/**
 * AskState / TurnIntent validate + merge unit tests (LLM path mocked via validate).
 * Run: tsx scripts/analytics-ask-state.test.ts
 */
import assert from "node:assert/strict";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";
import {
  applySlotAnswersToAskState,
  askStateIsComplete,
  askStateToStructured,
  buildAskStateFromStructure,
  completeTurnIntentSlots,
  extractChannelTokensFromText,
  inferTurnIntentFallback,
  isChannelSlotAnswer,
  mergeAskState,
  normalizeResultLayout,
  parseAskState,
  validateTurnIntent,
  type AskState,
  type TurnIntent,
} from "../src/analytics/ask-state.js";

{
  const pack = loadAnalyticsPack("watch-detail");
  assert.deepEqual(extractChannelTokensFromText("IndiaB呢？"), ["IndiaB"]);
  assert.deepEqual(extractChannelTokensFromText("以后默认印度A", pack), ["IndiaA"]);
  assert.deepEqual(extractChannelTokensFromText("以后默认印度A"), []);
}

const base: AskState = {
  askId: "a1",
  packId: "watch-detail",
  packVersion: "t",
  metricId: "uniq_users",
  time: { start: "2026-08-19", end: "2026-08-25" },
  filters: { channel: ["IndiaA"], contentLang: ["te-IN"] },
  outputDims: ["watch_date"],
  ops: ["base_aggregate"],
  requested: { channels: ["IndiaA"], contentLangs: ["te-IN"] },
  summary: "IndiaA te-IN UV",
  updatedAt: 1,
};

{
  // Fallback no longer invents revise from 「呢？」
  const fb = inferTurnIntentFallback({
    lastUserText: "IndiaB呢？",
    prevAskState: base,
  });
  assert.equal(fb.kind, "new_ask");
}

{
  const completed = completeTurnIntentSlots({
    intent: { kind: "revise", notes: ["validated_revise"] },
    lastUserText: "那换成 IndiaA 吧",
    prevAskState: {
      ...base,
      filters: { channel: ["GhostZZZ"] },
      requested: { channels: ["GhostZZZ"] },
    },
  });
  assert.equal(completed.kind, "revise");
  if (completed.kind === "revise") {
    assert.deepEqual(completed.requestedPatch?.channels, { mode: "replace", values: ["IndiaA"] });
  }
  const stillFollowup = completeTurnIntentSlots({
    intent: { kind: "new_ask", notes: ["fallback_new_ask"] },
    lastUserText: "IndiaB呢？",
    prevAskState: base,
  });
  assert.equal(stillFollowup.kind, "new_ask");
}

{
  const llmJson = {
    kind: "revise",
    requestedPatch: { channels: { mode: "union", values: ["FoxA"] } },
    set: { outputDims: ["watch_date", "channel"] },
    notes: ["from_llm"],
  };
  const intent = validateTurnIntent(llmJson, base);
  assert.equal(intent.kind, "revise");
  const merged = mergeAskState({ prev: base, intent: intent as Extract<TurnIntent, { kind: "revise" }> });
  assert.ok(merged.ok);
  if (!merged.ok) throw new Error("merge failed");
  assert.deepEqual(merged.state.requested.channels?.slice().sort(), ["FoxA", "IndiaA"]);
  assert.ok(merged.state.outputDims.includes("channel"));
  assert.deepEqual(merged.state.filters.contentLang, ["te-IN"]);
}

{
  // Soft-complete: multi channel without channel dim → merge adds it
  const intent = validateTurnIntent(
    {
      kind: "revise",
      requestedPatch: { channels: { mode: "union", values: ["FoxA"] } },
    },
    base,
  );
  assert.equal(intent.kind, "revise");
  const merged = mergeAskState({ prev: base, intent: intent as Extract<TurnIntent, { kind: "revise" }> });
  assert.ok(merged.ok);
  if (!merged.ok) throw new Error("merge failed");
  assert.ok(merged.state.outputDims.includes("channel"));
  assert.ok((merged.notes || []).some((n) => n.includes("auto_output_dim_channel")));
}

{
  const intent = validateTurnIntent(
    {
      kind: "revise",
      requestedPatch: { channels: { mode: "replace", values: ["FoxA"] } },
    },
    base,
  );
  const merged = mergeAskState({ prev: base, intent: intent as Extract<TurnIntent, { kind: "revise" }> });
  assert.ok(merged.ok);
  if (!merged.ok) throw new Error("merge failed");
  assert.deepEqual(merged.state.filters.channel, ["FoxA"]);
}

{
  // Illegal path → new_ask
  const bad = validateTurnIntent({ kind: "revise", set: { "filters.evil": ["x"] }, hack: 1 }, base);
  // filters.evil is allowed path prefix filters.* — use unknown root
  const bad2 = validateTurnIntent({ kind: "revise", set: { sql: "DROP" } }, base);
  assert.equal(bad2.kind, "new_ask");
  assert.ok((bad2.notes || []).some((n) => n.includes("turn_intent_invalid")));
  void bad;
}

{
  const noPrev = validateTurnIntent({ kind: "revise", set: { metricId: "uniq_users" } }, null);
  assert.equal(noPrev.kind, "new_ask");
}

{
  const clearLang = validateTurnIntent(
    {
      kind: "revise",
      clear: ["filters.contentLang", "requested.contentLangs"],
    },
    base,
  );
  assert.equal(clearLang.kind, "revise");
  const merged = mergeAskState({
    prev: base,
    intent: clearLang as Extract<TurnIntent, { kind: "revise" }>,
  });
  assert.ok(merged.ok);
  if (!merged.ok) throw new Error("merge failed");
  assert.equal(merged.state.filters.contentLang, undefined);
}

