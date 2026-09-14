import assert from "node:assert/strict";
import { resolveTimeRange } from "../src/analytics/time-resolve.js";

const clock = new Date("2026-09-09T12:00:00+08:00");

{
  const t = resolveTimeRange("最近人均多久", clock, "Asia/Shanghai");
  assert.equal(t.ok, false);
  if (!t.ok) assert.match(t.clarify, /最近/);
}

{
  const t = resolveTimeRange("八月初观看人数", clock, "Asia/Shanghai");
  assert.equal(t.ok, false);
}

{
  const t = resolveTimeRange("上周到本周观看人数", clock, "Asia/Shanghai");
  assert.equal(t.ok, false);
}

{
  const t = resolveTimeRange("观看人数", clock, "Asia/Shanghai");
  assert.equal(t.ok, false);
}

console.log("analytics-pipeline-unit.test.ts OK");
