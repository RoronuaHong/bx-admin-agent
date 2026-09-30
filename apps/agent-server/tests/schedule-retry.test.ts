// 调度补跑（方案 A）行为覆盖：到点但对话正忙时**不空过**——
// 钉住到点时刻排队重试；窗口内跑成 → 推进下一周期并清掉旧说明；超窗 → 如实记为「已错过」。
//
// 两个易错点各有一条专门用例：
//   · 等待窗口按「真正开始排队的时刻」计时，不按到点时刻——同刻多任务被串行 tick 依次执行，
//     按到点时刻计时会把「被前面任务挤后」误判成「等了太久，已错过」。
//   · 排队中的一次性任务不能被停用，否则这一期永远补不上。
//
// 用独立库名（bx_agent_schedule_probe）跑：不碰真实 chat_schedules，也躲开常驻调度循环。
import { test, expect, beforeAll, afterAll } from "vitest";

process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
process.env.MONGO_DB_NAME = "bx_agent_schedule_probe";

const { createSchedule, patchSchedule, deleteSchedule, getSchedule, nextRunOf, requestScheduleRun, schedulerTick } = await import(
  "../src/schedules.js"
);

const OWNER = "probe_owner_schedule";
const MIN = 60_000;
let id = "";

beforeAll(async () => {
  const s = await createSchedule({ conversationId: "conv_probe", ownerKey: OWNER, prompt: "probe", cron: "0 * * * *" });
  id = s.id;
});

afterAll(async () => {
  await deleteSchedule(id, OWNER);
});

test("到点但对话正忙：钉住到点时刻排队重试，不推进下一周期、也不算一次运行", async () => {
  const now = Date.now();
  const due = now - 20_000;
  await patchSchedule(id, OWNER, { nextRunAt: due });

  const runs: string[] = [];
  await schedulerTick(async (s) => {
    runs.push(s.id);
    return "skipped";
  }, now);

  expect(runs).toContain(id);
  const after = await getSchedule(id);
  expect(after?.nextRunAt).toBe(due); // 关键：没有被推到下一周期，下一 tick 还会到点
  expect(after?.queuedSince).toBe(now); // 排队起点被记下（窗口按它计时）
  expect(after?.lastStatus).toBe("skipped");
  expect(after?.lastNote || "").toContain("排队等待补跑");
  expect(after?.lastRunAt).toBeUndefined(); // 只是在等，不算跑过一次
});

test("到点已久但从未排过队（被同刻其它任务串行挤后）：先排队，不直接判错过", async () => {
  // 成功跑一轮清掉上一用例留下的排队起点（成功轮会清 queuedSince）。
  await schedulerTick(async () => "success", Date.now());
  expect((await getSchedule(id))?.queuedSince).toBeUndefined();

  const now = Date.now();
  await patchSchedule(id, OWNER, { nextRunAt: now - 11 * MIN });

  await schedulerTick(async () => "skipped", now);

  const after = await getSchedule(id);
  expect(after?.queuedSince).toBe(now);
  expect(after?.lastNote || "").toContain("排队等待补跑"); // 不是「已错过」
});

test("对话空闲后补跑成功：推进下一周期，并清掉等待说明与排队起点", async () => {
  const now = Date.now();
  await patchSchedule(id, OWNER, { nextRunAt: now - 5 * MIN });

  await schedulerTick(async () => "success", now);

  const after = await getSchedule(id);
  expect(after?.lastStatus).toBe("success");
  expect(after?.lastNote).toBe(""); // 旧说明必须被覆盖，否则界面看着像这轮也被跳过
  expect(after?.queuedSince).toBeUndefined(); // 下一期重新计时
  // lastRunAt / nextRunAt 按「跑完时刻」记账：长跑结束后不会落到已经过去的 cron 拍上连环补跑。
  expect(after?.lastRunAt || 0).toBeGreaterThanOrEqual(now);
  expect(after?.nextRunAt || 0).toBeGreaterThan(after?.lastRunAt || 0);
});

test("对话持续占用超过等待窗口：如实记为已错过并推进下一周期（不做无限重试）", async () => {
  const now = Date.now();
  await patchSchedule(id, OWNER, { nextRunAt: now - 20_000 });
  await schedulerTick(async () => "skipped", now); // 第 1 次：开始排队
  expect((await getSchedule(id))?.queuedSince).toBe(now);

  const later = now + 11 * MIN; // 11 分钟后仍被占用 → 超窗
  await schedulerTick(async () => "skipped", later);

  const after = await getSchedule(id);
  expect(after?.lastStatus).toBe("skipped");
  expect(after?.lastNote || "").toContain("已错过");
  expect(after?.queuedSince).toBeUndefined();
  expect(after?.nextRunAt || 0).toBeGreaterThan(later);
});

test("长跑结束后 nextRunAt 落在『跑完之后』的下一拍，避免 */5 连环补跑", async () => {
  await patchSchedule(id, OWNER, { cron: "*/5 * * * *", nextRunAt: Date.now() - 1000 });
  const started = Date.now();
  await schedulerTick(async () => {
    await new Promise((r) => setTimeout(r, 50));
    return "success";
  }, started);
  const after = await getSchedule(id);
  const finishedFloor = started + 40;
  expect(after?.lastRunAt || 0).toBeGreaterThanOrEqual(finishedFloor);
  expect(after?.nextRunAt || 0).toBeGreaterThan(after?.lastRunAt || 0);
});

