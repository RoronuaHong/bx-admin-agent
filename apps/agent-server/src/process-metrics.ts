/**
 * 进程级指标（P1 可观测）：直接产出 Prometheus 文本格式，零新依赖。
 *
 * 与已有的 `src/metrics.ts`（`/chat/metrics`，**按 owner 的历史聚合**，每次请求现扫 JSONL）分工不同：
 * 那里看趋势、看某人的用量；这里是**进程内实时计数**——在每次模型调用 / 工具调用 / 运行收束 / HTTP 请求上打点，
 * 抓取即读，用来回答「现在的速率和错误率是多少」，并能接进 Prometheus/Grafana 告警。
 * 进程重启即清零（趋势看持久聚合，实时看这里），刻意不落盘。
 *
 * 刻意不做：不引入 prom-client（依赖体积与维护成本）。
 */
type Labels = Record<string, string | number | boolean>;

interface Def {
  type: "counter" | "summary";
  help: string;
}

const defs = new Map<string, Def>();
const counters = new Map<string, number>();
const summaries = new Map<string, { count: number; sum: number }>();

/** 转义 label 值里的引号与反斜杠，避免破坏 Prometheus 文本格式。 */
function escape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function seriesKey(name: string, labels: Labels): string {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escape(String(v))}"`);
  return parts.length ? `${name}{${parts.join(",")}}` : name;
}

function define(name: string, type: Def["type"], help: string): void {
  if (!defs.has(name)) defs.set(name, { type, help });
}

/** 计数器 +1（或 +n）。 */
export function incCounter(name: string, help: string, labels: Labels = {}, by = 1): void {
  define(name, "counter", help);
  const k = seriesKey(name, labels);
  counters.set(k, (counters.get(k) || 0) + by);
}

/** 观测一个数值（记录次数与总和，可算均值）。 */
export function observeSummary(name: string, help: string, labels: Labels, value: number): void {
  define(name, "summary", help);
  const k = seriesKey(name, labels);
  const cur = summaries.get(k) || { count: 0, sum: 0 };
  cur.count += 1;
  cur.sum += Math.max(0, value);
  summaries.set(k, cur);
}

/** 读取当前值（供测试与 `/metrics` 之外的消费方使用）。 */
export function counterValue(name: string, labels: Labels = {}): number {
  return counters.get(seriesKey(name, labels)) || 0;
}

/** 渲染 Prometheus 文本暴露格式（含 HELP / TYPE 行）。 */
export function renderPrometheus(): string {
  const lines: string[] = [];
  for (const name of [...defs.keys()].sort()) {
    const def = defs.get(name)!;
    lines.push(`# HELP ${name} ${def.help}`);
    lines.push(`# TYPE ${name} ${def.type}`);
    const prefix = `${name}{`;
    if (def.type === "counter") {
      // 没被打过点的指标也要出现（否则 Prometheus 侧该序列消失，告警规则会失效）。
      const series = [...counters.entries()].filter(([k]) => k === name || k.startsWith(prefix));
      if (!series.length) lines.push(`${name} 0`);
      for (const [k, v] of series.sort()) lines.push(`${k} ${v}`);
    } else {
      const series = [...summaries.entries()].filter(([k]) => k === name || k.startsWith(prefix));
      if (!series.length) {
        lines.push(`${name}_count 0`);
        lines.push(`${name}_sum 0`);
      }
      for (const [k, s] of series.sort()) {
        lines.push(`${k.replace(name, `${name}_count`)} ${s.count}`);
        lines.push(`${k.replace(name, `${name}_sum`)} ${s.sum}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/** 仅供测试：清空全部指标。 */
export function resetMetricsForTest(): void {
  defs.clear();
  counters.clear();
  summaries.clear();
}
