/**
 * 同工具重复调用预算（第 2 批 P1-2）。
 *
 * **要补的洞**：现有的跨轮重复提示只认「工具 + 参数完全相同」。2026-10-14 事故里模型对
 * 同一个元数据工具调了 24 次，每次换对象/换字段 —— 参数全不相同，于是那条提示一次没触发，
 * 27 轮预算里大半耗在重复探查上。
 *
 * **判据借用两处思想**：
 * 1. AWS《Timeouts, Retries, and Backoff with Jitter》的**重试预算**：限制「额外动作占正常
 *    动作的比例」，而不是给一个绝对次数——绝对阈值与任务复杂度无关（探 3 张表和 30 张表
 *    该不该被罚不是同一个数），占比才与规模无关。
 * 2. Anthropic《Building Effective Agents》「防止重复调用」：重复本身就是信号，且要
 *    给出重试上限或替代动作。
 *
 * **为什么不硬拦**：重复有时是正当的（数据确实要刷新、口径要分批确认）。这里只提示，
 *    把选择权交回模型；同一签名的重复由既有的 Doom Loop 熔断负责硬拦。
 *
 * 超出原文的部分（已在事故文档标注为补强）：原文只管「相同工具 + 相同参数」，本模块
 * 增加「同工具、不同参数」这一维——因为换参数重试同样是对同一个失败假设的反复试探。
 */

export interface RepeatBudgetOptions {
  /** 单轮内同一工具的调用次数上限（超过即提示）。 */
  perRoundLimit?: number;
  /** 同一工具占全部已执行调用的比例上限（超过即提示）。 */
  shareLimit?: number;
  /** 占比判据的最小样本数：调用太少时比例没有意义（Fowler：比率必须配最小样本数）。 */
  minSamples?: number;
}

export interface RepeatBudgetInput {
  /** 同一工具在本轮被调用的次数。 */
  perRoundCount: number;
  /** 同一工具在本轮之前累计被调用的次数（不含本轮）。 */
  priorCount: number;
  /** 本轮已执行的总调用数（不含本轮这个工具）。 */
  totalOther: number;
  /** 工具名（英文契约名，可直接出现在提示里）。 */
  toolName: string;
}

const DEFAULTS: Required<RepeatBudgetOptions> = {
  perRoundLimit: 4,
  shareLimit: 0.4,
  minSamples: 6,
};

/**
 * 纯函数：判断是否该就「同一工具重复过多」给提示；不该则返回 null。
 *
 * 两个判据任一命中即提示（都不硬拦）：
 *   · 单轮次数超限 —— 说明这一轮就在原地打转；
 *   · 累计占比超限 —— 说明整个运行都在靠同一个工具硬撑。
 */
/* ── 阶梯升级（第 10 批） ──────────────────────────────────────────────────
 *
 * 要补的洞：上文的提示在 `chat.ts` 里是「同一工具只提示一次」（`repeatBudgetNotified`），
 * 于是 2026-10-15 真实复跑里出现「第 8 次被提醒过一次，之后又调了 24 次」——单工具
 * 本轮峰值 32 次、全程 28 轮 / 83 次调用，其中大半是同一批元数据反复探查。
 * 观测（toolRepeatMax → anomaly 的 tool_repeat_spike → eval 的 efficiency）早就红了，
 * 缺的是**跟着走的提醒**。
 *
 * 形态：按**累计次数的翻倍阶梯**提醒（8 → 16 → 32 …）——仍不用绝对阈值（探 3 张表和
 * 30 张表该不该被罚不是同一个数），与上文「占比而非绝对次数」同一取向；每上一个台阶
 * 提醒一次，文案逐级加重。
 *
 * **默认仍不硬拦**（重复有时是正当的）；`TOOL_REPEAT_STOP_AFTER` 打开后才在累计超限时
 * 停止执行该工具——这是「护栏拦得住单点、收不住总量」的可选收口，默认关以免影响既有长任务。
 */

/** 首个阶梯的累计次数（默认与在线评测 `EVAL_MAX_TOOL_REPEAT` 同口径）。 */
export const REPEAT_ESCALATE_FIRST = Math.max(1, Math.floor(Number(process.env.TOOL_REPEAT_ESCALATE_FIRST) || 8));
/** 阶梯倍率（>1）。 */
export const REPEAT_ESCALATE_FACTOR = Math.max(1.5, Number(process.env.TOOL_REPEAT_ESCALATE_FACTOR) || 2);
/** 累计达到该次数后**拒绝执行**（0 = 只提示不拦，默认）。 */
export const REPEAT_STOP_AFTER = Math.max(0, Math.floor(Number(process.env.TOOL_REPEAT_STOP_AFTER) || 0));

export interface RepeatEscalationInput {
  /** 工具名（英文契约名）。 */
  toolName: string;
  /** 该工具在本 run 内的累计执行次数（含本轮）。 */
  total: number;
  /** 已提示过的最高阶梯（0 = 从未提示）。 */
  notifiedStep: number;
}

export interface RepeatEscalationOptions {
  firstStep?: number;
  factor?: number;
  stopAfter?: number;
}

