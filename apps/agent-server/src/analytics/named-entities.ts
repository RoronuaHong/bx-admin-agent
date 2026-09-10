/**
 * Generic named-entity extraction from analytics NL (no business synonym table).
 * Used by multi-query verify, named-filter verify, and post-exec dim reconcile.
 */

const STOP = new Set(
  [
    "and",
    "or",
    "select",
    "from",
    "where",
    "group",
    "order",
    "by",
    "limit",
    "as",
    "in",
    "on",
    "join",
    "with",
    "the",
    "to",
    "of",
    "for",
    "day",
    "days",
    "sql",
    "null",
    "asc",
    "desc",
    "between",
    "uniq",
    "count",
    "sum",
    "avg",
  ].map((s) => s.toLowerCase()),
);

const DEFAULT_DIM_COLUMNS = ["channel", "contentLang", "package", "packName", "packageName"];

function looksLikeCodeToken(t: string): boolean {
  if (STOP.has(t.toLowerCase())) return false;
  return /[0-9]/.test(t) || /[a-z][A-Z]/.test(t) || t.length >= 4;
}

/**
 * Extract named entities:
 * - Latin identifiers (CamelCase / alnum codes)
 * - Short CJK + Latin suffix — surface form only; no synonym expand
 */
export function extractNamedEntities(nl: string): string[] {
  const out = new Set<string>();

  for (const m of nl.matchAll(/\b([A-Za-z][A-Za-z0-9]{1,31})\b/g)) {
    if (looksLikeCodeToken(m[1])) out.add(m[1]);
  }

  // 逐位置扫描，避免较长噪声匹配吞掉短实体
  const cjkPrefixStop =
    /^(同时|以及|还有|或者|按照|根据|关于|对于|进行|查询|观看|对比|对照|排行|人数|统计)/;
  const cjkNoise = /[月日年到零〇一二三四五六七八九十百千万]/;
  for (let i = 0; i < nl.length; i++) {
    const m = nl.slice(i).match(/^([\u4e00-\u9fff]{2,4}[A-Za-z][A-Za-z0-9]{0,3})/);
    if (!m) continue;
    const t = m[1];
    const cjk = t.replace(/[A-Za-z0-9]+$/, "");
    if (cjkNoise.test(cjk)) continue;
    if (cjkPrefixStop.test(cjk)) continue;
    out.add(t);
  }

  return [...out];
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether SQL references this entity.
 * Latin: literal must appear.
 * CJK surface: literal, or equality/IN on a probe/dimension column (from pack when provided).
 */
export function entityReferencedInSql(
  token: string,
  sql: string,
  dimColumns: string[] = DEFAULT_DIM_COLUMNS,
): boolean {
  if (new RegExp(escapeRegExp(token), "i").test(sql)) return true;
  if (/^[A-Za-z]/.test(token)) return false;
  const dims = (dimColumns.length ? dimColumns : DEFAULT_DIM_COLUMNS)
    .map((d) => escapeRegExp(d))
    .join("|");
  if (!dims) return false;
  return new RegExp(`\\b(?:${dims})\\s*(?:=|IN\\b)`, "i").test(sql);
}

/** Split-intent markers: parallel / per-entity queries. */
export function wantsMultiQuerySplit(nl: string): boolean {
  return /各自|同时|分别|分开|各一张/.test(nl);
}
