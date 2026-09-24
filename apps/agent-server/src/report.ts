// 通用报表合成器（最佳实践：交互式查看与静态导出分离，导出物自包含、零外链）。
//
// 设计要点：
// - 把「交付内容」抽象成一份结构化源：叙述段落(sections, markdown) + 表格(tables) + 图表(charts: ChartSpec[])。
// - 同一份源可渲染成多种格式（html / pdf / docx），与 Quarto / Jupyter nbconvert「一份源 → 多格式」同构。
// - 图表在导出时**烘焙成静态矢量**（内联 SVG），而不是把活 JS 塞进文件——离线可开、挪动不丢图。
// - 文本叙述走自带的最小 markdown 渲染，零依赖。
import type { ChartSpec } from "@bx/shared";

const PALETTE = [
  "#5B8FF9", "#61DDAA", "#F6BD16", "#E8684A", "#9270CA",
  "#FF9D4D", "#269A99", "#FF99C3", "#3BA0FF", "#C0E36B",
];

export function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// 最小 markdown → HTML（覆盖分析报告常用的：标题 / 列表 / 段落 / 强调 / 行内代码 /
// 链接 / 代码块 / 表格）。零依赖，够用即可。
// ---------------------------------------------------------------------------
export function renderMarkdown(md: string): string {
  if (!md) return "";
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let listType: "ul" | "ol" | null = null;
  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };
  while (i < lines.length) {
    const line = lines[i];
    // 代码块
    if (/^```/.test(line.trim())) {
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++; // 跳过结束 ```
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }
    // 空行
    if (!line.trim()) { closeList(); i++; continue; }
    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    // 表格（以 | 分隔，且下一行是分隔行）
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      closeList();
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
      out.push(
        "<table><thead><tr>" +
          head.map((c) => `<th>${inline(c)}</th>`).join("") +
          "</tr></thead><tbody>" +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
          "</tbody></table>",
      );
      continue;
    }
    // 无序列表
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
      out.push(`<li>${inline(ul[1])}</li>`);
      i++; continue;
    }
    // 有序列表
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
      out.push(`<li>${inline(ol[1])}</li>`);
      i++; continue;
    }
    // 段落（合并连续非空、非特殊行）
    closeList();
    const para: string[] = [line];
    i++;
    while (
      i < lines.length && lines[i].trim() &&
      !/^(#{1,4})\s+/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) && !/^```/.test(lines[i].trim()) &&
      !(lines[i].includes("|") && i + 1 < lines.length && lines[i + 1].includes("-"))
    ) { para.push(lines[i]); i++; }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  closeList();
  return out.join("\n");
}

