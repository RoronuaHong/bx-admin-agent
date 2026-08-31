// 端到端实例验证：「影片列表管理，前2页」→ 渲染分支 + 表格上屏
// 验证点：①真实 call_api（film.getList 分页）②extractListRowsFromContent 解析成功进入渲染分支
//       ③table 事件上屏（含 rows/total）④模型校验总结收束
// 运行：cd apps/agent-server && .\node_modules\.bin\tsx.cmd scripts/verify-movie-list.mjs
import "./../src/load-env.js";
import { chatStream } from "../src/chat.js";
import { createSession, deleteSession, setActiveProject } from "../src/session.js";
import { getCountry } from "../src/config.js";
import { mockLogin } from "../src/mock-upstream.js";

const INPUT = process.argv[2] || "影片列表管理，前2页";
const TIMEOUT_MS = 200_000;

const country = getCountry("india") || getCountry("brazil");
if (!country) {
  console.error("未找到国家线配置");
  process.exit(1);
}
const auth = mockLogin("verify-movie-list");
const session = createSession({ token: auth.token, country, user: auth.user, menus: auth.menus });
setActiveProject(session.id, { key: "bx-film-admin", label: "影视后台管理系统", setAt: Date.now() });

const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
const t0 = Date.now();
const tools = [];
const tables = [];
let text = "";
let error = "";

try {
  for await (const ev of chatStream(session, INPUT, { model: process.env.E2E_MODEL || "" }, ac.signal)) {
    if (ev.type === "tool_call") {
      const input = ev.input || {};
      const p = String(input.path || input.operation || input.name || "");
      const params = input.params && typeof input.params === "object" ? JSON.stringify(input.params) : "";
      tools.push(`${ev.name}(${p}${params ? ` ${params}` : ""})`);
    }
    if (ev.type === "table") tables.push(ev.table);
    if (ev.type === "text") text += ev.text;
    if (ev.type === "error") error = ev.message;
  }
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
} finally {
  clearTimeout(timer);
}

const costMs = Date.now() - t0;
console.log(`\n=== 输入: ${INPUT} ===`);
console.log(`耗时: ${(costMs / 1000).toFixed(1)}s`);
console.log(`工具序列(${tools.length}):`);
tools.forEach((t, i) => console.log(`  [${i + 1}] ${t}`));
console.log(`表格上屏(${tables.length}):`);
tables.forEach((tb, i) => {
  console.log(`  [${i + 1}] title=${tb.title} columns=${tb.columns?.length} rows=${tb.rows?.length} total=${tb.total}`);
  console.log(`      列: ${(tb.columns || []).map((c) => c.title).join(" / ").slice(0, 200)}`);
  if (tb.rows?.[0]) console.log(`      首行: ${JSON.stringify(tb.rows[0]).slice(0, 200)}`);
});
console.log(`最终文本: ${text.slice(0, 500)}${text.length > 500 ? "..." : ""}`);
if (error) console.log(`错误: ${error}`);

const callApiCount = tools.filter((t) => t.startsWith("call_api(")).length;
// 列表表格 = 多列（>2）且行数>=1；详情键值对 = 2 列「字段/值」（列表被误判详情的失败形态）
const renderOk = tables.length > 0 && tables.some((t) => (t.columns?.length || 0) > 2 && t.rows?.length >= 1);
const summaryOk = /校验|核对|共|条|页|前2页|前 2 页/.test(text);
const ok = !error && callApiCount > 0 && renderOk && summaryOk;
console.log(`\n=== 结论 ===`);
console.log(`call_api 次数: ${callApiCount}`);
console.log(`渲染分支进入+表格上屏: ${renderOk ? "✓" : "✗"}`);
console.log(`模型校验总结: ${summaryOk ? "✓" : "✗"}`);
console.log(ok ? "PASS" : "FAIL");

deleteSession(session.id);
process.exit(ok ? 0 : 1);
