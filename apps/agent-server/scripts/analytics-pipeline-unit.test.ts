import assert from "node:assert/strict";
import { resolveTimeRange } from "../src/analytics/time-resolve.js";
import { analyticsAsk } from "../src/analytics/pipeline.js";

// 裸「最近」由代码确定性澄清（不拦死其它缺时间路径进 LLM）
{
  const t = resolveTimeRange("最近人均多久", new Date("2026-09-09T12:00:00+08:00"), "Asia/Shanghai");
  assert.equal(t.ok, false);
  if (!t.ok) assert.match(t.clarify, /最近/);
}

{
  const r = await analyticsAsk("最近人均多久", {
    clock: new Date("2026-09-09T12:00:00+08:00"),
  });
  assert.equal(r.status, "clarify");
  assert.match(r.message, /最近/);
  assert.equal(r.timeEcho, undefined);
}

console.log("analytics-pipeline-unit.test.ts OK");
