// 工具调用二次确认（写操作安全闸门 P0-4）：
// 服务端签发一次性、不可猜的确认票据（cfm_<uuid>），与 (sessionId, conversationId) 绑定。
// chatStream 推 confirmation_required（带 ticket）后在此挂起，前端 POST /chat/confirm 必须携带
// ticket 且与当前请求会话匹配才能应答（跨会话 / 伪造票据一律拒绝）；超时按拒绝处理（fail-closed）。
import { randomUUID } from "node:crypto";

export interface ConfirmOutcome {
  confirmed: boolean;
  timedOut: boolean;
}

export interface ConfirmationRequest {
  /** 发起请求的会话 id：应答时必须匹配，防止跨会话批准别人的待确认写操作。 */
  sessionId: string;
  conversationId: string;
  /** 工具调用 id（UI 关联步骤用，不再用于批准）。 */
  callId: string;
  /** 工具名（审计与展示用）。 */
  tool: string;
  /** 所属 MCP 服务器 id（只读授权写入目标）。 */
  serverId?: string;
}

interface TicketRecord extends ConfirmationRequest {
  ticket: string;
  createdAt: number;
  resolve: (outcome: ConfirmOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

const tickets = new Map<string, TicketRecord>();
const DEFAULT_TIMEOUT_MS = Number(process.env.MCP_CONFIRM_TIMEOUT_MS || 120_000);

/** 登记等待器并签发票据；调用方把 ticket 放进 confirmation_required 事件。 */
export function requestConfirmation(input: ConfirmationRequest): {
  ticket: string;
  timeoutMs: number;
  wait: Promise<ConfirmOutcome>;
} {
  const ticket = `cfm_${randomUUID()}`;
  const wait = new Promise<ConfirmOutcome>((resolve) => {
    const timer = setTimeout(() => {
      tickets.delete(ticket);
      resolve({ confirmed: false, timedOut: true });
    }, DEFAULT_TIMEOUT_MS);
    tickets.set(ticket, { ...input, ticket, createdAt: Date.now(), resolve, timer });
  });
  return { ticket, timeoutMs: DEFAULT_TIMEOUT_MS, wait };
}

/**
 * 前端应答：必须同时匹配 ticket 与当前请求会话，否则拒绝。
 * 票据一次性：应答即删（无论成败）；超时已删（fail-closed）。
 */
export function answerConfirmation(
  ticket: string,
  sessionId: string,
  confirmed: boolean,
): { ok: boolean; reason?: string; conversationId?: string; serverId?: string } {
  const record = tickets.get(ticket);
  if (!record) return { ok: false, reason: "确认票据不存在或已失效" };
  tickets.delete(ticket);
  clearTimeout(record.timer);
  if (record.sessionId !== sessionId) {
    // 不匹配也要等票据已删：旧会话的回答作废，等待方超时后按拒绝处理。
    return { ok: false, reason: "该确认不属于当前会话" };
  }
  record.resolve({ confirmed, timedOut: false });
  return { ok: true, conversationId: record.conversationId, serverId: record.serverId };
}

