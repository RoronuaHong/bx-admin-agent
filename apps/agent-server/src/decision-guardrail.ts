/**
 * 决策点主动护栏（plan §13.5 R6/R7「过早宣布答不了 / 读了定义却没取数」）。
 *
 * 零业务词：本模块只做「阈值判定 + 提示文案」，不认识任何具体工具名、表名、业务词。
 * 工具角色（定义读取 vs 执行取数）由调用方按工具名映射成计数后传入，本模块据此决定是否回灌提示。
 *
 * 触发语义：一轮 BI 取数任务里，模型「读了大量候选定义/搜索结果（≥阈值）却一次都没执行取数」
 * 时，在综合轮主动回灌一句提示，避免模型停在「复述定义」或「宣布答不了」而没真正取数——
 * 数据没取出来，任何结论都不可靠。
 *
 * 失败开放：仅回灌提示、不阻断工具执行，模型可忽略；阈值走常量，可按需收紧。
 */

/** 触发回灌所需的最少「定义读取」次数。低于此值不回灌（少量摸索属正常探索）。 */
export const DECISION_GUARDRAIL_MIN_DEFINITIONS = 2;

/**
 * 是否应在综合轮回灌决策提示。
 * @param definitionsRead 本轮已成功执行的「定义读取类」工具次数（get_card / list_cards / search / get_database_schema ...）。
 * @param executionsDone 本轮已成功执行的「取数执行类」工具次数（execute_query / execute_sql / query / run_native_query ...）。
 */
export function shouldInjectDecisionHint(
  definitionsRead: number,
  executionsDone: number,
): boolean {
  if (!Number.isFinite(definitionsRead) || !Number.isFinite(executionsDone)) return false;
  if (definitionsRead < DECISION_GUARDRAIL_MIN_DEFINITIONS) return false;
  if (executionsDone > 0) return false;
  return true;
}

/**
 * 决策提示文案（回灌到综合轮前的用户消息）。
 * 纯引导、零业务词：只说「你读了 N 个定义却没取数，请直接取数或执行匹配的已存提问」。
 */
export function buildDecisionHint(definitionsRead: number): string {
  const n = Math.max(0, Math.floor(definitionsRead));
  return (
    `你已经读取了 ${n} 个候选定义/搜索结果，但还没有执行任何取数。` +
    `如果其中有匹配的已存提问，请直接执行对应的取数工具；否则就直接写 SQL 用取数工具取数，` +
    `不要只复述定义或宣布无法回答就收尾——数据没取出来，任何结论都不可靠。`
  );
}
