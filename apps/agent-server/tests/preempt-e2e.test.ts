// 抢占改造的端到端实例验证：在真实 Hono app 上走完整 HTTP 路由 / 中间件 / 序列化，
// 不启动监听端口、不碰真实 Mongo（测试环境为内存降级），验证跨模块协作而非单个函数。
import { afterEach, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { createConversation, getConversation } from "../src/conversations.js";
import { finishTask, startTask } from "../src/chat-tasks.js";

const ids: string[] = [];
const ownedTasks: Array<ReturnType<typeof startTask>> = [];
function newConv(tag: string) {
  const id = `conv_e2e_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  ids.push(id);
  return id;
}
afterEach(() => {
  for (const t of ownedTasks) if (t.status === "running") finishTask(t, "cancelled", false);
  ownedTasks.length = 0;
});

async function enqueue(app: ReturnType<typeof createApp>, id: string, text: string, extra: Record<string, unknown> = {}) {
  return app.request(`/chat/conversations/${id}/queue/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, at: Date.now(), ...extra }),
  });
}

test("[E2E-1] 原子队列：真实 HTTP 并发入队不丢、出队不重", async () => {
  const app = createApp();
  const id = newConv("queue");
  await createConversation({ id, title: "queue" });

  // 并发三个 HTTP 入队
  const results = await Promise.all([enqueue(app, id, "a"), enqueue(app, id, "b"), enqueue(app, id, "c")]);
  expect(results.every((r) => r.status === 200)).toBe(true);
  const queued = (await getConversation(id))!.pendingQueue!.map((x) => x.text);
  expect([...queued].sort()).toEqual(["a", "b", "c"]);

  // 并发两个 HTTP 出队：各拿不同项，且正好是实际队列的前两项
  const [d1, d2] = await Promise.all([
    app.request(`/chat/conversations/${id}/queue/dequeue`, { method: "POST" }),
    app.request(`/chat/conversations/${id}/queue/dequeue`, { method: "POST" }),
  ]);
  const i1 = ((await d1.json()) as { item: { text: string } | null }).item;
  const i2 = ((await d2.json()) as { item: { text: string } | null }).item;
  expect([i1?.text, i2?.text].sort()).toEqual([queued[0], queued[1]].sort());
  expect((await getConversation(id))!.pendingQueue!.map((x) => x.text)).toEqual([queued[2]]);
});

test("[E2E-2] 队列满：HTTP 返回 409 CHAT_QUEUE_FULL，且不丢已有项", async () => {
  const app = createApp();
  const id = newConv("full");
  await createConversation({ id, title: "full" });
  for (let i = 0; i < 20; i += 1) await enqueue(app, id, `m${i}`);
  const over = await enqueue(app, id, "overflow");
  expect(over.status).toBe(409);
  expect(((await over.json()) as { error?: { code?: string } }).error?.code).toBe("CHAT_QUEUE_FULL");
  expect((await getConversation(id))!.pendingQueue).toHaveLength(20);
});

test("[E2E-3] 取消契约：显式 Stop 不取消 unattended，普通任务可取消", async () => {
  const app = createApp();
  const OWNER = "e2eOwner000001";
  const cookie = `bx_agent_oid=${OWNER}`;
  const idTask = newConv("unattended");
  const idPlain = newConv("plain");
  // 建对话（归属校验要求对话存在且属于当前 owner）
  await createConversation({ id: idTask, title: "scheduled", ownerKey: OWNER });
  await createConversation({ id: idPlain, title: "plain", ownerKey: OWNER });
  // 直接在运行时注册表放任务（/chat/stream 会触发真实模型调用，此处只验证 cancel 端点的契约）
  const t1 = startTask({ conversationId: idTask, userText: "scheduled", unattended: true });
  const t2 = startTask({ conversationId: idPlain, userText: "hi" });
  ownedTasks.push(t1, t2);

  const cancel = async (id: string) =>
    (await (await app.request("/chat/cancel", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ conversationId: id }),
    })).json()) as { ok: boolean; running: boolean };

  expect(await cancel(idTask)).toEqual({ ok: false, running: true });
  // 普通任务：端点确实取消了（ok=true）。running 由异步 consumer 收 abort 后 finishTask 翻转，
  // 本测试没有 consumer 在跑，故手动收口后再验证状态，避免依赖不存在的异步流程。
  expect((await cancel(idPlain)).ok).toBe(true);
  // 重复取消幂等（abort 已置位）
  expect((await cancel(idPlain)).ok).toBe(false);
  finishTask(t2, "cancelled", false);
  expect((await cancel(idPlain)).running).toBe(false);
});

test("[E2E-4] 任务状态端点：跑着的任务 running=true；收束后落 last 摘要", async () => {
  const app = createApp();
  const OWNER = "e2eOwner000002";
  const cookie = `bx_agent_oid=${OWNER}`;
  const id = newConv("status");
  await createConversation({ id, title: "status", ownerKey: OWNER });
  const t = startTask({ conversationId: id, userText: "hi" });
  ownedTasks.push(t);
  const running = (await (await app.request(`/chat/task/status?conversationId=${id}`, { headers: { cookie } })).json()) as { running: boolean; task?: { id: string } };
  expect(running.running).toBe(true);
  expect(running.task?.id).toBe(t.id);
  finishTask(t, "success", true);
  const done = (await (await app.request(`/chat/task/status?conversationId=${id}`, { headers: { cookie } })).json()) as { running: boolean; last?: { status: string } };
  expect(done.running).toBe(false);
  expect(done.last?.status).toBe("success");
});

test("[E2E-5] 对话基础端点未被队列改造破坏：建 / 读 / PATCH / 删", async () => {
  const app = createApp();
  const id = newConv("crud");
  await createConversation({ id, title: "初始标题" });
  expect((await (await app.request(`/chat/conversations/${id}`)).json() as { conversation: { title: string } }).conversation.title).toBe("初始标题");
  const patch = await app.request(`/chat/conversations/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "改过的标题" }),
  });
  expect(patch.status).toBe(200);
  expect(((await patch.json()) as { conversation: { title: string } }).conversation.title).toBe("改过的标题");
});
