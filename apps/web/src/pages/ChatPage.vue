<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type ComponentPublicInstance,
} from "vue";
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
  reorderConversations,
  saveChatPreferences,
  saveConversationMessages,
  setChatMcpServers,
  streamChat,
  uploadFiles,
  type ChatPreferences,
  type ConversationDto,
  type ConvSortMode,
  type McpServerStatus,
  type ModelInfo,
  type PendingMessage,
  type StoredMessage,
  type UploadResult,
} from "../api";
import type { TodoItem } from "@bx/shared";

/** 侧栏视图：对话列表 / 定时任务。为后续接入定时任务预留结构化入口（占位面板）。 */
const view = ref<"chat" | "tasks">("chat");

/* ===========================================================================
 * 定时任务（前端脚手架）
 * 数据暂存 localStorage，结构对齐真实接口：
 *   { id, name, prompt, scheduleType: 'recurring'|'once',
 *     rrule?, scheduledAt?, status: 'active'|'paused', createdAt, nextRun? }
 * 接入后端时只需把 load/save 换成 GET/POST /agent/automations。
 * =========================================================================== */
interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  scheduleType: "recurring" | "once";
  rrule?: string;
  scheduledAt?: string;
  status: "active" | "paused";
  createdAt: number;
  nextRun?: number | null;
}

const TASKS_KEY = "bx-agent-automations";

function loadTasks(): ScheduledTask[] {
  try {
    const raw = localStorage.getItem(TASKS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? (arr as ScheduledTask[]) : [];
  } catch {
    return [];
  }
}

function saveTasks() {
  try {
    localStorage.setItem(TASKS_KEY, JSON.stringify(tasks.value));
  } catch {
    /* 隐私模式等写入失败时忽略 */
  }
}

const tasks = ref<ScheduledTask[]>(loadTasks());

const showTaskForm = ref(false);
const taskError = ref("");
const taskDraft = reactive({
  name: "",
  prompt: "",
  scheduleType: "recurring" as "recurring" | "once",
  rrule: "FREQ=DAILY;INTERVAL=1",
  scheduledAt: "",
});

function openTaskForm() {
  taskDraft.name = "";
  taskDraft.prompt = "";
  taskDraft.scheduleType = "recurring";
  taskDraft.rrule = "FREQ=DAILY;INTERVAL=1";
  taskDraft.scheduledAt = "";
  taskError.value = "";
  showTaskForm.value = true;
}

function closeTaskForm() {
  showTaskForm.value = false;
}

/** 脚手架阶段对 recurring 给粗略估算（每日=明天此刻），真实 nextRun 由后端计算。 */
function draftNextRun(): number | null {
  if (taskDraft.scheduleType === "once") {
    const t = taskDraft.scheduledAt ? new Date(taskDraft.scheduledAt).getTime() : NaN;
    return Number.isNaN(t) ? null : t;
  }
  return Date.now() + 24 * 3600 * 1000;
}

function createTask() {
  const name = taskDraft.name.trim();
  const prompt = taskDraft.prompt.trim();
  if (!name) return (taskError.value = tx("请填写任务名称", "Name is required"));
  if (!prompt) return (taskError.value = tx("请填写任务内容", "Task prompt is required"));
  if (taskDraft.scheduleType === "once" && !taskDraft.scheduledAt)
    return (taskError.value = tx("请选择执行时间", "Pick a run time"));
  tasks.value.unshift({
    id: "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    prompt,
    scheduleType: taskDraft.scheduleType,
    rrule: taskDraft.scheduleType === "recurring" ? taskDraft.rrule.trim() : undefined,
    scheduledAt: taskDraft.scheduleType === "once" ? taskDraft.scheduledAt : undefined,
    status: "active",
    createdAt: Date.now(),
    nextRun: draftNextRun(),
  });
  saveTasks();
  closeTaskForm();
}

function toggleTask(id: string) {
  const t = tasks.value.find((x) => x.id === id);
  if (!t) return;
  t.status = t.status === "active" ? "paused" : "active";
  saveTasks();
}

function removeTask(id: string) {
  tasks.value = tasks.value.filter((x) => x.id !== id);
  saveTasks();
}

function taskNextRunText(t: ScheduledTask): string {
  if (t.status !== "active") return tx("已暂停", "Paused");
  if (t.scheduleType === "once") {
    if (!t.scheduledAt) return tx("未设置", "Unscheduled");
    return tx("执行于 ", "Runs at ") + new Date(t.scheduledAt).toLocaleString();
  }
  return t.nextRun ? tx("下次 ", "Next ") + new Date(t.nextRun).toLocaleString() : "—";
}

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
/** 会话项上下文菜单（右键触发）：视口坐标绝对定位，渲染后做边界翻转。 */
const ctxMenu = ref<{ open: boolean; x: number; y: number; targetId: string }>({
  open: false,
  x: 0,
  y: 0,
  targetId: "",
});
const ctxMenuEl = ref<HTMLElement | null>(null);
/** 触发菜单的元素（会话项 / ⋯ 按钮）：Esc 关闭后把焦点还回去（WAI-ARIA menu pattern）。 */
let ctxTriggerEl: HTMLElement | null = null;
/** 正在内联重命名的会话（id 为空 = 无）。 */
const renaming = ref<{ id: string; value: string }>({ id: "", value: "" });
const renameInputEl = ref<HTMLInputElement | null>(null);
/** 标题长度上限：只做体验层收敛，防误粘贴超长文本。 */
const RENAME_MAX = 100;
/** 删除撤销窗口：窗口内可撤销，超时才真正落库删除。 */
const UNDO_DELETE_MS = 5000;
const undoDelete = ref<{ conv: ConversationDto; index: number; wasCurrent: boolean } | null>(null);
let undoDeleteTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 会话列表排序模式（设备级偏好，后端持久化）：
 * - `recent`：普通区按最近活动自动上浮（默认）；
 * - `manual`：按用户手动顺序，新消息不再自动上浮。
 * 见 `docs/conversation-list-ux-plan.md` §3.4「方案 A：拖拽即固化」。
 */
const sortMode = ref<ConvSortMode>("recent");
/** 会话列表容器引用：拖拽到上下边缘时自动滚动。 */
const convListEl = ref<HTMLElement | null>(null);
/** 正在被拖拽的会话 id（非空 = 拖拽中）。 */
const draggingId = ref("");
/** 拖拽落点：目标会话 id + 落在其上/下半区（决定插入到前还是后）。 */
const dropTarget = ref<{ id: string; after: boolean } | null>(null);
/** 自动滚动步长 / 触发边距。 */
const DRAG_SCROLL_STEP = 12;
const DRAG_SCROLL_EDGE = 24;
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

/** 输入内容变化（含切换对话）时让输入框自动长高。必须放在 current 声明之后，避免 setup 期 TDZ。 */
watch(() => current.value.input, () => autoGrow());

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
      text: m.role === "assistant" ? dedupeRepeats(m.text || "") : (m.text || ""),
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
  // 直接前插会让新对话跑到置顶区之上：按统一排序规则归位（新对话在普通区最上）。
  resortConversations();
  // 手动排序模式下，新对话没有 sortOrder 会沉到普通区底部：显式把它排到普通区最前。
  if (sortMode.value === "manual") {
    const firstRegular = conversations.value.find((c) => !c.pinnedAt && c.id !== conv.id);
    if (firstRegular) void applyConversationOrder(conv.id, firstRegular.id, false);
  }
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

/** 手动顺序步长（须与服务端 `ORDER_STEP` 一致）：相邻项间隔，便于中间插入。 */
const CONV_ORDER_STEP = 1000;

/**
 * 排序规则：
 * ① 置顶组永远在普通组之上；
 * ② 组内：`manual` 模式先按手动顺序（没排过的沉到最后），否则按默认序；
 * ③ 默认序：置顶组按置顶时间（新的在上），普通组按最近活动。
 */
function convRank(a: ConversationDto, b: ConversationDto): number {
  const ap = a.pinnedAt ? 1 : 0;
  const bp = b.pinnedAt ? 1 : 0;
  if (ap !== bp) return bp - ap;
  if (sortMode.value === "manual") {
    const ao = a.sortOrder ?? Number.POSITIVE_INFINITY;
    const bo = b.sortOrder ?? Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
  }
  if (ap && bp) return (b.pinnedAt || 0) - (a.pinnedAt || 0);
  return b.updatedAt - a.updatedAt;
}

/** 本地按同一套规则重排：乐观更新后立刻反映到侧栏，不等服务端回包。 */
function resortConversations() {
  conversations.value = [...conversations.value].sort(convRank);
}

/**
 * 把 `fromId` 移动到 `targetId` 前 / 后，并按新顺序整体固化（拖拽与 `Alt+↑/↓` 共用）。
 *
 * 「拖拽即固化」（方案 A）：首次移动即切到 `manual` 模式并写入全部顺序——所见即所得，
 * 不会出现「拖完再发条消息就弹回去」。
 * `pinOverride`：跨区拖拽时顺带改置顶（`null` = 取消置顶，`undefined` = 不动）。
 */
async function applyConversationOrder(
  fromId: string,
  targetId: string,
  after: boolean,
  pinOverride?: number | null,
) {
  if (fromId === targetId) return;
  const prevOrder = conversations.value;
  const prevMode = sortMode.value;
  const moved = prevOrder.find((c) => c.id === fromId);
  if (!moved) return;
  const nextList = prevOrder.filter((c) => c.id !== fromId);
  const anchor = nextList.findIndex((c) => c.id === targetId);
  if (anchor < 0) return;
  const movedNext: ConversationDto = pinOverride === undefined ? moved : { ...moved, pinnedAt: pinOverride };
  nextList.splice(after ? anchor + 1 : anchor, 0, movedNext);

  // 乐观更新：切手动模式 + 按下标写本地 sortOrder（下标即新顺序，与服务端分配规则一致）。
  sortMode.value = "manual";
  conversations.value = nextList.map((c, i) => ({ ...c, sortOrder: i * CONV_ORDER_STEP }));
  resortConversations();

  try {
    if (pinOverride !== undefined) await patchConversation(fromId, { pinnedAt: pinOverride });
    await reorderConversations(conversations.value.map((c) => c.id));
    if (prevMode !== "manual") void saveChatPreferences({ convSortMode: "manual" }).catch(() => undefined);
  } catch (err) {
    // 失败时可能是「置顶已生效、顺序没落库」：以服务端为准重新拉一次，避免本地与后端分叉。
    sortMode.value = prevMode;
    conversations.value = await fetchConversations().catch(() => prevOrder);
    resortConversations();
    showSettingsError(
      localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("排序失败", "Reorder failed")),
    );
  }
}

