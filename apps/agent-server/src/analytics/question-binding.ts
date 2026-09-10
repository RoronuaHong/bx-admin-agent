/**
 * Pack questionBindings — optional acceleration (Metabase card or SQL template).
 * Match is structural token AND; no business synonym table.
 */
export type QuestionBindingParamSource = "start" | "end" | string;

export type QuestionBinding = {
  id: string;
  /** All tokens must appear in NL (case-insensitive). */
  matchAll: string[];
  /** If any token appears, skip this binding (avoids multi-entity collisions). */
  matchNone?: string[];
  /** Metabase saved question / card id. Prefer over sqlTemplate when set (>0). */
  questionId?: number;
  /**
   * Native SQL with {start}/{end} placeholders (inclusive UX dates).
   * Used when questionId is absent; still a binding shortcut (no LLM SQL).
   */
  sqlTemplate?: string;
  /** Optional Metabase template-tag map: tagName → start|end|literal */
  parameters?: Record<string, QuestionBindingParamSource>;
};

export type MatchedQuestionBinding = QuestionBinding & {
  questionId?: number;
};

export function matchQuestionBinding(
  bindings: QuestionBinding[] | undefined,
  nl: string,
): MatchedQuestionBinding | null {
  if (!bindings?.length || !nl.trim()) return null;
  const hay = nl.toLowerCase();
  for (const b of bindings) {
    const tokens = (b.matchAll || []).map((t) => String(t).trim()).filter(Boolean);
    if (!tokens.length) continue;
    if (!tokens.every((t) => hay.includes(t.toLowerCase()))) continue;
    const none = (b.matchNone || []).map((t) => String(t).trim()).filter(Boolean);
    if (none.some((t) => hay.includes(t.toLowerCase()))) continue;
    const qid = b.questionId != null ? Number(b.questionId) : undefined;
    const hasCard = Number.isFinite(qid) && (qid as number) > 0;
    const hasSql = Boolean(b.sqlTemplate?.trim());
    if (!hasCard && !hasSql) continue;
    return {
      ...b,
      questionId: hasCard ? (qid as number) : undefined,
    };
  }
  return null;
}

/** Fill {start}/{end} (and bare start/end) in SQL templates. */
export function applyBindingSqlTemplate(
  template: string,
  range: { start: string; end: string },
): string {
  return template
    .replace(/\{start\}/gi, range.start)
    .replace(/\{end\}/gi, range.end)
    .replace(/\bSTART_DATE\b/g, range.start)
    .replace(/\bEND_DATE\b/g, range.end);
}

/** Build Metabase card query parameters from binding + resolved range. */
export function buildBindingParameters(
  binding: QuestionBinding,
  range: { start: string; end: string },
): Record<string, string> | undefined {
  const spec = binding.parameters;
  if (!spec || !Object.keys(spec).length) {
    return { start: range.start, end: range.end };
  }
  const out: Record<string, string> = {};
  for (const [key, src] of Object.entries(spec)) {
    if (src === "start") out[key] = range.start;
    else if (src === "end") out[key] = range.end;
    else out[key] = String(src);
  }
  return out;
}
