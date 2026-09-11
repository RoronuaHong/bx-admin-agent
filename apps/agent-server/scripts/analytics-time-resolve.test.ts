import assert from "node:assert/strict";
import { resolveTimeRange, hasTimeSignal, applyResolvedTime } from "../src/analytics/time-resolve.js";

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

console.log("analytics-time-resolve.test.ts OK");
