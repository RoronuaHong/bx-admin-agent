/**
 * 多场景端到端验证：简单任务 / 复杂任务 / 超复杂任务 / 续聊 / 错误处理
 * 复用 chatStream 全链路，验证语义理解 + 工具调度 + 错误返回。
 * 用法：MOCK_UPSTREAM=true E2E_MODEL=zen node scripts/verify-scenarios.mjs
 * 说明：E2E_MODEL 指定模型 id（注册表里的），缺省 hy3。
 *   - 自动确认写操作（autoConfirm=true），避免超时误判；
 *   - 402 场景已移除（模型可用后该场景过时），改为「模糊请求应澄清」。
 */
import "./../src/load-env.js";
import { chatStream, resolveConfirmWaiter } from "../src/chat.js";
import { createSession, deleteSession, clearSessionContext, setActiveProject } from "../src/session.js";
import { getCountry } from "../src/config.js";
import { mockLogin } from "../src/mock-upstream.js";

const TIMEOUT_MS = 240_000;
// 写操作场景：自动确认（模拟前端点「确认」），否则 60s 超时会被误判为取消。
const AUTO_CONFIRM = process.env.AUTO_CONFIRM !== "false";

// 场景设计：覆盖简单/复杂/超复杂/续聊/错误返回
const SCENARIOS = [
  {
    group: "简单任务",
    name: "单模块列表查询",
    input: "兑换码模块，列表查一下",
    check: { requireTools: ["call_api"], forbid: [/重新描述你要操作的模块名/i], allowClarify: false },
  },
  {
    group: "简单任务",
    name: "按 id 查详情",
    input: "时间标签模块，id=4985535735769088，列给我所有详情",
    check: { requireTools: ["call_api"], forbid: [/重新描述你要操作的模块名/i] },
  },
  {
    group: "复杂任务",
    name: "跨模块统计+对比",
    input: "帮我查影片搜索统计列表，再看下兑换码列表，对比两者的数据量",
    check: { requireTools: ["call_api"], forbid: [/重新描述你要操作的模块名/i] },
  },
  {
    group: "复杂任务",
    name: "带筛选条件的查询",
    input: "查 VIP 订单里状态为已支付的列表，按创建时间倒序",
    check: { requireTools: ["call_api"], forbid: [/重新描述你要操作的模块名/i] },
  },
  {
    group: "超复杂任务",
    name: "多步编排+报表摘要",
    input: "统计最近7天影片搜索的关键字 Top10，并生成趋势摘要，导出 Excel",
    check: { requireTools: ["call_api"], forbid: [/重新描述你要操作的模块名/i] },
  },
  {
    group: "超复杂任务",
    name: "写操作需确认",
    input: "把兑换码批次 12345 的状态设置为下线",
    check: { requireTools: ["call_api"], expectConfirm: true, forbid: [/重新描述你要操作的模块名/i] },
  },
  {
    group: "错误处理",
    name: "未知模块应反问或澄清",
    input: "查一下量子波动模块的数据",
    check: { allowClarify: true, forbid: [/没有匹配的模块/i] },
  },
  {
    group: "错误处理",
    name: "纯闲聊不调业务工具",
    input: "你好，你是谁？",
    check: { allowClarify: true, forbidTools: ["call_api"] },
  },
  {
    group: "错误处理",
    name: "模糊请求应澄清",
    input: "帮我查一下列表",
    check: { allowClarify: true, forbid: [/重新描述你要操作的模块名/i] },
  },
];

// 续聊场景：先建立上下文，再追问（验证多轮语义衔接）
const CONTINUE_SCENARIO = {
  group: "续聊功能",
  name: "上下文衔接追问",
  turns: [
    { input: "兑换码模块，列表查一下", check: { requireTools: ["call_api"] } },
    { input: "那上面第一条记录的详情是什么", check: { requireTools: ["call_api"], forbid: [/重新描述你要操作的模块名/i] } },
    { input: "把它导出来", check: { requireTools: ["call_api", "export_dataset"], allowClarify: false } },
  ],
};

