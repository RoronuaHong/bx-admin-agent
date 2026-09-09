import type { TableView, ChatFileRef, ChartView } from "./types";
import type { PortalEntries, TraceAccessSource } from "./portal-permissions";

export interface LocalizedToken {
  code: string;
  params?: Record<string, string | number | boolean | null>;
  defaultMessage?: string;
}

export interface ApiErrorPayload {
  error: LocalizedToken;
}

export interface Country {
  id: string;
  label: string;
}

export interface Me {
  user: { loginName: string; name: string };
  country: Country;
  preferences: {
    replyLanguage: string | null;
  };
  permissions: {
    canViewTrace: boolean;
    traceAccessSource: TraceAccessSource;
    entries: PortalEntries;
  };
}

function normalizePortalEntries(
  entries: Partial<PortalEntries> | null | undefined,
  canViewTrace: boolean,
): PortalEntries {
  return {
    admin: entries?.admin ?? true,
    knowledge: entries?.knowledge ?? true,
    viewing: entries?.viewing ?? true,
    analytics: entries?.analytics ?? true,
    trace: entries?.trace ?? canViewTrace,
  };
}

function normalizeMe(data: unknown): Me {
  const raw = (data && typeof data === "object" ? data : {}) as Partial<Me>;
  const rawPermissions = (raw.permissions && typeof raw.permissions === "object"
    ? raw.permissions
    : {}) as Partial<Me["permissions"]>;
  const canViewTrace = Boolean(rawPermissions.canViewTrace);
  return {
    user: {
      loginName: String(raw.user?.loginName || ""),
      name: String(raw.user?.name || raw.user?.loginName || ""),
    },
    country: {
      id: String(raw.country?.id || ""),
      label: String(raw.country?.label || raw.country?.id || ""),
    },
    preferences: {
      replyLanguage: typeof raw.preferences?.replyLanguage === "string" ? raw.preferences.replyLanguage : null,
    },
    permissions: {
      canViewTrace,
      traceAccessSource: (rawPermissions.traceAccessSource || "default-login") as TraceAccessSource,
      entries: normalizePortalEntries(rawPermissions.entries, canViewTrace),
    },
  };
}

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "model"; id: string; label: string; reason?: "image" | "fallback" }
  | { type: "tool_call"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: string }
  | { type: "confirmation_required"; callId: string; name: string; input: Record<string, unknown>; description?: string; descriptionToken?: LocalizedToken; impact?: { highRisk: boolean; target: string; count: number } }
  | { type: "confirmation_response"; callId: string; confirmed: boolean }
  | { type: "table"; table: TableView }
  | { type: "file"; file: ChatFileRef }
  | { type: "chart"; chart: ChartView }
  | { type: "error"; error: LocalizedToken; message?: string; code?: string | number }
  | { type: "task_running"; taskId: string; startedAt: number; userText?: string; note?: string; noteToken?: LocalizedToken }
  | { type: "done" };

export class ApiError extends Error {
  status?: number;
  token?: LocalizedToken;
  code?: string;
  constructor(message: string, options?: { status?: number; token?: LocalizedToken; code?: string }) {
    super(message);
    this.name = "ApiError";
    this.status = options?.status;
    this.token = options?.token;
    this.code = options?.code || options?.token?.code;
  }
}

export function getApiErrorToken(error: unknown): LocalizedToken | undefined {
  return error instanceof ApiError ? error.token : undefined;
}

function normalizeToken(data: unknown, fallbackCode?: string): LocalizedToken | undefined {
  const raw = (data && typeof data === "object" ? data : {}) as Partial<LocalizedToken>;
  const code = typeof raw.code === "string" && raw.code.trim()
    ? raw.code.trim()
    : fallbackCode;
  if (!code) return undefined;
  return {
    code,
    params: raw.params && typeof raw.params === "object" ? raw.params as Record<string, string | number | boolean | null> : undefined,
    defaultMessage: typeof raw.defaultMessage === "string" ? raw.defaultMessage : undefined,
  };
}

async function parseJson(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const payload = data as Partial<ApiErrorPayload> & { message?: string; code?: string };
    const token = normalizeToken(payload.error, payload.code);
    const err = new ApiError(payload.message || token?.defaultMessage || `HTTP ${res.status}`, {
      status: res.status,
      token,
      code: payload.code,
    });
    throw err;
  }
  return data;
}

export async function fetchCountries(): Promise<Country[]> {
  const res = await fetch("/agent/auth/countries", { credentials: "include" });
  const data = (await parseJson(res)) as { countries: Country[] };
  return data.countries;
}

