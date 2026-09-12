/**
 * Analytics LLM context pack — budgeted projection (not the UI transcript).
 *
 * Cascade (cheap → expensive): probe trim → sliding window → head/tail → drop oldest.
 * Pin AskState + current user turn. Facts/state first, current turn last (lost-in-the-middle).
 * Token estimate is chars/4 (same as chat.ts); no LLM summarizer on this path.
 */

import { compactAskStateForLlm, type AskState } from "./ask-state.js";
import { formatConversationTranscript, type ConversationTurn } from "./conversation-structure.js";

export type AnalyticsPackPhase = "structure" | "diagnose" | "turn_intent";

export type AnalyticsBucketCaps = {
  /** Soft total for the packed user payload (leave ~25% unused). */
  total: number;
  facts: number;
  state: number;
  history: number;
  probe: number;
  current: number;
  tool: number;
  keepRecent: number;
};

const PHASE_CAPS: Record<AnalyticsPackPhase, AnalyticsBucketCaps> = {
  structure: {
    total: 8000,
    facts: 800,
    state: 1500,
    history: 3500,
    probe: 1200,
    current: 2000,
    tool: 2000,
    keepRecent: 6,
  },
  diagnose: {
    total: 2800,
    facts: 200,
    state: 400,
    history: 1600,
    probe: 0,
    current: 800,
    tool: 0,
    keepRecent: 4,
  },
  turn_intent: {
    total: 3500,
    facts: 200,
    state: 1500,
    history: 0,
    probe: 0,
    current: 2000,
    tool: 0,
    keepRecent: 0,
  },
};

export const ANALYTICS_KEEP_RECENT_MESSAGES = PHASE_CAPS.structure.keepRecent;
export const ANALYTICS_MODEL_TRANSCRIPT_CHARS = PHASE_CAPS.structure.total;
export const ANALYTICS_PROBE_SUMMARY_CHARS = PHASE_CAPS.structure.probe;
export const ANALYTICS_TOOL_RESULT_CHARS = PHASE_CAPS.structure.tool;

const MSG_HEAD = 400;
const MSG_TAIL = 200;

export type AnalyticsLlmPack = {
  phase: AnalyticsPackPhase;
  facts: string;
  askStateLine: string;
  history: string;
  currentTurn: string;
  probeSummary?: string;
  omittedMessages: number;
  truncated: boolean;
  /** Joined projection for policy parse / wrap. */
  transcript: string;
  usage: {
    chars: number;
    tokensEst: number;
    buckets: Record<string, number>;
  };
};

export function phaseCaps(phase: AnalyticsPackPhase = "structure"): AnalyticsBucketCaps {
  return PHASE_CAPS[phase];
}

export function estimateTokensFromChars(chars: number): number {
  return Math.round(chars / 4);
}

export function capProbeSummary(probeSummary?: string, max = ANALYTICS_PROBE_SUMMARY_CHARS): string | undefined {
  return capText(probeSummary, max, "probe");
}

export function capToolResult(result: string, max = ANALYTICS_TOOL_RESULT_CHARS): string {
  return capText(result, max, "tool") || "";
}

function capText(text: string | undefined, max: number, label: string): string | undefined {
  const t = String(text || "").trim();
  if (!t || max <= 0) return undefined;
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 24))}\n…(${label} truncated)`;
}

function headTail(text: string, cap: number): { text: string; trimmed: boolean } {
  if (text.length <= cap) return { text, trimmed: false };
  const head = Math.min(MSG_HEAD, cap);
  const tail = Math.min(MSG_TAIL, Math.max(0, cap - head - 20));
  return {
    text: `${text.slice(0, head)}\n…(${text.length - head - tail} chars omitted)…\n${text.slice(-tail)}`,
    trimmed: true,
  };
}

function lastUserIndex(messages: ConversationTurn[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

export function renderAnalyticsLlmUserText(pack: Pick<
  AnalyticsLlmPack,
  "facts" | "askStateLine" | "history" | "currentTurn" | "probeSummary" | "omittedMessages"
>): string {
  return [
    pack.facts ? `Deterministic facts:\n${pack.facts}` : "",
    pack.askStateLine,
    pack.omittedMessages > 0
      ? `Earlier messages omitted: ${pack.omittedMessages}. Do not recover slots from omitted history; use AskState + recent turns.`
      : "",
    pack.history ? `Recent history:\n${pack.history}` : "",
    pack.probeSummary ? `Dimension probe (Top-N):\n${pack.probeSummary}` : "",
    pack.currentTurn ? `Current user turn:\n${pack.currentTurn}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Wrap only history + current (untrusted). Facts / AskState stay trusted. */
export function renderAnalyticsLlmUserTextWrapped(
  pack: AnalyticsLlmPack,
  wrapUntrusted: (text: string) => string,
): string {
  return renderAnalyticsLlmUserText({
    facts: pack.facts,
    askStateLine: pack.askStateLine,
    history: pack.history ? wrapUntrusted(pack.history) : "",
    currentTurn: pack.currentTurn ? wrapUntrusted(pack.currentTurn) : "",
    probeSummary: pack.probeSummary,
    omittedMessages: pack.omittedMessages,
  });
}

