/**
 * AskState: session working memory for analytics asks.
 * TurnIntent revise/new/clarify/meta → merge → candidate Ask for gates/compile.
 */

import { extractChannelsFromNl } from "./intent.js";
import {
  enumDimForField,
  enumDimsByMemberKind,
  languageDimension,
  loadAnalyticsPack,
  overlayTableName,
  type AnalyticsPack,
} from "./semantic-layer.js";
import type { StructuredAskOk } from "./conversation-structure.js";
import type { ResultLayout } from "./types.js";

export type AskRequested = {
  channels?: string[];
  contentLangs?: string[];
  movieTypes?: string[];
};

export type AskState = {
  askId: string;
  packId: string;
  packVersion: string;
  metricId: string;
  /** Warehouse table for this Ask; omit = overlay pack table. */
  table?: string;
  time: { start: string; end: string };
  filters: Record<string, string[]>;
  outputDims: string[];
  layout?: ResultLayout;
  pivotDim?: string;
  ops: string[];
  requested: AskRequested;
  defaultsApplied?: { channels?: boolean; layout?: boolean };
  summary: string;
  updatedAt: number;
};

export type TurnIntent =
  | { kind: "new_ask"; notes?: string[] }
  | {
      kind: "revise";
      set?: Record<string, unknown>;
      clear?: string[];
      /** default union for channel follow-ups */
      requestedPatch?: {
        channels?: { mode: "replace" | "union"; values: string[] };
      };
      notes?: string[];
    }
  | { kind: "clarify_answer"; slot: string; values: string[]; notes?: string[] }
  | {
      kind: "meta";
      action: "set_defaults" | "clear_defaults" | "disable_defaults_this_turn";
      payload?: Record<string, unknown>;
      notes?: string[];
    };

function uniq(xs: string[]): string[] {
  return [...new Set(xs.map(String).filter((x) => x !== undefined && x !== null && String(x).length))];
}

/**
 * 维度 field → AskRequested 契约字段（channels/contentLangs/movieTypes）。
 * 路由由 pack 的 memberKind 声明推导，不再写死 contentLang/movieType 字面量。
 */
function requestedContractKey(pack: AnalyticsPack | undefined, field: string): keyof AskRequested {
  const d = enumDimForField(pack, field);
  if (d?.memberKind === "locale") return "contentLangs";
  if (d?.memberKind === "lexicon") return "movieTypes";
  return "channels";
}

/** 维度 canonical slot（id/field）→ AskRequested 契约字段；未知 slot 返回 undefined（不落槽）。 */
function requestedContractKeyForSlot(
  pack: AnalyticsPack | undefined,
  slot: string,
): keyof AskRequested | undefined {
  const p = pack || loadAnalyticsPack();
  const d = (p.enumDimensions || []).find((x) => (x.id || x.field) === slot) || enumDimForField(p, slot);
  if (!d) return undefined;
  return requestedContractKey(p, d.field);
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return uniq(v.map(String));
}

/** Channel tokens from NL — pack aliases + shape; no product allow-list. */
export function extractChannelTokensFromText(text: string, pack?: AnalyticsPack): string[] {
  return extractChannelsFromNl(text, pack);
}

const CHANNEL_REPLACE_CUE = /换成|改成|改为|替换成/;
/** Generic Chinese filler/verb particles (NLP功能词) — dim wording comes from the pack. */
const SLOT_FILLER_RE = /那|换成|改成|改为|替换成|吧|呢|啊|呀|用|看/g;

/** True when leftover text after named codes is only a channel-slot answer (换成/吧/呢). */
export function isChannelSlotAnswer(
  text: string,
  channels: string[],
  pack?: AnalyticsPack,
): boolean {
  if (!channels.length) return false;
  let rest = String(text || "");
  for (const ch of channels) rest = rest.split(ch).join(" ");
  // Dim surface forms (渠道/语言/…) are pack-owned, not code.
  for (const d of pack?.enumDimensions || []) {
    for (const alias of [d.id, d.field, ...(d.aliases || [])]) {
      if (alias && alias.length >= 2) rest = rest.split(alias).join(" ");
    }
  }
  rest = rest
    .replace(SLOT_FILLER_RE, " ")
    .replace(/[。.!！,，;；?\s]+/g, " ")
    .trim();
  return rest.length === 0;
}

