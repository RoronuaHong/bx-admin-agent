/**
 * Analytics M2 Task 6 — local chart track (no Metabase temp card).
 * Convert result tables → ChartView when there is a category/date X + numeric Y.
 */
export type AnalyticsChartSeries = {
  name: string;
  data: number[];
  selected?: boolean;
  type?: "line" | "bar";
};

export type AnalyticsChartView = {
  title: string;
  categories: string[];
  series: AnalyticsChartSeries[];
  height?: number;
};

type TableLike = {
  title?: string;
  cols: string[];
  rows: unknown[][];
  grain?: string;
};

const DATEISH =
  /^(d|day|date|statdate|stat_date|lastwatchtime|dt|周期|日期|天)$/i;
const DIMISH =
  /^(channel|contentlang|lang|language|package|packname|name|label|title|category|dim|渠道|语言|包)$/i;

function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  const s = String(v ?? "").trim().replace(/,/g, "");
  if (!s || s === "-" || s === "null") return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function colLooksDate(name: string, sample: unknown[]): boolean {
  if (DATEISH.test(name)) return true;
  let dateHits = 0;
  for (const cell of sample.slice(0, 8)) {
    const s = String(cell ?? "");
    if (/^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{4}\/\d{2}\/\d{2}/.test(s)) dateHits++;
  }
  return dateHits >= Math.min(2, sample.length);
}

function colLooksDim(name: string): boolean {
  return DIMISH.test(name);
}

function isMostlyNumeric(values: unknown[]): boolean {
  if (!values.length) return false;
  let ok = 0;
  for (const v of values) {
    if (Number.isFinite(toNum(v))) ok++;
  }
  return ok >= Math.ceil(values.length * 0.8);
}

/**
 * Pick X column index: prefer date-ish, then dim-ish non-numeric, else first non-numeric.
 */
export function pickCategoryColIndex(cols: string[], rows: unknown[][]): number {
  if (!cols.length || !rows.length) return -1;
  const samples = cols.map((_, ci) => rows.map((r) => r[ci]));

  for (let i = 0; i < cols.length; i++) {
    if (colLooksDate(cols[i], samples[i]) && !isMostlyNumeric(samples[i])) return i;
  }
  for (let i = 0; i < cols.length; i++) {
    if (colLooksDim(cols[i]) && !isMostlyNumeric(samples[i])) return i;
  }
  for (let i = 0; i < cols.length; i++) {
    if (!isMostlyNumeric(samples[i])) return i;
  }
  return -1;
}

export function pickMetricColIndexes(
  cols: string[],
  rows: unknown[][],
  xIndex: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < cols.length; i++) {
    if (i === xIndex) continue;
    const sample = rows.map((r) => r[i]);
    if (isMostlyNumeric(sample)) out.push(i);
  }
  return out;
}

/** Prefer line for day grain / date X; bar for short categorical ranks. */
export function preferChartType(
  grain: string | undefined,
  xCol: string,
  categoryCount: number,
): "line" | "bar" {
  if (grain === "day" || DATEISH.test(xCol)) return "line";
  if (categoryCount <= 12) return "bar";
  return "line";
}

/**
 * Build at most one chart per table when structure is chartable.
 * Skips empty / single-metric-without-category / all-text tables.
 */
export function buildLocalChartFromTable(table: TableLike, opts?: { maxPoints?: number }): AnalyticsChartView | null {
  const cols = table.cols || [];
  const maxPoints = Math.max(2, opts?.maxPoints ?? 60);
  const rows = (table.rows || []).slice(0, maxPoints);
  if (cols.length < 2 || rows.length < 1) return null;

  const xIndex = pickCategoryColIndex(cols, rows);
  if (xIndex < 0) return null;
  const metricIndexes = pickMetricColIndexes(cols, rows, xIndex);
  if (!metricIndexes.length) return null;

  const categories = rows.map((r) => String(r[xIndex] ?? ""));
  // Need at least one non-empty category label
  if (!categories.some((c) => c.trim())) return null;

  const chartType = preferChartType(table.grain, cols[xIndex], categories.length);
  const series: AnalyticsChartSeries[] = metricIndexes.map((mi, i) => ({
    name: cols[mi] || `m${mi}`,
    data: rows.map((r) => {
      const n = toNum(r[mi]);
      return Number.isFinite(n) ? n : 0;
    }),
    selected: i === 0,
    type: chartType,
  }));

  return {
    title: table.title || "结果图",
    categories,
    series,
    height: 280,
  };
}

export function buildLocalChartsFromTables(
  tables: TableLike[] | undefined,
  opts?: { maxPoints?: number; maxCharts?: number },
): AnalyticsChartView[] {
  if (!tables?.length) return [];
  const maxCharts = Math.max(1, opts?.maxCharts ?? 4);
  const out: AnalyticsChartView[] = [];
  for (const t of tables) {
    if (out.length >= maxCharts) break;
    const chart = buildLocalChartFromTable(t, opts);
    if (chart) out.push(chart);
  }
  return out;
}

/** Short text hint for ledger / message (not a full summarize_chart_data dump). */
export function chartTrackNote(charts: AnalyticsChartView[]): string | undefined {
  if (!charts.length) return undefined;
  const parts = charts.map((c) => {
    const metric = c.series[0]?.name || "metric";
    return `${c.title}: ${c.categories.length} 点 × ${c.series.length} 序列（${metric}…）`;
  });
  return `本地图（无 Metabase card）：${parts.join("；")}`;
}
