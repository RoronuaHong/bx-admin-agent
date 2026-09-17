// 临时脚本：深度体检。对项目全部 GET 接口：
//   1) 无参/分页参数调用 → 2) 失败则按文档自动补必填参数重试 → 3) 仍失败给出缺参明细；
//   404 的路径再全项目搜一遍，判断是不是「接口搬家到别的服务」。
// 用法：node scripts/_yapi-api-deep.mjs [项目id=23]
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROJECT_ID = process.argv[2] || "23";
const YBASE = (process.env.YAPI_BASE_URL || "").replace(/\/+$/, "");

// ---- YApi 登录态（拿全量菜单，避免走工具结果截断）----
const loginRes = await fetch(`${YBASE}/api/user/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Referer: `${YBASE}/`, Origin: YBASE },
  body: JSON.stringify({ email: process.env.YAPI_LOGIN_EMAIL, password: process.env.YAPI_LOGIN_PASSWORD }),
});
const cookie = (loginRes.headers.getSetCookie?.() || [])
  .map((c) => c.split(";")[0].trim())
  .filter((c) => c.startsWith("_yapi_token=") || c.startsWith("_yapi_uid="))
  .join("; ");
async function yapi(path, params = {}) {
  const url = new URL(`${YBASE}/api${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const r = await fetch(url, { headers: { Cookie: cookie, Accept: "application/json" } });
  return (await r.json().catch(() => null))?.data;
}
const menu = (await yapi("/interface/list_menu", { project_id: PROJECT_ID })) || [];
const gets = menu
  .flatMap((c) => (c.list || []).map((a) => ({ ...a, cat: c.name })))
  .filter((a) => String(a.method).toUpperCase() === "GET");
console.log(`项目 ${PROJECT_ID}：GET 接口共 ${gets.length} 个，开始深度体检…\n`);

// ---- 起适配器 ----
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["scripts/yapi-mcp.mjs"],
  env: { ...process.env },
  stderr: "pipe",
});
const client = new Client({ name: "api-deep", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport, { timeout: 30_000 });

async function tool(name, args) {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
  const text = (res.content || []).map((c) => c.text || "").join("\n");
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 截断或纯文本 */
  }
  return { text, parsed, isError: Boolean(res.isError) };
}
const callApi = async (path, query = {}, responseChars) =>
  tool("call_api", { project_id: PROJECT_ID, path, ...(Object.keys(query).length ? { query } : {}), ...(responseChars ? { response_chars: responseChars } : {}) });

function bizOf(r) {
  const bodyText = r.parsed?.body ?? "";
  try {
    const body = JSON.parse(bodyText);
    return { code: body.code, msg: body.msg ?? body.message ?? "" };
  } catch {
    const code = /"code"\s*:\s*(-?\d+)/.exec(bodyText)?.[1];
    return { code: code === undefined ? undefined : Number(code), msg: /"msg"\s*:\s*"([^"]*)"/.exec(bodyText)?.[1] ?? "", truncated: bodyText.includes("已截断") };
  }
}

/** 按文档补必填 query 参数：优先用文档 example，没有就按名字/类型给哑值。 */
function docQuery(doc) {
  const q = {};
  for (const p of doc?.req_query || []) {
    const required = String(p.required) === "1" || String(p.required) === "true";
    if (!required) continue;
    const n = String(p.name || "").toLowerCase();
    q[p.name] =
      p.example ||
      (/page/.test(n) ? 1 : /size|limit/.test(n) ? 10 : /id$/.test(n) ? 1 : /type|status|state|client/.test(n) ? 1 : "test");
  }
  return q;
}

const detailCache = new Map();
async function docOf(apiId) {
  if (!/^\d+$/.test(String(apiId))) return null;
  if (!detailCache.has(apiId)) {
    const r = await tool("get_api_desc", { api_id: apiId });
    detailCache.set(apiId, r.parsed && !r.isError ? r.parsed : null);
  }
  return detailCache.get(apiId);
}

