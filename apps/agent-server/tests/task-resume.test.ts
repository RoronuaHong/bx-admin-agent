// 断线续传语义（纯逻辑，不依赖网络/真实模型）：
// 对齐 SSE `id:` + `Last-Event-ID`、OpenAI Responses `sequence_number` 的最小实现——
// 每个进缓冲的事件带任务内递增 `seq`；客户端记住游标，重连只取更新的部分；
// 正文增量只累加（不进缓冲），续传时以一条 `text` 快照补上（**替换**语义 → 幂等，不重复拼接）；
// 收束后任务留档一小段时间，晚到的重连仍能拿到尾部终态。
import { test, expect, vi } from "vitest";
import type { ChatEvent } from "@bx/shared";
import {
  finishTask,
  followTask,
  finalTextOf,
  getRetainedTask,
  getRunningTask,
  publishTaskEvent,
  startTask,
  startTaskRetentionSweeper,
  startTaskWatchdog,
} from "../src/chat-tasks.js";

/** 收集一个（已收束）任务的回放。 */
async function replay(task: Parameters<typeof followTask>[0], from = 0): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of followTask(task, from)) events.push(event);
  return events;
}

test("[A] 增量只累加、按序打号：text_delta 不进缓冲，其余事件带递增 seq", () => {
  const task = startTask({ conversationId: "conv_a", userText: "hi" });
  publishTaskEvent(task, { type: "text_delta", text: "你" });
  publishTaskEvent(task, { type: "text_delta", text: "好" });
  publishTaskEvent(task, { type: "tool_call", id: "t1", name: "fs_read" });
  publishTaskEvent(task, { type: "done" });

  // 缓冲里没有任何增量事件，且序号严格递增
  expect(task.buffer.map((e) => e.type)).toEqual(["tool_call", "done"]);
  const seqs = task.buffer.map((e) => e.seq ?? 0);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length);
  // 正文累积在 task.text（水位 = 最后一条增量的号）
  expect(task.text).toBe("你好");
  expect(task.textSeq).toBe(2);
  finishTask(task, "success", false);
});

test("[B] 续传用 text 快照补齐正文（替换语义，不重复拼）", async () => {
  const task = startTask({ conversationId: "conv_b", userText: "hi" });
  publishTaskEvent(task, { type: "text_delta", text: "第一段" });
  publishTaskEvent(task, { type: "tool_call", id: "t1", name: "fs_read" });
  publishTaskEvent(task, { type: "text_delta", text: "第二段" });
  publishTaskEvent(task, { type: "done" });
  finishTask(task, "success", false);

  // 首连（from=0）：先一条 text 快照给全文，再回放事件——不会再出现 text_delta
  const all = await replay(task, 0);
  expect(all[0]).toMatchObject({ type: "text", text: "第一段第二段" });
  expect(all.some((e) => e.type === "text_delta")).toBe(false);
  expect(all.map((e) => e.type)).toEqual(["text", "tool_call", "done"]);

  // 已有游标：只拿更新的部分——正文快照仍是全文（客户端替换），工具事件不重复
  const cursor = all[1]!.seq!;
  const tail = await replay(task, cursor);
  expect(tail.map((e) => e.type)).toEqual(["text", "done"]);
  expect(tail[0]).toMatchObject({ text: "第一段第二段" });

  // 游标已在末尾：没有正文要补（水位不大于游标），只剩终态
  const doneSeq = task.buffer[task.buffer.length - 1]!.seq!;
  expect((await replay(task, doneSeq)).map((e) => e.type)).toEqual([]);
});