/**
 * Map NL / option id / index to wide|long. Unknown → undefined (do not default to long).
 * Shape surface forms come from the pack (wideShapeCues / longShapeCues).
 */
export function normalizeResultLayout(
  v: unknown,
  pack?: AnalyticsPack,
): "wide" | "long" | undefined {
  const raw = String(v ?? "").trim();
  if (!raw) return undefined;
  const t = raw.toLowerCase();
  if (t === "wide" || t === "1" || /^wide\b/.test(t)) return "wide";
  if (t === "long" || t === "2" || /^long\b/.test(t)) return "long";
  const hit = (cues?: string[]) => (cues || []).some((c) => c && raw.includes(c));
  if (hit(pack?.wideShapeCues)) return "wide";
  if (hit(pack?.longShapeCues)) return "long";
  return undefined;
}

/**
 * Complete incomplete TurnIntent from the latest turn only.
 * Does not invent revise from bare 「呢？」; only fills missing channel slots
 * when the user named codes and either replaced or answered a channel clarify.
 */
export function completeTurnIntentSlots(input: {
  intent: TurnIntent;
  lastUserText: string;
  prevAskState?: AskState | null;
  pack?: AnalyticsPack | null;
  lastClarifySlot?: string;
}): TurnIntent {
  if (input.lastClarifySlot === "result_layout") {
    const layout = normalizeResultLayout(input.lastUserText, input.pack || undefined);
    if (layout) {
      return {
        kind: "clarify_answer",
        slot: "result_layout",
        values: [layout],
        notes: [...(input.intent.notes || []), "complete_layout_from_nl"],
      };
    }
  }
  const channels = extractChannelTokensFromText(input.lastUserText, input.pack || undefined);
  if (!channels.length) return input.intent;
  const replaceCue = CHANNEL_REPLACE_CUE.test(input.lastUserText);
  const channelClarify = input.lastClarifySlot === "channel";
  if (!replaceCue && !channelClarify) return input.intent;

  const notes = [...(input.intent.notes || [])];
  if (input.intent.kind === "clarify_answer" && input.intent.slot === "channel") {
    if (input.intent.values.length) return input.intent;
    return { ...input.intent, values: channels, notes: [...notes, "complete_clarify_channel_nl"] };
  }

  if (channelClarify && input.prevAskState && input.intent.kind !== "revise") {
    return {
      kind: "clarify_answer",
      slot: "channel",
      values: channels,
      notes: [...notes, "complete_channel_clarify_from_nl"],
    };
  }

  if (input.prevAskState && askStateIsComplete(input.prevAskState)) {
    return {
      kind: "revise",
      set: input.intent.kind === "revise" ? input.intent.set : undefined,
      clear: input.intent.kind === "revise" ? input.intent.clear : undefined,
      requestedPatch: { channels: { mode: "replace", values: channels } },
      notes: [...notes, "complete_channel_replace_from_nl"],
    };
  }
  return input.intent;
}

