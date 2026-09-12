import assert from "node:assert/strict";
import {
  ANALYTICS_KEEP_RECENT_MESSAGES,
  ANALYTICS_MODEL_TRANSCRIPT_CHARS,
  ANALYTICS_PROBE_SUMMARY_CHARS,
  applyToolUsage,
  capProbeSummary,
  capToolResult,
  packAnalyticsLlmContext,
  renderAnalyticsLlmUserText,
  renderAnalyticsLlmUserTextWrapped,
} from "../src/analytics/context-pack.js";
import {
  buildStructureSystemPrompt,
  buildStructureUserPrompt,
  neededProbeFields,
  needsDimensionProbe,
  parseStructureResponse,
} from "../src/analytics/conversation-structure.js";
import type { AskState } from "../src/analytics/ask-state.js";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";

const prev: AskState = {
  askId: "a1",
  packId: "watch-detail",
  packVersion: "t",
  metricId: "uniq_users",
  time: { start: "2026-08-19", end: "2026-08-25" },
  filters: { channel: ["IndiaA"] },
  outputDims: ["watch_date"],
  ops: [],
  requested: { channels: ["IndiaA"] },
  summary: "IndiaA 按天观看人数",
  updatedAt: 1,
};

{
  const long = Array.from({ length: 12 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    text: i % 2 === 0 ? `问${i} 三种小语种观看人数` : `请确认语言 ${i}`,
  }));
  long.push({ role: "user", text: "FoxA呢？" });
  const packed = packAnalyticsLlmContext({
    messages: long,
    prevAskState: prev,
    facts: "today_date: 2026-09-12",
    phase: "structure",
  });
  assert.ok(packed.omittedMessages >= 12 - ANALYTICS_KEEP_RECENT_MESSAGES);
  assert.match(packed.transcript, /FoxA呢/);
  assert.match(packed.transcript, /AskState/);
  assert.match(packed.transcript, /IndiaA/);
  assert.match(packed.transcript, /omitted/);
  assert.match(packed.transcript, /today_date/);
  assert.doesNotMatch(packed.transcript, /问0 三种小语种/);
  assert.ok(packed.transcript.indexOf("today_date") < packed.transcript.indexOf("FoxA呢"));
  assert.ok(packed.transcript.indexOf("AskState") < packed.transcript.indexOf("Current user turn"));
  assert.ok(packed.usage.tokensEst > 0);
  assert.ok(packed.usage.buckets.current > 0);
}

{
  const packed = packAnalyticsLlmContext({
    messages: [{ role: "user", text: "IndiaA 在 2026-08-19 至 2026-08-25 观看人数" }],
  });
  assert.equal(packed.omittedMessages, 0);
  assert.match(packed.currentTurn, /IndiaA 在 2026-08-19/);
}

{
  const huge = "lang: " + Array.from({ length: 400 }, (_, i) => `code-${i}`).join(", ");
  const capped = capProbeSummary(huge)!;
  assert.ok(capped.length <= ANALYTICS_PROBE_SUMMARY_CHARS + 30);
  assert.match(capped, /truncated/);
  assert.match(capToolResult("x".repeat(5000)), /truncated/);
}

{
  const packed = packAnalyticsLlmContext({
    messages: [
      { role: "user", text: "旧问" },
      { role: "assistant", text: "请确认" },
      { role: "user", text: "FoxA呢？" },
    ],
    prevAskState: prev,
    phase: "turn_intent",
  });
  assert.equal(packed.history, "");
  assert.match(packed.currentTurn, /FoxA呢/);
}

{
  const rendered = renderAnalyticsLlmUserText({
    facts: "f",
    askStateLine: "AskState: {}",
    history: "[1] 用户: 旧",
    currentTurn: "[2] 用户: 新",
    omittedMessages: 1,
  });
  assert.ok(rendered.indexOf("f") < rendered.indexOf("AskState"));
  assert.ok(rendered.indexOf("旧") < rendered.indexOf("新"));
}

{
  const pack = loadAnalyticsPack("watch-detail");
  const sys = buildStructureSystemPrompt(pack);
  assert.doesNotMatch(sys, /today_date/);
  assert.doesNotMatch(sys, /resolved_time_range/);
  assert.doesNotMatch(sys, /2026-09-12/);
  const prompt = buildStructureUserPrompt("AskState: {}\nCurrent user turn:\n[1] 用户: 观看人数");
  assert.match(prompt, /facts \+ AskState first/);
  assert.doesNotMatch(prompt, /use ALL turns/i);
}

{
  assert.equal(ANALYTICS_MODEL_TRANSCRIPT_CHARS, 8000);
}

