/**
 * 工具结果治理的「recall 优先」排序（第 8 批，对标 Anthropic
 * 《Effective context engineering for AI agents》「Compaction 调优顺序：先最大化 recall，
 * 再提升 precision；过度压缩是主要失败模式」）。
 *
 * 为什么单独成模块：排序判据必须与 `chat.ts` 的执行路径共用同一份实现，否则
 * 「文档写了 recall 优先、代码仍是按预算统一卸载」这类漂移无法被测试发现（与
 * `sql-readonly-common.mjs` / `adaptive-timeout.mjs` 同一手法）。本模块是**纯函数**：
 * 不读 env、不碰 MCP 注册表、不做 IO，判据由调用方以布尔入参注入。
 *
 * 分级依据只有一件事：**重取代价**。
 * - `replayed`：同一工具 + 同一参数在本轮上下文里还有另一条结果（重放已经发生过一次），
 *   卸载它不丢信息 —— 代价最低。
 * - `refetchable`：只读调用，原样重放无副作用 —— 代价是一次调用。
 * - `irreplaceable`：重放会再产生一次副作用（非只读），或内容根本不是一次调用能重放出来的
 *   （多轮子过程推导的交接结果）—— 代价最高，最后才动，且**只卸载、绝不丢弃**。
 *
 * 刻意不做的事：不按工具名 / 内容形态做「元数据 vs 聚合结论」的语义分类。
 * 那需要写死业务词，违反红线；重取代价是**协议层**可判定的（只读与否、是否重放过、是否推导产物）。
 */

export type RecallClass = "replayed" | "refetchable" | "irreplaceable";

export interface RecallInput {
  /** 同一工具 + 同一参数在本轮上下文里出现了不止一次。 */
  duplicated: boolean;
  /** 该次调用是只读（重放不产生副作用）。 */
  read: boolean;
  /** 内容由多轮子过程推导而来，不是「再调一次工具」就能拿回的。 */
  derived: boolean;
}

/** 卸载顺序权重：越小越先卸载（先卸代价低的，保住代价高的）。 */
export const RECALL_RANK: Record<RecallClass, number> = {
  replayed: 0,
  refetchable: 1,
  irreplaceable: 2,
};

export function recallRank(cls: RecallClass): number {
  return RECALL_RANK[cls] ?? RECALL_RANK.refetchable;
}

export function classifyRecall(input: RecallInput): RecallClass {
  // 「不可重放」优先于其它判据：重放有副作用或压侧重放不出来，都不是代价问题而是能不能的问题。
  if (!input.read || input.derived) return "irreplaceable";
  return input.duplicated ? "replayed" : "refetchable";
}

/**
 * 稳定排序：先按重取代价从低到高，同级保持传入顺序（传入顺序即「从旧到新」，
 * 旧结果被模型消化过、再被摘掉的损失更小）。
 */
export function orderByRecallCost<T>(items: readonly T[], clsOf: (item: T) => RecallClass): T[] {
  return items
    .map((item, index) => ({ item, index, rank: recallRank(clsOf(item)) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item);
}
