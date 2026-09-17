<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import ModelSelect from "../components/ModelSelect.vue";
import ThemeToggle from "../components/ThemeToggle.vue";
import UiLocaleSelect from "../components/UiLocaleSelect.vue";
import { renderChatMarkdown } from "../chat-richtext";
import { getUiLocale, detectDefaultLocale, isUiLocale, setUiLocale, type UiLocale } from "../ui-locale";
import { localizeToken } from "../localize";
import { readStoredTheme, useTheme } from "../theme";
import {
  clearConversation,
  clearConversationContext,
  confirmToolCall,
  createConversation,
  deleteConversation as apiDeleteConversation,
  fetchChatMcpServers,
  fetchChatPreferences,
  fetchConversations,
  fetchModels,
  getApiErrorToken,
  patchConversation,
  reloadMcpServer,
  saveChatPreferences,
  saveConversationMessages,
  setChatMcpServers,
  streamChat,
  uploadFiles,
  type ChatPreferences,
  type ConversationDto,
  type McpServerStatus,
  type ModelInfo,
  type PendingMessage,
  type StoredMessage,
  type UploadResult,
} from "../api";
import type { TodoItem } from "@bx/shared";

/** 气泡里的一个工具步骤（MCP 工具调用）。 */
interface ToolStep {
  id: string;
  name: string;
  server?: string;
  args?: string;
  status: "running" | "ok" | "error" | "cancelled";
  result?: string;
}

interface Bubble {
  id: number;
  role: "user" | "assistant";
  text: string;
  images?: Array<{ id: string; name: string }>;
  streaming?: boolean;
  error?: string;
  steps?: ToolStep[];
  /** 等待用户确认的工具调用（服务器级 requireConfirm 或该工具声明为破坏性操作）。 */
  pending?: { id: string; name: string; args?: string; reason?: string } | null;
  /** 本轮上下文用量（服务端回传，用于透明度展示）。 */
  usage?: {
    tokens: number;
    budget: number;
    window: number;
    turns: number;
    dropped: number;
    summarized?: boolean;
    toolResultsCleared: number;
    toolResultsOffloaded?: number;
  };
  /** 任务规划（write_todos 产出，随执行推进状态）。 */
  todos?: TodoItem[];
}

/**
 * 旧的**前端**持久化键：只用于一次性迁移读取（迁移成功后删除，此后前端零持久化）。
 * 主题键的读写封装在 `theme.ts`（`readStoredTheme`）。
 */
const LOCAL_KEYS = {
  lastConversation: "bx-chat-last-conversation",
  locale: "bx-admin-agent-ui-locale-v1",
} as const;

const { adopt: adoptTheme } = useTheme();

const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

/** 对话级设置（真相在 conversation 文档；前端只做镜像 + 乐观更新）。 */
interface ConvSettings {
  /** 空 = 用服务端默认模型。 */
  modelId: string;
  /** 空 = 用设备默认语言（`session.preferences.locale`）。 */
  locale: "" | UiLocale;
  mcpEnabled: string[];
}

/**
 * 每个对话独立的运行时状态。
 * 对齐 AI SDK 的「每个会话一个显式实例」：状态与中断句柄都归实例所有，
 * 因此切换对话只改指针、不打断任何流，N 个对话可同时流式。
 */
interface ConvState {
  bubbles: Bubble[];
  input: string;
  sending: boolean;
  /** 该对话自己的中断句柄；「停止」只作用于它，不是全局中断。 */
  controller: AbortController | null;
  pendingImages: UploadResult[];
  /** 服务端实际使用的模型名（可能因回退/降级与所选不同）。 */
  activeModelLabel: string;
  /** 该对话最近一次错误（侧栏状态点用）。 */
  error: string;
  /** 对话级设置（模型 / 语言 / MCP 启用集）。 */
  settings: ConvSettings;
  /** 待发队列（后端持久化：忙时入队，turn 收束后按序自动发）。 */
  queue: PendingMessage[];
}

function blankState(): ConvState {
  return {
    bubbles: [],
    input: "",
    sending: false,
    controller: null,
    pendingImages: [],
    activeModelLabel: "",
    error: "",
    settings: { modelId: "", locale: "", mcpEnabled: [] },
    queue: [],
  };
}

const threadEl = ref<HTMLElement | null>(null);
const models = ref<ModelInfo[]>([]);
const conversations = ref<ConversationDto[]>([]);
const currentId = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
/** 输入框元素引用：用于按内容自动撑高（交互优化）。 */
const inputEl = ref<HTMLTextAreaElement | null>(null);

/** 输入框随内容自动长高，超过上限回到滚动（交互优化）。 */
function autoGrow() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

watch(() => current.value.input, () => autoGrow());
/** 设备默认语言（来自 `GET /chat/preferences`；对话未显式设置 locale 时兜底）。 */
const deviceLocale = ref<UiLocale>(detectDefaultLocale());
/** 设置类操作的失败提示（乐观更新回滚后告诉用户，避免"点了没反应"）。 */
const settingsError = ref("");

/** 尚未选中任何对话时的占位态，避免模板到处判空。 */
const blank = reactive(blankState());
/** 对话 id → 运行时状态。切换对话**不清理**它，后台流继续写自己的 bubbles。 */
const states = reactive(new Map<string, ConvState>());

/** 取（必要时创建）某对话的状态容器。只在动作里调用，不在 computed 里创建，避免自依赖。 */
function stateOf(id: string): ConvState {
  if (!id) return blank;
  let state = states.get(id);
  if (!state) {
    state = reactive(blankState());
    states.set(id, state);
  }
  return state;
}

/** 当前对话的状态；纯查找，不产生副作用。 */
const current = computed<ConvState>(() => (currentId.value ? states.get(currentId.value) : undefined) ?? blank);

/** 当前对话的模型选择；空 = 服务端默认，UI 兜底展示列表首个（与旧行为一致）。 */
const modelId = computed({
  get: () => current.value.settings.modelId || models.value[0]?.id || "",
  set: (value: string) => {
    void saveModelChoice(value);
  },
});

let settingsErrorTimer: ReturnType<typeof setTimeout> | null = null;
/** 乐观更新失败后的提示；4s 自动消失，不打扰。 */
function showSettingsError(message: string) {
  settingsError.value = message;
  if (settingsErrorTimer) clearTimeout(settingsErrorTimer);
  settingsErrorTimer = setTimeout(() => {
    settingsError.value = "";
  }, 4000);
}

/** 把改动同步回本地列表条目，避免下次切回时被过期 DTO 覆盖（服务端仍是唯一真相）。 */
function syncConvLocal(convId: string, patch: Partial<ConversationDto>) {
  conversations.value = conversations.value.map((c) => (c.id === convId ? { ...c, ...patch } : c));
}

/** 应用某对话的语言（未显式设置时用设备默认）。tx() / localizeToken 都读这个内存态。 */
function applyConversationLocale(locale: string | undefined) {
  setUiLocale(isUiLocale(locale) ? locale : deviceLocale.value);
}

/**
 * 模型切换：乐观更新 → PATCH 落库 → 失败回滚（对齐 TanStack 的 onMutate/onError/onSettled 三段式）。
 * 尚未创建对话时（首屏）只改内存，创建对话后随设置一起落库。
 */
