import { config } from "../../config.js";
import { runNativeDataset } from "../metabase-client.js";
import { loadAnalyticsPack, packTimeField } from "../semantic-layer.js";
import {
  assertReadonlySingleSelect,
  assertTablesWhitelisted,
  normalizeDistinctCount,
} from "../sql-guard.js";
import type { NativeDatasetRunner } from "./freshness.js";
import { assertYmd, normalizeDateCell } from "./freshness.js";
import type { ScanMetricRow } from "./threshold.js";

const IDENT_RE = /^[a-zA-Z_][\w]*$/;
const DEFAULT_TABLE = "elt_watch_detail";

export interface ChannelUsersSqlOpts {
  scanDate: string;
  dodDate: string;
  wowDate: string;
  /** Fact table (must be pack-whitelisted). Default elt_watch_detail. */
  table?: string;
  /** Optional movieType IN (…) from pack.guards.defaultMovieTypes. */
  movieTypes?: number[];
  /** Distinct-count fn; default uniq. */
  distinctCountFn?: "uniq" | "uniqExact";
  /** Business time column; default lastWatchTime. */
  timeField?: string;
}

export type ChannelDailyUserRow = ScanMetricRow & { sample: number | null };

/**
 * One GROUP BY channel + date query covering scan / dod / wow days.
 * Pivot to per-channel scan/dod/wow values happens in JS.
 */
export function buildChannelUsersSql(opts: ChannelUsersSqlOpts): string {
  const table = opts.table ?? DEFAULT_TABLE;
  if (!IDENT_RE.test(table)) {
    throw new Error(`invalid table identifier: ${table}`);
  }
  const scanDate = assertYmd(opts.scanDate, "scanDate");
  const dodDate = assertYmd(opts.dodDate, "dodDate");
  const wowDate = assertYmd(opts.wowDate, "wowDate");
  const fn = opts.distinctCountFn ?? "uniq";
  const timeField = opts.timeField || "lastWatchTime";
  if (!IDENT_RE.test(timeField)) {
    throw new Error(`invalid timeField identifier: ${timeField}`);
  }

  let movieFilter = "";
  if (opts.movieTypes?.length) {
    if (!opts.movieTypes.every((n) => Number.isInteger(n))) {
      throw new Error("movieTypes must be integers");
    }
    movieFilter = ` AND movieType IN (${opts.movieTypes.join(",")})`;
  }

  return [
    `SELECT channel AS entity_key, toDate(${timeField}) AS d, ${fn}(guid) AS users`,
    `FROM ${table}`,
    `WHERE toDate(${timeField}) IN ('${scanDate}', '${dodDate}', '${wowDate}')${movieFilter}`,
    `GROUP BY channel, d`,
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
  table?: string;
  runDataset?: NativeDatasetRunner;
}

/**
 * Fetch channel_daily_users for scan/dod/wow via one native Metabase query.
 * Whitelists pack tables; applies defaultMovieTypes when present.
 */
export async function fetchChannelDailyUsers(
  scanDate: string,
  dodDate: string,
  wowDate: string,
  opts?: FetchChannelDailyUsersOpts,
): Promise<ChannelDailyUserRow[]> {
  const pack = loadAnalyticsPack(opts?.packId || "watch-detail");
  const table = opts?.table ?? DEFAULT_TABLE;
  const allowedTables = pack.tables.map((t) => t.name);
  if (!allowedTables.includes(table)) {
    throw new Error(`table not in whitelist: ${table}`);
  }

  let sql = buildChannelUsersSql({
    scanDate,
    dodDate,
    wowDate,
    table,
    movieTypes: pack.guards.defaultMovieTypes,
    distinctCountFn: config.metabase.distinctCountFn,
    timeField: packTimeField(pack),
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