/** 退出手动排序：普通区恢复「最近活动」自动上浮（手动顺序留在库里，下次拖拽会重新固化）。 */
function restoreRecentSort() {
  closeCtxMenu();
  sortMode.value = "recent";
  resortConversations();
  void saveChatPreferences({ convSortMode: "recent" }).catch(() => undefined);
}

// ---- 拖拽排序 ----

/** 拖拽开始：记录被拖会话。重命名编辑中不允许拖拽（否则输入框没法选中文字）。 */
function onConvDragStart(e: DragEvent, conv: ConversationDto) {
  if (renaming.value.id) {
    e.preventDefault();
    return;
  }
  draggingId.value = conv.id;
  dropTarget.value = null;
  e.dataTransfer?.setData("text/plain", conv.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}

/** 拖拽经过：按指针落在目标项的上/下半区决定插入位置，并在贴近容器边缘时自动滚动。 */
function onConvDragOver(e: DragEvent, conv: ConversationDto) {
  if (!draggingId.value || draggingId.value === conv.id) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  dropTarget.value = { id: conv.id, after: e.clientY > rect.top + rect.height / 2 };
  const list = convListEl.value;
  if (!list) return;
  const listRect = list.getBoundingClientRect();
  if (e.clientY < listRect.top + DRAG_SCROLL_EDGE) list.scrollTop -= DRAG_SCROLL_STEP;
  else if (e.clientY > listRect.bottom - DRAG_SCROLL_EDGE) list.scrollTop += DRAG_SCROLL_STEP;
}

/** 拖拽结束（无论是否落点成功）：清空拖拽态。 */
function onConvDragEnd() {
  draggingId.value = "";
  dropTarget.value = null;
}

/** 放置：移动到落点；跨区拖拽顺带置顶 / 取消置顶。 */
function onConvDrop(e: DragEvent) {
  e.preventDefault();
  const fromId = draggingId.value;
  const target = dropTarget.value;
  draggingId.value = "";
  dropTarget.value = null;
  if (!fromId || !target || fromId === target.id) return;
  const moved = conversations.value.find((c) => c.id === fromId);
  const anchor = conversations.value.find((c) => c.id === target.id);
  if (!moved || !anchor) return;
  // 拖进置顶区 = 置顶，拖出置顶区 = 取消置顶。
  const crossGroup = !!moved.pinnedAt !== !!anchor.pinnedAt;
  const pinOverride: number | null | undefined = crossGroup ? (moved.pinnedAt ? null : Date.now()) : undefined;
  void applyConversationOrder(fromId, target.id, target.after, pinOverride);
}

// ---- 键盘（拖拽的等价路径）----

/** `Alt+↑/↓`：在所在组内上移 / 下移一位。 */
async function moveConversation(conv: ConversationDto, delta: number) {
  const group = conversations.value.filter((c) => !!c.pinnedAt === !!conv.pinnedAt);
  const index = group.findIndex((c) => c.id === conv.id);
  const swap = group[index + delta];
  if (!swap) return;
  await applyConversationOrder(conv.id, swap.id, delta > 0);
  // 元素被 Vue 移到新位置后保住焦点，键盘用户不迷路。
  await nextTick();
  document.querySelector<HTMLElement>(`.conv-item[data-conv-id="${conv.id}"]`)?.focus();
}

/** 会话项键盘：Enter/Space 选中、↑/↓ 移动焦点、`Alt+↑/↓` 调序、F2 重命名。 */
function onConvKeydown(e: KeyboardEvent, conv: ConversationDto) {
  if (e.key === "F2") {
    e.preventDefault();
    void startRename(conv);
    return;
  }
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    void moveConversation(conv, e.key === "ArrowUp" ? -1 : 1);
    return;
  }
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    const items = Array.from(document.querySelectorAll<HTMLElement>(".conv-item"));
    const index = items.indexOf(e.currentTarget as HTMLElement);
    items[index + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
    return;
  }
  // Enter/Space 落在内层的 ⋯/× 按钮或重命名输入框上时，交给它们自己处理（否则会既开菜单又切对话）。
  if (e.key === "Enter" || e.key === " ") {
    const target = e.target as HTMLElement;
    if (target !== e.currentTarget && target.closest("button, input, textarea")) return;
    e.preventDefault();
    selectConversation(conv);
  }
}