export function applyToolUsage(pack: AnalyticsLlmPack, toolChars: number): AnalyticsLlmPack {
  pack.usage.buckets.tool = (pack.usage.buckets.tool || 0) + Math.max(0, toolChars);
  return pack;
}

function refreshUsage(pack: AnalyticsLlmPack) {
  pack.transcript = renderAnalyticsLlmUserText(pack);
  pack.usage.chars = pack.transcript.length;
  pack.usage.tokensEst = estimateTokensFromChars(pack.transcript.length);
  pack.usage.buckets.facts = pack.facts.length;
  pack.usage.buckets.state = pack.askStateLine.length;
  pack.usage.buckets.history = pack.history.length;
  pack.usage.buckets.probe = pack.probeSummary?.length || 0;
  pack.usage.buckets.current = pack.currentTurn.length;
}

/** After render: if over total, shrink probe then history. Never cut current / AskState / facts. */
function enforceTotal(pack: AnalyticsLlmPack, total: number) {
  refreshUsage(pack);
  let guard = 0;
  while (pack.transcript.length > total && guard++ < 24) {
    if (pack.probeSummary) {
      const next = Math.floor(pack.probeSummary.length * 0.55);
      pack.probeSummary = next < 64 ? undefined : capText(pack.probeSummary, next, "probe");
      pack.truncated = true;
      refreshUsage(pack);
      continue;
    }
    if (pack.history) {
      const lines = pack.history.split("\n").filter(Boolean);
      if (lines.length <= 1) pack.history = "";
      else pack.history = lines.slice(1).join("\n");
      pack.omittedMessages += 1;
      pack.truncated = true;
      refreshUsage(pack);
      continue;
    }
    break;
  }
}

function logPack(pack: AnalyticsLlmPack) {
  if ((process.env.ANALYTICS_CONTEXT_LOG || "on") === "off") return;
  console.log(
    `[analytics:context] phase=${pack.phase} chars=${pack.usage.chars} tok≈${pack.usage.tokensEst} omitted=${pack.omittedMessages} truncated=${pack.truncated} buckets=${JSON.stringify(pack.usage.buckets)}`,
  );
}

export function packAnalyticsLlmContext(input: {
  messages: ConversationTurn[];
  prevAskState?: AskState | null;
  probeSummary?: string;
  facts?: string;
  phase?: AnalyticsPackPhase;
}): AnalyticsLlmPack {
  const phase = input.phase || "structure";
  const caps = PHASE_CAPS[phase];
  let truncated = false;

  const facts = capText(input.facts, caps.facts, "facts") || "";
  if (input.facts && facts.length < String(input.facts).length) truncated = true;

  let askStateLine = "";
  if (input.prevAskState) {
    const raw = `AskState: ${JSON.stringify(compactAskStateForLlm(input.prevAskState))}`;
    askStateLine = capText(raw, caps.state, "state") || raw;
    if (askStateLine.length < raw.length) truncated = true;
  }

  const probeSummary = capProbeSummary(input.probeSummary, caps.probe);
  if (input.probeSummary && probeSummary && probeSummary.length < input.probeSummary.length) truncated = true;

  const all = (input.messages || []).filter((m) => String(m.text || "").trim());
  const lastIdx = lastUserIndex(all);
  const currentMsg = lastIdx >= 0 ? all[lastIdx]! : undefined;
  const before = lastIdx >= 0 ? all.slice(0, lastIdx) : all;

  let currentTurn = "";
  if (currentMsg) {
    const raw = formatConversationTranscript([currentMsg]);
    const capped = capText(raw, caps.current, "current") || raw;
    currentTurn = capped;
    if (capped.length < raw.length) truncated = true;
  }

  let omittedMessages = 0;
  let recent = before;
  if (caps.keepRecent > 0 && before.length > caps.keepRecent) {
    omittedMessages = before.length - caps.keepRecent;
    recent = before.slice(-caps.keepRecent);
  } else if (caps.keepRecent === 0) {
    omittedMessages = before.length;
    recent = [];
  }

  const historyCap = Math.max(0, Math.min(caps.history, caps.total - facts.length - askStateLine.length - currentTurn.length - (probeSummary?.length || 0) - 200));
  const trimmedRecent = recent.map((m) => {
    const ht = headTail(m.text, Math.max(280, Math.floor(historyCap / Math.max(1, recent.length))));
    if (ht.trimmed) truncated = true;
    return { ...m, text: ht.text };
  });

  while (
    formatConversationTranscript(trimmedRecent).length > historyCap &&
    trimmedRecent.length > 0
  ) {
    trimmedRecent.shift();
    omittedMessages += 1;
    truncated = true;
  }

  const history = formatConversationTranscript(trimmedRecent);

  const pack: AnalyticsLlmPack = {
    phase,
    facts,
    askStateLine,
    history,
    currentTurn,
    probeSummary,
    omittedMessages,
    truncated,
    transcript: "",
    usage: { chars: 0, tokensEst: 0, buckets: { tool: 0 } },
  };
  enforceTotal(pack, caps.total);
  logPack(pack);
  return pack;
}
