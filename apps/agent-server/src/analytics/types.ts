export type DistinctCountFn = "uniq" | "uniqExact";

export interface DatasetResult {
  ok: boolean;
  cols: string[];
  rows: unknown[][];
  error?: string;
  ms?: number;
}

export interface TimeRange {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD inclusive for UX; convert to [start,end) in SQL helpers if needed
  echo: string; // e.g. "按 2026-08-19～25"
}

export interface AnalyticsSlots {
  time_range?: TimeRange;
  metrics: string[];
  dimensions: string[];
  filters: Record<string, string[]>;
  need_parallel?: boolean;
  clarify?: string;
}

export interface AnalyticsAskResult {
  status: "ok" | "clarify" | "refuse" | "error";
  message: string;
  timeEcho?: string;
  sqls?: string[];
  tables?: Array<{ title: string; cols: string[]; rows: unknown[][]; grain?: string }>;
  probeSummary?: string;
  error?: string;
}
