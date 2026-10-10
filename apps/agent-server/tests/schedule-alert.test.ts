import { test, expect } from "vitest";
import {
  alertNextRunAt,
  buildUnattendedConclusion,
  ALERT_FAIL_REPEAT_MS,
  commitAlertFailureNotice,
  decideAlertDelivery,
  decideAlertFailure,
  deliveryArmPurpose,
  needsArmNotice,
  CONCLUSION_GAP,
  CONCLUSION_GAP_AFTER_TOOLS,
  alertAboveFromPrompt,
  fillCountAbove,
  applyScheduledCountFacts,
  formatScheduledCountFacts,
  markerFromCountText,
  parseAlertMarker,
  stampAlertMarker,
  pickNotifyPolicy,
  scheduleFinishedStatus,
  shouldDeliverScheduleResult,
  pickPurpose,
  SCHEDULE_UNGROUNDED_ALERT,
  SCHEDULE_UNGROUNDED_REPORT,
  SCHEDULE_DENIED_BUILTINS,
  unattendedDenySentence,
  unattendedToolDenial,
} from "../src/schedule-alert.js";
import { garbledTextReason, scheduleLockPid, validateTiming } from "../src/schedules.js";

test("scheduleLockPid：只认本机 owner 里的 pid", () => {
  expect(scheduleLockPid("DESKTOP-1-62232-ab12", "DESKTOP-1")).toBe(62232);
  expect(scheduleLockPid("OTHER-62232-ab12", "DESKTOP-1")).toBeNull();
  expect(scheduleLockPid("DESKTOP-1-nope-ab12", "DESKTOP-1")).toBeNull();
});

test("parseAlertMarker：认首行协议标记，忽略正文", () => {
  expect(parseAlertMarker("[SPIKE]\n印度对话量 420")).toBe("SPIKE");
  expect(parseAlertMarker("  [normal]  ")).toBe("NORMAL");
  expect(parseAlertMarker("[NO_DATA] 取数失败")).toBe("NO_DATA");
  expect(parseAlertMarker("正常，没有暴涨")).toBe(null);
  expect(parseAlertMarker("")).toBe(null);
});

test("没有协议结论的预警记失败，有标记的记成功", () => {
  expect(scheduleFinishedStatus({ finished: "success", text: "", ungrounded: false, alert: true })).toBe("failed");
  expect(
    scheduleFinishedStatus({
      finished: "success",
      text: CONCLUSION_GAP_AFTER_TOOLS,
      ungrounded: false,
      alert: true,
    }),
  ).toBe("failed");
  expect(
    scheduleFinishedStatus({
      finished: "success",
      text: `${CONCLUSION_GAP_AFTER_TOOLS}\n- 名称：客服预警。状态：已启用。频率：每 10 分钟。`,
      ungrounded: false,
      alert: true,
    }),
  ).toBe("failed");
  expect(
    scheduleFinishedStatus({
      finished: "success",
      text: "当前数量 12 条，未破线",
      ungrounded: false,
      alert: true,
    }),
  ).toBe("failed");
  expect(
    scheduleFinishedStatus({
      finished: "success",
      text: "[NORMAL]\n当前数量 12 条\n- 名称：客服预警。状态：已启用。频率：每 10 分钟。",
      ungrounded: false,
      alert: true,
    }),
  ).toBe("success");
  expect(
    scheduleFinishedStatus({ finished: "success", text: "[NO_DATA]\n没有取到数据", ungrounded: true, alert: true }),
  ).toBe("success");
  expect(
    scheduleFinishedStatus({ finished: "success", text: CONCLUSION_GAP, ungrounded: false, alert: false }),
  ).toBe("failed");
  expect(scheduleFinishedStatus({ finished: "cancelled", text: "[NORMAL]", ungrounded: false, alert: true })).toBe(
    "cancelled",
  );
});