test("[C] text 事件替换累积正文；没有终稿时 finalTextOf 退回累积值", () => {
  const task = startTask({ conversationId: "conv_c", userText: "hi" });
  publishTaskEvent(task, { type: "text_delta", text: "草稿" });
  publishTaskEvent(task, { type: "text", text: "终稿全文" });
  expect(task.text).toBe("终稿全文");
  expect(finalTextOf(task)).toBe("终稿全文");

  // 被取消（没有终稿 text 事件）：正文如实退回模型真正产出过的增量
  const cancelled = startTask({ conversationId: "conv_c2", userText: "hi" });
  publishTaskEvent(cancelled, { type: "text_delta", text: "半句" });
  finishTask(cancelled, "cancelled", false);
  expect(finalTextOf(cancelled)).toBe("半句");
});

test("[D] 运行中跟随：收束时等待者被唤醒，头部事件池为空", async () => {
  const task = startTask({ conversationId: "conv_d", userText: "hi" });
  const seen: ChatEvent[] = [];
  const pump = (async () => {
    for await (const event of followTask(task)) seen.push(event);
  })();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(task.live).toBe(true);
  publishTaskEvent(task, { type: "tool_call", id: "t1", name: "fs_read" });
  publishTaskEvent(task, { type: "done" });
  finishTask(task, "success", false);
  await pump;
  expect(seen.map((e) => e.type)).toEqual(["tool_call", "done"]);
  expect(task.live).toBe(false);
  // 收束后不再占用「运行中」名额（并发保护只认 running）
  expect(getRunningTask("conv_d")).toBeUndefined();
});

test("[E] 收束留档：晚到的重连仍能取到尾部；过期即回收", async () => {
  const task = startTask({ conversationId: "conv_e", userText: "hi" });
  publishTaskEvent(task, { type: "text_delta", text: "结果" });
  publishTaskEvent(task, { type: "done" });
  finishTask(task, "success", false);

  expect(getRetainedTask("conv_e")).toBeDefined();
  expect((await replay(getRetainedTask("conv_e")!, 0)).map((e) => e.type)).toEqual(["text", "done"]);

  // 手动过期（等价于清扫器跑到）：读取路径顺手回收，不依赖定时器准时
  getRetainedTask("conv_e")!.retainedUntil = Date.now() - 1;
  expect(getRetainedTask("conv_e")).toBeUndefined();
});

test("[G] 无进展看门狗：长时间没有实质事件就主动收口，并丢弃迟到产物", async () => {
  const task = startTask({ conversationId: "conv_watchdog", userText: "hi" });
  const seen: ChatEvent[] = [];
  const pump = (async () => {
    for await (const event of followTask(task)) seen.push(event);
  })();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const watchdog = startTaskWatchdog({ stallMs: 40, tickMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  clearInterval(watchdog);
  await pump;

  const stalled = seen.find((event) => event.type === "error");
  expect(stalled && stalled.type === "error" ? stalled.error.code : "").toBe("CHAT_TASK_STALLED");
  expect(getRunningTask("conv_watchdog")).toBeUndefined();

  // 迟到产物必须被丢弃：已收口的一轮不能再往留档 / 续传里塞事件（否则与「已收束」自相矛盾）
  const before = task.buffer.length;
  publishTaskEvent(task, { type: "text_delta", text: "迟到的正文" });
  publishTaskEvent(task, { type: "done" });
  expect(task.buffer.length).toBe(before);
  expect(task.text).toBe("");
});

test("[F] 留档可关闭（CHAT_TASK_RETAIN_MS=0）：不留档、不启清扫器", async () => {
  process.env.CHAT_TASK_RETAIN_MS = "0";
  vi.resetModules();
  try {
    const fresh = await import("../src/chat-tasks.js");
    expect(fresh.startTaskRetentionSweeper()).toBeNull();
    const task = fresh.startTask({ conversationId: "conv_f", userText: "hi" });
    fresh.publishTaskEvent(task, { type: "done" });
    fresh.finishTask(task, "success", false);
    expect(fresh.getRetainedTask("conv_f")).toBeUndefined();
  } finally {
    delete process.env.CHAT_TASK_RETAIN_MS;
    vi.resetModules();
  }
});
