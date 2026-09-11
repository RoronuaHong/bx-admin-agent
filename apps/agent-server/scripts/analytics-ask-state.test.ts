/**
 * AskState / TurnIntent unit tests.
 * Run: tsx scripts/analytics-ask-state.test.ts
 */
import assert from "node:assert/strict";
import {
  askStateIsComplete,
  askStateToStructured,
  buildAskStateFromStructure,
  extractChannelTokensFromText,
  inferTurnIntent,
  mergeAskState,
  parseAskState,
  type AskState,
} from "../src/analytics/ask-state.js";

{
  assert.deepEqual(extractChannelTokensFromText("IndiaB呢？"), ["IndiaB"]);
  assert.ok(extractChannelTokensFromText("印度B怎么样").includes("IndiaB"));
}

const base: AskState = {
  askId: "a1",
  packId: "watch-detail",
  packVersion: "t",
  metricId: "uniq_users",
  time: { start: "2026-08-19", end: "2026-08-25" },
  filters: { channel: ["IndiaA"], contentLang: ["te-IN"] },
  outputDims: ["watch_date", "channel"],
  ops: ["base_aggregate"],
  requested: { channels: ["IndiaA"], contentLangs: ["te-IN"] },
  summary: "IndiaA te-IN UV",
  updatedAt: 1,
};

{
  const intent = inferTurnIntent({
    lastUserText: "IndiaB呢？",
    prevAskState: base,
  });
  assert.equal(intent.kind, "revise");
  if (intent.kind !== "revise") throw new Error("expected revise");
  const merged = mergeAskState({ prev: base, intent, askId: "a2" });
  assert.equal(merged.ok, true);
  if (!merged.ok) throw new Error("merge failed");
  assert.deepEqual(merged.state.filters.channel?.slice().sort(), ["IndiaA", "IndiaB"]);
  assert.deepEqual(merged.state.requested.channels?.slice().sort(), ["IndiaA", "IndiaB"]);
  // language filter inherited — revise does not invent contentLang clarify
  assert.deepEqual(merged.state.filters.contentLang, ["te-IN"]);
  assert.ok(askStateIsComplete(merged.state));
  const structured = askStateToStructured(merged.state);
  assert.equal(structured.status, "ok");
  assert.equal(structured.metricId, "uniq_users");
}

{
  const intent = inferTurnIntent({
    lastUserText: "不要语言筛选",
    prevAskState: base,
  });
  assert.equal(intent.kind, "revise");
  if (intent.kind === "revise") {
    const merged = mergeAskState({ prev: base, intent });
    assert.ok(merged.ok);
    if (merged.ok) assert.equal(merged.state.filters.contentLang, undefined);
  }
}

{
  const intent = inferTurnIntent({
    lastUserText: "NotARealChannelXYZ呢？",
    prevAskState: base,
  });
  assert.equal(intent.kind, "revise");
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
}

{
  const disable = inferTurnIntent({ lastUserText: "本轮不用默认渠道" });
  assert.equal(disable.kind, "meta");
  if (disable.kind === "meta") assert.equal(disable.action, "disable_defaults_this_turn");

  const clear = inferTurnIntent({ lastUserText: "清除默认渠道" });
  assert.equal(clear.kind, "meta");
  if (clear.kind === "meta") assert.equal(clear.action, "clear_defaults");

  const combined = inferTurnIntent({
    lastUserText: "本轮不用默认渠道。2026-08-19到2026-08-25按天观看人数",
  });
  assert.equal(combined.kind, "new_ask");
  assert.ok((combined.notes || []).includes("disable_defaults_this_turn"));
}

console.log("analytics-ask-state.test.ts OK");
