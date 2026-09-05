/**
 * 安全审计日志（P1）—— 越权拒绝 / 写操作确认事件的独立落库。
 *
 * 与 traces 的关系：trace 面向「一次请求的完整调用栈」（可轮转、面向调试），
 * 审计面向「安全事件」的 append-only 留痕（合规诉求，不允许随 trace 清理丢失）。
 * 两者通过 runId 关联：审计事件带 runId，需要完整上下文时回 trace 反查。
 *
 * 设计原则：
 * - 零业务词：事件类型为通用安全语义——reject / confirm_request / confirm_result /
 *   prompt_guard（结构清洗/定界碰撞观察，不拒请求；reject 含 worker 越权与 rate_limit）；
 *   tool/worker/method/path 等字段是运行时数据，不是代码写死。
 * - 零新依赖：Node 标准库；JSONL 按月分文件（audit-YYYYMM.jsonl），append-only。
 * - 主流程零感知：auditEvent 写失败仅 console，不中断业务路径。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AuditEventKind = "reject" | "confirm_request" | "confirm_result" | "prompt_guard";
export type ConfirmOutcome = "granted" | "denied" | "timeout";

export interface AuditEvent {
  at: number;
  atIso: string;
  kind: AuditEventKind;
  sessionId: string;
  runId?: string;
  /** 操作者（countryId:loginName），来自登录态 */
  ownerKey?: string;
  /** 触发事件的工具（英文契约名，运行时值） */
  tool?: string;
  /** 事件发生时的 Worker 上下文（越权拒绝时必带） */
  worker?: string;
  /** 写确认的请求 id */
  callId?: string;
  /** confirm_result 的结论 */
  result?: ConfirmOutcome;
  method?: string;
  path?: string;
  detail?: string;
}

function auditDir(): string {
  return join(process.cwd(), ".data", "audit");
}

/** 审计落盘目录（供运维脚本/检查复用）。 */
export function getAuditDir(): string {
  return auditDir();
}

/**
 * 追加一条审计事件（同步、append-only，按月分文件）。
 * 写失败只打日志不抛错：审计不能阻断业务主流程。
 */
export function auditEvent(e: Omit<AuditEvent, "at" | "atIso">): void {
  try {
    const dir = auditDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const d = new Date();
    const month = d.toISOString().slice(0, 7).replace("-", "");
    const ev: AuditEvent = { at: d.getTime(), atIso: d.toISOString(), ...e };
    appendFileSync(join(dir, `audit-${month}.jsonl`), JSON.stringify(ev) + "\n", "utf8");
  } catch (err) {
    console.error("[audit] 写入失败（不中断主流程）:", err instanceof Error ? err.message : err);
  }
}

/**
 * 查询审计事件（at 倒序）。
 * @param opts.fromDay / toDay  ISO 日期过滤（含边界，按 atIso 前 10 位比较）
 * @param opts.kind             事件类型过滤
 * @param opts.ownerKey         只看某操作者（HTTP 端点按登录态强制传入）
 * @param opts.limit            返回条数上限（默认 200）
 */
export function listAuditEvents(opts?: {
  fromDay?: string;
  toDay?: string;
  kind?: AuditEventKind;
  ownerKey?: string;
  limit?: number;
}): AuditEvent[] {
  const dir = auditDir();
  if (!existsSync(dir)) return [];
  const out: AuditEvent[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.startsWith("audit-") || !f.endsWith(".jsonl")) continue;
    try {
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as AuditEvent;
          const day = ev.atIso.slice(0, 10);
          if (opts?.fromDay && day < opts.fromDay) continue;
          if (opts?.toDay && day > opts.toDay) continue;
          if (opts?.kind && ev.kind !== opts.kind) continue;
          if (opts?.ownerKey && ev.ownerKey !== opts.ownerKey) continue;
          out.push(ev);
        } catch {
          // 单行损坏跳过，不中断整体
        }
      }
    } catch {
      // 单文件损坏跳过
    }
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, Math.max(1, opts?.limit ?? 200));
}
