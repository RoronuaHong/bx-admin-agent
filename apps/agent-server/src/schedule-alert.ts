/**
 * 定时任务「预警 / 仅异常通知」纯逻辑（docs/scheduled-spike-detection-plan.md）。
 * 判定业务阈值在用户指令里；这里只认输出协议标记与恢复状态——不写死任何业务词。
 */
import { parseAlertMarker, type AlertMarker } from "@bx/shared";

export type { AlertMarker };
export { parseAlertMarker };

export type ScheduleNotifyPolicy = "always" | "on_alert";
export type SchedulePurpose = "report" | "alert";

export interface ScheduleAlertState {
  /** 当前是否处于告警中（已推过 SPIKE、尚未恢复）。 */
  firing?: boolean;
  /** 最近一次真正推送 SPIKE 的时刻。 */
  lastAlertAt?: number;
  /** 告警中连续出现 NORMAL 的期数；满 2 期触发恢复通知。 */
  normalStreak?: number;
  /**
   * 检查器失败态的起点（没有结论文本或模型调用失败）。
   * 没有这个字段 = 未在失败态。与 firing 无关：破线是业务异常，失败是检查没跑完。
   */
  failingSince?: number;
  /** 最近一次把失败通知发出去的时刻。满 60 分钟才允许再发一条。 */
  failNotifiedAt?: number;
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

/** 工具已经返回，模型却没写面向用户的正文。不能当成检查成功。 */
export const CONCLUSION_GAP_AFTER_TOOLS = "工具已经返回结果，但没有写出结论。";

/** 整轮没有任何面向用户的正文。 */
export const CONCLUSION_GAP = "这次没有写出结论。";

export function isConclusionGap(text: string): boolean {
  const body = String(text || "").trim();
  return body === CONCLUSION_GAP || body === CONCLUSION_GAP_AFTER_TOOLS;
}

/**
 * 没有检查结论时不推企业 IM。
 * 空正文、占位句，以及预警任务里认不出 [SPIKE]/[NORMAL]/[NO_DATA] 的失败，都不发。
 * 模型状态码说明是另一类结论，仍然发。
 */
export function shouldDeliverScheduleResult(input: {
  status: "success" | "failed";
  text: string;
  policy?: ScheduleNotifyPolicy;
  modelStatus?: boolean;
}): boolean {
  if (input.modelStatus) return true;
  const body = conclusionBody(input.text);
  if (!body || isConclusionGap(body)) return false;
  if (pickNotifyPolicy(input.policy) === "on_alert" && input.status === "failed" && !parseAlertMarker(input.text)) {
    return false;
  }
  return true;
}

/**
 * 定时运行的最终成败。consumeTask 只看有没有 error 事件；
 * 这里补上「有事件流但没有协议结论」：空正文、占位句、预警却没有首行标记，都记失败。
 * 不把它们改写成 [NO_DATA]，否则破线会被静默放过。
 */
/** 去掉服务端附上的任务配置句，看模型有没有写出检查结论。 */
function conclusionBody(text: string): string {
  return String(text || "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^- 名称：/.test(line))
    .join("\n")
    .trim();
}

export function scheduleFinishedStatus(input: {
  finished: "success" | "failed" | "cancelled";
  text: string;
  ungrounded: boolean;
  alert: boolean;
}): "success" | "failed" | "cancelled" {
  if (input.finished !== "success") return input.finished;
  const text = String(input.text || "").trim();
  const body = conclusionBody(text);
  if (!text || !body || isConclusionGap(body)) return "failed";
  if (input.ungrounded && !input.alert) return "failed";
  if (input.alert && !parseAlertMarker(text)) return "failed";
  return "success";
}

export const SCHEDULE_ALERT_GUIDE =
  "本次是数据预警检查（不是周期报告）。硬性规则：\n" +
  "1) 正文**第一行**单独输出且只输出下列标记之一（方括号保留）：\n" +
  "   [SPIKE]  — 按用户指令判定为异常 / 破线；\n" +
  "   [NORMAL] — 有完整计数且未破线；\n" +
  "   [NO_DATA] — 取不到数据、结果为空、或计数不完整（不要猜数）。\n" +
  "   计数结果里已有 above 与 over_count 时，服务端会按它校正这一行。\n" +
  "2) 不要写时间窗口、当前数量、阈值或任何条数。计数完整时服务端按 hours 段写成这三行；不完整时只保留 [NO_DATA]，不要编数字。\n" +
  "   不要写英文单词或字段名，不要写 complete、raw、unique、above。\n" +
  "   不要写钉钉或推送通道。\n" +
  "   不要自己写本任务是否启用、执行频率或下次时间，也不要写成无法确认。" +
  "需要时由服务端把已保存配置附在正文末尾。禁止自行换算 cron，禁止沿用本对话更早回复里的频率或时间，也不要为此再调用 list_schedules。" +
  "对话历史里出现的其它定时任务与本期无关，不要引用它们的名称、频率或状态。\n" +
  "3) **禁止** render_chart、export_data、写报告 HTML、基于截断片段估算/外推。\n" +
  "4) 取数优先短窗口（按用户指令，常见 ≤60 分钟）与**聚合/计数**接口；" +
  "列表没有总数、又要按小时或阈值计数时，调用 count_list_by_time 一次取回，不要逐页翻列表。" +
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

/**
 * 计数结果里的比较由引擎做，不交给模型心算。
 * complete 为 false → 无数据。带了 above 才比较 over_count。没带阈值则返回 null，仍由模型写标记。
 */
/** 预警指令里的破线阈值。只认「超过 N」，避免把「60 分钟」当成阈值。 */
export function alertAboveFromPrompt(prompt: string): number | null {
  const match = String(prompt || "").match(/超过\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** 模型没传 above 时补上指令里的阈值。已经传了数字就不动。 */
export function fillCountAbove(
  args: Record<string, unknown>,
  above: number | null | undefined,
): Record<string, unknown> {
  if (above == null || !Number.isFinite(above)) return args;
  const current = args.above;
  if (current != null && current !== "" && Number.isFinite(Number(current))) return args;
  return { ...args, above };
}

export function markerFromCountText(text: string): AlertMarker | null {
  const complete = String(text || "").match(/^complete:\s*(true|false)\s*$/m);
  if (!complete) return null;
  if (complete[1] === "false") return "NO_DATA";
  const above = String(text).match(/^above:\s*-?\d+(?:\.\d+)?\s*$/m);
  const over = String(text).match(/^over_count:\s*(\d+)\s*$/m);
  if (!above || !over) return null;
  return Number(over[1]) > 0 ? "SPIKE" : "NORMAL";
}

/** 用计数结论覆盖首行标记。不完整时整段换成协议句，避免模型用残缺数字写成未破线。 */
export function stampAlertMarker(text: string, marker: AlertMarker): string {
  if (marker === "NO_DATA") return SCHEDULE_UNGROUNDED_ALERT;
  const lines = String(text || "").split(/\n/);
  const first = lines[0]?.trim() || "";
  if (/^\[(SPIKE|NORMAL|NO_DATA)\]/i.test(first)) {
    lines[0] = first.replace(/^\[(SPIKE|NORMAL|NO_DATA)\]/i, `[${marker}]`);
    return lines.join("\n").trim();
  }
  const body = String(text || "").trim();
  return body ? `[${marker}]\n${body}` : `[${marker}]`;
}

const HOUR_COUNT_LINE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2})\t(\d+)\s*$/;
const MORE_HOURS_LINE = /^…其余\s*(\d+)\s*个小时/;
const RESTATED_COUNT_FACT = /^\s*(?:[-*•]\s*)?(?:时间窗口|当前数量|当前会话量|分小时会话量|阈值)\s*[:：]/;

/**
 * 预警和定时任务共用的计数结论。数字和标签都来自 count_list_by_time 的摘要，不看模型措辞。
 * 小时按时间从早到晚，避免按大小重排后每期换一种说法。不完整的计数返回 null，调用方保持原结论。
 */
export function formatScheduledCountFacts(report: string): string | null {
  const fields = new Map<string, string>();
  const grouped: Record<"hours" | "top" | "loose", Array<{ hour: string; count: number }>> = {
    hours: [],
    top: [],
    loose: [],
  };
  const moreBySection = { hours: 0, top: 0, loose: 0 };
  let section: "hours" | "top" | "loose" = "loose";
  for (const raw of String(report || "").split(/\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "hours:" || line.startsWith("hours:")) {
      section = "hours";
      continue;
    }
    if (line === "top:" || line.startsWith("top:")) {
      section = "top";
      continue;
    }
    const hour = line.match(HOUR_COUNT_LINE);
    if (hour) {
      grouped[section].push({ hour: hour[1]!, count: Number(hour[2]) });
      continue;
    }
    const extra = line.match(MORE_HOURS_LINE);
    if (extra) {
      moreBySection[section] += Number(extra[1]);
      continue;
    }
    const field = line.match(/^([a-z_]+):\s*(.*)$/);
    if (field && !fields.has(field[1]!)) fields.set(field[1]!, field[2]!.trim());
    section = "loose";
  }
  if (fields.get("complete") !== "true") return null;
  const uniqueRaw = fields.get("unique");
  const unique = uniqueRaw != null && /^\d+$/.test(uniqueRaw) ? Number(uniqueRaw) : null;
  const chosen = grouped.hours.length ? "hours" : grouped.top.length ? "top" : "loose";
  const buckets = grouped[chosen];
  const moreHours = moreBySection[chosen];
  if (unique == null && buckets.length === 0) return null;
  const ordered = [...buckets].sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0));
  const range = fields.get("range")?.match(/^(.+?)\s+\.\.\s+(.+)$/);
  let windowText = range
    ? `${range[1]} 至 ${range[2]}`
    : ordered.length === 1
      ? ordered[0]!.hour
      : ordered.length > 1
        ? `${ordered[0]!.hour} 至 ${ordered[ordered.length - 1]!.hour}`
        : "";
  const zone = fields.get("timezone") || "";
  if (zone) windowText = windowText ? `${windowText}（${zone}）` : zone;
  if (!windowText) return null;
  const total = unique ?? ordered.reduce((sum, item) => sum + item.count, 0);
  const detail = ordered.map((item) => `${item.hour} 为 ${item.count}`).join("，");
  const more = moreHours > 0 ? `，另有 ${moreHours} 个小时` : "";
  const lines = [
    `- 时间窗口：${windowText}`,
    detail ? `- 当前数量：${total}（${detail}${more}），计数完整` : `- 当前数量：${total}，计数完整`,
  ];
  const above = fields.get("above");
  if (above && /^-?\d+(?:\.\d+)?$/.test(above)) {
    const overRaw = fields.get("over_count");
    const over = overRaw && /^\d+$/.test(overRaw) ? Number(overRaw) : 0;
    const peak = ordered.length ? Math.max(...ordered.map((item) => item.count)) : null;
    const verdict = over > 0 ? `${over} 个小时破线` : "未破线";
    lines.push(`- 阈值：超过 ${above}；${peak != null ? `最高 ${peak}，` : ""}${verdict}`);
  }
  return lines.join("\n");
}