test("pickNotifyPolicy / pickPurpose", () => {
  expect(pickNotifyPolicy("on_alert")).toBe("on_alert");
  expect(pickNotifyPolicy("always")).toBe("always");
  expect(pickNotifyPolicy(undefined)).toBe("always");
  expect(pickPurpose("alert")).toBe("alert");
  expect(pickPurpose("nope")).toBe(undefined);
});

test("decideAlertDelivery：连续 SPIKE 每期都推", () => {
  const t0 = 1_700_000_000_000;
  const first = decideAlertDelivery({ marker: "SPIKE", now: t0 });
  expect(first.kind).toBe("spike");
  expect(first.nextState.firing).toBe(true);
  expect(first.nextState.lastAlertAt).toBe(t0);

  const again = decideAlertDelivery({
    marker: "SPIKE",
    alertState: first.nextState,
    now: t0 + 60_000,
  });
  expect(again.kind).toBe("spike");
  expect(again.nextState.lastAlertAt).toBe(t0 + 60_000);
  expect(again.nextState.normalStreak).toBe(0);
});

test("needsArmNotice / deliveryArmPurpose：欠确认才发；文案跟通知策略走", () => {
  expect(needsArmNotice({ armPending: true, armedNotifiedAt: 1, notifyPolicy: "always", lastRunAt: 1 })).toBe(true);
  expect(needsArmNotice({ notifyPolicy: "on_alert" })).toBe(true);
  expect(needsArmNotice({ notifyPolicy: "on_alert", armedNotifiedAt: 5, lastRunAt: 5 })).toBe(false);
  expect(needsArmNotice({ notifyPolicy: "always", lastRunAt: 5 })).toBe(false);
  expect(needsArmNotice({ notifyPolicy: "always" })).toBe(true);
  expect(needsArmNotice({ notifyPolicy: "always", lastRunAt: 5, armPending: true })).toBe(true);
  expect(deliveryArmPurpose({ purpose: "report", notifyPolicy: "on_alert" })).toBe("alert");
  expect(deliveryArmPurpose({ purpose: "alert", notifyPolicy: "always" })).toBe("alert");
  expect(deliveryArmPurpose({ purpose: "report", notifyPolicy: "always" })).toBe("report");
});

test("decideAlertDelivery：启用后第一期，未破线也要推启动确认；破线仍算异常", () => {
  const quiet = decideAlertDelivery({ marker: "NORMAL", arming: true });
  expect(quiet.kind).toBe("started");
  expect(quiet.nextState.firing).toBe(false);

  const nodata = decideAlertDelivery({ marker: "NO_DATA", arming: true });
  expect(nodata.kind).toBe("started");
  expect(nodata.nextState.firing).toBe(false);

  const unmarked = decideAlertDelivery({ marker: null, arming: true });
  expect(unmarked.kind).toBe("started");

  const spike = decideAlertDelivery({ marker: "SPIKE", arming: true, now: 50 });
  expect(spike.kind).toBe("spike");
  expect(spike.nextState.firing).toBe(true);

  const later = decideAlertDelivery({ marker: "NORMAL", alertState: quiet.nextState });
  expect(later.kind).toBe("skip");
});

test("计数比较由引擎落标记，不完整时整段换成无数据", () => {
  expect(markerFromCountText("complete: false\nreason: 输入流无效")).toBe("NO_DATA");
  expect(markerFromCountText("complete: true\nabove: 300\nover_count: 0\n")).toBe("NORMAL");
  expect(markerFromCountText("complete: true\nabove: 300\nover_count: 2\n")).toBe("SPIKE");
  expect(markerFromCountText("complete: true\nunique: 18\n")).toBeNull();
  const prompt = "超过300的1小时会话量，就要预警\n时间窗口：最近 60 分钟\n超过 300 → 异常";
  expect(alertAboveFromPrompt(prompt)).toBe(300);
  expect(alertAboveFromPrompt("最近 60 分钟")).toBeNull();
  expect(fillCountAbove({ tool: "x" }, 300).above).toBe(300);
  expect(fillCountAbove({ above: 100 }, 300).above).toBe(100);
  expect(stampAlertMarker("[NORMAL]\n未破线", "SPIKE")).toMatch(/^\[SPIKE\]/);
  expect(stampAlertMarker("未破线", "NORMAL")).toMatch(/^\[NORMAL\]\n未破线/);
  expect(stampAlertMarker("[NORMAL]\n估了 12 条", "NO_DATA")).toBe(SCHEDULE_UNGROUNDED_ALERT);
});

