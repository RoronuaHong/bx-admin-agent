/**
 * Post-exec LLM verify contract (M2 Task 2): pass | fail | unclear + reason codes.
 * Short-circuit empty results (caller skips). Configurable via ANALYTICS_LLM_VERIFY=0.
 * Deterministic metric-vs-NL check is always available (no new business wordlist).
 */

import type { AnalyticsPack } from "./semantic-layer.js";
import { inferMetricIdFromNl } from "./metric-infer.js";

export type VerifyVerdict = "pass" | "fail" | "unclear";

export type LlmVerifyResult = {
  verdict: VerifyVerdict;
  codes: string[];
  reason: string;
  raw?: string;
};

export function llmVerifyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ANALYTICS_LLM_VERIFY || "1").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/** Parse model JSON / loose text into structured verdict. Fail-closed → unclear. */
export function parseLlmVerifyResponse(raw: string): LlmVerifyResult {
  const text = (raw || "").trim();
  if (!text) {
    return { verdict: "unclear", codes: ["empty_verify"], reason: "校对模型返回空" };
  }

  // Prefer fenced or bare JSON object
  let jsonText = text;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) jsonText = fence[1].trim();
  const brace = jsonText.match(/\{[\s\S]*\}/);
  if (brace) jsonText = brace[0];

  try {
    const obj = JSON.parse(jsonText) as {
      verdict?: string;
      pass?: boolean;
      codes?: unknown;
      code?: unknown;
      reason?: unknown;
      message?: unknown;
    };
    const vRaw = String(obj.verdict || "").toLowerCase();
    let verdict: VerifyVerdict;
    if (vRaw === "pass" || vRaw === "fail" || vRaw === "unclear") {
      verdict = vRaw;
    } else if (obj.pass === true) {
      verdict = "pass";
    } else if (obj.pass === false) {
      verdict = "fail";
    } else {
      verdict = "unclear";
    }
    const codes = Array.isArray(obj.codes)
      ? obj.codes.map((c) => String(c))
      : obj.code
        ? [String(obj.code)]
        : [];
    const reason = String(obj.reason || obj.message || "").trim() || verdict;
    return { verdict, codes, reason, raw: text.slice(0, 500) };
  } catch {
    // Loose keyword fallback
    if (/\bPASS\b/i.test(text) && !/\bFAIL\b/i.test(text) && !/\bUNCLEAR\b/i.test(text)) {
      return { verdict: "pass", codes: [], reason: "loose PASS", raw: text.slice(0, 500) };
    }
    if (/\bFAIL\b/i.test(text)) {
      return { verdict: "fail", codes: ["loose_fail"], reason: text.slice(0, 200), raw: text.slice(0, 500) };
    }
    return {
      verdict: "unclear",
      codes: ["parse_fail"],
      reason: "无法解析校对 JSON",
      raw: text.slice(0, 500),
    };
  }
}

/**
 * Light CWR check: this-turn NL uniquely grounds a pack metric that differs from compiled id.
 * Returns null when there is no unique NL signal (follow-ups like 「FoxA呢」 must not fire).
 */
export function checkMetricIntentAlignment(input: {
  nl: string;
  metricId: string;
  pack: AnalyticsPack;
}): LlmVerifyResult | null {
  const id = String(input.metricId || "").trim();
  const inferred = inferMetricIdFromNl(input.nl, input.pack);
  if (!inferred || !id || inferred === id) return null;
  return {
    verdict: "fail",
    codes: ["metric_nl_mismatch"],
    reason: `问句接地指标 ${inferred}，编译指标为 ${id}`,
  };
}

