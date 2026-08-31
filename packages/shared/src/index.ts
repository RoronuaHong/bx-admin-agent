export type CountryId = string;

export type BaseUrlKey = "backend" | "user" | "film" | "gather";

export interface CountryPublic {
  id: CountryId;
  label: string;
}

export interface CountryConfig extends CountryPublic {
  backendUrl: string;
  userUrl: string;
  filmUrl: string;
  /** 爬虫/影片匹配服务基址（getGatherUrl/getMovieMatchUrl），如影片上传自动化等 gather 系接口 */
  gatherUrl?: string;
}

export interface SessionUser {
  id?: string | number;
  loginName: string;
  name: string;
}

/** 聊天内结构化表格（含树层级 / 表尾） */
export interface ChatTableColumn {
  key: string;
  title: string;
  kind?: "text" | "image" | "id" | "number" | "money" | "date" | "badge";
  align?: "left" | "center" | "right";
  width?: number | string;
  ellipsis?: boolean;
}

export interface ChatTableRow {
  [key: string]: string | number | boolean | null | undefined;
  _depth?: number;
  _isFooter?: boolean;
}

export interface ChatTableView {
  title: string;
  total: number;
  columns: ChatTableColumn[];
  rows: ChatTableRow[];
  tree?: boolean;
  footer?: Record<string, string>;
}

/** 聊天内可预览/下载的文件 */
export interface ChatFileRef {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "xlsx" | "pdf" | "other";
  /** 相对 agent 前缀的下载路径，如 /chat/download/:id */
  url: string;
  /** PDF 可同 url 预览 */
  previewUrl?: string;
}

/** 聊天内 ECharts 折线/柱图（对齐 PC Analysis canvas） */
export interface ChatChartSeries {
  name: string;
  data: number[];
  /** 默认是否选中（图例），与 PC Analysis selected 一致 */
  selected?: boolean;
  type?: "line" | "bar";
}

export interface ChatChartView {
  title: string;
  categories: string[];
  series: ChatChartSeries[];
  height?: number;
}

// SSE 事件契约（server → web）。
export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "model"; id: string; label: string; reason?: "image" | "fallback" }
  | { type: "error"; message: string; code?: string | number }
  | { type: "tool_call"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: string }
  | { type: "confirmation_required"; callId: string; name: string; input: Record<string, unknown>; description: string; impact?: { highRisk: boolean; target: string; count: number } }
  | { type: "confirmation_response"; callId: string; confirmed: boolean }
  | { type: "table"; table: ChatTableView }
  | { type: "file"; file: ChatFileRef }
  | { type: "chart"; chart: ChatChartView }
  | { type: "done" };