const COUNT_REPORT = [
  "complete: true",
  "reason: 已翻到末页",
  "unique: 33",
  "timezone: Asia/Shanghai",
  "range: 2026-10-09 14:00 .. 2026-10-09 15:00",
  "above: 300",
  "over_count: 0",
  "hours:",
  "2026-10-09 14:00\t19",
  "2026-10-09 15:00\t14",
].join("\n");

test("完整计数的时间窗口、当前数量、阈值三行固定，小时按时间排序", () => {
  expect(formatScheduledCountFacts("complete: false\nunique: 1")).toBeNull();
  expect(formatScheduledCountFacts(COUNT_REPORT)).toBe(
    [
      "- 时间窗口：2026-10-09 14:00 至 2026-10-09 15:00（Asia/Shanghai）",
      "- 当前数量：33（2026-10-09 14:00 为 19，2026-10-09 15:00 为 14），计数完整",
      "- 阈值：超过 300；最高 19，未破线",
    ].join("\n"),
  );
  const spiked = COUNT_REPORT.replace("over_count: 0", "over_count: 1").replace("2026-10-09 15:00\t14", "2026-10-09 15:00\t420");
  expect(formatScheduledCountFacts(spiked)).toContain("最高 420，1 个小时破线");
  const overFirst = [
    "complete: true",
    "unique: 33",
    "timezone: Asia/Shanghai",
    "range: 2026-10-09 14:00 .. 2026-10-09 15:00",
    "above: 300",
    "over_count: 0",
    "2026-10-09 15:00\t420",
    "hours:",
    "2026-10-09 14:00\t19",
    "2026-10-09 15:00\t14",
  ].join("\n");
  expect(formatScheduledCountFacts(overFirst)).toContain("2026-10-09 14:00 为 19，2026-10-09 15:00 为 14");
  expect(formatScheduledCountFacts(overFirst)).not.toContain("420");
  expect(
    applyScheduledCountFacts({ text: "[SPIKE]\n估了", report: "complete: false", conclusion: "alert", marker: "NO_DATA" }),
  ).toBe(SCHEDULE_UNGROUNDED_ALERT);
});

test("预警和定时报告用同一套三行，模型换过的标签会被盖掉", () => {
  const drafted = "[NORMAL]\n- 分小时会话量：15 点时段 18 个，14 点时段 15 个\n- 阈值：两小时均未破线";
  const alert = applyScheduledCountFacts({
    text: drafted,
    report: COUNT_REPORT,
    conclusion: "alert",
    marker: "NORMAL",
  });
  expect(alert.startsWith("[NORMAL]\n- 时间窗口：")).toBe(true);
  expect(alert).toContain("- 当前数量：33（2026-10-09 14:00 为 19，2026-10-09 15:00 为 14），计数完整");
  expect(alert).not.toContain("分小时会话量");
  const report = applyScheduledCountFacts({
    text: "- 当前会话量：33 个\n其余说明保持原样。",
    report: COUNT_REPORT,
    conclusion: "report",
  });
  expect(report.startsWith("- 时间窗口：")).toBe(true);
  expect(report).toContain("其余说明保持原样。");
  expect(report).not.toContain("当前会话量");
});

