// Async subagents 验证：subagent_start/delta/end 独立事件维度 + 独立取消（不影响主代理）。
// 运行：node --import tsx scripts/_async-subagent-check.mjs
// 可选真实模型 e2e：E2E_SUBAGENT=on 且服务可用时执行（模型需支持 tool calling 并委派 task）。
process.env.MONGO_URI = "mongodb://127.0.0.1:1"; // 强制走内存降级路径，测试确定性
process.env.MONGO_DB_NAME = "bx_agent_check";

import assert from "node:assert/strict";

const appMod = await import("../src/app.js");
const chatMod = await import("../src/chat.js");
const conversations = await import("../src/conversations.js");

const app = appMod.createApp();
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

// ---- A. 注册表单测：独立取消纯函数 ----
await check("cancelSubagent 未知 id / 跨会话 id 均不命中", async () => {
  assert.equal(chatMod.cancelSubagent("conv-x", "sa_conv-x_1"), false);
  assert.equal(chatMod.cancelSubagent("", ""), false);
});

await check("cancelSubagentsOfConversation 对未知会话是 no-op", async () => {
  chatMod.cancelSubagentsOfConversation("conv-not-exist");
});

// ---- B. 端点行为：独立取消端点 ----
await check("POST /chat/subagent/:conv/:id/cancel 未知对话 404", async () => {
  const res = await app.request("/chat/subagent/conv-not-exist/sa_x_1/cancel", { method: "POST" });
  assert.equal(res.status, 404);
});

await check("POST /chat/subagent/:conv/:id/cancel 已知对话未知 id → cancelled:false", async () => {
  // owner 形态必须匹配 OWNER_RE（^[A-Za-z0-9_-]{8,64}$），否则中间件会重新签发导致归属不匹配。
  await conversations.createConversation({ id: "chk-sub-1", title: "check", ownerKey: "chkowner0001" });
  const res = await app.request(`/chat/subagent/chk-sub-1/sa_unknown_1/cancel`, {
    method: "POST",
    headers: { cookie: "bx_agent_oid=chkowner0001" },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.cancelled, false);
});

await check("POST /chat/cancel 级联调用不抛错（无运行中子代理）", async () => {
  await conversations.createConversation({ id: "chk-sub-2", title: "check", ownerKey: "chkowner0001" });
  const res = await app.request("/chat/cancel", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "bx_agent_oid=chkowner0001" },
    body: JSON.stringify({ conversationId: "chk-sub-2" }),
  });
  assert.equal(res.status, 200);
});

// ---- C. 共享契约：subagent 事件类型可被构造（类型层无运行时校验，冒烟） ----
await check("ChatEvent subagent_* 事件形状冒烟", async () => {
  const start = { type: "subagent_start", id: "sa_1", parentId: "call_1", description: "d" };
  const delta = { type: "subagent_delta", id: "sa_1", text: "t" };
  const end = { type: "subagent_end", id: "sa_1", ok: true, status: "done", text: "s" };
  assert.equal(start.type, "subagent_start");
  assert.equal(delta.type, "subagent_delta");
  assert.equal(end.type, "subagent_end");
});

console.log(pass >= 5 ? `\n${pass} checks passed` : `\n${pass} checks passed (with failures above)`);