{
  const packed = packAnalyticsLlmContext({
    messages: [
      { role: "user", text: "旧问 三种小语种" },
      { role: "assistant", text: "请确认语言" },
      { role: "user", text: "FoxA呢？" },
    ],
    prevAskState: prev,
    facts: "today_date: 2026-09-12\nresolved_time_range: 2026-08-19 .. 2026-08-25",
    phase: "structure",
  });
  const wrapped = renderAnalyticsLlmUserTextWrapped(packed, (t) => `⟦UNTRUSTED⟧${t}⟦/UNTRUSTED⟧`);
  assert.match(wrapped, /Deterministic facts/);
  assert.match(wrapped, /AskState/);
  assert.match(wrapped, /⟦UNTRUSTED⟧/);
  assert.match(wrapped, /FoxA呢/);
  assert.doesNotMatch(wrapped, /⟦UNTRUSTED⟧[\s\S]*today_date/);
  assert.doesNotMatch(wrapped, /⟦UNTRUSTED⟧AskState/);
  const factsIdx = wrapped.indexOf("Deterministic facts");
  const wrapIdx = wrapped.indexOf("⟦UNTRUSTED⟧");
  assert.ok(factsIdx >= 0 && wrapIdx > factsIdx);
}

{
  const longHist = Array.from({ length: 8 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    text: `轮${i} ${"三种小语种观看人数 ".repeat(40)}`,
  }));
  longHist.push({ role: "user", text: "FoxA呢？" });
  const packed = packAnalyticsLlmContext({
    messages: longHist,
    prevAskState: prev,
    facts: `today_date: 2026-09-12\n${"pref ".repeat(80)}`,
    probeSummary: `lang: ${Array.from({ length: 200 }, (_, i) => `code-${i}`).join(", ")}`,
    phase: "structure",
  });
  assert.ok(packed.transcript.length <= ANALYTICS_MODEL_TRANSCRIPT_CHARS);
  assert.match(packed.transcript, /FoxA呢/);
  assert.match(packed.transcript, /AskState/);
  assert.match(packed.currentTurn, /FoxA呢/);
  assert.ok(packed.truncated);
}

{
  const packed = packAnalyticsLlmContext({
    messages: [{ role: "user", text: "IndiaA 上周观看人数" }],
    phase: "structure",
  });
  applyToolUsage(packed, 321);
  assert.equal(packed.usage.buckets.tool, 321);
  applyToolUsage(packed, 10);
  assert.equal(packed.usage.buckets.tool, 331);
}

{
  assert.equal(needsDimensionProbe("IndiaA 上周观看人数"), false);
  assert.equal(needsDimensionProbe("按天呢？"), false);
  assert.equal(needsDimensionProbe("FoxA呢？"), false);
  assert.equal(needsDimensionProbe("三种小语种观看人数"), true);
  assert.equal(needsDimensionProbe("电影观看人数"), true);
  assert.deepEqual(neededProbeFields("三种小语种观看人数"), ["contentLang"]);
  assert.deepEqual(neededProbeFields("电影观看人数"), ["movieType"]);
  assert.deepEqual(neededProbeFields("IndiaA 上周观看人数"), []);
}

{
  const prevLang: AskState = {
    ...prev,
    filters: { channel: ["IndiaA"], contentLang: ["te-IN", "ta-IN"] },
    summary: "IndiaA 三种小语种观看人数",
  };
  const packed = packAnalyticsLlmContext({
    messages: [{ role: "user", text: "FoxA呢？" }],
    prevAskState: prevLang,
    facts: "today_date: 2026-09-12",
    phase: "structure",
  });
  const r = parseStructureResponse(
    JSON.stringify({
      status: "ok",
      mergedNl: "FoxA 观看人数",
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["FoxA"], contentLang: ["te-IN"] },
      outputDims: ["watch_date", "channel"],
      metricId: "uniq_users",
    }),
    packed.transcript,
  );
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.filters.contentLang, undefined);
    assert.deepEqual(r.filters.channel, ["FoxA"]);
    assert.equal(r.mergedNl, "FoxA 观看人数");
  }

  const clarified = parseStructureResponse(
    JSON.stringify({
      status: "clarify",
      clarify: "请确认指标口径",
      clarifySlot: "metric",
      time: { start: "2026-08-19", end: "2026-08-25" },
    }),
    packed.transcript,
  );
  assert.equal(clarified.status, "clarify");
  if (clarified.status === "clarify") {
    assert.doesNotMatch(String(clarified.mergedNl || ""), /AskState|三种小语种/);
    assert.equal(clarified.mergedNl, "FoxA呢？");
  }
}

console.log("analytics-context-pack.test.ts OK");
