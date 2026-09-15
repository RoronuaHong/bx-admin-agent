/**
 * 运维告警推送（钉钉自定义机器人 Webhook）。
 *
 * - 未配 ALERT_DINGTALK_WEBHOOK → 静默 no-op（不抛错）。
 * - 触发源：预算告警 / 劣化 degradeHint / 数据分析巡检（调用方传入 messages）。
 * - 去重：同 fingerprint 在 ALERT_DEDUP_MS（默认 30min）内只推一次；kind 进入 fingerprint，互不串扰。
 * - 开关：ALERT_BUDGET_NOTIFY / ALERT_DEGRADE_NOTIFY / ALERT_ANALYTICS_NOTIFY（默认 true；设 0/false 关）。
 * - 零业务词；零新依赖；推送失败只打日志。
 */

export type AlertKind = "budget" | "degrade" | "analytics";

export interface AlertNotifyResult {
  attempted: boolean;
  sent: number;
  skippedDedup: number;
  skippedDisabled: boolean;
  error?: string;
}

const g = globalThis as unknown as { __bxAlertDedup?: Map<string, number> };

function dedupMap(): Map<string, number> {
  // 挂 globalThis：避免 tsx 双实例加载时 reset 与 notify 各用一份 Map，导致「全被去重」假阳性
  if (!g.__bxAlertDedup) g.__bxAlertDedup = new Map();
  return g.__bxAlertDedup;
}

export function getAlertWebhook(): string {
  return (process.env.ALERT_DINGTALK_WEBHOOK || "").trim();
}

const KIND_NOTIFY_ENV: Record<AlertKind, string> = {
  budget: "ALERT_BUDGET_NOTIFY",
  degrade: "ALERT_DEGRADE_NOTIFY",
  analytics: "ALERT_ANALYTICS_NOTIFY",
};