/** 从同前缀的列表接口里捞一个真实 id（getDetail 类接口用哑 id 会 400）。 */
async function findRealId(path) {
  const prefix = path.slice(0, path.lastIndexOf("/") + 1);
  const cands = menu
    .flatMap((c) => c.list || [])
    .filter(
      (a) =>
        String(a.path || "").startsWith(prefix) &&
        String(a.path) !== path &&
        String(a.method).toUpperCase() === "GET" &&
        /list|page|get/i.test(a.path) &&
        !/\{/.test(a.path),
    )
    .sort((x, y) => x.path.length - y.path.length)
    .slice(0, 3);
  for (const cand of cands) {
    const r = await callApi(String(cand.path), { page: 1, size: 1 });
    const m = /"id"\s*:\s*"?(\d{3,})"?/.exec(r.text || "");
    if (m) return m[1];
  }
  return "";
}

const rows = [];
const missing = [];
let idx = 0;
for (const api of gets) {
  idx += 1;
  const path = String(api.path || "").replace(/\{[^}]+\}/g, "1");
  let r = await callApi(path, { page: 1, size: 10 });
  let biz = bizOf(r);
  let how = "无参/分页参数";

  if ([400, 500].includes(Number(biz.code))) {
    const doc = await docOf(api._id);
    const q = docQuery(doc);
    if (Object.keys(q).length) {
      r = await callApi(path, q);
      biz = bizOf(r);
      how = `补参 ${Object.keys(q).join(",")}`;
    }
  }
  if ([400].includes(Number(biz.code)) && /(^|,|\()id(,|\)|$)/i.test(detailCache.get(api._id)?.req_query?.map((p) => p.name).join(",") || "")) {
    const realId = await findRealId(path);
    if (realId) {
      r = await callApi(path, { id: realId });
      biz = bizOf(r);
      how = `真实 id=${realId}`;
    }
  }
  if ([400, 500].includes(Number(biz.code))) {
    r = await callApi(path);
    biz = bizOf(r);
    how = "空参重试";
  }

  let verdict;
  const code = Number(biz.code);
  if (r.parsed?.status === 404) {
    verdict = "❌ 404 路径不存在";
    missing.push(api);
  } else if (code === 200) {
    verdict = biz.truncated ? "✅ 200（大响应已截断）" : "✅ 200";
  } else if (code === 400) {
    const doc = await docOf(api._id);
    const requiredNames = (doc?.req_query || [])
      .filter((p) => String(p.required) === "1" || String(p.required) === "true")
      .map((p) => p.name)
      .join(",");
    verdict = `⚠️ 400 需参数（文档必填：${requiredNames || "未标注"} · 尝试过：${how}）`;
  } else if (code === 401) {
    verdict = "❌ 401 鉴权失败";
  } else if (code === 500) {
    verdict = `⚠️ 500 服务内部错误（${how}）`;
  } else {
    verdict = `⚠️ code=${biz.code ?? "-"} ${biz.msg ?? ""}（${how}）`;
  }

  rows.push({ api, verdict, code: biz.code });
  if (!verdict.startsWith("✅")) {
    console.log(`${String(r.parsed?.status ?? "-").padStart(3)} | ${path.padEnd(52)} | ${verdict}`);
  }
}

// ---- 404 的路径：全项目搜一遍，看是否搬家 ----
console.log(`\n--- ${missing.length} 个 404 路径的全项目排查 ---`);
for (const api of missing) {
  const seg = String(api.path || "").split("/").filter(Boolean).pop() || "";
  const r = await tool("search_apis", { keyword: seg, limit: 10 });
  const hits = r.parsed?.results || [];
  const elsewhere = hits.filter((h) => String(h.project_id) !== String(PROJECT_ID));
  console.log(`${api.path} → ${elsewhere.length ? "其它项目里有同名路径：" : "全部 20 个项目都没有这个路径"}`);
  for (const h of elsewhere) console.log(`    ${h.method} ${h.path} · ${h.title} · ${h.project_name}(${h.project_id}) api_id=${h.api_id}`);
}

const count = (re) => rows.filter((r) => re.test(r.verdict)).length;
console.log(
  `\n汇总（共 ${rows.length}）：✅ 200 = ${count(/✅/)}；⚠️ 400 需参数 = ${count(/400 需参数/)}；⚠️ 500 = ${count(/500 服务内部错误/)}；❌ 404 = ${missing.length}；其它 = ${rows.length - count(/✅|400 需参数|500 服务内部错误/) - missing.length}`,
);

await client.close();