test("运行途中被暂停：收尾保持暂停，不再排下一拍", async () => {
  const now = Date.now();
  await patchSchedule(id, OWNER, { enabled: true, cron: "0 * * * *", nextRunAt: now - 1000 });
  await schedulerTick(async (s) => {
    await patchSchedule(s.id, OWNER, { enabled: false });
    return "success";
  }, now);
  const after = await getSchedule(id);
  expect(after?.enabled).toBe(false);
  expect(after?.nextRunAt).toBeUndefined();
  expect(after?.lastStatus).toBe("success");
});

test("运行途中被删除：收尾不得用开跑前的快照把任务写回去", async () => {
  const sid = (
    await createSchedule({ conversationId: "conv_probe_del", ownerKey: OWNER, prompt: "probe", cron: "0 * * * *" })
  ).id;
  try {
    await patchSchedule(sid, OWNER, { nextRunAt: Date.now() - 1000 });
    await schedulerTick(async (s) => {
      await deleteSchedule(s.id, OWNER);
      return "success";
    }, Date.now());
    expect(await getSchedule(sid)).toBeNull();
  } finally {
    await deleteSchedule(sid, OWNER);
  }
});

test("一次性任务到点但被占用：窗口内不误停用、超窗才如实记错过并停用", async () => {
  const onceId = (
    await createSchedule({ conversationId: "conv_probe_once", ownerKey: OWNER, prompt: "probe", onceAt: Date.now() })
  ).id;
  try {
    const now = Date.now();
    await patchSchedule(onceId, OWNER, { onceAt: now - 20_000 });
    await schedulerTick(async () => "skipped", now);
    let after = await getSchedule(onceId);
    expect(after?.enabled).toBe(true); // 还在排队，不能被停用（否则这一次永远补不上）
    expect(after?.lastNote || "").toContain("排队等待补跑");

    // 超出窗口：一次性任务如实记为错过并停用（不再有机会补跑）
    await schedulerTick(async () => "skipped", now + 11 * MIN);
    after = await getSchedule(onceId);
    expect(after?.enabled).toBe(false);
    expect(after?.nextRunAt).toBeUndefined();
    expect(after?.lastNote || "").toContain("已错过");
  } finally {
    await deleteSchedule(onceId, OWNER);
  }
});

test("立即执行不改原来的下一拍", async () => {
  const now = Date.now();
  const held = now + 3 * 60 * 60_000;
  await patchSchedule(id, OWNER, { enabled: true, cron: "0 * * * *", purpose: "report", nextRunAt: held });
  const queued = await requestScheduleRun(id, OWNER);
  expect(queued?.holdNextRunAt).toBe(held);
  expect(queued?.runRequestedAt).toBeGreaterThan(0);
  await schedulerTick(async () => "success", now + 5_000);
  const after = await getSchedule(id);
  expect(after?.nextRunAt).toBe(held);
  expect(after?.runRequestedAt).toBeUndefined();
  expect(after?.holdNextRunAt).toBeUndefined();
  expect(after?.enabled).toBe(true);
  expect(after?.lastStatus).toBe("success");
});

test("事件唤醒带上原因，跑完还原下一拍并清掉原因", async () => {
  const now = Date.now();
  const held = now + 2 * 60 * 60_000;
  await patchSchedule(id, OWNER, { enabled: true, cron: "0 * * * *", purpose: "report", nextRunAt: held });
  await requestScheduleRun(id, OWNER, "队列堆积");
  let seen = "";
  await schedulerTick(async (s) => {
    seen = s.wakeReason || "";
    return "success";
  }, now + 1_000);
  expect(seen).toBe("队列堆积");
  const after = await getSchedule(id);
  expect(after?.wakeReason).toBeUndefined();
  expect(after?.nextRunAt).toBe(held);
});

test("暂停中的立即执行跑完仍暂停，不再排下一拍", async () => {
  await patchSchedule(id, OWNER, { enabled: false });
  await requestScheduleRun(id, OWNER);
  await schedulerTick(async () => "success", Date.now());
  const after = await getSchedule(id);
  expect(after?.enabled).toBe(false);
  expect(after?.nextRunAt).toBeUndefined();
  expect(after?.runRequestedAt).toBeUndefined();
});

test("预警破线后下一拍比 cron 更密，cron 本身不改", async () => {
  const now = Date.now();
  await patchSchedule(id, OWNER, {
    enabled: true,
    cron: "0 0 1 6 *",
    purpose: "alert",
    nextRunAt: now - 1_000,
    lastMarker: "SPIKE",
    alertState: { firing: true, lastAlertAt: now },
  });
  await schedulerTick(async () => "success", now);
  const after = await getSchedule(id);
  expect(after?.cron).toBe("0 0 1 6 *");
  const cronNext = nextRunOf("0 0 1 6 *", new Date((after?.lastRunAt || now) + 1000));
  expect(cronNext).toBeTruthy();
  expect(after?.nextRunAt || 0).toBeLessThan(cronNext || 0);
  expect((after?.nextRunAt || 0) - (after?.lastRunAt || 0)).toBeGreaterThanOrEqual(5 * 60_000 - 50);
});
