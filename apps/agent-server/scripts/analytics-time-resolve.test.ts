import assert from "node:assert/strict";
import {
  resolveTimeRange,
  resolveAskTimeRange,
  hasTimeSignal,
  applyResolvedTime,
} from "../src/analytics/time-resolve.js";

const clock = new Date("2026-09-09T12:00:00+08:00");
const tz = "Asia/Shanghai";

{
  const r = resolveTimeRange("八月十九到二十五", clock, tz);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.range.start, "2026-08-19");
    assert.equal(r.range.end, "2026-08-25");
  }
}

{
  const r = resolveTimeRange("最近看一下人数", clock, tz);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.clarify, /最近|时间|日期/);
}

{
  const r = resolveTimeRange("2026-08-19 到 2026-08-25", clock, tz);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.range.start, "2026-08-19");
    assert.equal(r.range.end, "2026-08-25");
  }
}

{
  const r = resolveTimeRange("8月20日", clock, tz);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.range.start, "2026-08-20");
    assert.equal(r.range.end, "2026-08-20");
  }
}

{
  const r = resolveTimeRange("最近7天人均", clock, tz);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.range.end, "2026-09-09");
    assert.equal(r.range.start, "2026-09-03");
  }
}

{
  const r = resolveTimeRange("三天前观看人数", clock, tz);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.range.start, "2026-09-06");
    assert.equal(r.range.end, "2026-09-06");
  }
}

{
  // 2026-09-09 是周三 → 下周三 = 2026-09-16
  const r = resolveTimeRange("下周三完播率", clock, tz);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.range.start, "2026-09-16");
    assert.equal(r.range.end, "2026-09-16");
  }
}

{
  const r = resolveTimeRange("昨天人均时长", clock, tz);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.range.start, "2026-09-08");
}

{
  assert.equal(hasTimeSignal("最近7天"), true);
  assert.equal(hasTimeSignal("人均多久"), false);
}

{
  const applied = applyResolvedTime(
    { status: "ok" as const, time: { start: "2099-01-01", end: "2099-01-02" } },
    resolveTimeRange("昨天", clock, tz),
  );
  assert.equal(applied.time?.start, "2026-09-08");
}

{
  const a = resolveTimeRange("2026-08-19到25", clock, tz);
  assert.equal(a.ok, true);
  if (a.ok) {
    assert.equal(a.range.start, "2026-08-19");
    assert.equal(a.range.end, "2026-08-25");
  }
  const b = resolveTimeRange("2026-08-19至08-25", clock, tz);
  assert.equal(b.ok, true);
  if (b.ok) assert.equal(b.range.end, "2026-08-25");
  const c = resolveTimeRange("2026-08-19到8月25日", clock, tz);
  assert.equal(c.ok, true);
  if (c.ok) assert.equal(c.range.end, "2026-08-25");
}

{
  const prev = { start: "2026-08-19", end: "2026-08-25" };
  const yest = resolveAskTimeRange({
    lastUserText: "改成昨天",
    prevTime: prev,
    clock,
    tz,
  });
  assert.equal(yest.ok, true);
  if (yest.ok) {
    assert.equal(yest.range.start, "2026-09-08");
    assert.equal(yest.range.end, "2026-09-08");
  }
  const next = resolveAskTimeRange({
    lastUserText: "2026-08-20 到 2026-08-21 再算一遍",
    prevTime: prev,
    clock,
    tz,
  });
  assert.equal(next.ok, true);
  if (next.ok) {
    assert.equal(next.range.start, "2026-08-20");
    assert.equal(next.range.end, "2026-08-21");
  }
  const keep = resolveAskTimeRange({
    lastUserText: "FoxA呢？",
    prevTime: prev,
    clock,
    tz,
  });
  assert.equal(keep.ok, true);
  if (keep.ok) {
    assert.equal(keep.range.start, "2026-08-19");
    assert.equal(keep.range.end, "2026-08-25");
  }
  const recent = resolveAskTimeRange({
    lastUserText: "改成最近",
    prevTime: prev,
    clock,
    tz,
  });
  assert.equal(recent.ok, false);

  const earlyAug = resolveAskTimeRange({
    lastUserText: "改成八月初",
    prevTime: prev,
    clock,
    tz,
  });
  assert.equal(earlyAug.ok, false);

  const weekSpan = resolveTimeRange("上周到本周观看人数", clock, tz);
  assert.equal(weekSpan.ok, false);
  const monthStart = resolveTimeRange("本月初观看人数", clock, tz);
  assert.equal(monthStart.ok, false);

  const grainKeep = resolveAskTimeRange({
    lastUserText: "按天呢？",
    prevTime: prev,
    clock,
    tz,
  });
  assert.equal(grainKeep.ok, true);
  if (grainKeep.ok) {
    assert.equal(grainKeep.range.start, "2026-08-19");
    assert.equal(grainKeep.range.end, "2026-08-25");
  }

  const fromHistory = resolveAskTimeRange({
    lastUserText: "电影，电视剧",
    priorUserTexts: ["IndiaA 在 2026-08-19 至 2026-08-25 观看人数"],
    clock,
    tz,
  });
  assert.equal(fromHistory.ok, true);
  if (fromHistory.ok) {
    assert.equal(fromHistory.range.start, "2026-08-19");
    assert.equal(fromHistory.range.end, "2026-08-25");
  }
}

{
  const month = resolveTimeRange("IndiaA 2026-08 同比观看人数", clock, tz);
  assert.equal(month.ok, true);
  if (month.ok) {
    assert.equal(month.range.start, "2026-08-01");
    assert.equal(month.range.end, "2026-08-31");
  }
  const dayStill = resolveTimeRange("2026-08-19到25", clock, tz);
  assert.equal(dayStill.ok, true);
  if (dayStill.ok) {
    assert.equal(dayStill.range.start, "2026-08-19");
    assert.equal(dayStill.range.end, "2026-08-25");
  }
  const yestToday = resolveTimeRange("昨天到今天观看人数", clock, tz);
  assert.equal(yestToday.ok, true);
  if (yestToday.ok) {
    assert.equal(yestToday.range.start, "2026-09-08");
    assert.equal(yestToday.range.end, "2026-09-09");
  }
  const cnYearMonth = resolveTimeRange("2026年8月观看人数", clock, tz);
  assert.equal(cnYearMonth.ok, true);
  if (cnYearMonth.ok) {
    assert.equal(cnYearMonth.range.start, "2026-08-01");
    assert.equal(cnYearMonth.range.end, "2026-08-31");
  }
  const slash = resolveTimeRange("2026/08/19到2026/08/25观看人数", clock, tz);
  assert.equal(slash.ok, true);
  if (slash.ok) {
    assert.equal(slash.range.start, "2026-08-19");
    assert.equal(slash.range.end, "2026-08-25");
  }
  const dotted = resolveTimeRange("8.19到8.25观看人数", clock, tz);
  assert.equal(dotted.ok, true);
  if (dotted.ok) {
    assert.equal(dotted.range.start, "2026-08-19");
    assert.equal(dotted.range.end, "2026-08-25");
  }
}

console.log("analytics-time-resolve.test.ts OK");
