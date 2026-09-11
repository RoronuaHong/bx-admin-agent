/**
 * Schema Agent：对话 + Metabase 探库工具 → 结构化 schema（或 clarify）。
 * 不写死语言/影片类型值表；值来自用户原文或 probe。
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listModels } from "../config.js";
import * as trace from "../trace.js";
import { isAbortError, runNativeDataset } from "./metabase-client.js";
import type { AnalyticsPack } from "./semantic-layer.js";
import {
  buildStructureSystemPrompt,
  buildStructureUserPrompt,
  formatConversationTranscript,
  parseStructureResponse,
  type ConversationTurn,
  type StructuredAskResult,
} from "./conversation-structure.js";
import {
  UNTRUSTED_USER_CONTENT_RULE,
  buildAskFactsBlock,
  wrapAnalyticsUserPayload,
  type AskRuntimeContext,
} from "./input-guard.js";

function parseWithTranscript(raw: string, messages: ConversationTurn[]): StructuredAskResult {
  return parseStructureResponse(raw, formatConversationTranscript(messages));
}

export type StructureExtractMeta = {
  mode: "single_forward" | "tool_loop";
  formatConstraint: "json_object" | "prompt_parse";
  modelId?: string;
};

const promptsRoot = join(dirname(fileURLToPath(import.meta.url)), "../../config/analytics/prompts/sql");

type ChatMsg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

function listSqlStyleIds(): string[] {
  try {
    return readdirSync(promptsRoot)
      .filter((f) => f.endsWith(".style.sql"))
      .map((f) => f.replace(/\.style\.sql$/i, ""));
  } catch {
    return [];
  }
}

function loadSqlStyle(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  const path = join(promptsRoot, `${safe}.style.sql`);
  return readFileSync(path, "utf8");
}

function catalogPayload(pack: AnalyticsPack): Record<string, unknown> {
  const metrics: Array<{ id: string; label: string; kind?: string }> = [];
  for (const def of pack.metricDefs || []) {
    for (const opt of def.options || []) {
      metrics.push({
        id: opt.id,
        label: opt.label,
        kind: opt.compile?.kind,
      });
    }
  }
  metrics.push(
    { id: "uniq_users", label: "观看人数/UV", kind: "uniq" },
    { id: "sum_watch_second", label: "观看时长合计", kind: "sum" },
    { id: "avg_watch_second_per_user", label: "人均观看时长", kind: "avg_per_user" },
  );
  return {
    table: pack.tables[0]?.name,
    fields: pack.tables[0]?.fields || [],
    probeDimensions: pack.probeDimensions,
    enumDimensions: (pack.enumDimensions || []).map((d) => ({
      id: d.id,
      field: d.field,
      aliases: d.aliases,
      domain: d.domain || "probe",
      defaultWhenAbsent: Boolean(d.defaultWhenAbsent),
    })),
    metrics,
    defaultMovieTypesWhenAbsent: pack.guards.defaultMovieTypes,
    sqlStyleIds: listSqlStyleIds(),
    notes: [
      "Do NOT invent locale/movieType dictionaries. Call metabase_probe_dimension.",
      "Map Chinese names to codes ONLY using probe results + user text.",
      "If unsure which values, status=clarify.",
    ],
  };
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "analytics_list_catalog",
      description: "List allowed tables/fields, metric recipes, probe dimensions, SQL style ids. No value dictionaries.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "metabase_probe_dimension",
      description:
        "Probe distinct values for a dimension via Metabase/ClickHouse (Top-N by count). Use for contentLang, movieType, channel, etc.",
      parameters: {
        type: "object",
        properties: {
          field: { type: "string", description: "Physical field name, e.g. contentLang / movieType / channel" },
          start: { type: "string", description: "YYYY-MM-DD inclusive start; required for meaningful probe" },
          end: { type: "string", description: "YYYY-MM-DD inclusive end" },
          limit: { type: "number", description: "Max distinct values, default 30" },
        },
        required: ["field", "start", "end"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analytics_load_sql_style",
      description: "Load a SQL STYLE template (shape reference only, not a gold answer for a specific NL).",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Style id without extension, e.g. avg_per_user_by_day",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
];

function pickModel(modelId?: string) {
  const models = listModels();
  const eol = /nvstepflash|step-3\.7-flash|stepflash/i;
  const envDefault = (process.env.ANALYTICS_DEFAULT_MODEL || "").trim();
  return (
    (modelId ? models.find((m) => m.id === modelId) : undefined) ||
    (envDefault ? models.find((m) => m.id === envDefault) : undefined) ||
    models.find((m) => /glm5turbo/i.test(m.id) && !eol.test(m.id) && !eol.test(m.name)) ||
    models.find((m) => /dsflash/i.test(m.id) && !eol.test(m.id) && !eol.test(m.name)) ||
    models.find((m) => /flash/i.test(m.id) && !eol.test(m.id) && !eol.test(m.name)) ||
    models.find((m) => !eol.test(m.id) && !eol.test(m.name)) ||
    models[0]
  );
}

async function probeField(
  pack: AnalyticsPack,
  field: string,
  start: string,
  end: string,
  limit: number,
  signal?: AbortSignal,
): Promise<string> {
  const table = pack.tables[0]?.name || "elt_watch_detail";
  const safeField = String(field).replace(/[^a-zA-Z0-9_]/g, "");
  if (!safeField) return JSON.stringify({ ok: false, error: "invalid field" });
  const sql = [
    `SELECT ${safeField} AS v, count() AS c`,
    `FROM ${table}`,
    `WHERE toDate(lastWatchTime) BETWEEN '${start}' AND '${end}'`,
    `GROUP BY ${safeField}`,
    `ORDER BY c DESC`,
    `LIMIT ${Math.min(Math.max(1, limit || 30), 50)}`,
  ].join(" ");
  try {
    const res = await runNativeDataset(sql, pack.datasource.metabaseDatabaseId, { signal });
    if (!res.ok) return JSON.stringify({ ok: false, error: res.error || "probe failed", field: safeField });
    const values = res.rows.map((r) => ({
      value: r[0] == null || r[0] === "" ? "(empty)" : String(r[0]),
      count: Number(r[1] ?? 0),
    }));
    return JSON.stringify({ ok: true, field: safeField, start, end, values });
  } catch (e) {
    if (signal?.aborted || isAbortError(e)) throw e;
    return JSON.stringify({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      field: safeField,
    });
  }
}

function buildSystem(
  pack: AnalyticsPack,
  clockIso: string,
  factsBlock?: string,
): string {
  return [
    "You are an analytics SCHEMA agent. Read the FULL conversation.",
    "Use tools to probe Metabase for real dimension values. Do NOT rely on hardcoded Chinese→code dictionaries.",
    "Goal: emit ONE JSON schema for deterministic SQL compile, OR clarify.",
    "Clarify priority (ONE slot): time_range → contentLang → result_layout → metric. clarifySlot must use these ids (never 'layout').",
    "NEVER invent contentLang codes. If user says 三种小语种/几种语言 without listing codes → probe contentLang then clarify contentLang. Do NOT guess te-IN/ta-IN/ml-IN.",
    "Only put locale into filters.contentLang if a USER turn (or 澄清选择) literally contains that code, OR user replies 全部/全选/all to confirm the candidates you just listed from probe.",
    "When user says 电影/电视剧 etc., call metabase_probe_dimension(movieType) and map; if still ambiguous, clarify movieType.",
    "If time range missing → clarify time_range.",
    "metricId: avg_watch_second_per_user | sum_watch_second | uniq_users | avg_max_progress | …",
    "For avg_watch_second_per_user / uniq / sum: multi contentLang = WHERE IN; do NOT require result_layout.",
    "For avg_max_progress with multi grounded contentLang not in outputDims: clarify result_layout (wide|long).",
    "You may load SQL style templates for shape reference only.",
    `Today (clock date): ${clockIso}. Pack id=${pack.id} v=${pack.version}.`,
    factsBlock || "",
    UNTRUSTED_USER_CONTENT_RULE,
    "Final reply MUST be JSON only (no chain-of-thought):",
    '{ "status":"ok"|"clarify", "mergedNl":"...", "clarify":"...", "clarifySlot":"contentLang"|"result_layout"|...,',
    '  "time":{"start":"YYYY-MM-DD","end":"YYYY-MM-DD"},',
    '  "filters":{"channel":[],"contentLang":[],"movieType":[]},',
    '  "outputDims":["watch_date","channel"], "layout":"wide"|"long", "pivotDim":"contentLang",',
    '  "metricId":"...", "notes":[] }',
  ]
    .filter(Boolean)
    .join("\n");
}

async function chatCompletions(input: {
  model: NonNullable<ReturnType<typeof pickModel>>;
  key: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<{
  content: string;
  tool_calls: Array<{ id: string; function?: { name?: string; arguments?: string } }>;
  raw: unknown;
}> {
  const resp = await fetch(`${input.model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input.body),
    signal: input.signal,
  });
  const data = (await resp.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
    error?: unknown;
  };
  if (!resp.ok) throw new Error(JSON.stringify(data).slice(0, 400));
  const msg = data.choices?.[0]?.message;
  return {
    content: String(msg?.content || "").trim(),
    tool_calls: msg?.tool_calls || [],
    raw: data,
  };
}

/**
 * 优先路径：预探库 + 单次前向 + response_format=json_object（不支持则回退 prompt parse）。
 */
