// 安全审计留痕（append-only JSONL，写操作安全闸门 P0-7）。
// 记录「谁在什么时候批准/拒绝了哪个操作、参数摘要是什么」，事后可查。
// 写失败只 console，不阻断主流程（best-effort）；凭据不落盘：参数只存脱敏摘要 + sha256。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AuditDecision =
  | "allowed" // 只读外部工具直接放行（工作区工具不记，避免噪音）
  | "confirmed" // 用户批准
  | "denied" // 用户拒绝 / deny 口径拒绝
  | "timeout" // 确认等待超时（按拒绝）
  | "grant_read" // 会话级只读授权写入
  | "subagent_refused" // 子代理尝试非只读操作被立即拒绝
  | "clarify_deferred" // 待澄清期间被冻结暂缓的非只读调用（未执行、未产生副作用）
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