async function saveModelChoice(value: string) {
  const convId = currentId.value;
  const state = current.value;
  const prev = state.settings.modelId;
  if (prev === value) return;
  state.settings.modelId = value;
  state.activeModelLabel = models.value.find((m) => m.id === value)?.label || "";
  if (!convId) return;
  try {
    await patchConversation(convId, { model: value });
    syncConvLocal(convId, { model: value });
  } catch (err) {
    state.settings.modelId = prev;
    state.activeModelLabel = models.value.find((m) => m.id === prev)?.label || "";
    showSettingsError(
      localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("模型保存失败", "Failed to save model")),
    );
  }
}

/** 语言切换：组件已先改内存（立即生效），这里负责落当前对话 + 失败回滚。 */
async function onLocaleChange(locale: UiLocale) {
  const convId = currentId.value;
  const state = current.value;
  const prev = state.settings.locale;
  state.settings.locale = locale;
  if (!convId) return;
  try {
    await patchConversation(convId, { locale });
    syncConvLocal(convId, { locale });
  } catch (err) {
    state.settings.locale = prev;
    applyConversationLocale(prev);
    showSettingsError(
      localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("语言保存失败", "Failed to save language")),
    );
  }
}

/** 当前模型是否支持直读图片（由服务端 /models 的 vision 字段给出）。 */
const modelSupportsImages = computed(
  () => models.value.find((m) => m.id === modelId.value)?.vision === "direct",
);
/** 已选图片但当前模型不支持：明确提示，避免"传了但模型看不到"的静默失效。 */
const imagesUnsupported = computed(
  () => current.value.pendingImages.length > 0 && !modelSupportsImages.value,
);

// ---- MCP 连接面板（选择即可：服务器由部署侧提供，面板只做启用/停用）----
const mcpOpen = ref(false);
const mcpAvailable = ref<McpServerStatus[]>([]);
const mcpBusy = ref(false);
const mcpExpanded = ref("");
const mcpError = ref("");
const mcpRoot = ref<HTMLElement | null>(null);

let seq = 0;
let scrollQueued = false;

const canSend = computed(
  () => Boolean(current.value.input.trim() || current.value.pendingImages.length) && !current.value.sending,
);

/** 当前选中的模型名（用于判断服务端实际使用的模型是否与选择一致）。 */
const selectedModelLabel = computed(() => models.value.find((m) => m.id === modelId.value)?.label || "");

/** 气泡更新时是否要跟随滚动：只有"正在看的这个对话"才滚，后台流不抢滚动条。 */
function queueScrollIfCurrent(convId: string) {
  if (currentId.value === convId) queueScroll();
}

function queueScroll() {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    void nextTick(() => {
      const el = threadEl.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  });
}

// ---- 推理过程（任务计划 + 工具步骤）折叠：生成中默认展开，收束后自动折叠，避免长过程刷屏 ----
const openReasoning = reactive(new Set<number>());

function toggleReasoning(id: number) {
  if (openReasoning.has(id)) openReasoning.delete(id);
  else openReasoning.add(id);
}

function hasRunningStep(b: Bubble): boolean {
  return !!b.steps?.some((s) => s.status === "running");
}

function reasoningTitle(b: Bubble): string {
  const n = b.steps?.length || 0;
  if (b.streaming && hasRunningStep(b)) return tx("推理中…", "Reasoning…");
  if (n) return tx(`推理过程 · ${n} 步`, `Reasoning · ${n} step${n > 1 ? "s" : ""}`);
  if (b.todos?.length) return tx("任务计划", "Plan");
  return tx("推理过程", "Reasoning");
}

function toStored(list: Bubble[]): StoredMessage[] {
  return list
    .filter((b) => b.text || b.images?.length)
    .map((b) => ({ role: b.role, text: b.text, images: b.images }));
}

/**
 * 落库某个对话的气泡快照。
 * 必须显式传对话 id 与气泡：本轮结束时可能已经切到别的对话（后台流），
 * 用 currentId 会把 A 的内容写进 B。
 */
async function persist(convId: string, list: Bubble[]) {
  if (!convId) return;
  const title = list.find((b) => b.role === "user" && b.text)?.text.slice(0, 24) || undefined;
  try {
    await saveConversationMessages(convId, toStored(list), title);
    if (title) {
      conversations.value = conversations.value.map((c) => (c.id === convId ? { ...c, title } : c));
    }
  } catch {
    /* 保存失败不打断对话 */
  }
}

/** 切换对话：只改指针，不 abort、不覆盖任何已存在的运行时状态（后台流继续跑）。 */
function selectConversation(conv: ConversationDto) {
  const state = stateOf(conv.id);
  currentId.value = conv.id;
  reportActiveConversation(conv.id);
  // 仅首次载入时用服务端快照建气泡；已有气泡说明本地状态更新（可能正在流式），不能覆盖。
  if (!state.bubbles.length) {
    state.bubbles = (conv.messages || []).map((m) => ({
      id: ++seq,
      role: m.role,
      text: m.text || "",
      images: m.images,
    }));
  }
  // 设置按对话灌入（列表条目在每次写成功后都会同步，故不会用过期值覆盖）。
  state.settings.modelId = conv.model || "";
  state.settings.mcpEnabled = conv.mcpServers || [];
  state.settings.locale = isUiLocale(conv.locale) ? conv.locale : "";
  state.queue = conv.pendingQueue || [];
  applyConversationLocale(state.settings.locale);
  // 面板的可用服务器列表是全局的；启用集来自该对话。
  void loadMcp(conv.id);
  queueScroll();
}

async function newConversation() {
  const conv = await createConversation({ title: tx("新对话", "New chat") });
  conversations.value = [conv, ...conversations.value.filter((c) => c.id !== conv.id)];
  // 新对话默认不带模型 / MCP（干净起点），但**继承当前界面语言**：
  // 语言是 UI 偏好，不该每开一个对话都重设；写成对话自己的 locale 后仍与其它对话互不影响。
  const locale = uiLocale.value;
  stateOf(conv.id).settings.locale = locale;
  selectConversation(conv);
  void patchConversation(conv.id, { locale }).then(
    () => syncConvLocal(conv.id, { locale }),
    () => undefined,
  );
}

async function removeConversation(id: string) {
  // 只中断这个对话自己的流，其它对话不受影响。
  states.get(id)?.controller?.abort();
  states.delete(id);
  conversations.value = conversations.value.filter((c) => c.id !== id);
  try {
    await apiDeleteConversation(id);
  } catch {
    /* ignore */
  }
  if (currentId.value === id) {
    const next = conversations.value[0];
    if (next) selectConversation(next);
    else await newConversation();
  }
}

async function clearCurrent() {
  const state = current.value;
  if (state.sending) return;
  state.bubbles = [];
  state.error = "";
  // 同时清掉服务端上下文，否则旧历史仍会被带进下一轮模型请求。
  // 必须带上对话 id：不带 id 的旧端点按“服务端活跃对话”清，切换过对话时会清错对象。
  await Promise.all([
    currentId.value ? clearConversation(currentId.value).catch(() => undefined) : Promise.resolve(),
    currentId.value ? clearConversationContext(currentId.value).catch(() => undefined) : Promise.resolve(),
  ]);
}

/** 侧栏状态点：待确认 > 出错 > 生成中（服务端 running 或本地发送中）。 */
function convStatus(conv: ConversationDto): "" | "running" | "pending" | "error" {
  const state = states.get(conv.id);
  if (state?.bubbles.some((b) => b.pending)) return "pending";
  if (state?.error) return "error";
  if (state?.sending || conv.running) return "running";
  return "";
}

function convStatusText(status: ReturnType<typeof convStatus>): string {
  if (status === "running") return tx("生成中", "Generating");
  if (status === "pending") return tx("待确认", "Waiting for approval");
  if (status === "error") return tx("出错了", "Error");
  return "";
}

