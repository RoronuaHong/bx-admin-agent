/**
 * 行为异常检测（P2，OWASP ASI09 日志与监控不足）。
 *
 * 最佳实践要求「持续监控 agent 行为，识别目标劫持 / 工具滥用 / 权限滥用 / 记忆投毒等异常」。
 * 已有的 trace / audit / eval 解决的是「留痕」与「打分」，这里补的是**偏离基线**这一格：
 * 同一个人/同一个 agent 平时的行为长什么样，这次是不是明显不像。
 *
 * 设计取舍（诚实优先）：
 * - **不用模型判异常**：在线检测跑在每次运行上，再叠一次模型调用不值当；
 *   且「异常」的定义必须可解释，规则比模型更适合做告警。
 * - **样本不足不判**：基线样本 < MIN_SAMPLES 时只积累不出告警，
 *   否则冷启动第一次运行就会被自己的空基线判成异常（典型误报）。
 * - **只报不管**：检测只产出标记与指标，不阻断、不改行为——误报的代价远小于漏报时，
 *   也避免「护栏自己把服务搞挂」。
 * - 基线是**进程内**的，重启即重建（与进程级 metrics 同口径；跨进程需共享存储）。
 */
import type { RunTrace } from "./trace.js";
import { listSpanTraces } from "./trace.js";
import { incCounter } from "./process-metrics.js";

const WINDOW = Number(process.env.ANOMALY_WINDOW || 50);
/** 少于这么多样本不判异常（避免冷启动误报）。 */
const MIN_SAMPLES = Number(process.env.ANOMALY_MIN_SAMPLES || 5);
const SPIKE_FACTOR = Number(process.env.ANOMALY_SPIKE_FACTOR || 3);
/** 未取证（模型有编造倾向）在最近窗口内出现这么多次即告警。 */
const UNGROUNDED_BURST = Number(process.env.ANOMALY_UNGROUNDED_BURST || 3);
const UNGROUNDED_WINDOW = 10;
const REPORT_CAP = 100;

export interface RunSample {
  rounds?: number;
  tokens?: number;
  durationMs: number;
  toolNames: string[];
  ungrounded?: boolean;
}

export interface OwnerBaseline {
  count: number;
  rounds: number[];
  tokens: number[];
  durations: number[];
  tools: Set<string>;
  ungroundedWindow: boolean[];
}

const baselines = new Map<string, OwnerBaseline>();
const reports: AnomalyReport[] = [];

