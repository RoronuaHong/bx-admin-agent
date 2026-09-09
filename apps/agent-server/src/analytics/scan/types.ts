/** Baseline kinds for relative comparison (day-over-day / week-over-week). */
export type BaselineKind = "dod" | "wow";

/** How multiple baselines combine when deciding warn. */
export type BaselineLogic = "any" | "all";

/** Freshness probe: max business date on a whitelisted fact table/column. */
export interface FreshnessCheckMaxBusinessDate {
  type: "max_business_date";
  table: string;
  column: string;
}

export type FreshnessCheck = FreshnessCheckMaxBusinessDate;

/** Dimensions for rollup (and optional future drilldown). */
export interface RuleSetDimensions {
  rollup: string;
  drilldown?: string[];
}

/**
 * Configurable scan rule set (§9.3).
 * Thresholds and formulas live in config — not hard-coded in runner logic.
 */
export interface RuleSet {
  id: string;
  metrics: string[];
  baselines: BaselineKind[];
  baselineLogic: BaselineLogic;
  /** Warn when current/baseline ratio is strictly below this (e.g. 0.9 = >10% drop). */
  thresholdRatio: number;
  minAbsDelta: number;
  minSample: number;
  criticalEntityCount: number;
  dimensions: RuleSetDimensions;
  maxChildAlerts: number;
  businessTimezone: string;
  jobTimeoutMs: number;
  freshnessCheck: FreshnessCheck;
  packId: string;
  persistCard: boolean;
}

/**
 * Closed business-day window for a scan.
 * Dates are calendar YYYY-MM-DD in `businessTimezone` (not server local).
 */
export interface ScanWindow {
  scanDate: string;
  dodDate: string;
  wowDate: string;
  echo: string;
}

export interface ResolveScanWindowOpts {
  clock: Date;
  /** IANA timezone used to cut calendar days (e.g. Asia/Shanghai). */
  tz: string;
  /** Explicit closed business day; default = T-1 in `tz`. */
  scanDate?: string;
}
