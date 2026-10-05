// 安全审计留痕（append-only JSONL，写操作安全闸门 P0-7）。
// 记录「谁在什么时候批准/拒绝了哪个操作、参数摘要是什么」，事后可查。
// 写失败只 console，不阻断主流程（best-effort）；凭据不落盘：参数只存脱敏摘要 + sha256。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadChannels } from "./notify/channels.js";
import { deliverToChannels } from "./notify/deliver.js";
import type { DeliveryMessage } from "./notify/deliver.js";

export type AuditDecision =
  | "allowed" // 只读外部工具直接放行（工作区工具不记，避免噪音）
  | "confirmed" // 用户批准
  | "denied" // 用户拒绝 / deny 口径拒绝
  | "timeout" // 确认等待超时（按拒绝）
  | "grant_read" // 会话级只读授权写入
  | "subagent_refused" // 子代理尝试非只读操作被立即拒绝
  | "clarify_deferred" // 待澄清期间被冻结暂缓的非只读调用（未执行、未产生副作用）
  | "memory_write" // 长期记忆写入（OWASP ASI04 记忆投毒：留痕才能回溯是谁/哪次会话写进去的）
  | "ownership_mismatch"; // 确认应答与当前会话不匹配

export interface AuditEvent {
  at: number;
  kind: "gate";
  decision: AuditDecision;
  conversationId?: string;
  sessionId?: string;
  /** 设备 owner 标注；缺省 = 遗留事件（对所有人可见，与对话口径一致）。 */
  ownerKey?: string;
  tool: string;
  server?: string;
  level?: string;
  unknown?: boolean;
  reason?: string;
  ticket?: string;
  /** 参数摘要（脱敏后）。 */
  argsSummary?: Array<{ key: string; value: string }>;
  /** 参数原文 sha256：便于比对而不存原文。 */
  argsDigest?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIT_DIR = resolve(__dirname, "..", ".data", "audit");

function monthFile(at: number): string {
  const d = new Date(at);
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
  return resolve(AUDIT_DIR, `audit-${ym}.jsonl`);
}

function argsDigestOf(args?: string): string | undefined {
  const text = (args || "").trim();
  if (!text) return undefined;
  return createHash("sha256").update(text).digest("hex");
}

/** 追加一条审计事件；append-only，失败仅告警不抛错。 */
export function appendAudit(event: Omit<AuditEvent, "at" | "kind"> & { kind?: AuditEvent["kind"] }): void {
  const record: AuditEvent = { at: Date.now(), kind: "gate", ...event };
  try {
    mkdirSync(AUDIT_DIR, { recursive: true });
    appendFileSync(monthFile(record.at), `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    console.warn(`[audit] 写入失败：${String((err as Error)?.message || err)}`);
  }
  // 高风险决策主动推送告警（fail-soft：投递失败不影响主流程）。
  if (AUDIT_ALERT_DECISIONS.has(record.decision)) {
    if (!AUDIT_ALERT_THROTTLE) {
      void deliverAuditAlert(record);
      return;
    }
    const key = alertKeyOf(record);
    const decision = decideAuditAlert({ now: record.at, state: alertStates.get(key) });
    if (alertStates.size >= ALERT_STATE_CAP && !alertStates.has(key)) alertStates.clear();
    alertStates.set(key, decision.next);
    // 不推的那些不是丢了：JSONL 里一条不少，只是不打扰人。
    if (decision.deliver) void deliverAuditAlert(record, decision.count);
  }
}

// 需要主动推送告警的审计决策（拒绝 / 越权 / 子代理拒绝 / 超时）。
const AUDIT_ALERT_DECISIONS = new Set<AuditDecision>([
  "denied",
  "ownership_mismatch",
  "subagent_refused",
  "timeout",
]);

// ───────────────────── 告警节流（dedup + throttle） ─────────────────────
// 拒绝一次就推一条，等于把「用户正常点了不同意」变成刷屏：真实对话里拒绝写操作是常态，
// 真正值得告警的是**同一来源短时间内反复被拒**（探测/误配的信号），而不是单次拒绝。
// 与定时任务告警同口径：窗口内累计到阈值才推，推完进冷静期，冷静期内只累计不推，
// 冷静期结束还有新增就再推一条**带累计条数**的汇总（不丢信息，也不刷屏）。
// 状态只在进程内（重启即重置）：这是提示级告警，不是合规留痕——留痕仍在 append-only JSONL。

/** 累计窗口（默认 10 分钟）：跨窗口重新计数。 */
export const AUDIT_ALERT_WINDOW_MS = Math.max(
  60_000,
  Number(process.env.AUDIT_ALERT_WINDOW_MS) || 10 * 60_000,
);
/** 冷静期（默认 30 分钟）：推送后抑制时长，期内事件照常累计。 */
export const AUDIT_ALERT_COOLDOWN_MS = Math.max(
  60_000,
  Number(process.env.AUDIT_ALERT_COOLDOWN_MS) || 30 * 60_000,
);
/** 窗口内累计多少条才推第一条（默认 3）。 */
export const AUDIT_ALERT_BURST = Math.max(1, Number(process.env.AUDIT_ALERT_BURST) || 3);
/** 总开关：off = 退回「每次都推」的旧行为。 */
export const AUDIT_ALERT_THROTTLE = (process.env.AUDIT_ALERT_THROTTLE || "on").toLowerCase() !== "off";
/** 同一来源的节流键上限（防无限增长；超限整体清空，重启后自然重建）。 */
const ALERT_STATE_CAP = 500;

export interface AuditAlertState {
  /** 当前窗口内累计条数。 */
  count: number;
  /** 窗口起点。 */
  since: number;
  /** 上次推送时刻（冷静期锚点）。 */
  lastAlertAt?: number;
}

/**
 * 纯决策函数：这条事件要不要推告警。
 * - 跨窗口（now - since > windowMs）→ 重新计数；
 * - 冷静期内 → 只累计，不推；
 * - 累计未到阈值 → 不推；
 * - 到阈值 → 推，并把累计清零、锚定冷静期（推的文案带上本次累计条数）。
 */
export function decideAuditAlert(input: {
  now: number;
  state?: AuditAlertState;
  windowMs?: number;
  cooldownMs?: number;
  burst?: number;
}): { deliver: boolean; count: number; next: AuditAlertState } {
  const now = input.now;
  const windowMs = input.windowMs ?? AUDIT_ALERT_WINDOW_MS;
  const cooldownMs = input.cooldownMs ?? AUDIT_ALERT_COOLDOWN_MS;
  const burst = Math.max(1, input.burst ?? AUDIT_ALERT_BURST);
  const prev = input.state;
  // 跨窗口：上一窗口的累计不再影响本窗口。
  const stale = !prev || now - prev.since > windowMs;
  const count = (stale ? 0 : prev!.count) + 1;
  const since = stale ? now : prev!.since;
  const lastAlertAt = stale ? undefined : prev!.lastAlertAt;
  const inCooldown = lastAlertAt !== undefined && now - lastAlertAt < cooldownMs;
  if (inCooldown || count < burst) {
    return { deliver: false, count, next: { count, since, ...(lastAlertAt !== undefined ? { lastAlertAt } : {}) } };
  }
  return { deliver: true, count, next: { count: 0, since: now, lastAlertAt: now } };
}

/** 节流状态（进程内）：键 = 归属/会话 + 工具名。 */
const alertStates = new Map<string, AuditAlertState>();

/** 节流键：按「谁 + 哪个工具」聚合，避免不同来源互相压制。 */
function alertKeyOf(event: AuditEvent): string {
  const who = event.ownerKey || event.sessionId || "(unknown)";
  return `${who}|${event.tool}${event.server ? `@${event.server}` : ""}`;
}

// 把高风险审计事件推送到已启用的通知渠道。
// 可通过 AUDIT_ALERT_CHANNELS 环境变量（逗号分隔的 channel id）收窄范围；未设置则推全部启用渠道。
export function deliverAuditAlert(event: AuditEvent, aggregated?: number): void {
  try {
    const scoped = (process.env.AUDIT_ALERT_CHANNELS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const channels = loadChannels().filter((c) => c.enabled !== false && (!scoped.length || scoped.includes(c.id)));
    if (!channels.length) return;
    const lines = [
      `决策：${event.decision}`,
      `工具：${event.tool}${event.server ? `（${event.server}）` : ""}`,
      `时间：${new Date(event.at).toLocaleString()}`,
    ];
    // 聚合推送时带上被合并的条数：不让人以为只发生了一次。
    if (aggregated && aggregated > 1) lines.push(`合并：本窗口内同类事件 ${aggregated} 条（其余已合并，明细查审计留痕）`);
    if (event.ownerKey) lines.push(`归属：${event.ownerKey}`);
    if (event.reason) lines.push(`原因：${event.reason}`);
    const message: DeliveryMessage = {
      title: "bx-agent 安全审计告警",
      body: lines.join("\n"),
    };
    void deliverToChannels(channels, message).catch((err) => {
      console.warn(`[audit] 告警投递失败：${String((err as Error)?.message || err)}`);
    });
  } catch (err) {
    console.warn(`[audit] 告警投递异常：${String((err as Error)?.message || err)}`);
  }
}

export { argsDigestOf };

export interface AuditFilter {
  fromDay?: string; // YYYY-MM-DD（含）
  toDay?: string; // YYYY-MM-DD（含）
  decision?: AuditDecision;
  tool?: string;
  limit?: number;
  /** 归属过滤：命中该 owner 的事件 + 无主遗留事件（与对话/记忆同一口径）。 */
  ownerKey?: string;
}

function dayToTs(day: string, endOfDay: boolean): number {
  const ts = new Date(`${day}T00:00:00`).getTime();
  return endOfDay ? ts + 24 * 3600_000 - 1 : ts;
}

function monthFilesInRange(from?: number, to?: number): string[] {
  if (!existsSync(AUDIT_DIR)) return [];
  return readdirSync(AUDIT_DIR)
    .filter((name) => /^audit-\d{6}\.jsonl$/.test(name))
    .sort()
    .filter((name) => {
      if (!from && !to) return true;
      const ym = name.slice(6, 12);
      const start = new Date(Number(ym.slice(0, 4)), Number(ym.slice(4, 6)) - 1, 1).getTime();
      const end = new Date(Number(ym.slice(0, 4)), Number(ym.slice(4, 6)), 1).getTime() - 1;
      if (to && end < from!) return false;
      if (from && start > to!) return false;
      return true;
    });
}

/** 只读查询审计事件（按时间倒序返回最近 limit 条）。 */
export function listAuditEvents(filter: AuditFilter = {}): AuditEvent[] {
  const from = filter.fromDay ? dayToTs(filter.fromDay, false) : undefined;
  const to = filter.toDay ? dayToTs(filter.toDay, true) : undefined;
  const limit = Math.max(1, Math.min(1000, Math.floor(Number(filter.limit)) || 100));
  const events: AuditEvent[] = [];
  for (const file of monthFilesInRange(from, to).reverse()) {
    try {
      const lines = readFileSync(resolve(AUDIT_DIR, file), "utf-8").split("\n");
      for (const line of lines.reverse()) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as AuditEvent;
          if (from && event.at < from) continue;
          if (to && event.at > to) continue;
          if (filter.decision && event.decision !== filter.decision) continue;
          if (filter.tool && event.tool !== filter.tool) continue;
          // 归属隔离：只返回本 owner 的事件与无主遗留事件（HTTP 侧最小权限；全局视角走 CLI）。
          if (filter.ownerKey && event.ownerKey && event.ownerKey !== filter.ownerKey) continue;
          events.push(event);
          if (events.length >= limit) return events;
        } catch {
          /* 单行损坏忽略 */
        }
      }
    } catch {
      /* 文件不可读忽略 */
    }
  }
  return events;
}