/** 置顶项数量：模板据此在最后一置顶项后插入分隔线。 */
const pinnedCount = computed(() => conversations.value.filter((c) => c.pinnedAt).length);

/** 菜单当前指向的会话（模板渲染菜单项状态用）。 */
const ctxTarget = computed(() => conversations.value.find((c) => c.id === ctxMenu.value.targetId) || null);

// ---- 删除（带撤销窗口）----

/**
 * 删除会话：**先本地消失、服务端延迟落库**，窗口内可撤销（对齐 Gmail / Notion 的 undo 模式）。
 * 流的中断与运行时状态清理不可恢复，撤销只还原列表项本身。
 */
async function removeConversation(id: string) {
  closeCtxMenu();
  const index = conversations.value.findIndex((c) => c.id === id);
  const conv = conversations.value[index];
  if (!conv) return;
  const wasCurrent = currentId.value === id;
  // 只中断这个对话自己的流，其它对话不受影响。
  states.get(id)?.controller?.abort();
  states.delete(id);
  conversations.value = conversations.value.filter((c) => c.id !== id);
  scheduleUndoDelete(conv, index, wasCurrent);
  if (wasCurrent) {
    const next = conversations.value[0];
    if (next) selectConversation(next);
    else await newConversation();
  }
}

/** 把上一笔待删会话真正落库（新删除到来 / 撤销窗口结束 / 离开页面时调用），避免删除被无限推迟。 */
function flushPendingDelete() {
  if (undoDeleteTimer) {
    clearTimeout(undoDeleteTimer);
    undoDeleteTimer = null;
  }
  const pending = undoDelete.value;
  undoDelete.value = null;
  if (pending) void apiDeleteConversation(pending.conv.id).catch(() => undefined);
}

/** 登记一笔待删会话并启动撤销倒计时。 */
function scheduleUndoDelete(conv: ConversationDto, index: number, wasCurrent: boolean) {
  flushPendingDelete();
  undoDelete.value = { conv, index, wasCurrent };
  undoDeleteTimer = setTimeout(() => {
    undoDeleteTimer = null;
    const pending = undoDelete.value;
    undoDelete.value = null;
    if (pending) void apiDeleteConversation(pending.conv.id).catch(() => undefined);
  }, UNDO_DELETE_MS);
}

/** 撤销最近一次删除：放回原位置（服务端尚未删除，无需重建）。 */
function undoRemoveConversation() {
  if (undoDeleteTimer) {
    clearTimeout(undoDeleteTimer);
    undoDeleteTimer = null;
  }
  const pending = undoDelete.value;
  undoDelete.value = null;
  if (!pending) return;
  const next = [...conversations.value];
  next.splice(Math.max(0, Math.min(pending.index, next.length)), 0, pending.conv);
  conversations.value = next;
  resortConversations();
  if (pending.wasCurrent) selectConversation(pending.conv);
}

// ---- 上下文菜单 ----

/** 打开会话上下文菜单（右键触发），按菜单实际尺寸做视口边界翻转，避免被屏幕边缘裁切。 */
async function openCtxMenu(e: MouseEvent, conv: ConversationDto) {
  e.preventDefault();
  e.stopPropagation();
  ctxTriggerEl = (e.currentTarget as HTMLElement | null) || null;
  // 键盘触发（Shift+F10 / 菜单键）时 clientX/Y 为 0，直接用会把菜单甩到屏幕左上角：退回到该项定位。
  const itemRect = ctxTriggerEl?.getBoundingClientRect();
  const keyboardTriggered = !e.clientX && !e.clientY && !!itemRect;
  const anchorX = keyboardTriggered && itemRect ? itemRect.left + 12 : e.clientX;
  const anchorY = keyboardTriggered && itemRect ? itemRect.bottom : e.clientY;
  ctxMenu.value = { open: true, x: anchorX, y: anchorY, targetId: conv.id };
  await nextTick();
  const el = ctxMenuEl.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const pad = 8;
  let { x, y } = ctxMenu.value;
  if (x + rect.width + pad > window.innerWidth) x = Math.max(pad, anchorX - rect.width);
  if (y + rect.height + pad > window.innerHeight) y = Math.max(pad, anchorY - rect.height);
  ctxMenu.value = { ...ctxMenu.value, x, y };
  // WAI-ARIA menu pattern：打开即把焦点移入首个菜单项。
  el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
}

/** 关闭上下文菜单；restoreFocus 用于键盘路径（Esc）把焦点还给触发元素。 */
function closeCtxMenu(restoreFocus = false) {
  if (!ctxMenu.value.open) return;
  ctxMenu.value = { ...ctxMenu.value, open: false };
  if (restoreFocus) ctxTriggerEl?.focus();
  ctxTriggerEl = null;
}

