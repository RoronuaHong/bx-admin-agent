/**
 * Metabase REST 冒烟：账号密码换 Session → 列库 →（可选）试跑一条只读 SQL。
 *
 * 环境变量（写入 apps/agent-server/.env，勿提交、勿发到聊天）：
 *   METABASE_URL          默认 https://bi.vmovs.com
 *   METABASE_USERNAME     登录邮箱/用户名
 *   METABASE_PASSWORD     密码
 *   METABASE_DATABASE_ID  可选；有则对该库跑 SELECT 1（或 METABASE_SMOKE_SQL）
 *   METABASE_SMOKE_SQL    可选；默认 SELECT 1
 *
 * 用法（在 apps/agent-server 下）：
 *   node scripts/metabase-smoke.mjs
 */
import "dotenv/config";

const url = (process.env.METABASE_URL || "https://bi.vmovs.com").replace(/\/$/, "");
const username = (process.env.METABASE_USERNAME || process.env.METABASE_USER_EMAIL || "").trim();
const password = process.env.METABASE_PASSWORD || "";
const databaseIdRaw = (process.env.METABASE_DATABASE_ID || "").trim();
const smokeSql = (process.env.METABASE_SMOKE_SQL || "SELECT 1").trim();

function maskUser(u) {
  if (!u) return "(empty)";
  if (u.includes("@")) {
    const [a, b] = u.split("@");
    return `${a.slice(0, 2)}***@${b}`;
  }
  return `${u.slice(0, 2)}***`;
}

async function mb(path, { method = "GET", session, body } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (session) headers["X-Metabase-Session"] = session;
  const resp = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  return { ok: resp.ok, status: resp.status, data };
}

async function main() {
  console.log("[metabase-smoke] url =", url);
  console.log("[metabase-smoke] user =", maskUser(username));

  if (!username || !password) {
    console.error(
      "[metabase-smoke] FAIL: 请在 apps/agent-server/.env 设置 METABASE_USERNAME 与 METABASE_PASSWORD",
    );
    process.exit(2);
  }

  const login = await mb("/api/session", {
    method: "POST",
    body: { username, password },
  });
  if (!login.ok || !login.data?.id) {
    console.error("[metabase-smoke] FAIL: login", login.status, login.data);
    process.exit(1);
  }
  const session = login.data.id;
  console.log("[metabase-smoke] OK: session acquired");

  const me = await mb("/api/user/current", { session });
  if (me.ok) {
    console.log("[metabase-smoke] OK: current user =", me.data?.email || me.data?.common_name || me.data?.id);
  } else {
    console.warn("[metabase-smoke] WARN: /api/user/current", me.status, me.data);
  }

  const dbs = await mb("/api/database", { session });
  if (!dbs.ok) {
    console.error("[metabase-smoke] FAIL: list databases", dbs.status, dbs.data);
    process.exit(1);
  }
  const list = Array.isArray(dbs.data) ? dbs.data : dbs.data?.data || [];
  console.log("[metabase-smoke] OK: databases =", list.length);
  for (const db of list.slice(0, 20)) {
    console.log(
      `  - id=${db.id} name=${db.name} engine=${db.engine || db.dbms_version?.flavor || "?"}`,
    );
  }
  if (list.length > 20) console.log(`  … +${list.length - 20} more`);

  if (!databaseIdRaw) {
    console.log(
      "[metabase-smoke] SKIP query: 设置 METABASE_DATABASE_ID 后可试跑 SQL（默认 SELECT 1）",
    );
    console.log("[metabase-smoke] DONE (auth + list db OK)");
    return;
  }

  const databaseId = Number(databaseIdRaw);
  if (!Number.isFinite(databaseId)) {
    console.error("[metabase-smoke] FAIL: METABASE_DATABASE_ID 无效");
    process.exit(1);
  }

  const q = await mb("/api/dataset", {
    method: "POST",
    session,
    body: {
      type: "native",
      database: databaseId,
      native: { query: smokeSql },
    },
  });
  if (!q.ok) {
    console.error("[metabase-smoke] FAIL: dataset query", q.status, q.data);
    process.exit(1);
  }
  const rows = q.data?.data?.rows ?? q.data?.rows;
  const cols = q.data?.data?.cols ?? q.data?.cols;
  console.log(
    "[metabase-smoke] OK: query rows=",
    Array.isArray(rows) ? rows.length : "?",
    "cols=",
    Array.isArray(cols) ? cols.map((c) => c.name || c.display_name).join(",") : "?",
  );
  if (Array.isArray(rows) && rows[0]) {
    console.log("[metabase-smoke] sample row[0] =", JSON.stringify(rows[0]).slice(0, 200));
  }
  console.log("[metabase-smoke] DONE (auth + list db + query OK)");
}

main().catch((e) => {
  console.error("[metabase-smoke] FAIL:", e);
  process.exit(1);
});
