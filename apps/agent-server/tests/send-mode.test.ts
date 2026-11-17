// 会话发送模式开关（抢占式 vs 排队等待）的端到端验证：
// 在真实 Hono app 上走 HTTP 路由，验证 sendMode 如何改变 /chat/stream 的抢占判定与入队链路。
import { afterEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createConversation, deleteConversation, getConversation, patchConversation } from "../src/conversations.js";
import { finishTask, getRunningTask, startTask } from "../src/chat-tasks.js";

const OWNER = "sendModeOwner0001";
const cookie = `bx_agent_oid=${OWNER}`;
const ids: string[] = [];
const ownedTasks: Array<ReturnType<typeof startTask>> = [];
function newConv(tag: string) {
  const id = `conv_sm_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  ids.push(id);
  return id;
}
function presetTask(id: string, opts: { unattended?: boolean } = {}) {
  const t = startTask({ conversationId: id, userText: "running", ownerKey: OWNER, ...opts });
  ownedTasks.push(t);
  return t;
}
function stream(app: ReturnType<typeof createApp>, id: string) {
  return app.request("/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ text: "新消息", conversationId: id, timeZone: "Asia/Shanghai" }),
  });
}
afterEach(async () => {
  for (const t of ownedTasks) if (t.status === "running") finishTask(t, "cancelled", false);
  ownedTasks.length = 0;
  // /chat/stream 内部新建的任务不在 ownedTasks：按本次对话 id 把仍 running 的也收口，避免并发计数泄漏。
  for (const id of ids) {
    const t = getRunningTask(id);
    if (t && t.status === "running") finishTask(t, "error", false);
  }
  vi.unstubAllGlobals();
  await Promise.all(ids.map((id) => deleteConversation(id).catch(() => undefined)));
  ids.length = 0;
});

test("[S1] queue 模式：对话忙时新消息返回 409 CONVERSATION_BUSY（不抢占）", async () => {
  const app = createApp();
  const id = newConv("queue");
  await createConversation({ id, title: "q", ownerKey: OWNER });
  await patchConversation(id, { sendMode: "queue" });
  const busy = presetTask(id);

  const res = await stream(app, id);
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error?: { code?: string } };
  expect(body.error?.code).toBe("CONVERSATION_BUSY");
  expect(busy.buffer.some((e) => e.type === "cancelled")).toBe(false);
  // 队列模式下服务端不会自动入队（入队是前端 catch 的事），确认这一点
  expect((await getConversation(id))!.pendingQueue ?? []).toHaveLength(0);
});

test("[S2] 默认抢占：对话忙时新任务接管（旧轮 cancelled，新轮入注册表）", async () => {
  // mock 模型调用快速失败，避免真实网络；HTTP 响应在 consumeTask 之前就已返回。
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
  const app = createApp();
  const id = newConv("preempt");
  await createConversation({ id, title: "p", ownerKey: OWNER }); // 不设 sendMode → 默认抢占
  const busy = presetTask(id);

  const res = await stream(app, id);
  expect(res.status).toBe(200);
  expect(res.headers.get("X-Chat-Task-Id")).toBeTruthy();
  // 旧任务被抢占
  expect(busy.buffer.some((e) => e.type === "cancelled")).toBe(true);
  // 新任务真的接管：注册表里是本轮用户文本（而非预置的 "running"）
  expect(getRunningTask(id)?.userText).toBe("新消息");
  await res.text().catch(() => undefined); // 消费流，让 consumeTask 走完，避免 stub 移除竞态
});

test("[S3] unattended 定时任务无论模式如何都不被抢占（硬约束）", async () => {
  const app = createApp();
  const id = newConv("unattended");
  await createConversation({ id, title: "u", ownerKey: OWNER });
  await patchConversation(id, { sendMode: "preempt" }); // 显式抢占档
  const busy = presetTask(id, { unattended: true });

  const res = await stream(app, id);
  expect(res.status).toBe(409);
  expect(busy.buffer.some((e) => e.type === "cancelled")).toBe(false);
});

test("[S4] PATCH sendMode：合法值落库可读、非法值被忽略、切换不改 updatedAt", async () => {
  const app = createApp();
  const id = newConv("patch");
  await createConversation({ id, title: "patch", ownerKey: OWNER });
  const before = (await getConversation(id))!.updatedAt;

  const ok = await app.request(`/chat/conversations/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ sendMode: "queue" }),
  });
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { conversation: { sendMode?: string } }).conversation.sendMode).toBe("queue");
  expect((await getConversation(id))!.sendMode).toBe("queue");
  expect((await getConversation(id))!.updatedAt).toBe(before); // ACTIVITY_NEUTRAL

  const bad = await app.request(`/chat/conversations/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ sendMode: "bogus" }),
  });
  expect(bad.status).toBe(200);
  expect((await getConversation(id))!.sendMode).toBe("queue"); // 非法值未覆盖
});

test("[S5] queue 完整闭环：409 → 入队 → 上一轮成功收束 → 出队", async () => {
  const app = createApp();
  const id = newConv("fullcycle");
  await createConversation({ id, title: "full", ownerKey: OWNER });
  await patchConversation(id, { sendMode: "queue" });
  const busy = presetTask(id);

  // ① 忙时 /chat/stream → 409
  const res = await stream(app, id);
  expect(res.status).toBe(409);

  // ② 模拟前端 catch 409 后入队（走真实 HTTP 原子端点）
  const enq = await app.request(`/chat/conversations/${id}/queue/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ text: "排队消息A", at: Date.now() }),
  });
  expect(enq.status).toBe(200);
  expect((await getConversation(id))!.pendingQueue?.map((x) => x.text)).toContain("排队消息A");

  // ③ 上一轮成功收束，注册表释放
  finishTask(busy, "success", true);
  expect(getRunningTask(id)).toBeUndefined();

  // ④ 模拟 drainQueue 出队
  const deq = await app.request(`/chat/conversations/${id}/queue/dequeue`, {
    method: "POST",
    headers: { cookie },
  });
  expect(deq.status).toBe(200);
  const out = (await deq.json()) as { item: { text: string } | null };
  expect(out.item?.text).toBe("排队消息A");
  expect((await getConversation(id))!.pendingQueue ?? []).toHaveLength(0);
});

