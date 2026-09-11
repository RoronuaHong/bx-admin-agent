/**
 * Analytics ask pipeline:
 * conversation ? schema-agent (probe tools) ? Intent compile ? exec.
 * Intent/compile/lint/exec ??? LLM ????????????? SQL?
 */

import { config, listModels } from "../config.js";
import * as trace from "../trace.js";
import { getUpload, MAX_AT_ONCE } from "../uploads.js";
import { transcribeImage } from "../vision.js";
import { isAbortError, runNativeDataset } from "./metabase-client.js";
import { loadAnalyticsPack, type AnalyticsPack } from "./semantic-layer.js";
import {
  assertReadonlySingleSelect,
  assertTablesWhitelisted,
  lintSql,
  normalizeDistinctCount,
} from "./sql-guard.js";
import { resolveTimeRange } from "./time-resolve.js";
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
import { runSchemaAgent } from "./schema-agent.js";

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
        parts.push(`[附件文本]\n${item.text.trim()}`);
        usableCount += 1;
      } else {
        parts.push(`[附件文本为空] id=${id}`);
      }
    } else {
      parts.push(`[附件缺失] id=${id}（不存在或已过期）`);
    }
  }
  for (const id of (images || []).slice(0, MAX_AT_ONCE)) {
    signal?.throwIfAborted();
    const item = getUpload(id);
    if (!item || item.kind !== "image") {
      parts.push(`[图片缺失] id=${id}（不存在或已过期）`);
      continue;
    }
    try {
      const desc = await transcribeImage(item.base64, item.mediaType, signal);
      if (desc.trim()) {
        parts.push(`[图片内容]\n${desc.trim()}`);
        usableCount += 1;
      } else {
        parts.push(`[附件文本为空] id=${id}`);
      }
    } catch (e) {
      if (signal?.aborted || isAbortError(e)) throw e;
      parts.push(`[图片转录失败] ${e instanceof Error ? e.message : String(e)}`);
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
      const vals = res.rows
        .slice(0, 15)
        .map((r) => String(r[0] ?? ""))
        .filter(Boolean);
      lines.push(`${dim}: ${vals.join(", ") || "(empty)"}`);
    } catch (e) {
      if (signal?.aborted || isAbortError(e)) throw e;
      lines.push(`${dim}: PROBE_FAILED (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return lines.join("\n");
}

function parseProbeValuesForDim(
  probeSummary: string,
  dimField: string,
): Array<{ id: string; label: string }> {
  const line = probeSummary
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().startsWith(dimField.toLowerCase() + ":"));
  if (!line || /PROBE_FAILED/i.test(line)) return [];
  const raw = line.slice(line.indexOf(":") + 1).trim();
  if (!raw || raw === "(empty)") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 15)
    .map((v) => ({ id: v, label: v }));
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
      assertReadonlySingleSelect(sql);
    } catch (e) {
      issues.push(e instanceof Error ? e.message : String(e));
    }
    try {
      assertTablesWhitelisted(sql, allowedTables);
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
  const limit = Math.max(1, concurrency);
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      signal?.throwIfAborted();
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function allEmpty(results: DatasetResult[]): boolean {
  return results.length > 0 && results.every((r) => r.ok && r.rows.length === 0);
}

/** Intent/compile/lint/exec ???LLM ????????? SQL? */
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
  const system = [
    "You are an analytics diagnose assistant for a Metabase analytics agent.",
    "Explain in concise Chinese: why the ask cannot complete, and what the user should clarify next.",
    "ABSOLUTELY FORBIDDEN: do not write SQL, do not invent tables/schemas, do not propose CREATE/SELECT code blocks.",
    "If languages are missing, ask for contentLang codes. If wide/long is missing, ask result_layout.",
    "Plain text only; no markdown headings.",
  ].join(" ");
  const user = [
    `Failure stage: ${input.stage}`,
    `Technical detail: ${input.detail}`,
    input.structuredJson ? `Structured JSON:\n${input.structuredJson}` : "",
    input.intentJson ? `Intent:\n${input.intentJson}` : "",
    input.sqlPreview ? `SQL preview:\n${input.sqlPreview.slice(0, 2000)}` : "",
    "Conversation:\n" + input.transcript,
  ]
    .filter(Boolean)
    .join("\n\n");
  try {
    const text = (await llmText(system, user, { ...opts, spanName: "analytics.diagnose" })).trim();
    if (text && !/```sql|SELECT\s+\w+/i.test(text)) return text;
  } catch {
    /* fall through */
  }
  return `当前无法完成问数（${input.stage}）：${input.detail}。请补充更明确的时间、渠道、指标或筛选条件后再试。`;
}

