import assert from "node:assert/strict";
import {
  guardAnalyticsInput,
  redactPii,
  buildAskFactsBlock,
} from "../src/analytics/input-guard.js";
import { resolveTimeRange } from "../src/analytics/time-resolve.js";
import { analyticsAsk } from "../src/analytics/pipeline.js";

{
  const r = redactPii("联系我 foo@bar.com 或 13812345678");
  assert.match(r.text, /REDACTED_EMAIL/);
  assert.match(r.text, /REDACTED_PHONE/);
  assert.ok(r.redactions >= 2);
}

{
  const g = guardAnalyticsInput("正常问数 IndiaA 人均");
  assert.equal(g.refused, undefined);
  assert.match(g.text, /IndiaA/);
}

{
  const g = guardAnalyticsInput("\u0000\u200B");
  assert.ok(g.refused || !g.text);
}

{
  const facts = buildAskFactsBlock({
    clockIsoDate: "2026-09-09",
    timezone: "Asia/Shanghai",
    ownerKey: "cn:alice",
    userId: "alice",
    uiLocale: "zh-CN",
    timeResolveNote: "resolved_by_code",
    timeResolved: { start: "2026-09-01", end: "2026-09-09", echo: "按 2026-09-01～2026-09-09" },
  });
  assert.match(facts, /owner_key: cn:alice/);
  assert.match(facts, /resolved_time_range/);
  assert.match(facts, /Asia\/Shanghai/);
}

{
  // 裸「最近」：代码澄清，不依赖 LLM
  const r = await analyticsAsk("最近人均多久", {
    clock: new Date("2026-09-09T12:00:00+08:00"),
  });
  assert.equal(r.status, "clarify");
  assert.match(r.message, /最近/);
  assert.equal(r.clarifySlot, "time_range");
}

{
  const t = resolveTimeRange("最近人均多久", new Date("2026-09-09T12:00:00+08:00"), "Asia/Shanghai");
  assert.equal(t.ok, false);
}

console.log("analytics-input-guard.test.ts OK");
