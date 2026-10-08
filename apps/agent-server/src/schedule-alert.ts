/**
 * 定时任务「预警 / 仅异常通知」纯逻辑（docs/scheduled-spike-detection-plan.md）。
 * 判定业务阈值在用户指令里；这里只认输出协议标记与恢复状态——不写死任何业务词。
 */
export type ScheduleNotifyPolicy = "always" | "on_alert";
export type SchedulePurpose = "report" | "alert";

/** 模型按协议写在结论首行的标记（大小写不敏感）。 */
export type AlertMarker = "SPIKE" | "NORMAL" | "NO_DATA";

export interface ScheduleAlertState {
  /** 当前是否处于告警中（已推过 SPIKE、尚未恢复）。 */
  firing?: boolean;
  /** 最近一次真正推送 SPIKE 的时刻。 */
  lastAlertAt?: number;
  /** 告警中连续出现 NORMAL 的期数；满 2 期触发恢复通知。 */
  normalStreak?: number;
}

/**
 * 预警模式专用指引（替代报告型 SCHEDULE_TASK_GUIDE 里「必须出图」那套）。
 * 实测坑：列表 MCP 单页可达数百 KB，工具结果预算约 12KB 会截断；模型若去 parse 截断片、
 * 估数、再 render_chart / export_data，就会出现「正文 [NO_DATA] + 无关图表/HTML」的脏产出。
 * 成功跑完时投递旁路只认首行标记，不解析正文语义。
 */
/** 定时预警在「本该取数却一条数据都没有」时的正文。不要写阈值：指令里未必有阈值。 */
export const SCHEDULE_UNGROUNDED_ALERT =
  "[NO_DATA]\n这次没有取到可核对的数据，没有下结论。";

/** 定时报告在同样情况下的正文。不是交互对话那句道歉，也不编数字。 */
export const SCHEDULE_UNGROUNDED_REPORT = "这次没有取到可核对的数据，没有写结论。";

export const SCHEDULE_ALERT_GUIDE =
  "本次是数据预警检查（不是周期报告）。硬性规则：\n" +
  "1) 正文**第一行**单独输出且只输出下列标记之一（方括号保留）：\n" +
  "   [SPIKE]  — 按用户指令判定为异常 / 破线；\n" +
  "   [NORMAL] — 有完整计数且未破线；\n" +
  "   [NO_DATA] — 取不到数据、结果为空、或计数不完整（不要猜数）。\n" +
  "2) 第一行之后最多再写 3～5 行，全部用中文：时间窗口、当前数量、阈值。\n" +
  "   不要写英文单词或字段名，不要写 complete、raw、unique、above。\n" +
  "   不要写任务开关、下次执行时间、钉钉或推送通道。任务名、状态和时间由通知另附。\n" +
  "3) **禁止** render_chart、export_data、写报告 HTML、基于截断片段估算/外推。\n" +
  "4) 取数优先短窗口（按用户指令，常见 ≤60 分钟）与**聚合/计数**接口；" +
  "列表没有总数、又要按小时或阈值计数时，调用 count_list_by_time 一次取回，不要逐页翻列表。" +
  "会话列表的小时按开始时间计；排序字段不是每条会话的开始时间，不要拿它当分桶字段。" +
  "小时桶以外的汇总用 run_tool_code，不要用 run_script 翻页。" +
  "参数说明里没有的筛选字段不要写进查询参数。" +
  "若工具结果含「结果已截断」或首行 complete: false（计数不完整），禁止用该片段估算——仍不完整则 [NO_DATA]。\n" +
  "5) 必须重新取数；不得沿用本对话历史轮次的结论或数字。不要改用户指令里的阈值。" +
  "无 meaningful 变化时不要写长报告（引擎侧已按标记决定是否推送）。";

/**
 * 无人值守收束正文的协议化：接地护栏最终判定「没取到可核对的数据」时，把正文换成协议结论。
 *
 * 为什么按状态判定而不是比对措辞：这段正文是**模型写的受约束诚实兜底**，措辞每期都可能不同
 * （实测出现过「没有实际取数」「未进行实际取数」）。原实现只在正文恰好等于确定性兜底文案时才注入
 * 协议行，于是一旦模型自由发挥，预警正文就没有首行标记 —— parseAlertMarker 认不出来，
 * 既落不到 marker，也和「模型没遵守协议」无法区分。判定依据只能是状态（本轮是否取证失败）。
 */
export function buildUnattendedConclusion(input: {
  /** 本轮是否因「纠正后仍未取得工具数据」收束（chat.ts 的接地护栏状态）。 */
  ungrounded: boolean;
  /** 任务类型；不传 = 交互对话，正文原样不动。 */
  conclusion?: "alert" | "report";
  /** 收束正文（已过角色身份护栏）。 */
  text: string;
}): string {
  const body = String(input.text || "").trim();
  if (!input.ungrounded || !input.conclusion) return body;
  if (input.conclusion === "report") return body || SCHEDULE_UNGROUNDED_REPORT;
  // 预警：首行必须是协议标记。模型按指引自己写了标记就尊重它，没写就换成确定性协议句
  // （不追加模型那句自由措辞——它是交互语境的话术，在这里只是噪音）。
  return parseAlertMarker(body) ? body : SCHEDULE_UNGROUNDED_ALERT;
}

