export interface LocalizedToken {
  code: string;
  params?: Record<string, string | number | boolean | null>;
  defaultMessage?: string;
}

export interface ApiErrorPayload {
  error: LocalizedToken;
}

/** 任务规划条目（与后端 @bx/shared 对齐）。 */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "model"; id: string; label: string }
  | { type: "tool_call"; id: string; name: string; server?: string; args?: string }
  | { type: "tool_result"; id: string; name: string; ok: boolean; text: string }
  | { type: "confirmation_required"; id: string; name: string; args?: string; reason?: string }
  | { type: "confirmation_response"; id: string; confirmed: boolean }
  | { type: "todos"; todos: TodoItem[] }
  | { type: "error"; error: LocalizedToken; message?: string; code?: string | number }
  | {
      /** 本轮上下文用量（透明度）：跨轮 token 占用、预算、丢弃条数与被清理的工具结果数。 */
      type: "usage";
      tokens: number;
      budget: number;
      window: number;
      turns: number;
      dropped: number;
      summarized?: boolean;
      toolResultsCleared: number;
      toolResultsOffloaded?: number;
    }
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
  const code = typeof raw.code === "string" && raw.code.trim() ? raw.code.trim() : fallbackCode;
  if (!code) return undefined;
  return {
    code,
    params: raw.params && typeof raw.params === "object" ? (raw.params as Record<string, string | number | boolean | null>) : undefined,
    defaultMessage: typeof raw.defaultMessage === "string" ? raw.defaultMessage : undefined,
  };
}

async function parseJson(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const payload = data as Partial<ApiErrorPayload> & { message?: string; code?: string };
    const token = normalizeToken(payload.error, payload.code);
    throw new ApiError(payload.message || token?.defaultMessage || `HTTP ${res.status}`, {
      status: res.status,
      token,
      code: payload.code,
    });
  }
  return data;
}

async function jsonFetch(path: string, options?: RequestInit) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  return parseJson(res);
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: "anthropic" | "openai" | "ollama";
  source?: string;
  vision: "direct" | "ocr" | "none";
}

export async function fetchModels(): Promise<ModelInfo[]> {
  const data = (await jsonFetch("/agent/models")) as { models: ModelInfo[] };
  return data.models || [];
}

export interface UploadResult {
  id: string;
  name: string;
  size: number;
}

export async function uploadFiles(files: File[]): Promise<UploadResult[]> {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  const res = await fetch("/agent/chat/upload", { method: "POST", credentials: "include", body: form });
  const data = (await parseJson(res)) as { files: UploadResult[] };
  return data.files || [];
}

