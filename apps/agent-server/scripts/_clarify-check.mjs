// 结构化澄清（request_clarification）回归：工具入参校验 + 票据通道回传选项值 + 跨会话拒绝 + 超时。
// 运行：node --import tsx scripts/_clarify-check.mjs（纯内存，不依赖真实 MCP / 模型）。
import assert from "node:assert/strict";

// 超时口径设短一点，便于真的跑到超时分支。
process.env.MCP_CONFIRM_TIMEOUT_MS = "300";

const confirm = await import("../src/confirm.js");
const builtins = await import("../src/builtins.js");
const risk = await import("../src/risk.js");

let pass = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

const CONV = "clarify-check";
const call = (args) => builtins.execBuiltin("request_clarification", JSON.stringify(args), CONV);

await check("合法入参返回 clarification（由 chat 循环去挂起）", async () => {
  const out = await call({ question: "你要的是哪一种？", options: [{ label: "A" }, { label: "B", description: "说明" }] });
  assert.equal(out.ok, true, out?.text);
  assert.equal(out.text, "");
  assert.ok(out.clarification, "未返回 clarification");
  assert.equal(out.clarification.question, "你要的是哪一种？");
  assert.equal(out.clarification.options.length, 2);
  assert.equal(out.clarification.options[1].description, "说明");
});

await check("缺 question 被拒", async () => {
  const out = await call({ options: [{ label: "A" }, { label: "B" }] });
  assert.equal(out.ok, false);
});

await check("选项少于 2 个被拒（宁可直接执行也不要提问）", async () => {
  const out = await call({ question: "选哪个？", options: [{ label: "A" }] });
  assert.equal(out.ok, false);
});

await check("选项无有效 label 被拒", async () => {
  const out = await call({ question: "选哪个？", options: [{ description: "没有标题" }, {}] });
  assert.equal(out.ok, false);
});

await check("风险登记为只读工作区（免确认，不弹卡）", () => {
  const v = risk.resolveToolRisk("request_clarification");
  assert.equal(v.source, "builtin");
  assert.equal(v.level, "read");
  assert.equal(risk.verdictNeedsConfirm(v), false);
  builtins.assertBuiltinRiskCoverage();
});

await check("票据回传用户选中的选项值", async () => {
  const req = confirm.requestClarification({ sessionId: "s1", conversationId: CONV, callId: "c1" });
  const done = confirm.answerConfirmation(req.ticket, "s1", true, "选项A");
  assert.equal(done.ok, true);
  const outcome = await req.wait;
  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.value, "选项A");
});

await check("跳过（不带值）也能收束，不卡死", async () => {
  const req = confirm.requestClarification({ sessionId: "s1", conversationId: CONV, callId: "c2" });
  confirm.answerConfirmation(req.ticket, "s1", true);
  const outcome = await req.wait;
  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.value, undefined);
});

await check("跨会话应答被拒，且等待方立即按拒绝收束（不能永久挂起）", async () => {
  const req = confirm.requestClarification({ sessionId: "s1", conversationId: CONV, callId: "c3" });
  const res = confirm.answerConfirmation(req.ticket, "s2", true, "选项");
  assert.equal(res.ok, false);
  const outcome = await req.wait;
  assert.equal(outcome.confirmed, false); // 按拒绝处理（fail-closed），等待方不挂死
});

await check("票据一次性：重复应答第二次失效", async () => {
  const req = confirm.requestClarification({ sessionId: "s1", conversationId: CONV, callId: "c4" });
  assert.equal(confirm.answerConfirmation(req.ticket, "s1", true, "A").ok, true);
  assert.equal(confirm.answerConfirmation(req.ticket, "s1", true, "B").ok, false);
  await req.wait;
});

await check("超时按「未选择」收束（fail-closed 不挂死）", async () => {
  const req = confirm.requestClarification({ sessionId: "s1", conversationId: CONV, callId: "c5" });
  const outcome = await req.wait;
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.confirmed, false);
});

console.log(`=== clarify ${pass} PASS ===`);
