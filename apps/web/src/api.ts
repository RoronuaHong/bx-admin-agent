import type { TableView, ChatFileRef, ChartView } from "./types";

export interface Country {
  id: string;
  label: string;
}

export interface Me {
  user: { loginName: string; name: string };
  country: Country;
}

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "model"; id: string; label: string; reason?: "image" | "fallback" }
  | { type: "tool_call"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: string }
  | { type: "confirmation_required"; callId: string; name: string; input: Record<string, unknown>; description: string; impact?: { highRisk: boolean; target: string; count: number } }
  | { type: "table"; table: TableView }
  | { type: "file"; file: ChatFileRef }
  | { type: "chart"; chart: ChartView }
  | { type: "error"; message: string; code?: string | number }
  | { type: "done" };

async function parseJson(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data as { message?: string }).message || `HTTP ${res.status}`);
    (err as Error & { status?: number }).status = res.status;
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
  return parseJson(res) as Promise<Me>;
}

export async function logout() {
  await fetch("/agent/auth/logout", { method: "POST", credentials: "include" });
}

export async function fetchMe(): Promise<Me | null> {
  const res = await fetch("/agent/auth/me", { credentials: "include" });
  if (res.status === 401) return null;
  return (await parseJson(res)) as Me;
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

export async function streamChat(
  text: string,
  opts: { model?: string; images?: string[]; files?: string[] },
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
  console.log("[API_DIAG] fetch returned ok=", res.ok, "hasBody=", !!res.body, "status=", res.status);
  if (res.status === 401) throw Object.assign(new Error("会话失效，请重新登录"), { status: 401 });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { message?: string }).message || "请求失败");
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
          console.log("[API_DIAG] onEvent type=", ev.type);
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
  note?: string;
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