/** 去掉模型自己写的时间窗口 / 当前数量 / 阈值，避免和上面的固定三行重复。 */
function stripRestatedCountFacts(text: string): string {
  return String(text || "")
    .split(/\n/)
    .filter((line) => !RESTATED_COUNT_FACT.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 有完整计数时，用同一套三行覆盖模型正文里的数量说法。
 * 预警整段换成协议标记加这三行；定时报告把这三行放在正文前面，其余说明保留。
 */
export function applyScheduledCountFacts(input: {
  text: string;
  report: string;
  conclusion?: "alert" | "report";
  marker?: AlertMarker | null;
}): string {
  if (input.conclusion !== "alert" && input.conclusion !== "report") return input.text;
  if (input.conclusion === "alert" && input.marker === "NO_DATA") return SCHEDULE_UNGROUNDED_ALERT;
  const facts = formatScheduledCountFacts(input.report);
  if (!facts) {
    return input.conclusion === "alert" && input.marker ? stampAlertMarker(input.text, input.marker) : input.text;
  }
  if (input.conclusion === "alert") {
    const marker = input.marker || parseAlertMarker(input.text);
    return marker ? `[${marker}]\n${facts}` : facts;
  }
  const rest = stripRestatedCountFacts(input.text);
  return rest ? `${facts}\n\n${rest}` : facts;
}

export function pickNotifyPolicy(value?: unknown): ScheduleNotifyPolicy {
  return value === "on_alert" ? "on_alert" : "always";
}

export function pickPurpose(value?: unknown): SchedulePurpose | undefined {
  if (value === "alert" || value === "report") return value;
  return undefined;
}

/**
 * 启动确认文案跟「之后怎么推」走，不跟表单上的用途标签走。
 * 仅异常策略即使用途写成报告，也不能告诉收件人「之后每期都推」。
 */
export function deliveryArmPurpose(input: {
  purpose?: SchedulePurpose;
  notifyPolicy?: ScheduleNotifyPolicy;
}): "report" | "alert" {
  if (pickNotifyPolicy(input.notifyPolicy) === "on_alert" || input.purpose === "alert") return "alert";
  return "report";
}

/**
 * 这一期要不要附带启动确认。
 * - 显式 armPending：新建、重新启用，或上一期通道没发出去。
 * - 旧预警没有这个字段：只要还没确认过就补一次。
 * - 旧的周期报告已经跑过（有 lastRunAt）不补，避免下一拍被写成「刚启动」。
 *   从没跑过的仍补，创建后的第一期才不会漏。
 */
export function needsArmNotice(input: {
  armPending?: boolean;
  armedNotifiedAt?: number | null;
  notifyPolicy?: unknown;
  lastRunAt?: number | null;
}): boolean {
  if (input.armPending === true) return true;
  if (input.armedNotifiedAt != null) return false;
  if (pickNotifyPolicy(input.notifyPolicy) === "on_alert") return true;
  return input.lastRunAt == null;
}

export type AlertDeliveryKind = "spike" | "recovered" | "skip" | "started";

/** 同一失败态的再通知间隔。按跑完时刻算，不按 cron 拍数。 */
export const ALERT_FAIL_REPEAT_MS = 60 * 60_000;

export type AlertFailureKind = "notify" | "skip";

/**
 * 预警任务里「没写完结论」的执行失败怎么通知。
 * 模型 402 / 429 / 500 / 502 / 503 / 504 不走 60 分钟合并，由调用方传 force，每一期都推。
 * 业务破线不走这里。[SPIKE] 仍每期都推。
 * - 刚进入失败态：推一条；
 * - 已经在失败态且距上次通知不足 60 分钟：不推；
 * - 满 60 分钟仍失败：再推一条，并重新计这 60 分钟；
 * - force：启动确认必须发出。记成一次失败通知，避免下一期又当「刚失败」再推。
 */
export function decideAlertFailure(input: {
  alertState?: ScheduleAlertState;
  now?: number;
  force?: boolean;
}): { kind: AlertFailureKind; nextState: ScheduleAlertState } {
  const now = input.now ?? Date.now();
  const prev = input.alertState || {};
  const base: ScheduleAlertState = {
    ...(prev.firing ? { firing: true } : { firing: false }),
    ...(prev.lastAlertAt !== undefined ? { lastAlertAt: prev.lastAlertAt } : {}),
    ...(prev.normalStreak ? { normalStreak: prev.normalStreak } : { normalStreak: 0 }),
  };
  const since = prev.failingSince;
  const notified = prev.failNotifiedAt;
  const inFailure = since !== undefined && notified !== undefined;
  const due = !inFailure || now - notified >= ALERT_FAIL_REPEAT_MS || input.force === true;
  if (!due) {
    return {
      kind: "skip",
      nextState: { ...base, failingSince: since, failNotifiedAt: notified },
    };
  }
  return {
    kind: "notify",
    nextState: {
      ...base,
      failingSince: inFailure ? since : now,
      failNotifiedAt: now,
    },
  };
}

/**
 * 失败通知没发出去时，不要把 failNotifiedAt 往前拨。
 * 否则通道挂了会吞掉下一次该发的失败提醒。failingSince 仍保留，失败态不断。
 */
export function commitAlertFailureNotice(
  decided: ScheduleAlertState,
  previous: ScheduleAlertState | undefined,
  sent: boolean,
): ScheduleAlertState {
  if (sent) return decided;
  const next: ScheduleAlertState = { ...decided };
  if (previous?.failNotifiedAt !== undefined) next.failNotifiedAt = previous.failNotifiedAt;
  else delete next.failNotifiedAt;
  return next;
}

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

/** 定时运行默认拒绝的内置工具。交互式对话不传这份清单。澄清会空等用户，记忆会写进以后每一轮。 */
export const SCHEDULE_DENIED_BUILTINS = [
  "manage_schedule",
  "list_schedules",
  "fs_delete",
  "run_command",
  "run_script",
  "request_clarification",
  "save_memory",
] as const;

/** 写进系统提示的拒绝句。工具名只从上面的清单来，避免提示和执行闸各写一份。 */
export function unattendedDenySentence(): string {
  return `无人值守不允许调用 ${SCHEDULE_DENIED_BUILTINS.join("、")}；若仍调用，会被拒绝并记入本期记录。`;
}

/** 定时运行拒绝执行时写进本期工具记录的说明（交互式对话不走这里）。 */
const UNATTENDED_DENY_REASON: Record<string, string> = {
  fs_delete: "无人值守不允许删除文件",
  run_command: "无人值守不允许执行系统命令",
  run_script: "无人值守不允许执行脚本",
  manage_schedule: "无人值守不允许改定时任务",
  list_schedules: "本期只看当前任务。其它定时任务不在这次运行里，启用状态和频率以系统提示中的本任务配置为准",
  render_chart: "预警检查不允许出图",
  export_data: "预警检查不允许导出文件",
  request_clarification: "无人值守没有人回答澄清",
  save_memory: "无人值守不允许写入长期记忆",
};

export function unattendedToolDenial(name: string): string {
  const why = UNATTENDED_DENY_REASON[name] || "无人值守不允许这个操作";
  return `定时运行拒绝执行 ${name}：${why}。本次拒绝已记入本期记录。`;
}
