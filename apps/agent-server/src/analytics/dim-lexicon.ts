/**
 * Dimension value lexicon: code ↔ label from Metabase field values / description.
 * Pure functions — no I/O. Used for deterministic resolve before SQL compile.
 */

export type DimLexiconEntry = { code: string; label: string };

export type DimLexicon = {
  field: string;
  /** True when Metabase provides human labels distinct from stored codes. */
  remapped: boolean;
  entries: DimLexiconEntry[];
  codes: Set<string>;
  labelToCode: Map<string, string>;
};

export function normalizeDimLabel(s: string): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[（(].*?[）)]/g, "");
}

/** Parse `1:电影，2:电视剧` / `映射关系：1:电影，…` style descriptions. */
export function parseDescriptionMapping(description: string | null | undefined): DimLexiconEntry[] {
  const text = String(description || "").trim();
  if (!text) return [];
  const out: DimLexiconEntry[] = [];
  const re = /(\d+)\s*[:：]\s*([^\d，,;；:\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const code = m[1]!;
    const label = m[2]!.trim().replace(/[。．.]+$/g, "");
    if (code && label) out.push({ code, label });
  }
  return out;
}

/**
 * Metabase `/api/field/:id/values` rows:
 * - remapped: [[0,"未知"],[1,"电影"],…]
 * - list-only: [["ta-IN"],[""],…]
 */
export function parseFieldValuesRows(rows: unknown): DimLexiconEntry[] {
  if (!Array.isArray(rows)) return [];
  const out: DimLexiconEntry[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || !row.length) continue;
    const code = row[0] == null ? "" : String(row[0]);
    if (row.length >= 2 && row[1] != null && String(row[1]).trim() !== "") {
      out.push({ code, label: String(row[1]).trim() });
    } else {
      // literal domain — code is the stored value; label equals code for membership
      out.push({ code, label: code });
    }
  }
  return out;
}

export function buildDimLexicon(input: {
  field: string;
  valuesRows?: unknown;
  description?: string | null;
}): DimLexicon {
  const fromValues = parseFieldValuesRows(input.valuesRows);
  const fromDesc = parseDescriptionMapping(input.description);
  const byCode = new Map<string, DimLexiconEntry>();
  for (const e of fromValues) byCode.set(e.code, e);
  for (const e of fromDesc) {
    const prev = byCode.get(e.code);
    if (!prev || prev.label === prev.code) byCode.set(e.code, e);
    else if (prev.label !== e.label) {
      // keep value-api label; still register desc label as alias below
      byCode.set(e.code, prev);
    }
  }
  const entries = [...byCode.values()];
  const remapped = entries.some((e) => e.label !== e.code && e.label !== "");
  const codes = new Set(entries.map((e) => e.code));
  const labelToCode = new Map<string, string>();
  for (const e of entries) {
    const nk = normalizeDimLabel(e.label);
    if (nk) labelToCode.set(nk, e.code);
  }
  for (const e of fromDesc) {
    const nk = normalizeDimLabel(e.label);
    if (nk) labelToCode.set(nk, e.code);
  }
  for (const e of entries) {
    labelToCode.set(normalizeDimLabel(e.code), e.code);
  }
  return { field: input.field, remapped, entries, codes, labelToCode };
}

export type ResolveDimResult = {
  resolved: string[];
  unresolved: string[];
  /** code → label for clarify UI */
  options: Array<{ id: string; label: string }>;
};

/** Map user tokens (codes or labels) through lexicon. Non-remapped: membership / passthrough. */
export function resolveDimTokens(tokens: string[], lexicon: DimLexicon): ResolveDimResult {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of tokens) {
    const t = String(raw ?? "").trim();
    if (!t) continue;
    const nk = normalizeDimLabel(t);
    let code: string | undefined;
    if (lexicon.codes.has(t)) code = t;
    else if (nk && lexicon.labelToCode.has(nk)) code = lexicon.labelToCode.get(nk);
    else if (lexicon.codes.has(nk)) code = nk;

    if (code != null) {
      if (!seen.has(code)) {
        seen.add(code);
        resolved.push(code);
      }
      continue;
    }
    if (!lexicon.remapped) {
      // literal dims: accept as-is (probe will have validated earlier when needed)
      if (!seen.has(t)) {
        seen.add(t);
        resolved.push(t);
      }
      continue;
    }
    unresolved.push(t);
  }
  const options = lexicon.entries
    .filter((e) => e.label !== "" || e.code === "0")
    .map((e) => ({
      id: e.code === "" ? "(empty)" : e.code,
      label: e.label && e.label !== e.code ? `${e.code}=${e.label}` : e.code || "(empty)",
    }));
  const allNumeric = resolved.length > 0 && resolved.every((c) => /^-?\d+$/.test(c));
  if (allNumeric) resolved.sort((a, b) => Number(a) - Number(b));
  return { resolved, unresolved, options };
}

/** Longest-label-first scan so 「电视剧」 wins over 「电视」. */
export function extractLabelsFromText(text: string, lexicon: DimLexicon): string[] {
  if (!lexicon.remapped || !text) return [];
  const labels = lexicon.entries
    .map((e) => e.label)
    .filter((l) => l && l !== "")
    .sort((a, b) => b.length - a.length);
  const hit: string[] = [];
  const seen = new Set<string>();
  let rest = text;
  for (const label of labels) {
    if (rest.includes(label)) {
      const code = lexicon.labelToCode.get(normalizeDimLabel(label));
      if (code != null && !seen.has(code)) {
        seen.add(code);
        hit.push(code);
      }
      rest = rest.split(label).join(" ");
    }
  }
  return hit;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Ground lexicon codes from NL for remapped AND literal dims (channel codes, locale codes).
 * Skips short/numeric codes to avoid matching dates (10 in 2026-08-10).
 */
export function extractCodesFromText(text: string, lexicon: DimLexicon): string[] {
  if (!text || !lexicon.entries.length) return [];
  const hit: string[] = [];
  const seen = new Set<string>();
  const add = (code: string | undefined) => {
    if (code == null || seen.has(code)) return;
    seen.add(code);
    hit.push(code);
  };

  for (const c of extractLabelsFromText(text, lexicon)) add(c);

  const needles = lexicon.entries
    .flatMap((e) => [e.label, e.code])
    .filter((n) => n && n.trim() && n.length >= 2 && !/^\d+$/.test(n))
    .sort((a, b) => b.length - a.length);

  let rest = text;
  for (const needle of needles) {
    const latin = /^[A-Za-z][A-Za-z0-9_-]*$/.test(needle);
    const found = latin
      ? new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegExp(needle)}(?:[^A-Za-z0-9]|$)`, "i").test(rest)
      : rest.includes(needle);
    if (!found) continue;
    add(lexicon.labelToCode.get(normalizeDimLabel(needle)) ?? (lexicon.codes.has(needle) ? needle : undefined));
    rest = rest.split(needle).join(" ");
  }
  return hit;
}

export function lexiconClarifyOptions(lexicon: DimLexicon): Array<{ id: string; label: string }> {
  return lexicon.entries
    .filter((e) => !(e.code === "" && e.label === ""))
    .map((e) => ({
      id: e.code === "" ? "(empty)" : e.code,
      label: lexicon.remapped && e.label && e.label !== e.code ? e.label : e.code || "(empty)",
    }));
}
