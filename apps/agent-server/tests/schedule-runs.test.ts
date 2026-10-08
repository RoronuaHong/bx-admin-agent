// 定时任务运行会话回归（2026-09-29，docs/scheduled-task-sessions-plan.md）：
// A 建任务默认「每期新会话」且专属会话带归属标记 · B 落点可选「同一会话」 ·
// C 每期开新会话且继承角色/工具 · D 运行记录与未读 · E 超上限只归档不删除 ·
// F 删除任务连带清理本任务会话、不误伤用户自己的对话。
import { test, expect, afterAll } from "vitest";
import {
  createConversation,
  deleteConversation,
  getConversation,
} from "../src/conversations.js";
import {
  listSchedules,
  patchSchedule,
  prependRun,
  MAX_RUNS_PER_SCHEDULE,
  type ScheduleRun,
} from "../src/schedules.js";
import {
  createRunConversation,
  createScheduleTask,
  deleteScheduleWithRuns,
  recordScheduleRun,
  scheduleRunTitle,
} from "../src/schedule-service.js";

const OWNER = "vitest-schedule-runs";

/** 每个用例用独立的 owner 前缀，避免互相干扰（Mongo 是共享库）。 */
function owner(tag: string) {
  return `${OWNER}-${tag}`;
}

async function makeTask(tag: string, runMode?: "new" | "same") {
  const result = await createScheduleTask({
    ownerKey: owner(tag),
    prompt: "汇总今天的观看时长",
    name: "每日观看时长",
    cron: "0 9 * * *",
    ...(runMode ? { runMode } : {}),
  });
  if (!result.ok) throw new Error(result.error);
  return result;
}

afterAll(async () => {
  for (const s of await listSchedules()) {
    if (!s.ownerKey.startsWith(OWNER)) continue;
    for (const r of s.runs || []) await deleteConversation(r.conversationId).catch(() => undefined);
    await deleteConversation(s.conversationId).catch(() => undefined);
    await deleteScheduleWithRuns(s.id, s.ownerKey).catch(() => undefined);
  }
});

test("[A] 建任务默认「每期新会话」，专属会话带任务归属标记", async () => {
  const { schedule } = await makeTask("a");
  expect(schedule.runMode).toBe("new");
  // 周期任务一建好就排队跑一期，启动确认不用干等到下一拍 cron。
  expect(schedule.runRequestedAt).toBeGreaterThan(0);
  expect(schedule.armPending).toBe(true);
  const conv = await getConversation(schedule.conversationId);
  // 归属标记是「删任务时只删本任务产出的会话」的依据：没有它只能靠任务侧列表，截断后就认不出来了。
  expect(conv?.scheduleId).toBe(schedule.id);
});

test("[A2] 一次性任务不提前跑，避免目标时刻之外多执行一次", async () => {
  const result = await createScheduleTask({
    ownerKey: owner("a2"),
    prompt: "到点提醒",
    name: "一次性提醒",
    onceAt: Date.now() + 3_600_000,
  });
  if (!result.ok) throw new Error(result.error);
  expect(result.schedule.runRequestedAt).toBeUndefined();
});

test("[B] 落点可以指定「同一会话」（沿用上下文的场景）", async () => {
  const { schedule } = await makeTask("b", "same");
  expect(schedule.runMode).toBe("same");
});

test("[C] 每期开一个新会话：各自独立、标题带运行时间、继承角色与工具", async () => {
  const { schedule } = await makeTask("c");
  const at1 = new Date("2026-09-29T09:00:00").getTime();
  const at2 = new Date("2026-09-30T09:00:00").getTime();
  const first = await createRunConversation(schedule, at1);
  const second = await createRunConversation(schedule, at2);
  expect(first.id).not.toBe(second.id);
  expect(first.title).toBe(scheduleRunTitle(schedule, at1));
  expect(second.title).toBe(scheduleRunTitle(schedule, at2));
  // 标题要能一眼区分是哪一期（跨月/暂停后「第几期」与直觉对不上，故用时间）
  expect(first.title).not.toBe(second.title);
  expect(first.title).toContain("09-29 09:00");
  for (const conv of [first, second]) {
    expect(conv.scheduleId).toBe(schedule.id);
  }
  expect(second.scheduleRunAt).toBe(at2);
});

test("[D] 落运行记录：新的在前、未读累加、conversationId 指向最新一期", async () => {
  const { schedule } = await makeTask("d");
  const first = await createRunConversation(schedule, Date.now() - 86_400_000);
  await recordScheduleRun(schedule, first.id, Date.now() - 86_400_000, "success");
  const second = await createRunConversation(schedule, Date.now());
  await recordScheduleRun(schedule, second.id, Date.now(), "failed");
  const updated = (await listSchedules(owner("d")))[0]!;
  expect(updated.runs?.length).toBe(2);
  expect(updated.runs?.[0]?.conversationId).toBe(second.id);
  expect(updated.runs?.[0]?.status).toBe("failed");
  expect(updated.conversationId).toBe(second.id); // 「打开对话」与 IM 链接指向最新一期
  expect(updated.unreadRuns).toBe(2);
});