/** 从结论正文解析首行协议标记；认不出来返回 null（on_alert 下按不推处理）。 */
export function parseAlertMarker(text: string): AlertMarker | null {
  const first = String(text || "")
    .trim()
    .split(/\r?\n/, 1)[0]
    ?.trim() || "";
  const m = first.match(/^\[(SPIKE|NORMAL|NO_DATA)\]\s*$/i)
    || first.match(/^\[(SPIKE|NORMAL|NO_DATA)\](?:\s|$)/i);
  if (!m) return null;
  return m[1]!.toUpperCase() as AlertMarker;
}

export function pickNotifyPolicy(value?: unknown): ScheduleNotifyPolicy {
  return value === "on_alert" ? "on_alert" : "always";
}

export function pickPurpose(value?: unknown): SchedulePurpose | undefined {
  if (value === "alert" || value === "report") return value;
  return undefined;
}

export type AlertDeliveryKind = "spike" | "recovered" | "skip" | "started";

/**
 * 根据本期标记与任务上的 alertState 决定是否推送，并算出下一期状态。
 * - SPIKE：每期都推。同一条异常持续破线也会再发，不做时间去重。
 * - NORMAL：告警中连续 2 期才推「已恢复」。
 * - NO_DATA / 无标记：不推；NO_DATA 打断恢复计数，但不清除 firing。
 * - arming：启用后还没发过启动确认。本来会跳过的一期改成推「已启动」（不论是否破线）。
 *   已经是 SPIKE / 恢复的仍用原类型，由通知正文另附「已启动」。
 */
export function decideAlertDelivery(input: {
  marker: AlertMarker | null;
  alertState?: ScheduleAlertState;
  now?: number;
  /** 启用后尚未发出启动确认。 */
  arming?: boolean;
}): { kind: AlertDeliveryKind; nextState: ScheduleAlertState } {
  const now = input.now ?? Date.now();
  const prev = input.alertState || {};
  const firing = Boolean(prev.firing);
  const lastAlertAt = prev.lastAlertAt;
  const streak = Math.max(0, Number(prev.normalStreak) || 0);
  const finish = (kind: AlertDeliveryKind, nextState: ScheduleAlertState) =>
    input.arming && kind === "skip" ? { kind: "started" as const, nextState } : { kind, nextState };

  if (input.marker === "SPIKE") {
    return finish("spike", { firing: true, lastAlertAt: now, normalStreak: 0 });
  }

  if (input.marker === "NORMAL") {
    if (!firing) {
      return finish("skip", { firing: false, ...(lastAlertAt !== undefined ? { lastAlertAt } : {}), normalStreak: 0 });
    }
    const nextStreak = streak + 1;
    if (nextStreak >= 2) {
      return finish("recovered", { firing: false, ...(lastAlertAt !== undefined ? { lastAlertAt } : {}), normalStreak: 0 });
    }
    return finish("skip", { firing: true, ...(lastAlertAt !== undefined ? { lastAlertAt } : {}), normalStreak: nextStreak });
  }

  // NO_DATA 或无法识别：不推；打断恢复计数，保留 firing。
  return finish("skip", {
    ...(firing ? { firing: true } : { firing: false }),
    ...(lastAlertAt !== undefined ? { lastAlertAt } : {}),
    normalStreak: 0,
  });
}

/** 破线后加密检查的下限（5 分钟）。引擎自己算，不改用户存的 cron，也不交给模型改。 */
export const ALERT_MIN_TIGHT_MS = 5 * 60_000;

/**
 * 预警的下一拍：平稳时按 cron；处于告警中或本期是 SPIKE 时，改到「名义间隔的一半」（不低于 5 分钟），
 * 且不会比 cron 的下一拍更晚。cron 表达式本身不改。非预警、或算不出 cron 下一拍时，原样返回 cron 结果。
 */
export function alertNextRunAt(input: {
  cron: string;
  finishedAt: number;
  purpose?: SchedulePurpose;
  firing: boolean;
  marker?: AlertMarker | null;
  cronNext: (cron: string, after: Date) => number | undefined;
}): number | undefined {
  const after = new Date(input.finishedAt + 1000);
  const cronNext = input.cronNext(input.cron, after);
  const hot = input.purpose === "alert" && (input.marker === "SPIKE" || input.firing);
  if (!hot || cronNext === undefined) return cronNext;
  const following = input.cronNext(input.cron, new Date(cronNext));
  const interval = following !== undefined && following > cronNext ? following - cronNext : cronNext - input.finishedAt;
  const tight = Math.max(ALERT_MIN_TIGHT_MS, Math.floor(Math.max(interval, 0) / 2));
  return Math.min(input.finishedAt + tight, cronNext);
}

/** 定时运行拒绝执行时写进本期工具记录的说明（交互式对话不走这里）。 */
const UNATTENDED_DENY_REASON: Record<string, string> = {
  fs_delete: "无人值守不允许删除文件",
  run_command: "无人值守不允许执行系统命令",
  run_script: "无人值守不允许执行脚本",
  manage_schedule: "无人值守不允许改定时任务",
  render_chart: "预警检查不允许出图",
  export_data: "预警检查不允许导出文件",
  request_clarification: "无人值守没有人回答澄清",
};

export function unattendedToolDenial(name: string): string {
  const why = UNATTENDED_DENY_REASON[name] || "无人值守不允许这个操作";
  return `定时运行拒绝执行 ${name}：${why}。本次拒绝已记入本期记录。`;
}
