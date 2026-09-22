// 跨进程续传的持久层与判定口径（纯逻辑，不依赖 Mongo / 网络）：
//  - 留档落盘与读取（Mongo 不可用时自动走内存降级，测试就在这条路径上跑）；
//  - 「这一轮还活着吗」的判定：心跳新鲜 + 属于别的实例 = 别处还在跑；心跳已停 = 僵尸，就地改成 interrupted；
//  - 无进展看门狗判据（纯函数）——HTTP 层的 ping 不算进展，只认实质事件。
import { test, expect } from "vitest";
import {
  TASK_DB_RETAIN_MS,
  flushTask,
  listStaleRunningTasks,
  loadTaskRecord,
  markTaskInterrupted,
  taskStoreBackend,
  type TaskRecord,
} from "../src/task-store.js";
import {
  getRetainedTask,
  getRunningTask,
  interruptOwnRunningTasks,
  loadTaskForResume,
  publishTaskEvent,
  replayRecord,
  stallIdleMs,
  startTask,
} from "../src/chat-tasks.js";

function record(over: Partial<TaskRecord> = {}): TaskRecord {
  const now = Date.now();
  return {
    taskId: "task_persisted",
    conversationId: "conv_persisted",
    userText: "hi",
    instanceId: "instance-before-restart",
    status: "running",
    startedAt: now - 5_000,
    seq: 2,
    text: "已产出的半截正文",
    textSeq: 1,
    events: [{ type: "tool_call", id: "t1", name: "fs_read", seq: 2 }],
    updatedAt: now,
    expiresAt: new Date(now + TASK_DB_RETAIN_MS),
    ...over,
  };
}

test("[A] 留档写入与读取（Mongo 不可用时走内存降级，行为一致）", async () => {
  // 未 init ⇒ 降级；即便 init 过，本测试也不依赖 Mongo 是否存在
  expect(["memory", "mongo"]).toContain(taskStoreBackend());
  const first = record();
  await flushTask(first, first.events); // 首次落档：把已有事件作为「本次新增」交出去
  const loaded = await loadTaskRecord("conv_persisted");
  expect(loaded?.taskId).toBe("task_persisted");
  expect(loaded?.text).toBe("已产出的半截正文");
  expect(loaded?.events.map((e) => e.type)).toEqual(["tool_call"]);

  // 增量追加：只补新事件，不整表重写（模拟第二次 flush）
  await flushTask(record({ seq: 3, text: "更长的正文", textSeq: 3 }), [{ type: "done", seq: 3 }]);
  const again = await loadTaskRecord("conv_persisted");
  expect(again?.events.map((e) => e.type)).toEqual(["tool_call", "done"]);
  expect(again?.text).toBe("更长的正文");
  expect(again?.seq).toBe(3);
});

test("[B] 僵尸任务判定：心跳停了 → interrupted（就地改正，不假装还在跑）", async () => {
  // 心跳新鲜 + 属于别的实例 = 别处真的还在跑，不能动它
  await flushTask(record({ instanceId: "other-instance", updatedAt: Date.now() }), []);
  const live = await loadTaskForResume("conv_persisted");
  expect(live?.canContinue).toBe(true);

  // 心跳停了（超过恢复阈值）= 上次进程留下的残档 → 判定为僵尸并落成 interrupted
  await flushTask(record({ instanceId: "other-instance", updatedAt: Date.now() - 20 * 60_000 }), []);
  const zombie = await loadTaskForResume("conv_persisted");
  expect(zombie?.canContinue).toBe(false);
  expect(zombie?.record.status).toBe("interrupted");
  expect((await loadTaskRecord("conv_persisted"))?.status).toBe("interrupted");

  // 已跑完的留档：不能继续，但状态如实保留为 success——收口语由它决定，
  // 不能一律说「被中断」（那会让用户以为结果不完整，而它其实已经跑完）
  await flushTask(record({ instanceId: "other-instance", status: "success", settledAt: Date.now() }), []);
  const done = await loadTaskForResume("conv_persisted");
  expect(done?.canContinue).toBe(false);
  expect(done?.record.status).toBe("success");
});