export function buildLlmVerifyPrompt(input: {
  nl: string;
  timeEcho: string;
  sqls: string[];
  sampleTables: Array<{ title: string; cols: string[]; rows: unknown[][] }>;
  metricId?: string;
}): { system: string; user: string } {
  const system = [
    "You are a strict analytics SQL result verifier.",
    "Decide if the SQL results answer the user question for the resolved time window.",
    "Output ONLY a JSON object:",
    '{"verdict":"pass"|"fail"|"unclear","codes":["..."],"reason":"..."}',
    "verdict meanings:",
    "- pass: grain/filters/metrics are consistent with the question and sample rows are usable",
    "- fail: concrete mismatch visible in SQL or sample (wrong grain, missing entity filter, invented metric)",
    "- unclear: ONLY when the sample is too truncated/ambiguous to judge AND you see no concrete fail",
    "If named entities appear in WHERE filters, day grain matches 按天/每天/按日, and sample rows are non-empty for the window → prefer pass.",
    "If compiled metricId contradicts a uniquely grounded pack metric in the question (e.g. 人均 vs 最大进度), fail with metric_nl_mismatch.",
    "Do not invent business synonyms. Prefer fail over silent wrong pass; do not overuse unclear.",
  ].join("\n");

  const samples = input.sampleTables.map((t, i) => {
    const head = t.rows.slice(0, 8).map((r) => r.map((c) => (c == null ? "" : String(c))).join(" | "));
    return [
      `### Table ${i + 1}: ${t.title}`,
      `cols: ${t.cols.join(", ")}`,
      `rows(${t.rows.length} total, showing ≤8):`,
      ...head,
    ].join("\n");
  });

  const user = [
    `User question: ${input.nl}`,
    `Resolved time: ${input.timeEcho}`,
    input.metricId ? `Compiled metricId: ${input.metricId}` : "",
    `SQL:\n${input.sqls.map((s, i) => `-- sql ${i + 1}\n${s}`).join("\n\n")}`,
    samples.join("\n\n"),
    "Return JSON only.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { system, user };
}

/** Second-pass prompt when first verdict is unclear — force pass|fail. */
export function buildLlmVerifyRetryPrompt(input: {
  nl: string;
  timeEcho: string;
  sqls: string[];
  sampleTables: Array<{ title: string; cols: string[]; rows: unknown[][] }>;
  priorReason: string;
}): { system: string; user: string } {
  const base = buildLlmVerifyPrompt(input);
  return {
    system:
      base.system +
      "\nYour previous verdict was unclear. You MUST now choose pass or fail only (unclear forbidden).",
    user: base.user + `\nPrior unclear reason: ${input.priorReason}`,
  };
}

/**
 * After structural guards already passed: if LLM still returns unclear,
 * allow soft pass unless ANALYTICS_LLM_VERIFY_STRICT=1.
 */
export function resolveUnclearVerify(
  prior: LlmVerifyResult,
  opts?: { strict?: boolean },
): LlmVerifyResult {
  const strict =
    opts?.strict === true ||
    process.env.ANALYTICS_LLM_VERIFY_STRICT === "1" ||
    process.env.ANALYTICS_LLM_VERIFY_STRICT === "true";
  if (prior.verdict !== "unclear") return prior;
  if (strict) return prior;
  return {
    verdict: "pass",
    codes: [...prior.codes, "unclear_resolved_by_structure"],
    reason: `结构护栏已通过；校对 unclear 降级为 pass（${prior.reason}）`,
    raw: prior.raw,
  };
}

/** Truncate tables for verify prompt (≤ maxRows sample rows per table). */
export function sampleTablesForVerify(
  tables: Array<{ title: string; cols: string[]; rows: unknown[][] }>,
  maxRows = 12,
): Array<{ title: string; cols: string[]; rows: unknown[][] }> {
  return tables.map((t) => ({
    title: t.title,
    cols: t.cols,
    rows: t.rows.slice(0, maxRows),
  }));
}

export function llmInsightEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ANALYTICS_LLM_INSIGHT || "1").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

const NUM_TOKEN = /\d[\d,]*(?:\.\d+)?/g;
const VERSION_TOKEN = /\b\d+(?:\.\d+){1,3}\b/g;

/** Normalize a numeric/version token so 96,901 and 96901 match. */
export function normalizeGroundedToken(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/\d+\.\d+\.\d/.test(s)) return s;
  const n = s.replace(/,/g, "");
  if (!n) return "";
  const num = Number(n);
  if (Number.isFinite(num) && !/\d+\.\d+\.\d/.test(n)) {
    if (Number.isInteger(num)) return String(num);
    return String(num);
  }
  return n;
}

/** Numbers / versions the insight is allowed to mention (sample + time + row count). */
export function collectGroundedNumbers(
  tables: Array<{ cols: string[]; rows: unknown[][] }>,
  extraTexts: string[] = [],
): Set<string> {
  const out = new Set<string>();
  const add = (raw: string) => {
    const n = normalizeGroundedToken(raw);
    if (n) out.add(n);
  };
  for (let i = 0; i <= 10; i++) add(String(i));
  for (const t of tables) {
    add(String(t.rows.length));
    for (const row of t.rows) {
      for (const cell of row) {
        const s = String(cell ?? "");
        for (const m of s.match(VERSION_TOKEN) || []) add(m);
        for (const m of s.match(NUM_TOKEN) || []) add(m);
      }
    }
  }
  for (const text of extraTexts) {
    const s = String(text || "");
    for (const m of s.match(VERSION_TOKEN) || []) add(m);
    for (const m of s.match(NUM_TOKEN) || []) add(m);
  }
  return out;
}