/** 菜单键盘导航：↑/↓ 循环、Home/End、Tab 关闭。Esc 走全局监听（保证焦点在外时也生效）。 */
function onCtxMenuKeydown(e: KeyboardEvent) {
  const el = ctxMenuEl.value;
  if (!el) return;
  if (e.key === "Tab") {
    closeCtxMenu();
    return;
  }
  const items = Array.from(el.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  if (!items.length) return;
  const idx = items.indexOf(document.activeElement as HTMLElement);
  let next = -1;
  if (e.key === "ArrowDown") next = idx < 0 ? 0 : (idx + 1) % items.length;
  else if (e.key === "ArrowUp") next = idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = items.length - 1;
  if (next >= 0) {
    e.preventDefault();
    items[next]?.focus();
  }
}

/** 菜单收起时机：Esc（归还焦点）、任意滚动（scroll 不冒泡，用捕获阶段）、窗口尺寸变化。 */
function onCtxEscape(e: KeyboardEvent) {
  if (!ctxMenu.value.open) return;
  if (e.key === "Escape") closeCtxMenu(true);
  // 菜单项上标注的快捷键：菜单开着时按 F2 直接进入重命名。
  else if (e.key === "F2") {
    const target = ctxTarget.value;
    if (target) void startRename(target);
  }
}

function onCtxDismiss() {
  if (ctxMenu.value.open) closeCtxMenu();
}

// ---- 重命名 ----

/**
 * 重命名输入框的函数式 ref：模板里在 `v-for` 内部用字符串 ref 会被收集成数组，
 * 只有函数 ref 能稳定拿到那个唯一在渲染的 input 元素。
 */
function setRenameInput(el: Element | ComponentPublicInstance | null) {
  renameInputEl.value = el instanceof HTMLInputElement ? el : null;
}

/** 就地重命名：标题变输入框，自动聚焦并全选（便于直接覆盖）。 */
async function startRename(conv: ConversationDto) {
  closeCtxMenu();
  renaming.value = { id: conv.id, value: conv.title || "" };
  await nextTick();
  renameInputEl.value?.focus();
  renameInputEl.value?.select();
}

/** 取消重命名，恢复原标题。 */
function cancelRename() {
  renaming.value = { id: "", value: "" };
}

/** 提交重命名：乐观更新 → PATCH → 失败回滚提示。空值 / 未改动直接放弃。 */
async function commitRename() {
  const id = renaming.value.id;
  if (!id) return;
  const raw = renaming.value.value.trim();
  renaming.value = { id: "", value: "" };
  const prev = conversations.value.find((c) => c.id === id)?.title || "";
  const next = raw.slice(0, RENAME_MAX);
  if (!next || next === prev) return;
  syncConvLocal(id, { title: next });
  try {
    await patchConversation(id, { title: next });
  } catch (err) {
    syncConvLocal(id, { title: prev });
    showSettingsError(
      localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("重命名失败", "Rename failed")),
    );
  }
}

/** 重命名输入框按键：Enter 提交、Esc 取消。中文输入法组合态的 Enter 是「选词」，不能当作提交。 */
function onRenameKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    void commitRename();
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancelRename();
  }
}

// ---- 置顶 ----

/** 置顶 / 取消置顶：乐观更新 + 本地重排，失败回滚。 */
async function togglePin(conv: ConversationDto) {
  closeCtxMenu();
  const prev = conv.pinnedAt ?? null;
  const next = prev ? null : Date.now();
  syncConvLocal(conv.id, { pinnedAt: next });
  resortConversations();
  try {
    await patchConversation(conv.id, { pinnedAt: next });
  } catch (err) {
    syncConvLocal(conv.id, { pinnedAt: prev });
    resortConversations();
    showSettingsError(
      localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("置顶失败", "Pin failed")),
    );
  }
}

// ---- 清空指定会话 ----

/** 清空某一会话（菜单里对非当前会话也能操作）：重置 UI 快照 + 服务端上下文。 */
async function clearConversationById(id: string) {
  closeCtxMenu();
  const state = states.get(id);
  if (state?.sending) {
    showSettingsError(tx("生成中，请先停止", "Still generating — stop it first"));
    return;
  }
  if (state) {
    state.bubbles = [];
    state.error = "";
  }
  await Promise.all([
    clearConversation(id).catch(() => undefined),
    clearConversationContext(id).catch(() => undefined),
  ]);
}

/**
 * 关闭其它对话（保留右键点击的那一个）：中断各自的流、清本地状态、服务端删除，
 * 并把保留项设为当前对话。复制 removeConversation 的清理语义，批量处理。
 */
async function closeOtherConversations(keepId: string) {
  // 撤销窗口里那一条也在被关闭之列：先落实删除并清掉撤销条，避免留下「撤销一个已删会话」的悬空状态。
  flushPendingDelete();
  const others = conversations.value.filter((c) => c.id !== keepId);
  for (const c of others) {
    states.get(c.id)?.controller?.abort();
    states.delete(c.id);
    try {
      if (c.id) await apiDeleteConversation(c.id);
    } catch {
      /* ignore */
    }
  }
  conversations.value = conversations.value.filter((c) => c.id === keepId);
  if (currentId.value !== keepId) {
    const keep = conversations.value[0];
    if (keep) selectConversation(keep);
  }
  closeCtxMenu();
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
          // 只读查询（如 BI 的 SELECT）自动确认，不弹确认卡，避免每次查数都点一下。
          const argsObj = tryParseJson(event.args || "{}");
          const sql = (argsObj.query ?? argsObj.sql ?? "");
          if (typeof sql === "string" && sql && isReadOnlyQuery(sql)) {
            const step = (reply.steps || []).find((s) => s.id === event.id);
            if (step) {
              step.status = "ok";
              step.result = (step.result ? `${step.result}\n` : "") + tx("（只读查询，已自动确认）", "(read-only query, auto-approved)");
            }
            void confirmToolCall(event.id, true).catch(() => undefined);
          } else {
            reply.pending = { id: event.id, name: event.name, args: event.args, reason: event.reason };
          }
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
          // 收束时清理模型回声式重复（只改内存展示，不改落库文本）。
          reply.text = dedupeRepeats(reply.text);
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

/** 轻量 JSON 解析（前端用，不依赖服务端工具）。 */
function tryParseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 只读查询判定（保守口径）：只放行 SELECT / SHOW / DESCRIBE / EXPLAIN / PRAGMA / CTE(SELECT) 起头、
 * 且不含任何写操作的单语句。多语句直接判为非只读。用于「查询型工具自动确认，写操作仍弹卡」。
 */
function isReadOnlyQuery(sql: string): boolean {
  if (!sql) return false;
  const s = sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .replace(/#[^\n]*/g, "")
    .trim();
  if (!s) return false;
  // 多语句（除尾随分号外还有分号）→ 保守视为非只读。
  if (s.slice(0, -1).includes(";")) return false;
  const first = s.split(/\s+/)[0]?.toUpperCase();
  const okStart =
    first === "SELECT" ||
    first === "SHOW" ||
    first === "DESCRIBE" ||
    first === "DESC" ||
    first === "EXPLAIN" ||
    first === "PRAGMA" ||
    first === "WITH";
  if (!okStart) return false;
  return !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|MERGE|REPLACE|GRANT|REVOKE|ATTACH|DETACH)\b/i.test(s);
}

/**
 * 防御性展示去重：模型偶发把同一段文本原样重复多遍（回声 / 重复循环），两种形态都要兜住：
 *  1) 整段回答被原样重复 2~N 次（全文 = 某单元的整数倍）；
 *  2) 段中某句话/某段被连续重复（如「找到关键表了…结构。」连发 4 遍，前后还夹着别的文字）。
 * 只折叠「连续、原样、完全一致」的重复块（最短 12 字，避免误伤正常列表/强调）。
 * 只作用于渲染层：在收束 / 载入时各算一次，不在流式进行中反复跑（省开销）。
 */
function dedupeRepeats(text: string): string {
  const MIN = 12;
  let s = text;
  // 多轮折叠，处理「折叠后与新内容又构成重复」的边界情况。
  for (let guard = 0; guard < 6; guard++) {
    const n = s.length;
    let replaced = false;
    // 重复块长度从大到小试：优先折叠最长（最像整段回声）的重复单元。
    for (let L = Math.min(n >> 1, 600); L >= MIN && !replaced; L--) {
      let i = 0;
      while (i + 2 * L <= n) {
        const block = s.slice(i, i + L);
        if (s.slice(i + L, i + 2 * L) === block) {
          // 统计从 i 起连续相同的块数（含第一份）。
          let count = 2;
          while (i + count * L <= n && s.slice(i + (count - 1) * L, i + count * L) === block) count++;
          if (count >= 2) {
            s = s.slice(0, i) + block + s.slice(i + count * L);
            replaced = true;
            break;
          }
        }
        i++;
      }
    }
    if (!replaced) break;
  }
  return s;
}

/** 复制气泡文本（assistant 复制原始 markdown，user 复制纯文本），带瞬时反馈。 */
const copyToast = ref("");
let copyToastTimer: ReturnType<typeof setTimeout> | null = null;
async function copyBubble(b: Bubble) {
  try {
    await navigator.clipboard.writeText(b.text);
    copyToast.value = tx("已复制", "Copied");
  } catch {
    copyToast.value = tx("复制失败", "Copy failed");
  }
  if (copyToastTimer) clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => (copyToast.value = ""), 1600);
}

