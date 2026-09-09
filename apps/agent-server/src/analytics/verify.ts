/**
 * Slot/grain Verify helpers (§6.1 / §7.1).
 * Returns issue codes for structured rewrite feedback.
 */

/** NL contains 按天 → SQL must group by toDate(lastWatchTime). */
export function verifyGrainDay(nl: string, sql: string): string[] {
  const issues: string[] = [];
  if (!/按天/.test(nl)) return issues;
  if (!/toDate\s*\(\s*lastWatchTime\s*\)/i.test(sql)) {
    issues.push("missing_day_grain_toDate");
  }
  if (!/\bGROUP\s+BY\b/i.test(sql)) {
    issues.push("missing_day_grain_group_by");
  }
  return issues;
}

/** Single-channel NL (e.g. 印度A only) → each SQL must filter that channel. */
export function verifyNamedChannel(nl: string, sqls: string[]): string[] {
  const issues: string[] = [];
  const mentionsIndia = /印度A|IndiaA/i.test(nl);
  const multiChannel = /FoxA|GoGo/i.test(nl);
  if (!mentionsIndia || multiChannel) return issues;

  for (const sql of sqls) {
    if (!/IndiaA/i.test(sql)) {
      issues.push("missing_named_channel");
      break;
    }
  }
  return issues;
}

/** Split parallel SQL block on `\n---\n` between SELECT statements. */
export function splitSqls(text: string): string[] {
  return text
    .split(/\n---\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
