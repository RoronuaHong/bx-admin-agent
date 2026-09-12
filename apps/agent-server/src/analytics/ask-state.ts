/**
 * AskState: session working memory for analytics asks.
 * TurnIntent revise/new/clarify/meta → merge → candidate Ask for gates/compile.
 */

import { extractChannelsFromNl } from "./intent.js";
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

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return uniq(v.map(String));
}

/** Channel tokens from NL — reuses intent extractor (no duplicate allow-list). */
export function extractChannelTokensFromText(text: string): string[] {
  return extractChannelsFromNl(text);
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
 * Thin TurnIntent fallback (slotAnswers + meta only).
 * Short-follow-up revise heuristics removed — LLM path is resolveTurnIntent().
 */
export function inferTurnIntentFallback(input: {
  lastUserText: string;
  prevAskState?: AskState | null;
  slotAnswers?: Record<string, string[]>;
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

  if (/^(以后|今后|下次).{0,8}默认/.test(text) || /记住默认|设为默认/.test(text)) {
    const channels = extractChannelTokensFromText(text);
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

function setPath(state: AskState, path: string, value: unknown): void {
  if (path === "metricId" && typeof value === "string") {
    state.metricId = value;
    return;
  }
  if (path === "layout" && (value === "wide" || value === "long")) {
    state.layout = value;
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
  if (path === "requested.contentLangs") {
    const next = { ...state.requested };
    delete next.contentLangs;
    state.requested = next;
    return;
  }
  if (path === "requested.channels") {
    const next = { ...state.requested };
    delete next.channels;
    state.requested = next;
    return;
  }
  if (path === "requested.movieTypes") {
    const next = { ...state.requested };
    delete next.movieTypes;
    state.requested = next;
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
    if (slot === "metric" || slot === "metricId") state.metricId = values[0] || state.metricId;
    else if (slot === "result_layout") state.layout = values[0] === "wide" ? "wide" : "long";
    else if (slot === "time_range" && values.length >= 2) {
      state.time = { start: values[0]!, end: values[1]! };
    } else {
      state.filters = { ...state.filters, [slot]: values };
      if (slot === "channel") state.requested = { ...state.requested, channels: values };
      if (slot === "contentLang") state.requested = { ...state.requested, contentLangs: values };
      if (slot === "movieType") state.requested = { ...state.requested, movieTypes: values };
    }
    state.summary = summarizeAskState(state);
    return { ok: true, state, notes: [...notes, `clarify_answer:${slot}`] };
  }

  // revise
  for (const path of input.intent.clear || []) clearPath(state, path);
  for (const [path, value] of Object.entries(input.intent.set || {})) {
    setPath(state, path, value);
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

export function summarizeAskState(state: AskState): string {
  const parts = [
    state.time?.start && state.time?.end ? `${state.time.start}～${state.time.end}` : null,
    state.filters.channel?.length ? `渠道 ${state.filters.channel.join(",")}` : null,
    state.filters.contentLang?.length ? `语言 ${state.filters.contentLang.join(",")}` : null,
    state.filters.movieType?.length ? `类型 ${state.filters.movieType.join(",")}` : null,
    state.metricId || null,
    state.ops?.filter((o) => o !== "base_aggregate").join(",") || null,
  ];
  return parts.filter(Boolean).join(" · ") || "analytics ask";
}

export function askStateIsComplete(state: AskState): boolean {
  return Boolean(state.metricId && state.time?.start && state.time?.end);
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
  const requested: AskRequested = {
    channels: filters.channel ? [...filters.channel] : undefined,
    contentLangs: filters.contentLang ? [...filters.contentLang] : undefined,
    movieTypes: filters.movieType ? [...filters.movieType] : undefined,
  };
  const state: AskState = {
    askId: input.askId,
    packId: input.packId,
    packVersion: input.packVersion,
    metricId: String(s.metricId || ""),
    time: { start: s.time!.start, end: s.time!.end },
    filters,
    outputDims: [...(s.outputDims || [])],
    layout: s.layout,
    pivotDim: s.pivotDim,
    ops: [...(s.ops || ["base_aggregate"])],
    requested,
    defaultsApplied: input.defaultsApplied,
    summary: s.askSummary || s.mergedNl || summarizeAskState({
      askId: input.askId,
      packId: input.packId,
      packVersion: input.packVersion,
      metricId: String(s.metricId || ""),
      time: { start: s.time!.start, end: s.time!.end },
      filters,
      outputDims: [...(s.outputDims || [])],
      ops: [...(s.ops || [])],
      requested,
      summary: "",
      updatedAt: Date.now(),
    }),
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
  if (!metricId || !time || typeof time.start !== "string" || typeof time.end !== "string") {
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
  return {
    askId: String(o.askId || ""),
    packId: String(o.packId || "watch-detail"),
    packVersion: String(o.packVersion || ""),
    metricId,
    time: { start: time.start, end: time.end },
    filters,
    outputDims: asStringArray(o.outputDims),
    layout: o.layout === "wide" || o.layout === "long" ? o.layout : undefined,
    pivotDim: o.pivotDim ? String(o.pivotDim) : undefined,
    ops: asStringArray(o.ops).length ? asStringArray(o.ops) : ["base_aggregate"],
    requested: {
      channels: asStringArray(requestedRaw.channels).length
        ? asStringArray(requestedRaw.channels)
        : filters.channel,
      contentLangs: asStringArray(requestedRaw.contentLangs).length
        ? asStringArray(requestedRaw.contentLangs)
        : filters.contentLang,
      movieTypes: asStringArray(requestedRaw.movieTypes).length
        ? asStringArray(requestedRaw.movieTypes)
        : filters.movieType,
    },
    defaultsApplied:
      o.defaultsApplied && typeof o.defaultsApplied === "object"
        ? (o.defaultsApplied as AskState["defaultsApplied"])
        : undefined,
    summary: String(o.summary || ""),
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : Date.now(),
  };
}
