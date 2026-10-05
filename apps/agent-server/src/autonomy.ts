/**
 * 渐进式自主分级（P2，OWASP ASI08 过度自主）。
 *
 * 最佳实践的原话是「progressive autonomy with earned trust escalation」——按历史表现逐步放权。
 * 这里**只实现向下收紧的一半**：表现变差就降自主度（收窄轮次预算），
 * **绝不因为历史表现好就自动放开确认或权限**。
 *
 * 理由（诚实说明为什么不照搬「 earned trust escalation 」）：
 * 自动提权的前提是「评分可信且不可被操纵」。本项目的在线评测是确定性规则分，
 * 攻击者只要让运行「看起来干净」（少调工具、少纠正）就能刷出高分——
 * 用它来**放开权限**等于给了攻击者一条提权路径。
 * 收窄则相反：刷分失败只会更保守，不会更危险。所以方向选「只收紧不放宽」；
 * 要放开权限必须由人决策（改配置 / 改角色），不由分数自动决定。
 */
import { summarizeEval, type EvalSummary } from "./eval-online.js";

/** 2 = 默认；1 = 谨慎；0 = 受限。数字越小越保守。 */
export type AutonomyLevel = 0 | 1 | 2;

export interface AutonomyState {
  level: AutonomyLevel;
  reason: string;
  /** 收紧后的轮次预算上限；level=2 时为 baseRounds（即不收紧）。 */
  maxRounds: number;
}

/** 评分样本少于这么多时不参与降级判定（与在线评测「样本不足不判」同口径）。 */
const MIN_RUNS = Number(process.env.AUTONOMY_MIN_RUNS || 5);
const TIGHTEN_RATIO = Number(process.env.AUTONOMY_TIGHTEN_RATIO || 0.3);
const RESTRICT_RATIO = Number(process.env.AUTONOMY_RESTRICT_RATIO || 0.5);

/** 纯函数：由评测聚合推导自主度。baseRounds = 未收紧时的轮次预算。 */
export function autonomyFromSummary(summary: EvalSummary, baseRounds: number): AutonomyState {
  const base = Math.max(1, Math.floor(baseRounds));
  if (summary.runs < MIN_RUNS) {
    // 冷启动没有信号：既不奖励也不惩罚（奖励会被刷分利用，惩罚会误伤）。
    return { level: 2, reason: `样本不足（${summary.runs}/${MIN_RUNS}），按默认自主度`, maxRounds: base };
  }
  const badRatio = (summary.degraded + summary.poor) / summary.runs;
  if (badRatio > RESTRICT_RATIO) {
    return {
      level: 0,
      reason: `近期劣质运行占比 ${(badRatio * 100).toFixed(0)}% > ${RESTRICT_RATIO * 100}%`,
      maxRounds: Math.max(1, Math.min(base, 4)),
    };
  }
  if (summary.qualityDegraded || badRatio > TIGHTEN_RATIO) {
    return {
      level: 1,
      reason: `近期劣质运行占比 ${(badRatio * 100).toFixed(0)}% > ${TIGHTEN_RATIO * 100}%`,
      maxRounds: Math.max(1, Math.min(base, 8)),
    };
  }
  return { level: 2, reason: "近期质量正常", maxRounds: base };
}

/** 读当前 owner 的评测聚合推导自主度；读不到数据时按默认（不降级）。 */
export function autonomyFor(ownerKey: string | undefined, baseRounds: number): AutonomyState {
  try {
    return autonomyFromSummary(summarizeEval({ ownerKey, days: 7 }), baseRounds);
  } catch (err) {
    console.warn(`[autonomy] 推导失败，按默认自主度：${String((err as Error)?.message || err)}`);
    return { level: 2, reason: "推导失败，按默认自主度", maxRounds: Math.max(1, baseRounds) };
  }
}
