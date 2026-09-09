import assert from "node:assert/strict";
import { analyticsAsk } from "../src/analytics/pipeline.js";

const r = await analyticsAsk("最近人均多久", {
  clock: new Date("2026-09-09T12:00:00+08:00"),
});
assert.equal(r.status, "clarify");
assert.match(r.message, /最近/);
assert.equal(r.timeEcho, undefined);

console.log("analytics-pipeline-unit.test.ts OK");
