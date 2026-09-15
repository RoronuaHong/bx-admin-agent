/**
 * Analytics ask pipeline:
 * Clean + memory + retrieve + pack, then call LLM (structure / SQL agent).
 * Dates resolved by code become facts; missing time is not an early exit.
 */

import { config, type ModelEntry } from "../config.js";
import * as trace from "../trace.js";
import { getUpload, MAX_AT_ONCE } from "../uploads.js";
import { transcribeImage } from "../vision.js";
import { isAbortError, runNativeDataset } from "./metabase-client.js";
import { beginAnalyticsLlmSignal, sanitizeAnalyticsLlmError } from "./llm-error.js";
import {
  allowedTableNames,
  bareTableName,
  compileTableRef,
  expandLinkedTables,
  isOverlayTable,
  loadAnalyticsPack,
  packFieldsForTable,
  packTimeField,
  canApplyTextChannelFilter,
  type AnalyticsPack,
} from "./semantic-layer.js";
import { llmSqlEnabled, routeAnalyticsAsk } from "./ask-route.js";
import { matchVerifiedQuery } from "./verified-query.js";
import { missingNlAnchorsInSql, overlayResolvedDates, runSqlAgent } from "./sql-agent.js";
import { coerceMetricForWarehouseTable } from "./documented-ask.js";
import { answerableTableNamedInNl, formatCatalogFacts, refreshPackFromCatalog } from "./catalog.js";
import { resolveAskTable } from "./table-resolve.js";
import {
  assertAnalyticsSqlSafe,
  assertJoinsOnDeclaredRelationships,
  extractFromTables,
  lintSql,
  normalizeDistinctCount,
  sqlRequiresWhere,
} from "./sql-guard.js";
import { getTableSchemas } from "./catalog-schema.js";
import { applyResolvedTime, resolveAskTimeRange } from "./time-resolve.js";
import type { AnalyticsAskResult, DatasetResult } from "./types.js";
import { verifyGrainDay, verifyMultiQueryIntent, verifyNamedChannel } from "./verify.js";
import { reconcileNamedDimensions } from "./dim-reconcile.js";
import { deriveFailureClass, newAskId, recordAskLedger } from "./audit-ledger.js";
import { buildLocalChartsFromTables } from "./local-chart.js";
import { withNlColumnTitles } from "./column-labels.js";
import { buildAnalyticsIntentFromStructure, extractChannelsFromNl, intentToJson } from "./intent.js";
import { compileAnalyticsIntent } from "./sql-compile.js";
import {
  buildStructureSystemPrompt,
  buildStructureUserPrompt,
  impliesLangSetWithoutMembers,
  neededProbeFields,
  needsDimensionProbe,
  parseStructureResponse,
  userDemandsLangFilter,
  type ConversationTurn,
  type StructuredAskResult,
  type StructuredAskOk,
} from "./conversation-structure.js";
import { runSchemaAgent, runStructureOnce } from "./schema-agent.js";
import {
  UNTRUSTED_USER_CONTENT_RULE,
  buildAskFactsBlock,
  guardAnalyticsInput,
  type AskRuntimeContext,
} from "./input-guard.js";
import {
  packAnalyticsLlmContext,
  renderAnalyticsLlmUserText,
  type AnalyticsLlmPack,
} from "./context-pack.js";
import {
  attachClarifyOptions,
  layoutClarifyOptions,
  metricClarifyOptionsFromPack,
  parseProbeValuesForDim,
  type ClarifyOption,
} from "./clarify-options.js";
import { loadFieldLexicon, resolvePackFilters, groundRemappedFieldFromNl } from "./dim-resolve.js";
import { lexiconClarifyOptions, type DimLexicon } from "./dim-lexicon.js";
import { evaluateCapabilityGate, refuseUnsupportedOpsFromNl } from "./capability-gate.js";
import { applyCoverageGate, coverageFields } from "./coverage-gate.js";
import {
  ambiguousMetricFamilyClarify,
  alignMetricIdToNl,
  coerceUnknownMetricId,
  inferMetricIdFromNl,
  inferOutputDimsFromNl,
  nlForMetricFamilyGate,
} from "./metric-infer.js";
import { checkMetricIntentAlignment, runPostExecLlm, verifyCaution } from "./llm-verify.js";
import {
  listAnalyticsModelCandidates,
  markAnalyticsModelSuccess,
  markAnalyticsModelUnavailable,
} from "./pick-analytics-model.js";
import {
  isFatalModelError,
  isModelUnavailableError,
  modelFallbackAttempts,
  reportModelQualityFailure,
  withModelFallback,
} from "./model-fallback.js";
import {
  compileAskPlanSteps,
  gateAskPlan,
  inclusiveDaySpan,
  mergeRatioTables,
  growthKindToSynthesize,
  relativeGrowthKind,
  resolvePlanCardinality,
  entityCompareField,
  synthesizeMomPlan,
  synthesizeYoyPlan,
} from "./ask-plan.js";
import {
  applyAnalyticsPrefsDefaults,
  formatAnalyticsPrefsFacts,
  loadAnalyticsPrefs,
  rememberAnalyticsSuccess,
  saveAnalyticsPrefs,
} from "./analytics-prefs.js";
import {
  askStateIsComplete,
  buildAskStateFromStructure,
  applySlotAnswersToAskState,
  askStateToStructured,
  mergeAskState,
  parseAskState,
  type AskState,
  type TurnIntent,
} from "./ask-state.js";
import { resolveTurnIntent } from "./turn-intent-llm.js";
import { groundChannelFilters } from "./grounding-gate.js";
import { applyDeliveryReconcile, type DeliveryMode } from "./delivery.js";

type LlmOpts = {
  modelId?: string;
  signal?: AbortSignal;
  traceRunId?: string;
  spanName?: string;
  spanMeta?: Record<string, unknown>;
  /** 候选链换模型后上报「实际使用」的模型（结果/审计如实展示，而非请求时的首选） */
  onModelUsed?: (modelId: string) => void;
};

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

