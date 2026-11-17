// 限流优先级回归：queue 档 / 无人值守占用时，409 CONVERSATION_BUSY 必须在限流判定之前返回。
// 两层含义：①前端只认 409 入队，回 429 会丢消息；②busy 请求不该消耗 owner 的每分钟配额，
// 否则后续真正要发的消息会被这个「排队请求」挤到 429。
// RATE_STREAM_PER_MIN 在 app.ts 模块顶层求值，故先设环境变量再动态导入 app.js。
import { afterEach, expect, test, vi } from "vitest";

const OWNER = "sendModeRateOwner01";
const cookie = `bx_agent_oid=${OWNER}`;
const ids: string[] = [];

afterEach(async () => {
  delete process.env.RATE_LIMIT_STREAM_PER_MIN;
  vi.unstubAllGlobals();
  const conv = await import("../src/conversations.js").catch(() => null);
  if (conv) await Promise.all(ids.map((id) => conv.deleteConversation(id).catch(() => undefined)));
  ids.length = 0;
});

test("[S8] queue 档 busy 优先于限流，且不消耗每分钟配额", async () => {
  process.env.RATE_LIMIT_STREAM_PER_MIN = "1";
  // mock 模型调用，让第三条空闲请求快速收束（不触发真实网络）。
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
  vi.resetModules();
  const { createApp } = await import("../src/app.js");
  const conv = await import("../src/conversations.js");
  const tasks = await import("../src/chat-tasks.js");
  const app = createApp();

  const id = `conv_sm_rate_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  ids.push(id);
  await conv.createConversation({ id, title: "rate", ownerKey: OWNER });
  await conv.patchConversation(id, { sendMode: "queue" });
  const busy = tasks.startTask({ conversationId: id, userText: "running", ownerKey: OWNER });

  const req = (convId: string) =>
    app.request("/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text: "新消息", conversationId: convId, timeZone: "Asia/Shanghai" }),
    });

  // busy 优先于限流：连续两次都是 409 CONVERSATION_BUSY，不是前端不认的 429。
  expect((await req(id)).status).toBe(409);
  const second = await req(id);
  expect(second.status).toBe(409);
  expect(((await second.json()) as { error?: { code?: string } }).error?.code).toBe("CONVERSATION_BUSY");

  // 关键收益：两个 busy 请求没消耗唯一配额——空闲对话的第三条仍能拿到 200（而非 429 CHAT_RATE_LIMITED）。
  const idle = `conv_sm_rate_idle_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  ids.push(idle);
  await conv.createConversation({ id: idle, title: "idle", ownerKey: OWNER });
  const third = await req(idle);
  expect(third.status).toBe(200);
  await third.text().catch(() => undefined); // 消费流，避免 stub 移除竞态

  if (busy.status === "running") tasks.finishTask(busy, "cancelled", false);
});