/** 编辑用户气泡：把原文拿回输入框（对齐队列编辑的体验），聚焦等待再发。 */
function editUserBubble(b: Bubble) {
  const state = current.value;
  state.input = b.text;
  void nextTick(() => autoGrow());
  inputEl.value?.focus();
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
  window.addEventListener("keydown", onCtxEscape);
  // scroll 不冒泡：用捕获阶段才能收到 .conv-list 自身的滚动。
  window.addEventListener("scroll", onCtxDismiss, true);
  window.addEventListener("resize", onCtxDismiss);

  // 设备态偏好（主题 / 默认语言 / 上次打开的对话）以后端为唯一真相；顺带跑一次性迁移。
  const prefs = await fetchChatPreferences().catch(() => null);
  if (prefs) {
    if (isUiLocale(prefs.locale)) deviceLocale.value = prefs.locale;
    adoptTheme(prefs.theme);
    sortMode.value = prefs.convSortMode;
    initialConversationId = prefs.activeConversationId;
    await migrateLocalPrefs(prefs);
  }

  const list = await fetchConversations().catch(() => [] as ConversationDto[]);
  conversations.value = list;
  // 服务端给的是一份稳定默认序；「按最近活动」模式下要忽略 sortOrder 复算一次。
  resortConversations();
  const target = list.find((c) => c.id === initialConversationId) || list[0];
  if (target) selectConversation(target);
  else await newConversation();
});

onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onOutsideMcp);
  window.removeEventListener("keydown", onCtxEscape);
  window.removeEventListener("scroll", onCtxDismiss, true);
  window.removeEventListener("resize", onCtxDismiss);
  // 离开页面时把还没到点的删除落实，避免撤销窗口内的删除被永久搁置。
  flushPendingDelete();
});
</script>

