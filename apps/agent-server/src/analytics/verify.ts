/**
 * Slot/grain Verify helpers (§6.1 / §7.1).
 * Protocol-only: no hard-coded channel product list.
 */
import {
  entityReferencedInSql,
  extractNamedEntities,
  wantsMultiQuerySplit,
} from "./named-entities.js";
import { nlWantsGrain } from "./nl-signals.js";
import { packTimeField, type AnalyticsPack } from "./semantic-layer.js";

/**
 * Grain verify: when the NL requests the pack's time grain (pack.time.grainAliases), the SQL
 * must group by toDate(<pack time field>). Both the grain surface forms and the physical
 * time column come from the pack — never hard-coded.
 */
export function verifyGrainDay(nl: string, sql: string, pack: AnalyticsPack): string[] {
  const issues: string[] = [];
  if (!nlWantsGrain(nl, pack)) return issues;
  const field = String(packTimeField(pack)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!field) return issues;
  if (!new RegExp(`toDate\\s*\\(\\s*${field}\\s*\\)`, "i").test(sql)) {
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
