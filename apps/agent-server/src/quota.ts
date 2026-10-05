/**
 * 成本硬配额（P1，对齐 OWASP LLM04 模型 DoS / LLM10 模型窃取）。
 *
 * 现状缺口：`cost.ts` 的 `DAILY_TOKEN_BUDGET` **只产生告警文本**（`budgetAlerts`），不拦截任何请求——
 * 真到超预算时，钱已经花出去了才在报告里看到一行红字。这里补「拦截」这一层：
 *
 * - 默认**关闭**（`COST_HARD_QUOTA` 未配 = 只告警），行为与改动前完全一致；
 * - 开启后按**当日累计 token** 拒绝新的对话运行（已开始的运行不受影响，不会半途掐断）；
 * - 进程内计数（跨天自动重置），不做每次请求都去遍历 trace JSONL 的昂贵聚合。
 *   多实例部署时这是**每实例**的计数，需要入口层或共享存储兜底（见 docs/SECURITY.md §15）。
 */
/** 每次现读（可测试，也允许运维改了变量即时生效）。 */
function isEnabled(): boolean {
  return process.env.COST_HARD_QUOTA === "on";
}
function dailyBudget(): number {
  return Number(process.env.DAILY_TOKEN_BUDGET || 0);
}

function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let currentDay = dayKey(new Date());
let usedToday = 0;

function rolloverIfNeeded(): void {
  const today = dayKey(new Date());
  if (today !== currentDay) {
    currentDay = today;
    usedToday = 0;
  }
}

/** 记录本次运行消耗的 token（估算或 usage 上报值，取调用方给的口径）。 */
export function addDailyTokens(tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  rolloverIfNeeded();
  usedToday += tokens;
}

export interface QuotaState {
  enabled: boolean;
  day: string;
  used: number;
  budget: number;
  /** 配额是否允许开始**新的**运行。未启用 / 未配预算时恒为 true。 */
  allowed: boolean;
}

/** 纯读：当前配额状态（含是否允许新运行）。 */
export function quotaState(): QuotaState {
  rolloverIfNeeded();
  const budget = dailyBudget();
  const active = isEnabled() && budget > 0;
  return {
    enabled: active,
    day: currentDay,
    used: usedToday,
    budget,
    allowed: !active || usedToday < budget,
  };
}

/** 仅供测试：把计数置为指定值（避免测试真的烧 token）。 */
export function setDailyTokensForTest(tokens: number): void {
  currentDay = dayKey(new Date());
  usedToday = Math.max(0, tokens);
}