export function extractNumberTokens(text: string): string[] {
  const s = String(text || "");
  const found = [...(s.match(VERSION_TOKEN) || []), ...(s.match(NUM_TOKEN) || [])];
  return [...new Set(found)];
}

/** Drop sentences that invent numbers not present in the sample / time echo. */
export function sanitizeInsightText(text: string, grounded: Set<string>): string {
  const body = String(text || "").trim();
  if (!body) return "";
  const parts = body.split(/(?<=[。！？\n])/).map((p) => p.trim()).filter(Boolean);
  const kept = parts.filter((p) => {
    const tokens = extractNumberTokens(p);
    return tokens.every((t) => grounded.has(normalizeGroundedToken(t)));
  });
  return kept.join("").trim();
}

export function buildInsightPrompt(input: {
  nl: string;
  timeEcho: string;
  sqls: string[];
  sampleTables: Array<{ title: string; cols: string[]; rows: unknown[][] }>;
  locale?: string;
}): { system: string; user: string } {
  const system = [
    "You write a short analytics reading of ALREADY EXECUTED SQL results.",
    "Output ONLY JSON: {\"summary\":\"...\",\"trend\":\"...\"}",
    "summary: 2-4 sentences in the user's language (default Chinese).",
    "trend: one sentence on the pattern visible in the shown rows (rank, concentration, day-to-day direction).",
    "HARD RULES:",
    "- Use ONLY numbers/versions that appear in the sample rows or the resolved time window.",
    "- Do not invent totals, rates, or forecasts. No next-week / next-month numeric prediction.",
    "- Do not rewrite or round sample numbers into a different value.",
    "- If the sample is truncated, say you are describing the shown rows only.",
    "- Do not mention SQL dialect or internal table names unless the user named them.",
  ].join("\n");
  const samples = input.sampleTables.map((t, i) => {
    const head = t.rows.slice(0, 8).map((r) => r.map((c) => (c == null ? "" : String(c))).join(" | "));
    return [
      `### Table ${i + 1}: ${t.title}`,
      `cols: ${t.cols.join(", ")}`,
      `rows(${t.rows.length} total, showing ≤8):`,
      ...head,
    ].join("\n");
  });
  const user = [
    `User question: ${input.nl}`,
    `Resolved time: ${input.timeEcho}`,
    `SQL:\n${input.sqls.map((s, i) => `-- sql ${i + 1}\n${s}`).join("\n\n")}`,
    samples.join("\n\n"),
    "Return JSON only.",
  ].join("\n\n");
  return { system, user };
}

export function parseInsightResponse(raw: string): { summary: string; trend: string } {
  const text = String(raw || "").trim();
  if (!text) return { summary: "", trend: "" };
  let jsonText = text;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) jsonText = fence[1].trim();
  const brace = jsonText.match(/\{[\s\S]*\}/);
  if (brace) jsonText = brace[0];
  try {
    const obj = JSON.parse(jsonText) as { summary?: unknown; trend?: unknown; insight?: unknown };
    return {
      summary: String(obj.summary || obj.insight || "").trim(),
      trend: String(obj.trend || "").trim(),
    };
  } catch {
    return { summary: text.slice(0, 600).trim(), trend: "" };
  }
}

export function composeInsightMarkdown(parsed: { summary: string; trend: string }, grounded: Set<string>): string {
  const summary = sanitizeInsightText(parsed.summary, grounded);
  const trend = sanitizeInsightText(parsed.trend, grounded);
  return [summary, trend].filter(Boolean).join("\n\n").trim();
}

export type PostExecLlm = {
  verify?: LlmVerifyResult;
  insight?: string;
};

/** Instant reading from the result table — no extra LLM. Used for Path A/B. */
export function buildLocalInsight(input: {
  timeEcho: string;
  tables: Array<{ title?: string; cols: string[]; rows: unknown[][] }>;
}): string {
  const tables = input.tables || [];
  const first = tables[0];
  if (!first?.rows?.length) return "";
  const echo = String(input.timeEcho || "").trim();
  if (tables.length === 1 && first.rows.length === 1) {
    const row = first.rows[0] || [];
    const nums = first.cols.map((c, i) => {
      const v = row[i];
      if (v == null || v === "") return "";
      return first.cols.length === 1 ? String(v) : `${c} ${v}`;
    }).filter(Boolean);
    if (!nums.length) return "";
    return echo ? `${echo}，结果为 ${nums.join("，")}。` : `结果为 ${nums.join("，")}。`;
  }
  const n = tables.reduce((s, t) => s + (t.rows?.length || 0), 0);
  const row = first.rows[0] || [];
  const head = first.cols
    .map((c, i) => (row[i] == null || row[i] === "" ? "" : `${c} ${row[i]}`))
    .filter(Boolean)
    .slice(0, 3)
    .join(" / ");
  const bits = [echo, `共 ${n} 行`, head ? `首位 ${head}` : ""].filter(Boolean);
  return bits.length ? `${bits.join("，")}。` : "";
}

