/**
 * Analytics 输入护栏：控制符剥离、长度/成本上限、轻量 PII 脱敏、不可信定界。
 * 不做问句语义改写——只加安全层，原文槽位仍从脱敏后文本抽取。
 */

import {
  sanitizeUserInput,
  stripDangerousControls,
  wrapUntrustedUserContent,
  UNTRUSTED_USER_CONTENT_RULE,
  type WrapUserResult,
} from "../prompt-guard.js";

export const ANALYTICS_MAX_NL_CHARS = 4000;
export const ANALYTICS_MAX_TRANSCRIPT_CHARS = 12000;

export type AskRuntimeContext = {
  clockIsoDate: string;
  timezone: string;
  ownerKey?: string;
  userId?: string;
  uiLocale?: string;
  /** 代码侧时间解析结果摘要（注入事实，非改写用户句） */
  timeResolveNote: string;
  timeResolved?: { start: string; end: string; echo: string };
};

export type GuardedInput = {
  /** 进 LLM / 抽槽用（已控符+长度+PII） */
  text: string;
  truncated: boolean;
  strippedCount: number;
  piiRedactions: number;
  refused?: string;
};

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /(?<!\d)(?:\+?\d{1,3}[- ]?)?(?:\d{3,4}[- ]?){2}\d{4}(?!\d)/g;
const CN_ID_RE = /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g;

/** 轻量 PII 脱敏：邮箱 / 电话 / 身份证 → 占位符 */
export function redactPii(raw: string): { text: string; redactions: number } {
  let redactions = 0;
  let text = raw || "";
  text = text.replace(EMAIL_RE, () => {
    redactions += 1;
    return "[REDACTED_EMAIL]";
  });
  text = text.replace(CN_ID_RE, () => {
    redactions += 1;
    return "[REDACTED_ID]";
  });
  text = text.replace(PHONE_RE, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) return m;
    redactions += 1;
    return "[REDACTED_PHONE]";
  });
  return { text, redactions };
}

/**
 * 护栏入口：控符 → 长度 → PII。拒绝空串或明显超长轰炸。
 */
export function guardAnalyticsInput(raw: string, maxLen = ANALYTICS_MAX_NL_CHARS): GuardedInput {
  const sanitized = sanitizeUserInput(raw || "", maxLen);
  if (!sanitized.text.trim()) {
    return {
      text: "",
      truncated: sanitized.truncated,
      strippedCount: sanitized.strippedCount,
      piiRedactions: 0,
      refused: "输入为空或仅含不可见字符",
    };
  }
  const pii = redactPii(sanitized.text);
  return {
    text: pii.text,
    truncated: sanitized.truncated,
    strippedCount: sanitized.strippedCount,
    piiRedactions: pii.redactions,
  };
}

export function guardTranscriptLines(
  lines: string[],
  maxTotal = ANALYTICS_MAX_TRANSCRIPT_CHARS,
): { lines: string[]; truncated: boolean } {
  const out: string[] = [];
  let used = 0;
  let truncated = false;
  for (const line of lines) {
    const g = guardAnalyticsInput(line, Math.min(ANALYTICS_MAX_NL_CHARS, maxTotal - used));
    if (g.refused) continue;
    if (used + g.text.length > maxTotal) {
      truncated = true;
      break;
    }
    out.push(g.text);
    used += g.text.length + 1;
    if (g.truncated) truncated = true;
  }
  return { lines: out, truncated };
}

/** 拼进 system 的确定性事实块（补全上下文，不清洗用户句） */
export function buildAskFactsBlock(ctx: AskRuntimeContext): string {
  const lines = [
    "Deterministic runtime facts (trust these; do not guess):",
    `- today_date: ${ctx.clockIsoDate}`,
    `- timezone: ${ctx.timezone}`,
    ctx.ownerKey ? `- owner_key: ${ctx.ownerKey}` : null,
    ctx.userId ? `- user_id: ${ctx.userId}` : null,
    ctx.uiLocale ? `- ui_locale: ${ctx.uiLocale}` : null,
    `- time_resolve: ${ctx.timeResolveNote}`,
    ctx.timeResolved
      ? `- resolved_time_range: ${ctx.timeResolved.start} .. ${ctx.timeResolved.end} (${ctx.timeResolved.echo})`
      : `- resolved_time_range: (none — clarify time_range if still missing)`,
    "If resolved_time_range is set, you MUST use those exact start/end in JSON time.",
  ];
  return lines.filter(Boolean).join("\n");
}

export function wrapAnalyticsUserPayload(raw: string): WrapUserResult {
  const stripped = stripDangerousControls(raw || "");
  return wrapUntrustedUserContent(stripped.text);
}

export { UNTRUSTED_USER_CONTENT_RULE };
