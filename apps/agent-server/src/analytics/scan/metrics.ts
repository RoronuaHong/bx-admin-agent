import { config } from "../../config.js";
import { runNativeDataset } from "../metabase-client.js";
import { loadAnalyticsPack, packDefaultEntityKey, packTimeField } from "../semantic-layer.js";
import {
  assertReadonlySingleSelect,
  assertTablesWhitelisted,
  normalizeDistinctCount,
} from "../sql-guard.js";
import type { NativeDatasetRunner } from "./freshness.js";
import { assertYmd, normalizeDateCell } from "./freshness.js";
import type { ScanMetricRow } from "./threshold.js";

const IDENT_RE = /^[a-zA-Z_][\w]*$/;

/**
 * Every identifier is supplied by config (rule set `dimensions.rollup` + pack), never
 * defaulted in code — a different warehouse only changes config.
 */
export interface ChannelUsersSqlOpts {
  scanDate: string;
  dodDate: string;
  wowDate: string;
  /** Fact table (must be pack-whitelisted). */
  table: string;
  /** Group-by entity column (rule set `dimensions.rollup`). */
  entityField: string;
  /** Distinct-count column (pack entity key). */
  distinctField: string;
  /** Business time column (pack.time.field). */
  timeField: string;
  /** Optional equality filter, e.g. pack.guards.defaultMovieTypesField + defaultMovieTypes. */
  filterField?: string;
  filterValues?: number[];
  /** Distinct-count fn; default uniq. */
  distinctCountFn?: "uniq" | "uniqExact";
}

export type ChannelDailyUserRow = ScanMetricRow & { sample: number | null };

function ident(value: string | undefined, label: string): string {
  const v = String(value || "").trim();
  if (!IDENT_RE.test(v)) {
    throw new Error(`invalid ${label} identifier: ${v}`);
  }
  return v;
}

/**
 * One GROUP BY <entity> + date query covering scan / dod / wow days.
 * Pivot to per-entity scan/dod/wow values happens in JS.
 */
export function buildChannelUsersSql(opts: ChannelUsersSqlOpts): string {
  const scanDate = assertYmd(opts.scanDate, "scanDate");
  const dodDate = assertYmd(opts.dodDate, "dodDate");
  const wowDate = assertYmd(opts.wowDate, "wowDate");
  const table = ident(opts.table, "table");
  const entityField = ident(opts.entityField, "entityField");
  const distinctField = ident(opts.distinctField, "distinctField");
  const timeField = ident(opts.timeField, "timeField");
  const fn = opts.distinctCountFn ?? "uniq";

  let valueFilter = "";
  if (opts.filterValues?.length) {
    const filterField = ident(opts.filterField, "filterField");
    if (!opts.filterValues.every((n) => Number.isInteger(n))) {
      throw new Error("filterValues must be integers");
    }
    valueFilter = ` AND ${filterField} IN (${opts.filterValues.join(",")})`;
  }

  return [
    `SELECT ${entityField} AS entity_key, toDate(${timeField}) AS d, ${fn}(${distinctField}) AS users`,
    `FROM ${table}`,
    `WHERE toDate(${timeField}) IN ('${scanDate}', '${dodDate}', '${wowDate}')${valueFilter}`,
    `GROUP BY ${entityField}, d`,
  ].join(" ");
}

function colIndex(cols: string[], names: string[], fallback: number): number {
  const lower = cols.map((c) => String(c ?? "").toLowerCase());
  for (const name of names) {
    const i = lower.indexOf(name.toLowerCase());
    if (i >= 0) return i;
  }
  return fallback;
}

function toNumberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pivot (channel, date, users) rows into per-entity scan/dod/wow values.
 * sample = scanValue (for minSample quiet checks).
 */
export function pivotChannelDailyUsers(
  rows: unknown[][],
  cols: string[],
  scanDate: string,
  dodDate: string,
  wowDate: string,
): ChannelDailyUserRow[] {
  const scan = assertYmd(scanDate, "scanDate");
  const dod = assertYmd(dodDate, "dodDate");
  const wow = assertYmd(wowDate, "wowDate");

  const iKey = colIndex(cols, ["entity_key", "channel"], 0);
  const iDate = colIndex(cols, ["d", "date"], 1);
  const iUsers = colIndex(cols, ["users", "c"], 2);

  const byEntity = new Map<
    string,
    { scanValue: number | null; dodValue: number | null; wowValue: number | null }
  >();

  for (const row of rows) {
    const entityKey = String(row[iKey] ?? "").trim();
    if (!entityKey) continue;
    const d = normalizeDateCell(row[iDate]);
    if (!d) continue;
    const users = toNumberOrNull(row[iUsers]);
    let slot = byEntity.get(entityKey);
    if (!slot) {
      slot = { scanValue: null, dodValue: null, wowValue: null };
      byEntity.set(entityKey, slot);
    }
    if (d === scan) slot.scanValue = users;
    else if (d === dod) slot.dodValue = users;
    else if (d === wow) slot.wowValue = users;
  }

  return [...byEntity.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([entityKey, values]) => ({
      entityKey,
      scanValue: values.scanValue,
      dodValue: values.dodValue,
      wowValue: values.wowValue,
      sample: values.scanValue,
    }));
}

export interface FetchChannelDailyUsersOpts {
  packId?: string;
  /** Fact table; defaults to the pack's first modeled table. */
  table?: string;
  /** Group-by entity column; rule set `dimensions.rollup`. */
  entityField?: string;
  runDataset?: NativeDatasetRunner;
}

/**
 * Fetch the per-entity daily-users metric for scan/dod/wow via one native Metabase query.
 * Table / entity column / time column / filter column all come from config (pack + rule set).
 */
export async function fetchChannelDailyUsers(
  scanDate: string,
  dodDate: string,
  wowDate: string,
  opts?: FetchChannelDailyUsersOpts,
): Promise<ChannelDailyUserRow[]> {
  const pack = loadAnalyticsPack(opts?.packId || "watch-detail");
  const table = String(opts?.table || pack.tables[0]?.name || "").trim();
  const allowedTables = pack.tables.map((t) => t.name);
  if (!table || !allowedTables.includes(table)) {
    throw new Error(`table not in whitelist: ${table}`);
  }
  const filterField = String(pack.guards.defaultMovieTypesField || "").trim();

  let sql = buildChannelUsersSql({
    scanDate,
    dodDate,
    wowDate,
    table,
    entityField: String(opts?.entityField || "").trim(),
    distinctField: packDefaultEntityKey(pack),
    timeField: packTimeField(pack),
    filterField: filterField || undefined,
    filterValues: filterField ? pack.guards.defaultMovieTypes : undefined,
    distinctCountFn: config.metabase.distinctCountFn,
  });
  sql = normalizeDistinctCount(sql, config.metabase.distinctCountFn);
  assertReadonlySingleSelect(sql);
  assertTablesWhitelisted(sql, allowedTables);

  const run = opts?.runDataset ?? runNativeDataset;
  const res = await run(sql, pack.datasource.metabaseDatabaseId);
  if (!res.ok) {
    throw new Error(`channel_users_query_failed: ${res.error || "error"}`);
  }
  return pivotChannelDailyUsers(res.rows, res.cols, scanDate, dodDate, wowDate);
}
