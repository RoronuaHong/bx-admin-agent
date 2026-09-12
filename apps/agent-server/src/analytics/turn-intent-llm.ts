/**
 * TurnIntent LLM: model declares revise/new/clarify/meta; code validates enums.
 */

import * as trace from "../trace.js";
import {
  askStateIsComplete,
  completeTurnIntentSlots,
  inferTurnIntentFallback,
  stripDisableDefaultsPrefix,
  validateTurnIntent,
  type AskState,
  type TurnIntent,
} from "./ask-state.js";
import { pickAnalyticsModel } from "./pick-analytics-model.js";
import type { AnalyticsPack } from "./semantic-layer.js";
import { packAnalyticsLlmContext } from "./context-pack.js";
import { wrapPackedAnalyticsUserText } from "./input-guard.js";


function buildSystemPrompt(): string {
  return [
    "You classify the user's LATEST turn against the current analytics AskState.",
    "Return ONE JSON object only (no markdown).",
    "Kinds:",
    '- "new_ask": brand-new question (ignore prev Ask slots).',
    '- "revise": edit current Ask (set/clear/requestedPatch).',
    '- "clarify_answer": answering a pending clarify slot.',
    '- "meta": preference actions only.',
    "Rules:",
    "- Follow-ups like 「X呢？」that add a channel for comparison → revise + requestedPatch.channels.mode=union.",
    "- 「换成/改成 X」channel → revise + requestedPatch.channels.mode=replace with X only (drop previous channels).",
    "- If lastClarifySlot is channel and the user names a code, use clarify_answer or replace; never keep ungrounded prev codes.",
    "- Multi-channel compare → set.outputDims must include \"channel\" (and keep watch_date if day grain).",
    "- 「按天/按日」grain → revise set.outputDims to include watch_date; do NOT invent contentLang.",
    "- Without prevAskState you must use new_ask (never revise).",
    "- Never invent SQL. Never invent dimension codes not in the user text or prev Ask.",
    "Schema:",
    '{ "kind":"revise"|"new_ask"|"clarify_answer"|"meta",',
    '  "set": { "metricId"?:string, "outputDims"?:string[], "layout"?: "wide"|"long",',
    '          "filters.channel"?:string[], "filters.contentLang"?:string[], "time"?:{start,end} },',
    '  "clear": string[],',
    '  "requestedPatch": { "channels": { "mode":"union"|"replace", "values": string[] } },',
    '  "slot": string, "values": string[],',
    '  "action": "set_defaults"|"clear_defaults"|"disable_defaults_this_turn",',
    '  "payload": object,',
    '  "notes": string[] }',
  ].join("\n");
}

function buildUserPrompt(input: {
  lastUserText: string;
  prevAskState?: AskState | null;
  lastClarifySlot?: string;
  clarifyOptionIds?: string[];
}): { text: string; usage: ReturnType<typeof packAnalyticsLlmContext>["usage"] } {
  const packed = packAnalyticsLlmContext({
    messages: [{ role: "user", text: input.lastUserText }],
    prevAskState: input.prevAskState && askStateIsComplete(input.prevAskState) ? input.prevAskState : null,
    phase: "turn_intent",
  });
  const parts = [
    wrapPackedAnalyticsUserText(packed),
  ];
  if (input.lastClarifySlot) {
    parts.push(`lastClarifySlot: ${input.lastClarifySlot}`);
    if (input.clarifyOptionIds?.length) {
      parts.push(`clarifyOptionIds: ${input.clarifyOptionIds.join(", ")}`);
    }
  }
  parts.push("Emit TurnIntent JSON now.");
  return { text: parts.join("\n\n"), usage: packed.usage };
}

function extractJsonObject(raw: string): unknown {
  const t = String(raw || "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]!);
    } catch {
      return null;
    }
  }
}