export async function login(payload: { country: string; username: string; password: string }) {
  const res = await fetch("/agent/auth/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return normalizeMe(await parseJson(res));
}

export async function logout() {
  await fetch("/agent/auth/logout", { method: "POST", credentials: "include" });
}

export async function fetchMe(): Promise<Me | null> {
  const res = await fetch("/agent/auth/me", { credentials: "include" });
  if (res.status === 401) return null;
  return normalizeMe(await parseJson(res));
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: "anthropic" | "openai" | "ollama";
  // 服务商来源（如 NVIDIA / Zen / TokenHub），由服务端按端点推导；缺失时回退 provider。
  source?: string;
  // 图片/视觉能力：direct 原生多模态 | ocr 需 OCR 转录 | none 纯文本。
  vision: "direct" | "ocr" | "none";
}

export interface UploadResult {
  id: string;
  name: string;
  size: number;
  kind: "image" | "text";
}

export async function confirmChat(callId: string, confirmed: boolean) {
  const res = await fetch("/agent/chat/confirm", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callId, confirmed }),
  });
  return parseJson(res) as Promise<{ ok: boolean }>;
}

export async function fetchModels(): Promise<ModelInfo[]> {
  const res = await fetch("/agent/models", { credentials: "include" });
  if (res.status === 401) return [];
  const data = (await parseJson(res)) as { models: ModelInfo[] };
  return data.models || [];
}

export interface TaskStatusDto {
  running: { taskId: string; startedAt: number; eventCount: number; userText: string } | null;
  last: { taskId: string; settled: boolean; startedAt: number; userText: string } | null;
}

export async function fetchTaskStatus(): Promise<TaskStatusDto> {
  return (await jsonFetch("/agent/chat/task/status")) as TaskStatusDto;
}

export async function streamChat(
  text: string,
  opts: { model?: string; images?: string[]; files?: string[]; uiLocale?: string },
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
) {
  const res = await fetch("/agent/chat/stream", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, ...opts }),
    signal,
  });
  if (res.status === 401) {
    throw new ApiError("Unauthorized", {
      status: 401,
      token: { code: "AUTH_SESSION_EXPIRED" },
      code: "AUTH_SESSION_EXPIRED",
    });
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    const payload = data as Partial<ApiErrorPayload> & { message?: string; code?: string };
    const token = normalizeToken(payload.error, payload.code || "CHAT_STREAM_FAILED");
    throw new ApiError(payload.message || token?.defaultMessage || "Request failed", {
      status: res.status,
      token,
      code: payload.code,
    });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";
      for (const chunk of chunks) {
        const line = chunk.split("\n").find((item) => item.startsWith("data: "));
        if (!line) continue;
        try {
          const ev = JSON.parse(line.slice(6)) as ChatEvent;
          onEvent(ev);
        } catch {
          // 单条事件数据非法时跳过，不中断整个流式响应
        }
      }
    }
  } catch (err) {
    // 流中断/底层读取异常：上抛给调用方（send）按 AbortError 统一标记取消状态。
    // 注意：仅在此处上抛，未捕获的 Promise 由下方 finally 的 reader.cancel 兜底消化。
    throw err;
  } finally {
    // 释放底层流：用户取消（abort）时，fetch 底层 reader 的 closed/cancel promise
    // 可能 reject 且无人 await，导致控制台出现 "AbortError: signal is aborted without reason"
    // 的未捕获 Promise。显式 cancel 并吞掉其 rejection，消除该噪声。
    reader.cancel().catch(() => {});
  }
}

export async function uploadFiles(files: File[]): Promise<UploadResult[]> {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  const res = await fetch("/agent/chat/upload", {
    method: "POST",
    credentials: "include",
    body: form,
  });
  const data = (await parseJson(res)) as { files: UploadResult[] };
  return data.files || [];
}

export async function clearChatContext() {
  const res = await fetch("/agent/chat/context/clear", {
    method: "POST",
    credentials: "include",
  });
  return parseJson(res);
}

// ---- 聊天记录持久化（方案 C：服务端 MongoDB，按登录用户归属）----
export interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  images?: { id: string; name: string }[];
  tables?: unknown[];
  charts?: unknown[];
  files?: unknown[];
  cancelled?: boolean;
  status?: string;
  error?: string;
  errorToken?: LocalizedToken;
  reasoning?: string;
  toolResults?: Array<{ name: string; result: string }>;
  toolStep?: number;
  currentTool?: string;
}

export interface ConversationDto {
  id: string;
  title: string;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
}

