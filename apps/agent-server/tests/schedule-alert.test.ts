import { test, expect } from "vitest";
import {
  alertNextRunAt,
  buildUnattendedConclusion,
  decideAlertDelivery,
  parseAlertMarker,
  pickNotifyPolicy,
  pickPurpose,
  SCHEDULE_UNGROUNDED_ALERT,
  SCHEDULE_UNGROUNDED_REPORT,
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
  expect(unattendedToolDenial("render_chart")).toContain("出图");
  expect(unattendedToolDenial("run_command")).toContain("本期记录");
});

test("validateTiming：拒绝短于 1 分钟的周期", () => {
  expect(validateTiming({ cron: "*/10 * * * *" })).toBe(null);
  expect(validateTiming({ cron: "0 * * * *" })).toBe(null);
  // croner 对 5 段表达式最小粒度是分钟；用非法超密步进若被解析则应被最小间隔挡住。
  // `* * * * *` = 每分钟，刚好 = 60s，应通过；更密的需要 6 段（本项目已拒绝）。
  expect(validateTiming({ cron: "* * * * *" })).toBe(null);
  expect(validateTiming({ cron: "* * * * * *" })).toMatch(/5 段/);
});
