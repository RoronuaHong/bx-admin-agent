import type { LocalizedToken, ApiErrorPayload, ChatEvent } from "@bx/shared";

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

/** 错误码读取的唯一入口：判定分支只比字符串，绝不拿 token 对象去比。
 *  `ApiError.code` 构造时已用 `token.code` 兜底（见 ApiError 构造），这里再兼容任意自带 `code` 的错误对象。 */
export function getApiErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.trim()) return code.trim();
  return getApiErrorToken(error)?.code;
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

/** 模型选择器的「自动」模式：运行时挑一个可用模型（哪个能用用哪个）。 */
export const MODEL_AUTO_ID = "auto";

export async function fetchModels(): Promise<ModelInfo[]> {
  const data = (await jsonFetch("/agent/models")) as { models: ModelInfo[] };
  return data.models || [];
}

// 注：观影助手原有的「个性化推荐面板」已整体移除（前端 UI + 这里的客户端 API 层）。
// 服务端的 `/agent/chat/movie/*` 端点与 movie 模块仍在（供 Agent 自身与工具使用）。
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
  opts: { conversationId?: string; model?: string; images?: string[]; agentId?: string },
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
  /**
   * 扩展思考（reasoning）文本：支持思考的模型才有，仅作展示、不回灌模型上下文。
   * 必须持久化，否则刷新后推理面板里的思考过程丢失。
   */
  thinking?: string;
  /** 工具调用步骤摘要（推理面板展示用）。 */
  steps?: unknown[];
  /** 任务规划（write_todos 产出，推理面板展示用）。 */
  todos?: unknown[];
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
  /** 该对话用户勾选的技能（skills 目录名）；空 = 全部走按需加载。 */
  skillsEnabled?: string[];
  locale?: string;
  pendingQueue?: PendingMessage[];
  /** 置顶时间戳；null / 缺省 = 未置顶。置顶项固定排在列表最上（新的置顶在上）。 */
  pinnedAt?: number | null;
  /** 手动顺序（「手动排序」模式下生效）；未排过的项没有该字段。 */
  sortOrder?: number;
  /** 归档标记；归档对话默认不在列表显示，需显式 includeArchived。 */
  archived?: boolean;
  /** 免打扰：静默该对话的后台完成提醒（不弹提示，不影响消息落库与状态点）。 */
  muted?: boolean;
}

export async function fetchConversations(includeArchived = false, agentId?: string): Promise<ConversationDto[]> {
  const params = new URLSearchParams();
  if (includeArchived) params.set("includeArchived", "1");
  if (agentId) params.set("agentId", agentId);
  const qs = params.toString() ? `?${params.toString()}` : "";
  const data = (await jsonFetch(`/agent/chat/conversations${qs}`)) as { conversations: ConversationDto[] };
  return data.conversations || [];
}

export async function createConversation(payload: { id?: string; title?: string; agentId?: string }) {
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

/** 复制对话（Duplicate）：返回新对话 DTO。 */
export async function duplicateConversation(id: string): Promise<ConversationDto> {
  const data = (await jsonFetch(`/agent/chat/conversations/${encodeURIComponent(id)}/duplicate`, {
    method: "POST",
  })) as { conversation: ConversationDto };
  return data.conversation;
}

/** 导出对话下载链接（MD / JSON）；直接用浏览器下载。 */
export function conversationExportUrl(id: string, format: "md" | "json"): string {
  return `/agent/chat/conversations/${encodeURIComponent(id)}/export.${format}`;
}

/** 独立取消某一个运行中的子代理（不影响主代理）。 */
export async function cancelSubagent(conversationId: string, subagentId: string) {
  return jsonFetch(`/agent/chat/subagent/${encodeURIComponent(conversationId)}/${encodeURIComponent(subagentId)}/cancel`, {
    method: "POST",
  });
}

export async function deleteConversation(id: string) {
  return jsonFetch(`/agent/chat/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function clearConversation(id: string) {
  return jsonFetch(`/agent/chat/conversations/${encodeURIComponent(id)}/clear`, { method: "POST" });
}

/** 更新对话级设置（只传要改的字段；服务端未提供的字段保持不变）。 */
export async function patchConversation(
  id: string,
  patch: {
    title?: string;
    model?: string;
    mcpServers?: string[];
    skillsEnabled?: string[];
    locale?: string;
    pendingQueue?: PendingMessage[];
    pinnedAt?: number | null;
    /** 归档开关：true = 收进归档区（侧栏默认不显示，需打开「显示归档」）。 */
    archived?: boolean;
    /** 免打扰：静默该对话的「后台任务完成」提醒。 */
    muted?: boolean;
  },
): Promise<ConversationDto> {
  const data = (await jsonFetch(`/agent/chat/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })) as { conversation: ConversationDto };
  return data.conversation;
}