function splitRow(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function inline(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*(?!\*)(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+?)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$1">$2</a>');
}

// ---------------------------------------------------------------------------
// ChartSpec → 内联 SVG（覆盖高频图族：line / area / column / bar / pie / scatter /
// histogram；其余图族降级为数据表，保证「内容不丢」）。
// ---------------------------------------------------------------------------
const SVG_CHART_TYPES = new Set(["line", "area", "column", "bar", "pie", "scatter", "histogram"]);

export function isSvgChart(spec: ChartSpec): boolean {
  return SVG_CHART_TYPES.has(spec.chartType);
}

function asRows(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const f = v / base;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * base;
}

export function renderChartSvg(spec: ChartSpec): string | null {
  if (!isSvgChart(spec)) return null;
  const rows = asRows(spec.data);
  if (!rows.length) return null;
  const enc = spec.encode || {};
  const opts = spec.options || {};
  const xKey = enc.x || Object.keys(rows[0]).find((k) => k !== enc.y && k !== enc.series && k !== enc.color) || Object.keys(rows[0])[0];
  const yKey = enc.y || Object.keys(rows[0]).find((k) => k !== xKey) || Object.keys(rows[0])[1];
  const seriesKey = enc.series || enc.color;
  const unit = String(opts.unit || "");

  if (spec.chartType === "pie") return renderPie(rows, xKey, yKey, spec.title);
  return renderAxis(rows, xKey, yKey, seriesKey, spec.chartType, spec.title, opts, unit);
}

function renderAxis(
  rows: Record<string, unknown>[],
  xKey: string,
  yKey: string,
  seriesKey: string | undefined,
  type: string,
  title: string | undefined,
  opts: Record<string, unknown>,
  unit: string,
): string {
  const W = 760, H = 420, L = 60, R = 20, T = 28, B = 60;
  const pw = W - L - R, ph = H - T - B;
  const cats = [...new Set(rows.map((r) => String(r[xKey])))];
  const series = seriesKey ? [...new Set(rows.map((r) => String(r[seriesKey])))] : ["__single__"];
  const valOf = (r: Record<string, unknown>, s?: string) =>
    seriesKey ? String(r[seriesKey]) === (s === "__single__" ? series[0] : s) : true;
  const maxV = niceMax(Math.max(1, ...rows.map((r) => num(r[yKey]))));
  const xOf = (i: number) => L + (cats.length === 1 ? pw / 2 : (i + 0.5) / cats.length * pw);
  const yOf = (v: number) => T + ph * (1 - v / maxV);

  const parts: string[] = [];
  // 网格 + y 轴刻度
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const v = (maxV / ticks) * t;
    const y = yOf(v);
    parts.push(`<line x1="${L}" y1="${y}" x2="${L + pw}" y2="${y}" stroke="#EEF0F3" />`);
    parts.push(`<text x="${L - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="#8A94A6">${fmt(v)}${unit}</text>`);
  }
  // 轴线
  parts.push(`<line x1="${L}" y1="${T}" x2="${L}" y2="${T + ph}" stroke="#C9CED6" />`);
  parts.push(`<line x1="${L}" y1="${T + ph}" x2="${L + pw}" y2="${T + ph}" stroke="#C9CED6" />`);
  // x 轴标签
  cats.forEach((c, i) => {
    const x = xOf(i);
    const label = c.length > 8 ? c.slice(0, 7) + "…" : c;
    parts.push(`<text x="${x}" y="${T + ph + 18}" text-anchor="middle" font-size="11" fill="#525A66">${escapeHtml(label)}</text>`);
  });

  if (type === "bar") {
    // 水平柱状
    const band = ph / cats.length;
    cats.forEach((c, i) => {
      series.forEach((s, si) => {
        const r = rows.find((rr) => String(rr[xKey]) === c && valOf(rr, s));
        if (!r) return;
        const v = num(r[yKey]);
        const h = (v / maxV) * (pw - 40);
        const y = T + i * band + 6;
        const w = band - 12;
        const x = L + 20;
        parts.push(`<rect x="${x}" y="${y + si * (w / series.length)}" width="${h}" height="${w / series.length - 3}" fill="${PALETTE[(si) % PALETTE.length]}" rx="2" />`);
        parts.push(`<text x="${x + h + 4}" y="${y + si * (w / series.length) + (w / series.length) / 2 + 4}" font-size="10" fill="#525A66">${fmt(v)}</text>`);
      });
    });
  } else if (type === "column") {
    const band = pw / cats.length;
    const inner = Math.min(48, band - 12);
    cats.forEach((c, i) => {
      series.forEach((s, si) => {
        const r = rows.find((rr) => String(rr[xKey]) === c && valOf(rr, s));
        if (!r) return;
        const v = num(r[yKey]);
        const bh = (v / maxV) * (ph - 10);
        const bw = inner / series.length;
        const x = L + i * band + (band - inner) / 2 + si * bw;
        const y = T + ph - bh;
        parts.push(`<rect x="${x}" y="${y}" width="${bw - 3}" height="${bh}" fill="${PALETTE[si % PALETTE.length]}" rx="2" />`);
      });
    });
  } else {
    // line / area / scatter / histogram：按序列画折线/面积/点
    series.forEach((s, si) => {
      const color = PALETTE[si % PALETTE.length];
      const pts = cats.map((c, i) => {
        const r = rows.find((rr) => String(rr[xKey]) === c && valOf(rr, s));
        return r ? { x: xOf(i), y: yOf(num(r[yKey])), v: num(r[yKey]) } : null;
      }).filter(Boolean) as { x: number; y: number; v: number }[];
      if (!pts.length) return;
      if (type === "area") {
        const base = T + ph;
        const d = `M${pts[0].x},${base} ` + pts.map((p) => `L${p.x},${p.y}`).join(" ") + ` L${pts[pts.length - 1].x},${base} Z`;
        parts.push(`<path d="${d}" fill="${color}" fill-opacity="0.18" />`);
      }
      if (type === "line" || type === "area") {
        parts.push(`<polyline points="${pts.map((p) => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2.2" />`);
      }
      if (type === "scatter" || type === "histogram" || type === "line" || type === "area") {
        for (const p of pts) {
          parts.push(`<circle cx="${p.x}" cy="${p.y}" r="${type === "scatter" ? 4 : 3}" fill="${color}" />`);
          if (type === "scatter") parts.push(`<text x="${p.x + 6}" y="${p.y - 6}" font-size="10" fill="#525A66">${fmt(p.v)}</text>`);
        }
      }
    });
  }

  const xTitle = String(opts.xTitle || "");
  const yTitle = String(opts.yTitle || "");
  if (xTitle) parts.push(`<text x="${L + pw / 2}" y="${H - 12}" text-anchor="middle" font-size="12" fill="#525A66">${escapeHtml(xTitle)}</text>`);
  if (yTitle) parts.push(`<text x="14" y="${T + ph / 2}" text-anchor="middle" font-size="12" fill="#525A66" transform="rotate(-90 14 ${T + ph / 2})">${escapeHtml(yTitle)}</text>`);
  // 图例
  if (series.length > 1 && series[0] !== "__single__") {
    let lx = L + 4;
    series.forEach((s, si) => {
      parts.push(`<rect x="${lx}" y="${T - 18}" width="10" height="10" fill="${PALETTE[si % PALETTE.length]}" rx="2" />`);
      parts.push(`<text x="${lx + 14}" y="${T - 9}" font-size="11" fill="#525A66">${escapeHtml(s)}</text>`);
      lx += 24 + escapeHtml(s).length * 7;
    });
  }

  return wrapSvg(W, H, title, parts.join(""));
}

