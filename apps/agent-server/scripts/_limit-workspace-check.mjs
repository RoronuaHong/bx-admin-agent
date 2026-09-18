// 入口限流 + 工作区文件端点 + 记忆 owner 隔离 验证。
// 运行：node --import tsx scripts/_limit-workspace-check.mjs（强制 Mongo 降级内存，确定性）
process.env.MONGO_URI = "mongodb://127.0.0.1:1";
process.env.MONGO_DB_NAME = "bx_agent_check";
process.env.RATE_LIMIT_STREAM_PER_MIN = "2";
process.env.RATE_LIMIT_CONCURRENT_PER_OWNER = "2";

import assert from "node:assert/strict";

const appMod = await import("../src/app.js");
const tasksMod = await import("../src/chat-tasks.js");
const rateLimit = await import("../src/rate-limit.js");
const fsStore = await import("../src/fs-store.js");
const conversations = await import("../src/conversations.js");

const app = appMod.createApp();
const OWNER = "owner-limit111";
const cookie = `bx_agent_oid=${OWNER}`;
const req = (path, init = {}, owner = cookie) =>
  app.request(path, { ...init, headers: { "content-type": "application/json", ...(owner ? { cookie: owner } : {}), ...(init.headers || {}) } });

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
  return lines;
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

// ---- A. 限流单元 ----
await check("滑动窗口：第 limit+1 次被拒并给 Retry-After", () => {
  rateLimit.resetRateLimits();
  const key = "unit:k";
  assert.equal(rateLimit.hitRateLimit(key, 2).allowed, true);
  assert.equal(rateLimit.hitRateLimit(key, 2).allowed, true);
  const third = rateLimit.hitRateLimit(key, 2);
  assert.equal(third.allowed, false);
  assert.ok(third.retryAfterSec >= 1);
  assert.equal(rateLimit.hitRateLimit("unit:other", 2).allowed, true); // 不同 key 不共享
  rateLimit.resetRateLimits();
});
await check("limit=0 → 关闭", () => {
  assert.equal(rateLimit.hitRateLimit("unit:off", 0).allowed, true);
});

// ---- B. /chat/stream 限流（HTTP 层）----
await check("每分钟次数限制：第 3 次 429 + Retry-After", async () => {
  for (let i = 1; i <= 2; i++) {
    const res = await req("/chat/stream", {
      method: "POST",
      body: JSON.stringify({ text: "hi", conversationId: `lim-${i}` }),
    });
    assert.equal(res.status, 200);
    await readNdjson(res);
  }
  const third = await req("/chat/stream", {
    method: "POST",
    body: JSON.stringify({ text: "hi", conversationId: "lim-3" }),
  });
  assert.equal(third.status, 429);
  assert.ok(Number(third.headers.get("retry-after")) >= 1);
  const body = await third.json();
  assert.equal(body.error.code, "CHAT_RATE_LIMITED");
});

await check("每 owner 并发上限：2 个在跑 → 第 3 个对话 429", async () => {
  rateLimit.resetRateLimits();
  const g1 = tasksMod.startTask({ conversationId: "lim-c1", userText: "x", ownerKey: OWNER });
  const g2 = tasksMod.startTask({ conversationId: "lim-c2", userText: "x", ownerKey: OWNER });
  const res = await req("/chat/stream", {
    method: "POST",
    body: JSON.stringify({ text: "hi", conversationId: "lim-c3" }),
  });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.code, "CHAT_CONCURRENT_LIMITED");
  tasksMod.finishTask(g1, "cancelled", false);
  tasksMod.finishTask(g2, "cancelled", false);
  // 释放后再来一次 → 通过限流（200 流式）
  const ok = await req("/chat/stream", { method: "POST", body: JSON.stringify({ text: "hi", conversationId: "lim-c3" }) });
  assert.equal(ok.status, 200);
  await readNdjson(ok);
});

// ---- C. 工作区文件端点 ----
await check("工作区：列表 + 内容预览 + 归属守卫", async () => {
  await req("/chat/conversations", { method: "POST", body: JSON.stringify({ id: "ws-a", title: "ws" }) });
  fsStore.fsWrite("ws-a", "results/note.md", "hello workspace");
  const list = await (await req("/chat/conversations/ws-a/files")).json();
  assert.ok(list.files.some((f) => f.path === "results/note.md"));
  const content = await (await req("/chat/conversations/ws-a/files/content?path=results/note.md")).json();
  assert.equal(content.content, "hello workspace");
  const forbidden = await req(
    "/chat/conversations/ws-a/files",
    {},
    "bx_agent_oid=owner-other333",
  );
  assert.equal(forbidden.status, 404);
  const missing = await req("/chat/conversations/ws-a/files/content?path=nope.txt");
  assert.equal(missing.status, 404);
});

// ---- D. 记忆 owner 隔离 ----
await check("记忆：A 写的 B 看不到/删不掉；A 可删", async () => {
  const added = (await (await req("/chat/memory", { method: "POST", body: JSON.stringify({ text: "A 的偏好事实" }) })).json()).memory;
  assert.ok(added.id);
  const listB = (await (await req("/chat/memory", {}, "bx_agent_oid=owner-other333")).json()).memory;
  assert.ok(!listB.some((m) => m.id === added.id));
  const listA = (await (await req("/chat/memory")).json()).memory;
  assert.ok(listA.some((m) => m.id === added.id));
  const delB = await (await req(`/chat/memory/${added.id}`, { method: "DELETE" }, "bx_agent_oid=owner-other333")).json();
  assert.equal(delB.ok, false);
  const delA = await (await req(`/chat/memory/${added.id}`, { method: "DELETE" })).json();
  assert.equal(delA.ok, true);
});

console.log(`\n${pass} checks passed${process.exitCode ? "（存在失败）" : ""}`);