/** 一轮对话（HTTP Streamable，NDJSON 分块）：每个事件一行 JSON，text_delta 流式增量，text 为最终全文，done 结束。 */
export async function streamChat(
  text: string,
  opts: { conversationId?: string; model?: string; images?: string[] },
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
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as Partial<ApiErrorPayload> & { message?: string; code?: string };
    const token = normalizeToken(data.error, data.code || "CHAT_STREAM_FAILED");
    throw new ApiError(data.message || token?.defaultMessage || "Request failed", {
      status: res.status,
      token,
      code: data.code,
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
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          onEvent(JSON.parse(line) as ChatEvent);
        } catch {
          // 单条事件非法时跳过，不中断流
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** 清空指定对话的服务端模型上下文（不影响 UI 消息快照）。 */
export async function clearConversationContext(id: string) {
  return jsonFetch(`/agent/chat/conversations/${encodeURIComponent(id)}/context/clear`, { method: "POST" });
}

// ---- 会话持久化（服务端存储）----
export interface StoredMessage {
  id?: string | number;
  role: "user" | "assistant";
  text: string;
  images?: { id: string; name: string }[];
}

/** 排队中的待发消息（后端持久化，`conversation.pendingQueue`）。 */
export interface PendingMessage {
  text: string;
  images?: string[];
  at: number;
}

export interface ConversationDto {
  id: string;
  title: string;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
  /** 服务端是否正在为该对话生成（进程内存态）→ 侧栏状态点。 */
  running?: boolean;
  // ---- 对话级设置（每个对话独立；空 = 用服务端/设备默认）----
  model?: string;
  mcpServers?: string[];
  locale?: string;
  pendingQueue?: PendingMessage[];
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

export async function saveConversationMessages(id: string, messages: StoredMessage[], title?: string) {
  return jsonFetch(`/agent/chat/conversations/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    body: JSON.stringify({ messages, title }),
  });
}

export async function deleteConversation(id: string) {
  return jsonFetch(`/agent/chat/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function clearConversation(id: string) {
  return jsonFetch(`/agent/chat/conversations/${encodeURIComponent(id)}/clear`, { method: "POST" });
}

/** 取单个对话全量文档（含 context；切换对话时载入用）。 */
/** 更新对话级设置（只传要改的字段；服务端未提供的字段保持不变）。 */
export async function patchConversation(
  id: string,
  patch: { title?: string; model?: string; mcpServers?: string[]; locale?: string; pendingQueue?: PendingMessage[] },
): Promise<ConversationDto> {
  const data = (await jsonFetch(`/agent/chat/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })) as { conversation: ConversationDto };
  return data.conversation;
}

// ---- 设备级偏好（原前端 localStorage：主题 / 默认语言 / 上次打开的对话）----

export interface ChatPreferences {
  activeConversationId: string;
  theme: "" | "light" | "dark";
  locale: string;
  /** 非 0 = 客户端已完成过偏好同步（据此跳过旧 localStorage 的一次性迁移）。 */
  migratedAt: number;
}

function toPreferences(data: Partial<ChatPreferences>): ChatPreferences {
  return {
    activeConversationId: data.activeConversationId || "",
    theme: data.theme || "",
    locale: data.locale || "",
    migratedAt: data.migratedAt || 0,
  };
}

export async function fetchChatPreferences(): Promise<ChatPreferences> {
  return toPreferences((await jsonFetch("/agent/chat/preferences")) as Partial<ChatPreferences>);
}

export async function saveChatPreferences(patch: {
  activeConversationId?: string;
  theme?: "light" | "dark";
  locale?: string;
}): Promise<ChatPreferences> {
  const data = (await jsonFetch("/agent/chat/preferences", {
    method: "PUT",
    body: JSON.stringify(patch),
  })) as Partial<ChatPreferences>;
  return toPreferences(data);
}

// ---- MCP 服务器（全局配置 + 会话启用集）----
export interface McpServerPublic {
  id: string;
  label: string;
  transport: "stdio" | "http";
  enabled: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  timeoutMs?: number;
  requireConfirm?: boolean;
  envKeys: string[];
  headerKeys: string[];
}

export interface McpServerStatus {
  id: string;
  label: string;
  transport: string;
  enabled: boolean;
  connected: boolean;
  /** 连接过程进行中（尚未列完工具）。 */
  connecting?: boolean;
  error?: string;
  /** 连接正常但工具清单（listTools）获取失败的原因。 */
  toolsError?: string;
  tools: number;
  toolNames: string[];
}

export interface McpServerInput extends Partial<Omit<McpServerPublic, "envKeys" | "headerKeys">> {
  id: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

// 以下三个是「服务器增删改」的 API 层：当前前端只有启用/禁用（按对话持久化），
// 暂无管理面板 UI；保留给后续管理界面或直接 curl 服务端端点使用。
export async function fetchMcpServers(): Promise<McpServerPublic[]> {
  const data = (await jsonFetch("/agent/mcp/servers")) as { servers: McpServerPublic[] };
  return data.servers || [];
}

export async function saveMcpServer(payload: McpServerInput): Promise<McpServerPublic> {
  const data = (await jsonFetch("/agent/mcp/servers", {
    method: "POST",
    body: JSON.stringify(payload),
  })) as { server: McpServerPublic };
  return data.server;
}

export async function deleteMcpServer(id: string) {
  return jsonFetch(`/agent/mcp/servers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function reloadMcpServer(id: string): Promise<McpServerStatus> {
  const data = (await jsonFetch(`/agent/mcp/servers/${encodeURIComponent(id)}/reload`, {
    method: "POST",
  })) as { status: McpServerStatus };
  return data.status;
}

export async function fetchChatMcpServers(
  conversationId?: string,
): Promise<{ available: McpServerStatus[]; enabled: string[] }> {
  const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
  const data = (await jsonFetch(`/agent/chat/mcp/servers${query}`)) as {
    available: McpServerStatus[];
    enabled: string[];
  };
  return { available: data.available || [], enabled: data.enabled || [] };
}

export async function setChatMcpServers(
  enabled: string[],
  conversationId?: string,
): Promise<{ available: McpServerStatus[]; enabled: string[] }> {
  const data = (await jsonFetch("/agent/chat/mcp/servers", {
    method: "PUT",
    body: JSON.stringify({ enabled, ...(conversationId ? { conversationId } : {}) }),
  })) as { available: McpServerStatus[]; enabled: string[] };
  return { available: data.available || [], enabled: data.enabled || [] };
}

export async function confirmToolCall(callId: string, confirmed: boolean) {
  return jsonFetch("/agent/chat/confirm", {
    method: "POST",
    body: JSON.stringify({ callId, confirmed }),
  });
}