async function pickFiles(event: Event) {
  const el = event.target as HTMLInputElement;
  const files = Array.from(el.files || []);
  el.value = "";
  if (!files.length) return;
  const state = current.value;
  try {
    const saved = await uploadFiles(files);
    state.pendingImages.push(...saved);
  } catch (err) {
    state.bubbles.push({
      id: ++seq,
      role: "assistant",
      text: localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("上传失败", "Upload failed")),
    });
  }
}

/** 移除一张待发图片（模板里不能用 `current.pendingImages = ...` 直接赋值，故提供方法）。 */
function removePendingImage(id: string) {
  const state = current.value;
  state.pendingImages = state.pendingImages.filter((i) => i.id !== id);
}

/** 队列容量上限：超过拒绝入队，避免无限堆积。 */
const MAX_QUEUE = 20;

/** 忙时入队（排队语义）：先本地、后落库，失败回滚并提示。 */
async function enqueueMessage(convId: string, text: string, imageIds: string[]) {
  const state = stateOf(convId);
  if (state.queue.length >= MAX_QUEUE) {
    showSettingsError(tx("排队消息已达上限，请先处理队列", "The queue is full; handle it first"));
    return;
  }
  const item: PendingMessage = { text, ...(imageIds.length ? { images: imageIds } : {}), at: Date.now() };
  const prev = state.queue;
  state.queue = [...prev, item];
  try {
    await patchConversation(convId, { pendingQueue: state.queue });
    syncConvLocal(convId, { pendingQueue: state.queue });
  } catch (err) {
    state.queue = prev;
    showSettingsError(
      localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("排队失败", "Failed to queue message")),
    );
  }
}

/** 队列变更（上移/下移/删除/编辑）统一走这里：乐观 + 失败回滚。 */
async function setQueue(convId: string, next: PendingMessage[]) {
  const state = states.get(convId);
  if (!state) return;
  const prev = state.queue;
  state.queue = next;
  try {
    await patchConversation(convId, { pendingQueue: next });
    syncConvLocal(convId, { pendingQueue: next });
  } catch (err) {
    state.queue = prev;
    showSettingsError(
      localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("队列保存失败", "Failed to save queue")),
    );
  }
}

/**
 * turn 收束后的出队：只有**成功**收束才继续。
 * 出错 / 被停止 / 还有待确认 → 停下等用户（决议 §11.2：不要在出错时自动刷下一句）。
 */
async function drainQueue(convId: string, ok: boolean) {
  const state = states.get(convId);
  if (!state || !ok || state.sending || !state.queue.length) return;
  const [next, ...rest] = state.queue;
  state.queue = rest;
  try {
    await patchConversation(convId, { pendingQueue: rest });
    syncConvLocal(convId, { pendingQueue: rest });
  } catch {
    /* 落库失败不阻塞发送，下次同步会纠正 */
  }
  await runTurn(convId, next.text, next.images || []);
}

async function send() {
  const state = current.value;
  const convId = currentId.value;
  if (!convId) return;
  const text = state.input.trim();
  if (!text && !state.pendingImages.length) return;
  if (state.sending) {
    // 排队语义：同一对话在生成时，新消息进待发队列（服务端 409 是并发标签页的兜底）。
    await enqueueMessage(convId, text, state.pendingImages.map((i) => i.id));
    state.input = "";
    state.pendingImages = [];
    return;
  }
  const images = state.pendingImages.slice();
  // 发送后清空输入框与待发图片（仅在这条「用户主动发送」路径清；出队/立即发送走各自入参，不碰当前输入）。
  state.input = "";
  state.pendingImages = [];
  await runTurn(convId, text, images.map((i) => i.id), images.map((i) => ({ id: i.id, name: i.name })));
}

/**
 * 一轮对话的主流程（模型流式 + 工具循环渲染）。
 * 单独抽出是为了让「队列自动出队」与「立即发送」复用同一条路径；
 * 注意模型取自**该对话**的设置，而不是当前展示的对话（后台出队时二者不同）。
 */
async function runTurn(convId: string, text: string, imageIds: string[], thumbnails?: Array<{ id: string; name: string }>) {
  const state = stateOf(convId);
  if (state.sending) {
    // 并发兜底（例如另一标签页正在生成同对话）：入队而不是报错，消息不丢。
    await enqueueMessage(convId, text, imageIds);
    return;
  }
  state.bubbles.push({
    id: ++seq,
    role: "user",
    text,
    images: thumbnails || imageIds.map((id) => ({ id, name: id })),
  });
  // 必须用 reactive 包装：若 push 原始对象、之后又用原引用改属性，Vue 3 不会触发重渲染
  // （表现：流式文字不逐步显示、工具步骤与确认卡在等待期间不出现 → 确认必然超时）。
  const reply = reactive<Bubble>({
    id: ++seq,
    role: "assistant",
    text: "",
    streaming: true,
    steps: [],
    pending: null,
  });
  state.bubbles.push(reply);
  state.sending = true;
  state.error = "";
  const chosenModel = state.settings.modelId || models.value[0]?.id || "";
  state.activeModelLabel = models.value.find((m) => m.id === chosenModel)?.label || "";
  // 中断句柄存进「该对话自己的」状态：切到别的对话后按停止不会误伤这一条。
  const controller = new AbortController();
  state.controller = controller;
  queueScrollIfCurrent(convId);

  let stopped = false;
  let queued = false;
  try {
    await streamChat(
      text,
      // conversationId 显式带上：不依赖服务端的活跃对话回退（多标签页时会串）。
      { conversationId: convId, model: chosenModel || undefined, images: imageIds },
      (event) => {
        if (event.type === "text_delta") {
          reply.text += event.text;
          queueScrollIfCurrent(convId);
        } else if (event.type === "text") {
          reply.text = event.text;
        } else if (event.type === "model") {
          state.activeModelLabel = event.label;
        } else if (event.type === "tool_call") {
          reply.steps = reply.steps || [];
          reply.steps.push({
            id: event.id,
            name: event.name,
            server: event.server,
            args: event.args,
            status: "running",
          });
          openReasoning.add(reply.id);
          queueScrollIfCurrent(convId);
        } else if (event.type === "tool_result") {
          const step = (reply.steps || []).find((s) => s.id === event.id);
          if (step) {
            step.status = event.ok ? "ok" : "error";
            step.result = event.text;
          }
          reply.pending = null;
          queueScrollIfCurrent(convId);
        } else if (event.type === "confirmation_required") {
          reply.pending = { id: event.id, name: event.name, args: event.args, reason: event.reason };
          queueScrollIfCurrent(convId);
        } else if (event.type === "confirmation_response") {
          reply.pending = null;
        } else if (event.type === "error") {
          const message = localizeToken(uiLocale.value, event.error, event.message || "GENERIC_UNKNOWN_ERROR");
          reply.error = message;
          state.error = message;
        } else if (event.type === "todos") {
          // 任务规划（write_todos）：挂到当前回复气泡上，随执行推进状态。
          reply.todos = event.todos;
          openReasoning.add(reply.id);
          queueScrollIfCurrent(convId);
        } else if (event.type === "usage") {
          reply.usage = {
            tokens: event.tokens,
            budget: event.budget,
            window: event.window,
            turns: event.turns,
            dropped: event.dropped,
            summarized: event.summarized,
            toolResultsCleared: event.toolResultsCleared,
            toolResultsOffloaded: event.toolResultsOffloaded,
          };
        } else if (event.type === "done") {
          reply.streaming = false;
          openReasoning.delete(reply.id);
        }
      },
      controller.signal,
    );
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      stopped = true;
      reply.text = reply.text ? `${reply.text}\n\n${tx("（已停止生成）", " (stopped)")}` : tx("（已停止生成）", "(stopped)");
    } else if (getApiErrorToken(err) === "CONVERSATION_BUSY") {
      // 服务端并发保护（如另一标签页在跑）：消息不丢，进队列等下一轮自动发。
      queued = true;
      reply.text = tx("（该对话正在生成中，此消息已加入待发队列）", "(Chat is busy; the message was queued)");
      await enqueueMessage(convId, text, imageIds);
    } else {
      const message = localizeToken(
        uiLocale.value,
        getApiErrorToken(err),
        (err as Error)?.message || "GENERIC_UNKNOWN_ERROR",
      );
      reply.error = message;
      state.error = message;
    }
    reply.streaming = false;
  } finally {
    state.sending = false;
    state.controller = null;
    // 显式带上 convId：此刻用户可能已经切到别的对话，不能写错对话。
    await persist(convId, state.bubbles);
    queueScrollIfCurrent(convId);
    // 出队决策：停止 / 出错 / 已再入队 / 仍有待确认 → 停下等用户，不自动发下一条。
    void drainQueue(convId, !stopped && !queued && !reply.error && !reply.pending);
  }
}

