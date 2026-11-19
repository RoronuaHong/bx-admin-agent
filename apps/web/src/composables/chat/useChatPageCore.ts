
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  reactive,
  ref,
  watch,
  type ComponentPublicInstance,
} from "vue";
import { useRouter } from "vue-router";
import BackToTop from "../../components/BackToTop.vue";
import ConversationOutline from "../../components/ConversationOutline.vue";
import ModelSelect from "../../components/ModelSelect.vue";
import PromptBox from "../../components/PromptBox.vue";
import ToolsSearch from "../../components/ToolsSearch.vue";
import SkillAddForm from "../../components/SkillAddForm.vue";
import McpAddForm from "../../components/McpAddForm.vue";
import ThemeToggle from "../../components/ThemeToggle.vue";
import UiLocaleSelect from "../../components/UiLocaleSelect.vue";
import UiSelect from "../../components/UiSelect.vue";
import ChartCard from "../../components/ChartCard.vue";
import ChatBubble from "../../components/ChatBubble.vue";
import DoneToast from "../../components/chat/DoneToast.vue";
import ArtifactPreviewModal from "../../components/chat/ArtifactPreviewModal.vue";
import ConfirmDialog from "../../components/chat/ConfirmDialog.vue";
import ChatThread from "../../components/chat/ChatThread.vue";
import ContextMenuHost from "../../components/chat/ContextMenuHost.vue";
import ChatSidebarList from "../../components/chat/ChatSidebarList.vue";
import { bubbleContextKey, type BubbleContext } from "../../components/bubble-context";
import { renderChatMarkdown } from "../../chat-richtext";
import { applyStreamEvent, dedupeRepeats } from "../../chat-stream";
// 气泡相关共享类型以 chat-types.ts 为**单一来源**（原先在页面内各有一份重复定义，抽 ChatBubble 后需共享）。
// 不要在此再定义同名类型——重复定义会导致 provide/inject 两侧签名漂移（改一处漏两处即类型冲突）。
import type { StepStatus, SubagentStatus, ToolStep } from "../../chat-types";
import {
  MINUTELY_INTERVALS,
  REPEAT_FREQS,
  WEEKDAYS,
  buildCron as buildCronFromForm,
  parseCron,
  toLocalInput,
} from "../../schedule-cron";
import { useOnceAtPicker } from "../../use-once-at-picker";
import { alertMarkerInfo, bubbleBody, isStoppedBubble } from "../../bubble-text";
import {
  taskCardTip as taskCardTipOf,
  taskConvText as taskConvTextOf,
  taskDotClass as taskDotClassOf,
  taskHealthShort as taskHealthShortOf,
  taskKindText as taskKindTextOf,
  taskMarkerText as taskMarkerTextOf,
  taskNextRunText as taskNextRunTextOf,
  taskNextShort as taskNextShortOf,
  taskRightShort as taskRightShortOf,
  taskRunText as taskRunTextOf,
  taskStatusText as taskStatusTextOf,
  type TaskCardFacts,
} from "../../task-card-text";
import { matchesFuzzyScoped, matchesFuzzy, loadPinyin, pinyinReady } from "../../pinyin";
import { getUiLocale, detectDefaultLocale, isUiLocale, setUiLocale, type UiLocale } from "../../ui-locale";
import { showToolServer, toolDisplayName, visibleThinking } from "../../trace-labels";
import { localizeToken } from "../../localize";
import { AGENTS, agentText, findAgent, type AgentEntry } from "../../agents";
import { readStoredTheme, useTheme } from "../../theme";
import {
  cancelChatTask,
  clearConversation,
  clearConversationContext,
  confirmToolCall,
  createConversation,
  cancelSubagent as apiCancelSubagent,
  conversationExportUrl,
  NOT_MODEL_FAULT_CODES,
  createChatSchedule,
  deleteChatSchedule,
  runChatSchedule,
  restartChatSchedule,
  deleteConversation as apiDeleteConversation,
  deleteNotifyChannel,
  duplicateConversation,
  deleteCustomMcpServer,
  fetchChatMcpServers,
  fetchChatPreferences,
  fetchChatSkills,
  fetchChatTaskStatus,
  fetchConversation,
  fetchConversations,
  fetchModels,
  fetchMemory,
  fetchNotifyChannels,
  fetchSchedules,
  fetchWorkspaceFiles,
  getApiErrorToken,
  getApiErrorCode,
  addMemoryItem,
  readWorkspaceFile,
  workspaceDownloadUrl,
  removeMemoryItem,
  isChatTaskRunning,
  patchChatSchedule,
  patchConversation,
  enqueueConversationMessage,
  dequeueConversationMessage,
  reloadMcpServer,
  reorderConversations,
  resumeChatTaskEvents,
  saveChatPreferences,
  saveConversationMessages,
  saveNotifyChannel,
  setChatMcpServers,
  setChatSkills,
  streamChat,
  testNotifyChannel,
  uploadFiles,
  MODEL_AUTO_ID,
  type ChartSpec,
  type ChatPreferences,
  type ConversationDto,
  type ConvSortMode,
  type McpServerStatus,
  type MemoryItemDto,
  type ModelInfo,
  type NotifyChannelDto,
  type NotifyChannelKind,
  type PendingMessage,
  type ScheduleDto,
  type ScheduleInput,
  type ScheduleNotifyOn,
  type ScheduleNotifyPolicy,
  type SchedulePurpose,
  type SkillMeta,
  type StoredMessage,
  type UploadResult,
  type WorkspaceFile,
} from "../../api";
import { parseAlertMarker, type ArtifactSpec, type ChatEvent, type TodoItem } from "@bx/shared";
import { useChatPersistence } from "./useChatPersistence";
import { useChatModelSettings } from "./useChatModelSettings";
import { useChatThreadScroll } from "./useChatThreadScroll";
import { useChatReasoningUI } from "./useChatReasoningUI";
import { useChatConversationShell } from "./useChatConversationShell";
import { useChatToolPanels } from "./useChatToolPanels";
import type { Bubble, ConvSettings, ConvState } from "./chat-page-types";
import type { Router as ChatRouter } from "vue-router";

export function useChatPageCore(options: {
  agentProps: Readonly<{ agentId?: string; agentLabel?: string }>;
  router: ChatRouter;
}) {
  const { agentProps, router } = options;

/** 侧栏统一为对话列表：定时任务作为列表内可折叠分组（管理走右键菜单，新建走分组头 +），不再有独立 tab。 */

/* ===========================================================================
 * 定时任务（服务端持久化：/agent/chat/schedules，到点由服务端调度器执行）
 * 结果两处可见：① 回投到绑定的对话（打开就能看到）；② 勾了通知通道时推送到钉钉/飞书机器人。
 * 任务级 MCP 允许清单只能收窄对话的启用集（无人值守 Agent 的通行最小权限做法）。
 * =========================================================================== */
const tasks = ref<ScheduleDto[]>([]);
const tasksBusy = ref(false);
const showTaskForm = ref(false);
/** 主区「定时任务」页（对齐 CodeBuddy）：侧栏「定时任务」入口打开；列表 + 行内操作 + 展开各期运行。 */
const showTaskList = ref(false);
const taskError = ref("");
const taskDraft = reactive({
  name: "",
  prompt: "",
  scheduleType: "recurring" as "recurring" | "once",
  scheduledAt: "",
  /** 本任务允许使用的 MCP 服务器（空 = 不带任何 MCP 工具运行）。 */
  mcpServers: [] as string[],
  /** 本任务每期运行时勾选的技能（服务端按清单过滤后落到任务会话的 skillsEnabled）。 */
  skills: [] as string[],
  /** 任务角色（空 = 跟随当前页面入口的角色）。 */
  agentId: "",
  /**
   * 每期结果的落点（docs/scheduled-task-sessions-plan.md §3.1）：
   * "new"（默认）= 每期开一个新会话，各期独立可回溯与对比；"same" = 每期回投同一会话、沿用上下文。
   */
  runMode: "new" as "new" | "same",
  /** 用途：报告 / 预警（一键带默认；引擎以 notifyPolicy 为准）。 */
  purpose: "report" as SchedulePurpose,
  /** 通知策略：always=每期都推；on_alert=仅异常时推。 */
  notifyPolicy: "always" as ScheduleNotifyPolicy,
});
/** 正在编辑的任务 id（空 = 新建）。 */
const editingTaskId = ref("");
/** 原 cron 是外部建的、界面选项表达不了：频率区只读，保存时不回传频率（不猜一个相近的覆盖掉）。 */
const cronUnparsed = ref(false);
/** 上面那种情况要把原表达式显示出来，否则用户不知道自己错过什么。 */
const editingCron = ref("");
/** 频率 / 通知通道的细节编辑收进弹窗：主表单只留一行摘要，保证整体不超一屏。 */
const freqDialogOpen = ref(false);
const notifyDialogOpen = ref(false);

/** 拉取本设备的定时任务（owner 隔离在服务端）。 */
async function loadTasks() {
  tasks.value = await fetchSchedules().catch(() => [] as ScheduleDto[]);
}

/** 定时任务和各对话的新消息：页面可见时定期跟上，不必整页刷新。 */
let tasksPollTimer: ReturnType<typeof setInterval> | null = null;
function startTasksPoll() {
  if (tasksPollTimer) return;
  tasksPollTimer = setInterval(() => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    void loadTasks();
    void refreshConversationsQuiet();
    const openId = currentId.value;
    if (openId) void syncOpenConversation(openId);
  }, 5_000);
}
function stopTasksPoll() {
  if (!tasksPollTimer) return;
  clearInterval(tasksPollTimer);
  tasksPollTimer = null;
}
/** 只刷新可用服务器连接状态（不依赖当前对话；任务表单勾选预热后用来同步「已连接」）。 */
async function refreshMcpAvailable() {
  const data = await fetchChatMcpServers(currentId.value || undefined).catch(() => null);
  if (data) mcpAvailable.value = data.available;
}

/**
 * 任务表单勾选某台 MCP：写入草稿允许清单，并立刻预热连接（对齐对话区勾选即连）。
 * 到点运行才真正用工具，但状态要跟勾选同步，否则会一直停在「未连接」。
 */
async function toggleTaskServer(id: string) {
  const i = taskDraft.mcpServers.indexOf(id);
  if (i >= 0) {
    taskDraft.mcpServers.splice(i, 1);
    return;
  }
  taskDraft.mcpServers.push(id);
  await connectTaskMcp(id);
}

/** 预热单台连接：已连/连接中则跳过；乐观显示「连接中」，完成后刷回真实状态与工具数。 */
async function connectTaskMcp(id: string) {
  const row = mcpAvailable.value.find((s) => s.id === id);
  if (!row || row.connected || row.connecting) return;
  patchMcpRow(id, { connecting: true, connected: false, error: undefined });
  try {
    const status = await reloadMcpServer(id);
    patchMcpRow(id, { ...status, connecting: false });
    // listTools 偶发晚于 reload 响应，稍后再拉一次拿齐工具数。
    deferOnPage(() => void refreshMcpAvailable(), 800);
  } catch (err) {
    patchMcpRow(id, {
      connecting: false,
      connected: false,
      error: (err as Error)?.message || tx("连接失败", "connect failed", "falha na conexão", "कनेक्ट विफल"),
    });
  }
}

/** 已勾选但还没连上的，打开飞出/预选默认时批量预热（并行，互不阻塞勾选交互）。 */
function ensureTaskMcpConnected() {
  for (const id of taskDraft.mcpServers) void connectTaskMcp(id);
}

/** 任务表单里切换某项技能的勾选状态。 */
function toggleTaskSkill(dir: string) {
  const i = taskDraft.skills.indexOf(dir);
  if (i >= 0) taskDraft.skills.splice(i, 1);
  else taskDraft.skills.push(dir);
}

function taskCardFacts(): TaskCardFacts {
  return {
    tx,
    isRunning(task) {
      const ids = new Set<string>([
        task.conversationId,
        ...(task.runs || []).slice(0, 1).map((run) => run.conversationId),
      ]);
      return conversations.value.some((conv) => ids.has(conv.id) && conv.running);
    },
    mcpLabel(id) {
      return mcpAvailable.value.find((server) => server.id === id)?.label || id;
    },
    channelLabels: notifyChannels.value.filter((channel) => channel.enabled !== false).map((channel) => channel.label),
    convTitle(conversationId) {
      return conversations.value.find((conv) => conv.id === conversationId)?.title;
    },
  };
}

function taskStatusText(t: ScheduleDto): string {
  return taskStatusTextOf(t, taskCardFacts());
}
function taskRunText(t: ScheduleDto): string {
  return taskRunTextOf(t, taskCardFacts());
}
function taskMarkerText(marker?: string | null): string {
  return taskMarkerTextOf(marker, taskCardFacts());
}
function taskDotClass(t: ScheduleDto): string {
  return taskDotClassOf(t, taskCardFacts());
}
function taskHealthShort(t: ScheduleDto): string {
  return taskHealthShortOf(t, taskCardFacts());
}
function taskRightShort(t: ScheduleDto): string {
  return taskRightShortOf(t, taskCardFacts());
}
function taskNextRunText(t: ScheduleDto): string {
  return taskNextRunTextOf(t, taskCardFacts());
}
function taskNextShort(t: ScheduleDto): string {
  return taskNextShortOf(t, taskCardFacts());
}
function taskKindText(t: ScheduleDto): string {
  return taskKindTextOf(t, taskCardFacts());
}
function taskConvText(t: ScheduleDto): string {
  return taskConvTextOf(t, taskCardFacts());
}
function taskCardTip(t: ScheduleDto): string {
  return taskCardTipOf(t, taskCardFacts());
}

// ---- 通知通道（钉钉 / 飞书 / 企业微信机器人；全局注册表，凭据只写不回显）----
/** 通道类型的展示名（列表里显示「企业微信」等可读名，而不是原始 kind 值）。 */
const NOTIFY_KIND_LABELS: Record<string, string> = { dingtalk: "DingTalk", feishu: "Feishu", wecom: "企业微信" };
function notifyKindLabel(kind: string): string {
  return NOTIFY_KIND_LABELS[kind] || kind;
}
const notifyChannels = ref<NotifyChannelDto[]>([]);
const notifyBusy = ref(false);
/** 通道操作反馈（保存 / 测试结果）；空串 = 不显示。 */
const notifyNote = ref("");
const channelDraft = reactive({
  kind: "dingtalk" as NotifyChannelKind,
  label: "",
  webhook: "",
  secret: "",
  keyword: "",
});
/** 主表单「执行结果通知」摘要：列出已启用通道；增删改在弹窗里做。 */
const notifySummary = computed(() => {
  const on = notifyChannels.value.filter((c) => c.enabled !== false);
  if (!on.length) return tx("未启用任何通道", "No channel enabled", "Nenhum canal ativo", "कोई चैनल सक्रिय नहीं");
  return tx(
    `已启用 ${on.length} 个：${on.map((c) => c.label).join("、")}`,
    `${on.length} enabled: ${on.map((c) => c.label).join(", ")}`,
    `${on.length} ativos: ${on.map((c) => c.label).join(", ")}`,
    `${on.length} सक्रिय: ${on.map((c) => c.label).join(", ")}`,
  );
});

async function loadNotifyChannels() {
  notifyChannels.value = await fetchNotifyChannels().catch(() => [] as NotifyChannelDto[]);
}

function channelErrorText(err: unknown, fallback: string): string {
  return localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || fallback);
}

/** 新建通道：保存成功即勾选给当前任务（配通道的目的就是用它）。 */
async function saveChannelDraft() {
  const webhook = channelDraft.webhook.trim();
  if (!webhook) {
    notifyNote.value = tx("请填写机器人 Webhook", "Webhook is required", "Informe o webhook", "कृपया वेबहुक भरें");
    return;
  }
  notifyBusy.value = true;
  notifyNote.value = "";
  try {
    const saved = await saveNotifyChannel({
      kind: channelDraft.kind,
      label: channelDraft.label.trim(),
      webhook,
      ...(channelDraft.secret.trim() ? { secret: channelDraft.secret.trim() } : {}),
      ...(channelDraft.keyword.trim() ? { keyword: channelDraft.keyword.trim() } : {}),
    });
    notifyChannels.value = [saved, ...notifyChannels.value.filter((c) => c.id !== saved.id)];
    channelDraft.label = "";
    channelDraft.webhook = "";
    channelDraft.secret = "";
    channelDraft.keyword = "";
    notifyNote.value = tx("已保存，可点「测试」验证能不能收到", "Saved — use Test to verify delivery", "Salvo — use Testar para verificar", "सहेजा गया — जाँच के लिए टेस्ट दबाएँ");
  } catch (err) {
    notifyNote.value = channelErrorText(err, tx("保存失败", "Save failed", "Falha ao salvar", "सहेजना विफल"));
  } finally {
    notifyBusy.value = false;
  }
}

/** 测试发送：平台拒收（关键词 / 签名错）会带着平台原文回显，比「保存成功」有用得多。 */
async function testChannel(id: string) {
  notifyBusy.value = true;
  notifyNote.value = "";
  try {
    const result = await testNotifyChannel(id);
    notifyNote.value = result.ok
      ? tx("测试消息已发送，请查看机器人所在群", "Test message sent — check the chat", "Mensagem de teste enviada — verifique a conversa", "टेस्ट संदेश भेजा गया — चैट देखें")
      : tx("推送失败：", "Push failed: ", "Falha ao enviar: ", "भेजना विफल: ") + (result.error || "");
  } catch (err) {
    notifyNote.value = channelErrorText(err, tx("测试失败", "Test failed", "Teste falhou", "टेस्ट विफल"));
  } finally {
    notifyBusy.value = false;
  }
}

async function removeChannel(id: string) {
  notifyBusy.value = true;
  try {
    await deleteNotifyChannel(id);
    notifyChannels.value = notifyChannels.value.filter((c) => c.id !== id);
    notifyNote.value = "";
  } catch (err) {
    notifyNote.value = channelErrorText(err, tx("删除失败", "Delete failed", "Falha ao excluir", "हटाना विफल"));
  } finally {
    notifyBusy.value = false;
  }
}

/** 通道级启用开关：复用 upsert 端点（带 id + enabled）切换启用状态；关闭后所有引用它的任务都跳过投递。 */
async function toggleChannelEnabled(ch: NotifyChannelDto) {
  if (notifyBusy.value) return;
  notifyBusy.value = true;
  try {
    const nextEnabled = !ch.enabled;
    const saved = await saveNotifyChannel({ id: ch.id, kind: ch.kind, enabled: nextEnabled });
    const idx = notifyChannels.value.findIndex((c) => c.id === ch.id);
    if (idx >= 0) notifyChannels.value[idx] = saved;
    // 关闭后从当前任务的勾选里摘掉，避免「停用却仍显示已开启」。
    notifyNote.value = nextEnabled
      ? tx("已启用，引用它的任务到点会推送", "Enabled — tasks referencing it will deliver", "Ativado — tarefas que o referenciam entregarão", "सक्षम — इसे संदर्भित कार्य वितरित करेंगे")
      : tx("已停用，所有任务不再推送到该通道", "Disabled — no task will deliver to it", "Desativado — nenhuma tarefa entregará a ele", "अक्षम — कोई कार्य इसे नहीं भेजेगा");
  } catch (err) {
    notifyNote.value = channelErrorText(err, tx("切换失败", "Toggle failed", "Falha ao alternar", "टॉगल विफल"));
  } finally {
    notifyBusy.value = false;
  }
}

// ---- 任务表单「+ 工具」菜单（对齐对话输入区：+ 菜单 + 飞出面板；选择写入任务草稿，不影响当前对话）----
// 弹窗 overflow:auto 会裁剪 absolute 面板 → 菜单与飞出整体 Teleport 到 body。
// 锚盒必须带触发器同款高度：对话区 `.tools-menu { bottom: calc(100% + 8px) }` 依赖父盒高度 = 按钮高；
// 若做成 0×0，菜单会贴在按钮底边上方 8px（压住按钮），飞出底边也对不齐。
const taskToolsOpen = ref(false);
const taskSkillOpen = ref(false);
const taskSkillAddOpen = ref(false);
const taskMcpAddOpen = ref(false);
const taskMcpOpen = ref(false);
const taskExpertOpen = ref(false);
const taskSkillQuery = ref("");
const taskMcpQuery = ref("");
const taskExpertQuery = ref("");
/** 本次打开任务飞出是否把焦点放进搜索框（点击 = true，悬停 = false；与对话区 searchAutofocus 同口径）。 */
const taskSearchAutofocus = ref(true);
const taskToolsRoot = ref<HTMLElement | null>(null);
const taskToolsPanel = ref<HTMLElement | null>(null);
const taskToolsPos = reactive({ left: 0, bottom: 0, height: 0 });

function closeTaskFlyouts() {
  taskSkillOpen.value = false;
  taskMcpOpen.value = false;
  taskExpertOpen.value = false;
}

function updateTaskToolsPos() {
  const el = taskToolsRoot.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  taskToolsPos.left = Math.round(r.left);
  // 左/底钉在触发器，高度跟触发器一致 → 内部菜单上弹 / 飞出右展与对话区同款 CSS 算出来的位置一致。
  taskToolsPos.bottom = Math.round(window.innerHeight - r.bottom);
  taskToolsPos.height = Math.round(r.height);
}

function syncTaskToolsPos() {
  if (taskToolsOpen.value) updateTaskToolsPos();
}

function toggleTaskTools() {
  taskToolsOpen.value = !taskToolsOpen.value;
  if (!taskToolsOpen.value) {
    closeTaskFlyouts();
    return;
  }
  // 与对话区 toggleToolsMenu 同口径：打开即预取列表，飞出秒开；顺带拉拼音字典。
  void loadSkills();
  void loadMcp();
  loadPinyin();
  void nextTick(updateTaskToolsPos);
}

/**
 * 打开任务飞出（对齐对话区 openSkillPanel / openMcpPanel / openExpertPanel）：
 * 已展开则保持——悬停会先打开，紧接着的 click 绝不能再 toggle 关掉。
 */
function openTaskFlyout(kind: "skills" | "mcp" | "expert", focusSearch = true) {
  const isOpen = kind === "skills" ? taskSkillOpen.value : kind === "mcp" ? taskMcpOpen.value : taskExpertOpen.value;
  if (isOpen) {
    // 仅互斥：关掉其它飞出，不重置当前搜索/焦点。
    if (kind !== "skills") taskSkillOpen.value = false;
    if (kind !== "mcp") taskMcpOpen.value = false;
    if (kind !== "expert") taskExpertOpen.value = false;
    return;
  }
  closeTaskFlyouts();
  if (kind === "skills") {
    taskSkillOpen.value = true;
    taskSkillQuery.value = "";
    taskSkillAddOpen.value = false;
  } else if (kind === "mcp") {
    taskMcpOpen.value = true;
    taskMcpQuery.value = "";
    taskMcpAddOpen.value = false;
    void refreshMcpAvailable().then(() => ensureTaskMcpConnected());
  } else {
    taskExpertOpen.value = true;
    taskExpertQuery.value = "";
  }
  taskSearchAutofocus.value = focusSearch;
  loadPinyin();
  void nextTick(updateTaskToolsPos);
}

/** 悬停菜单行即展开飞出（与对话区 hoverFlyout 同口径，不抢焦点）。 */
function hoverTaskFlyout(kind: "skills" | "mcp" | "expert") {
  if (!taskToolsOpen.value) return;
  openTaskFlyout(kind, false);
}

