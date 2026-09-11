/**
 * Analytics ask pipeline:
 * \u62a4\u680f + \u4e8b\u5b9e\u6ce8\u5165 \u2192\uff08\u9884\u63a2\u5e93\uff09\u5355\u6b21\u7ed3\u6784\u5316 / \u5fc5\u8981\u65f6 tool-loop \u2192 Intent compile \u2192 lint/exec/\u8bed\u4e49\u6821\u9a8c\u3002
 * Intent/compile/lint/exec \u4e0d\u8d70 LLM \u5199 SQL\uff1b\u4e0d\u6539\u5199\u7528\u6237\u95ee\u53e5\uff1b\u65f6\u95f4\u7531\u4ee3\u7801\u89e3\u6790\u5e76\u8986\u76d6\u6a21\u578b time\u3002
 */

import { config, listModels } from "../config.js";
import * as trace from "../trace.js";
import { getUpload, MAX_AT_ONCE } from "../uploads.js";
import { transcribeImage } from "../vision.js";
import { isAbortError, runNativeDataset } from "./metabase-client.js";
import { loadAnalyticsPack, type AnalyticsPack } from "./semantic-layer.js";
import {
  assertAnalyticsSqlSafe,
  lintSql,
  normalizeDistinctCount,
} from "./sql-guard.js";
import { applyResolvedTime, hasTimeSignal, resolveTimeRange } from "./time-resolve.js";
import type { AnalyticsAskResult, DatasetResult } from "./types.js";
import { verifyGrainDay, verifyMultiQueryIntent, verifyNamedChannel } from "./verify.js";
import { reconcileNamedDimensions } from "./dim-reconcile.js";
import { deriveFailureClass, newAskId, recordAskLedger } from "./audit-ledger.js";
import { buildLocalChartsFromTables } from "./local-chart.js";
import { buildAnalyticsIntentFromStructure, intentToJson } from "./intent.js";
import { compileAnalyticsIntent } from "./sql-compile.js";
import {
  buildStructureSystemPrompt,
  buildStructureUserPrompt,
  formatConversationTranscript,
  impliesLangSetWithoutMembers,
  parseStructureResponse,
  type ConversationTurn,
  type StructuredAskResult,
} from "./conversation-structure.js";
import { runSchemaAgent, runStructureOnce } from "./schema-agent.js";
import { guardAnalyticsInput, type AskRuntimeContext } from "./input-guard.js";
import {
  attachClarifyOptions,
  layoutClarifyOptions,
  metricClarifyOptionsFromPack,
  parseProbeValuesForDim,
  type ClarifyOption,
} from "./clarify-options.js";

type LlmOpts = { modelId?: string; signal?: AbortSignal; traceRunId?: string; spanName?: string };