function renderPie(
  rows: Record<string, unknown>[],
  nameKey: string,
  valKey: string,
  title: string | undefined,
): string {
  const W = 760, H = 420, cx = 220, cy = 220, radius = 150;
  const total = rows.reduce((a, row) => a + num(row[valKey]), 0) || 1;
  let angle = -Math.PI / 2;
  const parts: string[] = [];
  rows.forEach((row, i) => {
    const v = num(row[valKey]);
    const frac = v / total;
    const a2 = angle + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x1 = cx + radius * Math.cos(angle), y1 = cy + radius * Math.sin(angle);
    const x2 = cx + radius * Math.cos(a2), y2 = cy + radius * Math.sin(a2);
    parts.push(`<path d="M${cx},${cy} L${x1},${y1} A${radius},${radius} 0 ${large} 1 ${x2},${y2} Z" fill="${PALETTE[i % PALETTE.length]}" />`);
    angle = a2;
  });
  // 图例
  let ly = Tlegend(cy, rows.length);
  rows.forEach((row, i) => {
    const v = num(row[valKey]);
    const pct = ((v / total) * 100).toFixed(1);
    parts.push(`<rect x="${cx + radius + 40}" y="${ly}" width="12" height="12" fill="${PALETTE[i % PALETTE.length]}" rx="2" />`);
    parts.push(`<text x="${cx + radius + 58}" y="${ly + 11}" font-size="12" fill="#525A66">${escapeHtml(String(row[nameKey]))} ${pct}%</text>`);
    ly += 22;
  });
  return wrapSvg(W, H, title, parts.join(""));
}

function Tlegend(cy: number, n: number): number {
  return cy - Math.min(n, 12) * 11;
}

function wrapSvg(W: number, H: number, title: string | undefined, body: string): string {
  return (
    `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img"${title ? ` aria-label="${escapeHtml(title)}"` : ""}>` +
    (title ? `<text x="0" y="18" font-size="14" font-weight="600" fill="#1F2329">${escapeHtml(title)}</text>` : "") +
    body +
    `</svg>`
  );
}

function fmt(v: number): string {
  if (Math.abs(v) >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (!Number.isInteger(v)) return v.toFixed(1);
  return String(v);
}

// ---------------------------------------------------------------------------
// 降级：把不支持的图表族渲染成数据表（保证内容不丢）。
// ---------------------------------------------------------------------------
export function chartDataMatrix(spec: ChartSpec): string[][] {
  const rows = asRows(spec.data);
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]);
  return [cols, ...rows.map((r) => cols.map((c) => String(r[c] ?? "")))];
}

