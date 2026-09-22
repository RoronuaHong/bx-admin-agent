import type { LocalizedToken, ApiErrorPayload, ChatEvent, ChartSpec } from "@bx/shared";

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

/** 从当前页面 URL 取 IM 通知链接带过来的 ownerKey，透传给 API 首包。
 *  钉钉/飞书 webview 不共享浏览器 cookie，靠它完成一次性设备归属回写。
 */
function withOwnerParam(path: string): string {
  try {
    const owner = new URLSearchParams(window.location.search).get("owner");
    if (!owner) return path;
    const sep = path.includes("?") ? "&" : "?";
    return `${path}${sep}owner=${encodeURIComponent(owner)}`;
  } catch {
    return path;
  }
}

async function jsonFetch(path: string, options?: RequestInit) {
  const res = await fetch(withOwnerParam(path), {
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
  const res = await fetch(withOwnerParam("/agent/chat/upload"), { method: "POST", credentials: "include", body: form });
  const data = (await parseJson(res)) as { files: UploadResult[] };
  return data.files || [];
}

/** NDJSON 逐行消费（每个事件一行 JSON；非法行跳过，不打断流）。 */
async function readNdjson(body: ReadableStream<Uint8Array>, onEvent: (event: ChatEvent) => void): Promise<void> {
  const reader = body.getReader();
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

/**
 * 一轮对话（HTTP Streamable，NDJSON 分块）：每个事件一行 JSON，text_delta 流式增量，text 为最终全文，done 结束。
 * 任务 id 在响应头 `X-Chat-Task-Id` 里：续传时带回去，服务端据此确认「接的还是同一轮」。
 * `onStart` 在**拿到响应头时立刻回调**——流中途断开时函数会抛错，但这一轮的任务 id 已经交出去了，
 * 调用方仍能按它续传（放在返回值里就太晚了）。
 */
export async function streamChat(
  text: string,
  opts: { conversationId?: string; model?: string; images?: string[]; attachments?: string[]; agentId?: string },
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
  onStart?: (info: { taskId?: string }) => void,
): Promise<{ taskId?: string }> {
  const res = await fetch(withOwnerParam("/agent/chat/stream"), {
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
  const taskId = res.headers.get("X-Chat-Task-Id") || undefined;
  onStart?.(taskId ? { taskId } : {});
  await readNdjson(res.body, onEvent);
  return taskId ? { taskId } : {};
}

/**
 * 断线续传：带上次消费到的 `seq` 重新挂上后台任务的事件流（对齐 SSE 的 `Last-Event-ID` 重连语义）。
 * 返回 true = 已接上（终态会在事件流里给出；正文由服务端补一条 `text` 快照，前端替换即可，
 * 不会把已显示的内容拼两遍）；返回 false = 服务端已没有可续传的任务（进程重启后连留档也没有、
 * 收束后留档已过期、或 `taskId` 不匹配——游标属于更早的一轮），调用方应如实收口而不是假装还在跑。
 */
export async function resumeChatTaskEvents(
  conversationId: string,
  cursor: { from: number; taskId?: string },
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const from = Math.max(0, Math.floor(cursor.from) || 0);
  const taskParam = cursor.taskId ? `&taskId=${encodeURIComponent(cursor.taskId)}` : "";
  const res = await fetch(
    withOwnerParam(`/agent/chat/task/events?conversationId=${encodeURIComponent(conversationId)}&from=${from}${taskParam}`),
    {
      credentials: "include",
      // 与 ?from= 同值：既保留 SSE 习惯（服务端也认这个头），也让中间层日志一眼看出在续传。
      headers: { "Last-Event-ID": String(from) },
      signal,
    },
  );
  if (!res.ok || !res.body) return false;
  await readNdjson(res.body, onEvent);
  return true;
}

/** 清空指定对话的服务端模型上下文（不影响 UI 消息快照）。 */
export async function clearConversationContext(id: string) {
  return jsonFetch(`/agent/chat/conversations/${encodeURIComponent(id)}/context/clear`, { method: "POST" });
}

/** 本地渲染图表的 spec（render_chart 产出；前端 ChartCard 按它绘制）。
 *  形状定义在 @bx/shared（与 chat 事件、服务端落库快照共用一份），这里只做转出。 */
export type { ChartSpec };

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
  /** 累计思考耗时（毫秒）：推理面板标题展示用（对齐 ChatGPT「Thought for Ns」）。 */
  thinkMs?: number;
  /** 工具调用步骤摘要（推理面板展示用）。 */
  steps?: unknown[];
  /** 任务规划（write_todos 产出，推理面板展示用）。 */
  todos?: unknown[];
  /**
   * 本地渲染图表（render_chart 产出的 spec）：图的渲染产物只存在内存里，
   * 必须随快照落库，否则刷新/重进对话后图表卡片消失（与 thinking/steps 同理）。
   * 一轮可出多张（如「两张图对比」），故为数组——单字段会让后一张覆盖前一张。
   */
  charts?: ChartSpec[];
  /** @deprecated 旧的单张结构（历史快照）：读取时并入 charts；写入一律用 charts。 */
  chart?: ChartSpec;
}

/** 排队中的待发消息（后端持久化，`conversation.pendingQueue`）。 */
export interface PendingMessage {
  text: string;
  images?: string[];
  docs?: string[];
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

/**
 * 应答确认 / 澄清：必须携带服务端签发的一次性票据；grantRead=true 时附带会话级只读授权。
 * 澄清（request_clarification）用同一通道回传用户选中的选项值 `value`。
 */
export async function confirmToolCall(
  ticket: string,
  confirmed: boolean,
  opts: { grantRead?: boolean; value?: string } = {},
) {
  return jsonFetch("/agent/chat/confirm", {
    method: "POST",
    body: JSON.stringify({
      ticket,
      confirmed,
      ...(opts.grantRead ? { grantRead: true } : {}),
      ...(opts.value ? { value: opts.value } : {}),
    }),
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
  /** `lastEventSeq` = 服务端事件序号上界（与本地游标比对可判断落后多少；排障用）。 */
  task?: { id: string; startedAt: number; elapsedMs: number; live: boolean; lastEventSeq?: number };
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

// ---- 定时任务（服务端持久化；到点执行，结果回投对话，可选推送到 IM 机器人）----

export type ScheduleStatus = "success" | "failed" | "cancelled" | "skipped" | "error";
/** 触发投递的状态白名单（跳过/取消一律不推）。 */
export type ScheduleNotifyOn = "success" | "failed";

export interface ScheduleDto {
  id: string;
  conversationId: string;
  /** 结果回投的对话是本任务专属（服务端创建，每个任务一个）；旧数据可能缺省。 */
  ownConversation?: boolean;
  name?: string;
  prompt: string;
  /** 周期任务：5 段 cron（分 时 日 月 周）。与 onceAt 二选一。 */
  cron?: string;
  /** 一次性任务：目标时刻（毫秒）。跑完自动停用。 */
  onceAt?: number;
  /** 任务级外部工具允许清单（MCP 服务器 id）：与对话启用集取交集，只收窄不放开。 */
  mcpServers?: string[];
  /** 结果投递通道（全局通道注册表 id）。 */
  notifyChannelIds?: string[];
  notifyOn?: ScheduleNotifyOn[];
  locale?: string;
  lastDelivery?: { at: number; ok: boolean; sent: number; error?: string };
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastStatus?: ScheduleStatus;
  lastNote?: string;
  nextRunAt?: number;
}

export interface ScheduleInput {
  /** 建任务时所在的对话（可选）：只用来沿用它的 Agent 角色；结果回投的对话由服务端另建。 */
  conversationId?: string;
  /** Agent 角色（/support 等非 generic 入口建任务时带上，专属对话按角色分槽）。 */
  agentId?: string;
  prompt: string;
  name?: string;
  cron?: string;
  onceAt?: number;
  mcpServers?: string[];
  notifyChannelIds?: string[];
  notifyOn?: ScheduleNotifyOn[];
  locale?: string;
}

export async function fetchSchedules(conversationId?: string): Promise<ScheduleDto[]> {
  const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
  const data = (await jsonFetch(`/agent/chat/schedules${query}`)) as { schedules: ScheduleDto[] };
  return data.schedules || [];
}

/** 新建定时任务：服务端同时创建任务专属对话（结果只回到那里），一并返回给前端接进侧栏。 */
export async function createChatSchedule(
  payload: ScheduleInput,
): Promise<{ schedule: ScheduleDto; conversation?: ConversationDto }> {
  const data = (await jsonFetch("/agent/chat/schedules", {
    method: "POST",
    body: JSON.stringify(payload),
  })) as { schedule: ScheduleDto; conversation?: ConversationDto };
  return data;
}

export async function patchChatSchedule(
  id: string,
  patch: Partial<Omit<ScheduleInput, "conversationId">> & { enabled?: boolean },
): Promise<ScheduleDto> {
  const data = (await jsonFetch(`/agent/chat/schedules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })) as { schedule: ScheduleDto };
  return data.schedule;
}

export async function deleteChatSchedule(id: string): Promise<void> {
  await jsonFetch(`/agent/chat/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---- 结果投递通道（钉钉 / 飞书自定义机器人；凭据只写不回显）----

export type NotifyChannelKind = "dingtalk" | "feishu";

export interface NotifyChannelDto {
  id: string;
  kind: NotifyChannelKind;
  label: string;
  /** 只回域名：凭据（webhook 含 token）留在服务端。 */
  host: string;
  hasSecret: boolean;
  keyword?: string;
  /** 通道级启用开关（缺省 true）。关闭后所有引用它的任务都跳过投递。 */
  enabled?: boolean;
  createdAt: number;
}

export interface NotifyChannelInput {
  id?: string;
  kind: NotifyChannelKind;
  label?: string;
  /** 新建时必填；更新时留空 = 保持原值（前端拿不到脱敏后的原文）。 */
  webhook?: string;
  secret?: string;
  keyword?: string;
  /** 通道级启用开关（仅 upsert 透传：保存时带 id + enabled 即切换）。 */
  enabled?: boolean;
}

export async function fetchNotifyChannels(): Promise<NotifyChannelDto[]> {
  const data = (await jsonFetch("/agent/notify/channels")) as { channels: NotifyChannelDto[] };
  return data.channels || [];
}

export async function saveNotifyChannel(payload: NotifyChannelInput): Promise<NotifyChannelDto> {
  const data = (await jsonFetch("/agent/notify/channels", {
    method: "POST",
    body: JSON.stringify(payload),
  })) as { channel: NotifyChannelDto };
  return data.channel;
}

export async function deleteNotifyChannel(id: string): Promise<void> {
  await jsonFetch(`/agent/notify/channels/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** 测试发送：平台拒收（关键词/签名错）返回 ok:false + 原因，不算 HTTP 错误。 */
export async function testNotifyChannel(id: string): Promise<{ ok: boolean; error?: string }> {
  const data = (await jsonFetch(`/agent/notify/channels/${encodeURIComponent(id)}/test`, {
    method: "POST",
  })) as { ok: boolean; error?: string };
  return { ok: Boolean(data.ok), ...(data.error ? { error: data.error } : {}) };
}
