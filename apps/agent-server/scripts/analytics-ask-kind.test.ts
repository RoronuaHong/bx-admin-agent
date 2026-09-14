/**
 * Capability / chit vs data-ask routing.
 * Run: tsx scripts/analytics-ask-kind.test.ts
 */
import assert from "node:assert/strict";
import {
  buildAnalyticsHelpCard,
  hasDataAskSignal,
  isAcceptSuggestionTurn,
  isCapabilityOrChitTurn,
  isThanksTurn,
  shouldAnswerCapabilities,
} from "../src/analytics/ask-kind.js";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";

const pack = loadAnalyticsPack("watch-detail");

assert.equal(isCapabilityOrChitTurn("你好，你能干嘛"), true);
assert.equal(isCapabilityOrChitTurn("你有哪些能力"), true);
assert.equal(isCapabilityOrChitTurn("what can you do"), true);
assert.equal(isCapabilityOrChitTurn("谢谢"), true);
assert.equal(isThanksTurn("谢谢"), true);
assert.equal(isThanksTurn("好的"), true);
assert.equal(isThanksTurn("嗯"), true);
assert.equal(isThanksTurn("ok"), true);
assert.equal(isThanksTurn("好的昨天观看人数"), false);
assert.equal(isAcceptSuggestionTurn("按你说的来"), true);
assert.equal(isAcceptSuggestionTurn("就按这个"), true);
assert.equal(isAcceptSuggestionTurn("第一种"), true);
assert.equal(isAcceptSuggestionTurn("好的"), false);
assert.equal(isAcceptSuggestionTurn("按你说的来查昨天观看人数"), false);
assert.equal(shouldAnswerCapabilities("按你说的来", pack), true);
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
assert.equal(shouldAnswerCapabilities("对比会拆表吗", pack), true);
assert.equal(shouldAnswerCapabilities("怎么对比", pack), true);
assert.equal(shouldAnswerCapabilities("CSV怎么下载", pack), true);
assert.equal(shouldAnswerCapabilities("查看SQL", pack), true);
assert.equal(shouldAnswerCapabilities("各渠道对比一下", pack), false);
assert.equal(shouldAnswerCapabilities("IndiaA和FoxA对比观看人数", pack), false);
assert.equal(hasDataAskSignal("对比会拆表吗", pack), false);
assert.equal(hasDataAskSignal("埋点", pack), true);
assert.equal(hasDataAskSignal("埋点汇总", pack), true);
assert.equal(hasDataAskSignal("埋点数据", pack), true);
assert.equal(shouldAnswerCapabilities("埋点", pack), false);
assert.equal(shouldAnswerCapabilities("埋点汇总", pack), false);
assert.equal(shouldAnswerCapabilities("那我应该怎么问？", pack), true);
assert.equal(shouldAnswerCapabilities("今天天气怎么样", pack), true);

{
  const help = buildAnalyticsHelpCard({ locale: "zh" });
  assert.match(help.message, /\*\*我能帮你问数\*\*/);
  assert.match(help.message, /^- /m);
  assert.ok(help.helpCard.examples.length >= 2);
  assert.ok(help.helpCard.examples.every((ex) => !/印度B|IndiaB/.test(ex)));
  assert.doesNotMatch(help.message, /粒度|口径/);
  assert.match(help.helpCard.how.join("\n"), /各自/);
}

console.log("analytics-ask-kind.test.ts OK");
