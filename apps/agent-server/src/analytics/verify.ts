/**
 * Slot/grain Verify helpers (§6.1 / §7.1).
 * Protocol-only: no hard-coded channel product list.
 */
import {
  entityReferencedInSql,
  extractNamedEntities,
  wantsMultiQuerySplit,
} from "./named-entities.js";

/** NL contains 按天 → SQL must group by toDate(lastWatchTime). */
export function verifyGrainDay(nl: string, sql: string): string[] {
  const issues: string[] = [];
  if (!/按天|每天|按日/.test(nl)) return issues;
  if (!/toDate\s*\(\s*lastWatchTime\s*\)/i.test(sql)) {
    issues.push("missing_day_grain_toDate");
  }
  if (!/\bGROUP\s+BY\b/i.test(sql)) {
    issues.push("missing_day_grain_group_by");
  }
  return issues;
}

/**
 * Exactly one named entity → each SQL must reference it.
 * Optional dimColumns from pack.probeDimensions for CJK surface forms.
 */
export function verifyNamedChannel(
  nl: string,
  sqls: string[],
  dimColumns?: string[],
): string[] {
  const issues: string[] = [];
  const named = extractNamedEntities(nl);
  if (named.length !== 1) return issues;
  const token = named[0];
  for (const sql of sqls) {
    if (!entityReferencedInSql(token, sql, dimColumns)) {
      issues.push("missing_named_channel");
      break;
    }
  }
  return issues;
}

/**
 * ≥2 named entities + split markers → must emit ≥2 SQLs.
 */
export function verifyMultiQueryIntent(nl: string, sqls: string[]): string[] {
  const issues: string[] = [];
  const named = extractNamedEntities(nl);
  if (named.length < 2 || !wantsMultiQuerySplit(nl)) return issues;
  if (sqls.length < 2) {
    issues.push("need_multi_query");
  }
  return issues;
}

export function splitSqls(text: string): string[] {
  return text
    .split(/\n---\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