test("[S6] queue 模式队列满：第 21 条返回 409 CHAT_QUEUE_FULL，不丢已有项", async () => {
  const app = createApp();
  const id = newConv("queuefull");
  await createConversation({ id, title: "qf", ownerKey: OWNER });
  await patchConversation(id, { sendMode: "queue" });
  const enq = (text: string) =>
    app.request(`/chat/conversations/${id}/queue/enqueue`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text, at: Date.now() }),
    });
  for (let i = 0; i < 20; i += 1) expect((await enq(`m${i}`)).status).toBe(200);
  const over = await enq("overflow");
  expect(over.status).toBe(409);
  expect(((await over.json()) as { error?: { code?: string } }).error?.code).toBe("CHAT_QUEUE_FULL");
  expect((await getConversation(id))!.pendingQueue).toHaveLength(20);
});

test("[S7] 切回 preempt 后恢复可抢占（行为级，非仅字段）", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
  const app = createApp();
  const id = newConv("switchback");
  await createConversation({ id, title: "sb", ownerKey: OWNER });
  await patchConversation(id, { sendMode: "queue" });
  // 先确认 queue 档忙时 409
  const busy1 = presetTask(id);
  expect((await stream(app, id)).status).toBe(409);
  expect(busy1.buffer.some((e) => e.type === "cancelled")).toBe(false);
  finishTask(busy1, "success", true);

  // 切回抢占：再置一个 running 任务，应能抢占（200 + 新任务接管）
  await patchConversation(id, { sendMode: "preempt" });
  const busy2 = presetTask(id);
  const res = await stream(app, id);
  expect(res.status).toBe(200);
  expect(busy2.buffer.some((e) => e.type === "cancelled")).toBe(true);
  expect(getRunningTask(id)?.userText).toBe("新消息");
  await res.text().catch(() => undefined);
});