test("没有结论不投递；有协议标记或模型状态码才投递", () => {
  expect(
    shouldDeliverScheduleResult({
      status: "failed",
      text: CONCLUSION_GAP_AFTER_TOOLS,
      policy: "on_alert",
    }),
  ).toBe(false);
  expect(shouldDeliverScheduleResult({ status: "failed", text: "", policy: "on_alert" })).toBe(false);
  expect(
    shouldDeliverScheduleResult({
      status: "failed",
      text: "工具报错了，但没有首行标记",
      policy: "on_alert",
    }),
  ).toBe(false);
  expect(
    shouldDeliverScheduleResult({
      status: "failed",
      text: "",
      policy: "on_alert",
      modelStatus: true,
    }),
  ).toBe(true);
  expect(
    shouldDeliverScheduleResult({
      status: "success",
      text: "[NORMAL]\n未破线\n- 名称：印度客服对话量预警。状态：已启用。",
      policy: "on_alert",
    }),
  ).toBe(true);
  expect(
    shouldDeliverScheduleResult({
      status: "success",
      text: "[NO_DATA]\n这次没有取到可核对的数据，没有下结论。",
      policy: "on_alert",
    }),
  ).toBe(true);
});

test("decideAlertFailure：刚失败推一条，60 分钟内不重复，期满再推；协议标记清除失败态", () => {
  const t0 = 1_700_000_000_000;
  const first = decideAlertFailure({ now: t0 });
  expect(first.kind).toBe("notify");
  expect(first.nextState.failingSince).toBe(t0);
  expect(first.nextState.failNotifiedAt).toBe(t0);

  const again = decideAlertFailure({ alertState: first.nextState, now: t0 + 5 * 60_000 });
  expect(again.kind).toBe("skip");
  expect(again.nextState.failNotifiedAt).toBe(t0);

  const third = decideAlertFailure({ alertState: again.nextState, now: t0 + 10 * 60_000 });
  expect(third.kind).toBe("skip");

  const later = decideAlertFailure({
    alertState: third.nextState,
    now: t0 + ALERT_FAIL_REPEAT_MS,
  });
  expect(later.kind).toBe("notify");
  expect(later.nextState.failingSince).toBe(t0);
  expect(later.nextState.failNotifiedAt).toBe(t0 + ALERT_FAIL_REPEAT_MS);

  const quiet = decideAlertDelivery({ marker: "NORMAL", alertState: later.nextState, now: t0 + ALERT_FAIL_REPEAT_MS + 1 });
  expect(quiet.kind).toBe("skip");
  expect(quiet.nextState.failingSince).toBeUndefined();
  expect(quiet.nextState.failNotifiedAt).toBeUndefined();

  const spike = decideAlertDelivery({ marker: "SPIKE", alertState: later.nextState, now: t0 + 1 });
  expect(spike.kind).toBe("spike");
  expect(spike.nextState.failingSince).toBeUndefined();
  const nodata = decideAlertDelivery({ marker: "NO_DATA", alertState: later.nextState });
  expect(nodata.kind).toBe("skip");
  expect(nodata.nextState.failingSince).toBeUndefined();

  const reenter = decideAlertFailure({ alertState: quiet.nextState, now: t0 + ALERT_FAIL_REPEAT_MS + 2 });
  expect(reenter.kind).toBe("notify");
  expect(reenter.nextState.failingSince).toBe(t0 + ALERT_FAIL_REPEAT_MS + 2);
});

test("decideAlertFailure：启动确认强制推送，并记成一次失败通知", () => {
  const t0 = 1_700_000_000_000;
  const held = decideAlertFailure({
    now: t0,
    alertState: { firing: false, failingSince: t0 - 60_000, failNotifiedAt: t0 - 60_000 },
    force: true,
  });
  expect(held.kind).toBe("notify");
  expect(held.nextState.failingSince).toBe(t0 - 60_000);
  expect(held.nextState.failNotifiedAt).toBe(t0);
});