/** 停止只作用于「当前正在看的这个对话」，不影响其它对话的流。 */
function stop() {
  current.value.controller?.abort();
}

// ---- 待发队列（后端持久化；忙时入队，成功收束后自动出队）----

function queueCount(conv: ConversationDto): number {
  return states.get(conv.id)?.queue.length || 0;
}

function moveQueueItem(index: number, dir: -1 | 1) {
  const convId = currentId.value;
  const state = current.value;
  const target = index + dir;
  if (!convId || target < 0 || target >= state.queue.length) return;
  const next = state.queue.slice();
  [next[index], next[target]] = [next[target]!, next[index]!];
  void setQueue(convId, next);
}

function removeQueueItem(index: number) {
  const convId = currentId.value;
  const state = current.value;
  if (!convId) return;
  void setQueue(convId, state.queue.filter((_, i) => i !== index));
}

/** 编辑 = 把内容拿回输入框并移出队列（比行内编辑器更简单，且复用既有输入体验）。 */
function editQueueItem(index: number) {
  const convId = currentId.value;
  const state = current.value;
  const item = state.queue[index];
  if (!convId || !item) return;
  state.input = item.text;
  void setQueue(convId, state.queue.filter((_, i) => i !== index));
}

/** 立即发送 = 中断当前生成 + 立刻发出这条（决议 C：主动权交给用户）。 */
async function sendQueueItemNow(index: number) {
  const convId = currentId.value;
  const state = current.value;
  const item = state.queue[index];
  if (!convId || !item) return;
  const rest = state.queue.filter((_, i) => i !== index);
  state.queue = rest;
  if (state.sending) {
    state.controller?.abort();
    // 等流真正收束（sending 翻转）再发，否则会被自己的并发保护再次入队。
    for (let i = 0; i < 20 && state.sending; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await setQueue(convId, rest);
  await runTurn(convId, item.text, item.images || []);
}

async function answerToolConfirm(bubble: Bubble, confirmed: boolean) {
  const pending = bubble.pending;
  if (!pending) return;
  bubble.pending = null;
  const step = (bubble.steps || []).find((s) => s.id === pending.id);
  if (step && !confirmed) {
    step.status = "cancelled";
    step.result = tx("已拒绝该工具调用", "Tool call denied");
  }
  await confirmToolCall(pending.id, confirmed).catch(() => undefined);
}

// ---- MCP 连接面板 ----
/**
 * 拉取某对话的可用服务器与启用集（必须显式传 conversationId：
 * 不带会回退到服务端 activeConversationId，读到的是别的对话）。
 * 响应可能晚于对话切换，所以写回「发起时那个对话」的状态，避免串味。
 */
async function loadMcp(convId = currentId.value) {
  if (!convId) return;
  const data = await fetchChatMcpServers(convId).catch(() => null);
  if (!data) return;
  mcpAvailable.value = data.available;
  const state = states.get(convId);
  if (state) state.settings.mcpEnabled = data.enabled;
}

/** 展开面板时刷新一次，避免看到过期连接状态。 */
function toggleMcpPanel() {
  mcpOpen.value = !mcpOpen.value;
  if (mcpOpen.value) void loadMcp();
}

/** 勾选/取消某个 MCP 服务器（乐观更新 + 失败回滚）。 */
async function toggleMcp(id: string, on: boolean) {
  const convId = currentId.value;
  const state = current.value;
  if (!convId) return;
  const prev = state.settings.mcpEnabled;
  const next = on ? [...new Set([...prev, id])] : prev.filter((item) => item !== id);
  state.settings.mcpEnabled = next;
  mcpBusy.value = true;
  mcpError.value = "";
  try {
    const data = await setChatMcpServers(next, convId);
    mcpAvailable.value = data.available;
    state.settings.mcpEnabled = data.enabled;
    syncConvLocal(convId, { mcpServers: data.enabled });
    // 连接是异步的，稍后刷新一次拿到真实连接状态。
    setTimeout(() => void loadMcp(convId), 1500);
  } catch (err) {
    state.settings.mcpEnabled = prev;
    mcpError.value = localizeToken(
      uiLocale.value,
      getApiErrorToken(err),
      (err as Error)?.message || tx("操作失败", "Request failed"),
    );
  } finally {
    mcpBusy.value = false;
  }
}

/** 取消全部启用（面板是纯选择语义，不再提供断开/删除服务端）。 */
async function clearMcpSelection() {
  const convId = currentId.value;
  const state = current.value;
  if (!convId) return;
  const prev = state.settings.mcpEnabled;
  state.settings.mcpEnabled = [];
  mcpBusy.value = true;
  try {
    const data = await setChatMcpServers([], convId);
    mcpAvailable.value = data.available;
    state.settings.mcpEnabled = data.enabled;
    syncConvLocal(convId, { mcpServers: data.enabled });
  } catch (err) {
    state.settings.mcpEnabled = prev;
    mcpError.value = localizeToken(
      uiLocale.value,
      getApiErrorToken(err),
      (err as Error)?.message || tx("操作失败", "Request failed"),
    );
  } finally {
    mcpBusy.value = false;
  }
}

async function reconnectMcp(id: string) {
  const convId = currentId.value;
  mcpBusy.value = true;
  await reloadMcpServer(id).catch(() => undefined);
  await loadMcp(convId);
  mcpBusy.value = false;
}

function onOutsideMcp(event: MouseEvent) {
  if (!mcpRoot.value?.contains(event.target as Node)) mcpOpen.value = false;
}

function stepClass(status: ToolStep["status"]): string {
  if (status === "ok") return "ok";
  if (status === "error" || status === "cancelled") return "err";
  return "running";
}

function stepStatusText(status: ToolStep["status"]): string {
  if (status === "ok") return tx("已完成", "done");
  if (status === "error") return tx("失败", "failed");
  if (status === "cancelled") return tx("已拒绝", "denied");
  return tx("执行中", "running");
}

/** 上下文用量的一行摘要（透明度：让用户知道用了多少、丢了什么）。 */
function usageText(usage: NonNullable<Bubble["usage"]>): string {
  const parts = [
    `${tx("上下文", "Context")}: ${usage.turns} ${tx("条历史", "history")}`,
    `${usage.tokens}/${usage.budget} tokens`,
    `${tx("窗口", "window")} ${usage.window}`,
  ];
  if (usage.dropped) parts.push(`${tx("已丢弃较早消息", "dropped")} ${usage.dropped}`);
  if (usage.summarized) parts.push(tx("已生成历史摘要", "summary"));
  if (usage.toolResultsCleared) parts.push(`${tx("已清理工具结果", "cleared")} ${usage.toolResultsCleared}`);
  if (usage.toolResultsOffloaded) {
    parts.push(`${tx("已卸载到工作区", "offloaded")} ${usage.toolResultsOffloaded}`);
  }
  return parts.join(" · ");
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
}

/** 首屏要打开的对话（来自后端 preferences；迁移时可能来自旧本地键）。 */
let initialConversationId = "";
let activeReportTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 上报「上次打开的对话」（设备态）。
 * 节流 500ms：连点会话卡不该刷写后端。
 */
function reportActiveConversation(convId: string) {
  if (!convId) return;
  if (activeReportTimer) clearTimeout(activeReportTimer);
  activeReportTimer = setTimeout(() => {
    void saveChatPreferences({ activeConversationId: convId }).catch(() => undefined);
  }, 500);
}

/**
 * 一次性迁移：把旧的 3 个 localStorage 键搬到后端，成功后删除本地键。
 * 迁移完成的标记在**服务端**（`preferences.migratedAt`，首次 PUT 自动落），
 * 因此换设备/清缓存都不会重复迁移，也不会把旧值反复写回。
 */
async function migrateLocalPrefs(prefs: ChatPreferences) {
  if (prefs.migratedAt) return;
  let last = "";
  let locale = "";
  try {
    last = localStorage.getItem(LOCAL_KEYS.lastConversation) || "";
    locale = localStorage.getItem(LOCAL_KEYS.locale) || "";
  } catch {
    /* 读不到就当没有旧值 */
  }
  const storedTheme = readStoredTheme();
  try {
    const saved = await saveChatPreferences({
      activeConversationId: last || prefs.activeConversationId || undefined,
      ...(storedTheme ? { theme: storedTheme } : {}),
      ...(isUiLocale(locale) ? { locale } : {}),
    });
    if (isUiLocale(saved.locale)) deviceLocale.value = saved.locale;
    adoptTheme(saved.theme);
    initialConversationId = saved.activeConversationId;
    for (const key of [LOCAL_KEYS.lastConversation, LOCAL_KEYS.locale, "bx-agent-theme"]) {
      localStorage.removeItem(key);
    }
  } catch {
    /* 迁移失败：保留本地键，下次启动再试（不阻断启动） */
  }
}

onMounted(async () => {
  models.value = await fetchModels().catch(() => []);
  // 不在这里写 modelId：它已按对话派生（空 = 服务端默认，UI 兜底列表首个），
  // 赋值会触发一次无意义的 PATCH。
  // 不在这里 loadMcp()：此刻还没选中对话，请求会回退到服务端的 activeConversationId（可能是别的对话）。
  // 交给下面的 selectConversation / newConversation 按对话加载。
  window.addEventListener("mousedown", onOutsideMcp);

  // 设备态偏好（主题 / 默认语言 / 上次打开的对话）以后端为唯一真相；顺带跑一次性迁移。
  const prefs = await fetchChatPreferences().catch(() => null);
  if (prefs) {
    if (isUiLocale(prefs.locale)) deviceLocale.value = prefs.locale;
    adoptTheme(prefs.theme);
    initialConversationId = prefs.activeConversationId;
    await migrateLocalPrefs(prefs);
  }

  const list = await fetchConversations().catch(() => [] as ConversationDto[]);
  conversations.value = list;
  const target = list.find((c) => c.id === initialConversationId) || list[0];
  if (target) selectConversation(target);
  else await newConversation();
});

onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onOutsideMcp);
});
</script>

