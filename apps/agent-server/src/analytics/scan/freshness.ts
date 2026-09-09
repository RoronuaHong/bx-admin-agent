import { runNativeDataset } from "../metabase-client.js";
import { loadAnalyticsPack } from "../semantic-layer.js";
import { assertReadonlySingleSelect, assertTablesWhitelisted } from "../sql-guard.js";
import type { DatasetResult } from "../types.js";
import type { FreshnessCheck, RuleSet } from "./types.js";

export type NativeDatasetRunner = (
  sql: string,
  databaseId?: number,
) => Promise<DatasetResult>;

const IDENT_RE = /^[a-zA-Z_][\w]*$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate YYYY-MM-DD calendar date strings used in scan SQL. */
export function assertYmd(date: string, label = "date"): string {
  const trimmed = String(date ?? "").trim();
  if (!YMD_RE.test(trimmed)) {
    throw new Error(`invalid ${label}: ${date}`);
  }
  return trimmed;
}

/** Normalize Metabase/ClickHouse date cells to YYYY-MM-DD when possible. */
export function normalizeDateCell(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(value).trim();
  if (YMD_RE.test(s)) return s;
  const head = s.slice(0, 10);
  if (YMD_RE.test(head)) return head;
  return undefined;
}

/**
 * Build freshness probe SQL from ruleset freshnessCheck.
 * Default shape: SELECT max(toDate(lastWatchTime)) AS d FROM elt_watch_detail
 */
export function buildFreshnessSql(check: FreshnessCheck): string {
  if (check.type !== "max_business_date") {
    throw new Error(`unsupported freshnessCheck type: ${(check as { type: string }).type}`);
  }
  if (!IDENT_RE.test(check.table) || !IDENT_RE.test(check.column)) {
    throw new Error("invalid freshnessCheck table/column identifier");
  }
  return `SELECT max(toDate(${check.column})) AS d FROM ${check.table}`;
}

export interface FreshnessResult {
  ok: boolean;
  maxDate?: string;
  reason?: string;
}

/**
 * Data-ready gate (§9.4.1): ok when max(business date) >= scanDate.
 * Failures / missing max → ok=false with reason `data_not_ready` (or query error).
 */
export async function checkFreshness(
  ruleSet: RuleSet,
  scanDate: string,
  opts?: { runDataset?: NativeDatasetRunner; packId?: string },
): Promise<FreshnessResult> {
  const scan = assertYmd(scanDate, "scanDate");
  const pack = loadAnalyticsPack(opts?.packId || ruleSet.packId || "watch-detail");
  const allowedTables = pack.tables.map((t) => t.name);

  if (!allowedTables.includes(ruleSet.freshnessCheck.table)) {
    throw new Error(`table not in whitelist: ${ruleSet.freshnessCheck.table}`);
  }

  const sql = buildFreshnessSql(ruleSet.freshnessCheck);
  assertReadonlySingleSelect(sql);
  assertTablesWhitelisted(sql, allowedTables);

  const run = opts?.runDataset ?? runNativeDataset;
  const res = await run(sql, pack.datasource.metabaseDatabaseId);
  if (!res.ok) {
    return { ok: false, reason: `freshness_query_failed: ${res.error || "error"}` };
  }

  const raw = res.rows[0]?.[0];
  const maxDate = normalizeDateCell(raw);
  if (!maxDate) {
    return { ok: false, reason: "data_not_ready" };
  }
  if (maxDate >= scan) {
    return { ok: true, maxDate };
  }
  return { ok: false, maxDate, reason: "data_not_ready" };
}
