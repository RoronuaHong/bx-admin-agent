import assert from "node:assert/strict";
import { guardAnalyticsInput, buildAskFactsBlock } from "../src/analytics/input-guard.js";
import { resolveTimeRange } from "../src/analytics/time-resolve.js";

{
  const g = guardAnalyticsInput("正常问数 IndiaA 人均");
  assert.equal(g.refused, undefined);
  assert.match(g.text, /IndiaA/);
}

{
  const g = guardAnalyticsInput("联系我 foo@bar.com 或 13812345678");
  assert.match(g.text, /foo@bar.com/);
  assert.match(g.text, /13812345678/);
}

{
  const g = guardAnalyticsInput("英语（contentLang=''）\n  te-IN\tta-IN");
  assert.match(g.text, /\n  te-IN\tta-IN/);
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
  const t = resolveTimeRange("最近人均多久", new Date("2026-09-09T12:00:00+08:00"), "Asia/Shanghai");
  assert.equal(t.ok, false);
}

console.log("analytics-input-guard.test.ts OK");
