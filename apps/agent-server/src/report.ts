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
export interface ReportKpi {
  label: string;          // 指标名（如「泰米尔人均时长」）—— 由调用方显式提供
  value: string;          // 指标值（如「68.8 分钟」）—— 由调用方显式提供
  delta?: string;         // 同比/环比提示（如「+2.1%」「较上周 -3min」）
  hint?: string;          // 补充说明（如「近 7 日」）
  tone?: "up" | "down" | "flat"; // 涨跌色：不传则按 delta 文案启发式判定
}
export interface BuildHtmlReportOpts {
  title?: string;
  sections?: string[]; // markdown 段落
  tables?: ReportTable[];
  charts?: ChartSpec[];
  kpis?: ReportKpi[];  // 可选 KPI 概要卡：仅当调用方显式传入才渲染，工具不自动推算（避免编造）
}

// 零外链设计系统：内联 CSS 变量 + 卡片化 + Hero + KPI 网格 + 打印友好。
// 全部用系统字体栈，不引任何 CDN / web font；图表为内联 SVG（report.ts 烘焙）。
// 与 §11.2 原则 1「导出物自包含、零外链」一致；同时保证 Ctrl+P 可干净存 PDF。
export const REPORT_CSS = `
:root{
  --bg:#F4F6F9; --card:#FFFFFF; --ink:#1D2129; --ink-2:#4E5969; --muted:#86909C;
  --line:#E5E6EB; --line-2:#F2F3F5; --brand:#3370FF; --brand-ink:#1D4ED8; --brand-soft:#EAF1FF;
  --up:#00B42A; --down:#F53F3F; --radius:14px; --radius-sm:10px;
  --shadow:0 1px 2px rgba(20,30,60,.04),0 8px 24px rgba(20,30,60,.06);
  --maxw:980px;
  --font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font-family:var(--font);line-height:1.65;font-size:15px;-webkit-font-smoothing:antialiased}
.page{max-width:var(--maxw);margin:0 auto;padding:32px 24px 56px}
.hero{position:relative;background:linear-gradient(135deg,#3370FF 0%,#5B8FF9 100%);color:#fff;border-radius:var(--radius);padding:30px 32px;box-shadow:var(--shadow);overflow:hidden;margin-bottom:24px}
.hero::after{content:"";position:absolute;right:-40px;top:-50px;width:190px;height:190px;border-radius:50%;background:rgba(255,255,255,.12)}
.hero h1{font-size:26px;line-height:1.3;margin:0;font-weight:700;letter-spacing:.4px;position:relative}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:0 0 24px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-sm);padding:16px 18px;box-shadow:var(--shadow)}
.kpi-label{font-size:12.5px;color:var(--muted);margin-bottom:8px}
.kpi-value{font-size:24px;font-weight:700;color:var(--ink);line-height:1.1}
.kpi-delta{font-size:12px;margin-top:6px;font-weight:600}
.kpi-delta.up{color:var(--up)} .kpi-delta.down{color:var(--down)} .kpi-delta.flat{color:var(--muted)}
.kpi-hint{font-size:11.5px;color:var(--muted);margin-top:6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:20px 22px;box-shadow:var(--shadow);margin:0 0 20px;page-break-inside:avoid}
.card > :first-child{margin-top:0} .card > :last-child{margin-bottom:0}
h1,h2,h3{color:var(--ink)}
h2{font-size:18px;margin:0 0 12px;padding-left:11px;border-left:4px solid var(--brand);line-height:1.4}
h3{font-size:15px;margin:18px 0 8px;color:var(--ink-2)}
p{margin:8px 0;color:var(--ink-2)}
ul,ol{margin:8px 0;padding-left:22px;color:var(--ink-2)}
li{margin:4px 0}
strong{color:var(--ink)}
code{background:var(--line-2);padding:1px 6px;border-radius:5px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
pre{background:#0F172A;color:#E2E8F0;padding:14px;border-radius:var(--radius-sm);overflow:auto}
pre code{background:none;padding:0;color:inherit}
blockquote{border-left:3px solid var(--brand);background:var(--brand-soft);margin:10px 0;padding:8px 14px;color:var(--ink-2);border-radius:0 var(--radius-sm) var(--radius-sm) 0}
a{color:var(--brand-ink);text-decoration:none}
a:hover{text-decoration:underline}
table{border-collapse:collapse;width:100%;font-size:13.5px;margin:6px 0}
th,td{border:1px solid var(--line);padding:8px 12px;text-align:left;vertical-align:top}
th{background:var(--line-2);font-weight:600;color:var(--ink)}
tr:nth-child(even) td{background:#FAFBFC}
figure.chart{margin:0 0 20px;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;box-shadow:var(--shadow);page-break-inside:avoid}
figure.chart svg{width:100%;height:auto;display:block}
.chart-fallback{color:var(--muted);font-size:13px;margin:0 0 8px}
img{max-width:100%;border-radius:var(--radius-sm)}
@media print{
  body{background:#fff}
  .page{padding:0;max-width:none}
  .hero,.card,figure.chart{box-shadow:none}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
`;

