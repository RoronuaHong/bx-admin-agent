// `scripts/adaptive-timeout.mjs` 的类型声明（纯 JS 实现，两侧共用：BI 适配器与 Jev）。
// 与 src/pdfmake.d.ts 同模式——JS 侧不给实现塞 TS 语法，用声明文件把类型补给 TS 消费方。
export interface AdaptiveTimeoutOptions {
  /** 保底值（配置项）。样本不足或派生低于它时按它走。 */
  configuredMs: number;
  /** 近期**成功**调用耗时（毫秒）。失败/超时的真实耗时未知，不进分布。 */
  samples?: readonly number[];
  /** 封顶值：派生再高也不超过它（不传则不封顶）。 */
  maxMs?: number;
  /** 安全系数：派生 = 分位值 × factor（默认 2）。 */
  factor?: number;
  /** 分位（默认 0.95）。 */
  percentile?: number;
  /** 少于此样本量不派生（默认 5）。 */
  minSamples?: number;
}

/** 由实测成功延迟样本派生超时阈值（毫秒）。 */
export function deriveAdaptiveTimeoutMs(opts: AdaptiveTimeoutOptions): number;

/** 进程内成功延迟环形缓冲：只记成功调用的耗时。 */
export class LatencyWindow {
  constructor(capacity?: number);
  /** 记一次成功调用的耗时；非正数/非有限值忽略。 */
  record(ms: number): void;
  /** 样本快照（派生函数每次现算，不缓存中间态）。 */
  snapshot(): number[];
  /** 当前样本数。 */
  readonly size: number;
}