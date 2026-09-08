export interface ToolResultI18nToken {
  code: string;
  params?: Record<string, unknown>;
}

export interface ToolResultEnvelope {
  ok: boolean;
  _i18n?: ToolResultI18nToken;
  [key: string]: unknown;
}

export function okTokenResult(code: string, params?: Record<string, unknown>, extra?: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, _i18n: { code, params }, ...(extra || {}) }, null, 2);
}

export function errorTokenResult(code: string, params?: Record<string, unknown>, extra?: Record<string, unknown>): string {
  return JSON.stringify({ ok: false, _i18n: { code, params }, ...(extra || {}) }, null, 2);
}

export function parseToolResultEnvelope(raw: string): ToolResultEnvelope | null {
  const text = String(raw || "").trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text) as ToolResultEnvelope;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.ok !== "boolean") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isToolErrorResult(raw: string): boolean {
  const text = String(raw || "").trimStart();
  if (text.startsWith("错误：")) return true;
  return parseToolResultEnvelope(text)?.ok === false;
}