export function buildPostExecCombinedPrompt(input: {
  nl: string;
  timeEcho: string;
  sqls: string[];
  sampleTables: Array<{ title: string; cols: string[]; rows: unknown[][] }>;
  metricId?: string;
}): { system: string; user: string } {
  const system = [
    "You are an analytics SQL result verifier AND reader.",
    "The SQL already ran. Do not rewrite numbers.",
    "Output ONLY JSON:",
    '{"verdict":"pass"|"fail"|"unclear","codes":["..."],"reason":"...","summary":"...","trend":"..."}',
    "verdict: pass if SQL/filters/grain match the question; fail if a concrete mismatch is visible; unclear only if the sample is too short AND you see no concrete fail.",
    "summary: 2-4 sentences in the user's language (default Chinese).",
    "trend: one observed pattern from shown rows. No future numeric forecast.",
    "Use ONLY numbers/versions that appear in the sample or resolved time window.",
  ].join("\n");
  const verify = buildLlmVerifyPrompt(input);
  const insight = buildInsightPrompt(input);
  return { system, user: verify.user + "\n\n" + insight.user.split("Return JSON only.")[0] + "Return one JSON object only." };
}

/** Path A/B already compiled or gold — skip extra LLM. Path C = one combined call, no retry. */
export async function runPostExecLlm(input: {
  nl: string;
  timeEcho: string;
  sqls: string[];
  tables: Array<{ title: string; cols: string[]; rows: unknown[][] }>;
  metricId?: string;
  empty?: boolean;
  trust?: "trusted" | "verified" | "unverified";
  llmText: (system: string, user: string, spanName: string) => Promise<string>;
}): Promise<PostExecLlm> {
  if (input.empty) {
    return { verify: { verdict: "pass", codes: ["empty_skip"], reason: "empty result skip verify" } };
  }
  const sampleTables = sampleTablesForVerify(input.tables, 8);
  const local = llmInsightEnabled() ? buildLocalInsight({ timeEcho: input.timeEcho, tables: input.tables }) : "";
  const compiled = input.trust === "trusted" || input.trust === "verified";
  if (compiled || (!llmVerifyEnabled() && !llmInsightEnabled())) {
    return {
      verify: {
        verdict: "pass",
        codes: [compiled ? "verify_skipped_compiled" : "verify_disabled"],
        reason: compiled ? "compiled/gold SQL; skipped extra LLM verify" : "ANALYTICS_LLM_VERIFY=0",
      },
      insight: local || undefined,
    };
  }

  const out: PostExecLlm = { insight: local || undefined };
  if (!llmVerifyEnabled() && !llmInsightEnabled()) return out;
  try {
    const prompt = buildPostExecCombinedPrompt({
      nl: input.nl,
      timeEcho: input.timeEcho,
      sqls: input.sqls,
      sampleTables,
      metricId: input.metricId,
    });
    const raw = await input.llmText(prompt.system, prompt.user, "analytics.llm_post_exec");
    if (llmVerifyEnabled()) {
      out.verify = resolveUnclearVerify(parseLlmVerifyResponse(raw));
    }
    if (llmInsightEnabled()) {
      const parsed = parseInsightResponse(raw);
      const grounded = collectGroundedNumbers(sampleTables, [input.timeEcho, input.nl, ...input.sqls]);
      const insight = composeInsightMarkdown(parsed, grounded) || local;
      if (insight) out.insight = insight;
    }
  } catch {
    if (llmVerifyEnabled()) {
      out.verify = { verdict: "unclear", codes: ["verify_http"], reason: "校对调用失败" };
    }
  }
  if (!out.verify && llmVerifyEnabled()) {
    out.verify = { verdict: "pass", codes: ["verify_disabled"], reason: "ANALYTICS_LLM_VERIFY=0" };
  }
  return out;
}

export function verifyCaution(verify?: LlmVerifyResult): string {
  if (verify?.verdict === "fail" && verify.reason) return `\n\n校对未通过：${verify.reason}`;
  return "";
}
