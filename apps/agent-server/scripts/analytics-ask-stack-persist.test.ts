/**
 * AskState stack persistence (memory fallback path).
 * Run: tsx scripts/analytics-ask-stack-persist.test.ts
 */
import assert from "node:assert/strict";
import {
  createConversation,
  getConversation,
  pushConversationAskState,
  undoConversationAskState,
} from "../src/conversations.js";
import type { AskState } from "../src/analytics/ask-state.js";

const ownerKey = `test:ask-stack:${Date.now()}`;
const convId = `conv_askstack_${Date.now()}`;

function sample(askId: string, channel: string): AskState {
  return {
    askId,
    packId: "watch-detail",
    packVersion: "t",
    metricId: "uniq_users",
    time: { start: "2026-08-19", end: "2026-08-25" },
    filters: { channel: [channel] },
    outputDims: ["channel"],
    ops: ["base_aggregate"],
    requested: { channels: [channel] },
    summary: `${channel} UV`,
    updatedAt: Date.now(),
  };
}

await createConversation({
  ownerKey,
  countryId: "test",
  loginName: "ask-stack",
  id: convId,
  title: "ask-stack",
  store: "analytics",
});

const p1 = await pushConversationAskState({
  ownerKey,
  id: convId,
  askState: sample("a1", "IndiaA"),
  store: "analytics",
  countryId: "test",
  loginName: "ask-stack",
});
assert.equal(p1.stack.states.length, 1);
assert.equal(p1.current?.askId, "a1");

const p2 = await pushConversationAskState({
  ownerKey,
  id: convId,
  askState: sample("a2", "FoxA"),
  store: "analytics",
});
assert.equal(p2.stack.states.length, 2);

const loaded = await getConversation(ownerKey, convId, "analytics");
assert.equal(loaded?.askStateStack?.states.length, 2);

const undone = await undoConversationAskState({ ownerKey, id: convId, store: "analytics" });
assert.equal(undone.popped?.askId, "a2");
assert.equal(undone.current?.askId, "a1");
assert.equal(undone.stack.states.length, 1);

const after = await getConversation(ownerKey, convId, "analytics");
assert.equal(after?.askStateStack?.states[0]?.askId, "a1");

console.log("analytics-ask-stack-persist.test.ts OK");
process.exit(0);
