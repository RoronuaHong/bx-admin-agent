/**
 * 成本硬配额（P1，对齐 OWASP LLM04 模型 DoS / LLM10 模型窃取）。
 *
 * 起点：`cost.ts` 的 `DAILY_TOKEN_BUDGET` **只产生告警文本**（`budgetAlerts`），不拦截任何请求——
 * 真到超预算时，钱已经花出去了才在报告里看到一行红字。这里补「拦截」这一层：
 *
 * - 默认**关闭**（`COST_HARD_QUOTA` 未配 = 只告警），行为与改动前完全一致；
 * - 开启后按**当日累计 token** 拒绝新的对话运行（已开始的运行不受影响，不会半途掐断）；
 * - 进程内计数（跨天自动重置），不做每次请求都去遍历 trace JSONL 的昂贵聚合。
 *   多实例部署时这是**每实例**的计数，需要入口层或共享存储兜底（见 docs/SECURITY.md §15）。
 *
 * 双层配额（为什么不能只有全局一池）：
 * 全局单一池意味着**任何一个用户都能把当日共享预算烧光、让其他人全部被挡住**——
 * 这既是可用性问题，也是一个用户即可制造的拒绝服务。故在全局池（守钱包）之外
 * 再加一层**每 owner 池**（守公平）：`DAILY_TOKEN_BUDGET_PER_OWNER`。
 * 一次运行必须**同时**满足两层才放行，任一层超限即拒。
 * 两层共用开关 `COST_HARD_QUOTA=on`；预算未配（=0）即该层不启用，行为与改动前一致。
 */

/** 每次现读（可测试，也允许运维改了变量即时生效）。 */
function isEnabled(): boolean {
  return process.env.COST_HARD_QUOTA === "on";
}
function dailyBudget(): number {
  return Number(process.env.DAILY_TOKEN_BUDGET || 0);
}
/** 每 owner 预算；未配 = 0 = 不启用该层。 */
function perOwnerBudget(): number {
  return Number(process.env.DAILY_TOKEN_BUDGET_PER_OWNER || 0);
}
/** 跟踪的 owner 数量上限：ownerKey 来自匿名 cookie，单实例可被无限灌入，Map 必须有界。 */
function maxTrackedOwners(): number {
  const n = Number(process.env.QUOTA_MAX_TRACKED_OWNERS || 1000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000;
}

function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let currentDay = dayKey(new Date());
let usedToday = 0;
/** ownerKey -> 当日 token。Map 保序，便于超上限时淘汰最早插入的（当日最久没再来的）。 */
const ownerUsed = new Map<string, number>();

function rolloverIfNeeded(): void {
  const today = dayKey(new Date());
  if (today !== currentDay) {
    currentDay = today;
    usedToday = 0;
    ownerUsed.clear();
  }
}

/**
 * 记录本次运行消耗的 token（估算或 usage 上报值，取调用方给的口径）。
 * 同时累加进全局池与该 owner 的池；ownerKey 缺失时只记全局（保持与旧行为一致）。
 */
export function addDailyTokens(tokens: number, ownerKey?: string): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  rolloverIfNeeded();
  usedToday += tokens;
  const key = (ownerKey || "").trim();
  if (!key) return;
  if (!ownerUsed.has(key) && ownerUsed.size >= maxTrackedOwners()) {
    // 超出跟踪上限：淘汰最早插入的一个，保证 Map 有界（全局计数不受影响，兜底仍有效）。
    const oldest = ownerUsed.keys().next();
    if (!oldest.done) ownerUsed.delete(oldest.value);
  }
  ownerUsed.set(key, (ownerUsed.get(key) || 0) + tokens);
}

export interface QuotaState {
  enabled: boolean;
  day: string;
  /** 全局池当日已用 token。 */
  used: number;
  /** 全局池预算（0 = 未配）。 */
  budget: number;
  /** 该 owner 当日已用 token（未传 ownerKey 时恒为 0）。 */
  ownerUsed: number;
  /** 每 owner 预算（0 = 未配 = 不启用该层）。 */
  ownerBudget: number;
  /** 两层是否都允许开始**新的**运行。未启用 / 未配预算时恒为 true。 */
  allowed: boolean;
  /** 拒绝原因分层：让错误文案与审计说清是哪一层挡住了（只报自己那层，不泄露他人用量）。 */
  blockedBy?: "global" | "owner";
}

/** 纯读：当前配额状态（含是否允许新运行）。两层判定：全局池与该 owner 池都要未超。 */
export function quotaState(ownerKey?: string): QuotaState {
  rolloverIfNeeded();
  const on = isEnabled();
  const budget = dailyBudget();
  const ownerBudget = perOwnerBudget();
  const key = (ownerKey || "").trim();
  const ownerUsedTokens = key ? ownerUsed.get(key) || 0 : 0;
  const globalActive = on && budget > 0;
  const ownerActive = on && ownerBudget > 0 && !!key;
  const globalAllowed = !globalActive || usedToday < budget;
  const ownerAllowed = !ownerActive || ownerUsedTokens < ownerBudget;
  const state: QuotaState = {
    enabled: globalActive || ownerActive,
    day: currentDay,
    used: usedToday,
    budget,
    ownerUsed: ownerUsedTokens,
    ownerBudget,
    allowed: globalAllowed && ownerAllowed,
  };
  if (!globalAllowed) state.blockedBy = "global";
  else if (!ownerAllowed) state.blockedBy = "owner";
  return state;
}

/** 仅供测试：把全局与指定 owner 的计数置为指定值（避免测试真的烧 token）。 */
export function setDailyTokensForTest(tokens: number, ownerKey?: string, ownerTokens?: number): void {
  currentDay = dayKey(new Date());
  usedToday = Math.max(0, tokens);
  ownerUsed.clear();
  const key = (ownerKey || "").trim();
  if (key && typeof ownerTokens === "number") ownerUsed.set(key, Math.max(0, ownerTokens));
}

/** 仅供测试：读取当前跟踪的 owner 数量（验证 Map 有界淘汰）。 */
export function trackedOwnerCountForTest(): number {
  return ownerUsed.size;
}
