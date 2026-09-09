import { config, listModels } from "../config.js";
import { runNativeDataset } from "./metabase-client.js";
import { loadAnalyticsPack, type AnalyticsPack } from "./semantic-layer.js";
import {
  assertTablesWhitelisted,
  lintSql,
  normalizeDistinctCount,
} from "./sql-guard.js";
import { resolveTimeRange } from "./time-resolve.js";
import type { AnalyticsAskResult, DatasetResult } from "./types.js";
import { splitSqls, verifyGrainDay, verifyNamedChannel } from "./verify.js";

/** Prefer flash/dsflash if registered, else first model. */
async function llmText(system: string, user: string): Promise<string> {
  const models = listModels();
  const model = models.find((m) => /flash|dsflash/i.test(m.id)) || models[0];
  if (!model) throw new Error("no model");
  const key = model.apiKeys[0] || model.apiKey;
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
  });
  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  if (!resp.ok) throw new Error(JSON.stringify(data).slice(0, 300));
  return data.choices?.[0]?.message?.content || "";
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
    "Each statement must be a single read-only SELECT (or WITH … SELECT). No semicolon-separated multi-statements.",
    "Output only SQL (optionally fenced). If the question cannot be answered safely, reply REFUSE.",
  ].join("\n");
}

async function probeDimensions(
  pack: AnalyticsPack,
  range: { start: string; end: string },
): Promise<string> {
  const dims = pack.probeDimensions.slice(0, pack.guards.maxProbeRounds);
  const lines: string[] = [];
  for (const dim of dims) {
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
      const res = await runNativeDataset(sql, pack.datasource.metabaseDatabaseId);
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
      lines.push(`${dim}: PROBE_FAILED (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return lines.join("\n");
}

function collectIssues(nl: string, sqls: string[], allowedTables: string[]): string[] {
  const issues: string[] = [];
  for (const sql of sqls) {
    try {
      assertTablesWhitelisted(sql, allowedTables);
    } catch (e) {
      issues.push(e instanceof Error ? e.message : String(e));
    }
    issues.push(...lintSql(sql, nl));
    issues.push(...verifyGrainDay(nl, sql));
  }
  issues.push(...verifyNamedChannel(nl, sqls));
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
): Promise<string[] | "REFUSE"> {
  const user = [
    `User question: ${nl}`,
    `Prior SQL(s):\n${sqls.join("\n---\n")}`,
    `Issue codes (fix these only; do not invent unconstrained EX rewrites): ${feedback}`,
    "Return corrected SQL only (or REFUSE).",
  ].join("\n\n");
  const text = await llmText(system, user);
  return parseSqlsFromLlm(text);
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, concurrency);
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
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
 * NL → time resolve → Probe → LLM SQL → lint/normalize/verify → parallel exec.
 */
export async function analyticsAsk(
  nl: string,
  opts?: { clock?: Date; packId?: string },
): Promise<AnalyticsAskResult> {
  try {
    const pack = loadAnalyticsPack(opts?.packId || "watch-detail");
    const clock = opts?.clock || new Date();
    const tz = pack.time.businessTimezone || config.metabase.businessTimezone;
    const resolved = resolveTimeRange(nl, clock, tz);
    if (!resolved.ok) {
      return { status: "clarify", message: resolved.clarify };
    }

    const { range } = resolved;
    const system = buildStructuralHint(pack, range);
    const allowedTables = pack.tables.map((t) => t.name);

    let probeSummary = "";
    try {
      probeSummary = await probeDimensions(pack, range);
    } catch {
      probeSummary = "PROBE_FAILED";
    }

    const genUser = [
      `User question: ${nl}`,
      `Resolved time: ${range.start} .. ${range.end} (${range.echo})`,
      probeSummary ? `Probe Top-N DISTINCT:\n${probeSummary}` : "",
      "Generate SQL now.",
    ]
      .filter(Boolean)
      .join("\n\n");

    let raw = await llmText(system, genUser);
    let parsed = parseSqlsFromLlm(raw);
    if (parsed === "REFUSE") {
      return {
        status: "refuse",
        message: "无法安全生成查询。",
        timeEcho: range.echo,
        probeSummary: probeSummary || undefined,
      };
    }

    let sqls = normalizeSqls(parsed);
    let issues = collectIssues(nl, sqls, allowedTables);
    let rounds = 0;
    while (issues.length && rounds < pack.guards.maxRewriteRounds) {
      rounds++;
      const rewritten = await rewriteSqls(system, nl, sqls, issues.join(", "));
      if (rewritten === "REFUSE") {
        return {
          status: "refuse",
          message: "重写后仍无法安全生成查询。",
          timeEcho: range.echo,
          sqls,
          probeSummary: probeSummary || undefined,
        };
      }
      sqls = normalizeSqls(rewritten);
      issues = collectIssues(nl, sqls, allowedTables);
    }
    if (issues.length) {
      return {
        status: "error",
        message: `SQL 校验未通过: ${issues.join(", ")}`,
        timeEcho: range.echo,
        sqls,
        probeSummary: probeSummary || undefined,
        error: issues.join(", "),
      };
    }

    const dbId = pack.datasource.metabaseDatabaseId;
    let results = await mapPool(sqls, pack.guards.parallelism, (sql) =>
      runNativeDataset(sql, dbId),
    );

    if (allEmpty(results)) {
      const yearHint = `All queries returned empty rows for ${range.start}..${range.end}. Consider year mismatch; keep resolved window unless clearly wrong. Rewrite SQL once.`;
      const rewritten = await rewriteSqls(system, nl, sqls, `empty_result; ${yearHint}`);
      if (rewritten !== "REFUSE" && rewritten.length) {
        sqls = normalizeSqls(rewritten);
        const emptyIssues = collectIssues(nl, sqls, allowedTables);
        if (!emptyIssues.length) {
          results = await mapPool(sqls, pack.guards.parallelism, (sql) =>
            runNativeDataset(sql, dbId),
          );
        }
      }
    }

    const execErrors = results.filter((r) => !r.ok);
    if (execErrors.length === results.length && results.length > 0) {
      return {
        status: "error",
        message: `执行失败: ${execErrors.map((r) => r.error).join("; ")}`,
        timeEcho: range.echo,
        sqls,
        probeSummary: probeSummary || undefined,
        error: execErrors.map((r) => r.error).join("; "),
      };
    }

    const tables = results.map((r, i) => ({
      title: sqls.length > 1 ? `查询 ${i + 1}` : "结果",
      cols: r.cols,
      rows: r.rows,
      grain: /toDate\s*\(\s*lastWatchTime\s*\)/i.test(sqls[i]) ? "day" : undefined,
    }));

    const emptyNote = allEmpty(results)
      ? `（${range.echo} 无数据行；请确认年份或筛选条件）`
      : "";

    return {
      status: "ok",
      message: `${range.echo}${emptyNote}`,
      timeEcho: range.echo,
      sqls,
      tables,
      probeSummary: probeSummary || undefined,
    };
  } catch (e) {
    return {
      status: "error",
      message: e instanceof Error ? e.message : String(e),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
