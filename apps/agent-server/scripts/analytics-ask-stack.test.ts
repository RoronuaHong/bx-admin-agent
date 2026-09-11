/**
 * AskState linear stack unit tests (P2).
 * Run: tsx scripts/analytics-ask-stack.test.ts
 */
import assert from "node:assert/strict";
import {
  ASK_STATE_STACK_MAX,
  emptyAskStateStack,
  parseAskStateStack,
  pushAskState,
  stackTop,
  undoAskState,
} from "../src/analytics/ask-stack.js";
import type { AskState } from "../src/analytics/ask-state.js";

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
    summary: channel,
    updatedAt: 1,
  };
}

{
  const a = sample("a1", "IndiaA");
  const b = sample("a2", "FoxA");
  let stack = pushAskState(null, a);
  assert.equal(stack.states.length, 1);
  assert.equal(stackTop(stack)?.askId, "a1");
  stack = pushAskState(stack, b);
  assert.equal(stack.states.length, 2);
  assert.equal(stackTop(stack)?.filters.channel?.[0], "FoxA");

  // same askId replaces
  const b2 = sample("a2", "GoGo");
  stack = pushAskState(stack, b2);
  assert.equal(stack.states.length, 2);
  assert.equal(stackTop(stack)?.filters.channel?.[0], "GoGo");

  const undone = undoAskState(stack);
  assert.equal(undone.popped?.askId, "a2");
  assert.equal(undone.current?.askId, "a1");
  assert.equal(undone.stack.states.length, 1);

  const empty = undoAskState(undone.stack);
  assert.equal(empty.popped?.askId, "a1");
  assert.equal(empty.current, null);
  const again = undoAskState(empty.stack);
  assert.equal(again.popped, null);
  assert.equal(again.stack.states.length, 0);
}

{
  let stack = emptyAskStateStack();
  for (let i = 0; i < ASK_STATE_STACK_MAX + 5; i++) {
    stack = pushAskState(stack, sample(`id-${i}`, `Ch${i}`));
  }
  assert.equal(stack.states.length, ASK_STATE_STACK_MAX);
  assert.equal(stackTop(stack)?.askId, `id-${ASK_STATE_STACK_MAX + 4}`);
}

{
  const parsed = parseAskStateStack({
    states: [sample("x", "IndiaA"), { bad: true }],
    updatedAt: 9,
  });
  assert.ok(parsed);
  assert.equal(parsed!.states.length, 1);
  assert.equal(parsed!.updatedAt, 9);
}

console.log("analytics-ask-stack.test.ts OK");