<template>
  <div class="chat" @click="closeCtxMenu()">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand__name">{{ tx("小助手", "Assistant") }}</span>
      </div>
      <nav class="nav" :aria-label="tx('主导航', 'Primary')">
        <button
          type="button"
          class="nav-seg"
          :class="{ active: view === 'chat' }"
          :aria-current="view === 'chat' ? 'page' : undefined"
          @click="view = 'chat'"
        >{{ tx("对话", "Chats") }}</button>
        <button
          type="button"
          class="nav-seg"
          :class="{ active: view === 'tasks' }"
          :aria-current="view === 'tasks' ? 'page' : undefined"
          @click="view = 'tasks'"
        >{{ tx("定时任务", "Scheduled") }}</button>
      </nav>
      <template v-if="view === 'chat'">
      <button class="new-chat" type="button" @click="newConversation">
        + {{ tx("新对话", "New chat") }}
      </button>
      <div ref="convListEl" class="conv-list">
        <template v-for="(conv, i) in conversations" :key="conv.id">
          <div v-if="pinnedCount > 0 && i === pinnedCount" class="conv-divider" role="separator">
            {{ tx("置顶", "Pinned") }}
          </div>
          <div
            class="conv-item"
            :class="{
              active: conv.id === currentId,
              pinned: !!conv.pinnedAt,
              dragging: draggingId === conv.id,
              'drop-before': dropTarget?.id === conv.id && !dropTarget?.after,
              'drop-after': dropTarget?.id === conv.id && !!dropTarget?.after,
            }"
            :data-conv-id="conv.id"
            role="button"
            tabindex="0"
            :aria-current="conv.id === currentId ? 'true' : undefined"
            aria-haspopup="menu"
            :draggable="renaming.id !== conv.id"
            @click="selectConversation(conv)"
            @contextmenu.prevent="openCtxMenu($event, conv)"
            @keydown="onConvKeydown($event, conv)"
            @dragstart="onConvDragStart($event, conv)"
            @dragover="onConvDragOver($event, conv)"
            @drop="onConvDrop"
            @dragend="onConvDragEnd"
          >
            <span
              v-if="convStatus(conv)"
              class="conv-dot"
              :class="convStatus(conv)"
              :title="convStatusText(convStatus(conv))"
              :aria-label="convStatusText(convStatus(conv))"
              role="img"
            ></span>
            <input
              v-if="renaming.id === conv.id"
              :ref="setRenameInput"
              v-model="renaming.value"
              class="conv-rename"
              type="text"
              :maxlength="RENAME_MAX"
              :aria-label="tx('重命名对话', 'Rename chat')"
              @keydown="onRenameKeydown"
              @blur="commitRename"
              @click.stop
            />
            <template v-else>
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
            </template>
          </div>
        </template>
      </div>
      <button class="ghost-btn" type="button" @click="clearCurrent">
        {{ tx("清空当前对话", "Clear current chat") }}
      </button>
      </template>
      <template v-else>
        <div class="tasks">
          <div class="tasks-head">
            <button class="primary-btn" type="button" @click="openTaskForm">
              + {{ tx("新建定时任务", "New scheduled task") }}
            </button>
          </div>
          <div v-if="!tasks.length" class="tasks-empty">
            <span class="tasks-empty__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7.5V12l3.2 1.9" />
              </svg>
            </span>
            <div class="tasks-empty__title">{{ tx("还没有定时任务", "No scheduled tasks yet") }}</div>
            <p class="tasks-empty__desc">{{ tx("点击「新建定时任务」创建第一个：把周期性的查询、监控与报告交给智能体自动执行。", "Click “New scheduled task” to create your first — schedule recurring queries, monitors and reports to run automatically.") }}</p>
          </div>
          <div v-else class="task-list">
            <div v-for="t in tasks" :key="t.id" class="task-card">
              <div class="task-card__main">
                <div class="task-card__title">{{ t.name }}</div>
                <div class="task-card__prompt">{{ t.prompt }}</div>
                <div class="task-card__meta">
                  <span class="task-badge" :class="t.scheduleType">{{ t.scheduleType === 'once' ? tx('一次性', 'Once') : tx('周期', 'Recurring') }}</span>
                  <span class="task-next">{{ taskNextRunText(t) }}</span>
                </div>
              </div>
              <div class="task-card__ops">
                <button
                  class="task-toggle"
                  type="button"
                  :class="{ on: t.status === 'active' }"
                  role="switch"
                  :aria-checked="t.status === 'active'"
                  :title="t.status === 'active' ? tx('暂停', 'Pause') : tx('启用', 'Enable')"
                  @click="toggleTask(t.id)"
                ><span class="task-toggle__knob"></span></button>
                <button class="task-del" type="button" :title="tx('删除', 'Delete')" @click="removeTask(t.id)">×</button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </aside>
    <Teleport to="body">
      <div
        v-if="ctxMenu.open"
        ref="ctxMenuEl"
        class="ctx-menu"
        role="menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @click.stop
        @contextmenu.prevent
        @keydown="onCtxMenuKeydown"
      >
        <button type="button" class="ctx-item" role="menuitem" @click="ctxTarget && startRename(ctxTarget)">
          <span>{{ tx("重命名", "Rename") }}</span>
          <kbd class="ctx-kbd">F2</kbd>
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="ctxTarget && togglePin(ctxTarget)">
          {{ ctxTarget?.pinnedAt ? tx("取消置顶", "Unpin") : tx("置顶", "Pin") }}
        </button>
        <button
          v-if="sortMode === 'manual'"
          type="button"
          class="ctx-item"
          role="menuitem"
          @click="restoreRecentSort"
        >
          {{ tx("恢复自动排序", "Sort by recent") }}
        </button>
        <div class="ctx-sep" role="separator"></div>
        <button type="button" class="ctx-item" role="menuitem" @click="clearConversationById(ctxMenu.targetId)">
          {{ tx("清空对话", "Clear chat") }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="closeOtherConversations(ctxMenu.targetId)">
          {{ tx("关闭其它对话", "Close other chats") }}
        </button>
        <div class="ctx-sep" role="separator"></div>
        <button type="button" class="ctx-item danger" role="menuitem" @click="removeConversation(ctxMenu.targetId)">
          {{ tx("删除对话", "Delete chat") }}
        </button>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="undoDelete" class="undo-toast" role="status" aria-live="polite">
        <span class="undo-toast__text">{{ tx("已删除对话", "Chat deleted") }}</span>
        <button type="button" class="undo-toast__undo" @click="undoRemoveConversation">
          {{ tx("撤销", "Undo") }}
        </button>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="showTaskForm" class="modal-mask" @click.self="closeTaskForm">
        <div class="modal" role="dialog" aria-modal="true" :aria-label="tx('新建定时任务', 'New scheduled task')">
          <div class="modal__head">
            <span class="modal__title">{{ tx("新建定时任务", "New scheduled task") }}</span>
            <button class="modal__close" type="button" aria-label="Close" @click="closeTaskForm">×</button>
          </div>
          <div class="modal__body">
            <label class="field">
              <span class="field__label">{{ tx("名称", "Name") }}</span>
              <input class="field__input" v-model="taskDraft.name" :placeholder="tx('例如：每日流量日报', 'e.g. Daily traffic report')" />
            </label>
            <label class="field">
              <span class="field__label">{{ tx("任务内容", "Task prompt") }}</span>
              <textarea class="field__input field__textarea" v-model="taskDraft.prompt" rows="3" :placeholder="tx('智能体要自动执行的自然语言指令…', 'Natural-language instruction for the agent…')"></textarea>
            </label>
            <div class="field">
              <span class="field__label">{{ tx("频率", "Schedule") }}</span>
              <div class="seg">
                <button type="button" class="seg__btn" :class="{ active: taskDraft.scheduleType === 'recurring' }" @click="taskDraft.scheduleType = 'recurring'">{{ tx("周期", "Recurring") }}</button>
                <button type="button" class="seg__btn" :class="{ active: taskDraft.scheduleType === 'once' }" @click="taskDraft.scheduleType = 'once'">{{ tx("一次性", "Once") }}</button>
              </div>
            </div>
            <label v-if="taskDraft.scheduleType === 'recurring'" class="field">
              <span class="field__label">{{ tx("重复规则 (RRULE)", "Repeat rule (RRULE)") }}</span>
              <input class="field__input" v-model="taskDraft.rrule" placeholder="FREQ=DAILY;INTERVAL=1" />
            </label>
            <label v-else class="field">
              <span class="field__label">{{ tx("执行时间", "Run at") }}</span>
              <input class="field__input" type="datetime-local" v-model="taskDraft.scheduledAt" />
            </label>
            <p v-if="taskError" class="field__error">{{ taskError }}</p>
          </div>
          <div class="modal__foot">
            <button class="ghost-btn" type="button" @click="closeTaskForm">{{ tx("取消", "Cancel") }}</button>
            <button class="primary-btn" type="button" @click="createTask">{{ tx("创建", "Create") }}</button>
          </div>
        </div>
      </div>
    </Teleport>

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
                        <span class="mcp-status" :class="s.connected ? 'ok' : s.error ? 'err' : s.connecting ? 'running' : 'idle'">
                          <span class="mcp-dot" :class="s.connected ? 'ok' : s.error ? 'err' : s.connecting ? 'running' : 'idle'"></span>
                          {{
                            s.connected
                              ? tx("已连接", "connected")
                              : s.connecting
                                ? tx("连接中", "connecting")
                                : s.error
                                  ? tx("失败", "failed")
                                  : tx("未连接", "not connected")
                          }}
                        </span>
                        <span class="mcp-row__sub">{{ s.transport }} · {{ s.tools }} {{ tx("工具", "tools") }}</span>
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
          <div class="bubble-wrap">
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
          <div class="bubble-actions">
            <button
              v-if="b.role === 'user'"
              type="button"
              class="bubble-act"
              :title="tx('编辑', 'Edit')"
              :aria-label="tx('编辑', 'Edit')"
              @click="editUserBubble(b)"
            >✎</button>
            <button
              type="button"
              class="bubble-act"
              :title="tx('复制', 'Copy')"
              :aria-label="tx('复制', 'Copy')"
              @click="copyBubble(b)"
            >⧉</button>
          </div>
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
      <transition name="fade">
        <div v-if="copyToast" class="copy-toast" role="status">{{ copyToast }}</div>
      </transition>
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
  width: 256px;
  flex: 0 0 256px;
  border-right: 1px solid var(--line);
  background: var(--panel);
  padding: 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.brand {
  display: flex;
  align-items: center;
  padding: 4px 6px 2px;
}

.brand__name {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

/* 主导航：分段控件，对话 / 定时任务 切换，为接入预留入口 */
.nav {
  display: flex;
  gap: 4px;
  padding: 4px;
  border-radius: var(--radius);
  background: var(--fill-soft);
}

.nav-seg {
  flex: 1;
  appearance: none;
  border: none;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  padding: 7px 8px;
  border-radius: calc(var(--radius) - 4px);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background 0.15s ease,
    box-shadow 0.15s ease;
}

.nav-seg:hover {
  color: var(--ink);
}

.nav-seg.active {
  background: var(--panel);
  color: var(--ink);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--ink) 14%, transparent);
}

