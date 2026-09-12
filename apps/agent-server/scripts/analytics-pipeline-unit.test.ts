import assert from "node:assert/strict";
import { resolveTimeRange } from "../src/analytics/time-resolve.js";
import { analyticsAsk } from "../src/analytics/pipeline.js";

const clock = new Date("2026-09-09T12:00:00+08:00");

{
  const t = resolveTimeRange("最近人均多久", clock, "Asia/Shanghai");
  assert.equal(t.ok, false);
  if (!t.ok) assert.match(t.clarify, /最近/);
}

{
  const r = await analyticsAsk("最近人均多久", { clock });
  assert.equal(r.status, "clarify");
  assert.match(r.message, /最近/);
  assert.equal(r.clarifySlot, "time_range");
  assert.equal(r.timeEcho, undefined);
}

{
  const r = await analyticsAsk("八月初观看人数", { clock });
  assert.equal(r.status, "clarify");
  assert.equal(r.clarifySlot, "time_range");
}

{
  const r = await analyticsAsk("上周到本周观看人数", { clock });
  assert.equal(r.status, "clarify");
  assert.equal(r.clarifySlot, "time_range");
}

{
  const r = await analyticsAsk("观看人数", { clock });
  assert.equal(r.status, "clarify");
  assert.equal(r.clarifySlot, "time_range");
}

console.log("analytics-pipeline-unit.test.ts OK");