/** 点击锚盒外关闭（面板已 Teleport 到 body，需同时排除触发器与浮层本体）。 */
function onOutsideTaskTools(e: MouseEvent) {
  if (!taskToolsOpen.value) return;
  const t = e.target;
  if (!(t instanceof Node)) return;
  const inTrigger = taskToolsRoot.value?.contains(t) ?? false;
  const inPanel = taskToolsPanel.value?.contains(t) ?? false;
  if (!inTrigger && !inPanel) {
    taskToolsOpen.value = false;
    closeTaskFlyouts();
  }
}

/** 任务技能搜索：与对话区 skillFiltered 同口径（拼音 + 短词只匹配名称）。 */
const taskSkillFiltered = computed(() => {
  const q = taskSkillQuery.value.trim().toLowerCase();
  void pinyinReady.value;
  if (!q) return skillAvailable.value;
  return skillAvailable.value.filter((s) => matchesFuzzyScoped([s.name], [s.dir, s.description], q));
});

/** 任务连接器搜索：与对话区 mcpFiltered 同口径；每行预存连接状态（taskRowState 只算一次）。 */
const taskMcpFiltered = computed(() => {
  const q = taskMcpQuery.value.trim().toLowerCase();
  void pinyinReady.value;
  const list = !q ? mcpAvailable.value : mcpAvailable.value.filter((s) => matchesFuzzyScoped([s.label], [s.id], q));
  return list.map((s) => ({ server: s, state: taskRowState(s) }));
});

/** 任务助手搜索：与对话区 expertFiltered 同口径；列表前另有「跟随当前入口」固定项。 */
const taskExpertFiltered = computed(() => {
  const q = taskExpertQuery.value.trim().toLowerCase();
  void pinyinReady.value;
  if (!q) return expertAgents;
  return expertAgents.filter((a) =>
    matchesFuzzyScoped(
      [agentText(a.label, uiLocale.value)],
      [a.id, ...Object.values(a.label), ...Object.values(a.description)],
      q,
    ),
  );
});

/** 任务连接器角标：只数当前列表里确实存在的 id（与对话区 enabledMcpCount 同口径）。 */
const taskMcpCount = computed(() => {
  const ids = taskDraft.mcpServers;
  if (!mcpAvailable.value.length) return ids.length;
  return ids.filter((id) => mcpAvailable.value.some((s) => s.id === id)).length;
});

function clearTaskSkills() {
  taskDraft.skills = [];
}

function clearTaskMcp() {
  taskDraft.mcpServers = [];
}

/** 助手菜单行的选中徽标：选了专家角色显示 1，「跟随当前入口」不显示。 */
const taskAgentLabel = computed(() => expertAgents.find((a) => a.id === taskDraft.agentId));

/** 友好的重复设置：频率/间隔/周几/时刻，提交时自动拼成 RRULE 字符串。 */
const taskRepeat = reactive({
  freq: "DAILY" as "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY",
  interval: 1,
  byday: ["MO"] as string[],
  time: "09:00",
});

function buildCron(): { cron?: string; error?: string } {
  return buildCronFromForm(taskRepeat, tx);
}

/**
 * 选「数据预警」一键带最佳实践默认（ChatGPT Monitoring / Datadog 主路径）：
 * 仅异常通知、同一会话、每 10 分钟；指令为空时填入可编辑脚手架（条件进指令，不进表单字段）。
 */
/** 预警指令脚手架（对齐 ChatGPT Monitoring 模板：源 / 窗口 / 阈值 / 失败规则 / 短窗口取数）。 */
const ALERT_PROMPT_SCAFFOLD =
  "【数据预警】\n" +
  "- 数据源：\n" +
  "- 范围 / 过滤：\n" +
  "- 时间窗口：最近 60 分钟（建议 ≤60 分钟，避免大列表截断）\n" +
  "- 异常条件：超过 ___ → 异常；否则正常\n" +
  "- 失败：取不到完整计数就说取不到，不要猜数、不要估算\n" +
  "- 取数：优先聚合/计数接口；列表须最少字段、小分页\n";

function applyTaskPurpose(purpose: SchedulePurpose) {
  taskDraft.purpose = purpose;
  if (purpose === "alert") {
    taskDraft.notifyPolicy = "on_alert";
    taskDraft.runMode = "same";
    if (taskDraft.scheduleType === "recurring" && !cronUnparsed.value) {
      taskRepeat.freq = "MINUTELY";
      taskRepeat.interval = 10;
    }
    // 空指令才填脚手架，不覆盖用户已写内容。
    if (!String(taskDraft.prompt || "").trim()) {
      taskDraft.prompt = ALERT_PROMPT_SCAFFOLD;
    }
  } else {
    taskDraft.notifyPolicy = "always";
    taskDraft.runMode = "new";
  }
}

function bubbleHasAlertMarker(b: {
  role: string;
  text: string;
  streaming?: boolean;
  error?: string;
  pending?: unknown;
}): boolean {
  return Boolean(
    b.role === "assistant" &&
      !b.streaming &&
      !b.error &&
      !b.pending &&
      parseAlertMarker(b.text),
  );
}

/**
 * 从对话草稿预警任务指令（ChatGPT「先测后跑」）：
 * 取「带协议标记的助手气泡」之前的所有用户话，优先命中结构化【数据预警】/数据源/异常条件 的那条
 * （用户写的完整规格），其余情况退回最近一条用户话。这样用户在规格后追加「帮我设为预警」之类
 * 的短句，不会把前面那整段规格丢掉。命中结构化则原样带入；否则包一层失败/短窗口纪律（不臆造工具名）。
 */
function draftAlertPromptFromChat(assistantBubble?: {
  role: string;
  text: string;
  streaming?: boolean;
  error?: string;
  pending?: unknown;
}): { prompt: string; name: string; mcpServers: string[] } | null {
  const bubbles = current.value?.bubbles || [];
  if (!bubbles.length) return null;

  let anchor = assistantBubble && bubbleHasAlertMarker(assistantBubble) ? assistantBubble : null;
  if (!anchor) {
    for (let i = bubbles.length - 1; i >= 0; i--) {
      if (bubbleHasAlertMarker(bubbles[i]!)) {
        anchor = bubbles[i]!;
        break;
      }
    }
  }

  // 锚点之前的所有用户话（从近到远）。结构化规格往往不是「紧邻锚点的那条」——
  // 比如规格发完、助手出结论后，用户又补一句「设为预警」，要往回找那条带规格的。
  const userMsgs: string[] = [];
  if (anchor) {
    const idx = bubbles.findIndex((b) => b === anchor || (b.id != null && (anchor as { id?: number }).id === b.id));
    const from = idx >= 0 ? idx : bubbles.length;
    for (let i = from - 1; i >= 0; i--) {
      const t = String(bubbles[i]?.text || "").trim();
      if (bubbles[i]?.role === "user" && t) userMsgs.push(t);
    }
  } else {
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const t = String(bubbles[i]?.text || "").trim();
      if (bubbles[i]?.role === "user" && t) {
        userMsgs.push(t);
        break;
      }
    }
  }
  if (!userMsgs.length) return null;

  const structuredRe = /【数据预警】|数据源\s*[:：]|异常条件\s*[:：]/;
  // 完整规格通常是「最实质」的一条用户消息：优先命中结构化标记；
  // 否则在「非闲聊短句」里取最长的一条（用户写的规格最长，「好的 / 帮我设为预警」最短，
  // 只取最近一条会把整段规格丢掉）。都没有再退回最近一条。
  const trivial = /^(?:好的|好|行|可以|谢谢|继续|设为预警|帮我设|创建|生成|确定|ok|yes|嗯|对)[\s\p{P}]*$/iu;
  const substantial = userMsgs.filter((t) => t.length > 12 && !trivial.test(t.trim()));
  const picked =
    userMsgs.find((t) => structuredRe.test(t)) ??
    (substantial.length
      ? substantial.reduce((best, t) => (t.length > best.length ? t : best), substantial[0])
      : userMsgs[0]);
  const prompt = structuredRe.test(picked)
    ? picked
    : `【数据预警】\n${picked}\n` +
      `- 失败：取不到完整计数就说取不到，不要猜数、不要估算、不要出图\n` +
      `- 取数：优先短窗口（≤60 分钟）与聚合/计数；列表须最少字段、小分页`;
  const name = picked.replace(/\s+/g, " ").slice(0, 24);
  const mcpServers = [...(current.value?.settings.mcpEnabled || [])];
  return { prompt, name, mcpServers };
}

/** 把对话试跑草稿写入当前任务表单字段（表单已开时直接填；不关弹窗）。 */
function applyAlertDraftFromChat(assistantBubble?: {
  role: string;
  text: string;
  streaming?: boolean;
  error?: string;
  pending?: unknown;
  id?: number;
}): boolean {
  const draft = draftAlertPromptFromChat(assistantBubble);
  if (!draft) {
    taskError.value = tx(
      "请先在对话里试跑一轮（结论首行出现 [NORMAL] / [SPIKE] / [NO_DATA]）",
      "Run a check in chat first (reply must start with [NORMAL] / [SPIKE] / [NO_DATA])",
      "Teste no chat primeiro (resposta deve começar com [NORMAL] / [SPIKE] / [NO_DATA])",
      "पहले चैट में चलाएँ (उत्तर [NORMAL]/[SPIKE]/[NO_DATA] से शुरू हो)",
    );
    return false;
  }
  applyTaskPurpose("alert");
  taskDraft.prompt = draft.prompt;
  if (!taskDraft.name.trim()) taskDraft.name = draft.name;
  if (draft.mcpServers.length) taskDraft.mcpServers = draft.mcpServers;
  taskError.value = "";
  ensureTaskMcpConnected();
  return true;
}

/** 对话试跑成功后一键打开「数据预警」表单（指令 + MCP + 预警默认）。 */
function openAlertScheduleFromChat(assistantBubble?: {
  role: string;
  text: string;
  streaming?: boolean;
  error?: string;
  pending?: unknown;
  id?: number;
}) {
  if (showTaskList.value) showTaskList.value = false;
  openTaskForm();
  if (!applyAlertDraftFromChat(assistantBubble)) {
    applyTaskPurpose("alert");
  }
}

const repeatUnit = computed(() => {
  const f = REPEAT_FREQS.find((x) => x.code === taskRepeat.freq)!;
  return tx(f.unitZh, f.unitEn, f.unitPt, f.unitHi);
});

function toggleWeekday(code: string) {
  const i = taskRepeat.byday.indexOf(code);
  if (i >= 0) taskRepeat.byday.splice(i, 1);
  else taskRepeat.byday.push(code);
}


/** 给用户看的纯中文预览，如「每 1 天，于 09:00 执行」。 */
const repeatPreview = computed(() => {
  const n = Math.min(99, Math.max(1, Math.floor(taskRepeat.interval || 1)));
  if (taskRepeat.freq === "MINUTELY") {
    const allowed = MINUTELY_INTERVALS as readonly number[];
    const n = allowed.includes(Math.floor(taskRepeat.interval || 10)) ? Math.floor(taskRepeat.interval || 10) : 10;
    return tx(`每 ${n} ${repeatUnit.value}执行一次`, `Every ${n} ${repeatUnit.value}`, `A cada ${n} ${repeatUnit.value}`, `हर ${n} ${repeatUnit.value}`);
  }
  if (taskRepeat.freq === "HOURLY")
    return tx(`每 ${n} ${repeatUnit.value}执行一次`, `Every ${n} ${repeatUnit.value}`, `A cada ${n} ${repeatUnit.value}`, `हर ${n} ${repeatUnit.value}`);
  if (taskRepeat.freq === "WEEKLY") {
    const days = WEEKDAYS.filter((w) => taskRepeat.byday.includes(w.code));
    const dayText = days.map((w) => tx(w.zh, w.en, w.pt, w.hi)).join(tx("、", ", ", ", ", ", "));
    return tx(
      `每 ${n} ${repeatUnit.value}的 ${dayText || "…"}，${taskRepeat.time} 执行`,
      `Every ${n} ${repeatUnit.value} on ${dayText || "…"} at ${taskRepeat.time}`,
      `A cada ${n} ${repeatUnit.value} em ${dayText || "…"} às ${taskRepeat.time}`,
      `${n} ${repeatUnit.value}, ${dayText || "…"} को ${taskRepeat.time} बजे`,
    );
  }
  // 每月重复固定落在 1 号（见 buildCron 的 MONTHLY 分支）：预览必须说清楚，别让用户以为是"下个月的今天"。
  if (taskRepeat.freq === "MONTHLY")
    return tx(
      `每 ${n} ${repeatUnit.value}的 1 号，${taskRepeat.time} 执行`,
      `Day 1 of every ${n} ${repeatUnit.value} at ${taskRepeat.time}`,
      `Dia 1 a cada ${n} ${repeatUnit.value} às ${taskRepeat.time}`,
      `हर ${n} ${repeatUnit.value} की 1 तारीख को ${taskRepeat.time} बजे`,
    );
  return tx(
    `每 ${n} ${repeatUnit.value}，${taskRepeat.time} 执行`,
    `Every ${n} ${repeatUnit.value} at ${taskRepeat.time}`,
    `A cada ${n} ${repeatUnit.value} às ${taskRepeat.time}`,
    `हर ${n} ${repeatUnit.value}, ${taskRepeat.time} बजे`,
  );
});
/** 主表单「执行频率」摘要：一行话讲清到点怎么跑；周期细节编辑在弹窗里。 */
const taskFreqSummary = computed(() => {
  if (cronUnparsed.value) return editingCron.value;
  if (taskDraft.scheduleType === "once")
    return taskDraft.scheduledAt ? dtDisplay.value : tx("未选择时间", "No time set", "Sem hora definida", "समय नहीं चुना");
  return repeatPreview.value;
});

const {
  dtOpen,
  dtRoot,
  dtPanel,
  dtPos,
  dtDisplay,
  openDtPicker,
  syncDtPos,
  pickDay,
  shiftMonth,
  DT_SHORTCUTS,
  DT_WEEKDAYS,
  dtMonthLabel,
  dtCells,
  isDtToday,
  isDtPicked,
  DT_HOURS,
  DT_MINUTES,
  dtHour,
  dtMinute,
  dtHourPart,
  dtMinutePart,
  onOutsideDt,
} = useOnceAtPicker({
  scheduledAt: () => taskDraft.scheduledAt,
  setScheduledAt: (value) => {
    taskDraft.scheduledAt = value;
  },
  tx: (zh, en, pt, hi) => tx(zh, en, pt, hi),
});

/**
 * 打开任务表单：不传 task = 新建（空白 + 预选默认），传 task = 编辑（按原任务回填）。
 * 编辑时频率区由 buildCron 的逆运算 parseCron 回填；解析不了的外部表达式只读展示，不猜。
 */
function openTaskForm(task?: ScheduleDto) {
  editingTaskId.value = task?.id || "";
  editingCron.value = task?.cron || "";
  const parsed = task ? parseCron(task.cron) : null;
  cronUnparsed.value = Boolean(task && !task.onceAt && !parsed);
  taskDraft.name = task?.name || "";
  taskDraft.prompt = task?.prompt || "";
  taskDraft.scheduleType = task?.onceAt ? "once" : "recurring";
  taskDraft.scheduledAt = task?.onceAt ? toLocalInput(task.onceAt) : "";
  taskDraft.mcpServers = [...(task?.mcpServers || [])];
  taskDraft.skills = [...(task?.skills || [])];
  // 编辑老任务时角色可能为空（旧数据）：显示为「跟随当前入口」而不是硬塞 generic。
  taskDraft.agentId = task?.agentId || "";
  // 老任务（未带落点策略）按服务端的既有语义显示为「同一会话」，避免编辑保存时悄悄改掉行为。
  // 预警任务（notifyPolicy=on_alert 或 purpose=alert）回填预警用途；否则报告。
  const isAlert = task?.purpose === "alert" || task?.notifyPolicy === "on_alert";
  taskDraft.purpose = isAlert ? "alert" : "report";
  taskDraft.notifyPolicy = task?.notifyPolicy === "on_alert" ? "on_alert" : "always";
  taskDraft.runMode = task
    ? task.runMode === "same"
      ? "same"
      : task.runMode === "new"
        ? "new"
        : isAlert
          ? "same"
          : "new"
    : "new";
  taskRepeat.freq = parsed?.freq || "DAILY";
  taskRepeat.interval = parsed?.interval || 1;
  if (taskRepeat.freq === "MINUTELY" && !(MINUTELY_INTERVALS as readonly number[]).includes(taskRepeat.interval)) {
    taskRepeat.interval = 10;
  }
  taskRepeat.byday = parsed?.byday.length ? [...parsed.byday] : ["MO"];
  taskRepeat.time = parsed?.time || "09:00";
  notifyNote.value = "";
  dtOpen.value = false;
  taskToolsOpen.value = false;
  closeTaskFlyouts();
  taskSkillQuery.value = "";
  taskMcpQuery.value = "";
  taskExpertQuery.value = "";
  taskError.value = "";
  showTaskForm.value = true;
  // 任务表单也要选 MCP / 技能 / 通知通道。新建不预勾连接器，已保存的任务沿用自己的启用集。
  void refreshMcpAvailable().then(() => {
    ensureTaskMcpConnected();
  });
  void loadSkills();
  void loadNotifyChannels();
}

function closeTaskForm() {
  freqDialogOpen.value = false;
  notifyDialogOpen.value = false;
  taskToolsOpen.value = false;
  closeTaskFlyouts();
  showTaskForm.value = false;

  editingTaskId.value = "";
  cronUnparsed.value = false;
  editingCron.value = "";
}

/** 打开主区「定时任务」页（对齐 CodeBuddy 的定时任务页）：列表 + 行内操作 + 展开各期运行。 */
function openTaskListPage() {
  if (showTaskForm.value) closeTaskForm();
  showTaskList.value = true;
  void loadTasks();
}

/**
 * Esc 关闭任务表单：这是最上层模态，只能靠取消/关闭按钮或 Esc 退出——**点遮罩不关闭**，
 * 免得填了一半的定时任务被一次误点清空。
 *
 * 两点实现细节：
 * - 监听用 capture 并 stopPropagation：模态开着时吃掉 Esc，不再触发侧栏抽屉 / 工具菜单的 Esc 收起。
 * - 表单里有两个 Teleport 到 body 的浮层（日期面板、MCP 下拉），它们不在模态 DOM 内，
 *   按层级先关浮层、再关模态（否则第一下 Esc 会直接丢掉整个表单）。
 */
function onTaskFormEsc(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  // 任务列表页（表单未开时）：Esc 退回对话视图；其余 Esc 语义交给各自的处理器。
  if (!showTaskForm.value) {
    if (showTaskList.value) showTaskList.value = false;
    return;
  }
  event.stopPropagation();
  if (dtOpen.value) {
    dtOpen.value = false;
    return;
  }
  // 子弹窗（频率 / 通知通道）盖在表单之上：先关子弹窗，再考虑表单本身。
  if (notifyDialogOpen.value) {
    notifyDialogOpen.value = false;
    return;
  }
  if (freqDialogOpen.value) {
    freqDialogOpen.value = false;
    return;
  }
  // 浮层分层收起：先飞出面板、再 + 菜单本体、最后才是表单（与对话区 Esc 语义一致）。
  if (taskSkillOpen.value || taskMcpOpen.value || taskExpertOpen.value) {
    closeTaskFlyouts();
    return;
  }
  if (taskToolsOpen.value) {
    taskToolsOpen.value = false;
    return;
  }
  closeTaskForm();
}

/** 提交表单：新建走 POST，编辑走 PATCH（同一份校验与同一份草稿）。 */
async function submitTask() {
  const name = taskDraft.name.trim();
  const prompt = taskDraft.prompt.trim();
  if (!name) return (taskError.value = tx("请填写任务名称", "Name is required", "Informe o nome da tarefa", "कृपया कार्य का नाम दर्ज करें"));
  if (!prompt) return (taskError.value = tx("请填写任务内容", "Task prompt is required", "Informe o conteúdo da tarefa", "कृपया कार्य का विवरण दर्ज करें"));
  const base = {
    name,
    prompt,
    mcpServers: taskDraft.mcpServers.slice(),
    skills: taskDraft.skills.slice(),
    // 成功与失败都列入 notifyOn（跳过不推）；真正「推不推」由 notifyPolicy 决定。
    notifyOn: ["success", "failed"] as ScheduleNotifyOn[],
    notifyPolicy: taskDraft.notifyPolicy,
    purpose: taskDraft.purpose,
    runMode: taskDraft.runMode,
  };
  // 角色：表单里显式选了专家就用它；「跟随当前入口」= 沿用页面角色（generic 页即通用助手）。
  const taskAgentId = taskDraft.agentId || (AGENT_ID !== "generic" ? AGENT_ID : "");
  // 频率：外部建的表达式（cronUnparsed）保存时不动它——界面选项表达不了它，
  // 顺手回传一个"最接近"的值等于把别人的调度改坏（服务端仍按原表达式跑）。
  const timing: { cron?: string; onceAt?: number } = {};
  if (!cronUnparsed.value) {
    if (taskDraft.scheduleType === "once") {
      if (!taskDraft.scheduledAt)
        return (taskError.value = tx("请选择执行时间", "Pick a run time", "Escolha o horário de execução", "कृपया निष्पादन समय चुनें"));
      const at = new Date(taskDraft.scheduledAt).getTime();
      if (!Number.isFinite(at))
        return (taskError.value = tx("执行时间无效", "Invalid run time", "Horário inválido", "अमान्य समय"));
      timing.onceAt = at;
    } else {
      const built = buildCron();
      if (built.error) return (taskError.value = built.error);
      timing.cron = built.cron;
    }
  }
  tasksBusy.value = true;
  taskError.value = "";
  try {
    if (editingTaskId.value) {
      // 角色：显式选了专家就改；「跟随当前入口」不动原值（避免一次编辑悄悄把角色清成 generic）。
      const updated = await patchChatSchedule(editingTaskId.value, {
        ...base,
        ...(taskAgentId ? { agentId: taskAgentId } : {}),
        ...timing,
      });
      tasks.value = tasks.value.map((x) => (x.id === updated.id ? updated : x));
    } else {
      // 结果回投的对话由服务端创建（每个任务独占一个，不再灌进当前打开的对话）；
      // 这里只带来源对话/角色，专属对话按角色分槽。返回的对话接进侧栏列表，用户能直接找到它。
      const created = await createChatSchedule({
        ...base,
        ...(currentId.value ? { conversationId: currentId.value } : {}),
        ...(taskAgentId ? { agentId: taskAgentId } : {}),
        locale: uiLocale.value,
        ...timing,
      });
      tasks.value = [created.schedule, ...tasks.value];
      if (created.conversation) {
        const conv = created.conversation;
        conversations.value = [conv, ...conversations.value.filter((c) => c.id !== conv.id)];
        resortConversations();
      }
    }
    closeTaskForm();
  } catch (err) {
    taskError.value = channelErrorText(err, tx("保存失败", "Save failed", "Falha ao salvar", "सहेजना विफल"));
  } finally {
    tasksBusy.value = false;
  }
}

/** 暂停 / 启用：乐观改写本地，失败回滚（服务端才是真相）。 */
async function toggleTask(id: string) {
  const t = tasks.value.find((x) => x.id === id);
  if (!t) return;
  const next = !t.enabled;
  t.enabled = next;
  try {
    const updated = await patchChatSchedule(id, { enabled: next });
    tasks.value = tasks.value.map((x) => (x.id === id ? updated : x));
  } catch {
    t.enabled = !next;
  }
}