.nav-seg:focus-visible {
  box-shadow: var(--ring);
}

/* 定时任务占位面板（为后续接入预留结构与入口） */
.tasks {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow-y: auto;
}

.tasks-empty {
  margin: auto;
  width: 100%;
  padding: 24px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 12px;
}

.tasks-empty__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: var(--fill-soft);
  color: var(--muted);
}

.tasks-empty__title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
}

.tasks-empty__desc {
  max-width: 260px;
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--muted);
}

.coming-soon {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--line);
  background: var(--panel);
  font-family: var(--font-body);
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
}

/* 定时任务：列表与卡片 */
.tasks-head {
  display: flex;
  padding-bottom: 2px;
}

.primary-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--line-strong);
  background: var(--ink);
  color: var(--bg);
  border-radius: var(--radius);
  padding: 9px 14px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  transition:
    transform 0.15s var(--ease),
    box-shadow 0.2s ease,
    opacity 0.2s ease;
}

.primary-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 18px color-mix(in srgb, var(--ink) 20%, transparent);
}

.primary-btn:active {
  transform: translateY(0);
  box-shadow: none;
}

.primary-btn:focus-visible {
  box-shadow: var(--ring);
}

.task-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 2px;
}

.task-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.task-card:hover {
  border-color: color-mix(in srgb, var(--ink) 26%, var(--line));
  box-shadow: 0 6px 16px color-mix(in srgb, var(--ink) 8%, transparent);
}

.task-card__main {
  flex: 1;
  min-width: 0;
}

.task-card__title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 3px;
}

.task-card__prompt {
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.task-card__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 11px;
  color: var(--muted);
}

.task-badge {
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--line);
  font-weight: 600;
}

.task-badge.once {
  color: color-mix(in srgb, #d99a1f 85%, var(--ink));
  border-color: color-mix(in srgb, #d99a1f 40%, var(--line));
  background: color-mix(in srgb, #d99a1f 12%, transparent);
}

.task-card__ops {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

.task-toggle {
  width: 38px;
  height: 22px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--fill-soft);
  position: relative;
  cursor: pointer;
  padding: 0;
  transition:
    background 0.18s ease,
    border-color 0.18s ease;
}

.task-toggle__knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--muted);
  transition:
    transform 0.18s var(--ease),
    background 0.18s ease;
}

.task-toggle.on {
  background: color-mix(in srgb, var(--stop) 80%, transparent);
  border-color: transparent;
}

.task-toggle.on .task-toggle__knob {
  transform: translateX(16px);
  background: #fff;
}

.task-toggle:focus-visible {
  box-shadow: var(--ring);
}

.task-del {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.5;
  transition:
    opacity 0.15s ease,
    color 0.15s ease,
    background 0.15s ease;
}

.task-del:hover,
.task-del:focus-visible {
  opacity: 1;
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

/* 弹窗：新建定时任务 */
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: color-mix(in srgb, var(--ink) 38%, transparent);
  backdrop-filter: blur(2px);
}

.modal {
  width: 100%;
  max-width: 460px;
  max-height: 90dvh;
  overflow: auto;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
}

.modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px;
  border-bottom: 1px solid var(--line);
}

.modal__title {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
}

.modal__close {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.modal__close:hover {
  background: var(--fill-soft);
  color: var(--ink);
}

.modal__body {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.modal__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 18px;
  border-top: 1px solid var(--line);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
}

.field__input {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 9px 11px;
  background: var(--fill);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.5;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.field__input:focus {
  outline: none;
  border-color: var(--ink);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ink) 14%, transparent);
}

.field__textarea {
  resize: vertical;
  min-height: 64px;
}

.field__error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}

.seg {
  display: flex;
  gap: 4px;
  padding: 4px;
  border-radius: var(--radius);
  background: var(--fill-soft);
}

.seg__btn {
  flex: 1;
  appearance: none;
  border: none;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  padding: 7px 8px;
  border-radius: calc(var(--radius) - 4px);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background 0.15s ease,
    box-shadow 0.15s ease;
}

.seg__btn:hover {
  color: var(--ink);
}

.seg__btn.active {
  background: var(--panel);
  color: var(--ink);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--ink) 14%, transparent);
}

.seg__btn:focus-visible {
  box-shadow: var(--ring);
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
  /* 拖拽落点指示线相对本项定位 */
  position: relative;
}

.conv-item:hover {
  background: var(--fill-soft);
}

/* 键盘可达（role=button + tabindex）：焦点必须可见。 */
.conv-item:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

/* 拖拽中的被拖项：半透明表示"正在搬动"。 */
.conv-item.dragging {
  opacity: 0.5;
}

/*
 * 落点指示线用伪元素而不是 box-shadow：`.conv-item.active` 已经占了 box-shadow（左侧选中条），
 * 两者叠加会互相覆盖。
 */
.conv-item.drop-before::before,
.conv-item.drop-after::after {
  content: "";
  position: absolute;
  left: 4px;
  right: 4px;
  height: 2px;
  border-radius: 2px;
  background: var(--ink);
  pointer-events: none;
}

.conv-item.drop-before::before {
  top: -3px;
}

.conv-item.drop-after::after {
  bottom: -3px;
}

.conv-item.active {
  background: var(--fill-soft);
  border: 1px solid var(--line);
  box-shadow: inset 2px 0 0 var(--ink);
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

/* 置顶区与普通区之间的分隔（只有两组都存在时才渲染）。 */
.conv-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px 2px;
  font-size: 11px;
  color: var(--muted);
  letter-spacing: 0.04em;
}

.conv-divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--line);
}

.conv-item.pinned .conv-title {
  font-weight: 600;
}

