// 工具调用二次确认：chatStream 推 confirmation_required 后在此挂起，
// 等前端 POST /chat/confirm 应答（或超时按拒绝处理），再继续工具循环。
export interface ConfirmOutcome {
  confirmed: boolean;
  timedOut: boolean;
}

interface Waiter {
  resolve: (outcome: ConfirmOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

const waiters = new Map<string, Waiter>();
const DEFAULT_TIMEOUT_MS = Number(process.env.MCP_CONFIRM_TIMEOUT_MS || 120_000);

export function waitForConfirmation(callId: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<ConfirmOutcome> {
  return new Promise<ConfirmOutcome>((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(callId);
      resolve({ confirmed: false, timedOut: true });
    }, timeoutMs);
    waiters.set(callId, { resolve, timer });
  });
}

/** 前端应答；返回 false 表示没有等待中的确认（重复应答或已超时）。 */
export function answerConfirmation(callId: string, confirmed: boolean): boolean {
  const waiter = waiters.get(callId);
  if (!waiter) return false;
  waiters.delete(callId);
  clearTimeout(waiter.timer);
  waiter.resolve({ confirmed, timedOut: false });
  return true;
}