async function removeTask(id: string) {
  const target = tasks.value.find((x) => x.id === id);
  const runs = target?.runs?.length || 0;
  if (runs > 0) {
    const msg = tx(
      `删除任务后，已产生的 ${runs} 期结果会话会保留在对话列表里。确认删除任务？`,
      `Deleting this task keeps its ${runs} run chats in the chat list. Delete the task?`,
      `Excluir esta tarefa mantém suas ${runs} conversas de execução na lista. Excluir a tarefa?`,
      `इस कार्य को हटाने पर इसकी ${runs} रन चैट सूची में रहेंगी। कार्य हटाएँ?`,
    );
    if (!window.confirm(msg)) return;
  }
  const prev = tasks.value;
  tasks.value = tasks.value.filter((x) => x.id !== id);
  try {
    await deleteChatSchedule(id);
  } catch {
    tasks.value = prev;
  }
}

const runningNow = ref<Record<string, boolean>>({});

/** 立即执行一期：不改原来的下次时间。服务端马上扫一次调度。 */
async function runTaskNow(id: string) {
  if (runningNow.value[id]) return;
  runningNow.value = { ...runningNow.value, [id]: true };
  try {
    const updated = await runChatSchedule(id);
    tasks.value = tasks.value.map((x) => (x.id === updated.id ? { ...x, ...updated, runs: updated.runs || x.runs } : x));
  } catch (err) {
    window.alert(err instanceof Error ? err.message : String(err));
  } finally {
    const next = { ...runningNow.value };
    delete next[id];
    runningNow.value = next;
  }
}

/** 重启任务：清掉卡在「即将执行」的陈旧请求、重新启用、并触发一期运行。 */
async function restartTask(id: string) {
  if (runningNow.value[id]) return;
  runningNow.value = { ...runningNow.value, [id]: true };
  try {
    const updated = await restartChatSchedule(id);
    tasks.value = tasks.value.map((x) => (x.id === updated.id ? { ...x, ...updated, runs: updated.runs || x.runs } : x));
  } catch (err) {
    window.alert(err instanceof Error ? err.message : String(err));
  } finally {
    const next = { ...runningNow.value };
    delete next[id];
    runningNow.value = next;
  }
}

const runStatusFilter = ref<"all" | "success" | "failed">("all");

function runMatchesFilter(status?: string): boolean {
  if (runStatusFilter.value === "all") return true;
  if (runStatusFilter.value === "success") return status === "success";
  return status === "failed" || status === "error" || status === "cancelled";
}

function filteredRuns<T extends { status?: string }>(runs: T[]): T[] {
  return runs.filter((r) => runMatchesFilter(r.status));
}

/** 正在编辑的任务（弹窗里展示「结果回到哪个对话」用）。 */
const editingTask = computed(() => tasks.value.find((t) => t.id === editingTaskId.value) || null);

/**
 * 打开某个结果会话：本地列表没有（换设备 / 刚被重建）就先刷新一次列表再选；
 * 实在没有则提示等下次运行时自动重建。任务对话与某一期对话共用这一段逻辑。
 */
async function openConversationById(convId: string, notFound: "task" | "run" | "link"): Promise<void> {
  // 先在已加载的本角色列表里找：命中即开，零额外请求。
  let conv = conversations.value.find((c) => c.id === convId);
  // 列表里没有（跨角色的任务/期次会话，或刚建好还没进列表）：直接按 id 直取——
  // 服务端不分角色、只校验归属，取到即补进本地列表（侧栏可见选中态）。
  // 先取具体资源、不再整列刷新：避免刷新打乱手动排序、也少一次请求（最佳实践）。
  if (!conv) {
    try {
      const doc = await fetchConversation(convId);
      conversations.value = [doc, ...conversations.value.filter((c) => c.id !== doc.id)];
      resortConversations();
      conv = doc;
    } catch {
      // 保持 conv 为空 → 走下面的「已不存在」提示（真被删掉/换设备还没跑过/无权访问）。
    }
  }
  if (!conv) {
    showSettingsError(
      notFound === "task"
        ? tx("该任务的对话已不存在，下次到点运行时会自动重建", "This task's chat is gone — it will be recreated on the next run", "A conversa desta tarefa não existe — será recriada na próxima execução", "इस कार्य की चैट मौजूद नहीं है — अगली रन पर फिर बनेगी")
        : notFound === "run"
        ? tx("这一期的结果会话已不存在", "This run's chat no longer exists", "A conversa desta execução não existe mais", "इस रन की चैट अब मौजूद नहीं है")
        : tx("该对话已不存在或无权访问", "This conversation no longer exists or you don't have access", "Esta conversa não existe mais ou você não tem acesso", "यह चैट अब मौजूद नहीं है या आपकी पहुँच नहीं है"),
    );
    return;
  }
  selectConversation(conv);
}

/** 打开任务的专属对话（每期结果都落在那里）。 */
function openTaskConversation(t: ScheduleDto): void {
  void openConversationById(t.conversationId, "task");
}

/** 打开某一期的结果会话。 */
function openRunConversation(run: TaskGroupRun): void {
  void openConversationById(run.conversationId, "run");
}

// 步骤状态 / 子代理状态 / 工具步骤：以上方 import 的 chat-types.ts 为单一来源，此处不再重复定义。
// （历史原因：这三个类型曾在页面内各有一份，抽 ChatBubble 组件后已抽取到 chat-types.ts 共享。）


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


function blankState(): ConvState {
  return {
    bubbles: [],
    input: "",
    sending: false,
    runCount: 0,
    hadConcurrent: false,
    controllers: [],
    dispatching: false,
    pendingImages: [],
    pendingDocs: [],
    error: "",
    settings: { modelId: "", locale: "", mcpEnabled: [], skillsEnabled: [] },
    queue: [],
  };
}

const threadEl = ref<HTMLElement | null>(null);
const conversations = ref<ConversationDto[]>([]);

/**
 * 每个对话「已成功落库」的消息条数（增量落库基线）。
 * 用 Map 而非响应式：它只是落库进度游标，不驱动渲染。
 * 没记录过的对话（本会话首次落库）回退到服务端快照长度（conversations 里该对话的 messages 长度），
 * 这样首次落库只回写「本地新增的部分」，不把整段历史（可达 MB 级）重新全量上传。
 */
const persistedCount = new Map<string, number>();

// 侧栏会话搜索（原文 + 拼音，按标题过滤）。搜索态下隐藏分组分隔线、禁用拖拽（见模板）。
const convQuery = ref("");
const conversationsFiltered = computed(() => {
  // 读 pinyinReady 建立依赖：字典异步就绪后重算，启用拼音。
  void pinyinReady.value;
  const q = convQuery.value.trim().toLowerCase();
  // 搜索态下**不过滤**任务会话：按标题搜时要能搜到某一期的结果
  // （否则「昨天那期日报」搜出来是空的）；分组区只在无搜索时渲染，不会重复出现。
  const base = q ? conversations.value : conversations.value.filter((c) => !taskConvIds.value.has(c.id));
  if (!q) return base;
  return base.filter((c) => matchesFuzzy([c.title], q));
});
function onConvSearchInput() {
  // 首次输入才拉起拼音字典（首屏不背这体积）。
  loadPinyin();
}
/**
 * Agent 角色（领域适配指南模式 B）：路由以 props 注入（/chat=generic，/movie=观影助手…）。
 * 同一页面组件服务所有 Agent —— 会话列表 / 新建 / 流式请求都带上 agentId，服务端按角色
 * 选人设与 skill 索引，会话分槽互不串台。角色判断只在后端，前端只透传。
 */
const AGENT_ID = agentProps.agentId || "generic";
const AGENT_LABEL = agentProps.agentLabel || "";

// 标签页标题跟随界面语言（AGENT_LABEL 由多 Agent 路由注入，缺省用通用名）。
watch(
  () => (AGENT_LABEL ? `${AGENT_LABEL} · Agent` : tx("小助手", "Assistant", "Assistente", "सहायक")),
  (title) => {
    document.title = title;
  },
  { immediate: true },
);

// 侧栏两套状态：移动端是带遮罩的抽屉（sidebarOpen），桌面端是常驻折叠（sidebarCollapsed）。
// 折叠态关掉后聊天区占满整屏（对齐 ChatGPT/Claude 桌面端「收起侧栏」最佳实践），
// 由顶栏汉堡按钮切换——即「PC 端左侧对话列表可点击展开 / 收起」。
const MOBILE_QUERY = "(max-width: 860px)";
const sidebarOpen = ref(false); // 移动端抽屉开关
const sidebarCollapsed = ref(false); // 桌面端常驻折叠
const isMobile = ref(typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches);
const navExpanded = computed(() => (isMobile.value ? sidebarOpen.value : !sidebarCollapsed.value));
function updateIsMobile() {
  isMobile.value = window.matchMedia(MOBILE_QUERY).matches;
}
function toggleSidebar() {
  if (isMobile.value) sidebarOpen.value = !sidebarOpen.value;
  else sidebarCollapsed.value = !sidebarCollapsed.value;
}

// 侧栏顶部「助手切换器」（对齐 CodeBuddy 的助手选择）：点当前助手名 → 下拉列出全部助手。
// 选中即 router.push —— App.vue 的 RouterView 按 path 加了 key，会整页重挂载并按新角色拉会话。
// 解决「切进 /support 后侧栏切不回通用助手」：不用再绕道门户页。
const agentMenuOpen = ref(false);
const agentMenuEl = ref<HTMLElement | null>(null);
const currentAgent = computed(() => findAgent(AGENT_ID));
function toggleAgentMenu() {
  agentMenuOpen.value = !agentMenuOpen.value;
}
function onPickAgent(agent: AgentEntry) {
  agentMenuOpen.value = false;
  if (agent.id === AGENT_ID) return;
  router.push(agent.path);
}
function onAgentMenuOutside(event: MouseEvent) {
  if (!agentMenuEl.value?.contains(event.target as Node)) agentMenuOpen.value = false;
}
function onAgentMenuEsc(event: KeyboardEvent) {
  if (event.key === "Escape") agentMenuOpen.value = false;
}
function onSidebarEsc(e: KeyboardEvent) {
  if (e.key === "Escape") sidebarOpen.value = false;
}

/** 是否把已归档对话也拉进侧栏列表。 */
const showArchived = ref(false);
const currentId = ref("");
/**
 * 首屏加载中（偏好 → 会话列表 → 选中/新建 全流程完成前为 true）。
 * 用于挡掉「先渲染空态（想聊点什么？/ 空列表 / 清空按钮误入待确认态）再被真实数据覆盖」的闪现：
 * 加载期间不出空态，加载完再按真实数据渲染空态或内容。
 */
const booting = ref(true);
/**
 * 是否真正渲染骨架屏。故意比 booting 晚一拍：
 * 本地/局域网首屏通常一两百毫秒就回来了，立刻出骨架会「闪一下又消失」，本身就是一种抖。
 * 只有加载超过延迟阈值才亮骨架，快加载则静默等到真实内容直接出现，中间不闪任何中间态。
 */
const showSkeleton = ref(false);
const SKELETON_DELAY_MS = 240;
/** 会话/定时任务上下文菜单（右键触发）：视口坐标绝对定位，渲染后做边界翻转。targetId=会话，taskId=定时任务，二选一。 */
const ctxMenu = ref<{ open: boolean; x: number; y: number; targetId: string; taskId: string }>({
  open: false,
  x: 0,
  y: 0,
  targetId: "",
  taskId: "",
});
const ctxMenuEl = ref<HTMLElement | null>(null);
/**
 * 菜单里「清空对话」的二次确认态（空 = 无）：首次点击只进入待确认，再点一次才执行；
 * 「关闭其它对话」改为走 confirmDialog 确认弹窗。菜单关闭即复位。
 */
const ctxConfirm = ref<"" | "clear">("");
/** 删除撤销窗口：窗口内可撤销，超时才真正落库删除。 */
const undoDelete = ref<{ conv: ConversationDto; index: number; wasCurrent: boolean } | null>(null);
/** 正在内联重命名的会话（id 为空 = 无）。 */
const renaming = ref<{ id: string; value: string }>({ id: "", value: "" });
const renameInputEl = ref<HTMLInputElement | null>(null);
/** 标题长度上限：只做体验层收敛，防误粘贴超长文本。 */
const RENAME_MAX = 100;

// ---- 删除确认弹窗（选项 A）----
// 点删除先弹确认框，确定才真正走 removeConversation；撤销条仍保留作为兜底，避免「确认后反悔」无路可退。
const confirmDialog = ref<{
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  onConfirm: () => void;
} | null>(null);
const confirmDialogEl = ref<HTMLElement | null>(null);
/**
 * 弹窗主操作按钮（删除 / 关闭）的引用：打开时焦点落这里，回车即执行。
 * 对齐 antd `Modal.confirm` 的 `autoFocusButton: "ok"` 默认值——弹窗本身已是二次确认，
 * 再让键盘用户多按一次 Tab 才能回车确认，等于把「回车」变成了「取消」。
 */
const confirmPrimaryBtn = ref<HTMLElement | null>(null);
let confirmReturnFocus: HTMLElement | null = null;

// ---- HTML 产物预览（对齐 CodeBuddy / Cursor 的 artifact 预览：自包含 HTML 在独立面板里直接渲染）----
const previewHtml = ref<{ name: string; path: string; content: string } | null>(null);
const previewLoading = ref(false);
function isHtmlArtifact(a: { name: string; path: string }): boolean {
  return /\.html?$/i.test(a.name || "") || /\.html?$/i.test(a.path || "");
}
async function openArtifactPreview(a: { name: string; path: string }) {
  previewLoading.value = true;
  previewHtml.value = { name: a.name, path: a.path, content: "" };
  try {
    const content = await readWorkspaceFile(currentId.value, a.path);
    previewHtml.value = { name: a.name, path: a.path, content };
  } catch {
    previewHtml.value = null;
  } finally {
    previewLoading.value = false;
  }
}
function closeArtifactPreview() {
  previewHtml.value = null;
}

function askDeleteConversation(conv: ConversationDto) {
  confirmReturnFocus = (document.activeElement as HTMLElement) || null;
  const fallback = tx("新对话", "New chat", "Nova conversa", "नई चैट");
  const name = conv.title || fallback;
  confirmDialog.value = {
    title: tx("删除对话", "Delete chat", "Excluir conversa", "चैट हटाएं"),
    message: tx(
      `确定删除「${name}」吗？删除后可通过底部撤销条恢复，但正在进行的对话流会被中断。`,
      `Delete “${name}”? You can undo from the toast, but the running stream will stop.`,
      `Excluir “${name}”? Você pode desfazer pelo aviso, mas o fluxo em andamento será interrompido.`,
      `“${name}” हटाएं? आप टूस्ट से पूर्ववत कर सकते हैं, परंतु चल रही स्ट्रीम रुक जाएगी।`
    ),
    confirmLabel: tx("删除", "Delete", "Excluir", "हटाएं"),
    danger: true,
    onConfirm: () => removeConversation(conv.id),
  };
}

function askDeleteFromCtx() {
  const id = ctxMenu.value.targetId;
  const conv = conversations.value.find((c) => c.id === id);
  closeCtxMenu();
  if (conv) askDeleteConversation(conv);
}

function askCloseOthers() {
  const keepId = ctxMenu.value.targetId;
  const n = conversations.value.filter((c) => c.id !== keepId && !c.archived).length;
  closeCtxMenu();
  // 没有其它会话可关：菜单直接收起，避免弹出「关闭 0 个对话」的怪异确认。
  if (n === 0) return;
  confirmReturnFocus = (document.activeElement as HTMLElement) || null;
  confirmDialog.value = {
    title: tx("关闭其它对话", "Close other chats", "Fechar outras conversas", "अन्य चैट बंद करें"),
    message: tx(
      `确定关闭其它 ${n} 个对话吗？这些对话都会被删除，且无法撤销。`,
      `Close ${n} other chat${n === 1 ? "" : "s"}? They will all be deleted and cannot be undone.`,
      `Fechar ${n} outra${n === 1 ? "" : "s"} conversa${n === 1 ? "" : "s"}? Todas serão excluídas e não podem ser desfeitas.`,
      `क्या ${n} अन्य चैट बंद करें? वे सभी हटा दी जाएंगी और पूर्ववत नहीं की जा सकतीं।`
    ),
    confirmLabel: tx("关闭", "Close", "Fechar", "बंद करें"),
    danger: true,
    onConfirm: () => closeOtherConversations(keepId),
  };
}

function closeConfirm() {
  confirmDialog.value = null;
  // 焦点还给触发元素（取消时按钮还在；确认删除后按钮已被移除则跳过）。
  if (confirmReturnFocus && document.body.contains(confirmReturnFocus)) {
    confirmReturnFocus.focus();
  }
  confirmReturnFocus = null;
}

function confirmDialogConfirm() {
  const fn = confirmDialog.value?.onConfirm;
  closeConfirm();
  fn?.();
}

function trapConfirmFocus(e: KeyboardEvent) {
  const dlg = confirmDialogEl.value;
  if (!dlg || e.key !== "Tab") return;
  const focusable = dlg.querySelectorAll<HTMLElement>("button:not([disabled])");
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// 打开时锁背景滚动；关闭时恢复。焦点移到主操作按钮（回车即确认，Esc / 点遮罩取消）。
watch(
  confirmDialog,
  (val) => {
    if (val) {
      document.body.style.overflow = "hidden";
      nextTick(() => confirmPrimaryBtn.value?.focus());
    } else {
      document.body.style.overflow = "";
    }
  },
  { flush: "post" }
);

onBeforeUnmount(() => {
  if (confirmDialog.value) document.body.style.overflow = "";
});

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
/** 输入框组件引用（对话输入区与任务表单共用同一个 PromptBox 外壳）。 */
const promptBoxEl = ref<InstanceType<typeof PromptBox> | null>(null);
/** 输入框元素引用：用于按内容自动撑高（交互优化）。走组件暴露的 textarea，调用方用法不变。 */
const inputEl = computed<HTMLTextAreaElement | null>(() => promptBoxEl.value?.el ?? null);
/** 「停止」按钮：发送后原按钮被它替换，焦点得接过来（见 current.sending 的 watch）。 */
const stopBtnRef = ref<HTMLButtonElement | null>(null);

/** 用户拖拽固定的输入框高度（null = 跟随内容自动），本地持久化。 */
const COMPOSER_H_KEY = "bx-agent-composer-h";
const COMPOSER_H_MIN = 52;
const COMPOSER_H_MAX = 420;
/** 基础高度（约 3 行）：空输入与少量输入时保持不变，内容超出才自适应增长。 */
const COMPOSER_BASE = 74;
/** 自动模式的增长上限：超过后内部滚动（拖拽定高不受此限，上限为 COMPOSER_H_MAX）。 */
const COMPOSER_AUTO_MAX = 200;
const composerSize = ref<number | null>(loadComposerSize());

function loadComposerSize(): number | null {
  try {
    const n = Number(localStorage.getItem(COMPOSER_H_KEY));
    return Number.isFinite(n) && n >= COMPOSER_H_MIN && n <= COMPOSER_H_MAX ? Math.round(n) : null;
  } catch {
    return null;
  }
}

/** 输入框随内容自动长高；拖拽定高后固定高度、超出滚动。
 *  未拖拽时：基础高度（约 3 行）内保持固定，只有内容需要更多空间才增长，上限 COMPOSER_AUTO_MAX。
 *  先置 height:auto 再读 scrollHeight 是必需的：scrollHeight 返回 max(内容高, 当前高)，
 *  不重置读不到收缩后的真实内容高（两次 reflow 是该模式的固有代价）。
 *  目标高度与上次相同时恢复原值跳过变更，避免 74px 内每次键入触发无谓样式失效。 */
function autoGrow() {
  const el = inputEl.value;
  if (!el) return;
  if (composerSize.value != null) {
    el.style.height = `${composerSize.value}px`;
    return;
  }
  const prev = el.style.height;
  el.style.height = "auto";
  const next = `${Math.max(COMPOSER_BASE, Math.min(el.scrollHeight, COMPOSER_AUTO_MAX))}px`;
  if (prev !== next) el.style.height = next;
  else el.style.height = prev;
}

/** 窗口缩放改变换行宽度 → 所需高度变化，需重算（键入时才算会漏掉纯缩放场景）。 */
function onWindowResizeGrow() {
  autoGrow();
}

/** 拖动顶部把手调整输入框高度（往上拉高、往下压低）。 */
function startComposerResize(e: MouseEvent) {
  const el = inputEl.value;
  if (!el) return;
  const startY = e.clientY;
  const startH = el.getBoundingClientRect().height;
  const move = (ev: MouseEvent) => {
    const h = Math.min(COMPOSER_H_MAX, Math.max(COMPOSER_H_MIN, Math.round(startH + (startY - ev.clientY))));
    composerSize.value = h;
    el.style.height = `${h}px`;
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    if (composerSize.value != null) {
      try {
        localStorage.setItem(COMPOSER_H_KEY, String(composerSize.value));
      } catch {
        /* 隐私模式忽略 */
      }
    }
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

/** 双击把手恢复「跟随内容自动高度」。 */
function resetComposerSize() {
  composerSize.value = null;
  try {
    localStorage.removeItem(COMPOSER_H_KEY);
  } catch {
    /* 忽略 */
  }
  void nextTick(() => autoGrow());
}

/** 设备默认语言（来自 `GET /chat/preferences`；对话未显式设置 locale 时兜底）。 */
const deviceLocale = ref<UiLocale>(detectDefaultLocale());

/** 浏览器 IANA 时区。非法或取不到时不传，服务端保持 UTC 并在回答里标明。 */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}
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

/** 仅最近一条带协议标记的助手结论显示「设为数据预警」，避免历史气泡刷屏。 */
const latestAlertMarkerId = ref<number | undefined>(undefined);
/**
 * 只在「切换会话」「气泡数量变化」「尾部气泡结束流式」或「尾部结论原地长出/变更告警标记」时重算，
 * 不跟每次 text_delta。之前是在模板里逐气泡调用扫描函数：父渲染因此依赖所有气泡的 text，长对话每帧 O(N²)。
 * sig 必须含告警标记位（原地补 [SPIKE]/[NORMAL] 时要刷新），也必须含会话 id（否则两个气泡数/尾部标记相同的
 * 会话切换时不触发，入口停在上一会话的残影），还必须含「气泡数组实例」——首次打开会先用列表快照建气泡、
 * 随后用完整快照 force 重载整段（bubblesFromStored 每次 ++seq 生成全新 id），若只看长度/尾部标记会误判为
 * 未变化，CTA 残留在已被替换掉的旧 id 上。
 * 回调的倒序全扫在长对话上很贵，按「会话 id + sig」缓存结果，来回切同一会话直接命中。
 */
const alertMarkerCache = new Map<string, { sig: string; id: number | undefined }>();
const EMPTY_BUBBLES: Bubble[] = [];
const bubbleArrIds = new WeakMap<object, number>();
let bubbleArrSeq = 0;
function bubbleArrId(arr: object): number {
  let id = bubbleArrIds.get(arr);
  if (id === undefined) {
    id = ++bubbleArrSeq;
    bubbleArrIds.set(arr, id);
  }
  return id;
}
watch(
  () => {
    const bubbles = current.value?.bubbles || EMPTY_BUBBLES;
    let sig = `${currentId.value}|${bubbleArrId(bubbles)}|${bubbles.length}`;
    const tail = Math.max(0, bubbles.length - 24);
    for (let i = bubbles.length - 1; i >= tail; i--) {
      const b = bubbles[i]!;
      if (b.role === "assistant") sig += b.streaming ? "1" : bubbleHasAlertMarker(b) ? "A" : "0";
    }
    return sig;
  },
  (sig) => {
    const convId = currentId.value;
    const cached = alertMarkerCache.get(convId);
    if (cached && cached.sig === sig) {
      latestAlertMarkerId.value = cached.id;
      return;
    }
    const bubbles = current.value?.bubbles || [];
    let id: number | undefined;
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i]!;
      if (bubbleHasAlertMarker(b)) {
        id = b.id;
        break;
      }
    }
    alertMarkerCache.set(convId, { sig, id });
    latestAlertMarkerId.value = id;
  },
  { immediate: true },
);

