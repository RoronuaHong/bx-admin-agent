/**
 * 巡检消息的 markdown 组装 + 文本柱状图。
 *
 * 为什么要有文本图：钉钉内嵌图（markdown `![](url)`）要求图片 URL **公网可达**，
 * 内网或未配公网域名时钉钉服务端取不到图。此时用 Unicode 方块图仍能让对方在消息里
 * 直接"看见"趋势，且零依赖、零公网要求——作为图片不可用时的兜底可视化。
 *
 * 通用实现：不含任何业务词，输入即 label/value 数组。
 */

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const FULL = "█";

/** Unicode 方块柱：按 value/max 归一化到 width 字符宽（1/8 精度）。 */
export function textBar(value: number | null, max: number, width = 12): string {
  if (value == null || !(value > 0) || !(max > 0)) return "";
  const eighths = Math.round((value / max) * width * 8);
  const full = Math.min(width, Math.floor(eighths / 8));
  const rem = Math.max(0, Math.min(7, eighths - full * 8));
  const partial = full >= width ? "" : EIGHTHS[rem] || "";
  return FULL.repeat(full) + partial;
}

export interface BarRow {
  label: string;
  value: number | null;
  /** 右侧补充说明（如数值 / 变化率），可选。 */
  suffix?: string;
}

export interface TextBarChartOpts {
  width?: number;
  /** 柱条颜色（6 位 hex，带 #），如 #597ef7。 */
  barColor?: string;
}

/** 多行文本柱状图；每行形如 `- ███████▌ label · suffix`（markdown 无序列表项）。 */
export function textBarChart(rows: BarRow[], opts?: TextBarChartOpts): string[] {
  const width = opts?.width ?? 12;
  const barColor = opts?.barColor;
  const max = rows.reduce((m, r) => Math.max(m, r.value ?? 0), 0);
  return rows.map((r) => {
    const bar = textBar(r.value, max, width);
    const coloredBar = bar && barColor ? `<font color="${barColor}">${bar}</font>` : bar;
    const head = `${coloredBar} ${r.label}`.trim();
    return r.suffix ? `- ${head} · ${r.suffix}` : `- ${head}`;
  });
}
