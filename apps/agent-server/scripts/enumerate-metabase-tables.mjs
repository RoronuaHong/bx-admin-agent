// 一次性：枚举 Metabase db 2 全部表（读 .env，不写死凭证）
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function loadEnv() {
  const path = fileURLToPath(new URL("../.env", import.meta.url));
  console.error("env path:", path);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    console.error("read failed:", e.message);
    return {};
  }
  console.error("env bytes:", raw.length, "first120:", JSON.stringify(raw.slice(0, 120)));
  const out = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/m);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const env = loadEnv();
console.error("parsed keys:", Object.keys(env).filter((k) => k.includes("METABASE")));
const BASE = env.METABASE_URL.replace(/\/$/, "");
const DB = Number(env.METABASE_DATABASE_ID || "2");

const login = await fetch(`${BASE}/api/session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: env.METABASE_USERNAME, password: env.METABASE_PASSWORD }),
});
if (!login.ok) {
  console.error("login failed", login.status, await login.text());
  process.exit(1);
}
const { id: session } = await login.json();

const meta = await fetch(`${BASE}/api/database/${DB}/metadata?include_hidden=true`, {
  headers: { "X-Metabase-Session": session },
});
const data = await meta.json();

const tables = (data.tables || []).filter((t) => t.name);
console.log(`\n=== Metabase db ${DB}: ${tables.length} tables ===\n`);

// 按 schema 分组
const bySchema = {};
for (const t of tables) {
  const s = t.schema || "(default)";
  (bySchema[s] ||= []).push(t);
}
for (const [schema, ts] of Object.entries(bySchema)) {
  console.log(`[schema ${schema}] ${ts.length} tables`);
  for (const t of ts) {
    const fields = (t.fields || []).filter((f) => !f.is_preview_display || true);
    const active = (t.fields || []).filter((f) => !f.visibility_type || f.visibility_type === "normal");
    console.log(`  - ${t.name}  (fields=${t.fields?.length || 0}, active=${active.length})`);
  }
}

// 是否存在 elt_watch_detail
const modeled = tables.find((t) => t.name === "elt_watch_detail");
console.log(`\nmodeled in pack: elt_watch_detail = ${modeled ? "PRESENT (" + (modeled.fields?.length||0) + " fields)" : "ABSENT"}`);
console.log(`coverage: 1 / ${tables.length} tables modeled`);