export interface AnomalyReport {
  runId: string;
  at: number;
  ownerKey?: string;
  /** 触发的异常类型（通用语义，非业务词）。 */
  flags: string[];
  anomalous: boolean;
  /** 判定时基线里已有的样本数（< MIN_SAMPLES 时不判）。 */
  baselineRuns: number;
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function pushCapped(arr: number[], value: number): void {
  arr.push(value);
  if (arr.length > WINDOW) arr.shift();
}

/**
 * 纯函数：拿当前样本与基线比对，产出异常标记。
 * 基线样本不足 → 返回空（不判），这是刻意的防误报设计。
 */
export function detectAnomalies(
  current: RunSample,
  baseline: OwnerBaseline | null,
  minSamples = MIN_SAMPLES,
): string[] {
  if (!baseline || baseline.count < minSamples) return [];
  const flags: string[] = [];

  const medRounds = median(baseline.rounds);
  if (typeof current.rounds === "number" && typeof medRounds === "number") {
    // 加一个绝对增量下限：基线极小时（如中位数 1）乘系数会到处误报。
    if (current.rounds >= Math.max(medRounds * SPIKE_FACTOR, medRounds + 5)) flags.push("rounds_spike");
  }
  const medTokens = median(baseline.tokens);
  if (typeof current.tokens === "number" && typeof medTokens === "number") {
    if (current.tokens >= medTokens * SPIKE_FACTOR && current.tokens > medTokens + 1000) {
      flags.push("tokens_spike");
    }
  }
  const medDuration = median(baseline.durations);
  if (typeof medDuration === "number") {
    if (current.durationMs >= medDuration * SPIKE_FACTOR && current.durationMs > medDuration + 5000) {
      flags.push("duration_spike");
    }
  }
  // 工具新颖性：用了基线里从没出现过的工具——可能是正常的首次使用，
  // 也可能是「作用域扩张」（ASI02）：agent 开始调用它原本不该碰的能力。
  const novel = current.toolNames.filter((name) => !baseline.tools.has(name));
  if (novel.length) flags.push("tool_novelty");

  if (current.ungrounded) {
    const recent = baseline.ungroundedWindow.slice(-UNGROUNDED_WINDOW);
    if (recent.filter(Boolean).length + 1 >= UNGROUNDED_BURST) flags.push("ungrounded_burst");
  }
  return flags;
}

function baselineOf(key: string): OwnerBaseline {
  let base = baselines.get(key);
  if (!base) {
    base = { count: 0, rounds: [], tokens: [], durations: [], tools: new Set(), ungroundedWindow: [] };
    baselines.set(key, base);
  }
  return base;
}

/** 用本次 run 更新基线（在判定之后调用，避免「自己跟自己比」）。 */
function updateBaseline(base: OwnerBaseline, sample: RunSample): void {
  base.count += 1;
  if (typeof sample.rounds === "number") pushCapped(base.rounds, sample.rounds);
  if (typeof sample.tokens === "number") pushCapped(base.tokens, sample.tokens);
  pushCapped(base.durations, sample.durationMs);
  for (const name of sample.toolNames) base.tools.add(name);
  base.ungroundedWindow.push(sample.ungrounded === true);
  if (base.ungroundedWindow.length > UNGROUNDED_WINDOW) base.ungroundedWindow.shift();
}

/**
 * 观测一次 run：判定 → 更新基线 → 记报告 + 打点。best-effort，绝不抛错、绝不阻断。
 * 工具名从该 run 的 span 里取（span 已如实记录每次工具调用）。
 */
export function observeRun(rt: RunTrace): AnomalyReport {
  let toolNames: string[] = [];
  try {
    toolNames = listSpanTraces(rt.runId, 200)
      .filter((span) => span.kind === "tool" && span.name)
      .map((span) => span.name as string);
  } catch {
    /* span 读不到就当没有工具名，不影响其它维度 */
  }
  const sample: RunSample = {
    durationMs: rt.durationMs,
    toolNames: [...new Set(toolNames)],
    ...(typeof rt.rounds === "number" ? { rounds: rt.rounds } : {}),
    ...(typeof rt.tokens === "number" ? { tokens: rt.tokens } : {}),
    ...(rt.ungrounded !== undefined ? { ungrounded: rt.ungrounded } : {}),
  };
  const key = rt.ownerKey || "__anon__";
  const base = baselines.get(key) || null;
  let flags: string[] = [];
  let baselineRuns = base?.count || 0;
  try {
    flags = detectAnomalies(sample, base);
  } catch (err) {
    console.warn(`[anomaly] 判定失败：${String((err as Error)?.message || err)}`);
  }
  updateBaseline(baselineOf(key), sample);

  const report: AnomalyReport = {
    runId: rt.runId,
    at: rt.at,
    ...(rt.ownerKey ? { ownerKey: rt.ownerKey } : {}),
    flags,
    anomalous: flags.length > 0,
    baselineRuns,
  };
  if (report.anomalous) {
    console.warn(`[anomaly] run ${rt.runId} 异常：${flags.join("、")}（基线 ${baselineRuns} 条）`);
  }
  try {
    incCounter("bx_agent_anomaly_runs_total", "行为异常检测运行数（按是否异常）", {
      anomalous: report.anomalous ? "yes" : "no",
    });
    for (const flag of flags) {
      incCounter("bx_agent_anomalies_total", "行为异常命中数（按类型）", { type: flag });
    }
  } catch {
    /* 打点不能影响主流程 */
  }
  reports.push(report);
  if (reports.length > REPORT_CAP) reports.shift();
  return report;
}

/** 只读：最近的异常报告（倒序）。ownerKey 隔离：只看自己的 + 无主遗留。 */
export function listAnomalies(ownerKey?: string, limit = 50): AnomalyReport[] {
  const n = Math.max(1, Math.min(REPORT_CAP, Math.floor(limit)));
  return reports
    .filter((r) => !ownerKey || !r.ownerKey || r.ownerKey === ownerKey)
    .slice(-n)
    .reverse();
}

/** 只读：当前基线规模（便于判断「现在能不能判」）。 */
export function baselineStats(): Array<{ ownerKey: string; count: number; tools: number }> {
  return [...baselines.entries()].map(([ownerKey, base]) => ({
    ownerKey,
    count: base.count,
    tools: base.tools.size,
  }));
}

/** 仅供测试：清空基线与报告。 */
export function resetAnomalyForTest(): void {
  baselines.clear();
  reports.length = 0;
}
