import { config, listModels } from "../config.js";
import * as trace from "../trace.js";
import { getUpload, MAX_AT_ONCE } from "../uploads.js";
import { transcribeImage } from "../vision.js";
import { isAbortError, runMetabaseQuestion, runNativeDataset } from "./metabase-client.js";
import { loadAnalyticsPack, type AnalyticsPack } from "./semantic-layer.js";
import {
  assertReadonlySingleSelect,
  assertTablesWhitelisted,
  lintSql,
  normalizeDistinctCount,
} from "./sql-guard.js";
import { resolveTimeRange } from "./time-resolve.js";
import type { AnalyticsAskResult, DatasetResult } from "./types.js";
import { splitSqls, verifyGrainDay, verifyMultiQueryIntent, verifyNamedChannel } from "./verify.js";
import {
  buildLlmVerifyPrompt,
  buildLlmVerifyRetryPrompt,
  llmVerifyEnabled,
  parseLlmVerifyResponse,
  resolveUnclearVerify,
  sampleTablesForVerify,
  type LlmVerifyResult,
} from "./llm-verify.js";
import { reconcileNamedDimensions } from "./dim-reconcile.js";
import { deriveFailureClass, newAskId, recordAskLedger } from "./audit-ledger.js";
import { buildLocalChartsFromTables } from "./local-chart.js";
import {
  applyBindingSqlTemplate,
  buildBindingParameters,
  matchQuestionBinding,
} from "./question-binding.js";
import {
  formatGroundedHint,
  parseProbeValuesForDim,
  runAmbiguityGate,
} from "./ambiguity-gate.js";
import { buildAnalyticsIntent, intentToJson } from "./intent.js";
import { compileAnalyticsIntent } from "./sql-compile.js";

type LlmOpts = { modelId?: string; signal?: AbortSignal; traceRunId?: string; spanName?: string };