/** Strip 「本轮/这次不用默认…」prefix; shared by fallback + TurnIntent-LLM. */
export function stripDisableDefaultsPrefix(text: string): string {
  return String(text || "")
    .replace(/本轮不用默认渠道/g, " ")
    .replace(/这次不用默认渠道/g, " ")
    .replace(/本轮不用默认/g, " ")
    .replace(/这次不用默认/g, " ")
    .replace(/不要用默认渠道/g, " ")
    .replace(/不用默认渠道/g, " ")
    .replace(/不要用默认/g, " ")
    .replace(/不用默认/g, " ")
    .replace(/[。.!！,，;；]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Thin TurnIntent fallback (slotAnswers + meta + grounded channel clarify/replace).
 * Bare 「呢？」 follow-ups still go to LLM — do not invent revise.
 */
export function inferTurnIntentFallback(input: {
  lastUserText: string;
  prevAskState?: AskState | null;
  slotAnswers?: Record<string, string[]>;
  lastClarifySlot?: string;
  pack?: AnalyticsPack | null;
}): TurnIntent {
  if (input.slotAnswers && Object.keys(input.slotAnswers).length) {
    const entries = Object.entries(input.slotAnswers);
    const [slot, values] = entries[0]!;
    return {
      kind: "clarify_answer",
      slot,
      values: [...values],
      notes:
        entries.length === 1
          ? ["slotAnswers"]
          : ["slotAnswers", `slotAnswers_first_of_${entries.length}`],
    };
  }

  const text = String(input.lastUserText || "").trim();
  if (!text) return { kind: "new_ask", notes: ["empty"] };

  if (input.lastClarifySlot === "result_layout") {
    const layout = normalizeResultLayout(text, input.pack || undefined);
    if (layout) {
      return {
        kind: "clarify_answer",
        slot: "result_layout",
        values: [layout],
        notes: ["fallback_layout_clarify"],
      };
    }
  }

  const namedChannels = extractChannelTokensFromText(text, input.pack || undefined);
  if (
    input.lastClarifySlot === "channel" &&
    namedChannels.length &&
    isChannelSlotAnswer(text, namedChannels, input.pack || undefined)
  ) {
    return {
      kind: "clarify_answer",
      slot: "channel",
      values: namedChannels,
      notes: ["fallback_channel_clarify"],
    };
  }
  if (
    CHANNEL_REPLACE_CUE.test(text) &&
    namedChannels.length &&
    input.prevAskState &&
    askStateIsComplete(input.prevAskState)
  ) {
    return {
      kind: "revise",
      requestedPatch: { channels: { mode: "replace", values: namedChannels } },
      notes: ["fallback_channel_replace"],
    };
  }

  if (/^(以后|今后|下次).{0,8}默认/.test(text) || /记住默认|设为默认/.test(text)) {
    const channels = extractChannelTokensFromText(text, input.pack || undefined);
    return {
      kind: "meta",
      action: "set_defaults",
      payload: channels.length ? { defaultChannels: channels } : {},
      notes: ["meta_set_defaults"],
    };
  }
  if (/清除默认|取消默认|别用默认|不要默认|不用默认/.test(text)) {
    const thisTurn = /本轮|这次|不要用默认|不用默认/.test(text);
    if (!thisTurn) {
      return {
        kind: "meta",
        action: "clear_defaults",
        notes: ["meta_clear_defaults"],
      };
    }
    const rest = stripDisableDefaultsPrefix(text);
    if (rest.length < 6) {
      return {
        kind: "meta",
        action: "disable_defaults_this_turn",
        notes: ["meta_disable_defaults"],
      };
    }
    // Rest is a real ask → LLM will classify; keep disable note on new_ask shell
    return { kind: "new_ask", notes: ["disable_defaults_this_turn", "meta_prefix_stripped"] };
  }

  return { kind: "new_ask", notes: ["fallback_new_ask"] };
}

const ALLOWED_SET_PATHS = new Set([
  "metricId",
  "layout",
  "pivotDim",
  "outputDims",
  "ops",
  "time",
]);

function isAllowedSetPath(path: string): boolean {
  if (ALLOWED_SET_PATHS.has(path)) return true;
  if (path.startsWith("filters.") && path.length > "filters.".length) return true;
  if (path.startsWith("requested.") && path.length > "requested.".length) return true;
  return false;
}

function isAllowedClearPath(path: string): boolean {
  return (
    path === "layout" ||
    path === "pivotDim" ||
    path.startsWith("filters.") ||
    path.startsWith("requested.")
  );
}

/**
 * Validate LLM / raw TurnIntent. Illegal → degrade to new_ask (no hard-guess slots).
 */
export function validateTurnIntent(raw: unknown, prevAskState?: AskState | null): TurnIntent {
  if (!raw || typeof raw !== "object") {
    return { kind: "new_ask", notes: ["turn_intent_invalid:not_object"] };
  }
  const o = raw as Record<string, unknown>;
  const kind = String(o.kind || "").trim();
  const notes = Array.isArray(o.notes) ? o.notes.map(String) : [];

  if (kind === "new_ask") {
    return { kind: "new_ask", notes: [...notes, "validated_new_ask"] };
  }

  if (kind === "meta") {
    const action = String(o.action || "").trim();
    if (
      action !== "set_defaults" &&
      action !== "clear_defaults" &&
      action !== "disable_defaults_this_turn"
    ) {
      return { kind: "new_ask", notes: [...notes, "turn_intent_invalid:meta_action"] };
    }
    return {
      kind: "meta",
      action,
      payload:
        o.payload && typeof o.payload === "object"
          ? (o.payload as Record<string, unknown>)
          : undefined,
      notes: [...notes, "validated_meta"],
    };
  }

  if (kind === "clarify_answer") {
    const slot = String(o.slot || "").trim();
    const values = asStringArray(o.values);
    if (!slot || !values.length) {
      return { kind: "new_ask", notes: [...notes, "turn_intent_invalid:clarify"] };
    }
    return { kind: "clarify_answer", slot, values, notes: [...notes, "validated_clarify"] };
  }

  if (kind === "revise") {
    if (!prevAskState || !askStateIsComplete(prevAskState)) {
      return { kind: "new_ask", notes: [...notes, "turn_intent_invalid:revise_without_prev"] };
    }
    const setRaw =
      o.set && typeof o.set === "object" ? (o.set as Record<string, unknown>) : {};
    const set: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(setRaw)) {
      if (!isAllowedSetPath(path)) {
        return { kind: "new_ask", notes: [...notes, `turn_intent_invalid:set_path:${path}`] };
      }
      set[path] = value;
    }
    const clear = asStringArray(o.clear);
    for (const path of clear) {
      if (!isAllowedClearPath(path)) {
        return { kind: "new_ask", notes: [...notes, `turn_intent_invalid:clear_path:${path}`] };
      }
    }
    let requestedPatch:
      | {
          channels?: { mode: "replace" | "union"; values: string[] };
        }
      | undefined;
    if (o.requestedPatch && typeof o.requestedPatch === "object") {
      const rp = o.requestedPatch as Record<string, unknown>;
      const ch =
        rp.channels && typeof rp.channels === "object"
          ? (rp.channels as Record<string, unknown>)
          : null;
      if (ch) {
        const mode = String(ch.mode || "").trim();
        const values = asStringArray(ch.values);
        if ((mode !== "union" && mode !== "replace") || !values.length) {
          return { kind: "new_ask", notes: [...notes, "turn_intent_invalid:requestedPatch"] };
        }
        requestedPatch = { channels: { mode: mode as "union" | "replace", values } };
      }
    }
    return {
      kind: "revise",
      set: Object.keys(set).length ? set : undefined,
      clear: clear.length ? clear : undefined,
      requestedPatch,
      notes: [...notes, "validated_revise"],
    };
  }

  return { kind: "new_ask", notes: [...notes, "turn_intent_invalid:kind"] };
}

function setPath(state: AskState, path: string, value: unknown, pack?: AnalyticsPack | null): void {
  if (path === "metricId" && typeof value === "string") {
    state.metricId = value;
    return;
  }
  if (path === "layout") {
    const layout = normalizeResultLayout(value, pack || undefined);
    if (layout) state.layout = layout;
    return;
  }
  if (path === "pivotDim" && typeof value === "string") {
    state.pivotDim = value;
    return;
  }
  if (path === "outputDims") {
    state.outputDims = asStringArray(value);
    return;
  }
  if (path === "ops") {
    state.ops = asStringArray(value);
    return;
  }
  if (path === "time" && value && typeof value === "object") {
    const t = value as Record<string, unknown>;
    if (typeof t.start === "string" && typeof t.end === "string") {
      state.time = { start: t.start, end: t.end };
    }
    return;
  }
  if (path.startsWith("filters.")) {
    const key = path.slice("filters.".length);
    state.filters = { ...state.filters, [key]: asStringArray(value) };
    return;
  }
  if (path.startsWith("requested.")) {
    const key = path.slice("requested.".length) as keyof AskRequested;
    state.requested = { ...state.requested, [key]: asStringArray(value) };
  }
}

function clearPath(state: AskState, path: string): void {
  if (path === "layout") {
    delete state.layout;
    return;
  }
  if (path === "pivotDim") {
    delete state.pivotDim;
    return;
  }
  if (path.startsWith("filters.")) {
    const key = path.slice("filters.".length);
    const next = { ...state.filters };
    delete next[key];
    state.filters = next;
    return;
  }
  if (path.startsWith("requested.")) {
    const next = { ...state.requested };
    delete next[path.slice("requested.".length) as keyof AskRequested];
    state.requested = next;
    return;
  }
}

export function cloneAskState(s: AskState): AskState {
  return {
    ...s,
    time: { ...s.time },
    filters: Object.fromEntries(Object.entries(s.filters).map(([k, v]) => [k, [...v]])),
    outputDims: [...s.outputDims],
    ops: [...(s.ops || [])],
    requested: {
      channels: s.requested.channels ? [...s.requested.channels] : undefined,
      contentLangs: s.requested.contentLangs ? [...s.requested.contentLangs] : undefined,
      movieTypes: s.requested.movieTypes ? [...s.requested.movieTypes] : undefined,
    },
    defaultsApplied: s.defaultsApplied ? { ...s.defaultsApplied } : undefined,
  };
}

export function mergeAskState(input: {
  prev: AskState;
  intent: TurnIntent;
  askId?: string;
  /** Pack that owns the shape surface forms (宽表/长表) — no built-in aliases in code. */
  pack?: AnalyticsPack | null;
}): { ok: true; state: AskState; notes: string[] } | { ok: false; reason: string } {
  if (input.intent.kind === "new_ask") {
    return { ok: false, reason: "new_ask_has_no_merge" };
  }
  if (input.intent.kind === "meta") {
    return { ok: false, reason: "meta_handled_elsewhere" };
  }

  const state = cloneAskState(input.prev);
  if (input.askId) state.askId = input.askId;
  state.updatedAt = Date.now();
  const notes = [...(input.intent.notes || [])];

  if (input.intent.kind === "clarify_answer") {
    const slot = input.intent.slot;
    const values = uniq(input.intent.values);
    if (slot === "table") {
      const next = String(values[0] || "").trim();
      if (next) state.table = next;
      delete state.filters.table;
    } else if (slot === "metric" || slot === "metricId") state.metricId = values[0] || state.metricId;
    else if (slot === "result_layout") {
      const layout = normalizeResultLayout(values[0], input.pack || undefined);
      if (layout) state.layout = layout;
      const langDim = languageDimension(input.pack || undefined);
      const langField = langDim?.field || "contentLang";
      const langs = state.filters[langField] || [];
      if (langs.length > 1 && !state.pivotDim) state.pivotDim = langField;
    }
    else if (slot === "time_range" && values.length >= 2) {
      state.time = { start: values[0]!, end: values[1]! };
    } else {
      state.filters = { ...state.filters, [slot]: values };
      const rkey = requestedContractKeyForSlot(input.pack, slot);
      if (rkey) state.requested = { ...state.requested, [rkey]: values };
    }
    state.summary = summarizeAskState(state);
    return { ok: true, state, notes: [...notes, `clarify_answer:${slot}`] };
  }

  // revise
  for (const path of input.intent.clear || []) clearPath(state, path);
  for (const [path, value] of Object.entries(input.intent.set || {})) {
    setPath(state, path, value, input.pack);
  }

  const patch = input.intent.requestedPatch?.channels;
  if (patch?.values?.length) {
    const prevCh = state.requested.channels || state.filters.channel || [];
    const next =
      patch.mode === "replace" ? uniq(patch.values) : uniq([...prevCh, ...patch.values]);
    state.requested = { ...state.requested, channels: next };
    state.filters = { ...state.filters, channel: next };
    notes.push(`requested_channels_${patch.mode}:${next.join(",")}`);
    // Multi-channel compare must expose channel in the result grain
    if (next.length > 1 && !state.outputDims.includes("channel")) {
      state.outputDims = uniq([...state.outputDims, "channel"]);
      notes.push("auto_output_dim_channel_for_compare");
    }
  } else if (state.filters.channel?.length) {
    state.requested = { ...state.requested, channels: [...state.filters.channel] };
  }

  state.summary = summarizeAskState(state);
  return { ok: true, state, notes };
}

/** Apply every slotAnswers entry (UI may send contentLang + result_layout together). */
export function applySlotAnswersToAskState(input: {
  prev: AskState;
  slotAnswers?: Record<string, string[]>;
  askId?: string;
  pack?: AnalyticsPack | null;
}): { ok: true; state: AskState; notes: string[] } | { ok: false; reason: string } {
  const entries = Object.entries(input.slotAnswers || {}).filter(([, vs]) => Array.isArray(vs) && vs.length);
  if (!entries.length) return { ok: false, reason: "no_slot_answers" };
  let state = cloneAskState(input.prev);
  if (input.askId) state.askId = input.askId;
  const notes: string[] = [];
  for (const [slot, values] of entries) {
    const merged = mergeAskState({
      prev: state,
      intent: { kind: "clarify_answer", slot, values: [...values] },
      pack: input.pack,
    });
    if (!merged.ok) return merged;
    state = merged.state;
    notes.push(...merged.notes);
  }
  return { ok: true, state, notes };
}

export function summarizeAskState(state: AskState, pack?: AnalyticsPack): string {
  // Filter bullets are driven by whatever dims the pack declares (label = first alias).
  const dimLabel = (field: string): string => {
    const d = (pack?.enumDimensions || []).find((x) => x.field === field || x.id === field);
    return String(d?.aliases?.[0] || d?.id || field);
  };
  const filterBits = Object.entries(state.filters || {})
    .filter(([, values]) => Array.isArray(values) && values.length)
    .map(([field, values]) => `${dimLabel(field)} ${(values as string[]).join(",")}`);
  const overlay = overlayTableName(pack);
  const parts = [
    state.time?.start && state.time?.end ? `${state.time.start}～${state.time.end}` : null,
    ...filterBits,
    state.table && overlay && state.table !== overlay ? `表 ${state.table}` : null,
    state.metricId || null,
    state.ops?.filter((o) => o !== "base_aggregate").join(",") || null,
  ];
  return parts.filter(Boolean).join(" · ") || "analytics ask";
}

export function askStateIsComplete(state: AskState): boolean {
  return Boolean(state.metricId && state.time?.start && state.time?.end);
}

/** Compact AskState for LLM injection (no askId / timestamps). */
export function compactAskStateForLlm(state: AskState): Record<string, unknown> {
  return {
    metricId: state.metricId,
    table: state.table,
    time: state.time,
    filters: state.filters,
    outputDims: state.outputDims,
    layout: state.layout,
    ops: state.ops,
    requested: state.requested,
    summary: state.summary,
  };
}

export function askStateToStructured(state: AskState): StructuredAskOk {
  return {
    status: "ok",
    mergedNl: state.summary,
    time: { ...state.time },
    filters: { ...state.filters },
    outputDims: [...state.outputDims],
    layout: state.layout,
    pivotDim: state.pivotDim,
    metricId: state.metricId,
    table: state.table,
    ops: [...(state.ops || [])],
    askSummary: state.summary,
    notes: ["from_ask_state"],
  };
}

export function buildAskStateFromStructure(input: {
  structure: StructuredAskOk;
  askId: string;
  packId: string;
  packVersion: string;
  defaultsApplied?: AskState["defaultsApplied"];
}): AskState {
  const s = input.structure;
  const filters = { ...(s.filters || {}) };
  const packForReq = loadAnalyticsPack();
  const requested: AskRequested = {};
  for (const d of packForReq.enumDimensions || []) {
    const key = requestedContractKey(packForReq, d.field);
    const vals = (filters[d.field] as string[]) || [];
    if (vals.length) requested[key] = [...new Set([...(requested[key] || []), ...vals])];
  }
  const metricId = String(s.metricId || "");
  const computedSummary = summarizeAskState({
    askId: input.askId,
    packId: input.packId,
    packVersion: input.packVersion,
    metricId,
    time: { start: s.time!.start, end: s.time!.end },
    filters,
    outputDims: [...(s.outputDims || [])],
    ops: [...(s.ops || [])],
    requested,
    summary: "",
    updatedAt: Date.now(),
  });
  const carriedSummary = String(s.askSummary || s.mergedNl || "").trim();
  // The model routinely carries the previous turn's summary forward verbatim, so it can still name
  // a metric this turn just changed. That summary is injected into the next turn's context as
  // mergedNl, so a stale one would drag the old metric back. Regenerate whenever the carried
  // summary does not name the metric actually resolved for this turn.
  const summary =
    metricId && carriedSummary && !carriedSummary.includes(metricId)
      ? computedSummary
      : carriedSummary || computedSummary;
  const state: AskState = {
    askId: input.askId,
    packId: input.packId,
    packVersion: input.packVersion,
    metricId,
    table: s.table,
    time: { start: s.time!.start, end: s.time!.end },
    filters,
    outputDims: [...(s.outputDims || [])],
    layout: s.layout,
    pivotDim: s.pivotDim,
    ops: [...(s.ops || ["base_aggregate"])],
    requested,
    defaultsApplied: input.defaultsApplied,
    summary,
    updatedAt: Date.now(),
  };
  state.summary = state.summary || summarizeAskState(state);
  return state;
}

/** Soft parse of prevAskState from client JSON. */
export function parseAskState(raw: unknown): AskState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const time = o.time as Record<string, unknown> | undefined;
  const metricId = String(o.metricId || "").trim();
  // NOTE: an empty metricId is valid here — a clarify continuation's prevAskState may legitimately
  // have a resolved time but a still-pending metric (the user answers it via slotAnswers on the
  // next turn). Requiring a non-empty metricId would reject such partial states and drop the
  // carried table/context, forcing the turn through the free-text LLM path and losing context.
  if (!time || typeof time.start !== "string" || typeof time.end !== "string") {
    return null;
  }
  const filters =
    o.filters && typeof o.filters === "object"
      ? Object.fromEntries(
          Object.entries(o.filters as Record<string, unknown>).map(([k, v]) => [k, asStringArray(v)]),
        )
      : {};
  const requestedRaw = (o.requested && typeof o.requested === "object" ? o.requested : {}) as Record<
    string,
    unknown
  >;
  const packForReq = loadAnalyticsPack();
  const requested: AskRequested = {};
  for (const d of packForReq.enumDimensions || []) {
    const key = requestedContractKey(packForReq, d.field);
    const fromRaw = asStringArray(requestedRaw[key as string]);
    const fromFilters = (filters[d.field] as string[]) || [];
    const vals = fromRaw.length ? fromRaw : fromFilters;
    if (vals.length) requested[key] = [...new Set(vals)];
  }
  return {
    askId: String(o.askId || ""),
    packId: String(o.packId || "watch-detail"),
    packVersion: String(o.packVersion || ""),
    metricId,
    table: o.table ? String(o.table).trim() || undefined : undefined,
    time: { start: time.start, end: time.end },
    filters,
    outputDims: asStringArray(o.outputDims),
    layout: o.layout === "wide" || o.layout === "long" ? o.layout : undefined,
    pivotDim: o.pivotDim ? String(o.pivotDim) : undefined,
    ops: asStringArray(o.ops).length ? asStringArray(o.ops) : ["base_aggregate"],
    requested,
    defaultsApplied:
      o.defaultsApplied && typeof o.defaultsApplied === "object"
        ? (o.defaultsApplied as AskState["defaultsApplied"])
        : undefined,
    summary: String(o.summary || ""),
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : Date.now(),
  };
}