/* 就地重命名输入框：占满标题位，视觉上尽量贴近原文本。 */
.conv-rename {
  flex: 1;
  min-width: 0;
  font: inherit;
  color: var(--ink);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 3px 6px;
  outline: none;
}

.conv-rename:focus {
  border-color: color-mix(in srgb, var(--ink) 34%, var(--line));
  box-shadow: var(--ring);
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

/* 右键上下文菜单：Teleport 到 body，scoped 样式不生效，用 :global 命中。 */
:global(.ctx-menu) {
  position: fixed;
  z-index: 1000;
  min-width: 168px;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 10px;
  /* 面板色 token 是 --panel（styles.css）。曾误写 var(--surface)：变量不存在 → background 无效 → 菜单全透明。 */
  background: var(--panel);
  box-shadow: 0 10px 30px color-mix(in srgb, var(--ink) 22%, transparent);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

:global(.ctx-item) {
  appearance: none;
  border: none;
  background: transparent;
  text-align: left;
  font: inherit;
  font-size: 13px;
  color: var(--ink);
  padding: 7px 10px;
  border-radius: 7px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  white-space: nowrap;
}

:global(.ctx-item:hover),
:global(.ctx-item:focus-visible) {
  background: var(--fill-soft);
  outline: none;
}

/* 危险动作（删除）独立配色，与常用项拉开距离，降低误点。 */
:global(.ctx-item.danger) {
  color: var(--danger);
}

:global(.ctx-item.danger:hover),
:global(.ctx-item.danger:focus-visible) {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

:global(.ctx-kbd) {
  font: inherit;
  font-size: 11px;
  color: var(--muted);
}

:global(.ctx-sep) {
  height: 1px;
  margin: 4px 6px;
  background: var(--line);
}

/* 删除撤销条：Teleport 到 body，scoped 样式不生效，用 :global 命中。 */
:global(.undo-toast) {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  z-index: 1100;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
  color: var(--ink);
  font-size: 13px;
  box-shadow: 0 10px 30px color-mix(in srgb, var(--ink) 22%, transparent);
}

:global(.undo-toast__undo) {
  appearance: none;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  padding: 2px 8px;
  border-radius: 6px;
  cursor: pointer;
  text-decoration: underline;
}

:global(.undo-toast__undo:hover),
:global(.undo-toast__undo:focus-visible) {
  background: var(--fill-soft);
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
  width: 360px;
  max-width: calc(100vw - 32px);
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--line) 88%, var(--ink) 12%);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--panel) 92%, white 8%);
  box-shadow:
    0 16px 40px color-mix(in srgb, var(--ink) 14%, transparent),
    0 2px 10px color-mix(in srgb, var(--ink) 7%, transparent);
  backdrop-filter: blur(10px);
  color: var(--ink);
  font-size: 13px;
}

.mcp-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 2px 10px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--line);
}

.mcp-panel__head > span:first-child {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
}

.mcp-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
}

.mcp-empty {
  padding: 14px 4px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}

.mcp-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--fill);
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}

.mcp-row:hover {
  background: var(--fill-soft);
  border-color: color-mix(in srgb, var(--ink) 22%, var(--line));
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
  gap: 4px;
  min-width: 0;
}

.mcp-row__label {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcp-row__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
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

.mcp-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px 1px 7px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--line);
  background: var(--fill-soft);
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.5;
}

.mcp-status.ok {
  color: color-mix(in srgb, #2f9e63 82%, var(--ink));
  background: color-mix(in srgb, #2f9e63 14%, transparent);
  border-color: color-mix(in srgb, #2f9e63 32%, var(--line));
}

.mcp-status.err {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  border-color: color-mix(in srgb, var(--danger) 32%, var(--line));
}

.mcp-status.running {
  color: color-mix(in srgb, var(--stop) 85%, var(--ink));
  background: color-mix(in srgb, var(--stop) 14%, transparent);
  border-color: color-mix(in srgb, var(--stop) 32%, var(--line));
}

.mcp-row__sub {
  color: var(--muted);
  font-size: 11px;
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
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 7px;
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

.row.assistant {
  justify-content: flex-start;
}

/* 气泡 + 其下方操作栏绑成一组：宽度随气泡收缩，操作栏右对齐到气泡右侧，
   故按钮始终落在「气泡下方的右侧」，而非整屏最右。
   宽度上限放在这一层（.row 的直接子项），.bubble 用 100% 相对它，
   避免百分比 max-width 相对自身 width: fit-content 造成循环、把气泡压窄。 */
.bubble-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  max-width: min(760px, 92%);
  min-width: 0;
}

.bubble {
  position: relative;
  max-width: 100%;
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

.md :deep(.table-wrapper) {
  overflow-x: auto;
  margin: 0 0 8px;
}

/* 前端折叠块：内部工具轨迹 / 超长表格默认收起，点击展开 */
.md :deep(details.agent-tool-trace),
.md :deep(details.agent-long-table) {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--fill-soft);
  padding: 2px 10px;
  margin: 0 0 8px;
}
.md :deep(details.agent-tool-trace > summary),
.md :deep(details.agent-long-table > summary) {
  cursor: pointer;
  color: var(--muted);
  font-size: 13px;
  user-select: none;
  padding: 4px 0;
}
.md :deep(details.agent-tool-trace[open] > summary),
.md :deep(details.agent-long-table[open] > summary) {
  margin-bottom: 4px;
}

.md :deep(table) {
  border-collapse: collapse;
  width: 100%;
  min-width: max-content;
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

/* 气泡操作栏（编辑 / 复制）：置于气泡正下方、靠右，悬停整行时淡入。
   下方布局从根上杜绝遮挡，且借助 .bubble-wrap 的 align-items: flex-end
   始终对齐到「气泡本体的右下角」，不会因助手气泡不满宽而漂到整屏最右。 */
.bubble-actions {
  display: flex;
  gap: 2px;
  margin-top: 3px;
  opacity: 0;
  transition: opacity 0.15s ease;
  pointer-events: none;
}

.row:hover .bubble-actions,
.row:focus-within .bubble-actions {
  opacity: 1;
  pointer-events: auto;
}

/* 触屏无 hover：常驻可见，保证可点。 */
@media (hover: none) {
  .bubble-actions {
    opacity: 1;
    pointer-events: auto;
  }
}

.bubble-act {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  transition:
    color 0.15s ease,
    background 0.15s ease;
}

.bubble-act:hover,
.bubble-act:focus-visible {
  color: var(--ink);
  background: var(--fill-soft);
}

/* 复制成功瞬时提示：浮在输入区上方，不抢占滚动条。 */
.copy-toast {
  position: absolute;
  bottom: calc(100% - 8px);
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  box-shadow: var(--shadow);
  color: var(--ink);
  font-size: 12px;
  z-index: 40;
  pointer-events: none;
}

.fade-enter-active,
.fade-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translate(-50%, 4px);
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
