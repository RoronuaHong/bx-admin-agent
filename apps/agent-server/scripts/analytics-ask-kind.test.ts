/**
 * Capability / chit vs data-ask routing.
 * Run: tsx scripts/analytics-ask-kind.test.ts
 */
import assert from "node:assert/strict";
import {
  buildAnalyticsHelpCard,
  hasDataAskSignal,
  isCapabilityOrChitTurn,
  shouldAnswerCapabilities,
} from "../src/analytics/ask-kind.js";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";

const pack = loadAnalyticsPack("watch-detail");

assert.equal(isCapabilityOrChitTurn("你好，你能干嘛"), true);
assert.equal(isCapabilityOrChitTurn("你有哪些能力"), true);
assert.equal(isCapabilityOrChitTurn("what can you do"), true);
assert.equal(isCapabilityOrChitTurn("谢谢"), true);
assert.equal(isCapabilityOrChitTurn("观看人数"), false);
assert.equal(isCapabilityOrChitTurn("有多少台设备"), false);

assert.equal(hasDataAskSignal("观看人数", pack), true);
assert.equal(hasDataAskSignal("有多少台设备", pack), true);
assert.equal(hasDataAskSignal("最近人均多久", pack), true);
assert.equal(hasDataAskSignal("IndiaA呢？", pack), true);
assert.equal(hasDataAskSignal("你好，你能干嘛", pack), false);

assert.equal(shouldAnswerCapabilities("你好，你能干嘛", pack), true);
assert.equal(shouldAnswerCapabilities("你好", pack), true);
assert.equal(shouldAnswerCapabilities("怎么问观看人数", pack), true);
assert.equal(shouldAnswerCapabilities("观看人数", pack), false);
assert.equal(shouldAnswerCapabilities("最近人均多久", pack), false);
assert.equal(shouldAnswerCapabilities("有多少台设备", pack), false);
assert.equal(shouldAnswerCapabilities("八月二十到二十一印度A按天观看人数", pack), false);

{
  const help = buildAnalyticsHelpCard({ locale: "zh" });
  assert.match(help.message, /\*\*我能帮你问数\*\*/);
  assert.match(help.message, /^- /m);
  assert.ok(help.helpCard.examples.length >= 2);
  assert.ok(help.helpCard.examples.every((ex) => !/印度B|IndiaB/.test(ex)));
}

console.log("analytics-ask-kind.test.ts OK");