export function alertNotifyEnabled(kind: AlertKind): boolean {
  const envName = KIND_NOTIFY_ENV[kind];
  const raw = (process.env[envName] ?? "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

export function getAlertDedupMs(): number {
  const n = Number(process.env.ALERT_DEDUP_MS);
  return Number.isFinite(n) && n >= 0 ? n : 30 * 60 * 1000;
}

function defaultTitle(kind: AlertKind): string {
  if (kind === "budget") return "[bx-agent] 预算告警";
  if (kind === "degrade") return "[bx-agent] 上游劣化告警";
  return "[bx-agent] 数据分析巡检";
}

export type AlertFormat = "text" | "markdown" | "action_card";

/** action_card 独立跳转按钮（title 最长 20 字符、url 最长 500 字符，超长由发送端截断）。 */
export interface AlertAction {
  title: string;
  action_url: string;
}

/**
 * 可注入的 sender（单测用）；默认 POST 钉钉机器人。
 * 第 4 参数可选（只写 3 个参数的旧 sender 仍兼容）：
 * - format：text / markdown / action_card（卡片正文仍是 markdown，另附按钮）。
 * - actions：action_card 独立跳转按钮；为空时 action_card 自动降级为 markdown。
 */
export type AlertSender = (
  webhook: string,
  title: string,
  body: string,
  opts?: { format?: AlertFormat; actions?: AlertAction[]; btnOrientation?: "0" | "1" },
) => Promise<void>;

let senderImpl: AlertSender = defaultDingTalkSender;

export function setAlertSender(fn: AlertSender | null): void {
  senderImpl = fn || defaultDingTalkSender;
}

export function resetAlertDedupState(): void {
  dedupMap().clear();
}

async function defaultDingTalkSender(
  webhook: string,
  title: string,
  body: string,
  opts?: { format?: AlertFormat; actions?: AlertAction[]; btnOrientation?: "0" | "1" },
): Promise<void> {
  const format: AlertFormat = opts?.format ?? "text";
  // 按钮参数按钉钉限制截断：btn title ≤20 字符、actionURL ≤500 字符。
  const btns = (opts?.actions ?? []).map((a) => ({
    title: a.title.slice(0, 20),
    actionURL: a.action_url.slice(0, 500),
  }));
  // text：标题+正文合并为一条纯文本（长度上限约 4000）。
  // markdown：title 为通知标题（会话列表首屏透出），text 为正文，支持 标题/加粗/链接/图片/列表 ——
  //   这是「消息里带图表」的唯一可行通道（自定义机器人 webhook 不支持 msgtype=image，
  //   内嵌图只能走 markdown ![](url)，且该 url 须公网可达）。
  // actionCard：卡片正文仍是 markdown + 独立跳转按钮（真实可点按钮，比正文里的蓝色文字链接更"人类"）。
  // ⚠️ 字段形状（2026-09-15 实测 400105 踩坑）：自定义机器人是驼峰 `actionCard` + `text` +
  //    `btns[{title, actionURL}]`；`action_card`/`btn_json_list`/`action_url` 是
  //    「员工服务台机器人」的形状，自定义机器人会直接拒收。
  // text 上限与 markdown 同源（官方"建议 1000 字符"是建议非硬限，实测长正文+按钮可送达；
  // 真硬限是单消息 20000 字节）。若沿用 1000 截断，巡检正文的柱状图/指纹行会被拦腰切掉。

  // 钉钉自定义机器人「关键词安全设置」：消息正文（与标题）须含指定词，否则被静默拒收
  //（HTTP 200 + errcode 310000，不报错）。把 ALERT_KEYWORD 注入正文/标题，保证通过校验。
  const kw = (process.env.ALERT_KEYWORD || "").trim();
  let finalTitle = title;
  let finalBody = body;
  if (kw) {
    if (!finalBody.includes(kw)) finalBody = `${finalBody}\n\n${kw}`;
    if (!finalTitle.includes(kw)) finalTitle = `${finalTitle} ${kw}`;
  }

  const payload =
    format === "action_card" && btns.length
      ? {
          msgtype: "actionCard",
          actionCard: {
            title: finalTitle.slice(0, 100),
            text: finalBody.slice(0, 18000),
            btnOrientation: opts?.btnOrientation ?? "0",
            btns,
          },
        }
      : format === "markdown" || format === "action_card"
        ? { msgtype: "markdown", markdown: { title: finalTitle.slice(0, 180), text: finalBody.slice(0, 18000) } }
        : { msgtype: "text", text: { content: `${finalTitle}\n\n${finalBody}`.slice(0, 4000) } };

  const resp = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const raw = await resp.text();
  let data: { errcode?: number; errmsg?: string } = {};
  try {
    data = JSON.parse(raw) as { errcode?: number; errmsg?: string };
  } catch {
    /* 非 JSON */
  }
  if (!resp.ok) {
    throw new Error(`dingtalk http ${resp.status}: ${raw.slice(0, 200)}`);
  }
  if (data.errcode && data.errcode !== 0) {
    throw new Error(`dingtalk errcode=${data.errcode} ${data.errmsg || ""}`);
  }
}

/**
 * 推送一组告警文案（已去重）。返回统计；永不抛到调用方。
 */
export async function notifyAlerts(opts: {
  kind: AlertKind;
  title?: string;
  messages: string[];
  now?: number;
  /** 单测：跳过真实 webhook 读 env */
  webhook?: string;
  /** 单测：注入 sender，避免模块双实例导致 setAlertSender 失效 */
  sender?: AlertSender;
  /** 载荷格式（默认 text）；markdown/action_card 才支持内嵌图/加粗/链接。 */
  format?: AlertFormat;
  /** action_card 独立跳转按钮（format 为 action_card 时使用）。 */
  actions?: AlertAction[];
  /** 按钮排列：0 竖排（默认）/ 1 横排。 */
  btnOrientation?: "0" | "1";
}): Promise<AlertNotifyResult> {
  const messages = [...new Set((opts.messages || []).map((m) => m.trim()).filter(Boolean))];
  if (!messages.length) {
    return { attempted: false, sent: 0, skippedDedup: 0, skippedDisabled: false };
  }
  if (!alertNotifyEnabled(opts.kind)) {
    return { attempted: false, sent: 0, skippedDedup: 0, skippedDisabled: true };
  }
  const webhook = (opts.webhook !== undefined ? opts.webhook : getAlertWebhook()).trim();
  if (!webhook) {
    return { attempted: false, sent: 0, skippedDedup: 0, skippedDisabled: false };
  }

  const now = opts.now ?? Date.now();
  const dedupMs = getAlertDedupMs();
  const title = opts.title || defaultTitle(opts.kind);
  let sent = 0;
  let skippedDedup = 0;
  const toSend: string[] = [];

  for (const msg of messages) {
    const fp = `${opts.kind}:${msg}`;
    const prev = dedupMap().get(fp);
    // 仅当曾经成功记过时才去重；prev 缺失时不能用 0（否则 now<dedupMs 会被误判为重复）
    if (prev !== undefined && dedupMs > 0 && now - prev < dedupMs) {
      skippedDedup += 1;
      continue;
    }
    toSend.push(msg);
    dedupMap().set(fp, now);
  }

  if (!toSend.length) {
    return { attempted: true, sent: 0, skippedDedup, skippedDisabled: false };
  }

  const send = opts.sender || senderImpl;
  const format: AlertFormat = opts.format ?? "text";
  try {
    // 结构化正文（markdown/action_card）保留调用方排版；纯 text 才补 bullet 前缀。
    const body =
      format === "markdown" || format === "action_card"
        ? toSend.join("\n\n")
        : toSend.map((m) => `• ${m}`).join("\n");
    await send(webhook, title, body, {
      format,
      actions: opts.actions,
      btnOrientation: opts.btnOrientation,
    });
    sent = toSend.length;
    return { attempted: true, sent, skippedDedup, skippedDisabled: false };
  } catch (e) {
    // 失败回滚 dedup 标记，允许下次重试
    for (const msg of toSend) dedupMap().delete(`${opts.kind}:${msg}`);
    const error = e instanceof Error ? e.message : String(e);
    console.error("[alert-notify] 推送失败:", error);
    return { attempted: true, sent: 0, skippedDedup, skippedDisabled: false, error };
  }
}