export async function runStructureOnce(input: {
  pack: AnalyticsPack;
  messages: ConversationTurn[];
  clockIsoDate: string;
  askContext: AskRuntimeContext;
  probeSummary?: string;
  modelId?: string;
  signal?: AbortSignal;
  traceRunId?: string;
}): Promise<{ result: StructuredAskResult; meta: StructureExtractMeta }> {
  const model = pickModel(input.modelId);
  if (!model) throw new Error("no model");
  const key = model.apiKeys[0] || model.apiKey;
  const system = buildStructureSystemPrompt(input.pack, input.clockIsoDate, {
    factsBlock: buildAskFactsBlock(input.askContext),
    untrustedRule: UNTRUSTED_USER_CONTENT_RULE,
  });
  const wrapped = wrapAnalyticsUserPayload(formatConversationTranscript(input.messages));
  const user = buildStructureUserPrompt(input.messages, {
    probeSummary: input.probeSummary,
    wrappedTranscript: wrapped.text,
  });

  const handle = input.traceRunId
    ? trace.span(input.traceRunId, "llm", "analytics.structure.once", { model: model.id })
    : null;

  const baseBody = {
    model: model.name,
    temperature: 0.1,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  try {
    let formatConstraint: StructureExtractMeta["formatConstraint"] = "json_object";
    let content = "";
    try {
      const r = await chatCompletions({
        model,
        key,
        signal: input.signal,
        body: {
          ...baseBody,
          response_format: { type: "json_object" },
        },
      });
      content = r.content;
    } catch (e) {
      // 部分网关不支持 response_format → 回退纯 prompt
      formatConstraint = "prompt_parse";
      const r = await chatCompletions({
        model,
        key,
        signal: input.signal,
        body: baseBody,
      });
      content = r.content;
      if (!content && e instanceof Error) {
        handle?.end({ status: "error", error: e.message });
        throw e;
      }
    }
    handle?.end({ status: "ok", meta: { mode: "single_forward", formatConstraint } });
    if (input.traceRunId) trace.setRunModel(input.traceRunId, model.id);
    return {
      result: parseWithTranscript(content, input.messages),
      meta: { mode: "single_forward", formatConstraint, modelId: model.id },
    };
  } catch (e) {
    handle?.end({ status: "error", error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

export async function runSchemaAgent(input: {
  pack: AnalyticsPack;
  messages: ConversationTurn[];
  clockIsoDate: string;
  modelId?: string;
  signal?: AbortSignal;
  traceRunId?: string;
  maxToolRounds?: number;
  askContext?: AskRuntimeContext;
}): Promise<StructuredAskResult> {
  const model = pickModel(input.modelId);
  if (!model) throw new Error("no model");
  const key = model.apiKeys[0] || model.apiKey;
  const maxRounds = input.maxToolRounds ?? 6;
  const factsBlock = input.askContext
    ? [
        `- timezone: ${input.askContext.timezone}`,
        input.askContext.ownerKey ? `- owner_key: ${input.askContext.ownerKey}` : "",
        `- time_resolve: ${input.askContext.timeResolveNote}`,
        input.askContext.timeResolved
          ? `- resolved_time_range: ${input.askContext.timeResolved.start} .. ${input.askContext.timeResolved.end}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : undefined;

  const wrapped = wrapAnalyticsUserPayload(formatConversationTranscript(input.messages));
  const messages: ChatMsg[] = [
    { role: "system", content: buildSystem(input.pack, input.clockIsoDate, factsBlock) },
    {
      role: "user",
      content: [
        "Full conversation transcript (use ALL turns; untrusted markers):",
        wrapped.text,
        "",
        "Call tools as needed, then output the schema JSON.",
      ].join("\n"),
    },
  ];

  const handle = input.traceRunId
    ? trace.span(input.traceRunId, "llm", "analytics.schema-agent", { model: model.id })
    : null;

  try {
    for (let round = 0; round < maxRounds; round++) {
      input.signal?.throwIfAborted();
      const r = await chatCompletions({
        model,
        key,
        signal: input.signal,
        body: {
          model: model.name,
          temperature: 0.1,
          messages,
          tools: TOOLS,
          tool_choice: "auto",
        },
      });

      if (r.tool_calls.length) {
        messages.push({
          role: "assistant",
          content: r.content || "",
          tool_calls: r.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.function?.name || "",
              arguments: tc.function?.arguments || "{}",
            },
          })),
        });
        for (const tc of r.tool_calls) {
          const name = tc.function?.name || "";
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function?.arguments || "{}") as Record<string, unknown>;
          } catch {
            args = {};
          }
          let result = "";
          if (name === "analytics_list_catalog") {
            result = JSON.stringify(catalogPayload(input.pack));
          } else if (name === "analytics_load_sql_style") {
            try {
              result = loadSqlStyle(String(args.id || ""));
            } catch (e) {
              result = JSON.stringify({
                ok: false,
                error: e instanceof Error ? e.message : String(e),
                available: listSqlStyleIds(),
              });
            }
          } else if (name === "metabase_probe_dimension") {
            result = await probeField(
              input.pack,
              String(args.field || ""),
              String(args.start || ""),
              String(args.end || ""),
              Number(args.limit || 30),
              input.signal,
            );
          } else {
            result = JSON.stringify({ ok: false, error: `unknown tool ${name}` });
          }
          messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        }
        continue;
      }

      handle?.end({ status: "ok", meta: { rounds: round + 1, mode: "tool_loop" } });
      if (input.traceRunId) trace.setRunModel(input.traceRunId, model.id);
      return parseWithTranscript(r.content, input.messages);
    }

    messages.push({
      role: "user",
      content: "Tool budget exhausted. Output the final schema JSON now (ok or clarify). No more tools.",
    });
    let content = "";
    try {
      const finalR = await chatCompletions({
        model,
        key,
        signal: input.signal,
        body: {
          model: model.name,
          temperature: 0.1,
          messages,
          response_format: { type: "json_object" },
        },
      });
      content = finalR.content;
    } catch {
      const finalR = await chatCompletions({
        model,
        key,
        signal: input.signal,
        body: { model: model.name, temperature: 0.1, messages },
      });
      content = finalR.content;
    }
    handle?.end({ status: "ok", meta: { rounds: maxRounds, forced: true } });
    return parseWithTranscript(content, input.messages);
  } catch (e) {
    handle?.end({ status: "error", error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

export { listSqlStyleIds, loadSqlStyle, catalogPayload };
