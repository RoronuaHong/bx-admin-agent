/**
 * 验证 truncateToolResultForUi：可解析 JSON 整体上屏（即使超过 1200），
 * 仅超长非结构化文本截断到 1200。复现「规则校验」(parse_intent) 卡片被截断的场景。
 * 运行：cd apps/agent-server && ..\..\node_modules\.bin\tsx.cmd scripts\verify-ui-truncate.mjs
 */
import { truncateToolResultForUi } from "../src/ui-truncate.js";

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS ${name}`);
  else { failed++; console.log(`FAIL ${name} :: ${detail}`); }
}

// 1) parse_intent 典型返回（用户截图那种，含中文 rawInput），>200 字符，旧代码 slice(0,200) 会截断
const parseIntent = {
  _parsed: true,
  project: "bx-film-admin",
  projectLabel: "影视后台管理系统",
  projectFromSession: true,
  module: "user/special_offer",
  operationType: "read",
  understoodFromLlm: false,
  rawInput: "查询优惠活动配置列表",
  params: { page: 1, pageSize: 20 },
  hint: "该模块为优惠活动配置，属于 user/special_offer，接口 beac/list",
};
const json = JSON.stringify(parseIntent, null, 2);
console.log(`parse_intent json length=${json.length} (old 200-truncate would cut)`);
const out1 = truncateToolResultForUi(json);
check("parse_intent json kept intact", out1 === json, "output differs from input");
check("parse_intent json still parseable", (() => { try { JSON.parse(out1); return true; } catch (e) { return String(e); } })(), "JSON.parse failed");

// 2) 超大 JSON（>1200 字符）也必须整体上屏
const big = JSON.stringify({ list: Array.from({ length: 300 }, (_, i) => ({ id: i, name: `条目${i}-这是一个比较长的中文名称用于撑大体积` })) }, null, 1);
console.log(`big json length=${big.length} (>1200)`);
const out2 = truncateToolResultForUi(big);
check("big json kept intact", out2 === big, `len ${out2.length} != ${big.length}`);
check("big json parseable", (() => { try { JSON.parse(out2); return true; } catch (e) { return String(e); } })(), "JSON.parse failed");

// 3) 超长非结构化文本（无 JSON 前缀）仍兜底截断到 1200
const text = "grep result: " + "x".repeat(5000);
const out3 = truncateToolResultForUi(text);
check("plain long text truncated to 1200", out3.length === 1200, `len=${out3.length}`);

// 4) 数组 JSON 同样完整
const arr = JSON.stringify([1, 2, 3, { a: "中文" }]);
check("array json kept intact", truncateToolResultForUi(arr) === arr, "array json cut");

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
