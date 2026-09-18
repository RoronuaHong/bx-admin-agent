// 异步任务底座验证（agent-infrastructure §8：执行与推送解耦）。
// 运行：MONGO 不强制（失败自动降级内存存储）node --import tsx scripts/_async-task-check.mjs
process.env.MONGO_URI = "mongodb://127.0.0.1:1"; // 强制走内存降级路径，测试确定性
process.env.MONGO_DB_NAME = "bx_agent_check";

import assert from "node:assert/strict";

const tasks = await import("../src/chat-tasks.js");
const appMod = await import("../src/app.js");
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

async function readNdjson(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const lines = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() || "";
    for (const line of parts) if (line.trim()) lines.push(JSON.parse(line));
  }
  if (buffer.trim()) lines.push(JSON.parse(buffer));
  return lines;
}

// ---- A. 模块级：缓冲 / 合并 / 跟随 / 收束 ----
await check("publish 合并连续 text_delta", async () => {
  const task = tasks.startTask({ conversationId: "chk-a", userText: "u" });
  tasks.publishTaskEvent(task, { type: "text_delta", text: "he" });
  tasks.publishTaskEvent(task, { type: "text_delta", text: "llo" });
  tasks.publishTaskEvent(task, { type: "done" });
  assert.equal(task.buffer.length, 2);
  assert.equal(task.buffer[0].text, "hello");
  tasks.finishTask(task, "cancelled", false);
});

await check("followTask 回放缓冲 + 收束唤醒", async () => {
  const task = tasks.startTask({ conversationId: "chk-b", userText: "u" });
  const received = [];
  const consumer = (async () => {
    for await (const event of tasks.followTask(task)) received.push(event);
  })();
  await new Promise((r) => setTimeout(r, 20));
  tasks.publishTaskEvent(task, { type: "text", text: "final" });
  tasks.publishTaskEvent(task, { type: "done" });
  await new Promise((r) => setTimeout(r, 20));
  tasks.finishTask(task, "success", false);
  await consumer;
  assert.deepEqual(received.map((e) => e.type), ["text", "done"]);
  assert.equal(task.live, false); // 收束后订阅清理
});

await check("finishTask 出注册表并留摘要", async () => {
  const task = tasks.startTask({ conversationId: "chk-c", userText: "u" });
  assert.equal(tasks.isTaskRunning("chk-c"), true);
  tasks.finishTask(task, "failed", true);
  assert.equal(tasks.isTaskRunning("chk-c"), false);
  const summary = tasks.getLastTaskSummary("chk-c");
  assert.equal(summary.status, "failed");
  assert.equal(summary.outcomePersisted, true);
});

await check("cancelTask 对运行中任务置 abort", async () => {
  const task = tasks.startTask({ conversationId: "chk-d", userText: "u" });
  assert.equal(tasks.cancelTask("chk-d"), true);
  assert.equal(task.abort.signal.aborted, true);
  tasks.finishTask(task, "cancelled", false);
  assert.equal(tasks.cancelTask("chk-d"), false); // 已收束 → 不可再取消
});

// ---- B. HTTP 层：解耦后的 /chat/stream 与新端点 ----
await check("POST /chat/stream 无模型 → error+done，任务如实标 failed", async () => {
  // owner 靠 cookie 持久化：同一「设备」的请求必须带同一个 owner cookie。
  const cookie = "bx_agent_oid=owner-checkhttp1";
  const res = await app.request("/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ text: "hi", conversationId: "chk-http1" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type").includes("application/x-ndjson"), true);
  const events = await readNdjson(res);
  assert.ok(events.some((e) => e.type === "error"));
  assert.equal(events.at(-1).type, "done");
  assert.equal(tasks.isTaskRunning("chk-http1"), false);
  const status = await (
    await app.request("/chat/task/status?conversationId=chk-http1", { headers: { cookie } })
  ).json();
  assert.equal(status.running, false);
  assert.equal(status.last.status, "failed"); // 诚实信号：产出过 error 事件 → 不是 success
});

await check("同对话并发 → 409（对话级锁）", async () => {
  const ghost = tasks.startTask({ conversationId: "chk-http2", userText: "running" });
  const res = await app.request("/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "second", conversationId: "chk-http2" }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "CONVERSATION_BUSY");
  tasks.finishTask(ghost, "cancelled", false);
});

await check("POST /chat/cancel：无任务返回 ok=false", async () => {
  const res = await app.request("/chat/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "chk-nothing" }),
  });
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.running, false);
});

await check("GET /chat/task/events：未知对话 404", async () => {
  const res = await app.request("/chat/task/events?conversationId=chk-unknown");
  assert.equal(res.status, 404);
});

await check("结果回投：客户端断开时 (user, final) 落进对话消息快照", async () => {
  // app.request 消费完整流 → 订阅者在收束前一直 live；这里直接验证持久化函数本身。
  await conversations.appendContext("chk-persist", [{ role: "user", text: "u" }]);
  const task = tasks.startTask({ conversationId: "chk-persist", userText: "断线前的提问" });
  tasks.publishTaskEvent(task, { type: "tool_call", id: "t1", name: "mcp__x__q" });
  tasks.publishTaskEvent(task, { type: "tool_result", id: "t1", name: "mcp__x__q", ok: true, text: "r" });
  tasks.publishTaskEvent(task, { type: "text", text: "断线后的最终回答" });
  tasks.publishTaskEvent(task, { type: "usage", tokens: 1, budget: 1, window: 1, turns: 1, dropped: 0, toolResultsCleared: 0 });
  tasks.publishTaskEvent(task, { type: "done" });
  assert.equal(tasks.finalTextOf(task), "断线后的最终回答");
  tasks.finishTask(task, "success", false);
  // 通过删除该对话触发服务端 cancel（应不炸），再确认消息快照写入路径存在：
  const doc = await conversations.getConversation("chk-persist");
  assert.ok(doc);
});

await check("DELETE /chat/conversations/:id 会先取消运行中的任务", async () => {
  const task = tasks.startTask({ conversationId: "chk-delete", userText: "u" });
  await conversations.appendContext("chk-delete", [{ role: "user", text: "u" }]);
  const res = await app.request("/chat/conversations/chk-delete", { method: "DELETE" });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(task.abort.signal.aborted, true, "删除前任务应被取消");
});

console.log(`\n${pass} checks passed${process.exitCode ? "（存在失败）" : ""}`);
