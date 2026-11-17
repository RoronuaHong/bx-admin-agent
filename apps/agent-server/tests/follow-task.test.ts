import { afterEach, describe, expect, test, vi } from "vitest";

import {
  detachTask,
  finishTask,
  followTask,
  publishTaskEvent,
  startTask,
} from "../src/chat-tasks.js";

const tasks = new Set<ReturnType<typeof startTask>>();
function newTask(conversationId: string) {
  const task = startTask({ conversationId, userText: "hi" });
  tasks.add(task);
  return task;
}

afterEach(() => {
  for (const task of tasks) {
    if (task.status === "running") finishTask(task, "cancelled", false);
  }
  tasks.clear();
  vi.restoreAllMocks();
});

describe("followTask 回放与订阅窗口", () => {
  test("[F4] 回放期间发布的 text_delta 不丢：先注册 waiter 再回放", async () => {
    const task = newTask("conv_replay_gap");
    // 订阅前已有一条 text 全文（seq=1，入 buffer）
    publishTaskEvent(task, { type: "text", text: "段落A" });

    const it = followTask(task, 0);
    // 第一次 next：拿到 text 快照，生成器暂停在 yield 处（回放尚未结束）
    const first = await it.next();
    expect(first.value?.type).toBe("text");
    expect((first.value as { text: string }).text).toBe("段落A");

    // 此刻（回放暂停窗口）发布增量：text_delta 只累加 text、不进 buffer。
    // 修复前 waiter 还没注册，这条增量永久丢失；修复后先进队列。
    publishTaskEvent(task, { type: "text_delta", text: "段落B" });

    // 逐条消费，直到收到那条增量
    const seen: string[] = [];
    for (let i = 0; i < 6 && !seen.some((s) => s.includes("段落B")); i += 1) {
      const { value, done } = await it.next();
      if (done || !value) break;
      if (value.type === "text_delta") seen.push(value.text);
      if (value.type === "text") seen.push(value.text);
    }
    expect(seen.some((s) => s.includes("段落B"))).toBe(true);
    await it.return(undefined);
  });

  test("[F4] 回放期间发布的非增量事件也不重复", async () => {
    const task = newTask("conv_replay_dedup");
    publishTaskEvent(task, { type: "text", text: "正文" });

    const it = followTask(task, 0);
    await it.next(); // text 快照

    // 回放窗口内发布一条 done 之外的普通事件（入 buffer 且 wake）
    publishTaskEvent(task, { type: "thinking_delta", text: "思考" });

    const types: string[] = [];
    let thinkingCount = 0;
    for (let i = 0; i < 6; i += 1) {
      const { value, done } = await it.next();
      if (done || !value) break;
      types.push(value.type);
      if (value.type === "thinking_delta") thinkingCount += 1;
      if (value.type === "thinking_delta") break;
    }
    // 水印 startSeq 让这条新事件只从队列走一次，不在 buffer 回放里重复
    expect(thinkingCount).toBe(1);
    await it.return(undefined);
  });

  // async generator 惰性：必须 next() 一次才会执行函数体、注册 waiter。
  async function start(it: AsyncGenerator) {
    void it.next().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
  }

  test("[F3] 多订阅者下 live 不会因一条流退出而误置 false", async () => {
    const task = newTask("conv_multi_waiter");
    const it1 = followTask(task, 0);
    const it2 = followTask(task, 0);
    await start(it1);
    await start(it2);
    expect(task.live).toBe(true);
    expect(task.waiters.size).toBe(2);

    // 模拟第一条流的外层 finally 无条件 detach（修复前这里把 live 置 false，误伤仍在消费的 it2）
    detachTask(task);
    expect(task.live).toBe(true);
    expect(task.waiters.size).toBe(2); // 不带 wake 时不应删除别人的订阅

    // 收束任务唤醒所有挂起的订阅，生成器得以自然退出
    finishTask(task, "cancelled", false);
    await it1.return(undefined);
    await it2.return(undefined);
    expect(task.live).toBe(false);
  });

  test("[F3] detachTask 按剩余订阅者重算 live", async () => {
    const task = newTask("conv_detach");
    const it1 = followTask(task, 0);
    await start(it1);
    expect(task.waiters.size).toBe(1);
    detachTask(task);
    expect(task.live).toBe(true); // 还有一个订阅者在
    finishTask(task, "cancelled", false);
    await it1.return(undefined);
  });
});