/**
 * NL ?????? schema-agent?? Intent compile ? lint ? exec?
 * Trace agentId=analytics; ownerKey analytics:anonymous.
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
    /** ??????????????? schema-agent? */
    slotAnswers?: Record<string, string[]>;
    /** ?????????????? */
    messages?: ConversationTurn[];
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
    if (!nl.trim() && attachmentReq > 0 && usableCount === 0) {
      return seal({
        status: "clarify",
        message: "附件已过期或无法识别，请重新上传，或直接输入问数内容。",
      });
    }
    const questionForLlm = [nl.trim(), attachmentCtx].filter(Boolean).join("\n\n");
    const nlForResolve = nl.trim() || (usableCount > 0 ? attachmentCtx : "");
    if (!nlForResolve) {
      return seal({ status: "clarify", message: "请输入问数内容，或附带可识别的文本/图片。" });
    }

    runId = trace.beginRun({
      userText: nlForResolve.slice(0, 2000),
      model: opts?.modelId,
      agentId: "analytics",
      ownerKey: "analytics:anonymous",
    });
    const llmOptsBase: LlmOpts = { modelId: opts?.modelId, signal: opts?.signal, traceRunId: runId };

    const pack = loadAnalyticsPack(opts?.packId || "watch-detail");
    packVersion = pack.version;
    const clock = opts?.clock || new Date();
    const tz = pack.time.businessTimezone || config.metabase.businessTimezone;
    const clockIso = clock.toISOString().slice(0, 10);

    let conversation: ConversationTurn[] = (opts?.messages || [])
      .map((m) => ({
        role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        text: String(m.text || "").trim(),
      }))
      .filter((m) => m.text);
    if (!conversation.length && nlForResolve) {
      conversation = [{ role: "user", text: nlForResolve }];
    }
    const last = conversation[conversation.length - 1];
    if (nl.trim() && (!last || last.role !== "user" || last.text !== nl.trim())) {
      conversation = [...conversation, { role: "user", text: nl.trim() }];
    }
    if (opts?.slotAnswers && Object.keys(opts.slotAnswers).length) {
      const parts = Object.entries(opts.slotAnswers).map(([k, vs]) => `${k}=${vs.join(",")}`);
      conversation = [...conversation, { role: "user", text: `澄清选择：${parts.join("；")}` }];
    }

    const userTurns = conversation.filter((m) => m.role === "user").length;
    if (userTurns <= 1) {
      const early = resolveTimeRange(nlForResolve, clock, tz);
      if (!early.ok) {
        return seal({ status: "clarify", message: early.clarify, clarifySlot: "time_range" });
      }
    }

    let structured: StructuredAskResult | null = null;
    if (conversation.length) {
      try {
        structured = await runSchemaAgent({
          pack,
          messages: conversation,
          clockIsoDate: clockIso,
          modelId: opts?.modelId,
          signal: opts?.signal,
          traceRunId: runId || undefined,
        });
      } catch (e) {
        if (opts?.signal?.aborted || isAbortError(e)) throw e;
        try {
          const rawStruct = await llmText(
            buildStructureSystemPrompt(pack, clockIso),
            buildStructureUserPrompt(conversation),
            { ...llmOptsBase, spanName: "analytics.structure.fallback" },
          );
          structured = parseStructureResponse(
            rawStruct,
            formatConversationTranscript(conversation),
          );
        } catch (e2) {
          if (opts?.signal?.aborted || isAbortError(e2)) throw e2;
          structured = null;
        }
      }
    }

    const transcript = formatConversationTranscript(conversation);

    if (structured?.status === "clarify") {
      let rangeEcho: string | undefined;
      let probeSummaryForClarify = "";
      let options: Array<{ id: string; label: string }> | undefined;
      if (structured.time?.start && structured.time?.end) {
        rangeEcho = `按 ${structured.time.start}～${structured.time.end}`;
      }
      const needProbe =
        structured.clarifySlot === "contentLang" ||
        structured.clarifySlot === "movieType" ||
        pack.probeDimensions.includes(structured.clarifySlot);
      // contentLang ???? schema ?????????????
      let probeRange = structured.time;
      if (needProbe && !(probeRange?.start && probeRange?.end)) {
        const resolved = resolveTimeRange(nlForResolve, clock, tz);
        if (resolved.ok) probeRange = { start: resolved.range.start, end: resolved.range.end };
      }
      if (needProbe && probeRange?.start && probeRange?.end) {
        try {
          probeSummaryForClarify = await probeDimensions(
            pack,
            { start: probeRange.start, end: probeRange.end },
            opts?.signal,
          );
          options = parseProbeValuesForDim(probeSummaryForClarify, structured.clarifySlot);
          if (!rangeEcho) rangeEcho = `按 ${probeRange.start}～${probeRange.end}`;
        } catch (e) {
          if (opts?.signal?.aborted || isAbortError(e)) throw e;
        }
      }
      const optionHint =
        options && options.length
          ? `\n候选示例：${options
              .slice(0, 12)
              .map((o) => o.label)
              .join("、")}`
          : "";
      return seal({
        status: "clarify",
        message: `${structured.clarify}${optionHint}`,
        timeEcho: rangeEcho,
        clarifySlot: structured.clarifySlot,
        clarifyOptions: options,
        probeSummary: probeSummaryForClarify || undefined,
        packVersion: pack.version,
        structuredFromConversation: true,
      });
    }

    if (!(structured?.status === "ok" && structured.metricId && structured.time)) {
      // schema-agent ??????N???????????????? LLM ?? SQL
      if (impliesLangSetWithoutMembers(transcript)) {
        let options: Array<{ id: string; label: string }> | undefined;
        let probeSummaryForClarify = "";
        let rangeEcho: string | undefined;
        const resolved = resolveTimeRange(nlForResolve, clock, tz);
        if (resolved.ok) {
          rangeEcho = resolved.range.echo;
          try {
            probeSummaryForClarify = await probeDimensions(pack, resolved.range, opts?.signal);
            options = parseProbeValuesForDim(probeSummaryForClarify, "contentLang");
          } catch (e) {
            if (opts?.signal?.aborted || isAbortError(e)) throw e;
          }
        }
        const optionHint =
          options && options.length
            ? `\n候选示例：${options
                .slice(0, 12)
                .map((o) => o.label)
                .join("?")}`
            : "";
        return seal({
          status: "clarify",
          message: `请确认要统计的具体内容语言列表（可多选）。请直接列出语言码（如 te-IN、ta-IN）。${optionHint}`,
          timeEcho: rangeEcho,
          clarifySlot: "contentLang",
          clarifyOptions: options,
          probeSummary: probeSummaryForClarify || undefined,
          packVersion: pack.version,
        });
      }

      const msg = await diagnoseFailure(
        {
          transcript,
          stage: "structure",
          detail: "未能从对话得到完整结构化 schema（时间/指标/过滤）",
          structuredJson: structured ? JSON.stringify(structured) : undefined,
        },
        llmOptsBase,
      );
      return seal({
        status: "clarify",
        message: msg,
        packVersion: pack.version,
      });
    }

    const range = {
      start: structured.time.start,
      end: structured.time.end,
      echo: `按 ${structured.time.start}～${structured.time.end}`,
    };
    const nlForGuards = structured.mergedNl || nl.trim() || nlForResolve;
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
      const msg = await diagnoseFailure(
        {
          transcript,
          stage: "intent",
          detail: intentBuilt.reason,
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
      });
    }

    const compiled = compileAnalyticsIntent(intentBuilt.intent, pack);
    if (!compiled.ok) {
      const msg = await diagnoseFailure(
        {
          transcript,
          stage: "compile",
          detail: compiled.reason,
          structuredJson: JSON.stringify(structured),
          intentJson: intentToJson(intentBuilt.intent),
        },
        llmOptsBase,
      );
      return seal({
        status: "clarify",
        message: msg,
        timeEcho: range.echo,
        packVersion: pack.version,
        structuredFromConversation: true,
      });
    }

    let sqls = normalizeSqls([compiled.sql]);
    const issues = collectIssues(nlForGuards, sqls, allowedTables, dimColumns);
    guardIssues = issues;
    if (issues.length) {
      const msg = await diagnoseFailure(
        {
          transcript,
          stage: "lint",
          detail: issues.join("; "),
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
        error: issues.join(", "),
        packVersion: pack.version,
        structuredFromConversation: true,
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
        (sql) => runNativeDataset(sql, dbId, { signal: opts?.signal }),
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
      });
    }

    const tables = results.map((r, i) => ({
      title: sqls.length > 1 ? `查询 ${i + 1}` : "结果",
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
      });
    }

    const emptyNote = allEmpty(results)
      ? `（${range.echo} 无数据行；请确认年份或筛选条件）`
      : "";
    const charts = allEmpty(results) ? [] : buildLocalChartsFromTables(tables);
    return seal({
      status: "ok",
      message: `${range.echo}${emptyNote}`,
      timeEcho: range.echo,
      sqls,
      tables,
      charts: charts.length ? charts : undefined,
      verifySkipped: "intent_compile",
      sqlSource: "intent_compile",
      packVersion: pack.version,
      structuredFromConversation: true,
    });
  } catch (e) {
    if (opts?.signal?.aborted || isAbortError(e)) {
      return seal({ status: "error", message: "已取消", error: "aborted" });
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