async function runTurn(session, input, check, ac, clearCtx = true) {
  if (clearCtx) {
    clearSessionContext(session.id);
    setActiveProject(session.id, { key: "bx-film-admin", label: "影视后台管理系统", setAt: Date.now() });
  }
  const tools = [];
  let text = "";
  let error = "";
  let confirmRequested = false;
  try {
    for await (const ev of chatStream(session, input, { model: process.env.E2E_MODEL || "hy3" }, ac.signal)) {
      if (ev.type === "tool_call") tools.push(ev.name);
      if (ev.type === "text") text += ev.text;
      if (ev.type === "error") error = ev.message;
      if (ev.type === "confirmation_required") {
        confirmRequested = true;
        // 自动确认写操作，模拟前端点「确认」；确认后继续执行后续编排
        if (AUTO_CONFIRM) {
          resolveConfirmWaiter(session.id, ev.callId, true);
          console.log(`  [auto-confirm] ${ev.callId}`);
        }
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const full = text.trim();
  const failedForbid = check.forbid?.filter((re) => re.test(full)) ?? [];
  const missingRequired = (check.requireTools || []).filter((t) => !tools.includes(t));
  const hitForbiddenTool = check.forbidTools?.some((t) => tools.includes(t)) ?? false;
  const confirmOk = check.expectConfirm ? confirmRequested : true;
  // 错误场景：预期 error 非空即 PASS（验证错误返回信息而非崩溃）
  const expectError = check.expectError === true;
  const ok = expectError
    ? Boolean(error) && failedForbid.length === 0
    : !error && failedForbid.length === 0 && missingRequired.length === 0 && !hitForbiddenTool && confirmOk;

  const label = check.group || "?";
  console.log(`\n[${label}] ${input}`);
  console.log(`  工具: ${tools.join(" → ") || "(无)"}`);
  console.log(`  确认请求: ${confirmRequested}`);
  console.log(`  输出: ${full.slice(0, 200)}${full.length > 200 ? "..." : ""}`);
  if (error) console.log(`  错误: ${error.slice(0, 160)}`);
  if (failedForbid.length) console.log(`  违规文案: ${failedForbid.map(String).join(", ")}`);
  if (missingRequired.length) console.log(`  缺必需工具: ${missingRequired.join(", ")}`);
  if (hitForbiddenTool) console.log(`  违禁工具: ${check.forbidTools.join(", ")}`);
  console.log(`  => ${ok ? "PASS" : "FAIL"}`);
  return { ok, tools, text: full, error, confirmRequested };
}

const country = getCountry("brazil") || getCountry("india");
if (!country) {
  console.error("未找到国家线配置，请检查 .env 中 COUNTRY_*");
  process.exit(1);
}
const auth = mockLogin("verify-tester");
const session = createSession({ token: auth.token, country, user: auth.user, menus: auth.menus });

console.log("===== 多场景端到端验证（chatStream 全链路）=====");
console.log(`模型: ${process.env.E2E_MODEL || "hy3"} | MOCK_UPSTREAM: ${process.env.MOCK_UPSTREAM || "false"} | AUTO_CONFIRM: ${AUTO_CONFIRM}`);
console.log(`国家线: ${country.label}\n`);

let total = 0;
let pass = 0;

for (const sc of SCENARIOS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const r = await runTurn(session, sc.input, { ...sc.check, group: `${sc.group}/${sc.name}` }, ac);
  clearTimeout(timer);
  total++;
  if (r.ok) pass++;
}

// 续聊场景：同一 session 连续多轮（不清上下文）
console.log("\n===== 续聊功能（同一 session 多轮）=====");
clearSessionContext(session.id);
setActiveProject(session.id, { key: "bx-film-admin", label: "影视后台管理系统", setAt: Date.now() });
for (const turn of CONTINUE_SCENARIO.turns) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const r = await runTurn(session, turn.input, { ...turn.check, group: `续聊功能/${turn.input.slice(0, 12)}` }, ac, false);
  clearTimeout(timer);
  total++;
  if (r.ok) pass++;
}

deleteSession(session.id);
console.log(`\n========== 验证汇总 ==========`);
console.log(`TOTAL: ${pass}/${total} PASS`);
if (pass < total) process.exit(1);
