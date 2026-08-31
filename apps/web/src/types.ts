export interface TableColumnView {
  key: string;
  title: string;
  kind?: "text" | "image" | "id" | "number" | "money" | "date" | "badge";
  align?: "left" | "center" | "right";
  width?: number | string;
  ellipsis?: boolean;
}

export interface TableView {
  title: string;
  total: number;
  columns: TableColumnView[];
  rows: Array<Record<string, string> & { _depth?: number; _isFooter?: boolean }>;
  tree?: boolean;
  footer?: Record<string, string>;
}

export interface ChatFileRef {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "xlsx" | "pdf" | "other";
  url: string;
  previewUrl?: string;
}

export interface ChartSeriesView {
  name: string;
  data: number[];
  selected?: boolean;
  type?: "line" | "bar";
}

export interface ChartView {
  title: string;
  categories: string[];
  series: ChartSeriesView[];
  height?: number;
}