async function jsonFetch(path: string, options?: RequestInit) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  return parseJson(res);
}

export async function fetchConversations(): Promise<ConversationDto[]> {
  const data = (await jsonFetch("/agent/chat/conversations")) as { conversations: ConversationDto[] };
  return data.conversations || [];
}

export async function createConversation(payload: { id?: string; title?: string }) {
  const data = (await jsonFetch("/agent/chat/conversations", {
    method: "POST",
    body: JSON.stringify(payload),
  })) as { conversation: ConversationDto };
  return data.conversation;
}

export async function fetchConversation(id: string): Promise<ConversationDto | null> {
  try {
    const data = (await jsonFetch(`/agent/chat/conversations/${encodeURIComponent(id)}`)) as {
      conversation: ConversationDto;
    };
    return data.conversation;
  } catch (err) {
    if ((err as Error & { status?: number }).status === 404) return null;
    throw err;
  }
}

export async function saveConversationMessages(id: string, messages: StoredMessage[], title?: string) {
  return jsonFetch(`/agent/chat/conversations/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    body: JSON.stringify({ messages, title }),
  });
}

export async function renameConversation(id: string, title: string) {
  return jsonFetch(`/agent/chat/conversations/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ title }),
  });
}

export async function deleteConversation(id: string) {
  return jsonFetch(`/agent/chat/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function clearConversation(id: string) {
  return jsonFetch(`/agent/chat/conversations/${encodeURIComponent(id)}/clear`, { method: "POST" });
}

/** 下载/预览导出文件（带 cookie） */
export function downloadUrl(fileId: string, preview = false) {
  return `/agent/chat/download/${fileId}${preview ? "?preview=1" : ""}`;
}

// ---- P3 可观测：trace 只读视图 ----
export interface TraceRunSummary {
  runId: string;
  startedAt: string;
  durationMs?: number;
  model?: string;
  userText?: string;
  ownerKey?: string;
  release?: string;
  llmRounds: number;
  emptyRounds: number;
  emptyRetries: number;
  toolCalls: number;
  totalTokens: number;
  error?: string;
  errorToken?: LocalizedToken;
}

export interface TraceRunsStats {
  runs: number;
  llmCalls: number;
  tokens: number;
  avgRounds: number;
  emptyRounds: number;
  emptyRetries: number;
  emptyRoundRate: number;
  shortCircuitRuns: number;
  degradeHint: string | null;
  degradeHintToken?: LocalizedToken | null;
}

export interface TraceSpanDto {
  runId: string;
  spanId: string;
  parentSpanId?: string;
  kind: string;
  name: string;
  model?: string;
  worker?: string;
  status: string;
  durationMs: number;
  usage?: { totalTokens?: number; promptTokens?: number; completionTokens?: number };
  error?: string;
  errorToken?: LocalizedToken;
  note?: string;
  noteToken?: LocalizedToken;
  meta?: Record<string, unknown>;
}

export async function fetchTraceRuns(limit = 20): Promise<{ runs: TraceRunSummary[]; stats: TraceRunsStats }> {
  const data = (await jsonFetch(`/agent/trace/runs?limit=${Math.min(limit, 50)}`)) as {
    runs: TraceRunSummary[];
    stats: TraceRunsStats;
  };
  return { runs: data.runs || [], stats: data.stats };
}

export async function fetchTraceRun(runId: string): Promise<{ release?: string; spans: TraceSpanDto[] }> {
  const data = (await jsonFetch(`/agent/trace/run/${encodeURIComponent(runId)}`)) as {
    release?: string;
    spans: TraceSpanDto[];
  };
  return { release: data.release, spans: data.spans || [] };
}

// ---- Metabase 数据分析 Agent ----
export interface AnalyticsAskTable {
  title: string;
  cols: string[];
  rows: unknown[][];
  grain?: string;
}

export interface AnalyticsAskResult {
  status: "ok" | "clarify" | "refuse" | "error";
  message: string;
  timeEcho?: string;
  sqls?: string[];
  tables?: AnalyticsAskTable[];
  probeSummary?: string;
  error?: string;
}

export async function askAnalytics(text: string): Promise<AnalyticsAskResult> {
  const resp = await fetch("/agent/analytics/ask", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    const payload = data as Partial<ApiErrorPayload> & { message?: string; code?: string };
    const token = normalizeToken(payload.error, payload.code);
    throw new ApiError(payload.message || token?.defaultMessage || `analytics ask ${resp.status}`, {
      status: resp.status,
      token,
      code: payload.code,
    });
  }
  return resp.json() as Promise<AnalyticsAskResult>;
}
