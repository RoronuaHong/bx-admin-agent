// 定时任务工具化回归（2026-09-24，docs/artifact-delivery-plan.md §17）：
// A 工具建任务必须连带建「任务专属对话」（与 HTTP 同一实现，否则结果会刷进当前聊天）·
// B list_schedules 只读免确认 · C manage_schedule 走确认闸门 ·
// D 暂停/恢复/删除 · E 时间参数与配额校验走同一套错误。
import { test, expect, afterAll } from "vitest";
import { execBuiltin, BUILTIN_RISK } from "../src/builtins.js";
import { listSchedules, deleteSchedule, patchSchedule } from "../src/schedules.js";
import { getConversation, deleteConversation } from "../src/conversations.js";
import { verdictNeedsConfirm, resolveToolRisk } from "../src/risk.js";

const OWNER = "vitest-schedule-owner";
const CONV = "vitest-schedule-conv";

const run = (name: string, args: Record<string, unknown>) =>
  execBuiltin(name, JSON.stringify(args), CONV, "generic", OWNER);

afterAll(async () => {
  for (const s of await listSchedules(OWNER)) {
    await deleteSchedule(s.id, OWNER);
    await deleteConversation(s.conversationId).catch(() => undefined);
  }
});

test("[A] 用工具建定时任务 → 会建任务专属对话（不复用当前对话，避免周期结果刷屏）", async () => {
  const out = await run("manage_schedule", {
    action: "create",
    prompt: "汇总今天的观看时长",
    name: "日报",
    cron: "0 9 * * *",
  });
  expect(out.ok, out.text).toBe(true);
  expect(out.text).toContain("专属对话");
  const list = await listSchedules(OWNER);
  expect(list.length).toBe(1);
  const created = list[0]!;
  expect(created.ownConversation).toBe(true);
  expect(created.conversationId).not.toBe(CONV); // 关键：不是当前对话
  const conv = await getConversation(created.conversationId);
  expect(conv?.title).toContain("日报");
});

test("[B] list_schedules 能列出刚建的任务，且登记为只读（免确认）", async () => {
  expect(BUILTIN_RISK.list_schedules.level).toBe("read");
  expect(verdictNeedsConfirm(resolveToolRisk("list_schedules"))).toBe(false);
  const out = await run("list_schedules", {});
  expect(out.ok).toBe(true);
  expect(out.text).toContain("日报");
});

test("[C] manage_schedule 走确认闸门（write + external）", () => {
  expect(BUILTIN_RISK.manage_schedule.level).toBe("write");
  expect(BUILTIN_RISK.manage_schedule.scope).toBe("external");
  expect(verdictNeedsConfirm(resolveToolRisk("manage_schedule"))).toBe(true);
});

test("[D] 暂停 → 恢复 → 删除（按 id 操作，删除不可恢复）", async () => {
  const list = await listSchedules(OWNER);
  const id = list[0]!.id;
  expect((await run("manage_schedule", { action: "pause", id })).ok).toBe(true);
  expect((await listSchedules(OWNER))[0]!.enabled).toBe(false);
  expect((await run("manage_schedule", { action: "resume", id })).ok).toBe(true);
  expect((await listSchedules(OWNER))[0]!.enabled).toBe(true);
  expect((await run("manage_schedule", { action: "delete", id })).ok).toBe(true);
  expect(await listSchedules(OWNER)).toHaveLength(0);
  // 不存在的 id：明确报错而不是静默成功
  const missing = await run("manage_schedule", { action: "delete", id: "nope" });
  expect(missing.ok).toBe(false);
  expect(missing.text).toContain("不存在");
});

test("[E] 参数校验与 HTTP 同一套：缺 prompt / 时间非法 / 未知 action 都明确报错", async () => {
  const noPrompt = await run("manage_schedule", { action: "create", cron: "0 9 * * *" });
  expect(noPrompt.ok).toBe(false);
  expect(noPrompt.text).toContain("需要 prompt");
  const badTime = await run("manage_schedule", { action: "create", prompt: "x" });
  expect(badTime.ok).toBe(false);
  const badAction = await run("manage_schedule", { action: "explode" });
  expect(badAction.ok).toBe(false);
  expect(badAction.text).toContain("不支持的 action");
  // 收尾：清掉 [E] 里可能建成的任务
  for (const s of await listSchedules(OWNER)) await deleteSchedule(s.id, OWNER);
});

test("[F] 无 ownerKey 时如实拒绝（不做「全员可见」的兜底）", async () => {
  const out = await execBuiltin("list_schedules", JSON.stringify({}), CONV, "generic");
  expect(out.ok).toBe(false);
  expect(out.text).toContain("缺少用户标识");
});