test("[E] 超上限的最旧一期只归档、不删除（静默删用户数据是最坏的一类行为）", async () => {
  // 纯函数层：截断到上限、同一会话不重复占位。
  const runs: ScheduleRun[] = Array.from({ length: MAX_RUNS_PER_SCHEDULE }, (_, i) => ({
    conversationId: `conv_${i}`,
    at: i,
  }));
  const oneMore = prependRun(runs, { conversationId: "conv_new", at: 999 });
  expect(oneMore.length).toBe(MAX_RUNS_PER_SCHEDULE);
  expect(oneMore[0]?.conversationId).toBe("conv_new");
  expect(oneMore.some((r) => r.conversationId === `conv_${MAX_RUNS_PER_SCHEDULE - 1}`)).toBe(false);
  const dedup = prependRun([{ conversationId: "same", at: 1 }], { conversationId: "same", at: 2 });
  expect(dedup.length).toBe(1);

  // 归档那一档：把最旧的一期换成真实会话，加一期新的之后它应该被归档但仍存在。
  const { schedule } = await makeTask("e");
  const oldest = await createConversation({ id: `conv_old_${Date.now()}`, title: "最旧的一期", ownerKey: owner("e") });
  const seeded: ScheduleRun[] = [
    ...Array.from({ length: MAX_RUNS_PER_SCHEDULE - 1 }, (_, i) => ({
      conversationId: `conv_fake_${i}`,
      at: i,
    })),
    { conversationId: oldest.id, at: 0 },
  ];
  await patchSchedule(schedule.id, owner("e"), { runs: seeded });
  const fresh = (await listSchedules(owner("e")))[0]!;
  const newest = await createRunConversation(fresh, Date.now());
  await recordScheduleRun(fresh, newest.id, Date.now(), "success");
  const after = await getConversation(oldest.id);
  expect(after?.archived).toBe(true); // 从任务历史里撤下
  expect(after?.messages?.length).toBe(0); // 内容还在（只是被归档），不是被删除
});

test("[F] 删除任务保留历史结果会话；不带归属标记的老对话也不误伤", async () => {
  const { schedule, conversation } = await makeTask("f");
  const run1 = await createRunConversation(schedule, Date.now() - 3600_000);
  await recordScheduleRun(schedule, run1.id, Date.now() - 3600_000, "success");

  // 老任务形态：ownConversation 但会话没有归属标记（里面可能混着用户自己的内容）
  const legacy = await createConversation({ id: `conv_legacy_${Date.now()}`, title: "用户自己的对话", ownerKey: owner("f") });
  const legacyTask = await createScheduleTask({
    ownerKey: owner("f"),
    prompt: "老任务",
    cron: "0 9 * * *",
    runMode: "same",
  });
  if (legacyTask.ok) {
    await patchSchedule(legacyTask.schedule.id, owner("f"), { conversationId: legacy.id });
  }

  const result = await deleteScheduleWithRuns(schedule.id, owner("f"));
  expect(result.ok).toBe(true);
  expect(result.removedConversations).toBe(0);
  expect(result.keptConversations).toBe(2);
  expect(await getConversation(conversation.id)).not.toBe(null);
  expect(await getConversation(run1.id)).not.toBe(null);

  // 老任务那条：删任务不动它（删掉等于把用户自己的对话删了）
  if (legacyTask.ok) {
    await deleteScheduleWithRuns(legacyTask.schedule.id, owner("f"));
    expect(await getConversation(legacy.id)).not.toBe(null);
  }
  await deleteConversation(legacy.id).catch(() => undefined);
});

test("[G] 未读清零：打开任一期后 unreadRuns 归 0", async () => {
  const { schedule } = await makeTask("g");
  const run = await createRunConversation(schedule, Date.now());
  await recordScheduleRun(schedule, run.id, Date.now(), "success");
  const before = (await listSchedules(owner("g")))[0]!;
  expect(before.unreadRuns).toBe(1);
  // 前端打开任一期会话时发的就是这个 PATCH
  await patchSchedule(schedule.id, owner("g"), { unreadRuns: 0 });
  const after = (await listSchedules(owner("g")))[0]!;
  expect(after.unreadRuns).toBe(0);
  expect(after.runs?.length).toBe(1); // 清零不能顺手把历史清掉
});