/** Expand uploaded text/images into LLM-readable context (reuses chat upload store + OCR). */
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
        parts.push(`[图片转录为空] id=${id}`);
      }
    } catch (e) {
      if (signal?.aborted || isAbortError(e)) throw e;
      parts.push(`[图片转录失败] ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { context: parts.join("\n\n"), usableCount };
}

/** Prefer explicit modelId; else glm5turbo → dsflash → other flash → first. */
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

function extractSqlBlock(text: string): string {
  const trimmed = text.trim();
  if (/^REFUSE\b/i.test(trimmed)) return "REFUSE";
  const fence = trimmed.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  return trimmed;
}

function parseSqlsFromLlm(text: string): string[] | "REFUSE" {
  const block = extractSqlBlock(text);
  if (block === "REFUSE" || /^REFUSE\b/i.test(block)) return "REFUSE";
  const parts = splitSqls(block);
  return parts.length ? parts : block ? [block] : [];
}

function buildStructuralHint(
  pack: AnalyticsPack,
  range: { start: string; end: string },
): string {
  const table = pack.tables[0];
  const fields = table?.fields.join(", ") ?? "";
  const movieTypes = pack.guards.defaultMovieTypes.join(", ");
  const distinctFn = config.metabase.distinctCountFn;
  return [
    "You generate ClickHouse SQL for analytics. STRUCTURAL rules only — no synonym maps.",
    `Only use table ${table?.name ?? "elt_watch_detail"} with fields: ${fields}.`,
    "Date filter: use toDate(lastWatchTime) (never lastWatchTime = 'YYYY-MM-DD').",
    `Distinct count: use ${distinctFn}(...), never uniqExact unless that is the configured default.`,
    `Always include movieType IN (${movieTypes}) unless the user explicitly overrides.`,
    `Resolved time window (inclusive UX dates): start=${range.start} end=${range.end}.`,
    "Inject these ISO dates into WHERE; do not invent other years.",
    "If multiple SELECT statements are needed (different grain/channel), separate them with a line containing only ---.",
    "When the user says 各自 / 同时 / 分别 for two or more named entities, you MUST emit ≥2 SELECT statements separated by --- (do not collapse into one query).",
    "If Grounded slots specify WIDE vs LONG layout, honor that structural shape; do not invent an alternate grain.",
    "Each statement must be a single read-only SELECT (or WITH … SELECT). No semicolon-separated multi-statements.",
    "Output only SQL (optionally fenced). If the question cannot be answered safely, reply REFUSE.",
  ].join("\n");
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

async function rewriteSqls(
  system: string,
  nl: string,
  sqls: string[],
  feedback: string,
  llmOpts?: LlmOpts,
): Promise<string[] | "REFUSE"> {
  const user = [
    `User question: ${nl}`,
    `Prior SQL(s):\n${sqls.join("\n---\n")}`,
    `Issue codes (fix these only; do not invent unconstrained EX rewrites): ${feedback}`,
    "Return corrected SQL only (or REFUSE).",
  ].join("\n\n");
  const text = await llmText(system, user, llmOpts);
  return parseSqlsFromLlm(text);
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

/**
 * NL → time resolve → Ambiguity Gate → Intent compile (优先) / Binding / LLM SQL → lint → exec.
 * 写入门户 Trace（agentId=analytics）；问数鉴权独立，ownerKey 用 analytics:anonymous。
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
    /** 澄清回合回填，如 { contentLang: ["te-IN","ta-IN","ml-IN"] } */
    slotAnswers?: Record<string, string[]>;
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
    recordAskLedger({
      askId,
      nl: nl.trim().slice(0, 4000),
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
      message: out.message?.slice(0, 500),
      error: out.error?.slice(0, 500),
    });
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
    const resolved = resolveTimeRange(nlForResolve, clock, tz);
    if (!resolved.ok) {
      return seal({ status: "clarify", message: resolved.clarify });
    }

    const { range } = resolved;
    // Entity / grain / multi-query guards use user NL only (attachments can pollute names).
    const nlForGuards = nl.trim() || nlForResolve;

    // Ambiguity Gate：filter_set 未接地 / 指标口径未选 → 反问（禁止执行）
    let gate = runAmbiguityGate(nlForGuards, pack, { slotAnswers: opts?.slotAnswers });
    if (!gate.ok) {
      let options = gate.options?.length ? gate.options : undefined;
      let probeSummaryForClarify = "";
      const dimDef = pack.enumDimensions?.find((d) => d.id === gate.slot);
      const needProbe =
        !options?.length &&
        (dimDef?.domain === "probe" ||
          gate.slot === "contentLang" ||
          pack.probeDimensions.includes(gate.slot));
      if (needProbe) {
        try {
          probeSummaryForClarify = await probeDimensions(pack, range, opts?.signal);
          const field = dimDef?.field || gate.slot;
          options = parseProbeValuesForDim(probeSummaryForClarify, field);
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
        message: `${gate.clarify}${optionHint}`,
        timeEcho: range.echo,
        clarifySlot: gate.slot,
        clarifyOptions: options,
        probeSummary: probeSummaryForClarify || undefined,
        packVersion: pack.version,
      });
    }

    const groundedHint = formatGroundedHint(gate);
    const system = buildStructuralHint(pack, range);
    const allowedTables = pack.tables.map((t) => t.name);
    const dimColumns = pack.probeDimensions;
    const llmOpts: LlmOpts = { ...llmOptsBase, spanName: "analytics.sql" };

    // Task 2：questionBinding 加速 — 未改写则跳过 LLM SQL / LLM 校对
    const bindingHit = matchQuestionBinding(pack.questionBindings, nlForGuards);
    if (bindingHit) {
      opts?.signal?.throwIfAborted();
      let bindingSql: string | undefined;
      let bindingResult: DatasetResult;
      const bindHandle = trace.span(runId, "tool", "metabase.question-binding", {
        worker: "analytics",
      });
      try {
        if (bindingHit.questionId) {
          bindingResult = await runMetabaseQuestion(
            bindingHit.questionId,
            buildBindingParameters(bindingHit, range),
            { signal: opts?.signal },
          );
        } else {
          bindingSql = applyBindingSqlTemplate(bindingHit.sqlTemplate || "", range);
          bindingSql = normalizeDistinctCount(bindingSql, config.metabase.distinctCountFn);
          assertReadonlySingleSelect(bindingSql);
          assertTablesWhitelisted(bindingSql, allowedTables);
          bindingSql = ensureMaxRows(bindingSql, pack.guards.maxRows);
          bindingResult = await runNativeDataset(bindingSql, pack.datasource.metabaseDatabaseId, {
            signal: opts?.signal,
          });
        }
        bindHandle.end({
          status: bindingResult.ok ? "ok" : "error",
          meta: { bindingId: bindingHit.id, questionId: bindingHit.questionId },
          error: bindingResult.ok ? undefined : bindingResult.error,
        });
      } catch (e) {
        bindHandle.end({ status: "error", error: e instanceof Error ? e.message : String(e) });
        throw e;
      }

      if (!bindingResult.ok) {
        // Fall through to LLM path when binding exec fails
      } else {
        const tables = [
          {
            title: "结果",
            cols: bindingResult.cols,
            rows: bindingResult.rows,
            grain: bindingSql && /toDate\s*\(\s*lastWatchTime\s*\)/i.test(bindingSql) ? "day" : undefined,
          },
        ];
        const charts = allEmpty([bindingResult]) ? [] : buildLocalChartsFromTables(tables);
        return seal({
          status: "ok",
          message: range.echo,
          timeEcho: range.echo,
          sqls: bindingSql ? [bindingSql] : undefined,
          tables,
          charts: charts.length ? charts : undefined,
          verifySkipped: "question_binding",
          sqlSource: "question_binding",
          questionBinding: {
            id: bindingHit.id,
            questionId: bindingHit.questionId,
            rewritten: false,
          },
          modelId: opts?.modelId,
          packVersion: pack.version,
        });
      }
    }

    // Intent → 确定性 SQL（语义层编译优先；失败再 LLM）
    const intentBuilt = buildAnalyticsIntent({
      nl: nlForGuards,
      range: { start: range.start, end: range.end },
      gate,
      pack,
    });
    if (intentBuilt.ok) {
      const compiled = compileAnalyticsIntent(intentBuilt.intent, pack);
      if (compiled.ok) {
        let sqls = normalizeSqls([compiled.sql]);
        let issues = collectIssues(nlForGuards, sqls, allowedTables, dimColumns);
        guardIssues = issues;
        if (!issues.length) {
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
            // 编译 SQL 执行失败 → 回落 LLM
          } else {
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
              return seal({
                status: "refuse",
                message: `维对账未通过：结果中缺少点名维度 ${dimCheck.missing.join("、")}，已停止交付以免假对照。`,
                timeEcho: range.echo,
                sqls,
                tables,
                sqlSource: "intent_compile",
                error: dimCheck.detail,
                modelId: opts?.modelId,
                packVersion: pack.version,
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
              modelId: opts?.modelId,
              packVersion: pack.version,
            });
          }
        }
        // lint 失败 → LLM 兜底
      }
    }

    let probeSummary = "";
    try {
      probeSummary = await probeDimensions(pack, range, opts?.signal);
    } catch (e) {
      if (opts?.signal?.aborted || isAbortError(e)) throw e;
      probeSummary = "PROBE_FAILED";
    }
    opts?.signal?.throwIfAborted();

    const intentHint =
      intentBuilt.ok
        ? `Structured Intent (prefer honor; compile failed or skipped):\n${intentToJson(intentBuilt.intent)}`
        : intentBuilt.reason
          ? `Intent not compiled (${intentBuilt.reason}); use Grounded slots + probe.`
          : "";

    const genUser = [
      `User question: ${questionForLlm}`,
      `Resolved time: ${range.start} .. ${range.end} (${range.echo})`,
      groundedHint || "",
      intentHint,
      probeSummary ? `Probe Top-N DISTINCT:\n${probeSummary}` : "",
      "Generate SQL now.",
    ]
      .filter(Boolean)
      .join("\n\n");

    const raw = await llmText(system, genUser, llmOpts);
    const parsed = parseSqlsFromLlm(raw);
    if (parsed === "REFUSE") {
      return seal({
        status: "refuse",
        message: "无法安全生成查询。",
        timeEcho: range.echo,
        probeSummary: probeSummary || undefined,
      });
    }

    let sqls = normalizeSqls(parsed);
    let issues = collectIssues(nlForGuards, sqls, allowedTables, dimColumns);
    guardIssues = issues;
    let rounds = 0;
    while (issues.length && rounds < pack.guards.maxRewriteRounds) {
      rounds++;
      rewriteRounds = rounds;
      const rewritten = await rewriteSqls(system, questionForLlm, sqls, issues.join(", "), {
        ...llmOpts,
        spanName: "analytics.sql.rewrite",
      });
      if (rewritten === "REFUSE") {
        return seal({
          status: "refuse",
          message: "重写后仍无法安全生成查询。",
          timeEcho: range.echo,
          sqls,
          probeSummary: probeSummary || undefined,
        });
      }
      sqls = normalizeSqls(rewritten);
      issues = collectIssues(nlForGuards, sqls, allowedTables, dimColumns);
      guardIssues = issues;
    }
    if (issues.length) {
      return seal({
        status: "error",
        message: `SQL 校验未通过: ${issues.join(", ")}`,
        timeEcho: range.echo,
        sqls,
        probeSummary: probeSummary || undefined,
        error: issues.join(", "),
      });
    }

    opts?.signal?.throwIfAborted();
    const dbId = pack.datasource.metabaseDatabaseId;
    const maxRows = pack.guards.maxRows;
    let execSqls = sqls.map((s) => ensureMaxRows(s, maxRows));
    const execHandle = trace.span(runId, "tool", "metabase.dataset", { worker: "analytics" });
    let results: DatasetResult[];
    try {
      results = await mapPool(
        execSqls,
        pack.guards.parallelism,
        (sql) => runNativeDataset(sql, dbId, { signal: opts?.signal }),
        opts?.signal,
      );
      execHandle.end({
        status: results.every((r) => r.ok) ? "ok" : "error",
        meta: { statements: execSqls.length },
      });
    } catch (e) {
      execHandle.end({ status: "error", error: e instanceof Error ? e.message : String(e) });
      throw e;
    }

    if (allEmpty(results)) {
      opts?.signal?.throwIfAborted();
      const yearHint = `All queries returned empty rows for ${range.start}..${range.end}. Consider year mismatch; keep resolved window unless clearly wrong. Rewrite SQL once.`;
      const rewritten = await rewriteSqls(system, questionForLlm, sqls, `empty_result; ${yearHint}`, {
        ...llmOpts,
        spanName: "analytics.sql.empty-rewrite",
      });
      if (rewritten !== "REFUSE" && rewritten.length) {
        rounds++;
        rewriteRounds = rounds;
        sqls = normalizeSqls(rewritten);
        const emptyIssues = collectIssues(nlForGuards, sqls, allowedTables, dimColumns);
        guardIssues = emptyIssues;
        if (!emptyIssues.length) {
          execSqls = sqls.map((s) => ensureMaxRows(s, maxRows));
          const retryHandle = trace.span(runId, "tool", "metabase.dataset.retry", { worker: "analytics" });
          try {
            results = await mapPool(
              execSqls,
              pack.guards.parallelism,
              (sql) => runNativeDataset(sql, dbId, { signal: opts?.signal }),
              opts?.signal,
            );
            retryHandle.end({
              status: results.every((r) => r.ok) ? "ok" : "error",
              meta: { statements: execSqls.length },
            });
          } catch (e) {
            retryHandle.end({ status: "error", error: e instanceof Error ? e.message : String(e) });
            throw e;
          }
        }
      }
    }

    const execErrors = results.filter((r) => !r.ok);
    if (execErrors.length === results.length && results.length > 0) {
      return seal({
        status: "error",
        message: `执行失败: ${execErrors.map((r) => r.error).join("; ")}`,
        timeEcho: range.echo,
        sqls,
        probeSummary: probeSummary || undefined,
        error: execErrors.map((r) => r.error).join("; "),
      });
    }

    let tables = results.map((r, i) => ({
      title: sqls.length > 1 ? `查询 ${i + 1}` : "结果",
      cols: r.cols,
      rows: r.rows,
      grain: /toDate\s*\(\s*lastWatchTime\s*\)/i.test(sqls[i]) ? "day" : undefined,
    }));

    let dimCheck = reconcileNamedDimensions({
      nl: nlForGuards,
      tables,
      sqls,
      dimColumns,
    });
    while (!dimCheck.ok && rounds < pack.guards.maxRewriteRounds) {
      rounds++;
      rewriteRounds = rounds;
      const rewritten = await rewriteSqls(system, questionForLlm, sqls, dimCheck.detail, {
        ...llmOpts,
        spanName: "analytics.sql.dim-rewrite",
      });
      if (rewritten === "REFUSE" || !rewritten.length) break;
      sqls = normalizeSqls(rewritten);
      const dIssues = collectIssues(nlForGuards, sqls, allowedTables, dimColumns);
      if (dIssues.length) {
        guardIssues = dIssues;
        dimCheck = {
          ok: false,
          missing: dimCheck.missing,
          named: dimCheck.named,
          detail: `dim_mismatch+lint:${dIssues.join(",")}`,
        };
        continue;
      }
      execSqls = sqls.map((s) => ensureMaxRows(s, maxRows));
      results = await mapPool(
        execSqls,
        pack.guards.parallelism,
        (sql) => runNativeDataset(sql, dbId, { signal: opts?.signal }),
        opts?.signal,
      );
      tables = results.map((r, i) => ({
        title: sqls.length > 1 ? `查询 ${i + 1}` : "结果",
        cols: r.cols,
        rows: r.rows,
        grain: /toDate\s*\(\s*lastWatchTime\s*\)/i.test(sqls[i]) ? "day" : undefined,
      }));
      dimCheck = reconcileNamedDimensions({
        nl: nlForGuards,
        tables,
        sqls,
        dimColumns,
      });
    }
    if (!dimCheck.ok) {
      return seal({
        status: "refuse",
        message: `维对账未通过：结果中缺少点名维度 ${dimCheck.missing.join("、")}，已停止交付以免假对照。`,
        timeEcho: range.echo,
        sqls,
        tables,
        probeSummary: probeSummary || undefined,
        error: dimCheck.detail,
        modelId: opts?.modelId,
        packVersion: pack.version,
      });
    }

    let verifyMeta: LlmVerifyResult | undefined;
    const nonempty = !allEmpty(results);
    if (nonempty && llmVerifyEnabled()) {
      const verifyInput = () => ({
        nl: nlForGuards,
        timeEcho: range.echo,
        sqls,
        sampleTables: sampleTablesForVerify(tables),
      });
      const runVerify = async (): Promise<LlmVerifyResult> => {
        const prompt = buildLlmVerifyPrompt(verifyInput());
        const rawVerify = await llmText(prompt.system, prompt.user, {
          ...llmOpts,
          spanName: "analytics.verify",
        });
        return parseLlmVerifyResponse(rawVerify);
      };
      const runVerifyRetry = async (priorReason: string): Promise<LlmVerifyResult> => {
        const prompt = buildLlmVerifyRetryPrompt({ ...verifyInput(), priorReason });
        const rawVerify = await llmText(prompt.system, prompt.user, {
          ...llmOpts,
          spanName: "analytics.verify.retry",
        });
        return parseLlmVerifyResponse(rawVerify);
      };

      verifyMeta = await runVerify();
      while (verifyMeta.verdict === "fail" && rounds < pack.guards.maxRewriteRounds) {
        rounds++;
        rewriteRounds = rounds;
        const feedback = `verify_fail:${verifyMeta.codes.join("|") || "unspecified"}; ${verifyMeta.reason}`;
        const rewritten = await rewriteSqls(system, questionForLlm, sqls, feedback, {
          ...llmOpts,
          spanName: "analytics.sql.verify-rewrite",
        });
        if (rewritten === "REFUSE" || !rewritten.length) break;
        sqls = normalizeSqls(rewritten);
        const vIssues = collectIssues(nlForGuards, sqls, allowedTables, dimColumns);
        if (vIssues.length) {
          guardIssues = vIssues;
          verifyMeta = {
            verdict: "fail",
            codes: ["rewrite_lint", ...vIssues.slice(0, 3)],
            reason: vIssues.join(", "),
          };
          continue;
        }
        execSqls = sqls.map((s) => ensureMaxRows(s, maxRows));
        const vExec = trace.span(runId, "tool", "metabase.dataset.verify-retry", { worker: "analytics" });
        try {
          results = await mapPool(
            execSqls,
            pack.guards.parallelism,
            (sql) => runNativeDataset(sql, dbId, { signal: opts?.signal }),
            opts?.signal,
          );
          vExec.end({
            status: results.every((r) => r.ok) ? "ok" : "error",
            meta: { statements: execSqls.length },
          });
        } catch (e) {
          vExec.end({ status: "error", error: e instanceof Error ? e.message : String(e) });
          throw e;
        }
        tables = results.map((r, i) => ({
          title: sqls.length > 1 ? `查询 ${i + 1}` : "结果",
          cols: r.cols,
          rows: r.rows,
          grain: /toDate\s*\(\s*lastWatchTime\s*\)/i.test(sqls[i]) ? "day" : undefined,
        }));
        if (allEmpty(results)) break;
        verifyMeta = await runVerify();
      }

      if (verifyMeta.verdict === "unclear") {
        verifyMeta = await runVerifyRetry(verifyMeta.reason);
        if (verifyMeta.verdict === "unclear") {
          verifyMeta = resolveUnclearVerify(verifyMeta);
        }
      }

      if (verifyMeta.verdict === "unclear" || verifyMeta.verdict === "fail") {
        return seal({
          status: "refuse",
          message:
            verifyMeta.verdict === "unclear"
              ? `校对无法确认结果是否正确（${verifyMeta.reason}），请补充条件或换种问法。`
              : `校对未通过（${verifyMeta.reason}），已停止交付以免静默错数。`,
          timeEcho: range.echo,
          sqls,
          tables,
          probeSummary: probeSummary || undefined,
          verify: {
            verdict: verifyMeta.verdict,
            codes: verifyMeta.codes,
            reason: verifyMeta.reason,
          },
          modelId: opts?.modelId,
          packVersion: pack.version,
        });
      }
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
      probeSummary: probeSummary || undefined,
      sqlSource: "llm",
      verify: verifyMeta
        ? { verdict: verifyMeta.verdict, codes: verifyMeta.codes, reason: verifyMeta.reason }
        : undefined,
      modelId: opts?.modelId,
      packVersion: pack.version,
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