test("[C] 恢复扫描只挑「别人的 + 心跳过期的 running」", async () => {
  const now = Date.now();
  await flushTask(
    record({ conversationId: "conv_stale", taskId: "t_stale", instanceId: "old-proc", updatedAt: now - 10 * 60_000 }),
    [],
  );
  await flushTask(
    record({ conversationId: "conv_fresh", taskId: "t_fresh", instanceId: "old-proc", updatedAt: now }),
    [],
  );
  await flushTask(
    record({ conversationId: "conv_mine", taskId: "t_mine", instanceId: "this-proc", updatedAt: now - 10 * 60_000 }),
    [],
  );
  const stale = await listStaleRunningTasks(now - 2 * 60_000, "this-proc");
  const ids = stale.map((s) => s.conversationId);
  expect(ids).toContain("conv_stale");
  expect(ids).not.toContain("conv_fresh"); // 心跳还新鲜
  expect(ids).not.toContain("conv_mine"); // 自己的任务由自己的看门狗负责

  // 显式改状态（恢复流程调的就是它）
  expect(await markTaskInterrupted("conv_stale")).toBe(true);
  expect((await loadTaskRecord("conv_stale"))?.status).toBe("interrupted");
});

test("[D] 留档回放：正文快照 + 只回放游标之后的事件", () => {
  const rec = record({
    text: "完整正文",
    textSeq: 5,
    events: [
      { type: "tool_call", id: "t1", name: "fs_read", seq: 2 },
      { type: "usage", tokens: 1, budget: 2, window: 3, turns: 1, dropped: 0, toolResultsCleared: 0, seq: 4 },
      { type: "done", seq: 5 },
    ],
  });
  // 从头：先正文快照（替换语义），再按序回放
  expect(replayRecord(rec, 0).map((e) => e.type)).toEqual(["text", "tool_call", "usage", "done"]);
  // 游标 2：跳过早于游标的事件，正文快照仍在（水位 5 > 2）
  expect(replayRecord(rec, 2).map((e) => e.type)).toEqual(["text", "usage", "done"]);
  // 游标已在末尾：没有可补的（调用方会补终态 done）
  expect(replayRecord(rec, 5)).toEqual([]);

  // 重复落档（写失败后的重试可能把同一批写两遍）→ 按 seq 去重，避免步骤/图卡渲染两遍
  const dup = record({
    text: "",
    textSeq: 0,
    events: [
      { type: "tool_call", id: "t1", name: "fs_read", seq: 2 },
      { type: "tool_call", id: "t1", name: "fs_read", seq: 2 },
      { type: "done", seq: 3 },
      { type: "done", seq: 3 },
    ],
  });
  expect(replayRecord(dup, 0).map((e) => e.seq)).toEqual([2, 3]);
});

test("[F] 进程退出：把自己在跑的任务就地标成 interrupted 并落档（不等心跳过期）", async () => {
  const a = startTask({ conversationId: "conv_quit_a", userText: "hi" });
  const b = startTask({ conversationId: "conv_quit_b", userText: "hi" });
  publishTaskEvent(a, { type: "text_delta", text: "半截正文" });
  const n = await interruptOwnRunningTasks("SIGTERM");
  expect(n).toBe(2);
  expect(getRunningTask("conv_quit_a")).toBeUndefined();
  expect(getRunningTask("conv_quit_b")).toBeUndefined();

  // 状态与已产出的正文一起落档：晚到的重连据此补齐内容并如实收口
  const rec = await loadTaskRecord("conv_quit_a");
  expect(rec?.status).toBe("interrupted");
  expect(rec?.text).toBe("半截正文");
  expect(await getRetainedTask("conv_quit_a")).toBeDefined();
  expect((await loadTaskForResume("conv_quit_a"))?.canContinue).toBe(false);
});

test("[E] 无进展看门狗判据：只认实质事件，阈值内不判死", () => {
  const now = 1_000_000;
  expect(stallIdleMs({ lastEventAt: now }, now, 600_000)).toBeNull();
  expect(stallIdleMs({ lastEventAt: now - 599_999 }, now, 600_000)).toBeNull();
  expect(stallIdleMs({ lastEventAt: now - 600_000 }, now, 600_000)).toBe(600_000);
  expect(stallIdleMs({ lastEventAt: now - 900_000 }, now, 600_000)).toBe(900_000);
});
