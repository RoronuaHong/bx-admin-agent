/**
 * 运维告警推送（钉钉自定义机器人 Webhook）。
 *
 * - 未配 ALERT_DINGTALK_WEBHOOK → 静默 no-op（不抛错）。
 * - 触发源：预算告警文案 / 劣化 degradeHint（调用方传入 messages）。
 * - 去重：同 fingerprint 在 ALERT_DEDUP_MS（默认 30min）内只推一次。
 * - 开关：ALERT_BUDGET_NOTIFY / ALERT_DEGRADE_NOTIFY（默认 true；设 0/false 关）。
 * - 零业务词；零新依赖；推送失败只打日志。
 */

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

export function alertNotifyEnabled(kind: "budget" | "degrade"): boolean {
  const envName = kind === "budget" ? "ALERT_BUDGET_NOTIFY" : "ALERT_DEGRADE_NOTIFY";
  const raw = (process.env[envName] ?? "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

export function getAlertDedupMs(): number {
  const n = Number(process.env.ALERT_DEDUP_MS);
  return Number.isFinite(n) && n >= 0 ? n : 30 * 60 * 1000;
}

/** 可注入的 sender（单测用）；默认 POST 钉钉机器人 text。 */
export type AlertSender = (webhook: string, title: string, body: string) => Promise<void>;

let senderImpl: AlertSender = defaultDingTalkSender;

export function setAlertSender(fn: AlertSender | null): void {
  senderImpl = fn || defaultDingTalkSender;
}

export function resetAlertDedupState(): void {
  dedupMap().clear();
}

async function defaultDingTalkSender(webhook: string, title: string, body: string): Promise<void> {
  const content = `${title}\n\n${body}`.slice(0, 4000);
  const resp = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msgtype: "text",
      text: { content },
    }),
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
  kind: "budget" | "degrade";
  title?: string;
  messages: string[];
  now?: number;
  /** 单测：跳过真实 webhook 读 env */
  webhook?: string;
  /** 单测：注入 sender，避免模块双实例导致 setAlertSender 失效 */
  sender?: AlertSender;
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
  const title = opts.title || (opts.kind === "budget" ? "[bx-agent] 预算告警" : "[bx-agent] 上游劣化告警");
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
  try {
    await send(webhook, title, toSend.map((m) => `• ${m}`).join("\n"));
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