async function collectAttachmentContext(
  images?: string[],
  files?: string[],
  signal?: AbortSignal,
): Promise<{ context: string; usableCount: number }> {
  const parts: string[] = [];
  let usableCount = 0;
  for (const id of (files || []).slice(0, MAX_AT_ONCE)) {
    signal?.throwIfAborted();
    const item = getUpload(id);
    if (item?.kind === "text") {
      if (item.text.trim()) {
        parts.push(`[\u9644\u4ef6\u6587\u672c]\n${item.text.trim()}`);
        usableCount += 1;
      } else {
        parts.push(`[\u9644\u4ef6\u6587\u672c\u4e3a\u7a7a] id=${id}`);
      }
    } else {
      parts.push(`[\u9644\u4ef6\u7f3a\u5931] id=${id}\uff08\u4e0d\u5b58\u5728\u6216\u5df2\u8fc7\u671f\uff09`);
    }
  }
  for (const id of (images || []).slice(0, MAX_AT_ONCE)) {
    signal?.throwIfAborted();
    const item = getUpload(id);
    if (!item || item.kind !== "image") {
      parts.push(`[\u56fe\u7247\u7f3a\u5931] id=${id}\uff08\u4e0d\u5b58\u5728\u6216\u5df2\u8fc7\u671f\uff09`);
      continue;
    }
    try {
      const desc = await transcribeImage(item.base64, item.mediaType, signal);
      if (desc.trim()) {
        parts.push(`[\u56fe\u7247\u5185\u5bb9]\n${desc.trim()}`);
        usableCount += 1;
      } else {
        parts.push(`[\u56fe\u7247\u5185\u5bb9\u4e3a\u7a7a] id=${id}`);
      }
    } catch (e) {
      if (signal?.aborted || isAbortError(e)) throw e;
      parts.push(`[\u56fe\u7247\u8f6c\u5f55\u5931\u8d25] ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { context: parts.join("\n\n"), usableCount };
}

async function llmText(system: string, user: string, opts?: LlmOpts): Promise<string> {
  const models = listModels();
  const eol = /nvstepflash|step-3\.7-flash|stepflash/i;
  const envDefault = (process.env.ANALYTICS_DEFAULT_MODEL || "").trim();
  const preferred =
    (opts?.modelId ? models.find((m) => m.id === opts.modelId) : undefined) ||
    (envDefault ? models.find((m) => m.id === envDefault) : undefined) ||
    models.find((m) => /glm5turbo/i.test(m.id) && !eol.test(m.id) && !eol.test(m.name)) ||
    models.find((m) => /dsflash/i.test(m.id) && !eol.test(m.id) && !eol.test(m.name)) ||
    models.find((m) => /flash/i.test(m.id) && !eol.test(m.id) && !eol.test(m.name)) ||
    models.find((m) => !eol.test(m.id) && !eol.test(m.name)) ||
    models[0];
  const model = preferred;
  if (!model) throw new Error("no model");
  const key = model.apiKeys[0] || model.apiKey;
  const handle = opts?.traceRunId
    ? trace.span(opts.traceRunId, "llm", opts.spanName || "analytics.llm", { model: model.id })
    : null;
  let ended = false;
  const endOnce = (endOpts?: Parameters<NonNullable<typeof handle>["end"]>[0]) => {
    if (!handle || ended) return;
    ended = true;
    handle.end(endOpts);
  };
  try {
    const resp = await fetch(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.name,
        temperature: 0.1,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: opts?.signal,
    });
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      error?: unknown;
    };
    if (!resp.ok) {
      const err = JSON.stringify(data).slice(0, 300);
      endOnce({ status: "error", error: err });
      throw new Error(err);
    }
    const usage = data.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : undefined;
    endOnce({ usage });
    if (opts?.traceRunId) trace.setRunModel(opts.traceRunId, model.id);
    return data.choices?.[0]?.message?.content || "";
  } catch (e) {
    endOnce({ status: "error", error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

async function probeDimensions(
  pack: AnalyticsPack,
  range: { start: string; end: string },
  signal?: AbortSignal,
): Promise<string> {
  const dims = pack.probeDimensions.slice(0, pack.guards.maxProbeRounds);
  const lines: string[] = [];
  for (const dim of dims) {
    signal?.throwIfAborted();
    const table = pack.tables[0]?.name ?? "elt_watch_detail";
    const sql = [
      `SELECT ${dim}, count() AS c`,
      `FROM ${table}`,
      `WHERE toDate(lastWatchTime) BETWEEN '${range.start}' AND '${range.end}'`,
      `GROUP BY ${dim}`,
      `ORDER BY c DESC`,
      `LIMIT 20`,
    ].join(" ");
    try {
      const res = await runNativeDataset(sql, pack.datasource.metabaseDatabaseId, { signal });
      if (!res.ok) {
        lines.push(`${dim}: PROBE_FAILED (${res.error || "error"})`);
        continue;
      }
      const vals = res.rows.slice(0, 15).map((r) => {
        const v = r[0] == null ? "" : String(r[0]);
        return v === "" ? "(empty)" : v;
      });
      lines.push(`${dim}: ${vals.join(", ") || "(empty)"}`);
    } catch (e) {
      if (signal?.aborted || isAbortError(e)) throw e;
      lines.push(`${dim}: PROBE_FAILED (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return lines.join("\n");
}

function collectIssues(
  nl: string,
  sqls: string[],
  allowedTables: string[],
  dimColumns?: string[],
): string[] {
  const issues: string[] = [];
  for (const sql of sqls) {
    try {
      assertAnalyticsSqlSafe(sql, allowedTables);
    } catch (e) {
      issues.push(e instanceof Error ? e.message : String(e));
    }
    issues.push(...lintSql(sql, nl));
    issues.push(...verifyGrainDay(nl, sql));
  }
  issues.push(...verifyNamedChannel(nl, sqls, dimColumns));
  issues.push(...verifyMultiQueryIntent(nl, sqls));
  return [...new Set(issues)];
}

/** \u8986\u76d6\u7f3a\u53e3 / SQL \u5b89\u5168\u95ee\u9898 \u2192 refuse\uff1b\u5176\u4f59 \u2192 clarify */
function isCoverageOrSafetyIssue(detail: string): boolean {
  return /unsupported_metric|not compilable|SQL AST guard|non_readonly|multi_statement|not_select|into_outfile|missing_where|whitelist|unknown metric/i.test(
    detail,
  );
}

function coverageRefuseMessage(stage: string, detail: string): string {
  return `\u5f53\u524d\u95ee\u6570\u8d85\u51fa\u8bed\u4e49\u5c42\u5df2\u5efa\u6a21\u8303\u56f4\u6216\u672a\u901a\u8fc7 SQL \u5b89\u5168\u6821\u9a8c\uff08${stage}\uff09\uff1a${detail}\u3002\u8bf7\u6539\u7528\u5df2\u652f\u6301\u7684\u6307\u6807/\u7ef4\u5ea6\uff0c\u6216\u8054\u7cfb\u8865\u5145\u5efa\u6a21\uff1b\u7cfb\u7edf\u4e0d\u4f1a\u8fd4\u56de\u672a\u6821\u9a8c\u7684\u67e5\u8be2\u7ed3\u679c\u3002`;
}

function normalizeSqls(sqls: string[]): string[] {
  const fn = config.metabase.distinctCountFn;
  return sqls.map((s) => normalizeDistinctCount(s, fn));
}

function ensureMaxRows(sql: string, maxRows: number): string {
  if (!Number.isFinite(maxRows) || maxRows <= 0) return sql;
  if (/\blimit\s+\d+\b/i.test(sql)) return sql;
  return `${sql.trim().replace(/;+\s*$/, "")}\nLIMIT ${Math.floor(maxRows)}`;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      signal?.throwIfAborted();
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

function allEmpty(results: DatasetResult[]): boolean {
  return results.length > 0 && results.every((r) => r.ok && r.rows.length === 0);
}

/** Intent/compile \u5931\u8d25\u65f6\u7528 LLM \u89e3\u91ca\u539f\u56e0\uff1b\u4e25\u7981 LLM \u5199 SQL */
async function diagnoseFailure(
  input: {
    transcript: string;
    stage: string;
    detail: string;
    structuredJson?: string;
    intentJson?: string;
    sqlPreview?: string;
  },
  opts?: LlmOpts,
): Promise<string> {
  try {
    const text = await llmText(
      [
        "Explain in concise Chinese: why the ask cannot complete, and what the user should clarify next.",
        "ABSOLUTELY FORBIDDEN: do not write SQL, do not invent table/column names.",
      ].join("\n"),
      [
        `Stage: ${input.stage}`,
        `Detail: ${input.detail}`,
        `Transcript:\n${input.transcript.slice(0, 2500)}`,
        input.structuredJson ? `Structured JSON:\n${input.structuredJson}` : "",
        input.intentJson ? `Intent:\n${input.intentJson}` : "",
        input.sqlPreview ? `SQL preview:\n${input.sqlPreview.slice(0, 800)}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      { ...opts, spanName: "analytics.diagnose" },
    );
    const cleaned = text.trim();
    if (cleaned) return cleaned.slice(0, 800);
  } catch {
    /* fall through */
  }
  return `\u95ee\u6570\u5728 ${input.stage} \u9636\u6bb5\u672a\u80fd\u5b8c\u6210\uff1a${input.detail}\u3002\u8bf7\u8865\u5145\u65f6\u95f4/\u7ef4\u5ea6/\u6307\u6807\u53e3\u5f84\u540e\u91cd\u8bd5\u3002`;
}

function businessClockDate(clock: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(clock);
}

/**
 * NL \u2192 \u62a4\u680f+\u4e8b\u5b9e\u6ce8\u5165 \u2192\uff08\u9884\u63a2\u5e93\uff09\u5355\u6b21\u7ed3\u6784\u5316 / \u5fc5\u8981\u65f6 tool-loop \u2192 Intent compile \u2192 lint/exec\u3002
 */
export async function analyticsAsk(
  nl: string,
  opts?: {
    clock?: Date;
    packId?: string;
    modelId?: string;
    signal?: AbortSignal;
    images?: string[];
    files?: string[];
    /** \u6f84\u6e05\u69fd\u4f4d\u77ed\u7b54\uff08\u524d\u7aef\u5408\u6210\uff09\uff0c\u5199\u5165\u5bf9\u8bdd\u4f9b schema \u62bd\u53d6 */
    slotAnswers?: Record<string, string[]>;
    /** \u591a\u8f6e\u5bf9\u8bdd\uff08\u7528\u6237/\u52a9\u624b\uff09\uff0c\u4f18\u5148\u4e8e\u5355\u6761 NL */
    messages?: ConversationTurn[];
    /** \u4f1a\u8bdd\u5f52\u5c5e / \u8ffd\u8e2a\uff1b\u4e0d\u6539\u5199\u95ee\u6570 NL */
    ownerKey?: string;
    userId?: string;
    uiLocale?: string;
  },
): Promise<AnalyticsAskResult> {
  let runId: string | null = null;
  let runClosed = false;
  const closeRun = () => {
    if (runId && !runClosed) {
      runClosed = true;
      trace.endRun(runId);
    }
  };
  const startedAt = Date.now();
  const askId = newAskId();
  let rewriteRounds = 0;
  let guardIssues: string[] = [];
  let packVersion: string | undefined;
  const resolvedModelId = opts?.modelId;

  const seal = (result: AnalyticsAskResult): AnalyticsAskResult => {
    const out: AnalyticsAskResult = {
      ...result,
      askId,
      rewriteRounds,
      modelId: result.modelId ?? resolvedModelId,
      packVersion: result.packVersion ?? packVersion,
    };
    try {
      recordAskLedger({
        askId,
        nl: nl.slice(0, 500),
        status: out.status,
        timeEcho: out.timeEcho,
        sqls: out.sqls,
        guardIssues,
        verify: out.verify,
        rewriteRounds,
        failureClass: deriveFailureClass(out, guardIssues),
        packVersion: out.packVersion,
        modelId: out.modelId,
        runId: runId || undefined,
        ms: Date.now() - startedAt,
        message: out.message,
        error: out.error,
      });
    } catch {
      /* ledger best-effort */
    }
    return out;
  };

  try {
    opts?.signal?.throwIfAborted();
    const attachmentReq = (opts?.images?.length || 0) + (opts?.files?.length || 0);
    const { context: attachmentCtx, usableCount } = await collectAttachmentContext(
      opts?.images,
      opts?.files,
      opts?.signal,
    );
    const guardedNl = guardAnalyticsInput(nl);
    if (guardedNl.refused && attachmentReq === 0) {
      return seal({ status: "clarify", message: guardedNl.refused });
    }
    if (!guardedNl.text && attachmentReq > 0 && usableCount === 0) {
      return seal({
        status: "clarify",
        message: "\u9644\u4ef6\u5df2\u8fc7\u671f\u6216\u65e0\u6cd5\u8bc6\u522b\uff0c\u8bf7\u91cd\u65b0\u4e0a\u4f20\uff0c\u6216\u76f4\u63a5\u8f93\u5165\u95ee\u6570\u5185\u5bb9\u3002",
      });
    }
    const nlSafe = guardedNl.text;
    const nlForResolve = nlSafe || (usableCount > 0 ? guardAnalyticsInput(attachmentCtx).text : "");
    if (!nlForResolve) {
      return seal({ status: "clarify", message: "\u8bf7\u8f93\u5165\u95ee\u6570\u5185\u5bb9\uff0c\u6216\u4e0a\u4f20\u53ef\u7528\u7684\u6587\u672c/\u56fe\u7247\u9644\u4ef6\u3002" });
    }

    const ownerKey = opts?.ownerKey || "analytics:anonymous";
    runId = trace.beginRun({
      userText: nlForResolve.slice(0, 2000),
      model: opts?.modelId,
      agentId: "analytics",
      ownerKey,
    });
    const llmOptsBase: LlmOpts = { modelId: opts?.modelId, signal: opts?.signal, traceRunId: runId };

    const pack = loadAnalyticsPack(opts?.packId || "watch-detail");
    packVersion = pack.version;
    const clock = opts?.clock || new Date();
    const tz = pack.time.businessTimezone || config.metabase.businessTimezone;
    const clockIso = businessClockDate(clock, tz);

    let conversation: ConversationTurn[] = (opts?.messages || [])
      .map((m) => ({
        role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        text: guardAnalyticsInput(String(m.text || "")).text,
      }))
      .filter((m) => m.text);
    if (!conversation.length && nlForResolve) {
      conversation = [{ role: "user", text: nlForResolve }];
    }
    const last = conversation[conversation.length - 1];
    if (nlSafe && (!last || last.role !== "user" || last.text !== nlSafe)) {
      conversation = [...conversation, { role: "user", text: nlSafe }];
    }
    if (opts?.slotAnswers && Object.keys(opts.slotAnswers).length) {
      const parts = Object.entries(opts.slotAnswers).map(([k, vs]) => `${k}=${vs.join(",")}`);
      conversation = [...conversation, { role: "user", text: `\u6f84\u6e05\u9009\u62e9\uff1a${parts.join("\uff1b")}` }];
    }

    const userTextJoined = conversation
      .filter((m) => m.role === "user")
      .map((m) => m.text)
      .join("\n");
    const timeResolved = resolveTimeRange(userTextJoined, clock, tz);
    // \u4ec5\u300c\u6700\u8fd1\u300d\u65e0\u5177\u4f53\u5929\u6570\u65f6\u53cd\u95ee\u65f6\u95f4
    if (
      !timeResolved.ok &&
      /\u6700\u8fd1/.test(userTextJoined) &&
      !hasTimeSignal(userTextJoined.replace(/\u6700\u8fd1/g, ""))
    ) {
      return seal({
        status: "clarify",
        message: timeResolved.clarify,
        clarifySlot: "time_range",
      });
    }

    const askContext: AskRuntimeContext = {
      clockIsoDate: clockIso,
      timezone: tz,
      ownerKey,
      userId: opts?.userId,
      uiLocale: opts?.uiLocale || "zh-CN",
      timeResolveNote: timeResolved.ok
        ? `resolved_by_code ${timeResolved.range.start}..${timeResolved.range.end}`
        : `unresolved: ${timeResolved.clarify}`,
      timeResolved: timeResolved.ok ? timeResolved.range : undefined,
    };

    let structureMeta: {
      mode: "single_forward" | "tool_loop";
      formatConstraint: "json_object" | "prompt_parse";
    } | null = null;
    let structured: StructuredAskResult | null = null;
    let preProbeSummary = "";

    if (conversation.length) {
      if (timeResolved.ok) {
        try {
          preProbeSummary = await probeDimensions(pack, timeResolved.range, opts?.signal);
        } catch (e) {
          if (opts?.signal?.aborted || isAbortError(e)) throw e;
        }
        try {
          const once = await runStructureOnce({
            pack,
            messages: conversation,
            clockIsoDate: clockIso,
            askContext,
            probeSummary: preProbeSummary,
            modelId: opts?.modelId,
            signal: opts?.signal,
            traceRunId: runId || undefined,
          });
          structured = once.result;
          structureMeta = { mode: once.meta.mode, formatConstraint: once.meta.formatConstraint };
        } catch (e) {
          if (opts?.signal?.aborted || isAbortError(e)) throw e;
          structured = null;
        }
      }

      const needsFuzzyDims =
        impliesLangSetWithoutMembers(formatConversationTranscript(conversation)) ||
        /\u7535\u5f71|\u7535\u89c6\u5267|\u77ed\u5267|\u52a8\u6f2b|\u771f\u4eba\u79c0|\u80a5\u7682\u5267/.test(userTextJoined);
      const needsToolLoop = !structured || (!timeResolved.ok && needsFuzzyDims);

      if (needsToolLoop) {
        try {
          structured = await runSchemaAgent({
            pack,
            messages: conversation,
            clockIsoDate: clockIso,
            askContext,
            modelId: opts?.modelId,
            signal: opts?.signal,
            traceRunId: runId || undefined,
          });
          structureMeta = { mode: "tool_loop", formatConstraint: "prompt_parse" };
        } catch (e) {
          if (opts?.signal?.aborted || isAbortError(e)) throw e;
          try {
            const rawStruct = await llmText(
              buildStructureSystemPrompt(pack, clockIso, {
                factsBlock: askContext.timeResolveNote,
              }),
              buildStructureUserPrompt(conversation, { probeSummary: preProbeSummary }),
              { ...llmOptsBase, spanName: "analytics.structure.fallback" },
            );
            structured = parseStructureResponse(
              rawStruct,
              formatConversationTranscript(conversation),
            );
            structureMeta = { mode: "single_forward", formatConstraint: "prompt_parse" };
          } catch (e2) {
            if (opts?.signal?.aborted || isAbortError(e2)) throw e2;
            structured = null;
          }
        }
      } else if (!structured && !timeResolved.ok) {
        try {
          const once = await runStructureOnce({
            pack,
            messages: conversation,
            clockIsoDate: clockIso,
            askContext,
            modelId: opts?.modelId,
            signal: opts?.signal,
            traceRunId: runId || undefined,
          });
          structured = once.result;
          structureMeta = { mode: once.meta.mode, formatConstraint: once.meta.formatConstraint };
        } catch (e) {
          if (opts?.signal?.aborted || isAbortError(e)) throw e;
          structured = null;
        }
      }
    }

    if (structured && timeResolved.ok) {
      structured = applyResolvedTime(structured, timeResolved);
    }

    const transcript = formatConversationTranscript(conversation);
    const metaFields = {
      formatConstraint: structureMeta?.formatConstraint,
      structureMode: structureMeta?.mode,
    };

    if (structured?.status === "clarify") {
      let rangeEcho: string | undefined;
      let probeSummaryForClarify = preProbeSummary;
      let options: ClarifyOption[] | undefined;
      if (structured.time?.start && structured.time?.end) {
        rangeEcho = `\u6309 ${structured.time.start}\uff5e${structured.time.end}`;
      }
      if (structured.clarifySlot === "result_layout") {
        options = layoutClarifyOptions();
      }
      const needProbe = Boolean(
        structured.clarifySlot &&
          (structured.clarifySlot === "contentLang" ||
            structured.clarifySlot === "movieType" ||
            pack.probeDimensions.includes(structured.clarifySlot)),
      );
      // contentLang / movieType \u7b49\u53ef\u63a2\u7ef4\uff1a\u5148 probe \u518d\u9644\u5e26\u5e8f\u53f7\u5019\u9009
      let probeRange = structured.time;
      if (needProbe && !(probeRange?.start && probeRange?.end) && timeResolved.ok) {
        probeRange = { start: timeResolved.range.start, end: timeResolved.range.end };
      }
      if (needProbe && probeRange?.start && probeRange?.end && !probeSummaryForClarify) {
        try {
          probeSummaryForClarify = await probeDimensions(
            pack,
            { start: probeRange.start, end: probeRange.end },
            opts?.signal,
          );
          if (!rangeEcho) rangeEcho = `\u6309 ${probeRange.start}\uff5e${probeRange.end}`;
        } catch (e) {
          if (opts?.signal?.aborted || isAbortError(e)) throw e;
        }
      }
      if (needProbe && probeSummaryForClarify) {
        options = parseProbeValuesForDim(probeSummaryForClarify, structured.clarifySlot);
      }
      if (
        structured.clarifySlot === "metric" &&
        !(options && options.length) &&
        pack.metricDefs?.length
      ) {
        options = metricClarifyOptionsFromPack(pack);
      }
      const clarified = attachClarifyOptions(structured.clarify, options, {
        multiSelect: structured.clarifySlot !== "result_layout" && structured.clarifySlot !== "metric",
        slot: structured.clarifySlot,
      });
      return seal({
        status: "clarify",
        message: clarified.message,
        timeEcho: rangeEcho,
        clarifySlot: structured.clarifySlot,
        clarifyOptions: clarified.clarifyOptions,
        probeSummary: probeSummaryForClarify || undefined,
        packVersion: pack.version,
        structuredFromConversation: true,
        ...metaFields,
      });
    }

    if (!(structured?.status === "ok" && structured.metricId && structured.time)) {
      // schema \u672a\u843d\u5730\u4e14\u542b\u300cN\u79cd\u5c0f\u8bed\u79cd\u300d\uff1a\u5f3a\u5236 contentLang \u53cd\u95ee\uff08\u7981\u6b62 LLM \u731c\u7801\uff09
      if (impliesLangSetWithoutMembers(transcript)) {
        let options: ClarifyOption[] | undefined;
        let probeSummaryForClarify = preProbeSummary;
        let rangeEcho: string | undefined;
        if (timeResolved.ok) {
          rangeEcho = timeResolved.range.echo;
          if (!probeSummaryForClarify) {
            try {
              probeSummaryForClarify = await probeDimensions(pack, timeResolved.range, opts?.signal);
            } catch (e) {
              if (opts?.signal?.aborted || isAbortError(e)) throw e;
            }
          }
          options = parseProbeValuesForDim(probeSummaryForClarify, "contentLang");
        }
        const clarified = attachClarifyOptions(
          "\u8bf7\u786e\u8ba4\u8981\u7edf\u8ba1\u7684\u5177\u4f53\u5185\u5bb9\u8bed\u8a00\uff08\u53ef\u591a\u9009\uff09\u3002\u53ef\u56de\u590d\u5e8f\u53f7\u6216\u8bed\u8a00\u7801\u3002",
          options,
          { multiSelect: true, slot: "contentLang" },
        );
        return seal({
          status: "clarify",
          message: clarified.message,
          timeEcho: rangeEcho,
          clarifySlot: "contentLang",
          clarifyOptions: clarified.clarifyOptions,
          probeSummary: probeSummaryForClarify || undefined,
          packVersion: pack.version,
          ...metaFields,
        });
      }

      const msg = await diagnoseFailure(
        {
          transcript,
          stage: "structure",
          detail: "\u672a\u80fd\u4ece\u5bf9\u8bdd\u5f97\u5230\u5b8c\u6574\u7ed3\u6784\u5316 schema\uff08\u65f6\u95f4/\u6307\u6807/\u8fc7\u6ee4\uff09",
          structuredJson: structured ? JSON.stringify(structured) : undefined,
        },
        llmOptsBase,
      );
      return seal({
        status: "clarify",
        message: msg,
        packVersion: pack.version,
        ...metaFields,
      });
    }

    const range = {
      start: structured.time.start,
      end: structured.time.end,
      echo: `\u6309 ${structured.time.start}\uff5e${structured.time.end}`,
    };
    const nlForGuards = structured.mergedNl || nlSafe || nlForResolve;
    const allowedTables = pack.tables.map((t) => t.name);
    const dimColumns = pack.probeDimensions;

    const intentBuilt = buildAnalyticsIntentFromStructure({
      structure: {
        time: structured.time,
        filters: structured.filters,
        outputDims: structured.outputDims,
        layout: structured.layout,
        pivotDim: structured.pivotDim,
        metricId: structured.metricId,
      },
      pack,
      fallbackNl: nlForGuards,
    });

    if (!intentBuilt.ok) {
      const detail = intentBuilt.reason;
      if (isCoverageOrSafetyIssue(detail) || /not compilable/i.test(detail)) {
        return seal({
          status: "refuse",
          message: coverageRefuseMessage("intent", detail),
          timeEcho: range.echo,
          error: detail,
          packVersion: pack.version,
          structuredFromConversation: true,
          semanticOk: false,
          semanticIssues: [detail],
          ...metaFields,
        });
      }
      if (/result_layout/i.test(detail)) {
        const clarified = attachClarifyOptions(
          "\u8bf7\u9009\u62e9\u5bbd\u8868\u6216\u957f\u8868\uff08wide/long\uff09\u3002",
          layoutClarifyOptions(),
          { multiSelect: false, slot: "result_layout" },
        );
        return seal({
          status: "clarify",
          message: clarified.message,
          clarifySlot: "result_layout",
          clarifyOptions: clarified.clarifyOptions,
          timeEcho: range.echo,
          packVersion: pack.version,
          structuredFromConversation: true,
          ...metaFields,
        });
      }
      const msg = await diagnoseFailure(
        {
          transcript,
          stage: "intent",
          detail,
          structuredJson: JSON.stringify(structured),
        },
        llmOptsBase,
      );
      return seal({
        status: "clarify",
        message: msg,
        timeEcho: range.echo,
        packVersion: pack.version,
        structuredFromConversation: true,
        ...metaFields,
      });
    }

    const compiled = compileAnalyticsIntent(intentBuilt.intent, pack);
    if (!compiled.ok) {
      const detail = compiled.reason;
      return seal({
        status: "refuse",
        message: coverageRefuseMessage("compile", detail),
        timeEcho: range.echo,
        error: detail,
        packVersion: pack.version,
        structuredFromConversation: true,
        semanticOk: false,
        semanticIssues: [detail],
        ...metaFields,
      });
    }

    let sqls = normalizeSqls([compiled.sql]);
    const issues = collectIssues(nlForGuards, sqls, allowedTables, dimColumns);
    guardIssues = issues;
    if (issues.length) {
      const detail = issues.join("; ");
      if (isCoverageOrSafetyIssue(detail)) {
        return seal({
          status: "refuse",
          message: coverageRefuseMessage("lint", detail),
          timeEcho: range.echo,
          sqls,
          error: detail,
          packVersion: pack.version,
          structuredFromConversation: true,
          semanticOk: false,
          semanticIssues: issues,
          ...metaFields,
        });
      }
      const msg = await diagnoseFailure(
        {
          transcript,
          stage: "lint",
          detail,
          intentJson: intentToJson(intentBuilt.intent),
          sqlPreview: sqls[0],
        },
        llmOptsBase,
      );
      return seal({
        status: "clarify",
        message: msg,
        timeEcho: range.echo,
        sqls,
        error: detail,
        packVersion: pack.version,
        structuredFromConversation: true,
        semanticOk: false,
        semanticIssues: issues,
        ...metaFields,
      });
    }

    opts?.signal?.throwIfAborted();
    const dbId = pack.datasource.metabaseDatabaseId;
    const maxRows = pack.guards.maxRows;
    const execSqls = sqls.map((s) => ensureMaxRows(s, maxRows));
    const compileHandle = trace.span(runId, "tool", "analytics.intent-compile", {
      worker: "analytics",
    });
    let results: DatasetResult[];
    try {
      results = await mapPool(
        execSqls,
        pack.guards.parallelism,
        (sql) => runNativeDataset(sql, dbId, { signal: opts?.signal, timeoutMs: pack.guards.queryTimeoutMs }),
        opts?.signal,
      );
      compileHandle.end({
        status: results.every((r) => r.ok) ? "ok" : "error",
        meta: { sqlSource: "intent_compile", statements: execSqls.length },
      });
    } catch (e) {
      compileHandle.end({
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }

    const execErrors = results.filter((r) => !r.ok);
    if (execErrors.length === results.length && results.length > 0) {
      const detail = execErrors.map((r) => r.error).join("; ");
      const msg = await diagnoseFailure(
        {
          transcript,
          stage: "exec",
          detail,
          intentJson: intentToJson(intentBuilt.intent),
          sqlPreview: sqls[0],
        },
        llmOptsBase,
      );
      return seal({
        status: "error",
        message: msg,
        timeEcho: range.echo,
        sqls,
        error: detail,
        sqlSource: "intent_compile",
        packVersion: pack.version,
        structuredFromConversation: true,
        semanticOk: false,
        semanticIssues: [detail],
        ...metaFields,
      });
    }

    const tables = results.map((r, i) => ({
      title: sqls.length > 1 ? `\u7ed3\u679c ${i + 1}` : "\u7ed3\u679c",
      cols: r.cols,
      rows: r.rows,
      grain: /toDate\s*\(\s*lastWatchTime\s*\)/i.test(sqls[i]!) ? "day" : undefined,
    }));
    const dimCheck = reconcileNamedDimensions({
      nl: nlForGuards,
      tables,
      sqls,
      dimColumns,
    });
    if (!dimCheck.ok) {
      const msg = await diagnoseFailure(
        {
          transcript,
          stage: "dim_reconcile",
          detail: dimCheck.detail,
          intentJson: intentToJson(intentBuilt.intent),
          sqlPreview: sqls[0],
        },
        llmOptsBase,
      );
      return seal({
        status: "refuse",
        message: msg,
        timeEcho: range.echo,
        sqls,
        tables,
        sqlSource: "intent_compile",
        error: dimCheck.detail,
        packVersion: pack.version,
        structuredFromConversation: true,
        semanticOk: false,
        semanticIssues: [dimCheck.detail],
        ...metaFields,
      });
    }

    const emptyNote = allEmpty(results)
      ? `\uff08${range.echo} \u65f6\u6bb5\u5185\u65e0\u5339\u914d\u884c\uff0c\u8bf7\u6838\u5bf9\u7b5b\u9009\u6761\u4ef6\uff09`
      : "";
    const charts = allEmpty(results) ? [] : buildLocalChartsFromTables(tables);
    return seal({
      status: "ok",
      message: `${range.echo}${emptyNote}`,
      timeEcho: range.echo,
      sqls,
      tables,
      charts: charts.length ? charts : undefined,
      sqlSource: "intent_compile",
      packVersion: pack.version,
      structuredFromConversation: true,
      semanticOk: true,
      semanticIssues: [],
      ...metaFields,
    });
  } catch (e) {
    if (opts?.signal?.aborted || isAbortError(e)) {
      return seal({ status: "error", message: "\u5df2\u53d6\u6d88", error: "aborted" });
    }
    return seal({
      status: "error",
      message: e instanceof Error ? e.message : String(e),
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    closeRun();
  }
}
