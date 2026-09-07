import type { ToolCall } from "./models.js";

export const SUBMIT_UNDERSTOOD_INTENT = "submit_understood_intent";

export type OperationType = "read" | "write" | "unknown";
export type ResponseMode = "execute" | "clarify" | "explain-capability";

/** 大模型对用户输入的结构化理解（不含业务规则判定） */
export interface UnderstoodIntent {
  isBusinessRequest: boolean;
  project?: string;
  module?: string;
  value?: string;
  operationType: OperationType;
  /** 回答模式：执行取数/写操作；先反问补对象；或仅说明系统能力/操作步骤。 */
  responseMode?: ResponseMode;
  /** 模型对本次理解的把握度（0~1）；不确定时给较低值。 */
  confidence?: number;
  /** 当前仍缺哪些槽位；建议用结构化英文键，如 module / operation / value / parentId / parentName。 */
  missingSlots?: string[];
  /** 模型选定的完整接口 id（module.func，如 <模块>.<接口> / <模块>.<接口>），
   *  由模型按 api-interface-routing skill 读模块接口源码精确给出；未给时服务端才按命名惯例兜底。 */
  operation?: string;
  operationHint?: string;
  summary?: string;
}

function asOp(raw: unknown): OperationType {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "read" || s === "write") return s;
  return "unknown";
}

function asResponseMode(raw: unknown): ResponseMode | undefined {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "execute" || s === "clarify" || s === "explain-capability") return s;
  return undefined;
}

function asConfidence(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : Number(String(raw || "").trim());
  if (!Number.isFinite(n)) return undefined;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function asMissingSlots(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const vals = raw
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .filter((x, i, arr) => arr.indexOf(x) === i);
  return vals.length ? vals : undefined;
}

export function parseUnderstoodIntent(input: Record<string, unknown>): UnderstoodIntent {
  const businessRaw = input.isBusinessRequest;
  const isBusinessRequest =
    businessRaw === true ||
    businessRaw === "true" ||
    String(businessRaw || "").toLowerCase() === "yes";

  // operation 字段：模型按 api-interface-routing skill 选定的完整接口 id（module.func）。
  // 与 operationType（read/write/unknown）区分开：operation 是具体接口，operationType 是读/写意图。
  // 注意：模型偶尔把 operation 误填成 read/write 意图词（旧 schema 习惯），此时视为未给完整接口。
  const opRaw = String(input.operation ?? "").trim();
  const operation =
    opRaw && !/^(read|write|unknown|capabilities)$/i.test(opRaw) && opRaw.includes(".") ? opRaw : undefined;

  return {
    isBusinessRequest,
    project: String(input.project || "").trim() || undefined,
    module: String(input.module || "").trim() || undefined,
    value: String(input.value || "").trim() || undefined,
    operationType: asOp(input.operationType),
    responseMode: asResponseMode(input.responseMode),
    confidence: asConfidence(input.confidence),
    missingSlots: asMissingSlots(input.missingSlots),
    operation,
    operationHint: String(input.operationHint || "").trim() || undefined,
    summary: String(input.summary || "").trim() || undefined,
  };
}

export function parseUnderstoodFromText(text: string): UnderstoodIntent | null {
  const raw = (text || "").trim();
  if (!raw) return null;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fence ? fence[1].trim() : raw;
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(jsonText.slice(start, end + 1)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    return parseUnderstoodIntent(parsed);
  } catch {
    return null;
  }
}

export function extractUnderstoodIntent(toolCalls: ToolCall[], text: string): UnderstoodIntent | null {
  const call = toolCalls.find((c) => c.name === SUBMIT_UNDERSTOOD_INTENT);
  if (call) return parseUnderstoodIntent(call.input || {});
  return parseUnderstoodFromText(text);
}
