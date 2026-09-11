export type DistinctCountFn = "uniq" | "uniqExact";

/** 多值过滤相对输出维的展示形态（完播宽/长表） */
export type ResultLayout = "wide" | "long";

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

export interface AnalyticsAskResult {
  status: "ok" | "clarify" | "refuse" | "error";
  message: string;
  timeEcho?: string;
  sqls?: string[];
  tables?: Array<{ title: string; cols: string[]; rows: unknown[][]; grain?: string }>;
  probeSummary?: string;
  /** 待填槽位 id（如 contentLang / completion_rate / time_range） */
  clarifySlot?: string;
  /** 澄清候选项（Probe） */
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
  /** @deprecated 保留兼容；语义结果见 semanticOk */
  verifySkipped?: "empty" | "disabled" | "intent_compile";
  /** SQL 来源：仅 Intent 确定性编译（不再 LLM 写 SQL） */
  sqlSource?: "intent_compile";
  /** 是否经对话 schema-agent 结构化 */
  structuredFromConversation?: boolean;
  /** 结构抽取模式：预探库单次 / tool-loop */
  structureMode?: "single_forward" | "tool_loop";
  /** 输出格式约束：json_object 或 prompt 解析兜底 */
  formatConstraint?: "json_object" | "prompt_parse";
  /** 语义校验是否通过（与 JSON 格式合法分开） */
  semanticOk?: boolean;
  semanticIssues?: string[];
  /** AskState working memory for follow-up revise */
  askState?: import("./ask-state.js").AskState;
  /** Turn intent notes (debug / UI) */
  turnKind?: string;
  /** Human-readable ask summary bar */
  askSummary?: string;
  /** Soft defaults applied this turn */
  defaultsNote?: string;
  /** 本地 ECharts 双轨图（无 Metabase temp card） */
  charts?: Array<{
    title: string;
    categories: string[];
    series: Array<{ name: string; data: number[]; selected?: boolean; type?: "line" | "bar" }>;
    height?: number;
  }>;
}
