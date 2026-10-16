// 超时阈值的自适应派生（第 6 批随 BI 查询超时抽出，第 7 批 Jev 复用）。
//
// 对标 AWS Builders Library《Timeouts, Retries, and Backoff with Jitter》
// 「超时值按误超时率反推（如 0.1% 误超时 → 取 p99.9），并覆盖跨公网最坏延迟」。
//
// 为什么不是固定值：2026-10-14 事故里一次合法聚合正好 30002ms 被打断（查询侧固定 30s），
// 同一个模型在别的端点又可能只要 2s——固定值要么误杀合法慢调用，要么给挂死调用留太长窗口。
// 取中：按**实测成功延迟**的分位数派生，保底（配置值）封顶（上限值）。
//
// 抽成独立模块的两种用法（两侧共用同一份实现，判据不漂移）：
//   · BI 适配器 `scripts/metabase-mcp.mjs`（stdio 进程，import 即连 stdio，测试无法直接 import 本仓 src）
//   · 客服分类器 `src/jev.ts`（同进程，走 chat.ts 的调用链）
//
// 诚实边界：
// - 样本只收**成功**调用。失败/超时调用的真实耗时未知（客户端 abort 后上游可能还在跑），
//   收进来会污染分布；超时后的正确处置是回灌可操作文案（缩小范围/加过滤/分页）。
// - 冷启动样本不足时按配置值走，不猜、不提前乐观。
// - 派生值受配置值保底：不会因为样本偏快就把阈值压到配置值以下。

/**
 * 纯函数：由实测成功延迟样本派生超时阈值（毫秒）。
 *
 * @param {object} opts
 * @param {number} opts.configuredMs  保底值（配置项，如 BI_TIMEOUT_MS / JEV_TIMEOUT_FLOOR_MS）
 * @param {number[]} [opts.samples]  近期**成功**调用耗时（毫秒）
 * @param {number} [opts.maxMs]      封顶值（超过就不再上调）
 * @param {number} [opts.factor]      安全系数（派生 = 分位值 × factor）
 * @param {number} [opts.percentile]  分位（默认 p95）
 * @param {number} [opts.minSamples]  少于此样本量不派生（按配置值走）
 * @returns {number} 生效阈值（毫秒）
 */
export function deriveAdaptiveTimeoutMs(opts) {
  const configured = Number(opts?.configuredMs);
  const floor = Math.max(500, configured || 30_000);
  const cap = Number(opts?.maxMs) > 0 ? Number(opts.maxMs) : Number.POSITIVE_INFINITY;
  const factor = Math.max(1, Number(opts?.factor) || 2);
  const percentile = Math.min(0.99, Math.max(0.5, Number(opts?.percentile) || 0.95));
  const minSamples = Math.max(1, Number(opts?.minSamples) || 5);
  const valid = (Array.isArray(opts?.samples) ? opts.samples : [])
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (valid.length < minSamples) return Math.min(floor, cap);
  const idx = Math.min(valid.length - 1, Math.floor(valid.length * percentile));
  const derived = Math.ceil(valid[idx] * factor);
  return Math.max(floor, Math.min(derived, cap));
}

/** 进程内成功延迟环形缓冲：只记成功调用的耗时，供派生函数消费。 */
export class LatencyWindow {
  constructor(capacity = 50) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.samples = [];
  }

  /** 记一次成功调用的耗时；非正数/非有限值忽略（脏数据不进分布）。 */
  record(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.samples.push(ms);
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  /** 样本快照（派生函数每次现算，不缓存中间态）。 */
  snapshot() {
    return [...this.samples];
  }

  get size() {
    return this.samples.length;
  }
}