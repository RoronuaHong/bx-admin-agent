/**
 * Post-exec dimension reconciliation (M2 Task 4).
 * Named entities from NL must appear in result cells or corresponding SQL filters.
 * Shared extraction with verify — no business synonym / channel allow-list.
 */
import { entityReferencedInSql, escapeRegExp, extractNamedEntities } from "./named-entities.js";

export type DimReconcileResult = {
  ok: boolean;
  missing: string[];
  named: string[];
  detail: string;
};

export { extractNamedEntities } from "./named-entities.js";
export { escapeRegExp };

function tableContains(tables: Array<{ cols: string[]; rows: unknown[][] }>, token: string): boolean {
  const needle = token.toLowerCase();
  for (const t of tables) {
    for (const row of t.rows) {
      for (const cell of row) {
        if (cell == null) continue;
        if (String(cell).toLowerCase() === needle) return true;
      }
    }
    for (const c of t.cols) {
      if (c.toLowerCase() === needle) return true;
    }
  }
  return false;
}

/**
 * If NL names ≥1 entity and results are non-empty:
 * each named entity must appear in some result cell, or be referenced in SQL.
 */
export function reconcileNamedDimensions(input: {
  nl: string;
  tables: Array<{ cols: string[]; rows: unknown[][] }>;
  sqls?: string[];
  dimColumns?: string[];
}): DimReconcileResult {
  const named = extractNamedEntities(input.nl);
  const totalRows = input.tables.reduce((n, t) => n + (t.rows?.length || 0), 0);
  if (!named.length || totalRows === 0) {
    return { ok: true, missing: [], named, detail: "skip" };
  }

  const sqls = input.sqls || [];
  const missing: string[] = [];
  for (const token of named) {
    if (tableContains(input.tables, token)) continue;
    if (sqls.some((s) => entityReferencedInSql(token, s, input.dimColumns))) continue;
    missing.push(token);
  }

  if (missing.length) {
    return {
      ok: false,
      missing,
      named,
      detail: `dim_mismatch: missing ${missing.join(",")}`,
    };
  }
  return { ok: true, missing: [], named, detail: "ok" };
}