<template>
  <div class="chat">
    <aside class="sidebar">
      <button class="new-chat" type="button" @click="newConversation">
        + {{ tx("新对话", "New chat") }}
      </button>
      <div class="conv-list">
        <div
          v-for="conv in conversations"
          :key="conv.id"
          class="conv-item"
          :class="{ active: conv.id === currentId }"
          @click="selectConversation(conv)"
        >
          <span
            v-if="convStatus(conv)"
            class="conv-dot"
            :class="convStatus(conv)"
            :title="convStatusText(convStatus(conv))"
            :aria-label="convStatusText(convStatus(conv))"
            role="img"
          ></span>
          <span class="conv-title">{{ conv.title || tx("新对话", "New chat") }}</span>
          <span
            v-if="queueCount(conv)"
            class="conv-queue"
            :title="tx('有排队消息', 'Has queued messages')"
            :aria-label="tx('有排队消息', 'Has queued messages')"
          >{{ queueCount(conv) }}</span>
          <button
            class="conv-del"
            type="button"
            :title="tx('删除对话', 'Delete chat')"
            @click.stop="removeConversation(conv.id)"
          >
            ×
          </button>
        </div>
      </div>
      <button class="ghost-btn" type="button" @click="clearCurrent">
        {{ tx("清空当前对话", "Clear current chat") }}
      </button>
    </aside>

    <main class="main">
      <header class="top">
        <div class="brand">{{ tx("对话", "Chat") }}</div>
        <div class="top-actions">
          <span
            v-if="current.activeModelLabel && current.activeModelLabel !== selectedModelLabel"
            class="model-tag"
          >
            {{ current.activeModelLabel }}
          </span>
          <ModelSelect v-model="modelId" :models="models" />
          <span ref="mcpRoot" class="mcp-box">
            <button
              type="button"
              class="mcp-btn"
              :class="{ on: current.settings.mcpEnabled.length > 0 }"
              :aria-expanded="mcpOpen"
              aria-haspopup="dialog"
              :title="tx('选择要连接的 MCP 服务器', 'Choose MCP servers to connect')"
              @click="toggleMcpPanel"
            >
              MCP<span v-if="current.settings.mcpEnabled.length" class="mcp-count">{{
                current.settings.mcpEnabled.length
              }}</span>
            </button>
            <div v-if="mcpOpen" class="mcp-panel" role="dialog" :aria-label="tx('MCP 连接', 'MCP connections')">
              <div class="mcp-panel__head">
                <span>{{ tx("MCP 连接", "MCP connections") }}</span>
                <button
                  class="mcp-link"
                  type="button"
                  :disabled="!current.settings.mcpEnabled.length || mcpBusy"
                  @click="clearMcpSelection"
                >
                  {{ tx("全部取消", "Deselect all") }}
                </button>
              </div>

              <div class="mcp-list">
                <div v-if="!mcpAvailable.length" class="mcp-empty">
                  {{ tx("没有可选的 MCP 服务器", "No MCP server available") }}
                </div>
                <div v-for="s in mcpAvailable" :key="s.id" class="mcp-row">
                  <label class="mcp-row__main">
                    <input
                      type="checkbox"
                      :checked="current.settings.mcpEnabled.includes(s.id)"
                      :disabled="mcpBusy"
                      @change="toggleMcp(s.id, !current.settings.mcpEnabled.includes(s.id))"
                    />
                    <span class="mcp-row__text">
                      <span class="mcp-row__label">{{ s.label }}</span>
                      <span class="mcp-row__meta">
                        <span class="mcp-dot" :class="s.connected ? 'ok' : s.error ? 'err' : 'idle'"></span>
                        {{ s.transport }} ·
                        {{
                          s.connected
                            ? tx("已连接", "connected")
                            : s.connecting
                              ? tx("连接中", "connecting")
                              : s.error
                                ? tx("失败", "failed")
                                : tx("未连接", "not connected")
                        }}
                        · {{ s.tools }} {{ tx("工具", "tools") }}
                      </span>
                      <span v-if="s.error" class="mcp-row__err">{{ s.error }}</span>
                      <span v-if="s.toolsError" class="mcp-row__err">{{ s.toolsError }}</span>
                      <span v-if="mcpExpanded === s.id && s.toolNames.length" class="mcp-tools">{{ s.toolNames.join("、") }}</span>
                    </span>
                  </label>
                  <div class="mcp-row__ops">
                    <button
                      class="mcp-mini"
                      type="button"
                      :title="tx('工具清单', 'Tool list')"
                      @click="mcpExpanded = mcpExpanded === s.id ? '' : s.id"
                    >
                      {{ mcpExpanded === s.id ? "▴" : "▾" }}
                    </button>
                    <button class="mcp-mini" type="button" :title="tx('重连', 'Reconnect')" @click="reconnectMcp(s.id)">
                      ⟳
                    </button>
                  </div>
                </div>
              </div>

              <div v-if="mcpError" class="mcp-error">{{ mcpError }}</div>
            </div>
          </span>
          <UiLocaleSelect @change="onLocaleChange" />
          <ThemeToggle />
        </div>
      </header>

      <div v-if="settingsError" class="warn-line header-warn" role="status">{{ settingsError }}</div>

      <div ref="threadEl" class="thread">
        <div v-if="!current.bubbles.length" class="empty">
          {{ tx("随便问点什么吧。", "Ask anything to get started.") }}
        </div>
        <div v-for="b in current.bubbles" :key="b.id" class="row" :class="b.role">
          <div class="bubble">
            <div
              v-if="b.todos?.length || b.steps?.length"
              class="reasoning"
              :class="{ open: openReasoning.has(b.id) }"
            >
              <button class="reasoning__head" type="button" @click="toggleReasoning(b.id)">
                <span class="reasoning__caret" aria-hidden="true"></span>
                <span class="reasoning__title">{{ reasoningTitle(b) }}</span>
                <span v-if="b.streaming && hasRunningStep(b)" class="reasoning__spinner" aria-hidden="true"></span>
              </button>
              <div v-show="openReasoning.has(b.id)" class="reasoning__body">
                <div v-if="b.todos?.length" class="todos">
                  <div class="todos__head">{{ tx("任务计划", "Plan") }}</div>
                  <div v-for="(item, i) in b.todos" :key="i" class="todos__item">
                    <span class="todos__mark" :class="item.status" aria-hidden="true">
                      {{
                        item.status === "completed"
                          ? "✓"
                          : item.status === "in_progress"
                            ? "•"
                            : item.status === "cancelled"
                              ? "×"
                              : "○"
                      }}
                    </span>
                    <span
                      class="todos__text"
                      :class="{ done: item.status === 'completed' || item.status === 'cancelled' }"
                    >{{ item.content }}</span>
                  </div>
                </div>
                <div v-if="b.steps?.length" class="steps">
                  <div v-for="step in b.steps" :key="step.id" class="step">
                    <div class="step-head">
                      <span class="mcp-dot" :class="stepClass(step.status)"></span>
                      <span class="step-name">{{ step.name }}</span>
                      <span v-if="step.server" class="step-server">{{ step.server }}</span>
                      <span class="step-status">{{ stepStatusText(step.status) }}</span>
                    </div>
                    <pre v-if="step.result" class="step-result">{{ step.result }}</pre>
                  </div>
                </div>
              </div>
            </div>
            <div v-if="b.pending" class="confirm-card">
              <div class="confirm-text">
                {{ tx("工具调用需要确认", "This tool call needs your approval") }}：<b>{{ b.pending.name }}</b>
              </div>
              <div v-if="b.pending.reason" class="confirm-reason">{{ b.pending.reason }}</div>
              <pre v-if="b.pending.args" class="confirm-args">{{ b.pending.args }}</pre>
              <div class="confirm-ops">
                <button type="button" class="mcp-primary" @click="answerToolConfirm(b, true)">
                  {{ tx("允许", "Allow") }}
                </button>
                <button type="button" class="mcp-link" @click="answerToolConfirm(b, false)">
                  {{ tx("拒绝", "Deny") }}
                </button>
              </div>
            </div>
            <div v-if="b.images?.length" class="thumbs">
              <img v-for="img in b.images" :key="img.id" :src="`/agent/chat/upload/${img.id}`" :alt="img.name" />
            </div>
            <div v-if="b.role === 'user'" class="plain">{{ b.text }}</div>
            <div v-else-if="b.text" class="md" v-html="renderChatMarkdown(b.text)"></div>
            <div v-else-if="!b.error && b.streaming" class="typing">
              <span></span><span></span><span></span>
            </div>
            <div v-if="b.error" class="err">{{ b.error }}</div>
            <div v-if="b.usage" class="usage-line">{{ usageText(b.usage) }}</div>
          </div>
        </div>
      </div>

      <footer class="composer">
        <div v-if="current.queue.length" class="queue" role="region" :aria-label="tx('待发队列', 'Message queue')">
          <div class="queue__head">
            <span>{{ tx("排队中", "Queued") }} · {{ current.queue.length }}</span>
            <span class="queue__hint">{{ tx("生成结束后按序自动发送", "Sent in order after the current reply") }}</span>
          </div>
          <div v-for="(item, i) in current.queue" :key="item.at" class="queue__item">
            <span class="queue__text">{{ item.text || tx("（仅图片）", "(images only)") }}</span>
            <span class="queue__ops">
              <button
                type="button"
                :disabled="i === 0"
                :title="tx('上移', 'Move up')"
                :aria-label="tx('上移', 'Move up')"
                @click="moveQueueItem(i, -1)"
              >
                ↑
              </button>
              <button
                type="button"
                :disabled="i === current.queue.length - 1"
                :title="tx('下移', 'Move down')"
                :aria-label="tx('下移', 'Move down')"
                @click="moveQueueItem(i, 1)"
              >
                ↓
              </button>
              <button type="button" @click="editQueueItem(i)">{{ tx("编辑", "Edit") }}</button>
              <button type="button" :title="tx('移除', 'Remove')" :aria-label="tx('移除', 'Remove')" @click="removeQueueItem(i)">
                ×
              </button>
              <button type="button" class="queue__send" @click="sendQueueItemNow(i)">
                {{ tx("立即发送", "Send now") }}
              </button>
            </span>
          </div>
        </div>
        <div v-if="current.pendingImages.length" class="pending">
          <span v-for="img in current.pendingImages" :key="img.id" class="chip">
            {{ img.name }}
            <button
              type="button"
              :title="tx('移除', 'Remove')"
              :aria-label="tx('移除', 'Remove')"
              @click="removePendingImage(img.id)"
            >
              ×
            </button>
          </span>
        </div>
        <div v-if="imagesUnsupported" class="warn-line">
          {{
            tx(
              "当前模型不支持图片，这些图片不会被发送给模型。请改用支持图片的模型。",
              "The current model can't read images, so they won't be sent. Pick a vision-capable model.",
            )
          }}
        </div>
        <div class="composer-row">
          <input
            id="chat-file-input"
            ref="fileInput"
            type="file"
            name="files"
            accept="image/*"
            multiple
            hidden
            @change="pickFiles"
          />
          <button
            class="icon-btn"
            type="button"
            :title="tx('上传图片', 'Upload image')"
            :aria-label="tx('上传图片', 'Upload image')"
            @click="fileInput?.click()"
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
              <circle cx="8.75" cy="10" r="1.5" />
              <path d="M20.5 15.5 15.75 11 9.5 17.5" />
            </svg>
          </button>
          <textarea
            id="chat-input"
            ref="inputEl"
            v-model="current.input"
            class="input"
            name="message"
            rows="1"
            :placeholder="tx('输入消息，Enter 发送，Shift+Enter 换行', 'Type a message. Enter to send, Shift+Enter for a new line')"
            @input="autoGrow"
            @keydown="onKeydown"
          ></textarea>
          <button v-if="current.sending" class="send stop" type="button" @click="stop">
            {{ tx("停止", "Stop") }}
          </button>
          <button v-else class="send" type="button" :disabled="!canSend" @click="send">
            {{ tx("发送", "Send") }}
          </button>
        </div>
      </footer>
    </main>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  height: 100dvh;
  width: 100%;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font-body);
}

