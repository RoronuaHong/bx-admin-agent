/**
 * Analytics LLM call hygiene: timeout + never leak gateway JSON to the UI.
 */

import { mergeTimeoutSignal } from "./metabase-client.js";

export function analyticsLlmTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ANALYTICS_LLM_TIMEOUT_MS || 15000);
  return Number.isFinite(n) && n >= 3000 ? Math.floor(n) : 15000;
}

export function beginAnalyticsLlmSignal(
  signal?: AbortSignal,
  timeoutMs?: number,
): ReturnType<typeof mergeTimeoutSignal> {
  return mergeTimeoutSignal(signal, timeoutMs ?? analyticsLlmTimeoutMs());
}

export function sanitizeAnalyticsLlmError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err || "");
  if (/401008|quota|exhausted|额度|后付费|postpaid/i.test(msg)) {
    return "当前模型额度已耗尽，请在左上角换一个模型后重试。";
  }
  if (/llm_timeout|aborted|timeout|TimeoutError/i.test(msg)) {
    return "模型响应超时，请换一个模型或稍后重试。";
  }
  if (/"error"|gateway_error|401008/.test(msg) || msg.trim().startsWith("{")) {
    return "模型服务暂时不可用，请换一个模型或稍后重试。";
  }
  return "模型调用失败，请稍后重试。";
}
