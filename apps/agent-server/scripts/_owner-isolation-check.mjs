// 轻量归属隔离（方案 A：owner 标注）验证。
// 运行：node --import tsx scripts/_owner-isolation-check.mjs（强制 Mongo 降级内存，确定性）
process.env.MONGO_URI = "mongodb://127.0.0.1:1";
process.env.MONGO_DB_NAME = "bx_agent_check";

import assert from "node:assert/strict";

const appMod = await import("../src/app.js");
const tasks = await import("../src/chat-tasks.js");
const conversations = await import("../src/conversations.js");

const app = appMod.createApp();
const OWNER_A = "owner-aaaaaaaa";
const OWNER_B = "owner-bbbbbbbb";
const cookieOf = (owner) => ({ cookie: `${"bx_agent_oid"}=${owner}` });

function req(path, init = {}, owner) {
  return app.request(path, {
    ...init,
    headers: { "content-type": "application/json", ...(owner ? cookieOf(owner) : {}), ...(init.headers || {}) },
  });
}

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

await check("A 创建的对话带 owner 标注", async () => {
  await req("/chat/conversations", { method: "POST", body: JSON.stringify({ id: "own-a", title: "A的对话" }) }, OWNER_A);
  const doc = await conversations.getConversation("own-a");
  assert.equal(doc.ownerKey, OWNER_A);
});

await check("B 的列表看不到 A 的对话；A 能看到", async () => {
  const listB = (await (await req("/chat/conversations", {}, OWNER_B)).json()).conversations;
  assert.ok(!listB.some((d) => d.id === "own-a"));
  const listA = (await (await req("/chat/conversations", {}, OWNER_A)).json()).conversations;
  assert.ok(listA.some((d) => d.id === "own-a"));
});

await check("无主遗留数据对所有人可见（升级兼容）", async () => {
  await conversations.createConversation({ id: "legacy-conv", title: "遗留" }); // 不带 ownerKey
  for (const owner of [OWNER_A, OWNER_B]) {
    const list = (await (await req("/chat/conversations", {}, owner)).json()).conversations;
    assert.ok(list.some((d) => d.id === "legacy-conv"));
  }
});

await check("B 按 id 访问 A 的对话 → 404（GET/PATCH/DELETE/messages/context）", async () => {
  for (const [method, path] of [
    ["GET", "/chat/conversations/own-a"],
    ["PATCH", "/chat/conversations/own-a"],
    ["DELETE", "/chat/conversations/own-a"],
    ["POST", "/chat/conversations/own-a/messages"],
    ["POST", "/chat/conversations/own-a/clear"],
    ["POST", "/chat/conversations/own-a/context/clear"],
  ]) {
    const res = await req(path, { method, body: method === "GET" ? undefined : "{}" }, OWNER_B);
    assert.equal(res.status, 404, `${method} ${path}`);
  }
});

await check("B 向 A 的对话发流 → 404（不启动任务）", async () => {
  const res = await req(
    "/chat/stream",
    { method: "POST", body: JSON.stringify({ text: "hi", conversationId: "own-a" }) },
    OWNER_B,
  );
  assert.equal(res.status, 404);
  assert.equal(tasks.isTaskRunning("own-a"), false);
});

await check("B 不能取消/窥探 A 的任务状态", async () => {
  const task = tasks.startTask({ conversationId: "own-a", userText: "u" });
  tasks.publishTaskEvent(task, { type: "text", text: "t" });
  tasks.finishTask(task, "success", false);
  const cancel = await (await req("/chat/cancel", { method: "POST", body: JSON.stringify({ conversationId: "own-a" }) }, OWNER_B)).json();
  assert.deepEqual(cancel, { ok: false, running: false });
  const statusB = await (await req("/chat/task/status?conversationId=own-a", {}, OWNER_B)).json();
  assert.equal(statusB.running, false);
  assert.equal(statusB.last, undefined);
  const statusA = await (await req("/chat/task/status?conversationId=own-a", {}, OWNER_A)).json();
  assert.equal(statusA.last.status, "success");
});

await check("B 的 reorder 丢弃 A 的 id", async () => {
  const res = await req(
    "/chat/conversations/reorder",
    { method: "POST", body: JSON.stringify({ ids: ["own-a"] }) },
    OWNER_B,
  );
  assert.equal(res.status, 200);
  const doc = await conversations.getConversation("own-a");
  assert.equal(doc.sortOrder, undefined); // 未被写入手动顺序
});

await check("B 的偏好不能把活跃对话指向 A 的对话", async () => {
  await req(
    "/chat/preferences",
    { method: "PUT", body: JSON.stringify({ activeConversationId: "own-a" }) },
    OWNER_B,
  );
  const prefs = await (await req("/chat/preferences", {}, OWNER_B)).json();
  assert.notEqual(prefs.activeConversationId, "own-a");
});

await check("B 的 MCP 启用集读不到 A 的对话", async () => {
  await conversations.patchConversation("own-a", { mcpServers: ["bi"] });
  const data = await (await req("/chat/mcp/servers?conversationId=own-a", {}, OWNER_B)).json();
  assert.deepEqual(data.enabled, []);
});

console.log(`\n${pass} checks passed${process.exitCode ? "（存在失败）" : ""}`);
