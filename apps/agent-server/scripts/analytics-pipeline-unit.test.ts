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

{
  const r = await analyticsAsk("你好，你能干嘛", { clock });
  assert.equal(r.status, "ok");
  assert.equal(r.turnKind, "help");
  assert.equal(r.clarifySlot, undefined);
  assert.match(r.message, /数据分析|问数/);
  assert.doesNotMatch(r.message, /请提供分析的日期范围/);
  assert.ok(r.helpCard);
  assert.ok(r.helpCard.examples.length >= 2);
  assert.ok(r.helpCard.examples.every((ex) => !/印度B/.test(ex)));
}

{
  const r = await analyticsAsk("对比会拆表吗", { clock });
  assert.equal(r.status, "ok");
  assert.equal(r.turnKind, "help");
  assert.equal(r.clarifySlot, undefined);
}

{
  const r = await analyticsAsk("埋点", { clock });
  assert.equal(r.status, "clarify");
  assert.equal(r.turnKind, undefined);
  assert.equal(r.clarifySlot, "time_range");
  assert.equal(r.helpCard, undefined);
}

{
  const r = await analyticsAsk("埋点汇总", { clock });
  assert.equal(r.status, "clarify");
  assert.equal(r.clarifySlot, "time_range");
  assert.equal(r.helpCard, undefined);
}

{
  const r = await analyticsAsk("今天天气怎么样", { clock });
  assert.equal(r.status, "ok");
  assert.equal(r.turnKind, "help");
  assert.equal(r.clarifySlot, undefined);
}

{
  const r = await analyticsAsk("好的", {
    clock,
    prevAskState: { metricId: "viewers", time: { start: "2026-09-01", end: "2026-09-07" } },
  });
  assert.equal(r.status, "ok");
  assert.equal(r.turnKind, "help");
  assert.equal(r.helpCard, undefined);
  assert.match(r.message ?? "", /收到|下一问/);
  assert.doesNotMatch(r.message ?? "", /点示例|操作说明/);
}

{
  const r = await analyticsAsk("按你说的来", {
    clock,
    lastClarifySlot: "time_range",
    messages: [
      { role: "user", text: "观看人数" },
      { role: "assistant", text: "请提供日期范围" },
      { role: "user", text: "按你说的来" },
    ],
  });
  assert.equal(r.status, "clarify");
  assert.equal(r.clarifySlot, "time_range");
  assert.equal(r.helpCard, undefined);
  assert.notEqual(r.turnKind, "help");
  assert.doesNotMatch(r.message ?? "", /我能帮你问数/);
}

{
  const r = await analyticsAsk("好的", {
    clock,
    lastClarifySlot: "time_range",
    messages: [
      { role: "user", text: "观看人数" },
      { role: "assistant", text: "请提供日期范围" },
      { role: "user", text: "好的" },
    ],
  });
  assert.equal(r.status, "clarify");
  assert.equal(r.clarifySlot, "time_range");
  assert.equal(r.helpCard, undefined);
  assert.doesNotMatch(r.message ?? "", /收到|我能帮你问数/);
}

{
  const r = await analyticsAsk("按你说的来", { clock });
  assert.equal(r.status, "ok");
  assert.equal(r.turnKind, "help");
  assert.ok(r.helpCard);
}

{
  const r = await analyticsAsk("巴西和印度近2周的日活均值分别是多少？", {
    clock: new Date("2026-09-14T12:00:00+08:00"),
  });
  assert.notEqual(r.clarifySlot, "time_range");
  assert.notEqual(r.turnKind, "help");
}

{
  const r = await analyticsAsk("有多少台设备", { clock });
  assert.equal(r.status, "clarify");
  assert.equal(r.clarifySlot, "time_range");
}

console.log("analytics-pipeline-unit.test.ts OK");