test("commitAlertFailureNotice：没发出去不推进失败通知时刻", () => {
  const decided = { firing: false as const, failingSince: 10, failNotifiedAt: 20, normalStreak: 0 };
  expect(commitAlertFailureNotice(decided, undefined, false).failNotifiedAt).toBeUndefined();
  expect(commitAlertFailureNotice(decided, { failNotifiedAt: 5 }, false).failNotifiedAt).toBe(5);
  expect(commitAlertFailureNotice(decided, { failNotifiedAt: 5 }, true).failNotifiedAt).toBe(20);
});

test("decideAlertDelivery：连续 2 期 NORMAL 才恢复；NO_DATA 打断计数", () => {
  const firing = { firing: true, lastAlertAt: 1, normalStreak: 0 };
  const n1 = decideAlertDelivery({ marker: "NORMAL", alertState: firing });
  expect(n1.kind).toBe("skip");
  expect(n1.nextState.normalStreak).toBe(1);

  const nodata = decideAlertDelivery({ marker: "NO_DATA", alertState: n1.nextState });
  expect(nodata.kind).toBe("skip");
  expect(nodata.nextState.firing).toBe(true);
  expect(nodata.nextState.normalStreak).toBe(0);

  const n2a = decideAlertDelivery({ marker: "NORMAL", alertState: nodata.nextState });
  expect(n2a.kind).toBe("skip");
  const n2b = decideAlertDelivery({ marker: "NORMAL", alertState: n2a.nextState });
  expect(n2b.kind).toBe("recovered");
  expect(n2b.nextState.firing).toBe(false);
});

test("SCHEDULE_ALERT_GUIDE：禁止出图/导出/截断估数，要求首行标记与短窗口", async () => {
  const { SCHEDULE_ALERT_GUIDE } = await import("../src/schedule-alert.js");
  expect(SCHEDULE_ALERT_GUIDE).toMatch(/\[SPIKE\]/);
  expect(SCHEDULE_ALERT_GUIDE).toMatch(/\[NORMAL\]/);
  expect(SCHEDULE_ALERT_GUIDE).toMatch(/\[NO_DATA\]/);
  expect(SCHEDULE_ALERT_GUIDE).toMatch(/render_chart/);
  expect(SCHEDULE_ALERT_GUIDE).toMatch(/export_data/);
  expect(SCHEDULE_ALERT_GUIDE).toMatch(/结果已截断|截断/);
  expect(SCHEDULE_ALERT_GUIDE).toMatch(/短窗口|聚合|计数/);
  expect(SCHEDULE_ALERT_GUIDE).toContain("count_list_by_time");
  expect(SCHEDULE_ALERT_GUIDE).toMatch(/complete: false/);
  expect(SCHEDULE_ALERT_GUIDE).not.toMatch(/图仍要用/);
  expect(SCHEDULE_ALERT_GUIDE).toContain("不要写成无法确认");
  expect(SCHEDULE_ALERT_GUIDE).toContain("禁止自行换算 cron");
  const { SCHEDULE_UNGROUNDED_ALERT, decideAlertDelivery, parseAlertMarker } = await import("../src/schedule-alert.js");
  expect(parseAlertMarker(SCHEDULE_UNGROUNDED_ALERT)).toBe("NO_DATA");
  expect(SCHEDULE_UNGROUNDED_ALERT).not.toMatch(/阈值/);
  expect(decideAlertDelivery({ marker: "NO_DATA" }).kind).toBe("skip");
});

