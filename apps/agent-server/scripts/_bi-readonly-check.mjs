// P1-1 验收：对比「管理员凭据」与「只读凭据」在每个元数据工具上的可见结果条数。
//
// 目的：切只读凭据（docs/text2sql-text2api-plan.md §6 P1-1）时，验证两个静默劣化前置——
//   · ① 原生查询权限：只读账号若无 native query 编辑权限，run_native_query 会**整体不可用**（不是被拦截）；
//   · ② 可见范围：只读账号可能看不到部分 collection → list_cards / search / get_dashboard **静默少结果**（比报错更难发现）。
// 用「逐工具对比切换前后返回条数」来验收，而不是「跑通就行」。
//
// 用法（在 apps/agent-server 下）：配置 BI_BASE_URL / BI_API_KEY / BI_READONLY_API_KEY，然后
//   node --import tsx scripts/_bi-readonly-check.mjs
import process from "node:process";

const BASE = process.env.BI_BASE_URL;
const ADMIN = process.env.BI_API_KEY;
const RO = process.env.BI_READONLY_API_KEY;

function need(v, name) {
  if (!v) {
    console.error(`缺 ${name}（在 .env 配置）`);
    process.exit(2);
  }
}
need(BASE, "BI_BASE_URL");
need(ADMIN, "BI_API_KEY");
if (!RO) {
  console.error("未配置 BI_READONLY_API_KEY：P1-1 还没切只读凭据，无从对比。配置后重跑。");
  process.exit(2);
}

async function api(key, path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    // 网络层失败（地址不可达 / DNS 失败等）：当成探测失败，不中断整轮对比。
    return { status: 0, ok: false, data: String(err?.message || err) };
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, data };
}
const asList = (v) => (Array.isArray(v) ? v : Array.isArray(v?.data) ? v.data : []);

// 对一种凭据跑一组探测，返回各维度条数（探针失败记 null）或布尔（原生查询是否拿到行）。
async function probe(key, dbId) {
  const out = {};
  // ① 原生查询：简单 SELECT，必须拿到行——否则只读账号缺 native query 权限。
  const q = await api(key, "/dataset", { method: "POST", body: { database: dbId, type: "native", native: { query: "SELECT 1" } } });
  out.nativeQuery = q.ok && Array.isArray(q.data?.data?.rows);
  const meta = await api(key, `/database/${dbId}/metadata?skip_fields=true`);
  out.tables = meta.ok && Array.isArray(meta.data?.tables) ? meta.data.tables.length : null;
  const cards = await api(key, "/card");
  out.cards = cards.ok ? asList(cards.data).length : null;
  const dash = await api(key, "/dashboard");
  out.dashboards = dash.ok ? asList(dash.data).length : null;
  const search = await api(key, `/search?q=${encodeURIComponent("film")}`);
  out.searchHits = search.ok && Array.isArray(search.data) ? search.data.length : null;
  return out;
}

const dbList = asList((await api(ADMIN, "/database")).data);
const dbId = dbList[0]?.id;
if (dbId === undefined) {
  console.error("管理员凭据没列到任何数据库，无法继续。");
  process.exit(2);
}

const admin = await probe(ADMIN, dbId);
const ro = await probe(RO, dbId);

console.log("管理员凭据：", JSON.stringify(admin));
console.log("只读凭据：  ", JSON.stringify(ro));
console.log();

let bad = 0;
function check(name, a, b) {
  if (b === null) {
    console.log(`✗ ${name}：只读凭据探针失败（status 非 2xx），P1-1 前置未满足`);
    bad += 1;
    return;
  }
  if (b === false) {
    console.log(`✗ ${name}：只读凭据下不可用（false）—— 缺 native query 权限，run_native_query 会整体失效`);
    bad += 1;
    return;
  }
  if (b < a) {
    console.log(`⚠ ${name}：${a} → ${b}，只读比管理员少，需逐工具核对是否漏了 collection（可见范围缩小）`);
    return;
  }
  console.log(`✓ ${name}：${a} / ${b}`);
}

check("原生查询可用", admin.nativeQuery, ro.nativeQuery);
check("表数", admin.tables, ro.tables);
check("卡片数", admin.cards, ro.cards);
check("仪表盘数", admin.dashboards, ro.dashboards);
check("搜索命中", admin.searchHits, ro.searchHits);

console.log();
console.log(bad === 0 ? "=== P1-1 前置通过（无整体不可用；若有 ⚠ 需人工核对范围）===" : `=== P1-1 前置未通过（${bad} 项）===`);
process.exit(bad === 0 ? 0 : 1);