/** 单个候选模型的一次 chat/completions 调用（自带 trace span 与超时信号） */
async function callAnalyticsChat(
  model: ModelEntry,
  system: string,
  user: string,
  opts?: LlmOpts,
): Promise<string> {
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
  const llmSig = beginAnalyticsLlmSignal(opts?.signal);
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
      signal: llmSig.signal,
    });
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      error?: unknown;
    };
    if (!resp.ok) {
      const err = JSON.stringify(data).slice(0, 300);
      endOnce({ status: "error", error: err });
      const httpErr = new Error(err) as Error & { status?: number };
      httpErr.status = resp.status;
      throw httpErr;
    }
    const usage = data.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : undefined;
    endOnce({ usage, meta: opts?.spanMeta });
    if (opts?.traceRunId) trace.setRunModel(opts.traceRunId, model.id);
    markAnalyticsModelSuccess(model.id);
    opts?.onModelUsed?.(model.id);
    return data.choices?.[0]?.message?.content || "";
  } catch (e) {
    const err = llmSig.didTimeout() ? new Error("llm_timeout") : e;
    endOnce({ status: "error", error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    llmSig.cleanup();
  }
}

/**
 * 分析链路统一模型调用：候选链 + 可用性冷却。
 * 首选因额度/限流/下线失败时自动换下一个候选，而不是让整条链路静默降级；
 * 取消与超时不换模型（换模型只会把等待时间翻倍）。
 */
async function llmText(system: string, user: string, opts?: LlmOpts): Promise<string> {
  const candidates = listAnalyticsModelCandidates(opts?.modelId);
  if (!candidates.length) throw new Error("no model");
  return withModelFallback({
    candidates,
    maxAttempts: modelFallbackAttempts(),
    isFatal: isFatalModelError,
    attempt: (model) => callAnalyticsChat(model, system, user, opts),
    onUnavailable: (model, e, next) => {
      if (isModelUnavailableError(e)) markAnalyticsModelUnavailable(model.id);
      const reason = (e instanceof Error ? e.message : String(e)).slice(0, 160);
      console.warn(
        `[analytics:model] ${model.id} 调用失败${next ? `，改用 ${next.id}` : "，无更多候选"}：${reason}`,
      );
    },
  });
}

async function probeDimensions(
  pack: AnalyticsPack,
  range: { start: string; end: string },
  signal?: AbortSignal,
  fields?: string[],
  tableName?: string,
): Promise<string> {
  const wanted = fields?.length
    ? pack.probeDimensions.filter((d) => fields.includes(d))
    : pack.probeDimensions;
  const dims = wanted.slice(0, pack.guards.maxProbeRounds);
  const lines: string[] = [];
  const table = String(tableName || "").trim() || pack.tables[0]?.name || "";
  if (!table) return "";
  const timeField = packTimeField(pack, table);
  const liveFields = new Set(packFieldsForTable(pack, table));
  const from = compileTableRef(pack, table);
  for (const dim of dims) {
    signal?.throwIfAborted();
    if (liveFields.size && !liveFields.has(dim)) {
      lines.push(`${dim}: SKIP_NOT_IN_CATALOG`);
      continue;
    }
    const where = timeField
      ? `WHERE toDate(${timeField}) BETWEEN '${range.start}' AND '${range.end}'`
      : "";
    const sql = [
      `SELECT ${dim}, count() AS c`,
      `FROM ${from}`,
      where,
      `GROUP BY ${dim}`,
      `ORDER BY c DESC`,
      `LIMIT 20`,
    ]
      .filter(Boolean)
      .join(" ");
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
  dimColumns: string[] | undefined,
  timeField: string | undefined,
  skipNamedChannel: boolean,
  pack: AnalyticsPack,
): string[] {
  const issues: string[] = [];
  // 时间列只来自调用方的 packTimeField(pack, table)——代码里不设 schema 默认列。
  const tf = String(timeField || "").trim();
  for (const sql of sqls) {
    try {
      assertAnalyticsSqlSafe(sql, allowedTables, {
        requireWhere: pack ? sqlRequiresWhere(sql, pack) : true,
      });
    } catch (e) {
      issues.push(e instanceof Error ? e.message : String(e));
    }
    issues.push(...lintSql(sql, nl, { pack, timeField: tf }));
    issues.push(...verifyGrainDay(nl, sql, pack));
  }
  if (!skipNamedChannel) {
    issues.push(...verifyNamedChannel(nl, sqls, dimColumns));
  }
  issues.push(...verifyMultiQueryIntent(nl, sqls));
  return [...new Set(issues)];
}

function sqlHasDayGrain(sql: string, pack: AnalyticsPack, table?: string): boolean {
  const field = packTimeField(pack, table);
  if (!field) return false;
  const f = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const toDate = new RegExp(`toDate\\s*\\(\\s*${f}\\s*\\)`, "i");
  if (toDate.test(sql)) {
    return new RegExp(`group\\s+by[\\s\\S]*toDate\\s*\\(\\s*${f}\\s*\\)`, "i").test(sql);
  }
  return new RegExp(`group\\s+by[\\s\\S]*\\b${f}\\b`, "i").test(sql);
}

/** \u8986\u76d6\u7f3a\u53e3 / SQL \u5b89\u5168\u95ee\u9898 \u2192 refuse\uff1b\u5176\u4f59 \u2192 clarify */
function isCoverageOrSafetyIssue(detail: string): boolean {
  return /unsupported_metric|unsupported_op|not compilable|SQL AST guard|non_readonly|multi_statement|not_select|into_outfile|missing_where|whitelist|unknown metric|undeclared_join/i.test(
    detail,
  );
}

function trustCaption(trust: "trusted" | "verified" | "unverified"): string {
  if (trust === "verified") return "\u300c\u91d1\u6837\u53e3\u5f84\u300d";
  if (trust === "unverified") return "\u300c\u672a\u6838\u9a8c\u53e3\u5f84\u300d";
  return "";
}

async function runHybridSqls(input: {
  pack: AnalyticsPack;
  sqls: string[];
  nl: string;
  time: { start: string; end: string };
  table?: string;
  allowedTables?: string[];
  signal?: AbortSignal;
}): Promise<
  | {
      ok: true;
      sqls: string[];
      tables: Array<{ title: string; cols: string[]; colTitles?: string[]; rows: unknown[][]; grain?: string }>;
      empty: boolean;
    }
  | { ok: false; sqls: string[]; issues: string[] }
> {
  const allowed = input.allowedTables?.length ? input.allowedTables : allowedTableNames(input.pack);
  const sqls = normalizeSqls(input.sqls);
  const issues: string[] = [];
  for (const sql of sqls) {
    try {
      assertAnalyticsSqlSafe(sql, allowed, { requireWhere: sqlRequiresWhere(sql, input.pack) });
      assertJoinsOnDeclaredRelationships(sql, input.pack);
    } catch (e) {
      issues.push(e instanceof Error ? e.message : String(e));
    }
    const tf = packTimeField(input.pack, input.table) || packTimeField(input.pack);
    issues.push(...lintSql(sql, input.nl, { pack: input.pack, timeField: tf || undefined }));
    if (tf) issues.push(...verifyGrainDay(input.nl, sql, input.pack));
  }
  issues.push(...verifyNamedChannel(input.nl, sqls, input.pack.probeDimensions));
  const uniq = [...new Set(issues.filter(Boolean))];
  if (uniq.length) return { ok: false, sqls, issues: uniq };
  const execSqls = sqls.map((s) => ensureMaxRows(s, input.pack.guards.maxRows));
  const results = await mapPool(
    execSqls,
    input.pack.guards.parallelism,
    (sql) =>
      runNativeDataset(sql, input.pack.datasource.metabaseDatabaseId, {
        signal: input.signal,
        timeoutMs: input.pack.guards.queryTimeoutMs,
      }),
    input.signal,
  );
  if (results.every((r) => !r.ok)) {
    return { ok: false, sqls: execSqls, issues: results.map((r) => r.error || "exec_failed") };
  }
  return {
    ok: true,
    sqls: execSqls,
    tables: withNlColumnTitles(
      results.map((r, i) => ({
        title: execSqls.length > 1 ? `\u7ed3\u679c ${i + 1}` : "\u7ed3\u679c",
        cols: r.cols,
        rows: r.rows,
        grain: sqlHasDayGrain(execSqls[i]!, input.pack, input.table) ? "day" : undefined,
      })),
      input.nl,
      input.pack,
    ),
    empty: allEmpty(results),
  };
}

function coverageRefuseMessage(stage: string, detail: string): string {
  return `\u5f53\u524d\u95ee\u6570\u8d85\u51fa\u8bed\u4e49\u5c42\u5df2\u5efa\u6a21\u8303\u56f4\u6216\u672a\u901a\u8fc7 SQL \u5b89\u5168\u6821\u9a8c\uff08${stage}\uff09\uff1a${detail}\u3002\u8bf7\u6539\u7528\u5df2\u652f\u6301\u7684\u6307\u6807/\u7ef4\u5ea6\uff0c\u6216\u8054\u7cfb\u8865\u5145\u5efa\u6a21\uff1b\u7cfb\u7edf\u4e0d\u4f1a\u8fd4\u56de\u672a\u6821\u9a8c\u7684\u67e5\u8be2\u7ed3\u679c\u3002`;
}

/**
 * A required filter is missing (e.g. ratio/retention metrics need channel + appVersion).
 * Still refuse — guessing an unverified value would answer something the user never asked — but
 * name the missing filter so the user can actually act on it. The name comes from the pack's
 * declared required filter, so nothing business-specific is hardcoded here.
 */
function missingFilterRefuseMessage(detail: string): string | null {
  const m = /^missing_filter:(.+)$/.exec(String(detail || "").trim());
  if (!m) return null;
  const dim = m[1]!.trim();
  return `\u8be5\u6307\u6807\u53e3\u5f84\u5fc5\u987b\u5e26 ${dim} \u7b5b\u9009\u6761\u4ef6\u624d\u80fd\u7edf\u8ba1\uff0c\u5f53\u524d\u672a\u63d0\u4f9b\u3002\u8bf7\u5728\u95ee\u53e5\u4e2d\u8865\u4e0a ${dim} \u7684\u53d6\u503c\u540e\u91cd\u8bd5\uff08\u7cfb\u7edf\u4e0d\u4f1a\u7528\u672a\u6821\u9a8c\u7684\u53d6\u503c\u53d6\u6570\uff09\u3002`;
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

function finalizeDeliveredTables(input: {
  tables: Array<{ title: string; cols: string[]; colTitles?: string[]; rows: unknown[][]; grain?: string }>;
  message: string;
  askState?: AskState;
  mode?: DeliveryMode;
  nl?: string;
  /** Pack that owns the grain/dim column codes used for NL column titles. */
  pack?: AnalyticsPack;
}): { tables: typeof input.tables; message: string } {
  const filled = applyDeliveryReconcile({
    tables: input.tables,
    requestedChannels: input.askState?.requested?.channels,
    mode: input.mode || "zero_fill",
  });
  const tables = withNlColumnTitles(filled.tables, input.nl || "", input.pack);
  return {
    tables,
    message: filled.messageSuffix ? `${input.message}${filled.messageSuffix}` : input.message,
  };
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
    packed: AnalyticsLlmPack;
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
        renderAnalyticsLlmUserText(input.packed),
        input.structuredJson
          ? `Structured JSON:\n${input.structuredJson.length > 1200 ? `${input.structuredJson.slice(0, 1200)}\n?(truncated)` : input.structuredJson}`
          : "",
        input.intentJson
          ? `Intent:\n${input.intentJson.length > 800 ? `${input.intentJson.slice(0, 800)}\n?(truncated)` : input.intentJson}`
          : "",
        input.sqlPreview ? `SQL preview:\n${input.sqlPreview.slice(0, 800)}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      { ...opts, spanName: "analytics.diagnose", spanMeta: { context: input.packed.usage } },
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
    /** Clarify slot answers used to fill schema */
    slotAnswers?: Record<string, string[]>;
    /** Conversation turns / current-turn NL */
    messages?: ConversationTurn[];
    /** Previous AskState for revise */
    prevAskState?: AskState | Record<string, unknown>;
    /** Last clarify slot, used to resolve TurnIntent */
    lastClarifySlot?: string;
    clarifyOptionIds?: string[];
    /** Conversation / prefs owner */
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
  // 候选链可能换模型：记录「实际使用」的模型，结果/审计如实上报
  let usedModelId: string | undefined;
  let currentAskState: AskState | undefined;
  let turnKind: string | undefined;
  let turnIntentSource: string | undefined;

  const defaultsNoteFromState = (s?: AskState): string | undefined => {
    if (!s?.defaultsApplied) return undefined;
    const bits: string[] = [];
    if (s.defaultsApplied.channels) bits.push("\u5df2\u7528\u9ed8\u8ba4\u6e20\u9053");
    if (s.defaultsApplied.layout) bits.push("\u5df2\u7528\u9ed8\u8ba4\u5e03\u5c40");
    return bits.length ? bits.join("\uff1b") : undefined;
  };

  const seal = (result: AnalyticsAskResult): AnalyticsAskResult => {
    const state = result.askState ?? currentAskState;
    const out: AnalyticsAskResult = {
      ...result,
      askId,
      rewriteRounds,
      modelId: result.modelId ?? usedModelId ?? resolvedModelId,
      packVersion: result.packVersion ?? packVersion,
      askState: state,
      turnKind: result.turnKind ?? turnKind,
      turnIntentSource: result.turnIntentSource ?? turnIntentSource,
      askSummary: result.askSummary ?? state?.summary,
      defaultsNote: result.defaultsNote ?? defaultsNoteFromState(state),
      trust:
        result.trust ??
        (result.sqlSource === "intent_compile"
          ? "trusted"
          : result.sqlSource === "verified_query"
            ? "verified"
            : result.sqlSource === "llm_sql"
              ? "unverified"
              : undefined),
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
    const analyticsPrefs = loadAnalyticsPrefs(ownerKey);
    runId = trace.beginRun({
      userText: nlForResolve.slice(0, 2000),
      model: opts?.modelId,
      agentId: "analytics",
      ownerKey,
    });
    const llmOptsBase: LlmOpts = {
      modelId: opts?.modelId,
      signal: opts?.signal,
      traceRunId: runId,
      onModelUsed: (id) => {
        usedModelId = id;
      },
    };

    let pack = loadAnalyticsPack(opts?.packId || "watch-detail");
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

    const typedTurn = nlSafe || "";
    const userTexts = conversation.filter((m) => m.role === "user").map((m) => m.text);
    const lastUserText = userTexts[userTexts.length - 1] || nlSafe || nlForResolve;
    const priorUserTexts = userTexts.slice(0, -1).reverse();
    const prevAskStateEarly = parseAskState(opts?.prevAskState);
    const catalogApplied = await refreshPackFromCatalog(pack, {
      signal: opts?.signal,
      nl: lastUserText,
    });
    pack = catalogApplied.pack;
    const catalogFacts = formatCatalogFacts(pack, catalogApplied.notes);
    const blocked = catalogApplied.unmodeledTablesInNl;
    if (blocked.length) {
      return seal({
        status: "refuse",
        message: `\u8868 ${blocked.join("\u3001")} \u5df2\u9690\u85cf\u6216\u4e0d\u53ef\u67e5\u8be2\uff08\u4e34\u65f6\u8868/\u5b57\u5178/\u4e0a\u4f20\u8868\uff09\uff0c\u4e0d\u4f1a\u751f\u6210 SQL\u3002`,
        error: `blocked_table:${blocked.join(",")}`,
        packVersion: pack.version,
        semanticOk: false,
        semanticIssues: catalogApplied.notes,
      });
    }
    const mergeVerify = (
      a?: AnalyticsAskResult["verify"],
      b?: AnalyticsAskResult["verify"],
    ) => (a?.verdict === "fail" ? a : b?.verdict === "fail" ? b : b || a);
    const attachPostExec = async (input: {
      message: string;
      timeEcho: string;
      sqls: string[];
      tables: NonNullable<AnalyticsAskResult["tables"]>;
      metricId?: string;
      empty?: boolean;
      trust?: AnalyticsAskResult["trust"];
      priorVerify?: AnalyticsAskResult["verify"];
    }) => {
      const post = await runPostExecLlm({
        nl: lastUserText,
        timeEcho: input.timeEcho,
        sqls: input.sqls,
        tables: input.tables,
        metricId: input.metricId,
        empty: input.empty,
        trust: input.trust,
        llmText: async (system, user, spanName) => {
          try {
            return await llmText(system, user, { ...llmOptsBase, spanName });
          } catch {
            return "";
          }
        },
      });
      const verify = mergeVerify(input.priorVerify, post.verify);
      // 口径提示与校对提示同属「方法与出处」收尾层；不再拼进 message（正文只留答案/提示本身）
      const caution = [input.trust ? trustCaption(input.trust) : "", verifyCaution(verify)]
        .filter(Boolean)
        .join("\n");
      return {
        verify,
        insight: post.insight,
        headline: post.headline,
        caution: caution || undefined,
        followups: post.followups,
        message: input.message,
      };
    };

    // ---- 续答分流：TurnIntent + AskState 合并必须早于任何「按当前句」的解析 ----
    const prevAskState = prevAskStateEarly;
    const turnResolved = await resolveTurnIntent({
      lastUserText: typedTurn || lastUserText,
      prevAskState,
      slotAnswers: opts?.slotAnswers,
      lastClarifySlot: opts?.lastClarifySlot,
      clarifyOptionIds: opts?.clarifyOptionIds,
      modelId: opts?.modelId,
      signal: opts?.signal,
      traceRunId: runId || undefined,
      pack,
    });
    const turnIntent: TurnIntent = turnResolved.intent;
    turnKind = turnIntent.kind;
    turnIntentSource = turnResolved.source;

    let structureMeta: {
      mode: "single_forward" | "tool_loop";
      formatConstraint: "json_object" | "prompt_parse";
    } | null = null;
    let structured: StructuredAskResult | null = null;
    // Captured model-resolved StructuredAskOk (table/metricId/outputDims/filters) before any
    // clarify reassignment, so the recoverable AskState seal can carry resolved fields forward.
    let modelOkStructured: StructuredAskOk | null = null;

    /** Seal the current ok structure into AskState, tagging it with a note. */
    const sealWithNote = (note: string): void => {
      if (!structured || structured.status !== "ok") return;
      currentAskState = buildAskStateFromStructure({
        structure: { ...structured, notes: [...(structured.notes || []), note] },
        askId,
        packId: pack.id,
        packVersion: pack.version,
      });
    };

    // AskState the structure phase sees. When a slot answer / revise was merged it becomes the
    // merged state, so already-answered slots (e.g. contentLang) stay visible and the model only
    // has to resolve what is genuinely still missing (e.g. an ambiguous metric).
    let askStateForStructure = prevAskState;
    if (
      (turnIntent.kind === "revise" || turnIntent.kind === "clarify_answer") &&
      prevAskState
    ) {
      // slotAnswers 已含全部槽位（turnIntent 只是其首槽派生），直接全量应用
      const merged =
        opts?.slotAnswers && Object.keys(opts.slotAnswers).length
          ? applySlotAnswersToAskState({
              prev: prevAskState,
              slotAnswers: opts.slotAnswers,
              askId,
              pack,
            })
          : mergeAskState({ prev: prevAskState, intent: turnIntent, askId, pack });
      if (merged.ok) {
        // Carry the merged state even when still incomplete. A multi-slot clarify may be
        // answered one slot at a time (e.g. contentLang first, metric next); dropping the
        // incomplete merge throws away the slots resolved this turn and re-asks them.
        askStateForStructure = merged.state;
        currentAskState = merged.state;
      }
    }

    // 槽位续答（「全部」「1,2,3,4」）且全部槽位齐备 → 不是新问，直接按它编译
    if (
      (turnIntent.kind === "clarify_answer" || turnIntent.kind === "revise") &&
      currentAskState &&
      askStateIsComplete(currentAskState)
    ) {
      structured = askStateToStructured(currentAskState);
      structureMeta = { mode: "single_forward", formatConstraint: "json_object" };
    }
    const isContinuation = structured !== null;

    const timeResolved = resolveAskTimeRange({
      lastUserText,
      prevTime: prevAskStateEarly?.time,
      priorUserTexts,
      clock,
      tz,
    });
    const timeRange = timeResolved.ok ? timeResolved.range : undefined;
    const timeEcho = timeRange
      ? `\u6309 ${timeRange.start}\uff5e${timeRange.end}`
      : undefined;
    const timeCol = packTimeField(pack);
    const overlayFields = pack.tables[0]?.fields || [];
    if (
      pack.catalog?.source !== "skipped" &&
      overlayFields.length &&
      !overlayFields.includes(timeCol)
    ) {
      return seal({
        status: "refuse",
        message: `\u65f6\u95f4\u5b57\u6bb5 ${timeCol} \u4e0d\u5728 overlay \u8868 schema \u4e2d\uff0c\u5df2\u62d2\u7edd\u3002`,
        error: `catalog_time_field_missing:${timeCol}`,
        packVersion: pack.version,
        semanticOk: false,
        semanticIssues: catalogApplied.notes,
      });
    }

    let verifiedQueryFact: string | undefined;
    const vqrHit = matchVerifiedQuery(lastUserText, pack);
    if (vqrHit && "query" in vqrHit) {
      verifiedQueryFact = `- verified_query: ${vqrHit.query.id} ${vqrHit.query.title || ""}`.trim();
    } else if (vqrHit && "clarify" in vqrHit) {
      verifiedQueryFact = `- verified_query_candidates: ${vqrHit.clarify.map((c) => c.id).join(", ")}`;
    }

    const tableResolved = resolveAskTable({
      nl: lastUserText,
      pack,
      hinted: opts?.slotAnswers?.table?.[0],
      fallback: prevAskStateEarly
        ? prevAskStateEarly.table || pack.tables[0]?.name
        : undefined,
    });
    const lockedTable = tableResolved.status === "ok" ? tableResolved.table : undefined;
    const linkedSeed =
      tableResolved.status === "ok" && tableResolved.linked.length
        ? tableResolved.linked
        : lockedTable
          ? expandLinkedTables(pack, [lockedTable])
          : [];
    const tableConfidence =
      tableResolved.status === "ok" ? tableResolved.confidence : undefined;

    // 续答已按上一问合并成完整 AskState：不参与路由，直接编译
    const hybridRoute = isContinuation
      ? { path: "intent_compile" as const, reason: "ask_state_continuation" }
      : routeAnalyticsAsk({
          nl: lastUserText,
          pack,
          lockedTable,
          linkedTables: linkedSeed,
          tableConfidence,
          llmSqlEnabled: llmSqlEnabled(),
        });
    if (hybridRoute.path === "refuse") {
      return seal({
        status: "refuse",
        message: hybridRoute.message,
        error: hybridRoute.reason,
        timeEcho,
        packVersion: pack.version,
        semanticOk: false,
        semanticIssues: [hybridRoute.reason],
      });
    }
    const llmSqlTables = hybridRoute.path === "llm_sql" ? hybridRoute.tables : linkedSeed;
    const runLlmSqlPath = async (range: { start: string; end: string; echo?: string }) => {
      const echo = range.echo || `\u6309 ${range.start}\uff5e${range.end}`;
      const capRefuse = refuseUnsupportedOpsFromNl(lastUserText, pack);
      if (capRefuse) {
        return seal({
          status: "refuse",
          message: capRefuse.message,
          error: capRefuse.reason,
          timeEcho: echo,
          packVersion: pack.version,
          sqlSource: "llm_sql" as const,
          trust: "unverified" as const,
          linkedTables: llmSqlTables,
          semanticOk: false,
          semanticIssues: capRefuse.notes,
        });
      }
      const preChannels = extractChannelsFromNl(lastUserText, pack);
      const channelTable = lockedTable || llmSqlTables[0] || "";
      if (preChannels.length && channelTable && canApplyTextChannelFilter(pack, channelTable)) {
        try {
          const chGround = await groundChannelFilters({
            pack,
            filters: { channel: preChannels },
            table: channelTable,
            opts: { signal: opts?.signal },
          });
          if (chGround.status === "clarify") {
            const clarified = attachClarifyOptions(chGround.message, chGround.options, {
              multiSelect: true,
              slot: "channel",
            });
            return seal({
              status: "clarify",
              message: clarified.message,
              clarifySlot: "channel",
              clarifyOptions: clarified.clarifyOptions,
              timeEcho: echo,
              packVersion: pack.version,
              sqlSource: "llm_sql" as const,
              trust: "unverified" as const,
              linkedTables: llmSqlTables,
            });
          }
        } catch (e) {
          if (opts?.signal?.aborted || isAbortError(e)) throw e;
        }
      }
      let lastErr = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        const gen = await runSqlAgent({
          nl: lastUserText,
          pack,
          tables: llmSqlTables,
          time: { start: range.start, end: range.end },
          repair: lastErr || undefined,
          modelId: opts?.modelId,
          signal: opts?.signal,
          traceRunId: runId || undefined,
        });
        if (gen.status === "error") {
          // Infra/config/LLM failure: surface as error (not a bogus clarify the user cannot act on).
          return seal({
            status: "error",
            message: gen.message,
            error: gen.notes.join(",") || "llm_sql_agent_error",
            timeEcho: echo,
            packVersion: pack.version,
            sqlSource: "llm_sql" as const,
            trust: "unverified" as const,
            linkedTables: llmSqlTables,
          });
        }
        if (gen.status === "clarify") {
          return seal({
            status: "clarify",
            message: gen.clarify,
            clarifySlot: gen.clarifySlot,
            timeEcho: echo,
            packVersion: pack.version,
            sqlSource: "llm_sql" as const,
            trust: "unverified" as const,
            linkedTables: llmSqlTables,
          });
        }
        const sql = overlayResolvedDates(gen.sql, range.start, range.end);
        const anchors = missingNlAnchorsInSql(lastUserText, sql, pack);
        if (anchors.length) {
          lastErr = `SQL omitted user-mentioned filters: ${anchors.join("; ")}`;
          continue;
        }
        const claimed = [
          ...new Set(
            [
              ...llmSqlTables,
              ...(gen.schemaedTables || []),
              ...(gen.tables || []),
              ...extractFromTables(sql),
            ]
              .map((t) => bareTableName(t))
              .filter(Boolean),
          ),
        ];
        const got = getTableSchemas(pack, claimed, Math.max(claimed.length, 1));
        if (got.refused.length) {
          lastErr = `get_table_schema refused: ${got.refused.map((r) => `${r.name}:${r.reason}`).join("; ")}`;
          continue;
        }
        if (!got.ok.length) {
          lastErr = "get_table_schema required before FROM; no answerable table was schemed.";
          continue;
        }
        const ran = await runHybridSqls({
          pack,
          sqls: [sql],
          nl: lastUserText,
          time: range,
          table: lockedTable || gen.tables[0] || llmSqlTables[0],
          allowedTables: got.ok,
          signal: opts?.signal,
        });
        if (ran.ok) {
          const extra = await attachPostExec({
            message: `${echo}${ran.empty ? "\uff08\u65f6\u6bb5\u5185\u65e0\u5339\u914d\u884c\uff09" : ""}`,
            timeEcho: echo,
            sqls: ran.sqls,
            tables: ran.tables,
            empty: ran.empty,
            trust: "unverified",
          });
          if (!ran.empty && extra.verify?.verdict === "fail" && attempt < 2) {
            lastErr = `LLM verify fail: ${extra.verify.reason}`;
            rewriteRounds += 1;
            continue;
          }
          return seal({
            status: "ok",
            message: extra.message,
            timeEcho: echo,
            sqls: ran.sqls,
            tables: ran.tables,
            charts: ran.empty ? undefined : buildLocalChartsFromTables(ran.tables, { pack }),
            packVersion: pack.version,
            sqlSource: "llm_sql" as const,
            trust: "unverified" as const,
            linkedTables: llmSqlTables,
            semanticOk: extra.verify?.verdict !== "fail",
            semanticIssues: extra.verify?.verdict === "fail" ? [extra.verify.reason] : undefined,
            verify: extra.verify,
            insight: extra.insight,
            headline: extra.headline,
            caution: extra.caution,
            followups: extra.followups,
          });
        }
        lastErr = ran.issues.join("; ");
      }
      return seal({
        status: "refuse",
        message: lastErr || "\u6a21\u578b\u5199 SQL \u4e09\u6b21\u4ecd\u5931\u8d25",
        error: lastErr,
        timeEcho: echo,
        packVersion: pack.version,
        sqlSource: "llm_sql" as const,
        trust: "unverified" as const,
        linkedTables: llmSqlTables,
        semanticOk: false,
        semanticIssues: [lastErr || "llm_sql_exhausted"],
      });
    };

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
      prefsFacts: formatAnalyticsPrefsFacts(analyticsPrefs) || undefined,
      catalogFacts: [catalogFacts, `- resolved_table: ${lockedTable} (${tableResolved.reason})`]
        .filter(Boolean)
        .join("\n"),
      slotAnswersNote:
        opts?.slotAnswers && Object.keys(opts.slotAnswers).length
          ? `- slot_answers: ${Object.entries(opts.slotAnswers)
              .map(([k, vs]) => `${k}=${vs.join(",")}`)
              .join("; ")}`
          : undefined,
      verifiedQueryFact,
    };

    /** Gates read current turn + structure summary; never the full transcript. */
    const askScopeNl = (merged = "") =>
      [...new Set([lastUserText, merged].filter((s) => String(s || "").trim()))].join("\n");

    const loadAskLexicons = async (): Promise<Record<string, DimLexicon>> => {
      const out: Record<string, DimLexicon> = {};
      for (const field of coverageFields(pack)) {
        try {
          const loaded = await loadFieldLexicon(pack, field, {
            signal: opts?.signal,
            table: lockedTable,
          });
          if (loaded.ok) out[field] = loaded.lexicon;
        } catch (e) {
          if (opts?.signal?.aborted || isAbortError(e)) throw e;
        }
      }
      return out;
    };
    let askLexicons: Record<string, DimLexicon> | undefined;

    if (turnIntent.kind === "meta") {
      if (turnIntent.action === "clear_defaults") {
        saveAnalyticsPrefs(ownerKey, { version: 1, updatedAt: Date.now() });
        return seal({
          status: "ok",
          message: "\u5df2\u6e05\u9664\u9ed8\u8ba4\u504f\u597d\u3002",
          turnKind,
        });
      }
      if (turnIntent.action === "set_defaults") {
        const channels = Array.isArray(turnIntent.payload?.defaultChannels)
          ? (turnIntent.payload!.defaultChannels as string[])
          : [];
        if (channels.length) {
          saveAnalyticsPrefs(ownerKey, {
            version: 1,
            updatedAt: Date.now(),
            defaultChannels: channels,
            preferLayout: analyticsPrefs.preferLayout,
            recentMetricIds: analyticsPrefs.recentMetricIds,
          });
          return seal({
            status: "ok",
            message: `\u5df2\u8bb0\u4f4f\u9ed8\u8ba4\u6e20\u9053\uff1a${channels.join(", ")}`,
            turnKind,
          });
        }
        return seal({
          status: "clarify",
          message:
            "\u8bf7\u8bf4\u660e\u8981\u8bb0\u4f4f\u7684\u9ed8\u8ba4\u6e20\u9053\uff08\u4f8b\u5982\uff1a\u4ee5\u540e\u9ed8\u8ba4 IndiaA\uff09\u3002",
          turnKind,
        });
      }
      if (turnIntent.action === "disable_defaults_this_turn") {
        return seal({
          status: "ok",
          message:
            "\u672c\u8f6e\u5df2\u5ffd\u7565\u9ed8\u8ba4\u504f\u597d\u3002\u8bf7\u7ee7\u7eed\u63d0\u95ee\uff08\u6216\u5728\u95ee\u53e5\u524d\u52a0\u300c\u672c\u8f6e\u4e0d\u7528\u9ed8\u8ba4\u300d\uff09\u3002",
          turnKind,
        });
      }
    }

    const disableDefaultsThisTurn = (turnIntent.notes || []).includes("disable_defaults_this_turn");

    let preProbeSummary = "";

    if (!structured && conversation.length) {
      // JIT probe: only when this turn needs dim members. Structure itself always runs.
      if (needsDimensionProbe(lastUserText) && timeRange) {
        try {
          preProbeSummary = await probeDimensions(
            pack,
            timeRange,
            opts?.signal,
            neededProbeFields(lastUserText),
            lockedTable,
          );
        } catch (e) {
          if (opts?.signal?.aborted || isAbortError(e)) throw e;
        }
      }
      try {
        const once = await runStructureOnce({
          pack,
          messages: conversation,
          askContext,
          probeSummary: preProbeSummary,
          prevAskState: askStateForStructure,
          resolvedTable: lockedTable,
          modelId: opts?.modelId,
          signal: opts?.signal,
          traceRunId: runId || undefined,
        });
        structured = once.result;
        if (once.meta.modelId) usedModelId = once.meta.modelId;
        structureMeta = { mode: once.meta.mode, formatConstraint: once.meta.formatConstraint };
      } catch (e) {
        if (opts?.signal?.aborted || isAbortError(e)) throw e;
        structured = null;
      }

      if (!structured) {
        try {
          structured = await runSchemaAgent({
            pack,
            messages: conversation,
            askContext,
            probeSummary: preProbeSummary,
            prevAskState: askStateForStructure,
            resolvedTable: lockedTable,
            modelId: opts?.modelId,
            signal: opts?.signal,
            traceRunId: runId || undefined,
          });
          structureMeta = { mode: "tool_loop", formatConstraint: "prompt_parse" };
        } catch (e) {
          if (opts?.signal?.aborted || isAbortError(e)) throw e;
          try {
            const packed = packAnalyticsLlmContext({
              messages: conversation,
              prevAskState: askStateForStructure,
              probeSummary: preProbeSummary,
              facts: buildAskFactsBlock(askContext),
              phase: "structure",
            });
            const rawStruct = await llmText(
              buildStructureSystemPrompt(pack, {
                untrustedRule: UNTRUSTED_USER_CONTENT_RULE,
              }),
              buildStructureUserPrompt(renderAnalyticsLlmUserText(packed)),
              { ...llmOptsBase, spanName: "analytics.structure.fallback", spanMeta: { context: packed.usage } },
            );
            try {
              structured = parseStructureResponse(rawStruct, packed.transcript);
            } catch (parseErr) {
              // 模型 200 但给不出可用 schema（质量信号）：短冷却，下一次尝试自动换候选
              if (usedModelId) reportModelQualityFailure(usedModelId);
              throw parseErr;
            }
            structureMeta = { mode: "single_forward", formatConstraint: "prompt_parse" };
          } catch (e2) {
            if (opts?.signal?.aborted || isAbortError(e2)) throw e2;
            structured = null;
          }
        }
      }
    }

    if (structured && structured.status === "ok") {
      modelOkStructured = structured;
    }
    if (structured && timeResolved.ok) {
      structured = applyResolvedTime(structured, timeResolved);
    }

    const metaFields = {
      formatConstraint: structureMeta?.formatConstraint,
      structureMode: structureMeta?.mode,
    };

    if (hybridRoute.path === "llm_sql") {
      // A slot answer may have resolved everything except the metric (e.g. the user picked the
      // content languages while the metric wording is still ambiguous). Ask for the metric then —
      // falling through to free-text SQL generation would discard the slots already answered.
      if (
        currentAskState &&
        !currentAskState.metricId &&
        currentAskState.time?.start &&
        currentAskState.time?.end
      ) {
        const clarified = attachClarifyOptions(
          "\u8bf7\u786e\u8ba4\u6307\u6807\u53e3\u5f84\u3002\u8bf7\u56de\u590d\u4e0b\u65b9\u5e8f\u53f7\u3002",
          metricClarifyOptionsFromPack(pack),
          { multiSelect: false, slot: "metric" },
        );
        return seal({
          status: "clarify",
          message: clarified.message,
          clarifySlot: "metric",
          clarifyOptions: clarified.clarifyOptions,
          timeEcho: `\u6309 ${currentAskState.time.start}\uff5e${currentAskState.time.end}`,
          packVersion: pack.version,
          ...metaFields,
        });
      }
      const pathCRange =
        structured?.time?.start && structured?.time?.end
          ? {
              start: structured.time.start,
              end: structured.time.end,
              echo: `\u6309 ${structured.time.start}\uff5e${structured.time.end}`,
            }
          : timeRange;
      const structureWantsTime =
        structured?.status === "clarify" &&
        structured.clarifySlot === "time_range" &&
        !pathCRange;
      // ratio/retention metrics require channel+appVersion; the LLM-SQL path writes SQL via the
      // model and skips the deterministic compileAnalyticsIntent check, so a missing required
      // filter would slip through to an unchecked query. Re-check here and refuse with an
      // actionable message instead of running a partial SQL.
      if (
        pathCRange &&
        !structureWantsTime &&
        structured?.status === "ok" &&
        structured.metricId
      ) {
        const probeIntent = buildAnalyticsIntentFromStructure({
          structure: {
            time: structured.time || { start: pathCRange.start, end: pathCRange.end },
            filters: structured.filters || {},
            outputDims: structured.outputDims,
            layout: structured.layout,
            pivotDim: structured.pivotDim,
            metricId: structured.metricId,
            table: structured.table,
          },
          pack,
          fallbackNl: structured?.mergedNl || nlSafe || nlForResolve,
        });
        if (probeIntent.ok) {
          const probeCompiled = compileAnalyticsIntent(probeIntent.intent, pack);
          if (!probeCompiled.ok) {
            const mf = missingFilterRefuseMessage(probeCompiled.reason);
            if (mf) {
              return seal({
                status: "refuse",
                message: mf,
                timeEcho: pathCRange.echo,
                error: probeCompiled.reason,
                packVersion: pack.version,
                structuredFromConversation: true,
                semanticOk: false,
                semanticIssues: [probeCompiled.reason],
                ...metaFields,
              });
            }
          }
        }
      }
      if (pathCRange && !structureWantsTime) {
        return await runLlmSqlPath(pathCRange);
      }
    }

    const diagnosePack = packAnalyticsLlmContext({
      messages: conversation,
      prevAskState: currentAskState || prevAskState,
      facts: buildAskFactsBlock(askContext, { slim: true }),
      phase: "diagnose",
    });
    // If model clarified movieType/metric but NL already grounds them, promote to ok
    if (
      structured?.status === "clarify" &&
      (structured.clarifySlot === "movieType" || structured.clarifySlot === "metric") &&
      timeResolved.ok
    ) {
      try {
        const nlBlob = lastUserText || nlSafe || nlForResolve;
        const metricId = inferMetricIdFromNl(nlBlob, pack);
        const grounded = await groundRemappedFieldFromNl({
          pack,
          field: "movieType",
          nl: nlBlob,
          table: lockedTable,
          opts: { signal: opts?.signal },
        });
        const movieCodes =
          grounded.ok && grounded.codes.length
            ? grounded.codes
            : structured.partialFilters?.movieType;
        const canPromoteMetric = structured.clarifySlot === "metric" && Boolean(metricId);
        const canPromoteMovie =
          structured.clarifySlot === "movieType" &&
          Boolean(metricId) &&
          Boolean(movieCodes?.length);
        if ((canPromoteMetric || canPromoteMovie) && metricId) {
          const dims = inferOutputDimsFromNl(nlBlob, pack);
          const filters = { ...(structured.partialFilters || {}) };
          if (movieCodes?.length) filters.movieType = movieCodes;
          structured = {
            status: "ok",
            mergedNl: structured.mergedNl || nlSafe || nlForResolve,
            time: structured.time || {
              start: timeResolved.range.start,
              end: timeResolved.range.end,
            },
            filters,
            outputDims: dims.length ? dims : ["watch_date"],
            metricId,
            notes: [
              canPromoteMovie
                ? "nl_grounded_movieType_skip_clarify"
                : "nl_grounded_metric_skip_clarify",
            ],
          };
        }
      } catch (e) {
        if (opts?.signal?.aborted || isAbortError(e)) throw e;
      }
    }

    // Belt: drop spurious contentLang clarify when user never asked for languages
    const langScope = askScopeNl();
    if (
      structured?.status === "clarify" &&
      structured.clarifySlot === "contentLang" &&
      !userDemandsLangFilter(langScope) &&
      !impliesLangSetWithoutMembers(langScope) &&
      timeResolved.ok
    ) {
      const mid =
        currentAskState?.metricId ||
        prevAskState?.metricId ||
        inferMetricIdFromNl(lastUserText, pack) ||
        inferMetricIdFromNl(structured.mergedNl || "", pack);
      if (mid) {
        const dims = currentAskState?.outputDims?.length
          ? currentAskState.outputDims
          : prevAskState?.outputDims?.length
            ? prevAskState.outputDims
            : inferOutputDimsFromNl(lastUserText, pack);
        const filters = { ...(structured.partialFilters || {}) };
        delete filters.contentLang;
        structured = {
          status: "ok",
          mergedNl: structured.mergedNl || nlSafe || nlForResolve,
          time: structured.time || {
            start: timeResolved.range.start,
            end: timeResolved.range.end,
          },
          filters,
          outputDims: dims.length ? dims : ["watch_date"],
          metricId: mid,
          notes: ["pipeline_dropped_spurious_contentLang_clarify"],
        };
      }
    }

    const metricNlBlob = nlForMetricFamilyGate({
      lastUserText,
      fallbackNl: nlSafe || nlForResolve,
    });
    if (
      structured?.status === "ok" &&
      !opts?.slotAnswers?.metric &&
      !opts?.slotAnswers?.metricId
    ) {
      const familyClarify = ambiguousMetricFamilyClarify(metricNlBlob, pack);
      if (familyClarify) {
        if (structured.time?.start && structured.time?.end && structured.metricId) {
          sealWithNote("ask_state_sealed_on_metric_family_clarify");
        }
        structured = {
          status: "clarify",
          clarify: familyClarify.message,
          clarifySlot: "metric",
          mergedNl: structured.mergedNl || nlSafe || nlForResolve,
          time: structured.time,
          partialFilters: structured.filters,
        };
      }
    }

    if (structured?.status === "ok") {
      const fromAskState = (structured.notes || []).includes("from_ask_state");
      if (lockedTable && structured.table !== lockedTable && !fromAskState) {
        structured = {
          ...structured,
          table: lockedTable,
          notes: [...(structured.notes || []), `locked_table:${tableResolved.reason}:${lockedTable}`],
        };
      }
      if (lockedTable && !isOverlayTable(pack, lockedTable) && !fromAskState) {
        const nextMetric = coerceMetricForWarehouseTable(
          structured.metricId,
          lastUserText,
          pack,
          lockedTable,
        );
        if (nextMetric && nextMetric !== structured.metricId) {
          structured = {
            ...structured,
            metricId: nextMetric,
            notes: [...(structured.notes || []), `coerced_metric_for_warehouse_table:${nextMetric}`],
          };
        } else if (!structured.metricId && nextMetric) {
          structured = { ...structured, metricId: nextMetric };
        }
      }
      askLexicons = await loadAskLexicons();
      const coverageNl = askScopeNl(structured.mergedNl || "");
      const covered = applyCoverageGate({
        filters: structured.filters || {},
        nl: coverageNl,
        pack,
        lexicons: askLexicons,
        table: structured.table || lockedTable || answerableTableNamedInNl(lastUserText, pack),
      });
      if (covered.notes.length) {
        structured = {
          ...structured,
          filters: covered.filters,
          notes: [...(structured.notes || []), ...covered.notes],
        };
      }
    }

    if (structured?.status === "ok" && structured.metricId) {
      const prefsForApply = disableDefaultsThisTurn
        ? { version: 1 as const, updatedAt: 0 }
        : analyticsPrefs;
      const applied = applyAnalyticsPrefsDefaults({
        filters: structured.filters || {},
        layout: structured.layout,
        prefs: prefsForApply,
        nl: askScopeNl(structured.mergedNl || ""),
        outputDims: structured.outputDims,
        pack,
        table: structured.table || answerableTableNamedInNl(lastUserText, pack),
      });
      structured = {
        ...structured,
        filters: applied.filters,
        layout: applied.layout,
        notes: [
          ...(structured.notes || []),
          ...applied.notes,
          ...(disableDefaultsThisTurn ? ["disable_defaults_this_turn"] : []),
        ],
      };
    }

    /**
     * Shared partial-AskState seal for the clarify exits (generic structure clarify / contentLang).
     * Seals whenever a time range is known — the metric may still be pending and is meant to be
     * supplied by the user's next slot answer, so sealing is NOT gated on metricId.
     * Everything already resolved is carried forward, in priority order:
     * merged AskState(this turn) → model structure → carried AskState → NL inference.
     */
    const sealPartialAskState = (input: {
      note: string;
      /** Time already resolved for this clarify; falls back to resolved range → carried AskState. */
      time?: { start?: string; end?: string } | null;
      /** Filters layered last (e.g. the clarify's partialFilters). */
      extraFilters?: Record<string, string[]>;
      /** Force the language-pivot when this is a result_layout clarify with >1 language. */
      pivotLangWhenResultLayout?: boolean;
      mergedNl?: string;
    }): void => {
      const t =
        input.time?.start && input.time?.end
          ? input.time
          : structured?.time?.start && structured?.time?.end
            ? structured.time
            : timeResolved.ok
              ? { start: timeResolved.range.start, end: timeResolved.range.end }
              : prevAskState?.time;
      if (!t?.start || !t?.end) return;
      // Prefer the model-resolved metric over NL heuristics: inferMetricIdFromNl may not map the
      // exact wording the model used for the metric.
      const metricId =
        currentAskState?.metricId ||
        modelOkStructured?.metricId ||
        prevAskState?.metricId ||
        inferMetricIdFromNl(lastUserText, pack) ||
        inferMetricIdFromNl(structured?.mergedNl || "", pack);
      const dims =
        currentAskState?.outputDims?.length
          ? currentAskState.outputDims
          : modelOkStructured?.outputDims?.length
            ? modelOkStructured.outputDims
            : prevAskState?.outputDims?.length
              ? prevAskState.outputDims
              : inferOutputDimsFromNl(lastUserText, pack);
      const filters = {
        ...(currentAskState?.filters || {}),
        ...(modelOkStructured?.filters || {}),
        ...(input.extraFilters || {}),
      };
      const langs = filters.contentLang || [];
      currentAskState = buildAskStateFromStructure({
        structure: {
          status: "ok",
          mergedNl: input.mergedNl || structured?.mergedNl || nlSafe || nlForResolve,
          time: { start: t.start, end: t.end },
          table: modelOkStructured?.table || pack.tables?.[0]?.name,
          filters,
          outputDims: dims.length ? dims : ["watch_date"],
          metricId,
          pivotDim:
            input.pivotLangWhenResultLayout && langs.length > 1
              ? "contentLang"
              : prevAskState?.pivotDim,
          ops: prevAskState?.ops || ["base_aggregate"],
          notes: [input.note],
        },
        askId,
        packId: pack.id,
        packVersion: pack.version,
      });
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
        structured.clarifySlot && pack.probeDimensions.includes(structured.clarifySlot),
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
            [structured.clarifySlot],
            lockedTable,
          );
          if (!rangeEcho) rangeEcho = `\u6309 ${probeRange.start}\uff5e${probeRange.end}`;
        } catch (e) {
          if (opts?.signal?.aborted || isAbortError(e)) throw e;
        }
      }
      if (needProbe && probeSummaryForClarify) {
        options = parseProbeValuesForDim(probeSummaryForClarify, structured.clarifySlot, pack);
      }
      // Prefer Metabase lexicon labels for remapped dims (movieType 1=?? ?)
      if (structured.clarifySlot === "movieType") {
        try {
          const lex = await loadFieldLexicon(pack, "movieType", {
            signal: opts?.signal,
            table: lockedTable,
          });
          if (lex.ok && lex.lexicon.remapped) {
            options = lexiconClarifyOptions(lex.lexicon);
          }
        } catch (e) {
          if (opts?.signal?.aborted || isAbortError(e)) throw e;
        }
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
      // Recoverable clarify: seal partial Ask when time is known so the next free-text
      // follow-up (slotAnswers) can revise/complete it without losing context.
      sealPartialAskState({
        note: "ask_state_sealed_on_structure_clarify",
        extraFilters: structured.partialFilters,
        pivotLangWhenResultLayout: structured.clarifySlot === "result_layout",
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
      if (impliesLangSetWithoutMembers(lastUserText)) {
        let options: ClarifyOption[] | undefined;
        let probeSummaryForClarify = preProbeSummary;
        let rangeEcho: string | undefined;
        if (timeResolved.ok) {
          rangeEcho = timeResolved.range.echo;
          if (!probeSummaryForClarify) {
            try {
              probeSummaryForClarify = await probeDimensions(
                pack,
                timeResolved.range,
                opts?.signal,
                ["contentLang"],
                lockedTable,
              );
            } catch (e) {
              if (opts?.signal?.aborted || isAbortError(e)) throw e;
            }
          }
          options = parseProbeValuesForDim(probeSummaryForClarify, "contentLang", pack);
        }
        const clarified = attachClarifyOptions(
          "\u8bf7\u786e\u8ba4\u8981\u7edf\u8ba1\u7684\u5177\u4f53\u5185\u5bb9\u8bed\u8a00\uff08\u53ef\u591a\u9009\uff09\u3002\u53ef\u56de\u590d\u5e8f\u53f7\u6216\u8bed\u8a00\u7801\u3002",
          options,
          { multiSelect: true, slot: "contentLang" },
        );
        // Seal even when the metric is still pending (ambiguous metric + explicit language set):
        // the user answers contentLang next, and that merge must not lose the sealed context.
        sealPartialAskState({
          note: "ask_state_sealed_on_contentLang_clarify",
          time: timeResolved.ok ? timeResolved.range : null,
        });
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
          packed: diagnosePack,
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
    const allowedTables = allowedTableNames(pack).length
      ? allowedTableNames(pack)
      : pack.tables.map((t) => t.name);
    const dimColumns = pack.probeDimensions;

    const coercedMetric = coerceUnknownMetricId(structured.metricId, lastUserText, pack);
    const alignedMetric = alignMetricIdToNl(coercedMetric, lastUserText, pack);
    if (alignedMetric !== structured.metricId) {
      structured = {
        ...structured,
        metricId: alignedMetric,
        notes: [
          ...(structured.notes || []),
          alignedMetric !== coercedMetric
            ? `aligned_metric:${structured.metricId}->${alignedMetric}`
            : `coerced_metric:${structured.metricId}->${alignedMetric}`,
        ],
      };
    }
    // 闭包内不保留 narrowing，取 narrowed 快照供 verify / AskState 复用
    let okStruct = structured as StructuredAskOk;
    const metricVerifyForOk = (): Pick<
      AnalyticsAskResult,
      "semanticOk" | "semanticIssues" | "verify"
    > => {
      const metricAlign = checkMetricIntentAlignment({
        nl: lastUserText || "",
        metricId: okStruct.metricId || "",
        pack,
      });
      const alignedNote = (okStruct.notes || []).find((n) => n.startsWith("aligned_metric:"));
      return {
        semanticOk: !metricAlign,
        semanticIssues: metricAlign ? [metricAlign.reason] : [],
        verify: metricAlign
          ? metricAlign
          : alignedNote
            ? { verdict: "pass", codes: ["metric_aligned"], reason: alignedNote }
            : undefined,
      };
    };

    /**
     * Shared terminal stage for the multi-step plan path and the single-intent path.
     * Those two paths used to duplicate this ~90-line tail verbatim (delivery zero-fill →
     * named-dim reconcile → charts → post-exec verify → seal ok). Only the parameterized
     * bits below actually differ.
     */
    const deliverAndSeal = async (input: {
      /** SQLs reported in the result and fed to post-exec + named-dim reconcile */
      sqls: string[];
      tables: NonNullable<AnalyticsAskResult["tables"]>;
      message: string;
      /** table deciding whether channel dims apply */
      dimTable?: string;
      metricId?: string;
      layout?: "wide" | "long";
      /** post-delivery emptiness (plan path) vs pre-delivery emptiness (single path) */
      emptyOf: (deliveredTables: NonNullable<AnalyticsAskResult["tables"]>) => boolean;
      chartsOf?: (
        deliveredTables: NonNullable<AnalyticsAskResult["tables"]>,
      ) => AnalyticsAskResult["charts"] | undefined;
      /** when provided, a named-dim mismatch is explained by the caller's diagnose step */
      dimFailMessage?: (detail: string) => Promise<string>;
    }): Promise<AnalyticsAskResult> => {
      const delivered = finalizeDeliveredTables({
        tables: input.tables,
        message: input.message,
        askState: currentAskState,
        mode: pack.delivery?.missingChannel,
        nl: lastUserText,
        pack,
      });
      const skipChannelDim = !canApplyTextChannelFilter(pack, input.dimTable);
      const dimCheck = skipChannelDim
        ? {
            ok: true as const,
            missing: [] as string[],
            named: [] as string[],
            detail: "skip_non_text_channel",
          }
        : reconcileNamedDimensions({
            nl: lastUserText || nlForGuards,
            tables: delivered.tables,
            sqls: input.sqls,
            dimColumns,
            requiredInResults: currentAskState?.requested?.channels,
            requiredDim: "channel",
          });
      if (!dimCheck.ok) {
        const msg = input.dimFailMessage
          ? await input.dimFailMessage(dimCheck.detail)
          : dimCheck.detail;
        return seal({
          status: "refuse",
          message: msg,
          timeEcho: range.echo,
          sqls: input.sqls,
          tables: delivered.tables,
          sqlSource: "intent_compile",
          error: dimCheck.detail,
          packVersion: pack.version,
          structuredFromConversation: true,
          semanticOk: false,
          semanticIssues: [dimCheck.detail],
          ...metaFields,
        });
      }
      try {
        rememberAnalyticsSuccess({
          ownerKey,
          metricId: input.metricId,
          layout: input.layout,
        });
      } catch {
        /* prefs write is best-effort */
      }
      const charts = input.chartsOf?.(delivered.tables);
      const metricV = metricVerifyForOk();
      const extra = await attachPostExec({
        message: delivered.message,
        timeEcho: range.echo,
        sqls: input.sqls,
        tables: delivered.tables,
        metricId: input.metricId,
        empty: input.emptyOf(delivered.tables),
        trust: "trusted",
        priorVerify: metricV.verify,
      });
      return seal({
        status: "ok",
        message: extra.message,
        timeEcho: range.echo,
        sqls: input.sqls,
        tables: delivered.tables,
        charts: charts?.length ? charts : undefined,
        sqlSource: "intent_compile",
        packVersion: pack.version,
        structuredFromConversation: true,
        ...metricV,
        verify: extra.verify,
        insight: extra.insight,
        headline: extra.headline,
        caution: extra.caution,
        followups: extra.followups,
        ...metaFields,
      });
    };

    // Demand-Capability: refuse unsupported ops (no silent downgrade)
    const capGate = evaluateCapabilityGate({
      structure: structured,
      pack,
      nl: askScopeNl(nlForGuards),
    });
    if (capGate.status === "refuse") {
      return seal({
        status: "refuse",
        message: capGate.message,
        timeEcho: range.echo,
        error: capGate.reason,
        packVersion: pack.version,
        structuredFromConversation: true,
        semanticOk: false,
        semanticIssues: [capGate.reason, ...capGate.notes],
        ...metaFields,
      });
    }
    if (capGate.status === "clarify") {
      sealWithNote("ask_state_sealed_on_capability_clarify");
      return seal({
        status: "clarify",
        message: capGate.message,
        clarifySlot: "metric",
        timeEcho: range.echo,
        packVersion: pack.version,
        structuredFromConversation: true,
        semanticOk: false,
        semanticIssues: [capGate.reason, ...capGate.notes],
        ...metaFields,
      });
    }
    structured = {
      ...structured,
      ops: capGate.ops,
      notes: [...(structured.notes || []), ...capGate.notes],
    };
    okStruct = structured;

    // Metabase field lexicon: map labels to codes before Intent/SQL compile
    let filtersForIntent = structured.filters;
    const materializeAskState = (filters: typeof filtersForIntent) => {
      currentAskState = buildAskStateFromStructure({
        structure: { ...okStruct, filters },
        askId,
        packId: pack.id,
        packVersion: pack.version,
        defaultsApplied: {
          channels: (okStruct.notes || []).some((n) => n.startsWith("prefs_default_channel")),
          layout: (okStruct.notes || []).some((n) => n.startsWith("prefs_default_layout")),
        },
      });
      return currentAskState;
    };
    // Seal incomplete Ask early so channel/dim clarify can still revise next turn
    materializeAskState(filtersForIntent);

    try {
      const grounded = await resolvePackFilters({
        pack,
        filters: structured.filters,
        nl: nlForGuards,
        table: structured.table || lockedTable,
        opts: { signal: opts?.signal },
      });
      if (grounded.status === "clarify") {
        materializeAskState(filtersForIntent);
        const clarified = attachClarifyOptions(grounded.message, grounded.options, {
          multiSelect: true,
          slot: grounded.clarifySlot,
        });
        return seal({
          status: "clarify",
          message: clarified.message,
          clarifySlot: grounded.clarifySlot,
          clarifyOptions: clarified.clarifyOptions,
          timeEcho: range.echo,
          packVersion: pack.version,
          structuredFromConversation: true,
          ...metaFields,
        });
      }
      filtersForIntent = grounded.filters;
      if (grounded.notes.length) {
        structured = {
          ...structured,
          notes: [...(structured.notes || []), ...grounded.notes],
        };
      }
    } catch (e) {
      if (opts?.signal?.aborted || isAbortError(e)) throw e;
    }

    // Channel grounding hard gate: ghost codes -> clarify (AskState already sealed)
    const askTable = structured.table || answerableTableNamedInNl(nlForGuards, pack);
    if (!askTable || canApplyTextChannelFilter(pack, askTable)) {
      try {
        const chGround = await groundChannelFilters({
          pack,
          filters: filtersForIntent,
          table: askTable || lockedTable,
          opts: { signal: opts?.signal },
        });
        if (chGround.status === "clarify") {
          materializeAskState(filtersForIntent);
          const clarified = attachClarifyOptions(chGround.message, chGround.options, {
            multiSelect: true,
            slot: "channel",
          });
          return seal({
            status: "clarify",
            message: clarified.message,
            clarifySlot: "channel",
            clarifyOptions: clarified.clarifyOptions,
            timeEcho: range.echo,
            packVersion: pack.version,
            structuredFromConversation: true,
            ...metaFields,
          });
        }
        filtersForIntent = chGround.filters;
        if (chGround.notes.length) {
          structured = {
            ...structured,
            filters: filtersForIntent,
            notes: [...(structured.notes || []), ...chGround.notes],
          };
        }
      } catch (e) {
        if (opts?.signal?.aborted || isAbortError(e)) throw e;
      }
    }

    materializeAskState(filtersForIntent);

    if (structured.status === "ok" && !structured.plan) {
      if (!askLexicons) askLexicons = await loadAskLexicons();
      const card = resolvePlanCardinality({
        structure: { ...structured, filters: filtersForIntent },
        nl: askScopeNl(structured.mergedNl || ""),
        lexicons: askLexicons,
        pack,
      });
      if (card.kind === "clarify") {
        return seal({
          status: "clarify",
          message: card.message,
          timeEcho: range.echo,
          packVersion: pack.version,
          structuredFromConversation: true,
          semanticOk: false,
          semanticIssues: card.notes,
          ...metaFields,
        });
      }
      if (card.kind === "plan") {
        const entityField = entityCompareField(pack);
        const planEntities = entityField
          ? [...new Set(card.plan.steps.flatMap((s) => s.filters?.[entityField] || []))]
          : [];
        structured = {
          ...structured,
          plan: card.plan,
          filters: {
            ...filtersForIntent,
            ...(entityField && planEntities.length ? { [entityField]: planEntities } : {}),
          },
          notes: [...(structured.notes || []), ...card.notes],
        };
        filtersForIntent = structured.filters;
        materializeAskState(filtersForIntent);
      }
    }

    // Multi-intent plan: synthesize YoY/MoM when ops demand it; never step-1-only on growth
    const growthKind = growthKindToSynthesize(structured.ops, structured.plan);
    if (growthKind) {
      const syn =
        growthKind === "mom"
          ? synthesizeMomPlan({ ...structured, filters: filtersForIntent }, pack)
          : synthesizeYoyPlan({ ...structured, filters: filtersForIntent }, pack);
      if (syn) {
        structured = {
          ...structured,
          plan: syn,
          notes: [
            ...(structured.notes || []),
            growthKind === "mom" ? "synthesized_mom_plan" : "synthesized_yoy_plan",
          ],
        };
      } else {
        return seal({
          status: "refuse",
          message:
            "\u76f8\u5bf9\u589e\u957f\uff08\u540c\u6bd4/\u73af\u6bd4\uff09\u5df2\u8bc6\u522b\uff0c\u4f46\u65e0\u6cd5\u7ec4\u88c5\u53cc\u7a97\u53e3\u8ba1\u5212\uff08\u7f3a\u5c11\u6307\u6807\u6216\u65f6\u95f4\uff09\uff0c\u5df2\u62d2\u7edd\u4ee5\u514d\u7b54\u975e\u6240\u95ee\u3002",
          timeEcho: range.echo,
          error: "relative_growth_plan_synthesize_failed",
          packVersion: pack.version,
          structuredFromConversation: true,
          semanticOk: false,
          semanticIssues: ["relative_growth_plan_synthesize_failed"],
          ...metaFields,
        });
      }
    }
    if (structured.plan) {
      const planBase = {
        ...structured,
        filters: filtersForIntent,
      };
      const planGate = gateAskPlan(structured.plan, pack, planBase);
      if (planGate.status === "refuse") {
        return seal({
          status: "refuse",
          message: planGate.message,
          timeEcho: range.echo,
          error: planGate.reason,
          packVersion: pack.version,
          structuredFromConversation: true,
          semanticOk: false,
          semanticIssues: [planGate.reason, ...planGate.notes],
          ...metaFields,
        });
      }
      const mergeKind = structured.plan.merge.kind;
      if (mergeKind === "side_by_side" || mergeKind === "ratio") {
        const planCompiled = compileAskPlanSteps({
          plan: structured.plan,
          base: planBase,
          pack,
          fallbackNl: nlForGuards,
        });
        if (!planCompiled.ok) {
          return seal({
            status: "refuse",
            message: coverageRefuseMessage("plan_compile", planCompiled.reason),
            timeEcho: range.echo,
            error: planCompiled.reason,
            packVersion: pack.version,
            structuredFromConversation: true,
            semanticOk: false,
            semanticIssues: [planCompiled.reason],
            ...metaFields,
          });
        }
        // 同文本 SQL 去重（协议护栏）：模型 plan 可能产出多个完全相同的 step SQL，
        // 重复执行只会浪费查询并上屏 N 张相同表格（2026-09-14 实测 3 条相同 SQL/3 张重复表）。
        const normByStep = planCompiled.steps.map((s) => normalizeSqls([s.sql])[0]!);
        let sqls = normalizeSqls(planCompiled.steps.map((s) => s.sql));
        const uniqSqls = [...new Set(normByStep)];
        const lintTable = structured.table || lockedTable;
        const issues = collectIssues(
          nlForGuards,
          sqls,
          allowedTables,
          dimColumns,
          packTimeField(pack, lintTable),
          !canApplyTextChannelFilter(pack, lintTable),
          pack,
        );
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
          return seal({
            status: "clarify",
            message: detail,
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
        const execSqls = uniqSqls.map((s) => ensureMaxRows(s, maxRows));
        const results = await mapPool(
          execSqls,
          pack.guards.parallelism,
          (sql) => runNativeDataset(sql, dbId, { signal: opts?.signal, timeoutMs: pack.guards.queryTimeoutMs }),
          opts?.signal,
        );
        // 相同 SQL 的多个 step 共享同一份查询结果
        const resultBySql = new Map<string, DatasetResult>();
        uniqSqls.forEach((s, i) => resultBySql.set(s, results[i]!));
        const stepById = new Map(
          planCompiled.steps.map((s, i) => [s.id, { step: s, result: resultBySql.get(normByStep[i]!) ?? results[0]! }]),
        );
        const leftId = structured.plan.merge.left;
        const rightId = structured.plan.merge.right;
        if (results.every((r) => !r.ok)) {
          return seal({
            status: "error",
            message: results.map((r) => r.error).join("; "),
            timeEcho: range.echo,
            sqls: execSqls,
            error: results.map((r) => r.error).join("; "),
            packVersion: pack.version,
            structuredFromConversation: true,
            sqlSource: "intent_compile",
            semanticOk: false,
            ...metaFields,
          });
        }

        let tables: Array<{ title: string; cols: string[]; rows: unknown[][]; grain?: string }>;
        let message = range.echo;
        if (mergeKind === "ratio") {
          const left = stepById.get(leftId);
          const right = stepById.get(rightId);
          if (!left?.result.ok || !right?.result.ok) {
            return seal({
              status: "error",
              message:
                [left?.result.error, right?.result.error].filter(Boolean).join("; ") ||
                "relative growth step failed",
              timeEcho: range.echo,
              sqls: execSqls,
              error: "relative_growth_step_failed",
              packVersion: pack.version,
              structuredFromConversation: true,
              sqlSource: "intent_compile",
              semanticOk: false,
              ...metaFields,
            });
          }
          const priorOffset = String(right.step.timeOffset || left.step.timeOffset || "");
          const isMom =
            /mom/i.test(priorOffset) ||
            priorOffset.includes("\u73af\u6bd4") ||
            relativeGrowthKind(structured.ops) === "mom";
          const isYoy =
            /yoy/i.test(priorOffset) ||
            priorOffset.includes("\u540c\u6bd4") ||
            relativeGrowthKind(structured.ops) === "yoy";
          const spanDays =
            right.step.time.spanDays ||
            (structured.time
              ? inclusiveDaySpan(structured.time.start, structured.time.end)
              : undefined);
          const align = isMom
            ? spanDays
              ? { days: spanDays }
              : undefined
            : isYoy
              ? { years: 1 }
              : undefined;
          const priorLabel = isMom ? "prior_mom" : "prior_yoy";
          const merged = mergeRatioTables({
            left: { cols: left.result.cols, rows: left.result.rows },
            right: { cols: right.result.cols, rows: right.result.rows },
            align,
            leftLabel: "current",
            rightLabel: priorLabel,
          });
          const growthTitle = isMom
            ? "\u73af\u6bd4\u589e\u957f\u7387"
            : "\u540c\u6bd4\u589e\u957f\u7387";
          const currentTitle = `\u672c\u671f ${left.step.time.echo}`;
          const priorTitle = isMom
            ? `\u4e0a\u4e00\u7b49\u957f\u7a97 ${right.step.time.echo}`
            : `\u53bb\u5e74\u540c\u671f ${right.step.time.echo}`;
          message = `${range.echo}\uff1b${isMom ? "\u73af\u6bd4" : "\u540c\u6bd4"}\u57fa\u671f ${right.step.time.echo}\uff1bgrowth_rate=(\u672c\u671f-\u57fa\u671f)/\u57fa\u671f`;
          tables = [
            {
              title: growthTitle,
              cols: merged.cols,
              rows: merged.rows,
              grain: /watchDate|watch_date/i.test(merged.cols[0] || "") ? "day" : undefined,
            },
            {
              title: currentTitle,
              cols: left.result.cols,
              rows: left.result.rows,
            },
            {
              title: priorTitle,
              cols: right.result.cols,
              rows: right.result.rows,
            },
          ];
        } else {
          tables = execSqls.map((s, i) => ({
            title: execSqls.length > 1 ? `\u7ed3\u679c ${i + 1}` : "\u7ed3\u679c",
            cols: results[i]!.cols,
            rows: results[i]!.rows,
            grain: sqlHasDayGrain(s, pack) ? "day" : undefined,
          }));
        }

        return await deliverAndSeal({
          sqls: execSqls,
          tables,
          message,
          dimTable: structured.table || lockedTable,
          metricId: structured.metricId,
          layout: structured.layout,
          emptyOf: (t) => t.every((x) => !x.rows.length),
        });
      }
    }

    const intentBuilt = buildAnalyticsIntentFromStructure({
      structure: {
        time: structured.time!,
        filters: filtersForIntent,
        outputDims: structured.outputDims,
        layout: structured.layout,
        pivotDim: structured.pivotDim,
        metricId: structured.metricId!,
        table: structured.table,
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
          packed: diagnosePack,
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
        message: missingFilterRefuseMessage(detail) || coverageRefuseMessage("compile", detail),
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
    const lintTable = intentBuilt.intent.table || structured.table || lockedTable;
    const issues = collectIssues(
      nlForGuards,
      sqls,
      allowedTables,
      dimColumns,
      packTimeField(pack, lintTable),
      !canApplyTextChannelFilter(pack, lintTable),
      pack,
    );
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
          packed: diagnosePack,
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
          packed: diagnosePack,
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
      grain: sqlHasDayGrain(sqls[i]!, pack) ? "day" : undefined,
    }));
    const emptyNote = allEmpty(results)
      ? `\uff08${range.echo} \u65f6\u6bb5\u5185\u65e0\u5339\u914d\u884c\uff0c\u8bf7\u6838\u5bf9\u7b5b\u9009\u6761\u4ef6\uff09`
      : "";
    // Delivery zero-fill → dim reconcile → charts → post-exec verify → seal ok (shared helper)
    return await deliverAndSeal({
      sqls,
      tables,
      message: `${range.echo}${emptyNote}`,
      dimTable: intentBuilt.intent.table || structured.table || lockedTable,
      metricId: structured.metricId,
      layout: structured.layout,
      emptyOf: () => allEmpty(results),
      chartsOf: (deliveredTables) =>
        allEmpty(results) ? [] : buildLocalChartsFromTables(deliveredTables, { pack }),
      dimFailMessage: (detail) =>
        diagnoseFailure(
          {
            packed: diagnosePack,
            stage: "dim_reconcile",
            detail,
            intentJson: intentToJson(intentBuilt.intent),
            sqlPreview: sqls[0],
          },
          llmOptsBase,
        ),
    });
  } catch (e) {
    if (opts?.signal?.aborted || isAbortError(e)) {
      return seal({ status: "error", message: "\u5df2\u53d6\u6d88", error: "aborted" });
    }
    const raw = e instanceof Error ? e.message : String(e);
    const llmish = /llm_timeout|401008|gateway_error|quota|exhausted|"error"/.test(raw) || raw.trim().startsWith("{");
    return seal({
      status: "error",
      message: llmish ? sanitizeAnalyticsLlmError(e) : raw,
      error: raw,
    });
  } finally {
    closeRun();
  }
}
