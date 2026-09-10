/**
 * Post-exec LLM verify contract (M2 Task 2): pass | fail | unclear + reason codes.
 * Short-circuit empty results (caller skips). Configurable via ANALYTICS_LLM_VERIFY=0.
 */
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

export function buildLlmVerifyPrompt(input: {
  nl: string;
  timeEcho: string;
  sqls: string[];
  sampleTables: Array<{ title: string; cols: string[]; rows: unknown[][] }>;
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
    `SQL:\n${input.sqls.map((s, i) => `-- sql ${i + 1}\n${s}`).join("\n\n")}`,
    samples.join("\n\n"),
    "Return JSON only.",
  ].join("\n\n");

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