.sidebar {
  width: 248px;
  flex: 0 0 248px;
  border-right: 1px solid var(--line);
  background: var(--panel);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.new-chat {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--line-strong);
  background: var(--ink);
  color: var(--bg);
  border-radius: var(--radius);
  padding: 10px 12px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  line-height: 1;
  transition:
    transform 0.15s var(--ease),
    box-shadow 0.2s ease,
    opacity 0.2s ease;
}

.new-chat:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 18px color-mix(in srgb, var(--ink) 20%, transparent);
}

.new-chat:active {
  transform: translateY(0);
  box-shadow: none;
}

.new-chat:focus-visible {
  box-shadow: var(--ring);
}

.conv-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.conv-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
}

.conv-item:hover {
  background: var(--fill-soft);
}

.conv-item.active {
  background: var(--fill-soft);
  border: 1px solid var(--line);
}

/* 侧栏状态点：生成中 / 待确认 / 出错。不只靠颜色区分（同时带 title 与 aria-label 文案）。 */
.conv-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: var(--muted);
}

.conv-dot.running {
  background: var(--stop);
  animation: mcp-pulse 1.1s infinite ease-in-out;
}

.conv-dot.pending {
  background: color-mix(in srgb, #d99a1f 85%, var(--ink));
}

.conv-dot.error {
  background: var(--danger);
}

/* 侧栏排队徽标：该对话有待发消息（不只用颜色，带 title/aria 文案）。 */
.conv-queue {
  flex: none;
  min-width: 16px;
  padding: 1px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, #d99a1f 18%, transparent);
  color: color-mix(in srgb, #d99a1f 85%, var(--ink));
  font-size: 10px;
  font-weight: 600;
  line-height: 1.4;
  text-align: center;
}

.conv-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-del {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: none;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  opacity: 0.45;
  transition:
    opacity 0.15s ease,
    background 0.15s ease,
    color 0.15s ease;
}

.conv-item:hover .conv-del {
  opacity: 1;
}

.conv-del:hover,
.conv-del:focus-visible {
  opacity: 1;
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
}

.ghost-btn {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  border-radius: var(--radius);
  padding: 8px 10px;
  cursor: pointer;
  font-size: 13px;
  transition:
    color 0.15s ease,
    background 0.15s ease,
    border-color 0.15s ease;
}

.ghost-btn:hover {
  color: var(--ink);
  background: var(--fill-soft);
  border-color: color-mix(in srgb, var(--ink) 26%, var(--line));
}

.ghost-btn:focus-visible {
  box-shadow: var(--ring);
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--line);
}

.brand {
  font-family: var(--font-display);
  font-size: 17px;
}

.top-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.model-tag {
  font-size: 12px;
  line-height: 1;
  color: var(--muted);
  padding: 5px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--fill-soft) 65%, transparent);
  white-space: nowrap;
}