test("buildUnattendedConclusion：交互对话不动正文，无人值守按状态判定不认措辞", () => {
  // 交互对话（conclusion 缺省）：无论有没有取证失败，正文原样返回。
  expect(buildUnattendedConclusion({ ungrounded: true, text: "这次没有实际取数" })).toBe("这次没有实际取数");
  expect(buildUnattendedConclusion({ ungrounded: false, text: "取到了" })).toBe("取到了");

  // 预警 + 取证失败：正文换成协议句，首行必须是 [NO_DATA]（投递旁路只认首行标记）。
  // 关键回归：模型写的诚实兜底措辞不固定，不能靠「文案等于某句固定话术」来判定要不要注入。
  const alertText = buildUnattendedConclusion({
    ungrounded: true,
    conclusion: "alert",
    text: "没有实际取数，没法下结论",
  });
  expect(parseAlertMarker(alertText)).toBe("NO_DATA");
  expect(alertText).toBe(SCHEDULE_UNGROUNDED_ALERT);

  // 预警 + 取证失败 + 模型自己写了标记：尊重模型写的标记，不覆盖。
  expect(
    buildUnattendedConclusion({ ungrounded: true, conclusion: "alert", text: "[NORMAL]\n计数完整" }),
  ).toBe("[NORMAL]\n计数完整");

  // 预警 + 正常取得数据：不动正文（标不标记是模型的事）。
  expect(buildUnattendedConclusion({ ungrounded: false, conclusion: "alert", text: "[SPIKE]\n破线" })).toBe(
    "[SPIKE]\n破线",
  );

  // 报告 + 取证失败：保留模型写的正文（报告没有首行标记协议），空正文才回落确定性文案。
  expect(buildUnattendedConclusion({ ungrounded: true, conclusion: "report", text: "这次没有实际取数" })).toBe(
    "这次没有实际取数",
  );
  expect(buildUnattendedConclusion({ ungrounded: true, conclusion: "report", text: "  " })).toBe(
    SCHEDULE_UNGROUNDED_REPORT,
  );
});

test("alertNextRunAt：告警中加密到间隔的一半，平稳时回到 cron", () => {
  const finishedAt = Date.parse("2026-09-30T01:00:00Z");
  const day = 24 * 60 * 60_000;
  const nextOf = (_cron: string, after: Date) => (after.getTime() <= finishedAt + 1000 ? finishedAt + day : finishedAt + 2 * day);
  expect(
    alertNextRunAt({
      cron: "0 9 * * *",
      finishedAt,
      purpose: "alert",
      firing: true,
      marker: "NORMAL",
      cronNext: nextOf,
    }),
  ).toBe(finishedAt + day / 2);
  expect(
    alertNextRunAt({
      cron: "0 9 * * *",
      finishedAt,
      purpose: "report",
      firing: false,
      marker: null,
      cronNext: nextOf,
    }),
  ).toBe(finishedAt + day);
});

test("garbledTextReason：几乎全是问号才拒绝", () => {
  expect(garbledTextReason("??????")).toBeTruthy();
  expect(garbledTextReason("任务名称")).toBeNull();
  expect(garbledTextReason("hello")).toBeNull();
  expect(garbledTextReason("a?")).toBeNull();
});

test("unattendedToolDenial：拒绝文案按工具说明原因", () => {
  expect(unattendedToolDenial("fs_delete")).toContain("删除文件");
  expect(unattendedToolDenial("request_clarification")).toContain("澄清");
  expect(unattendedToolDenial("save_memory")).toContain("长期记忆");
  expect(unattendedToolDenial("render_chart")).toContain("出图");
  expect(unattendedToolDenial("run_command")).toContain("本期记录");
  expect(unattendedToolDenial("list_schedules")).toContain("当前任务");
  const sentence = unattendedDenySentence();
  for (const name of SCHEDULE_DENIED_BUILTINS) {
    expect(sentence).toContain(name);
    expect(unattendedToolDenial(name)).not.toContain("不允许这个操作");
  }
});

test("validateTiming：拒绝短于 1 分钟的周期", () => {
  expect(validateTiming({ cron: "*/10 * * * *" })).toBe(null);
  expect(validateTiming({ cron: "0 * * * *" })).toBe(null);
  // croner 对 5 段表达式最小粒度是分钟；用非法超密步进若被解析则应被最小间隔挡住。
  // `* * * * *` = 每分钟，刚好 = 60s，应通过；更密的需要 6 段（本项目已拒绝）。
  expect(validateTiming({ cron: "* * * * *" })).toBe(null);
  expect(validateTiming({ cron: "* * * * * *" })).toMatch(/5 段/);
});