function kpiTone(delta: string, tone?: string): "up" | "down" | "flat" {
  if (tone === "up" || tone === "down" || tone === "flat") return tone;
  const t = delta.trim();
  if (/^[-−]/.test(t) || /下降|减少|跌|降/.test(t)) return "down";
  if (/^[+＋]/.test(t) || /上升|增长|涨|提升|增/.test(t)) return "up";
  return "flat";
}

export function buildHtmlReport(opts: BuildHtmlReportOpts): string {
  // 标题缺失时**不编造**：既不塞默认大标题，也不拿它去猜语言。
  // 旧实现 `opts.title || "数据分析报告"` 会往用户文件里硬塞一行「数据分析报告」，
  // 与「内容必须来自真实输入、禁止编造」的口径直接冲突。
  const title = (opts.title || "").trim();
  // 语言改从「标题 + 正文」一起判断：标题现在可能为空，只看标题会把中文正文误判成 en。
  const lang = /[\u3400-\u9FFF]/.test(`${title}\n${(opts.sections || []).join("\n")}`) ? "zh-CN" : "en";
  const blocks: string[] = [];

  for (const sec of opts.sections || []) {
    const html = renderMarkdown(sec).trim();
    if (html) blocks.push(`<section class="card">${html}</section>`);
  }
  for (const c of opts.charts || []) {
    const svg = renderChartSvg(c);
    blocks.push(`<figure class="chart">${svg ?? renderFallbackTable(c)}</figure>`);
  }
  for (const t of opts.tables || []) {
    const head = t.matrix[0] || [];
    const body = t.matrix.slice(1);
    blocks.push(
      `<section class="card"><table>` +
        `<thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>` +
        `<tbody>${body.map((r) => `<tr>${head.map((_, i) => `<td>${escapeHtml(r[i] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>` +
        `</table></section>`,
    );
  }

  // Hero：仅当真有标题才渲染，绝不编造任何默认标题文案。
  const hero = title ? `<header class="hero"><h1>${escapeHtml(title)}</h1></header>` : "";

  // KPI 概要卡：仅当调用方显式传入才渲染；工具不自动从表格推算（避免编造指标）。
  const kpis = opts.kpis || [];
  const kpisHtml = kpis.length
    ? `<div class="kpis">` + kpis.map((k) => {
        const tone = kpiTone(k.delta || "", k.tone);
        const delta = k.delta ? `<div class="kpi-delta ${tone}">${escapeHtml(k.delta)}</div>` : "";
        const hint = k.hint ? `<div class="kpi-hint">${escapeHtml(k.hint)}</div>` : "";
        return `<div class="kpi"><div class="kpi-label">${escapeHtml(k.label)}</div><div class="kpi-value">${escapeHtml(k.value)}</div>${delta}${hint}</div>`;
      }).join("") + `</div>`
    : "";

  return [
    "<!doctype html>",
    `<html lang="${lang}">`,
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    REPORT_CSS,
    "</style>",
    "</head>",
    '<body><div class="page">',
    hero,
    kpisHtml,
    ...blocks,
    "</div></body>",
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