{
  const meta = inferTurnIntentFallback({ lastUserText: "清除默认渠道" });
  assert.equal(meta.kind, "meta");
  if (meta.kind === "meta") assert.equal(meta.action, "clear_defaults");

  const disable = inferTurnIntentFallback({ lastUserText: "本轮不用默认渠道" });
  assert.equal(disable.kind, "meta");
  if (disable.kind === "meta") assert.equal(disable.action, "disable_defaults_this_turn");

  const combined = inferTurnIntentFallback({
    lastUserText: "本轮不用默认渠道。2026-08-19到2026-08-25按天观看人数",
  });
  assert.equal(combined.kind, "new_ask");
  assert.ok((combined.notes || []).includes("disable_defaults_this_turn"));
}

{
  const v = validateTurnIntent({ kind: "not_a_kind" }, base);
  assert.equal(v.kind, "new_ask");
}

{
  const multi = inferTurnIntentFallback({
    lastUserText: "x",
    slotAnswers: { channel: ["IndiaA"], contentLang: ["te-IN"] },
  });
  assert.equal(multi.kind, "clarify_answer");
  if (multi.kind === "clarify_answer") assert.equal(multi.slot, "channel");
  assert.ok((multi.notes || []).some((n) => n.startsWith("slotAnswers_first_of_")));
}

{
  const built = buildAskStateFromStructure({
    structure: {
      status: "ok",
      mergedNl: "x",
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"] },
      outputDims: ["watch_date"],
      metricId: "uniq_users",
      ops: ["base_aggregate"],
    },
    askId: "n1",
    packId: "watch-detail",
    packVersion: "1",
  });
  assert.equal(built.requested.channels?.[0], "IndiaA");
  const round = parseAskState(JSON.parse(JSON.stringify(built)));
  assert.ok(round);
  assert.equal(round!.metricId, "uniq_users");
  assert.ok(askStateIsComplete(built));
  const structured = askStateToStructured(built);
  assert.equal(structured.status, "ok");
}

{
  const extra = applySlotAnswersToAskState({
    prev: base,
    slotAnswers: {
      contentLang: ["ta-IN", "te-IN"],
      result_layout: ["wide"],
    },
  });
  assert.ok(extra.ok);
  if (extra.ok) {
    assert.deepEqual(extra.state.filters.contentLang, ["ta-IN", "te-IN"]);
    assert.equal(extra.state.layout, "wide");
  }
}

{
  const pack = loadAnalyticsPack("watch-detail");
  assert.equal(isChannelSlotAnswer("那换成 IndiaA 吧", ["IndiaA"]), true);
  assert.equal(isChannelSlotAnswer("IndiaA 的人均观看时长", ["IndiaA"]), false);
  const clarify = inferTurnIntentFallback({
    lastUserText: "那换成 IndiaA 吧",
    prevAskState: {
      ...base,
      filters: { channel: ["GhostZZZ"] },
      requested: { channels: ["GhostZZZ"] },
    },
    lastClarifySlot: "channel",
    pack,
  });
  assert.equal(clarify.kind, "clarify_answer");
  if (clarify.kind === "clarify_answer") {
    assert.equal(clarify.slot, "channel");
    assert.deepEqual(clarify.values, ["IndiaA"]);
  }
  const replace = inferTurnIntentFallback({
    lastUserText: "那换成 IndiaA 吧",
    prevAskState: {
      ...base,
      filters: { channel: ["GhostZZZ"] },
      requested: { channels: ["GhostZZZ"] },
    },
    pack,
  });
  assert.equal(replace.kind, "revise");
  if (replace.kind === "revise") {
    assert.deepEqual(replace.requestedPatch?.channels, { mode: "replace", values: ["IndiaA"] });
  }
  const leftover = inferTurnIntentFallback({
    lastUserText: "IndiaA 的人均观看时长",
    prevAskState: base,
    lastClarifySlot: "channel",
    pack,
  });
  assert.equal(leftover.kind, "new_ask");
}

{
  assert.equal(normalizeResultLayout("宽表"), "wide");
  assert.equal(normalizeResultLayout("1"), "wide");
  assert.equal(normalizeResultLayout("长表"), "long");
  assert.equal(normalizeResultLayout("ghost"), undefined);
  const fromNl = inferTurnIntentFallback({
    lastUserText: "宽表",
    prevAskState: base,
    lastClarifySlot: "result_layout",
  });
  assert.equal(fromNl.kind, "clarify_answer");
  if (fromNl.kind === "clarify_answer") {
    assert.equal(fromNl.slot, "result_layout");
    assert.deepEqual(fromNl.values, ["wide"]);
  }
  const merged = mergeAskState({
    prev: base,
    intent: { kind: "clarify_answer", slot: "result_layout", values: ["宽表"] },
  });
  assert.ok(merged.ok);
  if (merged.ok) assert.equal(merged.state.layout, "wide");
}

{
  const merged = mergeAskState({
    prev: base,
    intent: { kind: "clarify_answer", slot: "table", values: ["elt_film_order"] },
  });
  assert.ok(merged.ok);
  if (merged.ok) {
    assert.equal(merged.state.table, "elt_film_order");
    assert.ok(!merged.state.filters.table);
  }
}

console.log("analytics-ask-state.test.ts OK");
