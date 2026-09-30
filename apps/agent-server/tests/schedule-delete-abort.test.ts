// 回归（2026-09-30）：删除「正在运行」的定时任务必须立即中断在途运行（abort），
// 否则运行跑完仍会把结果（如 [NO_DATA] 预警）写进对话并投递，表现为「删了还收到预警」。
// 用动态 import 在设置内存模式之后再加载 schedules，避免污染真实库。
process.env.MONGO_URI = "mongodb://127.0.0.1:1"; // 不可达端口 → getColl 立即失败降级内存
const {
  createSchedule,
  deleteSchedule,
  registerActiveScheduleRun,
  unregisterActiveScheduleRun,
  listSchedules,
} = await import("../src/schedules.js");
import { test, expect, afterAll } from "vitest";

const OWNER = "vitest-del-abort-owner";

afterAll(async () => {
  for (const s of await listSchedules(OWNER)) await deleteSchedule(s.id, OWNER);
});

test("删除运行中的定时任务 → 在途运行被 abort，且注册表清理", async () => {
  // 内存模式下每次 getColl 对不可达端口走 serverSelectionTimeoutMS(3s)，故放宽超时。
  const controller = new AbortController();
  const schedule = await createSchedule({ conversationId: "conv-x", ownerKey: OWNER, prompt: "p" });
  registerActiveScheduleRun(schedule.id, controller);
  expect(controller.signal.aborted).toBe(false); // 前置：删除前确实在跑

  const ok = await deleteSchedule(schedule.id, OWNER);

  expect(ok).toBe(true);
  expect(controller.signal.aborted).toBe(true); // 关键：删除即中断
  expect(registerActiveScheduleRun === unregisterActiveScheduleRun).toBe(false);
  unregisterActiveScheduleRun(schedule.id); // 调用方（runner）在 finally 里做，这里幂等清理
}, 20000);

test("删除不存在 / 非本人的任务返回 false，且不抛错", async () => {
  expect(await deleteSchedule("nope", OWNER)).toBe(false);
  expect(await deleteSchedule("nope", "other-owner")).toBe(false);
}, 20000);
