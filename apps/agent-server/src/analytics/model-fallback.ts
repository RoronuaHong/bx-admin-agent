/**
 * 候选模型链：首选不可用（额度/限流/下线/网络）时自动换下一个候选，
 * 避免整条分析链路因为一个模型 402/429 就静默降级。
 *
 * 纯编排逻辑（attempt 注入），不绑定具体传输实现，便于单测。
 */

import { analyticsModelCooldownMs, markAnalyticsModelUnavailable } from "./pick-analytics-model.js";

/** 单次调用最多尝试几个候选（ANALYTICS_MODEL_FALLBACKS，默认 6，上限 10） */
export function modelFallbackAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ANALYTICS_MODEL_FALLBACKS || 6);
  if (!Number.isFinite(n) || n < 1) return 6;
  return Math.min(Math.floor(n), 10);
}

/**
 * 上限类错误不再换模型：调用方取消、以及超时（换模型只会把等待时间翻倍）。
 * 其余错误一律允许换下一个候选重试一次。
 */
export function isFatalModelError(e: unknown): boolean {
  if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) return true;
  const msg = e instanceof Error ? e.message : String(e || "");
  return /abort|llm_timeout|timeout/i.test(msg);
}

/** 从错误上取 HTTP 状态（传输层已挂上时优先用它判断） */
export function modelErrorStatus(e: unknown): number | undefined {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** 「模型不可用」类信号：这类失败才值得冷却该模型（普通请求错误不剔除模型） */
export function isModelUnavailableError(e: unknown): boolean {
  const status = modelErrorStatus(e);
  if (status !== undefined) {
    return status === 402 || status === 408 || status === 410 || status === 429 || status >= 500;
  }
  const msg = e instanceof Error ? e.message : String(e || "");
  return /401008|quota|exhaust|rate.?limit|too many requests|not supported|missingsessionid|missing session|can only be used in|unavailable|overloaded|worker local total|gateway_error|gone/i.test(
    msg,
  );
}

/** 传输层失败登记：只有「模型不可用」类错误才把该模型放进冷却队列 */
export function reportModelFailure(modelId: string, e: unknown): void {
  if (!modelId) return;
  if (isModelUnavailableError(e)) markAnalyticsModelUnavailable(modelId);
}

/**
 * 质量失败登记：模型 HTTP 200 但给不出可用输出（如 structure 严格 JSON 解析失败）。
 * 短冷却（≤60s）：让同请求内的下一次尝试自动换候选，又不至于把偶发抖动的模型踢太久。
 */
export function reportModelQualityFailure(modelId: string, now = Date.now()): void {
  if (!modelId) return;
  const ttl = Math.min(analyticsModelCooldownMs(), 60000);
  if (ttl <= 0) return;
  markAnalyticsModelUnavailable(modelId, now, ttl);
}

export type ModelAttempt<TModel, TResult> = (model: TModel, attempt: number) => Promise<TResult>;

/**
 * 按候选顺序尝试，直到拿到结果；非致命错误自动换下一个候选。
 * 全部失败时抛出**最后一个**错误（调用方据此决定降级文案）。
 */
export async function withModelFallback<TModel extends { id: string }, TResult>(input: {
  candidates: TModel[];
  maxAttempts: number;
  attempt: ModelAttempt<TModel, TResult>;
  isFatal?: (e: unknown) => boolean;
  onUnavailable?: (model: TModel, e: unknown, next?: TModel) => void;
}): Promise<TResult> {
  const attempts =
    input.maxAttempts > 0 ? input.candidates.slice(0, input.maxAttempts) : [...input.candidates];
  const isFatal = input.isFatal || (() => false);
  let lastError: unknown = null;
  for (let i = 0; i < attempts.length; i++) {
    const model = attempts[i]!;
    try {
      return await input.attempt(model, i);
    } catch (e) {
      if (isFatal(e)) throw e;
      lastError = e;
      const next = attempts[i + 1];
      input.onUnavailable?.(model, e, next);
      if (!next) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "no_model"));
}