/* ---- MCP 连接面板 ---- */
.mcp-box {
  position: relative;
  display: inline-flex;
}

.mcp-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: var(--ctrl-h);
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--muted);
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  flex: none;
  transition:
    color 0.15s ease,
    background 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.mcp-btn:hover {
  color: var(--ink);
  background: var(--fill-soft);
  border-color: color-mix(in srgb, var(--ink) 28%, var(--line));
}

.mcp-btn.on {
  color: var(--ink);
  border-color: color-mix(in srgb, var(--ink) 30%, var(--line));
}

.mcp-btn:focus-visible,
.mcp-btn[aria-expanded="true"] {
  outline: none;
  box-shadow: var(--ring);
}

.mcp-count {
  min-width: 16px;
  padding: 1px 5px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--ink) 12%, transparent);
  color: var(--ink);
  font-size: 11px;
  text-align: center;
}

.mcp-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 30;
  width: 340px;
  max-width: calc(100vw - 32px);
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--line) 88%, var(--ink) 12%);
  border-radius: calc(var(--radius-sm) + 2px);
  background: color-mix(in srgb, var(--panel) 92%, white 8%);
  box-shadow:
    0 12px 28px color-mix(in srgb, var(--ink) 12%, transparent),
    0 2px 8px color-mix(in srgb, var(--ink) 6%, transparent);
  backdrop-filter: blur(10px);
  color: var(--ink);
  font-size: 13px;
}

.mcp-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 2px 8px;
}

.mcp-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 300px;
  overflow-y: auto;
}

.mcp-empty {
  padding: 10px 4px;
  color: var(--muted);
  font-size: 12px;
}

.mcp-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px;
  border-radius: var(--radius-sm);
  transition: background 0.15s ease;
}

.mcp-row:hover {
  background: color-mix(in srgb, var(--fill-soft) 78%, var(--panel));
}

.mcp-row__main {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.mcp-row__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.mcp-row__label {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcp-row__meta {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--muted);
  font-size: 12px;
}

.mcp-row__err {
  color: var(--danger);
  font-size: 11px;
  word-break: break-word;
}

.mcp-tools {
  margin-top: 2px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
  word-break: break-word;
}

.mcp-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: var(--muted);
  opacity: 0.55;
}

.mcp-dot.ok {
  background: color-mix(in srgb, #2f9e63 85%, var(--ink));
  opacity: 1;
}

.mcp-dot.err {
  background: var(--danger);
  opacity: 1;
}

.mcp-dot.running {
  background: var(--stop);
  opacity: 1;
  animation: mcp-pulse 1.1s infinite ease-in-out;
}

@keyframes mcp-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}

.mcp-row__ops {
  display: inline-flex;
  gap: 2px;
  flex: none;
}

.mcp-mini {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}

.mcp-mini:hover {
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 10%, transparent);
}

.mcp-mini.danger:hover {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.mcp-link {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 6px;
  transition: color 0.15s ease, background 0.15s ease;
}

.mcp-link:hover:not(:disabled) {
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}

.mcp-link:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.mcp-error {
  margin: 6px 2px 0;
  color: var(--danger);
  font-size: 12px;
  word-break: break-word;
}

.mcp-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--ink);
  color: var(--bg);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: transform 0.15s var(--ease), box-shadow 0.2s ease, opacity 0.2s ease;
}

.mcp-primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 6px 16px color-mix(in srgb, var(--ink) 18%, transparent);
}