/** 长对话只渲染最近一段：上万条消息一次性挂载会让首屏和每次 diff 都卡。 */
const THREAD_WINDOW_STEP = 60;
const threadWindow = ref(THREAD_WINDOW_STEP);
watch(currentId, () => {
  threadWindow.value = THREAD_WINDOW_STEP;
});
const visibleBubbles = computed(() => {
  const all = current.value?.bubbles || [];
  const cap = Math.min(all.length, threadWindow.value);
  return cap >= all.length ? all : all.slice(all.length - cap);
});
/** 展开更早消息时保持视口不跳：按「距底部距离」回填 scrollTop。 */
function showEarlierMessages() {
  const el = threadEl.value;
  const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
  threadWindow.value += THREAD_WINDOW_STEP;
  void nextTick(() => {
    if (!el) return;
    el.scrollTop = el.scrollHeight - fromBottom;
  });
}

/* —— 对话大纲浮层（docs/conversation-outline-panel-plan.md）：右缘悬浮面板列出本会话的用户指令，点击跳转。 —— */
interface OutlineItem {
  id: number;
  label: string;
}
const OUTLINE_LABEL_MAX = 48;
/**
 * 大纲条目文案：压平空白、超长截断；纯图片消息给占位（沿用待发队列「仅图片」的占位惯例）。
 */
function outlineLabel(b: Bubble): string {
  const raw = (b.text || "").replace(/\s+/g, " ").trim();
  if (raw) return raw.length > OUTLINE_LABEL_MAX ? `${raw.slice(0, OUTLINE_LABEL_MAX)}…` : raw;
  const n = b.images?.length ?? 0;
  if (n) return tx(`图片 ×${n}`, `Images ×${n}`, `Imagens ×${n}`, `छवियाँ ×${n}`);
  return tx("（无文本）", "(no text)", "(sem texto)", "(कोई पाठ नहीं)");
}
/**
 * 大纲派生：只读 user 气泡的 text、其余气泡只读 role。
 * computed 依赖是细粒度的——助手气泡流式追加 text 不会触碰这里的依赖，面板在生成全程零重算零抖动；
 * 新增/删除气泡（含用户新消息）才会使它更新。
 */
// 大纲派生扫全量气泡做正则并生成上千条目：长对话（上万条消息）来回切时每次重算是切换延迟的大头。
// 用户气泡文本创建后不会被原地改（编辑是回填输入框再重发），气泡数组只会整体替换或 push/splice，
// 故按「状态对象 + 数组引用 + 长度 + 语言」缓存即可安全失效；助手流式改 text 不影响大纲，也不该触发重算。
// 语言必须入键：纯图片/空文本用户气泡的标签走 tx()，切界面语言后要重算本地化文案。
let outlineCache: { state: ConvState; arr: Bubble[]; len: number; locale: string; items: OutlineItem[] } | null = null;
const conversationOutline = computed<OutlineItem[]>(() => {
  const state = current.value;
  const arr = state?.bubbles ?? [];
  const locale = uiLocale.value;
  if (
    outlineCache &&
    outlineCache.state === state &&
    outlineCache.arr === arr &&
    outlineCache.len === arr.length &&
    outlineCache.locale === locale
  ) {
    return outlineCache.items;
  }
  const out: OutlineItem[] = [];
  for (const b of arr) {
    if (b.role !== "user") continue;
    out.push({ id: b.id, label: outlineLabel(b) });
  }
  outlineCache = { state, arr, len: arr.length, locale, items: out };
  return out;
});

/** 大纲面板开关与当前高亮项。切换会话先清高亮，防止上一会话的残影。 */
const outlineOpen = ref(false);
const activeOutlineId = ref<number | null>(null);
/** 点击跳转后锁定高亮：滚动跟踪此时别把「点的那条」改成「带内的下一条」。 */
const pinnedOutlineId = ref<number | null>(null);
/** 本轮跳转的程序滚动是否在飞：期间的 scroll 不算用户滚动，不解锁。 */
let outlineJumpActive = false;
let outlineJumpFallback = 0;
let outlineScrollEndHandler: (() => void) | null = null;
/** scrollend 之后极短的尾随 scroll 忽略窗口，避免程序滚动补发事件误解锁。 */
let outlineIgnoreScrollUntil = 0;

/** 结束「程序滚动中」标记；不负责清 pin（用户没滚就继续锁定）。 */
function finishOutlineScroll() {
  outlineJumpActive = false;
  outlineIgnoreScrollUntil = Date.now() + 120;
  window.clearTimeout(outlineJumpFallback);
  outlineJumpFallback = 0;
  if (outlineScrollEndHandler && threadEl.value) threadEl.value.removeEventListener("scrollend", outlineScrollEndHandler);
  outlineScrollEndHandler = null;
}

/** 用户主动滚动 → 解锁高亮跟踪，并终止本轮程序滚动标记。 */
function releaseOutlinePin() {
  if (pinnedOutlineId.value === null) return;
  pinnedOutlineId.value = null;
  finishOutlineScroll();
}

/** 滚轮 / 触摸 / 翻页键都算用户滚动意图，立即解锁（不必等 scrollend）。 */
const OUTLINE_NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
function onOutlineUserScrollIntent(e?: Event) {
  if (e instanceof KeyboardEvent && !OUTLINE_NAV_KEYS.has(e.key)) return;
  releaseOutlinePin();
}

watch(currentId, () => {
  activeOutlineId.value = null;
  releaseOutlinePin();
});
// 新用户消息进来后大纲追加，旧锁不再有意义。
watch(
  () => conversationOutline.value.length,
  () => releaseOutlinePin(),
);

/** 跳转目标的窗口余量：让目标行进窗后再多留几条上下文，避免它贴在窗口边缘。 */
const OUTLINE_WINDOW_MARGIN = 20;
/** 当前项高亮带：视口顶部往下该比例。与 ConversationOutline 的滚动跟踪共用同一口径。 */
const OUTLINE_ACTIVE_BAND = 0.4;
/** 目标行落在高亮带略上方，避开像素取整导致高亮判给前一条。 */
const OUTLINE_LANDING_INSET = 12;

/**
 * 大纲跳转：目标在渲染窗口（最近 60 条）之外时先扩窗，再滚动 + 落焦。
 * 落点对齐高亮带（而非贴视口顶），否则目标下方的下一条会落进带内，高亮跑偏到下一条。
 * 不强制回底——向上跳后 nearBottom() 自然置 followBottom=false，流式增量不会把用户拽回底部，
 * 滚回底部附近即自动恢复跟随（onThreadScroll 既有逻辑）。
 */
function jumpToOutline(id: number) {
  const all = current.value?.bubbles ?? [];
  const index = all.findIndex((b) => b.id === id);
  if (index < 0) return; // 运行时序号失效（HMR/刷新后 seq 重编）时静默忽略
  const need = all.length - index;
  if (need > threadWindow.value) threadWindow.value = need + OUTLINE_WINDOW_MARGIN;
  if (isMobile.value) outlineOpen.value = false; // 移动端跳转后收起面板，不遮刚滚到的内容
  activeOutlineId.value = id; // 点击即高亮，不等平滑滚动过程中的滚动跟踪
  finishOutlineScroll(); // 清掉上一轮的程序滚动收尾监听
  pinnedOutlineId.value = id;
  outlineJumpActive = true; // 点击到 nextTick 之间也可能有 scroll，先屏蔽
  void nextTick(() => {
    const thread = threadEl.value;
    const el = thread?.querySelector<HTMLElement>(`[data-bubble-id="${id}"]`);
    if (!thread || !el) {
      finishOutlineScroll();
      return;
    }
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const offset = el.getBoundingClientRect().top - thread.getBoundingClientRect().top;
    const top = Math.max(0, thread.scrollTop + offset - thread.clientHeight * OUTLINE_ACTIVE_BAND + OUTLINE_LANDING_INSET);
    thread.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
    if (reduceMotion) {
      finishOutlineScroll(); // 瞬时滚动没有 scrollend，立即收尾
    } else {
      const done = () => finishOutlineScroll();
      outlineScrollEndHandler = done;
      thread.addEventListener("scrollend", done, { once: true });
      // scrollend 尚未普及的浏览器兜底：避免程序滚动标记永不清。
      outlineJumpFallback = window.setTimeout(done, 1200);
    }
    el.focus({ preventScroll: true }); // 行有 tabindex="-1"，落焦避免面板收起后焦点悬空
  });
}


/**
 * 发送 ⇄ 停止是两个不同按钮（v-if 互换）：点了之后原来那个按钮从 DOM 里消失，焦点掉到 body，
 * 键盘用户按 Tab 得从页首重新走一遍（观影页实测复现过同一处）。
 * 切换后把焦点扶到「此刻该按的控件」：生成中 → 停止，收束后 → 输入框；
 * 只在焦点无主（body）时才接管，避免抢走用户此刻在别处的焦点。
 */
watch(
  () => current.value.sending,
  async (busy) => {
    await nextTick();
    if (document.activeElement !== document.body) return;
    if (busy) stopBtnRef.value?.focus();
    else inputEl.value?.focus();
  },
);

let seq = 0;

// ---- SCC C：模型设置 / 滚动跟底 / 推理 UI（从本文件机械拆分，行为零变化）----
// 初始化顺序固定：modelSettings → threadScroll → reasoningUI。
// 跨组/跨层依赖只通过 options 注入引用或回调；薄代理仅在事件/异步回调里被触发，
// setup 同步阶段不得调用——搬迁后用搜索确认没有提前调用。
const {
  models,
  modelsLoaded,
  modelId,
  lastGoodModelId,
  failedModelIds,
  resolveModel,
  settingsErrorTimer,
  showSettingsError,
  disposeSettingsErrorTimer,
  syncConvLocal,
  applyConversationLocale,
  modelChoiceLabel,
  modelSwitchHint,
  saveModelChoice,
  onLocaleChange,
  resolvedModelId,
  modelSupportsImages,
  imagesUnsupported,
} = useChatModelSettings({
  current,
  currentId,
  settingsError,
  conversations,
  deviceLocale,
  uiLocale,
  tx,
  nextSeq: () => ++seq,
  queueScroll: (force) => queueScroll(force),
});

const {
  scrollQueued,
  scrollForce,
  queueScrollIfCurrent,
  followBottom,
  nearBottom,
  atBottomNow,
  onThreadScroll,
  queueScroll,
  setFollowBottom,
} = useChatThreadScroll({
  currentId,
  threadEl,
  pinnedOutlineId,
  isOutlineJumpActive: () => outlineJumpActive,
  getOutlineIgnoreScrollUntil: () => outlineIgnoreScrollUntil,
  releaseOutlinePin,
});

const {
  openReasoning,
  reasoningCollapsedByUser,
  toggleReasoning,
  openReasoningPanel,
  closeReasoningPanel,
  openSteps,
  stepKey,
  toggleStep,
  stepSummary,
  hasRunningStep,
  hasThinking,
  INTENT_RE,
  intentOf,
  thinkingDisplay,
  thinkStarts,
  thinkPhaseStart,
  thinkPhaseEnd,
  thinkLabel,
  thinkStickQueued,
  stickThinkingToBottom,
  reasoningTitle,
} = useChatReasoningUI({ threadEl, uiLocale, tx });
const mcpAvailable = ref<McpServerStatus[]>([]);

const canSend = computed(
  () => Boolean(current.value.input.trim() || current.value.pendingImages.length || current.value.pendingDocs.length),
);

const {
  conversationSyncing,
  pendingSyncId,
  chartsOf,
  settleStep,
  SNAPSHOT_DETAIL_TAIL,
  SNAPSHOT_THINKING_CAP,
  SNAPSHOT_STEP_RESULT_CAP,
  capTail,
  toStored,
  bubblesFromStored,
  upgradeConversationDetail,
  applyServerThread,
  tailSig,
  serverThreadAhead,
  syncOpenConversation,
  pendingPersists,
  persistChains,
  waitPendingPersists,
  persist,
  persistNow,
} = useChatPersistence({
  states,
  currentId,
  conversations,
  persistedCount,
  nextSeq: () => ++seq,
  atBottomNow: () => atBottomNow(),
  queueScroll: (force) => queueScroll(force),
  ensureRunPrompt,
  attachRunningTask,
  messageTimes: (messages, createdAt, updatedAt) => messageTimes(messages, createdAt, updatedAt),
});

// ---- SCC A 会话壳：列表排序 / 会话动作 / 右键 / 删除撤销（机械拆分，行为零变化）----
// 每页实例状态传引用；定义在注入点之后的回调统一用箭头/getter 包裹消解 TDZ。
const {
  CONV_ORDER_STEP,
  convRank,
  resortConversations,
  refreshConversationsQuiet,
  reloadConversations,
  applyConversationOrder,
  restoreRecentSort,
  selectConversation,
  newConversation,
  createConvFromDraft,
  ctxTarget,
  ctxAnchorPos,
  placeCtxMenu,
  openCtxMenu,
  openTaskCtxMenu,
  closeCtxMenu,
  armCtxConfirm,
  deleteConversationOnServer,
  flushPendingDelete,
  scheduleUndoDelete,
  removeConversation,
  undoRemoveConversation,
} = useChatConversationShell({
  agentId: AGENT_ID,
  conversations,
  currentId,
  states,
  stateOf,
  persistedCount,
  blank,
  showArchived,
  sortMode,
  current,
  modelSwitchHint,
  ctxMenu,
  ctxMenuEl,
  ctxConfirm,
  undoDelete,
  uiLocale,
  tx,
  messageTimes: (messages, createdAt, updatedAt) => messageTimes(messages, createdAt, updatedAt),
  bubblesFromStored: (messages, times) => bubblesFromStored(messages, times),
  toStored: (list) => toStored(list),
  upgradeConversationDetail: (id) => upgradeConversationDetail(id),
  syncOpenConversation: (id) => syncOpenConversation(id),
  syncConvLocal: (id, patch) => syncConvLocal(id, patch),
  applyConversationLocale: (locale) => applyConversationLocale(locale),
  queueScroll: (force) => queueScroll(force),
  showSettingsError: (message) => showSettingsError(message),
  isLocale: (locale) => isUiLocale(locale),
  closeTaskForm: () => closeTaskForm(),
  showTaskForm,
  showTaskList,
  sidebarOpen,
  loadTasks: () => loadTasks(),
  watchBackgroundDone: (id) => watchBackgroundDone(id),
  reportActiveConversation: (conv) => reportActiveConversation(conv),
  clearTaskUnread: (id) => clearTaskUnread(id),
  loadMcp: (id) => loadMcp(id),
  loadSkills: (id) => loadSkills(id),
  boundMcpIds: () => boundMcpIds.value,
  draftSendMode: () => draftSendMode.value,
});

// ---- 拖拽排序 ----

/** 拖拽开始：记录被拖会话。重命名编辑中不允许拖拽（否则输入框没法选中文字）；归档项不参与排序。 */
function onConvDragStart(e: DragEvent, conv: ConversationDto) {
  if (renaming.value.id || conv.archived) {
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
  // 归档区不是落点：归档与否由菜单里的「归档 / 取消归档」决定，不靠拖拽（避免误拖进/拖出）。
  if (conv.archived) {
    dropTarget.value = null;
    return;
  }
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
  // 归档项两端都不参与落点（拖拽对它无效）。
  if (moved.archived || anchor.archived) return;
  // 拖进置顶区 = 置顶，拖出置顶区 = 取消置顶。
  const crossGroup = !!moved.pinnedAt !== !!anchor.pinnedAt;
  const pinOverride: number | null | undefined = crossGroup ? (moved.pinnedAt ? null : Date.now()) : undefined;
  void applyConversationOrder(fromId, target.id, target.after, pinOverride);
}

// ---- 键盘（拖拽的等价路径）----

/** `Alt+↑/↓`：在所在组内上移 / 下移一位（归档项不参与，与拖拽一致）。 */
async function moveConversation(conv: ConversationDto, delta: number) {
  if (conv.archived) return;
  const group = conversations.value.filter((c) => !c.archived && !!c.pinnedAt === !!conv.pinnedAt);
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

/** 置顶项数量：模板据此在最后一置顶项后插入分隔线（归档项自成一组，不计入）。 */
const pinnedCount = computed(() => conversationsFiltered.value.filter((c) => !c.archived && c.pinnedAt).length);

/** 归档项数量（显示归档时用于在归档区前插入分隔线）。 */
const archivedCount = computed(() => conversationsFiltered.value.filter((c) => c.archived).length);

/** 第一个归档项的下标：归档区固定在列表最末（由 convRank 保证）。 */
const firstArchivedIndex = computed(() => conversationsFiltered.value.length - archivedCount.value);

/**
 * 任务产出的会话 id 集合（专属对话 + 各期会话）：侧栏据此把它们**从平铺列表里移出**，
 * 改到下方「定时任务」区按任务分组成树展示（docs/scheduled-task-sessions-plan.md §3.10）。
 * 不移出的代价：周期任务每跑一期就刷新 `updatedAt`、顶到列表最上面，把自己的对话一直往下挤。
 */
const taskConvIds = computed(() => {
  const set = new Set<string>();
  for (const t of tasks.value) {
    if (t.ownConversation && t.conversationId) set.add(t.conversationId);
    for (const r of t.runs || []) set.add(r.conversationId);
  }
  return set;
});

/** 定时任务分组（父 = 任务，子 = 各期会话）；按最近一期倒序，新的在上。 */
interface TaskGroupRun {
  conversationId: string;
  at: number;
  status?: string;
  marker?: string;
  trigger?: "schedule" | "manual" | "wake";
  durationMs?: number;
  conv?: ConversationDto;
}
const taskGroups = computed<Array<{ schedule: ScheduleDto; runs: TaskGroupRun[] }>>(() => {
  const byId = new Map(conversations.value.map((c) => [c.id, c]));
  return tasks.value
    .filter((t) => t.ownConversation)
    .map((t) => ({
      schedule: t,
      // 老任务没有 runs：用它的专属对话顶一条，保证分组里不是空的（内容确实都在那里）。
      runs: (
        t.runs?.length
          ? t.runs
          : t.conversationId
            ? [{ conversationId: t.conversationId, at: t.lastRunAt ?? t.createdAt }]
            : []
      )
        .map((r) => ({ ...r, conv: byId.get(r.conversationId) }))
        .sort((a, b) => b.at - a.at),
    }))
    .filter((g) => g.runs.length)
    .sort((a, b) => (b.runs[0]?.at || 0) - (a.runs[0]?.at || 0));
});

/** 分组展开状态：默认折叠（任务多时不占地方），按任务 id 记在本地，刷新保持。 */
const TASK_GROUP_KEY = "bx-agent-task-groups";
const expandedTasks = ref<Record<string, boolean>>(readTaskGroupState());
function readTaskGroupState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(TASK_GROUP_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}
function toggleTaskGroup(id: string) {
  expandedTasks.value = { ...expandedTasks.value, [id]: !expandedTasks.value[id] };
  try {
    localStorage.setItem(TASK_GROUP_KEY, JSON.stringify(expandedTasks.value));
  } catch {
    /* 隐私模式下写不进去：只丢「展开状态」这一层偏好，不影响功能 */
  }
}
function onTaskGroupKeydown(e: KeyboardEvent, id: string) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggleTaskGroup(id);
  }
}

/**
 * 定时任务分组区整体折叠（置顶为可折叠分组后，允许一键收起整块，与文件树/CodeBuddy 同口径）。
 * 默认展开，状态记本地；隐私模式写不进去时只丢这一层偏好。
 */
const TASK_SECTION_KEY = "bx-agent-task-section";
const taskSectionOpen = ref(readTaskSectionState());
function readTaskSectionState(): boolean {
  try {
    return localStorage.getItem(TASK_SECTION_KEY) !== "0";
  } catch {
    return true;
  }
}
function toggleTaskSection() {
  taskSectionOpen.value = !taskSectionOpen.value;
  try {
    localStorage.setItem(TASK_SECTION_KEY, taskSectionOpen.value ? "1" : "0");
  } catch {
    /* 隐私模式下写不进去：只丢「分组区折叠状态」这一层偏好，不影响功能 */
  }
}

/** 对话列表整体折叠（与定时任务分组头同款交互，CodeBuddy「空间/任务」两组同口径）。 */
const CONV_SECTION_KEY = "bx-agent-conv-section";
const convSectionOpen = ref(readConvSectionState());
function readConvSectionState(): boolean {
  try {
    return localStorage.getItem(CONV_SECTION_KEY) !== "0";
  } catch {
    return true;
  }
}
function toggleConvSection() {
  convSectionOpen.value = !convSectionOpen.value;
  try {
    localStorage.setItem(CONV_SECTION_KEY, convSectionOpen.value ? "1" : "0");
  } catch {
    /* 隐私模式下写不进去：只丢「对话折叠状态」这一层偏好，不影响功能 */
  }
}

/** 分组里的「某一期」也要键盘可达（与 .conv-item 同口径：Enter/Space 打开）。 */
function onRunKeydown(e: KeyboardEvent, run: TaskGroupRun) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    void openRunConversation(run);
  }
}

