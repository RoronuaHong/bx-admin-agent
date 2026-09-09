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

/** Job lifecycle (§9.2.1): queued → running → terminal. */
export type ScanJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled"
  | "skipped";

/** Alert severity for scan parent/child alerts (§9.6). */
export type ScanAlertSeverity = "info" | "warn" | "critical";

/** Thin alert record attached to a job (full notify shape lands in Task 5). */
export interface ScanAlert {
  severity: ScanAlertSeverity;
  metric?: string;
  entityKey?: string;
  baseline?: BaselineKind;
  message: string;
  fingerprint?: string;
  parent?: boolean;
}

/** Optional rollup written when a job finishes. */
export interface ScanJobResultSummary {
  entityCount?: number;
  warnCount?: number;
  criticalCount?: number;
  skippedReason?: string;
  [key: string]: unknown;
}

/**
 * In-process scan job record (§9.2.1 / Task 2).
 * Timestamps are ISO-8601 strings.
 */
export interface ScanJob {
  jobId: string;
  ruleSetId: string;
  scanDate: string;
  status: ScanJobStatus;
  dryRun: boolean;
  forceRerun: boolean;
  rerunSeq: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  resultSummary?: ScanJobResultSummary;
  alerts?: ScanAlert[];
}
