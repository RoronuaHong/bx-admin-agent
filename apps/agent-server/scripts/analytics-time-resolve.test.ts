import assert from "node:assert/strict";
import { resolveTimeRange } from "../src/analytics/time-resolve.js";

const clock = new Date("2026-09-09T12:00:00+08:00");

{
  const r = resolveTimeRange("八月十九到二十五", clock, "Asia/Shanghai");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.range.start, "2026-08-19");
    assert.equal(r.range.end, "2026-08-25");
  }
}

{
  const r = resolveTimeRange("最近看一下人数", clock, "Asia/Shanghai");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.clarify, /最近|时间|日期/);
}

{
  const r = resolveTimeRange("2026-08-19 到 2026-08-25", clock, "Asia/Shanghai");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.range.start, "2026-08-19");
    assert.equal(r.range.end, "2026-08-25");
  }
}

{
  const r = resolveTimeRange("8月20日", clock, "Asia/Shanghai");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.range.start, "2026-08-20");
    assert.equal(r.range.end, "2026-08-20");
  }
}

console.log("analytics-time-resolve.test.ts OK");