function renderFallbackTable(spec: ChartSpec): string {
  const m = chartDataMatrix(spec);
  if (!m.length) return `<p class="chart-fallback">（无可渲染数据）</p>`;
  return (
    `<p class="chart-fallback">（该图型「${escapeHtml(spec.chartType)}」暂以数据表呈现）</p>` +
    "<table><thead><tr>" + m[0].map((c) => `<th>${escapeHtml(c)}</th>`).join("") + "</tr></thead><tbody>" +
    m.slice(1).map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("") +
    "</tbody></table>"
  );
}

// ---------------------------------------------------------------------------
// 自包含 HTML 报告合成器（零外链：内联样式 + 内联 SVG）。
// ---------------------------------------------------------------------------
export interface ReportTable { name: string; matrix: unknown[][] }
export interface BuildHtmlReportOpts {
  title?: string;
  sections?: string[]; // markdown 段落
  tables?: ReportTable[];
  charts?: ChartSpec[];
}

export function buildHtmlReport(opts: BuildHtmlReportOpts): string {
  const title = opts.title || "数据分析报告";
  const lang = /[\u3400-\u9FFF]/.test(title) ? "zh-CN" : "en";
  const blocks: string[] = [];

  for (const sec of opts.sections || []) {
    const html = renderMarkdown(sec).trim();
    if (html) blocks.push(`<section class="section">${html}</section>`);
  }
  for (const c of opts.charts || []) {
    const svg = renderChartSvg(c);
    blocks.push(
      `<figure class="chart">${svg ?? renderFallbackTable(c)}` +
        (c.title && !svg ? "" : "") +
        `</figure>`,
    );
  }
  for (const t of opts.tables || []) {
    const head = t.matrix[0] || [];
    const body = t.matrix.slice(1);
    blocks.push(
      `<section class="section"><table>` +
        `<thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>` +
        `<tbody>${body.map((r) => `<tr>${head.map((_, i) => `<td>${escapeHtml(r[i] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>` +
        `</table></section>`,
    );
  }

  return [
    "<!doctype html>",
    `<html lang="${lang}">`,
    "<head>",
    '<meta charset="utf-8" />',
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    "body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;margin:28px;color:#1f2329;line-height:1.6}",
    "h1{font-size:22px;margin:0 0 20px}",
    "h2{font-size:17px;margin:22px 0 10px}",
    "h3{font-size:15px;margin:16px 0 8px}",
    "p{margin:8px 0}",
    "ul,ol{margin:8px 0;padding-left:22px}",
    "code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:13px}",
    "pre{background:#f7f8fa;border:1px solid #eaecef;padding:12px;border-radius:8px;overflow:auto}",
    "pre code{background:none;padding:0}",
    "table{border-collapse:collapse;width:100%;font-size:13px;margin:10px 0}",
    "th,td{border:1px solid #dcdfe6;padding:6px 10px;text-align:left;vertical-align:top}",
    "th{background:#f5f7fa;font-weight:600}",
    "tr:nth-child(even) td{background:#fafbfc}",
    "figure.chart{margin:18px 0;padding:12px;border:1px solid #eef0f3;border-radius:10px;background:#fff}",
    "figure.chart svg{width:100%;height:auto;display:block}",
    ".chart-fallback{color:#8a94a6;font-size:13px;margin:0 0 8px}",
    "a{color:#3370ff}",
    "</style>",
    "</head>",
    "<body>",
    `<h1>${escapeHtml(title)}</h1>`,
    ...blocks,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 供 PDF / DOCX 复用：把图表烘焙成 SVG 字符串数组（支持的类型）或数据表矩阵（降级）。
// ---------------------------------------------------------------------------
export function chartSvgs(charts: ChartSpec[] = []): string[] {
  return charts.map((c) => renderChartSvg(c)).filter((s): s is string => !!s);
}

export function chartFallbackTables(charts: ChartSpec[] = []): Array<{ title?: string; matrix: string[][] }> {
  return charts
    .filter((c) => !isSvgChart(c))
    .map((c) => ({ title: c.title, matrix: chartDataMatrix(c) }));
}
