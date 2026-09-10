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
  /** Ambiguity Gate：待填槽位 id（如 contentLang / completion_rate） */
  clarifySlot?: string;
  /** 澄清候选项（Probe / pack 枚举） */
  clarifyOptions?: Array<{ id: string; label: string }>;
  error?: string;
  /** M2 LLM 校对结论（可跳过 empty / 关闭 ANALYTICS_LLM_VERIFY） */
  verify?: { verdict: "pass" | "fail" | "unclear"; codes: string[]; reason: string };
  modelId?: string;
  packVersion?: string;
  /** M2 审计账本 id；UI 反馈挂靠 */
  askId?: string;
  /** 本问自纠错轮次（lint/empty/dim/verify） */
  rewriteRounds?: number;
  /** questionBinding 命中且未改写时跳过 LLM 校对 */
  verifySkipped?: "question_binding" | "empty" | "disabled" | "intent_compile";
  /** SQL 来源：绑定卡 / Intent 编译 / LLM */
  sqlSource?: "question_binding" | "intent_compile" | "llm";
  questionBinding?: { id: string; questionId?: number; rewritten: boolean };
  /** 本地 ECharts 双轨图（无 Metabase temp card） */
  charts?: Array<{
    title: string;
    categories: string[];
    series: Array<{ name: string; data: number[]; selected?: boolean; type?: "line" | "bar" }>;
    height?: number;
  }>;
}