/** 返回 ≤ total 的最高阶梯值；未达首阶返回 0。 */
export function repeatEscalationStep(total: number, opts: RepeatEscalationOptions = {}): number {
  const first = Math.max(1, Math.floor(opts.firstStep ?? REPEAT_ESCALATE_FIRST));
  const factor = Math.max(1.5, opts.factor ?? REPEAT_ESCALATE_FACTOR);
  if (!(total >= first)) return 0;
  let step = first;
  for (;;) {
    const next = Math.floor(step * factor);
    if (next > total || next <= step) break;
    step = next;
  }
  return step;
}

/** 累计是否已达「停止执行」上限（默认关闭时恒为 false）。 */
export function repeatBudgetStop(total: number, opts: RepeatEscalationOptions = {}): boolean {
  const stopAfter = Math.max(0, Math.floor(opts.stopAfter ?? REPEAT_STOP_AFTER));
  return stopAfter > 0 && total >= stopAfter;
}

/** 停止执行的回灌文案：必须给替代动作，否则模型会当成工具坏了而反复重试（Doom Loop）。 */
export function repeatStopNotice(toolName: string, total: number, limit: number): string {
  return (
    `已停止执行 ${toolName}：本次运行累计已调用 ${total} 次，达到重复上限 ${limit}。` +
    "请直接基于已取到的结果给出结论，并把没取到的部分如实说明；" +
    "确实还缺数据时换一条取证路径（换工具、先缩小范围，或用服务端聚合的一次性调用）。"
  );
}

/**
 * 纯函数：按阶梯给（或不给）提醒，并附带是否该停止执行。
 * `step` 回传给调用方记住「提示到哪一级」，下一轮据此只在新台阶上再提示一次。
 */
export function repeatEscalation(
  input: RepeatEscalationInput,
  opts: RepeatEscalationOptions = {},
): { step: number; notice: string | null; stop: boolean } {
  const step = repeatEscalationStep(input.total, opts);
  const stop = repeatBudgetStop(input.total, opts);
  if (step <= input.notifiedStep) return { step: Math.max(step, input.notifiedStep), notice: null, stop };
  const notice =
    input.notifiedStep > 0
      ? `（再次提醒）${input.toolName} 累计已调用 ${input.total} 次（上一次提醒在 ${input.notifiedStep} 次）。` +
        "本轮结束前请直接给出结论，并如实列出没取到的部分；不要再靠同一条路径继续取数。"
      : `到此为止你已调用 ${input.toolName} 共 ${input.total} 次。` +
        "同一条取证路径反复换参数，边际收益已经很低。请二选一：" +
        "① 用已有结果直接给出结论（缺的项如实说明没取到）；" +
        "② 换一条取证路径（换一个工具、先缩小范围，或改用服务端聚合的一次性调用）。";
  return { step, notice, stop };
}

export function repeatBudgetNotice(input: RepeatBudgetInput, opts: RepeatBudgetOptions = {}): string | null {
  const o = { ...DEFAULTS, ...opts };
  if (input.perRoundCount >= o.perRoundLimit) {
    return (
      `你在同一轮里调用了 ${input.toolName} 共 ${input.perRoundCount} 次。` +
      "同一次探查换参数反复试，通常不会得到新信息。请二选一：" +
      "① 用已有结果直接给出结论（缺的项如实说明没取到）；" +
      "② 换成另一条取证路径（换一个工具，或先缩小范围再取）。"
    );
  }
  const total = input.priorCount + input.perRoundCount + input.totalOther;
  if (total >= o.minSamples) {
    const share = (input.priorCount + input.perRoundCount) / total;
    if (share >= o.shareLimit) {
      return (
        `到目前为止 ${Math.round(share * 100)}% 的工具调用都花在 ${input.toolName} 上（共 ${input.priorCount + input.perRoundCount} 次）。` +
        "继续在同一棵树上找边际收益已经很低。请给出当前能给的结论，并把没取到的部分如实说明；" +
        "确实需要更多数据时，换一个信息来源或先与用户确认口径。"
      );
    }
  }
  return null;
}

/* ── 总调用预算：单工具护栏收不住总量（2026-10-16 客服/BI 复跑事故） ─────────────
 *
 * 要补的洞：上面所有判据都按**单个工具**统计，于是「换一个工具/换一条查询继续探」
 * 完全逃逸。2026-10-16 在 /chat 实跑一个多子问题取数：模型用 **25 条不同 SQL** 跑到
 * ~27 轮 / ~41 次工具调用，单工具重复一次都没超限，perRoundLimit / shareLimit / 阶梯
 * 全部没触发——典型的**护栏拦得住单点、收不住总量**。
 *
 * 网上最佳实践同向：迭代必须有硬上限防失控循环，逼近上限时**强制用已取到的结果总结**，
 * 而不是继续探到预算耗尽。这里给的就是那个「总量上限 + 强制收尾」的判据。
 *
 * 为什么仍要求 `evidenceCalls > 0`：没有证据时强制收尾只会得到一句「没取到数」，
 * 那属于把探索掐死。零证据的极端情形仍由轮次预算 / Doom Loop / token 预算兜底。
 */
export function forceSynthesisByToolCallTotal(
  toolCallTotal: number,
  cap: number,
  evidenceCalls: number,
): boolean {
  return cap > 0 && evidenceCalls > 0 && toolCallTotal >= cap;
}

