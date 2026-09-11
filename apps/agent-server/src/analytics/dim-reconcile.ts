/**
 * Post-exec dimension reconciliation.
 * Named entities from NL must appear in result cells or corresponding SQL filters.
 * AskState.requested members: when the dim column is present in results, SQL-only
 * is NOT enough — cells (or prior zero_fill) must cover them.
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

function tablesHaveDimColumn(
  tables: Array<{ cols: string[]; rows: unknown[][] }>,
  dim: string,
): boolean {
  const want = dim.toLowerCase();
  return tables.some((t) =>
    (t.cols || []).some((c) => c.toLowerCase() === want || c.toLowerCase().includes(want)),
  );
}

function sameToken(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * If NL names ≥1 entity and results are non-empty:
 * each named entity must appear in some result cell, or be referenced in SQL.
 * When `requiredInResults` is set and the dim column exists in tables,
 * those members must appear in cells (SQL mention alone fails).
 */
export function reconcileNamedDimensions(input: {
  nl: string;
  tables: Array<{ cols: string[]; rows: unknown[][] }>;
  sqls?: string[];
  dimColumns?: string[];
  /** AskState.requested members that must show in result cells when dim col present */
  requiredInResults?: string[];
  requiredDim?: string;
}): DimReconcileResult {
  const named = extractNamedEntities(input.nl);
  const totalRows = input.tables.reduce((n, t) => n + (t.rows?.length || 0), 0);
  if ((!named.length && !(input.requiredInResults || []).length) || totalRows === 0) {
    return { ok: true, missing: [], named, detail: "skip" };
  }

  const sqls = input.sqls || [];
  const required = [...new Set((input.requiredInResults || []).map(String).filter(Boolean))];
  const dim = input.requiredDim || "channel";
  const enforceRequiredInCells = required.length > 0 && tablesHaveDimColumn(input.tables, dim);
  const missing: string[] = [];

  if (enforceRequiredInCells) {
    for (const token of required) {
      if (!tableContains(input.tables, token)) missing.push(token);
    }
  }

  for (const token of named) {
    if (missing.some((m) => sameToken(m, token))) continue;
    if (tableContains(input.tables, token)) continue;
    if (enforceRequiredInCells && required.some((r) => sameToken(r, token))) {
      // already recorded above if absent
      continue;
    }
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