/** 某一期的显示文案：`MM-DD HH:mm`（会话标题里已带任务名，分组里重复一次没意义）。 */
function runTimeText(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 执行记录副文案：时间 · 触发方式 · 耗时。对齐千问办公执行记录里能在列表上看见的几项。 */
function runMetaText(run: { at: number; trigger?: string; durationMs?: number }): string {
  const parts = [runTimeText(run.at)];
  if (run.trigger === "manual") parts.push(tx("手动", "Manual", "Manual", "मैनुअल"));
  else if (run.trigger === "wake") parts.push(tx("唤醒", "Wake", "Evento", "वेक"));
  else if (run.trigger === "schedule") parts.push(tx("定时", "Scheduled", "Agendado", "निर्धारित"));
  if (run.durationMs !== undefined && run.durationMs >= 1000) {
    const sec = Math.max(1, Math.round(run.durationMs / 1000));
    parts.push(
      sec < 60
        ? tx(`${sec} 秒`, `${sec}s`, `${sec} s`, `${sec}s`)
        : tx(`${Math.round(sec / 60)} 分`, `${Math.round(sec / 60)}m`, `${Math.round(sec / 60)} min`, `${Math.round(sec / 60)}m`),
    );
  }
  return parts.join(" · ");
}


/** 打开任一期即把该任务的未读清零（对齐 ChatGPT「Scheduled 视图当收件箱」）。 */
function clearTaskUnread(convId: string) {
  const t = tasks.value.find((x) => (x.runs || []).some((r) => r.conversationId === convId));
  if (!t || !t.unreadRuns) return;
  t.unreadRuns = 0;
  void patchChatSchedule(t.id, { unreadRuns: 0 }).catch(() => undefined);
}

/** 菜单当前指向的定时任务（右键任务分组头时非空；此时菜单只渲染任务项）。 */
const ctxTargetTask = computed(() => tasks.value.find((t) => t.id === ctxMenu.value.taskId) || null);

/** 任务菜单动作：先收菜单再执行（与对话菜单项同口径）。 */
function ctxOpenTaskConv() {
  const t = ctxTargetTask.value;
  closeCtxMenu();
  if (t) void openTaskConversation(t);
}

function ctxRunTaskNow() {
  const t = ctxTargetTask.value;
  closeCtxMenu();
  if (t) void runTaskNow(t.id);
}

function ctxEditTask() {
  const t = ctxTargetTask.value;
  closeCtxMenu();
  if (t) openTaskForm(t);
}

function ctxToggleTaskEnabled() {
  const t = ctxTargetTask.value;
  closeCtxMenu();
  if (t) void toggleTask(t.id);
}

function ctxMarkTaskRead() {
  const t = ctxTargetTask.value;
  closeCtxMenu();
  if (!t || !t.unreadRuns) return;
  t.unreadRuns = 0;
  void patchChatSchedule(t.id, { unreadRuns: 0 }).catch(() => undefined);
}

function ctxRemoveTask() {
  const t = ctxTargetTask.value;
  closeCtxMenu();
  if (t) void removeTask(t.id);
}

async function toggleArchive(id: string) {
  const conv = conversations.value.find((c) => c.id === id);
  if (!conv) return;
  const archived = !conv.archived;
  const updated = await patchConversation(id, { archived }).catch(() => null);
  closeCtxMenu();
  if (!updated) return;
  if (archived && !showArchived.value) {
    conversations.value = conversations.value.filter((c) => c.id !== id);
    // 归档的是当前对话：它已从列表收起，切到仍可见的那条，避免侧栏没有任何选中项。
    if (currentId.value === id) {
      const next = conversations.value[0];
      if (next) selectConversation(next);
    }
  } else {
    conversations.value = conversations.value.map((c) => (c.id === id ? { ...c, archived } : c));
  }
  resortConversations();
}

/**
 * 免打扰：静默该对话的「后台任务完成」提醒（多会话并行时避免被打断）。
 * 只关提醒，不影响消息落库、侧栏状态点与拖拽排序；失败以服务端为准回滚。
 */
async function toggleMute(id: string) {
  const conv = conversations.value.find((c) => c.id === id);
  if (!conv) return;
  const muted = !conv.muted;
  closeCtxMenu();
  conversations.value = conversations.value.map((c) => (c.id === id ? { ...c, muted } : c));
  const updated = await patchConversation(id, { muted }).catch(() => null);
  if (!updated) {
    // 失败回滚：以服务端为唯一真相。
    conversations.value = conversations.value.map((c) => (c.id === id ? { ...c, muted: !muted } : c));
  }
}

/**
 * 完全访问：开 = 该对话的写/破坏性/外部操作不逐项弹确认卡、直接执行（默认开）。
 * 仅切「人审确认」，不影响免打扰等其它设置；失败以服务端为准回滚。
 */
async function toggleFullAccess(id: string) {
  const conv = conversations.value.find((c) => c.id === id);
  if (!conv) return;
  const fullAccess = !(conv.fullAccess ?? true);
  closeCtxMenu();
  conversations.value = conversations.value.map((c) => (c.id === id ? { ...c, fullAccess } : c));
  const updated = await patchConversation(id, { fullAccess }).catch(() => null);
  if (!updated) {
    conversations.value = conversations.value.map((c) => (c.id === id ? { ...c, fullAccess: !fullAccess } : c));
  }
}

/**
 * 发送模式：抢占式（默认，新消息接管旧轮）/ 排队等待（新消息入队，等上一轮成功收束后自动发）。
 * 纯设置：不中止当前正在生成的轮次，只从下一条消息起生效；多标签页以服务端会话文档为准。
 * 失败以服务端为唯一真相回滚。
 */
/** 草稿态（尚无会话）的发送模式待选值，创建会话时随设置一起落库。 */
const draftSendMode = ref<"preempt" | "queue">("preempt");
/** 当前会话的发送模式（草稿态用上面的待选值，默认抢占）。输入区按钮据此显示。 */
const currentSendMode = computed<"preempt" | "queue">(() => {
  if (currentId.value) return conversations.value.find((c) => c.id === currentId.value)?.sendMode ?? "preempt";
  return draftSendMode.value;
});

/** 输入区快捷切换：已有对话走持久化；草稿态只改本地，创建会话时随设置一起落库。 */
async function toggleSendModeForCurrent() {
  const next = currentSendMode.value === "preempt" ? "queue" : "preempt";
  if (currentId.value) {
    await toggleSendMode(currentId.value);
    return;
  }
  draftSendMode.value = next;
}

async function toggleSendMode(id: string) {
  const conv = conversations.value.find((c) => c.id === id);
  if (!conv) return;
  const current = conv.sendMode ?? "preempt";
  const sendMode = current === "preempt" ? "queue" : "preempt";
  closeCtxMenu();
  conversations.value = conversations.value.map((c) => (c.id === id ? { ...c, sendMode } : c));
  const updated = await patchConversation(id, { sendMode }).catch(() => null);
  if (!updated) {
    conversations.value = conversations.value.map((c) => (c.id === id ? { ...c, sendMode: current } : c));
  }
}

async function duplicateCurrent(id: string) {
  closeCtxMenu();
  const created = await duplicateConversation(id).catch(() => null);
  if (!created) return;
  if (showArchived.value || !created.archived) {
    conversations.value = [created, ...conversations.value];
    resortConversations();
  }
}

/** 导出对话为 MD / JSON：用隐藏 <a> 触发浏览器下载。 */
function exportConversation(id: string, format: "md" | "json") {
  closeCtxMenu();
  const a = document.createElement("a");
  a.href = conversationExportUrl(id, format);
  a.download = `conversation-${id}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 独立取消某一个正在运行的子代理（不影响主代理继续运行）。 */
async function cancelSubagent(bubbleId: number, subagentId: string) {
  const convId = currentId.value;
  if (!convId) return;
  try {
    await apiCancelSubagent(convId, subagentId);
    // 状态由服务端 subagent_end 事件回写（status=cancelled）；乐观更新只作兜底。
    const conv = states.get(convId);
    const bubble = conv?.bubbles.find((b) => b.id === bubbleId);
    const sa = bubble?.subagents?.find((s) => s.id === subagentId);
    if (sa && sa.status === "running") sa.status = "cancelled";
  } catch {
    /* 静默：取消失败不打断主流程 */
  }
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
      localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("重命名失败", "Rename failed", "Falha ao renomear", "नाम बदलने में विफल")),
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
      localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("置顶失败", "Pin failed", "Falha ao fixar", "पिन करने में विफल")),
    );
  }
}

// ---- 清空指定会话 ----

/** 清空某一会话（菜单里对非当前会话也能操作）：重置 UI 快照 + 服务端上下文。 */
async function clearConversationById(id: string) {
  closeCtxMenu();
  const state = states.get(id);
  if (state?.sending) {
    showSettingsError(tx("生成中，请先停止", "Still generating — stop it first", "Gerando resposta — pare antes", "उत्पन्न हो रहा है — पहले रोकें"));
    return;
  }
  // 等在途落库结束：否则 sending 已归零但 saveConversationMessages 仍在飞，后到的快照会把刚清的消息写回。
  await waitPendingPersists(id);
  if (state) {
    state.bubbles = [];
    state.error = "";
  }
  persistedCount.delete(id);
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
  // 归档对话不在「其它对话」之列：归档本就是把它收起来，批量关闭不该连带删掉看不见的对话。
  const others = conversations.value.filter((c) => c.id !== keepId && !c.archived);
  for (const c of others) {
    states.get(c.id)?.controllers?.forEach((c) => c.abort());
    states.delete(c.id);
    try {
      if (c.id) await apiDeleteConversation(c.id);
    } catch {
      /* ignore */
    }
  }
  conversations.value = conversations.value.filter((c) => c.id === keepId);
  void loadTasks(); // 批量删除也会清掉对应任务的运行记录，刷一次任务列表保持一致
  if (currentId.value !== keepId) {
    const keep = conversations.value[0];
    if (keep) selectConversation(keep);
  }
  closeCtxMenu();
}

/**
 * 头部「清空当前对话」的二次确认态：记录已进入待确认的对话 id（切换对话自然复位），
 * 5 秒内没有第二次点击则退回普通态——清空会丢上下文且没有撤销入口，值得挡一道。
 */
const clearArmedFor = ref("");
let clearArmTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * 是否处于待确认态。必须要求已有选中对话（currentId 非空）：
 * 首屏未选中时 currentId 与 clearArmedFor 都是空串，直接比较会被判等，
 * 刷新瞬间按钮会错误地闪成红色「确认清空（不可恢复）」。
 */
const clearArmed = computed(() => !!currentId.value && clearArmedFor.value === currentId.value);

/** 头部清空按钮：首点进入待确认，再点才真正清空。 */
function onClearCurrentClick() {
  const id = currentId.value;
  if (clearArmedFor.value !== id) {
    clearArmedFor.value = id;
    if (clearArmTimer) clearTimeout(clearArmTimer);
    clearArmTimer = setTimeout(() => {
      clearArmedFor.value = "";
    }, 5000);
    return;
  }
  if (clearArmTimer) clearTimeout(clearArmTimer);
  clearArmedFor.value = "";
  void clearCurrent();
}

async function clearCurrent() {
  const state = current.value;
  if (state.sending) return;
  // 等在途落库结束（详见 waitPendingPersists 注释）：清空守卫只看 sending，盖不住 persist 的请求窗口。
  if (currentId.value) await waitPendingPersists(currentId.value);
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
  if (state?.bubbles.some((b) => b.pending || b.clarification)) return "pending";
  if (state?.error) return "error";
  if (state?.sending || conv.running) return "running";
  return "";
}

function convStatusText(status: ReturnType<typeof convStatus>): string {
  if (status === "running") return tx("生成中", "Generating", "Gerando", "उत्पन्न हो रहा है");
  if (status === "pending") return tx("待确认", "Waiting for approval", "Aguardando aprovação", "अनुमोदन प्रतीक्षित");
  if (status === "error") return tx("出错了", "Error", "Erro", "त्रुटि");
  return "";
}

async function pickFiles(event: Event) {
  const el = event.target as HTMLInputElement;
  const files = Array.from(el.files || []);
  el.value = "";
  if (!files.length) return;
  const state = current.value;
  // 图片走 vision 通道；文档（PDF/Word/Excel/md/txt/csv）走附件通道，由服务端解析后注入上下文。
  const imageFiles: File[] = [];
  const docFiles: File[] = [];
  for (const f of files) {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    if (f.type.startsWith("image/") || ["png", "jpg", "jpeg", "webp"].includes(ext)) imageFiles.push(f);
    else docFiles.push(f);
  }
  try {
    if (imageFiles.length) state.pendingImages.push(...(await uploadFiles(imageFiles)));
    if (docFiles.length) state.pendingDocs.push(...(await uploadFiles(docFiles)));
  } catch (err) {
    state.bubbles.push({
      id: ++seq,
      role: "assistant",
      at: Date.now(),
      text: localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("上传失败", "Upload failed", "Falha no upload", "अपलोड विफल")),
    });
  }
}

/** 移除一张待发图片（模板里不能用 `current.pendingImages = ...` 直接赋值，故提供方法）。 */
function removePendingImage(id: string) {
  const state = current.value;
  state.pendingImages = state.pendingImages.filter((i) => i.id !== id);
}

/** 移除一个待发文档附件。 */
function removePendingDoc(id: string) {
  const state = current.value;
  state.pendingDocs = state.pendingDocs.filter((i) => i.id !== id);
}

/** 队列容量上限：超过拒绝入队，避免无限堆积。 */
const MAX_QUEUE = 20;
/** 整队列写串行链：重排 / 编辑 / 删除走整数组 PATCH，同页内串行避免彼此交错；出入队走原子端点不受此限。 */
const queueSetChains = new Map<string, Promise<unknown>>();

/**
 * 忙时入队（排队语义）：走服务端原子 $push，避免多标签 / 自动出队并发整体覆盖丢项（B6）。
 * 返回是否真的入队成功：调用方据此决定能否显示「已入队」——失败时消息既没发也没排，必须如实告知。
 */
async function enqueueMessage(convId: string, text: string, imageIds: string[], docIds: string[] = []): Promise<boolean> {
  const state = stateOf(convId);
  if (state.queue.length >= MAX_QUEUE) {
    showSettingsError(tx("排队消息已达上限，请先处理队列", "The queue is full; handle it first", "A fila está cheia; resolva-a primeiro", "कतार भरी हुई है; पहले उसे संभालें"));
    return false;
  }
  const item: PendingMessage = {
    text,
    ...(imageIds.length ? { images: imageIds } : {}),
    ...(docIds.length ? { docs: docIds } : {}),
    at: Date.now(),
  };
  const prev = state.queue;
  try {
    // 服务端原子追加并返回完整队列：本地直接用它同步，顺带看到其它标签页并发入的项。
    const res = await enqueueConversationMessage(convId, item);
    state.queue = res.pendingQueue;
    syncConvLocal(convId, { pendingQueue: res.pendingQueue });
    return true;
  } catch (err) {
    state.queue = prev;
    showSettingsError(
      localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("排队失败", "Failed to queue message", "Falha ao enfileirar", "कतार में जोड़ने में विफल")),
    );
    return false;
  }
}

/** 队列变更（上移/下移/删除/编辑）统一走这里：乐观 + 失败回滚。 */
async function setQueue(convId: string, next: PendingMessage[]): Promise<void> {
  const state = states.get(convId);
  if (!state) return;
  const prevChain = queueSetChains.get(convId) || Promise.resolve();
  const task = prevChain.catch(() => undefined).then(async () => {
    const prev = state.queue;
    state.queue = next;
    try {
      await patchConversation(convId, { pendingQueue: next });
      syncConvLocal(convId, { pendingQueue: next });
    } catch (err) {
      state.queue = prev;
      showSettingsError(
        localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("队列保存失败", "Failed to save queue", "Falha ao salvar a fila", "कतार सहेजने में विफल")),
      );
    }
  });
  queueSetChains.set(convId, task);
  void task.finally(() => {
    if (queueSetChains.get(convId) === task) queueSetChains.delete(convId);
  });
  return task;
}

/**
 * turn 收束后的出队：只有**成功**收束才继续。
 * 出错 / 被停止 / 还有待确认 → 停下等用户（决议 §11.2：不要在出错时自动刷下一句）。
 */
async function drainQueue(convId: string, ok: boolean) {
  const state = states.get(convId);
  if (!state || !ok || state.sending || !state.queue.length) return;
  // 原子出队：服务端一次操作移除并返回队首（多标签 / watchAndDrain 并发不会各拿同一条）。
  let next: PendingMessage;
  let rest: PendingMessage[];
  try {
    const res = await dequeueConversationMessage(convId);
    if (!res.item) {
      // 并发下别的出队已取空：以服务端为准同步本地，不发送。
      state.queue = res.pendingQueue;
      syncConvLocal(convId, { pendingQueue: res.pendingQueue });
      return;
    }
    next = res.item;
    rest = res.pendingQueue;
  } catch {
    // 出队端点失败（网络）：退回本地队首，仍不落库——下次同步会以服务端为准纠正。
    [next, ...rest] = state.queue;
  }
  state.queue = rest;
  syncConvLocal(convId, { pendingQueue: rest });
  await runTurn(convId, next.text, next.images || [], undefined, next.docs || []);
}

async function send() {
  const state = current.value;
  // R08：同步原子标志——并发双击 / 同步双触发时，第二次调用在 runTurn 同步置位 sending 之前就看到 dispatching 而返回，
  // 避免同一条消息开两个 run（双流）。runTurn 同步部分会把 state.sending 置 true 后再释放本标志。
  if (state.dispatching) return;
  state.dispatching = true;
  let released = false;
  try {
    let convId = currentId.value;
    const text = state.input.trim();
    if (!text && !state.pendingImages.length && !state.pendingDocs.length) return;
    setFollowBottom(true); // 用户发送：无条件回底（新一轮回复从底部开始展示）
    if (!convId) {
      // 草稿态首条消息：此刻才创建会话入列表（对齐 CodeBuddy）；失败则保留输入不丢内容。
      convId = await createConvFromDraft(text);
      if (!convId) return;
    }
    // 默认抢占档（§4 Interrupt）：runTurn 直接开新 run 抢占旧生成；仅当服务端回 409（queue 档 / 无人值守占用）
    // 才转入待发队列。runTurn 同步部分会把 sending 置位，此后并发发送会再开一个 run 而非重复同一轮。
    const images = state.pendingImages.slice();
    const docs = state.pendingDocs.slice();
    state.input = "";
    state.pendingImages = [];
    state.pendingDocs = [];
    queueScroll(true);
    // 同步启动 runTurn 到它的第一个 await（此刻 state.sending 已置 true），随后释放 dispatching：
    const turn = runTurn(
      convId,
      text,
      images.map((i) => i.id),
      images.map((i) => ({ id: i.id, name: i.name })),
      docs.map((i) => i.id),
    );
    state.dispatching = false;
    released = true;
    await turn;
  } finally {
    if (!released && current.value) current.value.dispatching = false;
  }
}

/** 断线续传的重试策略：指数退避（对齐「可恢复流」的客户端自动重连），退避耗尽才如实宣告中断。 */
const RESUME_ATTEMPTS = 3;
const RESUME_BACKOFF_MS = 600;

// 「非模型故障」终态码集合已上移到 api.ts（/movie 页共用同一份口径），这里直接 import 使用。

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 一轮运行的上下文。
 * 原先是 `runTurn` 里的闭包变量；抽出来是为了让「断线续传」复用**同一套事件处理**——
 * 续传不是另写一条渲染路径，而是把后续事件重新接回同一个气泡，避免两份渲染逻辑各自演化。
 */
interface TurnRun {
  convId: string;
  reply: Bubble;
  state: ConvState;
  /** 本轮请求的模型。自动模式传 auto，真正跑起来的模型以服务端 model 事件为准。 */
  chosenModel: string;
  /** 服务端实际用上的模型（自动模式换过模型之后是换成的那个）。 */
  servedModel?: string;
  /** 是否收到过终态事件（done / 服务端 error）：没收到就结束的流 = 中断，必须收口。 */
  sawTerminal: boolean;
  /** 本轮被抢占 / 取消（cancelled 事件）：收尾不算成功，不触发队列出队（applyStreamEvent 置位）。 */
  cancelled?: boolean;
  /** 已消费到的最后一个事件序号 = 续传游标（服务端据它只回放更新的部分）。 */
  lastSeq: number;
  /** 本轮的任务 id（`POST /chat/stream` 的响应头给出）：续传时带回去，确认接的还是**同一轮**。 */
  taskId?: string;
  /** 服务端终态错误码（决定要不要把该模型记进失败黑名单）。 */
  serverErrorCode?: string;
}

/**
 * 把一条服务端事件应用到气泡上。分支在 chat-stream.ts，这里只接上页面自己的滚动和文案。
 */
function applyChatEvent(run: TurnRun, event: ChatEvent): void {
  // 事件应用**之前**先量底部位置：增量把气泡撑高之后再量就成了「用户已上滚」，跟着就断了。
  const wasAtBottom = currentId.value === run.convId && atBottomNow();
  applyStreamEvent(run, event, {
    thinkPhaseEnd,
    thinkPhaseStart,
    queueScrollIfCurrent,
    stickThinkingToBottom,
    scheduleConfirmExpiry,
    localizeError: (token, fallback) => localizeToken(uiLocale.value, token, fallback),
    localizeStopMarker: () =>
      tx("（已停止生成）", " (stopped)", "(geração interrompida)", "(उत्पादन रोक दिया गया)"),
    openReasoning: openReasoningPanel,
    closeReasoning: closeReasoningPanel,
    rememberModel: (id) => {
      lastGoodModelId.value = id;
    },
  });
  // 用户本来贴着底部 → 强制回底，让增量继续跟着走（流式正文要能一路看到底）。
  if (wasAtBottom) queueScroll(true);
}

/**
 * 断线后自动续传（按游标 + 指数退避重试）。
 * 返回 true = 已接上并跑到终态（事件走同一套 `applyChatEvent`，含最终 `done`）；
 * 返回 false = 服务端已没有该任务（进程重启后注册表为空 / 收束后留档过期）或重试耗尽 ——
 * 由调用方如实收口，不假装还在跑。
 */
async function resumeRun(run: TurnRun, signal: AbortSignal): Promise<boolean> {
  for (let attempt = 0; attempt < RESUME_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(RESUME_BACKOFF_MS * 2 ** (attempt - 1));
    if (signal.aborted || run.sawTerminal) break;
    try {
      // 服务端没有可续传的任务时返回 false（不抛错）：直接走「如实收口」分支。
      // 游标带上 taskId：确认接的还是**这一轮**（同对话里旧游标遇到新一轮事件会串流）。
      await resumeChatTaskEvents(
        run.convId,
        { from: run.lastSeq, ...(run.taskId ? { taskId: run.taskId } : {}) },
        (event) => applyChatEvent(run, event),
        signal,
      );
    } catch {
      /* 连接仍不通：退避后重试 */
    }
    if (run.sawTerminal) return true;
    // 事件流结束但没有终态：确认任务是否还在跑——已收束且留档过期就没必要继续重试。
    if (!(await isChatTaskRunning(run.convId).catch(() => false))) break;
  }
  return run.sawTerminal;
}

/**
 * 一轮对话的主流程（模型流式 + 工具循环渲染）。
 * 单独抽出是为了让「队列自动出队」与「立即发送」复用同一条路径；
 * 注意模型取自**该对话**的设置，而不是当前展示的对话（后台出队时二者不同）。
 */
async function runTurn(
  convId: string,
  text: string,
  imageIds: string[],
  thumbnails?: Array<{ id: string; name: string }>,
  docIds: string[] = [],
) {
  const state = stateOf(convId);
  // 默认抢占语义（§4 Interrupt 档）：同一对话正在生成时，新发送直接开新 run 并取消旧轮；
  // 仅服务端回 409（queue 档 / 无人值守占用，见下方 catch）才转入队列。多轮可并发（runCount 驱动 sending），
  // 被抢占的旧轮次收到 cancelled 事件后其气泡显示「已停止生成」。
  const sentAt = Date.now();
  const userBubble: Bubble = {
    id: ++seq,
    role: "user",
    at: sentAt,
    text,
    images: thumbnails || imageIds.map((id) => ({ id, name: id })),
  };
  state.bubbles.push(userBubble);
  // 必须用 reactive 包装：若 push 原始对象、之后又用原引用改属性，Vue 3 不会触发重渲染
  // （表现：流式文字不逐步显示、工具步骤与确认卡在等待期间不出现 → 确认必然超时）。
  const reply = reactive<Bubble>({
    id: ++seq,
    role: "assistant",
    at: sentAt,
    text: "",
    streaming: true,
    steps: [],
    pending: null,
    clarification: null,
    subagents: [],
  });
  state.bubbles.push(reply);
  // 流式开始即展开推理面板：loading 期直接显示「正在规划…」，避免只剩空白/圆点像卡死。
  openReasoning.add(reply.id);
  state.runCount += 1;
  state.sending = true;
  // 抢占意味着与现存 run 并发：标记后本周期内每次收束都全量落库（增量水位在并发下会漏中间项的终态）。
  if (state.runCount > 1) state.hadConcurrent = true;
  state.error = "";
  // 新一轮从底部开始：用户可能正停在历史上方，Enter 发送必须回到最底（不受 240px 跟随阈值限制）。
  if (currentId.value === convId) queueScroll(true);
  // 模型取自该对话自己的设置（后台出队时可能与当前展示的不同）。
  // 失效 id 无需在此特殊处理：resolveModel 对查不到的 id 与 auto 走同一条回落链。
  const selected = state.settings.modelId || MODEL_AUTO_ID;
  // 自动模式把挑选权交给服务端：402 / 500 会当场换下一个还能用的模型，而不是先钉死一个再失败。
  const chosenModel = selected === MODEL_AUTO_ID ? MODEL_AUTO_ID : resolveModel(selected);
  // 中断句柄存进「该对话自己的」状态：切到别的对话后按停止不会误伤这一条。
  const controller = new AbortController();
  state.controllers.push(controller);

  // 本轮上下文：事件处理与续传共用同一个对象（游标 lastSeq 随事件推进）。
  const run: TurnRun = { convId, reply, state, chosenModel, sawTerminal: false, lastSeq: 0 };
  let stopped = false;
  let queued = false;
  let interrupted = false;
  try {
    await streamChat(
      text,
      // conversationId 显式带上：不依赖服务端的活跃对话回退（多标签页时会串）；agentId 供服务端按角色分流。
      { conversationId: convId, model: chosenModel || undefined, images: imageIds, attachments: docIds, agentId: AGENT_ID, timeZone: browserTimeZone() },
      (event) => applyChatEvent(run, event),
      controller.signal,
      // 任务 id 在响应头到达时立刻记下（流中途断开就拿不到返回值了），续传时带回去防跨轮串流。
      (info) => {
        if (info.taskId) run.taskId = info.taskId;
      },
    );
    // 流结束了却一个终态事件都没收到：连接在收尾前就断了（服务端进程重启 / 代理切断 / 连接被回收）。
    // 先按游标自动续传（可恢复流的客户端重连 + 精确续读）；服务端确实没有这个任务时才如实收口，
    // 否则推理面板会永久转圈。
    if (!run.sawTerminal && !stopped) {
      if (!(await resumeRun(run, controller.signal))) {
        interrupted = true;
        await settleInterruptedRun(run);
      }
    }
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      stopped = true;
      reply.text = reply.text ? `${reply.text}\n\n${tx("（已停止生成）", " (stopped)", " (geração interrompida)", " (उत्पादन रोक दिया गया)")}` : tx("（已停止生成）", "(stopped)", "(geração interrompida)", "(उत्पादन रोक दिया गया)");
    } else if (getApiErrorCode(err) === "CONVERSATION_BUSY") {
      // 服务端并发保护（如另一标签页在跑）：进队列等下一轮自动发。
      // 对齐主流产品（Claude/ChatGPT）：待发消息只在「待发队列」里显示一次，不在对话流里留占位气泡——
      // 入队成功后撤回刚 push 的 user/reply 气泡，等出队发送时再由 runTurn 真正建一对气泡，
      // 避免同一条消息出现两组气泡 + 两次落库（用户会误以为上一轮被打断 / 消息发了两次）。
      // 只有入队真的成功才认作 queued：否则消息既没发出也没排上，不能谎报「已入队」，更不能启动守望。
      queued = await enqueueMessage(convId, text, imageIds, docIds);
      if (queued) {
        state.bubbles = state.bubbles.filter((b) => b.id !== userBubble.id && b.id !== reply.id);
        openReasoning.delete(reply.id);
        // 轻量提示替代占位气泡；待发内容在队列面板里可见。
        showSettingsError(
          tx("消息已排队，将在当前回复完成后发送", "Message queued; it will be sent when the current reply finishes", "Mensagem na fila; será enviada quando a resposta atual terminar", "संदेश कतार में है; वर्तमान उत्तर पूरे होने पर भेजा जाएगा"),
        );
        // 本标签页收不到「另一标签页那轮」的收束事件，必须自己守望占用释放后出队，否则队列卡死。
        watchAndDrain(convId);
      } else {
        reply.error = state.error = tx("消息未能入队，请重试", "Message could not be queued; please retry", "A mensagem não entrou na fila; tente novamente", "संदेश कतार में नहीं गया; कृपया पुनः प्रयास करें");
        if (!state.input) state.input = text;
      }
    } else {
      // 连接类错误（断网/刷新/代理断开）：执行与推送已解耦，后台任务可能仍在跑。
      // 先按游标续传（与「流无终态结束」同一条路径）；真接不上再查任务状态如实告知，
      // 绝不误报为生成失败，也不用「断开」覆盖掉已经产出的正文。
      if (!(await resumeRun(run, controller.signal))) {
        const backgroundRunning = await isChatTaskRunning(convId).catch(() => false);
        if (backgroundRunning) {
          reply.text = appendNotice(
            reply.text,
            tx(
              "（连接已中断，生成仍在后台继续；完成后重新打开该对话即可看到结果）",
              "(Connection lost; generation continues in the background — reopen this conversation to see the result)",
              "(Conexão perdida; a geração continua em segundo plano — reabra esta conversa para ver o resultado)",
              "(कनेक्शन टूट गया; निर्माण पृष्ठभूमि में जारी है — परिणाम देखने के लिए यह चैट दोबारा खोलें)",
            ),
          );
          watchBackgroundDone(convId);
        } else {
          const message = localizeToken(
            uiLocale.value,
            getApiErrorToken(err),
            (err as Error)?.message || "GENERIC_UNKNOWN_ERROR",
          );
          reply.error = message;
          state.error = message;
        }
      }
    }
    reply.streaming = false;
    // 异常退出（停止/断连/报错）也要把开着的思考段关掉，耗时才不会丢。
    thinkPhaseEnd(reply);
  } finally {
    state.runCount = Math.max(0, state.runCount - 1);
    state.sending = state.runCount > 0;
    state.controllers = state.controllers.filter((c) => c !== controller);
    // auto 模式：本轮失败则把该模型记入黑名单（下次解析跳过），成功则清除其失败标记。
    // 仅「模型真的不可用」计入——用户主动停止 / 对话繁忙 / 后台继续 / 中断 / 无进展收口 都不算。
    if (reply.error && !NOT_MODEL_FAULT_CODES.has(run.serverErrorCode || "")) failedModelIds.value.add(chosenModel);
    else failedModelIds.value.delete(chosenModel);
    // 显式带上 convId：此刻用户可能已经切到别的对话，不能写错对话。
    // 曾并发过（hadConcurrent）或本轮入队撤回过气泡（queued）则全量落库：本地 bubbles 是 UI 真相源，
    // 全量替换把「半截中间项 / 重复提问 / 已撤回的入队占位」一并修正，确保服务端不残留重复气泡。
    await persist(convId, state.bubbles, state.hadConcurrent || queued);
    if (state.runCount === 0) state.hadConcurrent = false;
    queueScrollIfCurrent(convId);
    // 出队决策：停止 / 中断 / 出错 / 已再入队 / 仍有待确认 / 被抢占取消 → 停下等用户，不自动发下一条。
    // 被抢占的旧 run（run.cancelled）虽然可能以 wrapup 正常收尾，但它不是「本轮成功」，不能替最新一轮触发出队。
    void drainQueue(convId, !stopped && !interrupted && !queued && !reply.error && !reply.pending && !run.cancelled);
  }
}

/** 停止只作用于「当前正在看的这个对话」，不影响其它对话的流。
 *  执行与推送解耦后，断开连接不再中止生成——必须显式调取消端点。 */
function stop() {
  const convId = currentId.value;
  for (const c of current.value.controllers) c.abort();
  if (convId) void cancelChatTask(convId).catch(() => undefined);
}

// ---- 后台任务完成提醒（免打扰的作用对象）----
// 场景：多会话并行 —— 用户切走后任务仍在后台跑，跑完给一次提醒；该对话免打扰则静默。
const doneToast = ref<{ id: string; title: string } | null>(null);
let doneToastTimer: ReturnType<typeof setTimeout> | null = null;
const bgWatch = new Map<string, ReturnType<typeof setInterval>>();
/** 409 入队后守望「占用释放」的定时器（与完成提醒分开：前者要出队，后者只弹 toast）。 */
const queueWatch = new Map<string, ReturnType<typeof setInterval>>();
/** 组件已卸载：守望回调里 await 状态查询期间页面可能已销毁，返回后据此放弃出队/弹提醒。 */
let pageUnmounted = false;
/** 无句柄的延迟回调统一登记，卸载时清理；回调内也用 pageUnmounted 兜底。 */
const unmountTimers = new Set<ReturnType<typeof setTimeout>>();
function deferOnPage(fn: () => void, ms: number) {
  const t = setTimeout(() => {
    unmountTimers.delete(t);
    if (pageUnmounted) return;
    fn();
  }, ms);
  unmountTimers.add(t);
}

/**
 * 当前消息因 CONVERSATION_BUSY 入队后（常见：另一标签页正在生成），本标签页感知不到那轮结束，
 * 也没有后续 runTurn 收束来触发 drainQueue——队列会一直卡住。这里轮询到占用释放就出队。
 * 守望只持续到「本对话队列被清空」或超时（15 分钟）；占用是否释放由服务端任务状态判定，
 * 且只有上一轮成功收束才出队下一条（见下方）。
 */
function watchAndDrain(convId: string): void {
  if (queueWatch.has(convId)) return;
  let ticks = 0;
  const timer = setInterval(async () => {
    ticks += 1;
    const state = states.get(convId);
    // 只在队列真被清空（别处已出队）时注销；不能因 state.sending 为真就注销——
    // sending 是本标签页状态，与「服务端那轮占用是否释放」独立；queue 档下入队的那条正是靠这个守望出队，
    // 若在另一条 409 的 sending 窗口里被误注销，队列就再也无出队入口（卡死）。
    if (!state || !state.queue.length) {
      clearInterval(timer);
      queueWatch.delete(convId);
      return;
    }
    const status = await fetchChatTaskStatus(convId).catch(() => null);
    // await 期间页面可能已卸载：此时绝不能出队发消息（clearInterval 挡不住已在途的回调）。
    if (pageUnmounted) return;
    // 查询失败 / 上一轮仍在跑：继续等（最多守望 15 分钟）。只有查到明确「没在跑」才判定终态。
    if (!status || status.running) {
      if (ticks >= 180) {
        clearInterval(timer);
        queueWatch.delete(convId);
      }
      return;
    }
    clearInterval(timer);
    queueWatch.delete(convId);
    // 只有上一轮「成功收束」才自动发下一条；失败 / 被取消 / 中断都停下等用户决定（对齐 §4.6）。
    // last 为空（任务已过 retain 期，无法判定终态）时保守不发，避免误把失败轮当成功。
    if (status.last?.status === "success") void drainQueue(convId, true);
  }, 5000);
  queueWatch.set(convId, timer);
}

function showDoneToast(id: string, title: string) {
  doneToast.value = { id, title: title || tx("新对话", "New chat", "Nova conversa", "नई चैट") };
  if (doneToastTimer) clearTimeout(doneToastTimer);
  doneToastTimer = setTimeout(() => (doneToast.value = null), 8000);
}

function openDoneToast() {
  const target = doneToast.value;
  if (!target) return;
  const conv = conversations.value.find((c) => c.id === target.id);
  doneToast.value = null;
  if (conv) selectConversation(conv);
}

/**
 * 守着某个对话的后台任务：running → 结束 时提醒一次（除非该对话免打扰或用户正看着它）。
 * 轮询间隔 5s、最长守 15 分钟（超时静默放弃，避免长期空转）。
 */
function watchBackgroundDone(convId: string) {
  if (!convId || bgWatch.has(convId)) return;
  let ticks = 0;
  const timer = setInterval(async () => {
    ticks += 1;
    const status = await fetchChatTaskStatus(convId).catch(() => null);
    // await 期间页面可能已卸载：此时不弹完成提醒（clearInterval 挡不住已在途的回调）。
    if (pageUnmounted) return;
    // 查询失败（瞬时网络抖动）不能当成「任务已结束」放弃守望：继续轮询到 15 分钟上限。
    if (!status) {
      if (ticks >= 180) {
        clearInterval(timer);
        bgWatch.delete(convId);
      }
      return;
    }
    if (status.running && ticks < 180) return;
    clearInterval(timer);
    bgWatch.delete(convId);
    if (status.running) return; // 超时：不再打扰
    // 只报「真正成功完成」：被抢占 / 用户停止 / 中断都不该说「已完成」（否则用户以为有结果可看）。
    // last 已过 retain 期为空时保守不报，避免误报。
    if (status.last?.status && status.last.status !== "success") return;
    if (!status.last) return;
    const conv = conversations.value.find((c) => c.id === convId);
    // 免打扰 / 用户正看着这个对话 / 对话已删除 → 不提醒。
    if (!conv || conv.muted || convId === currentId.value) return;
    showDoneToast(convId, conv.title);
  }, 5000);
  bgWatch.set(convId, timer);
}

/** 给正文追加一行提示（空正文不留前导空行）。 */
function appendNotice(text: string, line: string): string {
  return text ? `${text}\n\n${line}` : line;
}

/**
 * 收口一次「没等到任何终态事件就结束」的轮次（服务端进程重启 / 连接被回收 / 代理切断都会这样）。
 * 调用前提：**续传已经试过并失败**（`resumeRun` 返回 false）——所以这里只做如实收尾，不重试。
 * 与服务端同一原则：**不猜结果**，只问服务端这个对话的任务还在不在——
 * - 还在跑（续传只是网络不通）：如实说「后台继续」并守望完成（结果由服务端回投到该对话）；
 * - 不在跑（进程重启后注册表为空 / 收束后留档过期）：把还挂着的步骤与子代理标成中断，并给出可操作提示。
 * 半路挂起的确认卡一并清掉：票据大概率已随进程失效，留着只会让用户点一个注定失败的按钮。
 */
async function settleInterruptedRun(run: TurnRun): Promise<void> {
  const { convId, reply } = run;
  reply.streaming = false;
  thinkPhaseEnd(reply);
  for (const step of reply.steps || []) {
    if (step.status !== "running") continue;
    step.status = "interrupted";
    step.result =
      step.result ||
      tx(
        "未收到执行结果（连接中断）",
        "No result received (connection lost)",
        "Nenhum resultado recebido (conexão perdida)",
        "कोई परिणाम नहीं मिला (कनेक्शन टूटा)",
      );
  }
  for (const sa of reply.subagents || []) {
    if (sa.status === "running") sa.status = "interrupted";
  }
  reply.pending = null;
  reply.clarification = null;
  const backgroundRunning = await isChatTaskRunning(convId).catch(() => false);
  reply.text = appendNotice(
    reply.text,
    backgroundRunning
      ? tx(
          "（连接已中断，生成仍在后台继续；完成后会自动出现在这个对话里）",
          "(Connection lost; generation continues in the background and will show up in this conversation)",
          "(Conexão perdida; a geração continua em segundo plano e aparecerá nesta conversa)",
          "(कनेक्शन टूट गया; निर्माण पृष्ठभूमि में जारी है और इसी चैट में दिखेगा)",
        )
      : tx(
          "（本轮已中断：连接结束且服务端没有在跑的任务，未完成的部分请重新发起）",
          "(This turn was interrupted — the connection ended and no task is running on the server; please retry)",
          "(Este turno foi interrompido — a conexão terminou e não há tarefa em execução no servidor; tente novamente)",
          "(यह चरण बाधित हुआ — कनेक्शन समाप्त और सर्वर पर कोई कार्य नहीं चल रहा; कृपया फिर से प्रयास करें)",
        ),
  );
  if (backgroundRunning) watchBackgroundDone(convId);
  closeReasoningPanel(reply.id);
  queueScrollIfCurrent(convId);
}

/**
 * 把本期提问补进对话。定时任务每期正文相同，上一期那条不能算本期已经显示。
 * 正在流式的助手气泡留在最后，提问插在它前面。
 */
function ensureRunPrompt(state: ConvState, userText: string, startedAt: number): void {
  const text = userText.trim();
  if (!text || !startedAt) return;
  const floor = startedAt - 2000;
  const belongs = (bubble: Bubble | undefined) =>
    !!bubble && bubble.role === "user" && bubble.text === text && (bubble.at || 0) >= floor;
  const last = state.bubbles[state.bubbles.length - 1];
  const prev = state.bubbles[state.bubbles.length - 2];
  if (belongs(last) || (belongs(prev) && last?.role === "assistant")) return;
  // 补这条提问会把对话撑高一大截（定时任务的正文很长）：先量「用户本来贴不贴底部」，
  // 撑高之后强制回底——否则停在页面上的用户压根看不见这一轮从哪开始（看着像"没反应"）。
  const wasAtBottom = state === current.value && atBottomNow();
  const prompt: Bubble = { id: ++seq, role: "user", at: startedAt, text };
  if (last?.streaming) state.bubbles.splice(state.bubbles.length - 1, 0, prompt);
  else state.bubbles.push(prompt);
  if (wasAtBottom) queueScroll(true);
}

/**
 * 打开对话时若服务端仍有本对话的任务在跑：就地挂一个气泡跟随（游标 0 = 从头回放）。
 * 场景是刷新 / 换标签页 / 换设备进来——之前的表现是「界面上什么都看不到，只能等结果回投」，
 * 对齐最佳实践：重新挂上正在跑的流（客户端刷新后应接回当前 run，而不是从零等）。
 * 已在发送或已有流式气泡时不重复挂；服务端没有可续的内容就撤掉这个只为跟随而生的气泡，
 * 不留一条凭空的「已中断」记录给用户。
 */
async function attachRunningTask(convId: string): Promise<void> {
  const state = states.get(convId);
  if (!state || state.sending || state.bubbles.some((b) => b.streaming)) return;
  // 查状态时顺带拿**这一轮**的 task id：续传请求带上它，避免接错轮次。
  const status = await fetchChatTaskStatus(convId).catch(() => null);
  if (!status?.running) return;
  // 二次确认：等待期间用户可能已经发了新消息，或别的路径已经接上了。
  const fresh = states.get(convId);
  if (!fresh || fresh.sending || fresh.bubbles.some((b) => b.streaming)) return;
  // 快照可能还没有这句提问（落库和刷新撞在一起）。先补上用户气泡，再挂助手占位，
  // 否则刷新后只剩一个空的「正在规划」，看起来像提问丢了、也像没反应。
  ensureRunPrompt(fresh, status.task?.userText || "", status.task?.startedAt || 0);
  const reply = reactive<Bubble>({
    id: ++seq,
    role: "assistant",
    at: Date.now(),
    text: "",
    streaming: true,
    steps: [],
    pending: null,
    clarification: null,
    subagents: [],
  });
  fresh.bubbles.push(reply);
  openReasoning.add(reply.id);
  const run: TurnRun = {
    convId,
    reply,
    state: fresh,
    chosenModel: resolveModel(fresh.settings.modelId),
    sawTerminal: false,
    lastSeq: 0,
    ...(status.task?.id ? { taskId: status.task.id } : {}),
  };
  const controller = new AbortController();
  fresh.controllers.push(controller);
  fresh.runCount += 1;
  fresh.sending = true;
  // 与 runTurn 同口径：attach 时若已有别的 run 在跑（罕见，入口有 sending/streaming 守卫），同样标记并发。
  if (fresh.runCount > 1) fresh.hadConcurrent = true;
  try {
    const attached = await resumeChatTaskEvents(
      convId,
      { from: 0, ...(run.taskId ? { taskId: run.taskId } : {}) },
      (event) => applyChatEvent(run, event),
      controller.signal,
    );
    if (!attached) {
      fresh.bubbles = fresh.bubbles.filter((b) => b.id !== reply.id);
      closeReasoningPanel(reply.id);
      return;
    }
    // 挂上了却没跑到终态（连接又断）：与首连同一条路径——先退避续传，仍不行才如实收口。
    if (!run.sawTerminal && !(await resumeRun(run, controller.signal))) await settleInterruptedRun(run);
  } catch {
    // 网络不通 / 用户按了停止：留下气泡并如实说明这一轮没能拿到终态（不假装还在跑）。
    await settleInterruptedRun(run);
  } finally {
    fresh.runCount = Math.max(0, fresh.runCount - 1);
    fresh.sending = fresh.runCount > 0;
    fresh.controllers = fresh.controllers.filter((c) => c !== controller);
    reply.streaming = false;
    thinkPhaseEnd(reply);
    openReasoning.delete(reply.id);
    // 与 runTurn finally 同口径：并发周期内全量落库，归零后复位。
    await persist(convId, fresh.bubbles, fresh.hadConcurrent);
    if (fresh.runCount === 0) fresh.hadConcurrent = false;
    queueScrollIfCurrent(convId);
  }
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

/** 立即发送的同步派发标志：本函数在 runTurn 前有多段 await，快速双击会各自起一个 run（R08 同类问题）。 */
let queueNowDispatching = false;
/** 立即发送 = 中断当前生成 + 立刻发出这条（决议 C：主动权交给用户）。 */
async function sendQueueItemNow(index: number) {
  if (queueNowDispatching) return;
  queueNowDispatching = true;
  try {
    const convId = currentId.value;
    const state = current.value;
    const item = state.queue[index];
    if (!convId || !item) return;
    const rest = state.queue.filter((_, i) => i !== index);
    state.queue = rest;
    if (state.sending) {
      for (const c of state.controllers) c.abort();
      void cancelChatTask(convId).catch(() => undefined);
      // 等流真正收束（sending 翻转）再发，否则会被自己的并发保护再次入队。
      for (let i = 0; i < 20 && state.sending; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // 服务端任务收束有一瞬延迟：等注册表清空，避免「立即发送」被 409 再度入队。
      for (let i = 0; i < 15; i += 1) {
        if (!(await isChatTaskRunning(convId))) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    await setQueue(convId, rest);
    // 队列项里的图片/文档附件要原样带回本轮（漏传 docs 会让附件静默丢失）。
    await runTurn(convId, item.text, item.images || [], undefined, item.docs || []);
  } finally {
    queueNowDispatching = false;
  }
}

async function answerToolConfirm(bubble: Bubble, confirmed: boolean) {
  const pending = bubble.pending;
  if (!pending) return;
  bubble.pending = null;
  const step = (bubble.steps || []).find((s) => s.id === pending.id);
  if (step && !confirmed) {
    step.status = "cancelled";
    step.result = tx("已拒绝该工具调用", "Tool call denied", "Chamada de ferramenta recusada", "टूल कॉल अस्वीकृत");
  }
  await confirmToolCall(pending.ticket, confirmed, { grantRead: pending.grantRead === true }).catch((err) => {
    // 票据是一次性的且有有效期：超时、已在别处应答、跨会话都会走到这里。
    // 静默吞错会让用户以为「点了没反应」——如实反馈，并标掉该步骤（服务端确实没执行）。
    if (step) {
      step.status = "error";
      step.result = tx(
        "确认已失效（超时或已处理），该操作未执行，请重新发起",
        "Confirmation expired (timed out or already handled) — nothing was executed; please retry",
        "Confirmação expirada (tempo esgotado ou já tratada) — nada foi executado; tente novamente",
        "पुष्टि समाप्त हो गई (समय समाप्त या पहले ही संसाधित) — कुछ भी निष्पादित नहीं हुआ; फिर से प्रयास करें",
      );
    }
    showSettingsError(
      localizeToken(
        uiLocale.value,
        getApiErrorToken(err),
        (err as Error)?.message ||
          tx("确认失败，操作未执行", "Confirmation failed — nothing executed", "Falha na confirmação — nada executado", "पुष्टि विफल — कुछ भी निष्पादित नहीं"),
      ),
    );
  });
}

/**
 * 澄清卡的自由文本补充（对齐「问题卡必须提供自由文本回退」的通行做法）：
 * 选项之外还能补充说明，避免用户只能点一个都不贴切的选项——点兜底项却不补充，模型拿到的是零信息。
 * 按气泡 id 暂存草稿。
 */
const clarifyDraft = ref<Record<number, string>>({});

async function submitClarifyFreeform(bubble: Bubble) {
  const text = (clarifyDraft.value[bubble.id] || "").trim();
  if (!text) return;
  clarifyDraft.value = { ...clarifyDraft.value, [bubble.id]: "" };
  await answerClarification(bubble, text);
}

/**
 * 应答结构化澄清：选中某个选项即把选项值回传；不带值 = 跳过（模型按自己的理解继续）。
 * 与确认卡共用票据通道（一次性 + 会话绑定），失效处理口径一致。
 */
async function answerClarification(bubble: Bubble, value?: string) {
  const ask = bubble.clarification;
  if (!ask) return;
  bubble.clarification = null;
  // 清掉自由文本草稿：避免同气泡稍后再出现澄清卡时带回上一轮的旧输入。
  delete clarifyDraft.value[bubble.id];
  const step = (bubble.steps || []).find((s) => s.id === ask.id);
  if (step) {
    step.status = "ok";
    step.result = value || tx("已跳过澄清", "Clarification skipped", "Esclarecimento ignorado", "स्पष्टीकरण छोड़ दिया");
  }
  await confirmToolCall(ask.ticket, true, { ...(value ? { value } : {}) }).catch((err) => {
    if (step) {
      step.status = "error";
      step.result = tx(
        "澄清已失效（超时或已处理），请重新发起",
        "Clarification expired (timed out or already handled) — please retry",
        "Esclarecimento expirado (tempo esgotado ou já tratado) — tente novamente",
        "स्पष्टीकरण समाप्त हो गया (समय समाप्त या पहले ही संसाधित) — फिर से प्रयास करें",
      );
    }
    showSettingsError(
      localizeToken(
        uiLocale.value,
        getApiErrorToken(err),
        (err as Error)?.message || tx("澄清应答失败", "Failed to answer clarification", "Falha ao responder", "उत्तर देने में विफल"),
      ),
    );
  });
}

/**
 * 确认票据到点自动作废（与服务端 fail-closed 一致，正常路径由服务端回执清卡）：
 * 兜底「流已断开 / 已切走对话导致回执丢失」时卡片一直挂着，用户点一个注定失败的按钮。
 */
function scheduleConfirmExpiry(reply: Bubble, expiresInMs?: number) {
  if (!expiresInMs || expiresInMs <= 0) return;
  const ticket = reply.pending?.ticket;
  if (!ticket) return;
  deferOnPage(() => {
    const pending = reply.pending;
    if (!pending || pending.ticket !== ticket) return;
    reply.pending = null;
    const step = (reply.steps || []).find((s) => s.id === pending.id);
    if (step && step.status === "running") {
      step.status = "cancelled";
      step.result = tx(
        "确认超时，未执行",
        "Confirmation timed out — not executed",
        "Confirmação expirada — não executado",
        "पुष्टि का समय समाप्त — निष्पादित नहीं",
      );
    }
  }, expiresInMs);
}

/** 确认卡风险级别徽标文案。 */
function confirmLevelText(level: NonNullable<Bubble["pending"]>["level"]): string {
  if (level === "read") return tx("只读", "read-only", "somente leitura", "केवल पढ़ने योग्य");
  if (level === "write") return tx("写操作", "write", "escrita", "लेखन");
  return tx("高风险", "destructive", "destrutivo", "उच्च जोखिम");
}

/** 确认卡有效期提示（服务端下发的票据时长；超时按拒绝处理）。 */
function confirmExpiryText(expiresInMs?: number): string {
  if (!expiresInMs || expiresInMs <= 0) return "";
  const seconds = Math.round(expiresInMs / 1000);
  return tx(
    `${seconds} 秒内有效，超时按拒绝处理`,
    `Valid for ${seconds}s — treated as denied if it times out`,
    `Válido por ${seconds}s — será tratado como recusado ao expirar`,
    `${seconds} सेकंड तक मान्य — समय समाप्त होने पर अस्वीकृत माना जाएगा`,
  );
}

/** 专家自带的数据源（客服 = 已接好的 SalesIQ）。不在连接器里当普通可选项关掉。 */
const boundMcpIds = computed(() => (AGENT_ID === "support" ? ["zoho-salesiq"] : []));

async function removeCustomMcp(id: string) {
  const ok = window.confirm(
    tx(
      "移除这个连接器？各对话里的勾选会一起去掉。",
      "Remove this connector? It will also be unchecked in every conversation.",
      "Remover este conector? Ele também será desmarcado em todas as conversas.",
      "यह कनेक्टर हटाएँ? सभी बातचीत से चयन भी हट जाएगा।",
    ),
  );
  if (!ok) return;
  mcpBusy.value = true;
  mcpError.value = "";
  try {
    await deleteCustomMcpServer(id);
    taskDraft.mcpServers = taskDraft.mcpServers.filter((item) => item !== id);
    if (currentId.value) await loadMcp(currentId.value);
    else await refreshMcpAvailable();
  } catch (err) {
    mcpError.value = localizeToken(
      uiLocale.value,
      getApiErrorToken(err),
      (err as Error)?.message || tx("操作失败", "Request failed", "Falha na solicitação", "अनुरोध विफल"),
    );
  } finally {
    mcpBusy.value = false;
  }
}

/**
 * 行内连接状态展示：按「所在作用域是否启用」感知，而不是直接透出服务端连接池状态。
 * 连接池是服务端进程级共享（其它对话建的连、空闲回收期内都活着），与当前作用域无关；
 * 直接透出会出现「复选框没勾却显示已连接」的自相矛盾。未启用的一律显示「未启用」，
 * 工具数仍保留展示（那是服务器能力信息，不随作用域变）。
 * @param enabled 该行的启用集：连接器面板传当前对话的启用集，任务表单传草稿的勾选集。
 */
function mcpRowState(
  s: McpServerStatus,
  enabled: readonly string[] = current.value.settings.mcpEnabled,
  bound = false,
): { cls: string; text: string } {
  // bound（客服自带）服务器恒为启用态、且不可在本面板关闭：跳过启用集判定，
  // 否则会出现「已启用」pin 与状态「未启用」并存的矛盾。
  if (!bound && !enabled.includes(s.id)) {
    return { cls: "idle", text: tx("未启用", "not enabled", "não ativado", "सक्षम नहीं") };
  }
  if (s.connected) return { cls: "ok", text: tx("已连接", "connected", "conectado", "कनेक्टेड") };
  if (s.connecting) return { cls: "running", text: tx("连接中", "connecting", "conectando", "कनेक्ट हो रहा है") };
  if (s.error) return { cls: "err", text: tx("失败", "failed", "falhou", "विफल") };
  return { cls: "idle", text: tx("未连接", "not connected", "não conectado", "कनेक्ट नहीं") };
}

/** 任务表单一行：作用域是「这个任务勾选了哪些」（草稿集），不是当前对话的启用集。 */
function taskRowState(s: McpServerStatus): { cls: string; text: string } {
  return mcpRowState(s, taskDraft.mcpServers);
}
const skillAvailable = ref<SkillMeta[]>([]);
const toolsRoot = ref<HTMLElement | null>(null);
// 专家菜单只列「有专门角色」的 Agent：观影助手属独立项目（/movie）不在此列，
// 通用助手是默认形态也不算专家；其余专家（如客服）在此列出。
const expertAgents: AgentEntry[] = AGENTS.filter((a) => a.id !== "movie" && a.id !== "generic");

/** 悬停菜单项即展开右侧飞出面板（与点击等价，但不抢焦点）。 */
function hoverFlyout(which: "skills" | "mcp" | "expert") {
  if (!toolsMenuOpen.value) return;
  if (which === "skills") openSkillPanel(false);
  if (which === "mcp") openMcpPanel(false);
  if (which === "expert") openExpertPanel(false);
}

/** Esc 收起工具菜单/飞出面板（键盘可达，不拦截输入框内容）。 */
function onEscTools(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  if (!toolsMenuOpen.value && !mcpOpen.value && !skillOpen.value && !expertOpen.value) return;
  toolsMenuOpen.value = false;
  mcpOpen.value = false;
  skillOpen.value = false;
  expertOpen.value = false;
}

function onOutsideTools(event: MouseEvent) {
  if (!toolsRoot.value?.contains(event.target as Node)) {
    toolsMenuOpen.value = false;
    mcpOpen.value = false;
    skillOpen.value = false;
    expertOpen.value = false;
  }
}

// ---- SCC B 工具面板：MCP / 技能 / 搜索 / 专家（共享状态留根，引用注入）----
const {
  mcpOpen,
  mcpBusy,
  mcpReconnecting,
  mcpError,
  patchMcpRow,
  loadMcp,
  openMcpPanel,
  isBoundMcp,
  bindingBoundMcp,
  ensureBoundMcp,
  toggleMcp,
  clearMcpSelection,
  reconnectMcp,
  skillOpen,
  skillAddOpen,
  mcpAddOpen,
  skillBusy,
  skillError,
  loadSkills,
  onChatSkillCreated,
  onTaskSkillCreated,
  onChatMcpCreated,
  onTaskMcpCreated,
  openSkillPanel,
  toggleSkill,
  clearSkillSelection,
  toolsMenuOpen,
  skillQuery,
  mcpQuery,
  searchAutofocus,
  skillFiltered,
  mcpFiltered,
  mcpBoundRows,
  mcpOptionalRows,
  mcpPanelRows,
  canClearOptionalMcp,
  enabledMcpCount,
  toggleToolsMenu,
  mcpDescText,
  expertOpen,
  expertStarters,
  currentExpert,
  composerPlaceholder,
  askStarter,
  expertQuery,
  expertFiltered,
  openExpertPanel,
  closeToolsPanels,
  onPickExpert,
  onClearExpert,
} = useChatToolPanels({
  agentId: AGENT_ID,
  currentId,
  current,
  states,
  stateOf,
  mcpAvailable,
  skillAvailable,
  expertAgents,
  boundMcpIds: () => boundMcpIds.value,
  taskDraft,
  taskSkillAddOpen,
  taskMcpAddOpen,
  mcpRowState,
  deferOnPage,
  syncConvLocal,
  send: () => send(),
  routerPush: (path) => router.push(path),
  refreshMcpAvailable: () => refreshMcpAvailable(),
  connectTaskMcp: (id) => connectTaskMcp(id),
  uiLocale,
  tx,
});

/** 列表项头像：按 key 稳定散列出一个色相 → 渐变底 + 首字符，对齐 ima 的彩色图标列表。 */
function iconStyle(key: string): Record<string, string> {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return {
    background: `linear-gradient(135deg, hsl(${h} 60% 52%), hsl(${(h + 42) % 360} 60% 40%))`,
  };
}

function iconChar(name: string): string {
  return [...name.trim()][0]?.toUpperCase() || "?";
}

// ---- 资源面板：长期记忆管理 + 对话工作区文件（只读）----

const resOpen = ref(false);
const resRoot = ref<HTMLElement | null>(null);
const memoryItems = ref<MemoryItemDto[]>([]);
const memoryText = ref("");
const memoryBusy = ref(false);
const wsFiles = ref<WorkspaceFile[]>([]);
const wsFileContent = ref<{ path: string; content: string } | null>(null);
const wsLoading = ref(false);

function onOutsideRes(event: MouseEvent) {
  if (!resRoot.value?.contains(event.target as Node)) resOpen.value = false;
}

function toggleResPanel() {
  resOpen.value = !resOpen.value;
  if (resOpen.value) {
    void loadMemory();
    void loadWorkspaceFiles();
  }
}

async function loadMemory() {
  memoryItems.value = await fetchMemory().catch(() => []);
}

async function addMemoryEntry() {
  const text = memoryText.value.trim();
  if (!text || memoryBusy.value) return;
  memoryBusy.value = true;
  try {
    const item = await addMemoryItem(text);
    if (item) {
      memoryItems.value = [item, ...memoryItems.value.filter((m) => m.id !== item.id)];
      memoryText.value = "";
    }
  } finally {
    memoryBusy.value = false;
  }
}

async function removeMemoryEntry(id: string) {
  if (await removeMemoryItem(id).catch(() => false)) {
    memoryItems.value = memoryItems.value.filter((m) => m.id !== id);
  }
}

async function loadWorkspaceFiles() {
  const convId = currentId.value;
  if (!convId) {
    wsFiles.value = [];
    wsFileContent.value = null;
    return;
  }
  wsLoading.value = true;
  try {
    wsFiles.value = await fetchWorkspaceFiles(convId).catch(() => []);
    wsFileContent.value = null;
  } finally {
    wsLoading.value = false;
  }
}

async function openWorkspaceFile(path: string) {
  const convId = currentId.value;
  if (!convId) return;
  const content = await readWorkspaceFile(convId, path).catch(() => "");
  wsFileContent.value = { path, content };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function stepClass(status: StepStatus): string {
  if (status === "ok") return "ok";
  // 未执行（闸门/跳过）：黄色警告——标成红色会让人以为工具自己坏了，实为「先去读技能/未授权」等。
  if (status === "refused") return "warn";
  if (status === "error" || status === "cancelled" || status === "interrupted") return "err";
  return "running";
}

function stepStatusText(status: StepStatus): string {
  if (status === "ok") return tx("已完成", "done", "concluído", "पूर्ण");
  if (status === "error") return tx("失败", "failed", "falhou", "विफल");
  if (status === "cancelled") return tx("已拒绝", "denied", "recusado", "अस्वीकृत");
  // 未执行 ≠ 失败：闸/跳过导致这一步没跑，标「失败」会误导（具体原因见步骤展开的提示文案）。
  if (status === "refused") return tx("未执行", "not run", "não executado", "निष्पादित नहीं");
  // 中断 ≠ 失败：不知道结果就如实说不知道（标成失败会让人以为工具自己报错了）。
  if (status === "interrupted") return tx("已中断", "interrupted", "interrompido", "बाधित");
  return tx("执行中", "running", "executando", "चल रहा है");
}

/** 子代理状态点：与步骤共用一套语义配色（运行中动效 / 出错红 / 其余灰）。 */
function subagentDotClass(status: SubagentStatus): string {
  if (status === "running") return "running";
  if (status === "error" || status === "interrupted") return "error";
  return "ok";
}

function subagentStatusText(status: SubagentStatus): string {
  if (status === "running") return tx("运行中", "running", "rodando", "चल रहा");
  if (status === "done") return tx("完成", "done", "concluído", "पूर्ण");
  if (status === "cancelled") return tx("已取消", "cancelled", "cancelado", "रद्द");
  if (status === "interrupted") return tx("已中断", "interrupted", "interrompido", "बाधित");
  return tx("失败", "failed", "falhou", "विफल");
}

/** 上下文用量的一行摘要（透明度：让用户知道用了多少、丢了什么）。 */
function usageText(usage: NonNullable<Bubble["usage"]>): string {
  const parts = [
    `${tx("上下文", "Context", "Contexto", "संदर्भ")}: ${usage.turns} ${tx("条历史", "history", "mensagens", "इतिहास")}`,
    `${usage.tokens}/${usage.budget} tokens`,
    `${tx("窗口", "window", "janela", "विंडो")} ${usage.window}`,
  ];
  if (usage.dropped) parts.push(`${tx("已丢弃较早消息", "dropped", "descartadas", "छोड़ी गई")} ${usage.dropped}`);
  if (usage.summarized) parts.push(tx("已生成历史摘要", "summary", "resumo", "सारांश"));
  if (usage.toolResultsCleared) parts.push(`${tx("已清理工具结果", "cleared", "limpas", "साफ़ की गई")} ${usage.toolResultsCleared}`);
  if (usage.toolResultsOffloaded) {
    parts.push(`${tx("已卸载到工作区", "offloaded", "transferidas", "ऑफलोड की गई")} ${usage.toolResultsOffloaded}`);
  }
  return parts.join(" · ");
}


/** 预警徽章的人话文案（协议标记 → 中/英/葡/印地）。 */
function alertChipText(marker: string): string {
  if (marker === "SPIKE") return tx("异常", "Alert", "Alerta", "अलर्ट");
  if (marker === "NORMAL") return tx("正常", "Normal", "Normal", "सामान्य");
  return tx("无数据", "No data", "Sem dados", "कोई डेटा नहीं");
}

/** 复制气泡文本（assistant 复制原始 markdown，user 复制纯文本），带瞬时反馈。 */
const copyToast = ref("");
let copyToastTimer: ReturnType<typeof setTimeout> | null = null;
async function copyBubble(b: Bubble) {
  try {
    await navigator.clipboard.writeText(bubbleBody(b));
    copyToast.value = tx("已复制", "Copied", "Copiado", "कॉपी हो गया");
  } catch {
    copyToast.value = tx("复制失败", "Copy failed", "Falha ao copiar", "कॉपी विफल");
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

/**
 * 行内输入框的回车提交同样要跳过 IME 合成态（同 renaming / composer 的处理）。
 * 之前这两处直接写 `@keydown.enter.prevent`，中文输入法选词的那一下回车会被当成提交。
 */
function onInlineSubmitKeydown(event: KeyboardEvent, submit: () => unknown) {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  void submit();
}

/** 首屏要打开的对话（来自后端 preferences；迁移时可能来自旧本地键）。 */
let initialConversationId = "";
let activeReportTimer: ReturnType<typeof setTimeout> | null = null;
/** 首屏骨架屏延迟计时器（见 showSkeleton）。 */
let skeletonTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 上报「上次打开的对话」（设备态）。
 * 节流 500ms：连点会话卡不该刷写后端。
 */
function reportActiveConversation(conv: { id: string; agentId?: string }) {
  const convId = conv?.id;
  if (!convId) return;
  // 只把「本角色」的会话记进本角色活跃槽：跨角色会话（如 /generic 页点开 support 期次）不写，
  // 否则会污染首屏按角色恢复（见 docs/cross-role-restore-scoping.md）。
  if ((conv.agentId || "generic") !== AGENT_ID) return;
  if (activeReportTimer) clearTimeout(activeReportTimer);
  activeReportTimer = setTimeout(() => {
    void saveChatPreferences({ agentId: AGENT_ID, activeConversationId: convId }).catch(() => undefined);
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

const nowClock = ref("");
const nowZone = ref("");
let nowClockTimer = 0;

/** 旧消息没有逐条时间：按对话的创建、更新时刻，把每一轮摊到这段时间上。已有的时间保持不动。 */
function messageTimes(
  messages: Array<{ role: string; at?: number }>,
  createdAt?: number,
  updatedAt?: number,
): number[] {
  const count = messages.length;
  if (!count) return [];
  const start = createdAt || updatedAt || Date.now();
  const end = Math.max(updatedAt || start, start);
  const turnOf: number[] = [];
  let turn = -1;
  for (const message of messages) {
    if (message.role === "user" || turn < 0) turn += 1;
    turnOf.push(turn);
  }
  const turns = turn + 1;
  const atOfTurn = (index: number) => (turns <= 1 ? end : Math.round(start + ((end - start) * index) / (turns - 1)));
  return messages.map((message, index) => message.at || atOfTurn(turnOf[index] ?? 0));
}

// 每条气泡时间都新建 Intl.DateTimeFormat + formatToParts：切换会话时 60 条气泡同时重挂载，
// 这笔固定开销能占掉几十毫秒。格式化器与按时间戳缓存的文案都要跟随系统时区：Intl 实例一旦
// 创建就固化了当时的时区，故 zone 变化时重建实例并清空文案缓存（refreshNowClock 每秒探测）。
function buildBubbleTimeFormatter(zone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone || undefined,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
let bubbleTimeZone = "";
let bubbleTimeFormatter = buildBubbleTimeFormatter(bubbleTimeZone);
const bubbleTimeCache = new Map<number, string>();
function bubbleTimeText(at: number): string {
  const hit = bubbleTimeCache.get(at);
  if (hit !== undefined) return hit;
  const parts = bubbleTimeFormatter.formatToParts(new Date(at));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = pick("hour") === "24" ? "00" : pick("hour");
  const text = `${pick("year")}-${pick("month")}-${pick("day")} ${hour}:${pick("minute")}:${pick("second")}`;
  if (bubbleTimeCache.size > 2000) bubbleTimeCache.clear();
  bubbleTimeCache.set(at, text);
  return text;
}

function refreshNowClock() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  nowZone.value = zone;
  if (zone !== bubbleTimeZone) {
    bubbleTimeZone = zone;
    bubbleTimeFormatter = buildBubbleTimeFormatter(zone);
    bubbleTimeCache.clear();
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone || undefined,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date());
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = pick("hour") === "24" ? "00" : pick("hour");
  nowClock.value = `${pick("year")}-${pick("month")}-${pick("day")} ${hour}:${pick("minute")}:${pick("second")}`;
}

refreshNowClock();

onMounted(async () => {
  nowClockTimer = window.setInterval(refreshNowClock, 1000);
  // 移动端抽屉：Esc 关闭（桌面端无抽屉、此监听无害）。
  window.addEventListener("keydown", onSidebarEsc);
  models.value = await fetchModels().catch(() => []);
  modelsLoaded.value = true;
  // 不在这里写 modelId：它已按对话派生（空 = 自动模式，UI 兜底展示「自动」），
  // 赋值会触发一次无意义的 PATCH。
  // 不在这里 loadMcp()：此刻还没选中对话，请求会回退到服务端的 activeConversationId（可能是别的对话）。
  // 交给下面的 selectConversation / newConversation 按对话加载。
  window.addEventListener("mousedown", onOutsideTools);
  window.addEventListener("keydown", onEscTools);
  // 侧栏助手切换菜单：点击外部 / Esc 收起。
  window.addEventListener("mousedown", onAgentMenuOutside);
  window.addEventListener("keydown", onAgentMenuEsc);
  // 任务表单的 Esc：capture 阶段先于上面几个 Esc 处理器，模态开着时由它独占（见 onTaskFormEsc）。
  window.addEventListener("keydown", onTaskFormEsc, true);
  window.addEventListener("mousedown", onOutsideRes);
  window.addEventListener("mousedown", onOutsideDt);
  window.addEventListener("keydown", onCtxEscape);
  // scroll 不冒泡：用捕获阶段才能收到 .conv-list 自身的滚动。
  window.addEventListener("scroll", onCtxDismiss, true);
  window.addEventListener("resize", onCtxDismiss);
  // 日期面板 Teleport 到 body：弹窗滚动/窗口缩放时跟随输入框重算位置。
  window.addEventListener("scroll", syncDtPos, true);
  window.addEventListener("resize", syncDtPos);
  // 任务表单「+ 工具」浮层：Teleport 到 body 后，滚动/窗口缩放时跟随触发按钮重算位置。
  window.addEventListener("mousedown", onOutsideTaskTools);
  window.addEventListener("scroll", syncTaskToolsPos, true);
  window.addEventListener("resize", syncTaskToolsPos);
  // 窗口缩放改变输入框换行宽度，高度需重算。
  window.addEventListener("resize", onWindowResizeGrow);
  window.addEventListener("resize", updateIsMobile);

  // 骨架屏延迟亮起：只在加载超过阈值时才显示，避免快加载时骨架「闪一下又消失」。
  skeletonTimer = setTimeout(() => {
    if (booting.value) showSkeleton.value = true;
  }, SKELETON_DELAY_MS);

  // 设备态偏好（主题 / 默认语言 / 上次打开的对话）以后端为唯一真相；顺带跑一次性迁移。
  const prefs = await fetchChatPreferences().catch(() => null);
  if (prefs) {
    if (isUiLocale(prefs.locale)) deviceLocale.value = prefs.locale;
    adoptTheme(prefs.theme);
    sortMode.value = prefs.convSortMode;
    showArchived.value = prefs.showArchived;
    // 按角色取「上次打开的对话」：generic 用旧槽；其余角色用 activeByAgent（后端维护）。
    // 不用 generic 槽：否则双角色用户进 /support 会把 generic 的会话当首屏打开（见 docs/cross-role-restore-scoping.md）。
    initialConversationId =
      AGENT_ID === "generic" ? prefs.activeConversationId : prefs.activeByAgent?.[AGENT_ID] || "";
    const zone = browserTimeZone();
    if (zone && zone !== prefs.timeZone) {
      void saveChatPreferences({ timeZone: zone }).catch(() => undefined);
    }
    await migrateLocalPrefs(prefs);
  }

  const list = await fetchConversations(showArchived.value, AGENT_ID).catch(() => [] as ConversationDto[]);
  conversations.value = list;
  // 服务端给的是一份稳定默认序；「按最近活动」模式下要忽略 sortOrder 复算一次。
  resortConversations();
  // 定时任务列表与对话列表无关，可以并行拉（不阻塞首屏会话恢复）。
  void loadTasks();
  startTasksPoll();
  void loadNotifyChannels();
  // IM 通知里的「打开对话」链接带 ?conv=<id>：显式指定优先于设备上次打开的对话。
  const linkedConvId = String(router.currentRoute.value.query.conv || "").trim();
  const findInList = (id: string) => (id ? list.find((c) => c.id === id) : undefined);
  // 首屏恢复按角色收窄（见 docs/cross-role-restore-scoping.md）：自动恢复的活跃槽只在**本角色列表里**才打开，
  // 否则回落 list[0]——不把别角色的会话按 id 直取拖进本页（那会既串列表又串人设）。
  let target = findInList(linkedConvId) || findInList(initialConversationId) || list[0];
  // 只有**显式深链**（IM 通知 ?conv=）才跨角色按 id 直取：如从通用对话建的定时任务，其专属 / 某期会话
  // 属 generic，却在 /support 打开——按 id 直取（服务端只校验归属），取到补进列表并优先打开。
  if (linkedConvId && !findInList(linkedConvId)) {
    const doc = await fetchConversation(linkedConvId).catch(() => null);
    if (doc) {
      conversations.value = [doc, ...conversations.value.filter((c) => c.id !== doc.id)];
      resortConversations();
      target = doc;
    } else {
      // 显式深链既不在本角色列表、直取又失败：如实提示，
      // 不再静默落到别的对话（用户点了链接却进了一个毫不相关的会话而无感知）。
      showSettingsError(
        tx("该对话已不存在或无权访问", "This conversation no longer exists or you don't have access", "Esta conversa não existe mais ou você não tem acesso", "यह चैट अब मौजूद नहीं है या आपकी पहुँच नहीं है"),
      );
    }
  }
  try {
    if (target) selectConversation(target);
    else await newConversation();
  } finally {
    // 首屏数据就位（或失败）后收尾：清计时器、关骨架/空态拦截。
    if (skeletonTimer) {
      clearTimeout(skeletonTimer);
      skeletonTimer = null;
    }
    booting.value = false;
    showSkeleton.value = false;
  }
});

// 同路径只换 ?conv= 时（App.vue 以 $route.path 作 key，组件不重挂载，onMounted 不重跑）：
// 运行期从 IM 通知链接跳来的切换要在这里接住。首屏已由上面的 onMounted 处理，这里用非 immediate，
// 避免和首屏逻辑重复触发；空值（离开深链）或已是当前对话则不动，维持既有导航行为。
watch(
  () => String(router.currentRoute.value.query.conv || "").trim(),
  (convId) => {
    if (!convId || convId === currentId.value) return;
    void openConversationById(convId, "link");
  },
);

onBeforeUnmount(() => {
  if (nowClockTimer) window.clearInterval(nowClockTimer);
  stopTasksPoll();
  window.removeEventListener("keydown", onSidebarEsc);
  window.removeEventListener("mousedown", onOutsideTools);
  window.removeEventListener("keydown", onEscTools);
  window.removeEventListener("mousedown", onAgentMenuOutside);
  window.removeEventListener("keydown", onAgentMenuEsc);
  window.removeEventListener("keydown", onTaskFormEsc, true);
  window.removeEventListener("mousedown", onOutsideRes);
  window.removeEventListener("mousedown", onOutsideDt);
  window.removeEventListener("keydown", onCtxEscape);
  window.removeEventListener("scroll", onCtxDismiss, true);
  window.removeEventListener("resize", onCtxDismiss);
  window.removeEventListener("scroll", syncDtPos, true);
  window.removeEventListener("resize", syncDtPos);
  window.removeEventListener("mousedown", onOutsideTaskTools);
  window.removeEventListener("scroll", syncTaskToolsPos, true);
  window.removeEventListener("resize", syncTaskToolsPos);
  window.removeEventListener("resize", onWindowResizeGrow);
  window.removeEventListener("resize", updateIsMobile);
  // 离开页面时把还没到点的删除落实，避免撤销窗口内的删除被永久搁置。
  flushPendingDelete();
  // 首屏未加载完就离开：清掉延迟骨架计时器，避免卸载后仍回写状态。
  if (skeletonTimer) {
    clearTimeout(skeletonTimer);
    skeletonTimer = null;
  }
  // 大纲跳转的 scrollend 兜底定时器，卸载后无需再解锁滚动标记。
  if (outlineJumpFallback) window.clearTimeout(outlineJumpFallback);
  // 先置卸载标志：守望回调里已在途的 fetchChatTaskStatus 返回后据此放弃出队/弹提醒
  //（clearInterval 只能挡未发起的 tick，挡不住 await 中的回调）。
  pageUnmounted = true;
  // 统一登记的延迟回调（MCP 刷新 / 确认票据到期 / MCP 加载）在此清零。
  for (const t of unmountTimers) clearTimeout(t);
  unmountTimers.clear();
  // 四个短时具名定时器：卸载后回写 ref 或上报偏好，必须取消。
  // settingsErrorTimer 归 modelSettings composable 所有，经 dispose 入口清理。
  disposeSettingsErrorTimer();
  if (clearArmTimer) {
    clearTimeout(clearArmTimer);
    clearArmTimer = null;
  }
  if (copyToastTimer) {
    clearTimeout(copyToastTimer);
    copyToastTimer = null;
  }
  if (activeReportTimer) {
    clearTimeout(activeReportTimer);
    activeReportTimer = null;
  }
  // 后台守望计时器：组件卸载后仍跑会持有响应式对象、滞留实例（最长 15 分钟），必须清掉。
  for (const t of bgWatch.values()) clearInterval(t);
  bgWatch.clear();
  for (const t of queueWatch.values()) clearInterval(t);
  queueWatch.clear();
  // 在途的整队列 PATCH 无法取消，但其 finally 会自清；这里显式清空 Map 引用，加速回收。
  queueSetChains.clear();
  if (doneToastTimer) {
    clearTimeout(doneToastTimer);
    doneToastTimer = null;
  }
});

// 把气泡模板依赖的全部函数 / 响应式集合 / ref 一次性透传给 ChatBubble 子组件，
// 避免逐个 prop 钻透。气泡因此成为独立渲染单元：流式只重渲染正在输出的那一条，其余纹丝不动。
const bubbleContext = {
  openReasoning,
  openSteps,
  clarifyDraft,
  uiLocale,
  currentId,
  toggleReasoning,
  toggleStep,
  cancelSubagent,
  answerToolConfirm,
  submitClarifyFreeform,
  answerClarification,
  copyBubble,
  editUserBubble,
  openArtifactPreview,
  openAlertScheduleFromChat,
  onInlineSubmitKeydown,
  formatBytes,
  reasoningTitle,
  thinkLabel,
  hasThinking,
  intentOf,
  thinkingDisplay,
  stepKey,
  stepClass,
  stepStatusText,
  toolDisplayName,
  showToolServer,
  stepSummary,
  subagentDotClass,
  subagentStatusText,
  confirmLevelText,
  confirmExpiryText,
  usageText,
  alertChipText,
  bubbleTimeText,
  isHtmlArtifact,
  renderChatMarkdown,
  alertMarkerInfo,
  bubbleBody,
  isStoppedBubble,
  workspaceDownloadUrl,
} satisfies BubbleContext;

if (import.meta.env.DEV && Object.keys(bubbleContext).length !== 41) {
  throw new Error(`bubbleContext key count changed: ${Object.keys(bubbleContext).length}`);
}

provide(bubbleContextKey, bubbleContext);


return {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  reactive,
  ref,
  watch,
  BackToTop,
  ConversationOutline,
  ModelSelect,
  PromptBox,
  ToolsSearch,
  SkillAddForm,
  McpAddForm,
  ThemeToggle,
  UiLocaleSelect,
  UiSelect,
  ChatBubble,
  DoneToast,
  ArtifactPreviewModal,
  ConfirmDialog,
  ChatThread,
  ContextMenuHost,
  ChatSidebarList,
  bubbleContextKey,
  renderChatMarkdown,
  applyStreamEvent,
  dedupeRepeats,
  MINUTELY_INTERVALS,
  REPEAT_FREQS,
  WEEKDAYS,
  buildCronFromForm,
  parseCron,
  toLocalInput,
  useOnceAtPicker,
  alertMarkerInfo,
  bubbleBody,
  isStoppedBubble,
  taskCardTipOf,
  taskConvTextOf,
  taskDotClassOf,
  taskHealthShortOf,
  taskKindTextOf,
  taskMarkerTextOf,
  taskNextRunTextOf,
  taskNextShortOf,
  taskRightShortOf,
  taskRunTextOf,
  taskStatusTextOf,
  matchesFuzzyScoped,
  matchesFuzzy,
  loadPinyin,
  pinyinReady,
  getUiLocale,
  detectDefaultLocale,
  isUiLocale,
  setUiLocale,
  showToolServer,
  toolDisplayName,
  visibleThinking,
  localizeToken,
  AGENTS,
  agentText,
  findAgent,
  readStoredTheme,
  useTheme,
  cancelChatTask,
  clearConversation,
  clearConversationContext,
  confirmToolCall,
  createConversation,
  apiCancelSubagent,
  conversationExportUrl,
  NOT_MODEL_FAULT_CODES,
  createChatSchedule,
  deleteChatSchedule,
  runChatSchedule,
  restartChatSchedule,
  apiDeleteConversation,
  deleteNotifyChannel,
  duplicateConversation,
  deleteCustomMcpServer,
  fetchChatMcpServers,
  fetchChatPreferences,
  fetchChatSkills,
  fetchChatTaskStatus,
  fetchConversation,
  fetchConversations,
  fetchModels,
  fetchMemory,
  fetchNotifyChannels,
  fetchSchedules,
  fetchWorkspaceFiles,
  getApiErrorToken,
  getApiErrorCode,
  addMemoryItem,
  readWorkspaceFile,
  workspaceDownloadUrl,
  removeMemoryItem,
  isChatTaskRunning,
  patchChatSchedule,
  patchConversation,
  enqueueConversationMessage,
  dequeueConversationMessage,
  reloadMcpServer,
  reorderConversations,
  resumeChatTaskEvents,
  saveChatPreferences,
  saveConversationMessages,
  saveNotifyChannel,
  setChatMcpServers,
  setChatSkills,
  streamChat,
  testNotifyChannel,
  uploadFiles,
  MODEL_AUTO_ID,
  parseAlertMarker,
  tasks,
  tasksBusy,
  showTaskForm,
  showTaskList,
  taskError,
  taskDraft,
  editingTaskId,
  cronUnparsed,
  editingCron,
  freqDialogOpen,
  notifyDialogOpen,
  loadTasks,
  tasksPollTimer,
  conversationSyncing,
  pendingSyncId,
  startTasksPoll,
  stopTasksPoll,
  refreshConversationsQuiet,
  refreshMcpAvailable,
  patchMcpRow,
  toggleTaskServer,
  connectTaskMcp,
  ensureTaskMcpConnected,
  toggleTaskSkill,
  taskCardFacts,
  taskStatusText,
  taskRunText,
  taskMarkerText,
  taskDotClass,
  taskHealthShort,
  taskRightShort,
  taskNextRunText,
  taskNextShort,
  taskKindText,
  taskConvText,
  taskCardTip,
  NOTIFY_KIND_LABELS,
  notifyKindLabel,
  notifyChannels,
  notifyBusy,
  notifyNote,
  channelDraft,
  notifySummary,
  loadNotifyChannels,
  channelErrorText,
  saveChannelDraft,
  testChannel,
  removeChannel,
  toggleChannelEnabled,
  taskToolsOpen,
  taskSkillOpen,
  taskSkillAddOpen,
  taskMcpAddOpen,
  taskMcpOpen,
  taskExpertOpen,
  taskSkillQuery,
  taskMcpQuery,
  taskExpertQuery,
  taskSearchAutofocus,
  taskToolsRoot,
  taskToolsPanel,
  taskToolsPos,
  closeTaskFlyouts,
  updateTaskToolsPos,
  syncTaskToolsPos,
  toggleTaskTools,
  openTaskFlyout,
  hoverTaskFlyout,
  onOutsideTaskTools,
  taskSkillFiltered,
  taskMcpFiltered,
  taskExpertFiltered,
  taskMcpCount,
  clearTaskSkills,
  clearTaskMcp,
  taskAgentLabel,
  taskRepeat,
  buildCron,
  ALERT_PROMPT_SCAFFOLD,
  applyTaskPurpose,
  bubbleHasAlertMarker,
  draftAlertPromptFromChat,
  applyAlertDraftFromChat,
  openAlertScheduleFromChat,
  repeatUnit,
  toggleWeekday,
  repeatPreview,
  taskFreqSummary,
  dtOpen,
  dtRoot,
  dtPanel,
  dtPos,
  dtDisplay,
  openDtPicker,
  syncDtPos,
  pickDay,
  shiftMonth,
  DT_SHORTCUTS,
  DT_WEEKDAYS,
  dtMonthLabel,
  dtCells,
  isDtToday,
  isDtPicked,
  DT_HOURS,
  DT_MINUTES,
  dtHour,
  dtMinute,
  dtHourPart,
  dtMinutePart,
  onOutsideDt,
  openTaskForm,
  closeTaskForm,
  openTaskListPage,
  onTaskFormEsc,
  submitTask,
  toggleTask,
  removeTask,
  runningNow,
  runTaskNow,
  restartTask,
  runStatusFilter,
  runMatchesFilter,
  filteredRuns,
  editingTask,
  openConversationById,
  openTaskConversation,
  openRunConversation,
  LOCAL_KEYS,
  adoptTheme,
  uiLocale,
  tx,
  blankState,
  threadEl,
  models,
  modelsLoaded,
  conversations,
  persistedCount,
  convQuery,
  conversationsFiltered,
  onConvSearchInput,
  AGENT_ID,
  AGENT_LABEL,
  MOBILE_QUERY,
  sidebarOpen,
  sidebarCollapsed,
  isMobile,
  navExpanded,
  updateIsMobile,
  toggleSidebar,
  agentMenuOpen,
  agentMenuEl,
  currentAgent,
  toggleAgentMenu,
  onPickAgent,
  onAgentMenuOutside,
  onAgentMenuEsc,
  onSidebarEsc,
  showArchived,
  currentId,
  booting,
  showSkeleton,
  SKELETON_DELAY_MS,
  ctxMenu,
  ctxMenuEl,
  ctxConfirm,
  renaming,
  renameInputEl,
  RENAME_MAX,
  undoDelete,
  confirmDialog,
  confirmDialogEl,
  confirmPrimaryBtn,
  confirmReturnFocus,
  previewHtml,
  previewLoading,
  isHtmlArtifact,
  openArtifactPreview,
  closeArtifactPreview,
  askDeleteConversation,
  askDeleteFromCtx,
  askCloseOthers,
  closeConfirm,
  confirmDialogConfirm,
  trapConfirmFocus,
  sortMode,
  convListEl,
  draggingId,
  dropTarget,
  DRAG_SCROLL_STEP,
  DRAG_SCROLL_EDGE,
  fileInput,
  promptBoxEl,
  inputEl,
  stopBtnRef,
  COMPOSER_H_KEY,
  COMPOSER_H_MIN,
  COMPOSER_H_MAX,
  COMPOSER_BASE,
  COMPOSER_AUTO_MAX,
  composerSize,
  loadComposerSize,
  autoGrow,
  onWindowResizeGrow,
  startComposerResize,
  resetComposerSize,
  deviceLocale,
  browserTimeZone,
  settingsError,
  blank,
  states,
  stateOf,
  current,
  latestAlertMarkerId,
  alertMarkerCache,
  EMPTY_BUBBLES,
  bubbleArrIds,
  bubbleArrSeq,
  bubbleArrId,
  THREAD_WINDOW_STEP,
  threadWindow,
  visibleBubbles,
  showEarlierMessages,
  OUTLINE_LABEL_MAX,
  outlineLabel,
  outlineCache,
  conversationOutline,
  outlineOpen,
  activeOutlineId,
  pinnedOutlineId,
  outlineJumpActive,
  outlineJumpFallback,
  outlineScrollEndHandler,
  outlineIgnoreScrollUntil,
  finishOutlineScroll,
  releaseOutlinePin,
  OUTLINE_NAV_KEYS,
  onOutlineUserScrollIntent,
  OUTLINE_WINDOW_MARGIN,
  OUTLINE_ACTIVE_BAND,
  OUTLINE_LANDING_INSET,
  jumpToOutline,
  modelId,
  lastGoodModelId,
  failedModelIds,
  resolveModel,
  settingsErrorTimer,
  showSettingsError,
  syncConvLocal,
  applyConversationLocale,
  modelChoiceLabel,
  modelSwitchHint,
  saveModelChoice,
  onLocaleChange,
  resolvedModelId,
  modelSupportsImages,
  imagesUnsupported,
  mcpOpen,
  mcpAvailable,
  mcpBusy,
  mcpReconnecting,
  mcpError,
  seq,
  scrollQueued,
  scrollForce,
  canSend,
  queueScrollIfCurrent,
  followBottom,
  nearBottom,
  atBottomNow,
  onThreadScroll,
  queueScroll,
  openReasoning,
  reasoningCollapsedByUser,
  toggleReasoning,
  openReasoningPanel,
  closeReasoningPanel,
  openSteps,
  stepKey,
  toggleStep,
  stepSummary,
  hasRunningStep,
  hasThinking,
  INTENT_RE,
  intentOf,
  thinkingDisplay,
  thinkStarts,
  thinkPhaseStart,
  thinkPhaseEnd,
  thinkLabel,
  thinkStickQueued,
  stickThinkingToBottom,
  reasoningTitle,
  chartsOf,
  settleStep,
  SNAPSHOT_DETAIL_TAIL,
  SNAPSHOT_THINKING_CAP,
  SNAPSHOT_STEP_RESULT_CAP,
  capTail,
  toStored,
  bubblesFromStored,
  upgradeConversationDetail,
  applyServerThread,
  tailSig,
  serverThreadAhead,
  syncOpenConversation,
  pendingPersists,
  persistChains,
  waitPendingPersists,
  persist,
  persistNow,
  selectConversation,
  newConversation,
  createConvFromDraft,
  CONV_ORDER_STEP,
  convRank,
  resortConversations,
  applyConversationOrder,
  restoreRecentSort,
  onConvDragStart,
  onConvDragOver,
  onConvDragEnd,
  onConvDrop,
  moveConversation,
  onConvKeydown,
  pinnedCount,
  archivedCount,
  firstArchivedIndex,
  taskConvIds,
  taskGroups,
  TASK_GROUP_KEY,
  expandedTasks,
  readTaskGroupState,
  toggleTaskGroup,
  onTaskGroupKeydown,
  TASK_SECTION_KEY,
  taskSectionOpen,
  readTaskSectionState,
  toggleTaskSection,
  CONV_SECTION_KEY,
  convSectionOpen,
  readConvSectionState,
  toggleConvSection,
  onRunKeydown,
  runTimeText,
  runMetaText,
  clearTaskUnread,
  ctxTarget,
  ctxTargetTask,
  ctxOpenTaskConv,
  ctxRunTaskNow,
  ctxEditTask,
  ctxToggleTaskEnabled,
  ctxMarkTaskRead,
  ctxRemoveTask,
  removeConversation,
  deleteConversationOnServer,
  flushPendingDelete,
  scheduleUndoDelete,
  undoRemoveConversation,
  ctxAnchorPos,
  placeCtxMenu,
  openCtxMenu,
  openTaskCtxMenu,
  closeCtxMenu,
  armCtxConfirm,
  reloadConversations,
  toggleArchive,
  toggleMute,
  toggleFullAccess,
  draftSendMode,
  currentSendMode,
  toggleSendModeForCurrent,
  toggleSendMode,
  duplicateCurrent,
  exportConversation,
  cancelSubagent,
  onCtxMenuKeydown,
  onCtxEscape,
  onCtxDismiss,
  setRenameInput,
  startRename,
  cancelRename,
  commitRename,
  onRenameKeydown,
  togglePin,
  clearConversationById,
  closeOtherConversations,
  clearArmedFor,
  clearArmTimer,
  clearArmed,
  onClearCurrentClick,
  clearCurrent,
  convStatus,
  convStatusText,
  pickFiles,
  removePendingImage,
  removePendingDoc,
  MAX_QUEUE,
  queueSetChains,
  enqueueMessage,
  setQueue,
  drainQueue,
  send,
  RESUME_ATTEMPTS,
  RESUME_BACKOFF_MS,
  sleep,
  applyChatEvent,
  resumeRun,
  runTurn,
  stop,
  doneToast,
  doneToastTimer,
  bgWatch,
  queueWatch,
  pageUnmounted,
  unmountTimers,
  deferOnPage,
  watchAndDrain,
  showDoneToast,
  openDoneToast,
  watchBackgroundDone,
  appendNotice,
  settleInterruptedRun,
  ensureRunPrompt,
  attachRunningTask,
  queueCount,
  moveQueueItem,
  removeQueueItem,
  editQueueItem,
  queueNowDispatching,
  sendQueueItemNow,
  answerToolConfirm,
  clarifyDraft,
  submitClarifyFreeform,
  answerClarification,
  scheduleConfirmExpiry,
  confirmLevelText,
  confirmExpiryText,
  loadMcp,
  openMcpPanel,
  boundMcpIds,
  isBoundMcp,
  bindingBoundMcp,
  ensureBoundMcp,
  toggleMcp,
  clearMcpSelection,
  reconnectMcp,
  removeCustomMcp,
  mcpRowState,
  taskRowState,
  skillOpen,
  skillAddOpen,
  mcpAddOpen,
  skillAvailable,
  skillBusy,
  skillError,
  loadSkills,
  onChatSkillCreated,
  onTaskSkillCreated,
  onChatMcpCreated,
  onTaskMcpCreated,
  openSkillPanel,
  toggleSkill,
  clearSkillSelection,
  toolsMenuOpen,
  toolsRoot,
  skillQuery,
  mcpQuery,
  searchAutofocus,
  skillFiltered,
  mcpFiltered,
  mcpBoundRows,
  mcpOptionalRows,
  mcpPanelRows,
  canClearOptionalMcp,
  enabledMcpCount,
  toggleToolsMenu,
  mcpDescText,
  expertOpen,
  expertAgents,
  currentExpert,
  expertStarters,
  composerPlaceholder,
  askStarter,
  expertQuery,
  expertFiltered,
  openExpertPanel,
  closeToolsPanels,
  onPickExpert,
  onClearExpert,
  hoverFlyout,
  onEscTools,
  onOutsideTools,
  iconStyle,
  iconChar,
  resOpen,
  resRoot,
  memoryItems,
  memoryText,
  memoryBusy,
  wsFiles,
  wsFileContent,
  wsLoading,
  onOutsideRes,
  toggleResPanel,
  loadMemory,
  addMemoryEntry,
  removeMemoryEntry,
  loadWorkspaceFiles,
  openWorkspaceFile,
  formatBytes,
  stepClass,
  stepStatusText,
  subagentDotClass,
  subagentStatusText,
  usageText,
  alertChipText,
  copyToast,
  copyToastTimer,
  copyBubble,
  editUserBubble,
  onKeydown,
  onInlineSubmitKeydown,
  initialConversationId,
  activeReportTimer,
  skeletonTimer,
  reportActiveConversation,
  migrateLocalPrefs,
  nowClock,
  nowZone,
  nowClockTimer,
  messageTimes,
  buildBubbleTimeFormatter,
  bubbleTimeZone,
  bubbleTimeFormatter,
  bubbleTimeCache,
  bubbleTimeText,
  refreshNowClock,
};
}