/** 批量写入手动顺序：`ids` 的下标即新顺序（一次提交，服务端按下标写 `sortOrder`）。 */
export async function reorderConversations(ids: string[]) {
  return jsonFetch("/agent/chat/conversations/reorder", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

// ---- 设备级偏好（原前端 localStorage：主题 / 默认语言 / 上次打开的对话 / 会话排序模式）----

/** 会话列表排序模式：recent = 普通区按最近活动；manual = 按用户手动顺序。 */
export type ConvSortMode = "recent" | "manual";

export interface ChatPreferences {
  activeConversationId: string;
  theme: "" | "light" | "dark";
  locale: string;
  convSortMode: ConvSortMode;
  /** 侧栏「显示归档」开关（归档对话默认收起，打开后拉进列表）。 */
  showArchived: boolean;
  /** 非 0 = 客户端已完成过偏好同步（据此跳过旧 localStorage 的一次性迁移）。 */
  migratedAt: number;
}

function toPreferences(data: Partial<ChatPreferences>): ChatPreferences {
  return {
    activeConversationId: data.activeConversationId || "",
    theme: data.theme || "",
    locale: data.locale || "",
    convSortMode: data.convSortMode === "manual" ? "manual" : "recent",
    showArchived: data.showArchived === true,
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
  convSortMode?: ConvSortMode;
  showArchived?: boolean;
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
  /** 新建对话/任务默认勾选（服务端配置 defaultEnabled）。 */
  defaultEnabled?: boolean;
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

// ---- 技能（Skills）：对话级勾选，与 MCP 启用集同构 ----
export interface SkillMeta {
  /** 展示名（SKILL.md frontmatter name，缺省为目录名）。 */
  name: string;
  description: string;
  /** skills 目录名（勾选集存的值 / read_skill 的入参）。 */
  dir: string;
}

export async function fetchChatSkills(
  conversationId?: string,
): Promise<{ available: SkillMeta[]; enabled: string[] }> {
  const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
  const data = (await jsonFetch(`/agent/chat/skills${query}`)) as {
    available: SkillMeta[];
    enabled: string[];
  };
  return { available: data.available || [], enabled: data.enabled || [] };
}

export async function setChatSkills(
  enabled: string[],
  conversationId?: string,
): Promise<{ available: SkillMeta[]; enabled: string[] }> {
  const data = (await jsonFetch("/agent/chat/skills", {
    method: "PUT",
    body: JSON.stringify({ enabled, ...(conversationId ? { conversationId } : {}) }),
  })) as { available: SkillMeta[]; enabled: string[] };
  return { available: data.available || [], enabled: data.enabled || [] };
}

/** 应答确认：必须携带服务端签发的一次性票据；grantRead=true 时附带会话级只读授权。 */
export async function confirmToolCall(ticket: string, confirmed: boolean, opts: { grantRead?: boolean } = {}) {
  return jsonFetch("/agent/chat/confirm", {
    method: "POST",
    body: JSON.stringify({ ticket, confirmed, ...(opts.grantRead ? { grantRead: true } : {}) }),
  });
}

/** 显式取消某对话的后台任务（执行与推送解耦后，「停止」不再等于断开连接）。 */
export async function cancelChatTask(conversationId: string): Promise<{ ok: boolean; running: boolean }> {
  return jsonFetch("/agent/chat/cancel", {
    method: "POST",
    body: JSON.stringify({ conversationId }),
  });
}

export interface ChatTaskStatus {
  conversationId: string;
  running: boolean;
  task?: { id: string; startedAt: number; elapsedMs: number; live: boolean };
  last?: { id: string; status: string; startedAt: number; settledAt: number; durationMs: number; outcomePersisted: boolean };
}

/** 查询某对话的任务状态（断线后判断「后台还在跑吗」）。 */
export async function fetchChatTaskStatus(conversationId: string): Promise<ChatTaskStatus> {
  return jsonFetch(`/agent/chat/task/status?conversationId=${encodeURIComponent(conversationId)}`);
}

/** 便捷判定：该对话是否还有后台任务在跑（网络错误时按 false 处理）。 */
export async function isChatTaskRunning(conversationId: string): Promise<boolean> {
  try {
    return (await fetchChatTaskStatus(conversationId)).running;
  } catch {
    return false;
  }
}

// ---- 长期记忆（按 owner 隔离）----

export interface MemoryItemDto {
  id: string;
  text: string;
  createdAt: number;
}

export async function fetchMemory(): Promise<MemoryItemDto[]> {
  const data = (await jsonFetch("/agent/chat/memory")) as { memory: MemoryItemDto[] };
  return data.memory || [];
}

export async function addMemoryItem(text: string): Promise<MemoryItemDto | null> {
  const data = (await jsonFetch("/agent/chat/memory", {
    method: "POST",
    body: JSON.stringify({ text }),
  })) as { memory: MemoryItemDto | null };
  return data.memory;
}

export async function removeMemoryItem(id: string): Promise<boolean> {
  const data = (await jsonFetch(`/agent/chat/memory/${encodeURIComponent(id)}`, { method: "DELETE" })) as { ok: boolean };
  return Boolean(data.ok);
}

// ---- 对话工作区（虚拟文件系统，只读 UI）----

export interface WorkspaceFile {
  path: string;
  bytes: number;
}

export async function fetchWorkspaceFiles(conversationId: string): Promise<WorkspaceFile[]> {
  const data = (await jsonFetch(
    `/agent/chat/conversations/${encodeURIComponent(conversationId)}/files`,
  )) as { files: WorkspaceFile[] };
  return data.files || [];
}

export async function readWorkspaceFile(conversationId: string, path: string): Promise<string> {
  const data = (await jsonFetch(
    `/agent/chat/conversations/${encodeURIComponent(conversationId)}/files/content?path=${encodeURIComponent(path)}`,
  )) as { content: string };
  return data.content || "";
}
