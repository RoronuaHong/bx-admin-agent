/**
 * Linear AskState stack helpers (P2): push / undo / cap.
 * Pure functions — persistence lives in conversations.ts.
 */

import { parseAskState, type AskState } from "./ask-state.js";

export const ASK_STATE_STACK_MAX = 20;

export type AskStateStack = {
  states: AskState[];
  updatedAt: number;
};

export function emptyAskStateStack(now = Date.now()): AskStateStack {
  return { states: [], updatedAt: now };
}

export function parseAskStateStack(raw: unknown): AskStateStack | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const arr = Array.isArray(o.states) ? o.states : [];
  const states: AskState[] = [];
  for (const item of arr) {
    const s = parseAskState(item);
    if (s) states.push(s);
  }
  return {
    states: states.slice(-ASK_STATE_STACK_MAX),
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : Date.now(),
  };
}

export function stackTop(stack: AskStateStack | null | undefined): AskState | null {
  if (!stack?.states?.length) return null;
  return stack.states[stack.states.length - 1] || null;
}

/** Push; replace existing same askId instead of duplicating. Cap at ASK_STATE_STACK_MAX. */
export function pushAskState(stack: AskStateStack | null | undefined, state: AskState): AskStateStack {
  const prev = stack?.states ? [...stack.states] : [];
  const without = prev.filter((s) => s.askId !== state.askId);
  without.push(state);
  return {
    states: without.slice(-ASK_STATE_STACK_MAX),
    updatedAt: Date.now(),
  };
}

export function undoAskState(stack: AskStateStack | null | undefined): {
  stack: AskStateStack;
  popped: AskState | null;
  current: AskState | null;
} {
  const prev = stack?.states ? [...stack.states] : [];
  if (!prev.length) {
    const empty = emptyAskStateStack();
    return { stack: empty, popped: null, current: null };
  }
  const popped = prev.pop() || null;
  const next: AskStateStack = { states: prev, updatedAt: Date.now() };
  return { stack: next, popped, current: stackTop(next) };
}