.mcp-primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* ---- 气泡里的工具步骤与确认卡 ---- */
.steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}

.step {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--fill-soft) 60%, transparent);
  padding: 6px 8px;
}

.step-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.step-name {
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.step-server,
.step-status {
  color: var(--muted);
  flex: none;
}

.step-status {
  margin-left: auto;
}

.step-result {
  margin: 6px 0 0;
  max-height: 160px;
  overflow: auto;
  background: color-mix(in srgb, var(--panel) 70%, transparent);
  border-radius: 6px;
  padding: 6px 8px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.confirm-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--stop) 45%, var(--line));
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--stop) 8%, transparent);
  font-size: 13px;
}

.confirm-reason {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.confirm-args {
  margin: 0;
  max-height: 120px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.confirm-ops {
  display: flex;
  gap: 8px;
}

.thread {
  flex: 1;
  overflow-y: auto;
  padding: 22px 18px 8px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
}

.empty {
  margin: auto;
  color: var(--muted);
  font-size: 14px;
}

.row {
  display: flex;
}

.row.user {
  justify-content: flex-end;
}

.bubble {
  max-width: min(760px, 92%);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 12px 14px;
  background: var(--panel);
  box-shadow: var(--shadow);
  font-size: 14px;
  line-height: 1.65;
}

.row.user .bubble {
  background: var(--fill-soft);
}

.plain {
  white-space: pre-wrap;
  word-break: break-word;
}

.md :deep(p),
.md :deep(ul),
.md :deep(ol),
.md :deep(pre) {
  margin: 0 0 8px;
}

.md :deep(pre) {
  background: var(--fill-soft);
  padding: 10px;
  border-radius: var(--radius-sm);
  overflow-x: auto;
}

.md :deep(code) {
  font-family: var(--font-mono);
  font-size: 13px;
}

.md :deep(table) {
  border-collapse: collapse;
  width: 100%;
}

.md :deep(th),
.md :deep(td) {
  border: 1px solid var(--line);
  padding: 6px 8px;
  text-align: left;
}

.thumbs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.thumbs img {
  max-width: 160px;
  max-height: 160px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
}

.err {
  color: var(--danger);
  font-size: 13px;
  white-space: pre-wrap;
}

.usage-line {
  margin-top: 6px;
  font-size: 11px;
  color: var(--muted);
  word-break: break-all;
}

.warn-line {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--danger);
}

/* 任务计划（write_todos）：状态标记不只靠颜色（✓/•/○/× 字形 + 文案删除线）。 */
.todos {
  margin-bottom: 8px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.todos__head {
  margin-bottom: 5px;
  color: var(--muted);
  font-weight: 600;
}

.todos__item {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 2px 0;
  line-height: 1.5;
}

.todos__mark {
  flex: none;
  width: 14px;
  text-align: center;
  color: var(--muted);
}

.todos__mark.completed {
  color: color-mix(in srgb, #2f9e63 85%, var(--ink));
}

.todos__mark.in_progress {
  color: var(--stop);
}

.todos__mark.cancelled {
  color: var(--danger);
}

.todos__text.done {
  color: var(--muted);
  text-decoration: line-through;
}

/* 推理过程（任务计划 + 工具步骤）折叠：生成中展开、收束后折叠，避免长过程刷屏。 */
.reasoning {
  margin-bottom: 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--fill-soft) 55%, transparent);
  overflow: hidden;
}

.reasoning__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  text-align: left;
  transition: color 0.15s ease;
}

.reasoning__head:hover {
  color: var(--ink);
}

.reasoning__caret {
  flex: none;
  width: 6px;
  height: 6px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
  transition: transform 0.18s ease;
}

.reasoning.open .reasoning__caret {
  transform: rotate(45deg);
}

.reasoning__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reasoning__spinner {
  flex: none;
  width: 11px;
  height: 11px;
  border: 1.5px solid color-mix(in srgb, var(--ink) 22%, transparent);
  border-top-color: var(--stop);
  border-radius: 50%;
  animation: reason-spin 0.7s linear infinite;
}

@keyframes reason-spin {
  to { transform: rotate(360deg); }
}

.reasoning__body {
  padding: 2px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.reasoning__body .todos,
.reasoning__body .steps {
  margin-bottom: 0;
}

/* 待发队列：忙时入队、成功收束后按序自动发；出错/待确认时停下等用户。 */
.queue {
  margin-bottom: 8px;
  padding: 8px 10px;
  border: 1px dashed color-mix(in srgb, var(--line) 70%, var(--ink) 10%);
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.queue__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--muted);
}

.queue__hint {
  font-size: 11px;
  opacity: 0.8;
}

.queue__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 0;
}

.queue__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
}

.queue__ops {
  display: inline-flex;
  gap: 4px;
  flex: none;
}

.queue__ops button {
  min-width: 24px;
  height: 22px;
  padding: 0 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--ink);
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
}

.queue__ops button:hover:not(:disabled) {
  background: var(--fill-soft);
}

.queue__ops button:disabled {
  opacity: 0.4;
  cursor: default;
}

.queue__send {
  color: var(--stop);
}

/* 设置保存失败的横幅：挂在 header 下方，不挤压输入区。 */
.header-warn {
  padding: 6px 18px 0;
}

.typing {
  display: flex;
  gap: 4px;
}

.typing span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted);
  animation: blink 1.2s infinite ease-in-out;
}

.typing span:nth-child(2) {
  animation-delay: 0.15s;
}

.typing span:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes blink {
  0%, 80%, 100% { opacity: 0.25; }
  40% { opacity: 1; }
}

.composer {
  border-top: 1px solid var(--line);
  padding: 12px 18px calc(12px + var(--safe-bottom));
  background: var(--panel);
}

.pending {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  padding: 3px 8px;
  color: var(--muted);
}

.chip button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}

.chip button:hover {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.composer-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex: none;
  border: 1px solid var(--line);
  background: var(--fill);
  color: var(--muted);
  border-radius: var(--radius-sm);
  padding: 0;
  cursor: pointer;
  transition:
    color 0.15s ease,
    background 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.icon-btn:hover {
  color: var(--ink);
  background: var(--fill-soft);
  border-color: color-mix(in srgb, var(--ink) 26%, var(--line));
}

.icon-btn:focus-visible {
  box-shadow: var(--ring);
}

.input {
  flex: 1;
  resize: none;
  min-height: 44px;
  max-height: 200px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 10px 12px;
  background: var(--fill);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.5;
}

.input:focus {
  outline: 2px solid color-mix(in srgb, var(--ink) 25%, transparent);
}

.send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 44px;
  min-height: 44px;
  flex: none;
  border: 1px solid var(--line-strong);
  background: var(--ink);
  color: var(--bg);
  border-radius: var(--radius);
  padding: 0 18px;
  font-size: 14px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  transition:
    transform 0.15s var(--ease),
    box-shadow 0.2s ease,
    opacity 0.2s ease,
    background 0.2s ease;
}

.send:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 8px 20px color-mix(in srgb, var(--ink) 18%, transparent);
}

.send:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: none;
}

.send:focus-visible {
  box-shadow: var(--ring);
}

.send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.send.stop {
  background: var(--stop);
  border-color: var(--stop);
  color: #fff;
}

@media (max-width: 860px) {
  .sidebar {
    display: none;
  }
}

@media (max-width: 720px) {
  .model-tag {
    display: none;
  }

  .top {
    gap: 8px;
    padding: 10px 12px;
  }

  .top-actions {
    gap: 6px;
  }
}
</style>