async function chatJson(input: {
  modelId?: string;
  system: string;
  user: string;
  signal?: AbortSignal;
  traceRunId?: string;
  context?: ReturnType<typeof packAnalyticsLlmContext>["usage"];
}): Promise<string> {
  const model = pickAnalyticsModel(input.modelId);
  if (!model) throw new Error("no_model");
  const key = model.apiKeys?.[0] || model.apiKey;
  if (!key) throw new Error("no_api_key");

  const handle = input.traceRunId
    ? trace.span(input.traceRunId, "llm", "analytics.turn_intent", { model: model.id })
    : null;

  const bodyBase = {
    model: model.name,
    temperature: 0,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
  };

  try {
    let content = "";
    try {
      const resp = await fetch(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...bodyBase,
          response_format: { type: "json_object" },
        }),
        signal: input.signal,
      });
      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      if (!resp.ok) throw new Error("json_object_unsupported");
      content = String(data.choices?.[0]?.message?.content || "").trim();
    } catch {
      const resp = await fetch(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bodyBase),
        signal: input.signal,
      });
      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      if (!resp.ok) throw new Error(JSON.stringify(data).slice(0, 300));
      content = String(data.choices?.[0]?.message?.content || "").trim();
    }
    handle?.end({ status: "ok", meta: { bytes: content.length, context: input.context } });
    return content;
  } catch (e) {
    handle?.end({
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

export type ResolveTurnIntentResult = {
  intent: TurnIntent;
  source: "fallback" | "llm" | "llm_invalid" | "llm_error";
};

/**
 * Thin fallback first; otherwise LLM TurnIntent + validate.
 */
export async function resolveTurnIntent(input: {
  lastUserText: string;
  prevAskState?: AskState | null;
  slotAnswers?: Record<string, string[]>;
  lastClarifySlot?: string;
  clarifyOptionIds?: string[];
  modelId?: string;
  signal?: AbortSignal;
  traceRunId?: string;
  pack?: AnalyticsPack | null;
}): Promise<ResolveTurnIntentResult> {
  const fb = inferTurnIntentFallback({
    lastUserText: input.lastUserText,
    prevAskState: input.prevAskState,
    slotAnswers: input.slotAnswers,
    lastClarifySlot: input.lastClarifySlot,
    pack: input.pack,
  });

  // Pure meta / slotAnswers / grounded channel replace → no LLM
  if (fb.kind === "clarify_answer" || fb.kind === "meta") {
    return { intent: fb, source: "fallback" };
  }
  if ((fb.notes || []).includes("fallback_channel_replace")) {
    return { intent: fb, source: "fallback" };
  }
  if ((fb.notes || []).includes("empty")) {
    return { intent: fb, source: "fallback" };
  }

  // 「本轮不用默认」+ 问句：fallback may only attach note; still need LLM on stripped rest
  let textForLlm = String(input.lastUserText || "").trim();
  const disableNote = (fb.notes || []).includes("disable_defaults_this_turn");
  if (disableNote && fb.kind === "new_ask") {
    textForLlm = stripDisableDefaultsPrefix(textForLlm);
  }

  // No prev Ask → new_ask without LLM (Structure will fill)
  if (!input.prevAskState || !askStateIsComplete(input.prevAskState)) {
    const intent: TurnIntent = {
      kind: "new_ask",
      notes: [
        ...(fb.notes || []),
        "turn_intent_no_prev",
        ...(disableNote ? ["disable_defaults_this_turn"] : []),
      ],
    };
    return { intent, source: "fallback" };
  }

  try {
    const prompt = buildUserPrompt({
      lastUserText: textForLlm || input.lastUserText,
      prevAskState: input.prevAskState,
      lastClarifySlot: input.lastClarifySlot,
      clarifyOptionIds: input.clarifyOptionIds,
    });
    const raw = await chatJson({
      modelId: input.modelId,
      system: buildSystemPrompt(),
      user: prompt.text,
      signal: input.signal,
      traceRunId: input.traceRunId,
      context: prompt.usage,
    });
    const parsed = extractJsonObject(raw);
    const validated = validateTurnIntent(parsed, input.prevAskState);
    const completed = completeTurnIntentSlots({
      intent: validated,
      lastUserText: textForLlm || input.lastUserText,
      prevAskState: input.prevAskState,
      pack: input.pack,
      lastClarifySlot: input.lastClarifySlot,
    });
    const notes = [
      ...(completed.notes || []),
      "turn_intent_source:llm",
      ...(disableNote ? ["disable_defaults_this_turn"] : []),
    ];
    if ((validated.notes || []).some((n) => n.startsWith("turn_intent_invalid"))) {
      return {
        intent: { ...completed, notes },
        source: "llm_invalid",
      };
    }
    return { intent: { ...completed, notes }, source: "llm" };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    const completed = completeTurnIntentSlots({
      intent: {
        kind: "new_ask",
        notes: [
          "turn_intent_llm_error",
          `turn_intent_llm_error_detail:${err.slice(0, 180)}`,
          ...(disableNote ? ["disable_defaults_this_turn"] : []),
        ],
      },
      lastUserText: textForLlm || input.lastUserText,
      prevAskState: input.prevAskState,
      pack: input.pack,
      lastClarifySlot: input.lastClarifySlot,
    });
    return { intent: completed, source: "llm_error" };
  }
}
