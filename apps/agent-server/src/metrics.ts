/**
 * Prometheus 文本格式的只读指标（§可观测）。
 *
 * 为什么不是 OTLP：单机规模下先给一个能被抓的端点就够了——零新依赖、零埋点改造，
 * 数据全部来自已有的 run 级 trace 与 append-only 审计留痕（同一份事实，不另建一套账）。
 * 与 OTel 的差距（没有 llm / tool 分层 span）不因本文件消失，它缺的是埋点粒度，不是导出格式。
 *
 * 归属口径与 `/chat/trace/runs`、`/chat/cost/summary`、`/audit/list` 一致：
 * HTTP 侧只暴露本 owner 的指标，全局视角走 CLI 直读 JSONL。指标里不出现会话/对话标识。
 */
import type { AuditEvent } from "./audit.js";
import type { RunTrace } from "./trace.js";

/** 指标名前缀（Prometheus 命名建议：<namespace>_<subsystem>_<name>_<unit>）。 */
const NS = "bx_agent";

/** 只保留指标名与标签值里安全的字符；标签值再按 Prometheus 规则转义。 */
function escapeLabelValue(value: string): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export interface MetricsInput {
  runs: RunTrace[];
  /** 审计事件（同 owner 口径；用于按决策计数）。 */
  audit?: AuditEvent[];
  release?: string;
  /** 生成时刻（便于单测钉死，缺省取当前时间）。 */
  now?: number;
}

/**
 * 组装 Prometheus 文本（纯函数：单测直接断言文本，不需要起服务）。
 * 只输出标量聚合，不逐条输出时间序列——单机规模下逐条序列只会把抓取端压垮，
 * 且会泄漏「谁在什么时候跑了什么」（trace 的 HTTP 侧本来就按 owner 隔离）。
 */
export function buildMetrics(input: MetricsInput): string {
  const runs = input.runs || [];
  const audit = input.audit || [];
  const out: string[] = [];

  const emit = (name: string, type: "counter" | "gauge", help: string, lines: string[]) => {
    out.push(`# HELP ${NS}_${name} ${help}`);
    out.push(`# TYPE ${NS}_${name} ${type}`);
    for (const line of lines) out.push(`${NS}_${name}${line}`);
  };

  // 运行数按状态：失败/取消是主要告警面。
  const byStatus = new Map<string, number>();
  for (const run of runs) {
    const key = String(run.status || "unknown");
    byStatus.set(key, (byStatus.get(key) || 0) + 1);
  }
  emit(
    "runs_total",
    "counter",
    "Number of agent runs by final status.",
    [...byStatus.entries()].sort().map(([status, n]) => `{status="${escapeLabelValue(status)}"} ${n}`),
  );

  // 字段都是可选的（老记录可能没有）：交给 num 兜底成 0，不做「缺了就是 0」之外的猜测。
  const sum = (pick: (r: RunTrace) => number | undefined): number =>
    runs.reduce((acc, r) => acc + num(pick(r)), 0);
  const durations = runs.map((r) => num(r.durationMs)).filter((n) => n > 0).sort((a, b) => a - b);
  const avg = (list: number[]): number => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
  // 分位数用「最接近秩」法：这里只给 p50/p95，够看劣化趋势，不引入 histogram 桶。
  const quantile = (list: number[], q: number): number => {
    if (!list.length) return 0;
    const idx = Math.min(list.length - 1, Math.max(0, Math.ceil(q * list.length) - 1));
    return list[idx]!;
  };

  emit("tokens_total", "counter", "Sum of tokens reported by runs.", [` ${sum((r) => r.tokens)}`]);
  emit("tool_calls_total", "counter", "Sum of tool executions reported by runs.", [` ${sum((r) => r.toolCalls)}`]);
  emit(
    "rounds_avg",
    "gauge",
    "Average tool-loop rounds per run.",
    [` ${Number(avg(runs.map((r) => num(r.rounds))).toFixed(2))}`],
  );
  emit(
    "run_duration_ms",
    "gauge",
    "Run duration in milliseconds (avg / p50 / p95 / max).",
    [
      `{quantile="avg"} ${Math.round(avg(durations))}`,
      `{quantile="p50"} ${Math.round(quantile(durations, 0.5))}`,
      `{quantile="p95"} ${Math.round(quantile(durations, 0.95))}`,
      `{quantile="max"} ${Math.round(durations[durations.length - 1] || 0)}`,
    ],
  );
  // 韧性与护栏：这三个是「模型/数据源在退化」的先行信号，比成功率更早变红。
  emit(
    "model_fallbacks_total",
    "counter",
    "Times the run had to fall back to another model.",
    [` ${sum((r) => r.modelFallbacks)}`],
  );
  emit(
    "grounding_retries_total",
    "counter",
    "Times an answer was voided for having no tool evidence.",
    [` ${sum((r) => r.groundingRetries)}`],
  );
  emit(
    "grounding_verifications_total",
    "counter",
    "Times the pre-answer claim verification ran.",
    [` ${sum((r) => r.groundingVerifications)}`],
  );
  emit(
    "ungrounded_runs_total",
    "counter",
    "Runs that ended with the deterministic refusal (no data could be retrieved).",
    [` ${runs.filter((r) => r.ungrounded === true).length}`],
  );

  const byDecision = new Map<string, number>();
  for (const event of audit) {
    const key = String(event.decision || "unknown");
    byDecision.set(key, (byDecision.get(key) || 0) + 1);
  }
  emit(
    "audit_events_total",
    "counter",
    "Security audit events by decision.",
    [...byDecision.entries()].sort().map(([decision, n]) => `{decision="${escapeLabelValue(decision)}"} ${n}`),
  );

  // 构建信息：版本标签只放这一条，避免把 release 贴到每个指标上（卡片数量爆炸）。
  out.push(`# HELP ${NS}_build_info Build/release metadata (always 1).`);
  out.push(`# TYPE ${NS}_build_info gauge`);
  out.push(`${NS}_build_info{release="${escapeLabelValue(input.release || "unknown")}"} 1`);

  out.push(`# HELP ${NS}_scrape_at_ms Timestamp of this scrape (ms epoch).`);
  out.push(`# TYPE ${NS}_scrape_at_ms gauge`);
  out.push(`${NS}_scrape_at_ms ${input.now ?? Date.now()}`);

  return `${out.join("\n")}\n`;
}
