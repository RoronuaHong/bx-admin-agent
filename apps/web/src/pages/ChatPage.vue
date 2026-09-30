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
import { useRouter } from "vue-router";
import BackToTop from "../components/BackToTop.vue";
import ModelSelect from "../components/ModelSelect.vue";
import PromptBox from "../components/PromptBox.vue";
import ToolsSearch from "../components/ToolsSearch.vue";
import ThemeToggle from "../components/ThemeToggle.vue";
import UiLocaleSelect from "../components/UiLocaleSelect.vue";
import UiSelect from "../components/UiSelect.vue";
import ChartCard from "../components/ChartCard.vue";
import { renderChatMarkdown } from "../chat-richtext";
import { matchesFuzzyScoped, matchesFuzzy, loadPinyin, pinyinReady } from "../pinyin";
import { getUiLocale, detectDefaultLocale, isUiLocale, setUiLocale, type UiLocale } from "../ui-locale";
import { localizeToken } from "../localize";
import { AGENTS, agentText, type AgentEntry } from "../agents";
import { readStoredTheme, useTheme } from "../theme";
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
  deleteConversation as apiDeleteConversation,
  deleteNotifyChannel,
  duplicateConversation,
  fetchChatMcpServers,
  fetchChatPreferences,
  fetchChatSkills,
  fetchChatTaskStatus,
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
  type ScheduleStatus,
  type SkillMeta,
  type StoredMessage,
  type UploadResult,
  type WorkspaceFile,
} from "../api";
import type { ArtifactSpec, ChatEvent, TodoItem } from "@bx/shared";

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

/** 定时任务健康态需要较新的 next/last/running：页面可见时每 20s 轻量刷新。 */
let tasksPollTimer: ReturnType<typeof setInterval> | null = null;
function startTasksPoll() {
  if (tasksPollTimer) return;
  tasksPollTimer = setInterval(() => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    void loadTasks();
    // 顺带刷对话 running 标记，任务「执行中」才看得见。
    void refreshConversationsQuiet();
  }, 20_000);
}
function stopTasksPoll() {
  if (!tasksPollTimer) return;
  clearInterval(tasksPollTimer);
  tasksPollTimer = null;
}
/** 不改归档开关、不打断当前对话的侧栏刷新（只同步 running / 标题等）。 */
async function refreshConversationsQuiet() {
  const list = await fetchConversations(showArchived.value, AGENT_ID).catch(() => null);
  if (!list) return;
  const pendingDeleted = undoDelete.value?.conv.id;
  const next = pendingDeleted ? list.filter((c) => c.id !== pendingDeleted) : list;
  // 保留本地排序：只按 id 合并字段，避免轮询把「按最近活动」打乱。
  const byId = new Map(next.map((c) => [c.id, c]));
  conversations.value = conversations.value.map((c) => {
    const fresh = byId.get(c.id);
    return fresh ? { ...c, ...fresh } : c;
  });
  // 新出现的对话（本期新会话）补进列表末尾，下次完整 reload 再排序。
  for (const c of next) {
    if (!conversations.value.some((x) => x.id === c.id)) conversations.value.push(c);
  }
}

/** 只刷新可用服务器连接状态（不依赖当前对话；任务表单勾选预热后用来同步「已连接」）。 */
async function refreshMcpAvailable() {
  const data = await fetchChatMcpServers(currentId.value || undefined).catch(() => null);
  if (data) mcpAvailable.value = data.available;
}

function patchMcpRow(id: string, patch: Partial<McpServerStatus>) {
  const idx = mcpAvailable.value.findIndex((s) => s.id === id);
  if (idx < 0) return;
  mcpAvailable.value[idx] = { ...mcpAvailable.value[idx], ...patch };
}

/**
 * 任务表单勾选某台 MCP：写入草稿允许清单，并立刻预热连接（对齐对话区勾选即连）。
 * 到点运行才真正用工具，但状态要跟勾选同步，否则会一直停在「未连接」。
 */
async function toggleTaskServer(id: string) {
  const i = taskDraft.mcpServers.indexOf(id);
  if (i >= 0) {
    taskDraft.mcpServers.splice(i, 1);
    if (taskMcpExpanded.value === id) taskMcpExpanded.value = "";
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
    setTimeout(() => void refreshMcpAvailable(), 800);
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

/** 任务卡片「工具」事实：只列服务器标签（空则如实说这次不带工具）。 */
function taskToolsFact(t: ScheduleDto): string {
  const ids = t.mcpServers || [];
  if (!ids.length) return tx("不使用 MCP 工具", "No MCP tools", "Sem ferramentas MCP", "कोई MCP टूल नहीं");
  return ids
    .map((id) => mcpAvailable.value.find((s) => s.id === id)?.label || id)
    .join(tx("、", ", ", ", ", ", "));
}



/** 任务卡片「通知」事实：任务启用且通道启用即推送；列出所有启用通道标签 + 上次投递结果。 */
function taskNotifyFact(t: ScheduleDto): string {
  const enabled = notifyChannels.value.filter((c) => c.enabled !== false);
  if (!enabled.length) return "";
  const labels = enabled.map((c) => c.label).join(tx("、", ", ", ", ", ", "));
  const last = t.lastDelivery;
  if (!last) return labels;
  return `${labels} · ${
    last.ok
      ? tx("上次推送成功", "last push ok", "último envio ok", "पिछला भेजा गया")
      : tx("上次推送失败", "last push failed", "último envio falhou", "पिछला भेजना विफल")
  }`;
}

/** 最近一次执行结果的短标签（卡片右上角徽标）。 */
const STATUS_LABEL: Record<ScheduleStatus, [string, string, string, string]> = {
  success: ["成功", "success", "sucesso", "सफल"],
  failed: ["失败", "failed", "falhou", "विफल"],
  skipped: ["跳过", "skipped", "ignorado", "छोड़ा"],
  cancelled: ["已取消", "cancelled", "cancelado", "रद्द"],
  error: ["出错", "error", "erro", "त्रुटि"],
};

function taskStatusText(t: ScheduleDto): string {
  const label = t.lastStatus ? STATUS_LABEL[t.lastStatus] : null;
  return label ? tx(label[0], label[1], label[2], label[3]) : "";
}

/** 状态徽标的悬浮全文：上次执行时间 + 服务端说明（跳过原因 / 错误）。卡片上放不下这些。 */
function taskRunText(t: ScheduleDto): string {
  const label = taskStatusText(t);
  if (!label) return "";
  const at = t.lastRunAt ? ` ${new Date(t.lastRunAt).toLocaleString()}` : "";
  const head = tx("上次执行", "Last run", "Última execução", "पिछला निष्पादन") + "：" + label + at;
  return t.lastNote ? `${head}（${t.lastNote}）` : head;
}

/** 预警结论标记的短文案。 */
function taskMarkerText(marker?: string | null): string {
  if (marker === "SPIKE") return tx("异常", "Spike", "Anomalia", "स्पाइक");
  if (marker === "NORMAL") return tx("正常", "Normal", "Normal", "सामान्य");
  if (marker === "NO_DATA") return tx("无数据", "No data", "Sem dados", "डेटा नहीं");
  return "";
}

/**
 * 侧栏任务健康态：执行中 / 排队 / 逾期 / 上次结论。
 * 「仅异常通知」时 NORMAL/NO_DATA 不推 IM，必须在这里把「已检查」说清楚，否则像没跑。
 */
function taskIsRunning(t: ScheduleDto): boolean {
  const ids = new Set<string>([
    t.conversationId,
    ...(t.runs || []).slice(0, 1).map((r) => r.conversationId),
  ]);
  return conversations.value.some((c) => ids.has(c.id) && c.running);
}

function taskDotClass(t: ScheduleDto): string {
  if (!t.enabled) return "paused";
  if (taskIsRunning(t)) return "running";
  if (t.queuedSince) return "pending";
  if (t.enabled && t.nextRunAt && t.nextRunAt < Date.now() - 90_000 && !t.lastStatus) return "pending";
  if (t.enabled && t.nextRunAt && t.nextRunAt < Date.now() - 90_000 && t.lastRunAt && t.nextRunAt > (t.lastRunAt || 0)) {
    // 到点超过 90s 仍未推进 next → 可能卡在跑或锁上。
    if (!taskIsRunning(t) && Date.now() - (t.nextRunAt || 0) > 90_000) return "pending";
  }
  if (t.alertState?.firing || t.lastMarker === "SPIKE") return "alert";
  if (t.lastMarker === "NO_DATA") return "nodata";
  if (t.lastStatus) return t.lastStatus;
  return "idle";
}

function taskHealthShort(t: ScheduleDto): string {
  if (!t.enabled) return tx("已暂停", "Paused", "Pausada", "रुका हुआ");
  if (taskIsRunning(t)) return tx("执行中", "Running", "Executando", "चल रहा है");
  if (t.queuedSince) return tx("排队中", "Queued", "Na fila", "कतार में");
  if (t.enabled && t.nextRunAt && t.nextRunAt < Date.now() - 90_000) {
    return tx("待执行", "Due", "Pendente", "बाकी");
  }
  const marker = taskMarkerText(t.lastMarker);
  if (marker) {
    const when = t.lastRunAt ? formatShortTime(t.lastRunAt) : "";
    if (t.alertState?.firing && t.lastMarker !== "SPIKE") {
      return (when ? when + " · " : "") + tx("告警中", "Firing", "Em alerta", "अलर्ट में");
    }
    return (when ? when + " · " : "") + marker;
  }
  if (t.lastRunAt) {
    const st = taskStatusText(t);
    return formatShortTime(t.lastRunAt) + (st ? ` · ${st}` : "");
  }
  return tx("尚未执行", "Not run yet", "Ainda não executou", "अभी नहीं चला");
}

function taskRightShort(t: ScheduleDto): string {
  if (!t.enabled) return tx("已暂停", "Paused", "Pausada", "रुका हुआ");
  if (taskIsRunning(t)) return tx("执行中", "Running", "Executando", "चल रहा है");
  return taskNextShort(t);
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
const taskMcpOpen = ref(false);
const taskExpertOpen = ref(false);
const taskSkillQuery = ref("");
const taskMcpQuery = ref("");
const taskExpertQuery = ref("");
/** 本次打开任务飞出是否把焦点放进搜索框（点击 = true，悬停 = false；与对话区 searchAutofocus 同口径）。 */
const taskSearchAutofocus = ref(true);
const taskMcpExpanded = ref("");
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
  } else if (kind === "mcp") {
    taskMcpOpen.value = true;
    taskMcpQuery.value = "";
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

/** 任务连接器搜索：与对话区 mcpFiltered 同口径。 */
const taskMcpFiltered = computed(() => {
  const q = taskMcpQuery.value.trim().toLowerCase();
  void pinyinReady.value;
  if (!q) return mcpAvailable.value;
  return mcpAvailable.value.filter((s) => matchesFuzzyScoped([s.label], [s.id], q));
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
  taskMcpExpanded.value = "";
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

/** 预警分钟级间隔只开放整除 60 且 ≥5 的档位（单期 Agent 常要数十秒，不开放 1 分钟）。 */
const MINUTELY_INTERVALS = [5, 10, 15, 30] as const;

const REPEAT_FREQS: Array<{ code: typeof taskRepeat.freq; zh: string; en: string; pt: string; hi: string; unitZh: string; unitEn: string; unitPt: string; unitHi: string }> = [
  { code: "MINUTELY", zh: "每分钟", en: "Minutely", pt: "Por minuto", hi: "प्रति मिनट", unitZh: "分钟", unitEn: "minute(s)", unitPt: "minuto(s)", unitHi: "मिनट" },
  { code: "HOURLY", zh: "每小时", en: "Hourly", pt: "A cada hora", hi: "हर घंटे", unitZh: "小时", unitEn: "hour(s)", unitPt: "hora(s)", unitHi: "घंटे" },
  { code: "DAILY", zh: "每天", en: "Daily", pt: "Diariamente", hi: "हर दिन", unitZh: "天", unitEn: "day(s)", unitPt: "dia(s)", unitHi: "दिन" },
  { code: "WEEKLY", zh: "每周", en: "Weekly", pt: "Semanalmente", hi: "हर सप्ताह", unitZh: "周", unitEn: "week(s)", unitPt: "semana(s)", unitHi: "सप्ताह" },
  { code: "MONTHLY", zh: "每月", en: "Monthly", pt: "Mensalmente", hi: "हर महीने", unitZh: "个月", unitEn: "month(s)", unitPt: "mês(es)", unitHi: "महीने" },
];

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

/** 前端识别预警结论协议标记（与服务端 parseAlertMarker 同口径，仅用于「设为数据预警」入口）。 */
function parseAlertMarkerClient(text: string): "SPIKE" | "NORMAL" | "NO_DATA" | null {
  const first = String(text || "")
    .trim()
    .split(/\r?\n/, 1)[0]
    ?.trim() || "";
  const m =
    first.match(/^\[(SPIKE|NORMAL|NO_DATA)\]\s*$/i) ||
    first.match(/^\[(SPIKE|NORMAL|NO_DATA)\](?:\s|$)/i);
  if (!m) return null;
  return m[1]!.toUpperCase() as "SPIKE" | "NORMAL" | "NO_DATA";
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
      parseAlertMarkerClient(b.text),
  );
}

/** 仅最近一条带协议标记的助手结论显示「设为数据预警」，避免历史气泡刷屏。 */
function isLatestAlertMarkerBubble(b: { id?: number; role: string; text: string }): boolean {
  const bubbles = current.value?.bubbles || [];
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const cur = bubbles[i]!;
    if (!bubbleHasAlertMarker(cur)) continue;
    return cur === b || (b.id != null && cur.id === b.id);
  }
  return false;
}

/**
 * 从对话草稿预警任务指令（ChatGPT「先测后跑」）：
 * 优先取「带协议标记的助手气泡」之前最近一条用户话；否则取最近用户话。
 * 用户已写结构化【数据预警】则原样带入，否则包一层失败/短窗口纪律（不臆造工具名）。
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

  let userText = "";
  if (anchor) {
    const idx = bubbles.findIndex((b) => b === anchor || (b.id != null && (anchor as { id?: number }).id === b.id));
    const from = idx >= 0 ? idx : bubbles.length;
    for (let i = from - 1; i >= 0; i--) {
      const t = String(bubbles[i]?.text || "").trim();
      if (bubbles[i]?.role === "user" && t) {
        userText = t;
        break;
      }
    }
  }
  if (!userText) {
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const t = String(bubbles[i]?.text || "").trim();
      if (bubbles[i]?.role === "user" && t) {
        userText = t;
        break;
      }
    }
  }
  if (!userText) return null;

  const structured = /【数据预警】|数据源\s*[:：]|异常条件\s*[:：]/.test(userText);
  const prompt = structured
    ? userText
    : `【数据预警】\n${userText}\n` +
      `- 失败：取不到完整计数就说取不到，不要猜数、不要估算、不要出图\n` +
      `- 取数：优先短窗口（≤60 分钟）与聚合/计数；列表须最少字段、小分页`;
  const name = userText.replace(/\s+/g, " ").slice(0, 24);
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

const WEEKDAYS: Array<{ code: string; zh: string; en: string; pt: string; hi: string }> = [
  { code: "MO", zh: "周一", en: "Mon", pt: "Seg", hi: "सोम" },
  { code: "TU", zh: "周二", en: "Tue", pt: "Ter", hi: "मंगल" },
  { code: "WE", zh: "周三", en: "Wed", pt: "Qua", hi: "बुध" },
  { code: "TH", zh: "周四", en: "Thu", pt: "Qui", hi: "गुरु" },
  { code: "FR", zh: "周五", en: "Fri", pt: "Sex", hi: "शुक्र" },
  { code: "SA", zh: "周六", en: "Sat", pt: "Sáb", hi: "शनि" },
  { code: "SU", zh: "周日", en: "Sun", pt: "Dom", hi: "रवि" },
];

const repeatUnit = computed(() => {
  const f = REPEAT_FREQS.find((x) => x.code === taskRepeat.freq)!;
  return tx(f.unitZh, f.unitEn, f.unitPt, f.unitHi);
});

function toggleWeekday(code: string) {
  const i = taskRepeat.byday.indexOf(code);
  if (i >= 0) taskRepeat.byday.splice(i, 1);
  else taskRepeat.byday.push(code);
}

/** cron 星期字段是数字（0 = 周日）。 */
const DOW: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** 格式化成 datetime-local 需要的本地时间字符串（编辑一次性任务时回填）。 */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 卡片上的紧凑时间：侧栏宽度只够「9/21 16:00」这一档，完整 locale 串会被挤成三行。
 * 非本年才带上年份（跨年任务看不出年份会误读）。
 */
function formatShortTime(ms: number): string {
  const d = new Date(ms);
  const date = `${d.getMonth() + 1}/${d.getDate()}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear() ? `${date} ${time}` : `${d.getFullYear()}/${date} ${time}`;
}

/**
 * 5 段 cron → 友好选项（buildCron 的逆运算，编辑时回填用）。
 * 只认本界面能产出/能表达的那几个形态；其余（外部 API 建的复杂表达式）返回 null，
 * 由调用方**只读展示原表达式**——「尽力猜一个相近的」会在保存时把别人的调度悄悄改掉。
 */
function parseCron(expr?: string): { freq: typeof taskRepeat.freq; interval: number; time: string; byday: string[] } | null {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  const isNum = (s: string) => /^\d{1,2}$/.test(s);
  const step = (s: string): number => (s === "*" ? 1 : /^\*\/(\d{1,2})$/.test(s) ? Number(s.slice(2)) : 0);
  const hhmm = (): string | null =>
    isNum(hour) && isNum(min) ? `${hour.padStart(2, "0")}:${min.padStart(2, "0")}` : null;
  // 每 N 分钟：*/n * * * *（n 须整除 60；界面只开放 5/10/15/30）
  const minutelyStep = step(min);
  if (minutelyStep >= 1 && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { freq: "MINUTELY", interval: minutelyStep, time: "09:00", byday: ["MO"] };
  }
  // 每小时：0 */n * * *
  const hourlyStep = step(hour);
  if (min === "0" && hourlyStep >= 1 && dom === "*" && mon === "*" && dow === "*") {
    return { freq: "HOURLY", interval: hourlyStep, time: "09:00", byday: ["MO"] };
  }
  const time = hhmm();
  if (!time) return null;
  // 每天：m h */n * *
  const dayStep = step(dom);
  if (dayStep >= 1 && mon === "*" && dow === "*") {
    return { freq: "DAILY", interval: dayStep, time, byday: ["MO"] };
  }
  // 每周：m h * * d1,d2
  if (dom === "*" && mon === "*" && dow !== "*") {
    const codes = dow.split(",");
    const names = codes.map((code) => Object.keys(DOW).find((k) => DOW[k] === Number(code)));
    if (codes.every(isNum) && names.every(Boolean) && names.length) {
      return { freq: "WEEKLY", interval: 1, time, byday: names as string[] };
    }
  }
  // 每月：m h 1 */n *
  const monthStep = step(mon);
  if (dom === "1" && monthStep >= 1 && dow === "*") {
    return { freq: "MONTHLY", interval: monthStep, time, byday: ["MO"] };
  }
  return null;
}

/**
 * 友好选项 → 服务端 5 段 cron（分 时 日 月 周）。
 * 只表达 cron 能**精确**表达的形态：日字段的步长是「每 N 天」（不是每 N 个月），周字段也不支持 `*​/2`。
 * 表达不了的情况如实返回 error，不用近似值糊弄用户（宁可少一个选项，也不要到点跑错）。
 */
function buildCron(): { cron?: string; error?: string } {
  const interval = Math.min(99, Math.max(1, Math.floor(taskRepeat.interval || 1)));
  const [h, m] = taskRepeat.time.split(":").map((x) => parseInt(x, 10));
  const hour = Number.isNaN(h) ? 9 : h;
  const minute = Number.isNaN(m) ? 0 : m;
  if (taskRepeat.freq === "MINUTELY") {
    const allowed = MINUTELY_INTERVALS as readonly number[];
    const n = allowed.includes(interval) ? interval : 10;
    return { cron: `*/${n} * * * *` };
  }
  if (taskRepeat.freq === "HOURLY") {
    return { cron: interval === 1 ? "0 * * * *" : `0 */${interval} * * *` };
  }
  if (taskRepeat.freq === "DAILY") {
    return { cron: `${minute} ${hour} */${interval} * *` };
  }
  if (taskRepeat.freq === "WEEKLY") {
    if (interval > 1) {
      return {
        error: tx(
          "每周重复暂只支持间隔 1 周（cron 无法精确表达「每 N 周」）",
          "Weekly repeats support interval 1 only (cron cannot express every N weeks)",
          "Repetição semanal aceita apenas intervalo 1",
          "साप्ताहिक दोहराव में अंतराल 1 ही समर्थित है",
        ),
      };
    }
    const days = WEEKDAYS.filter((w) => taskRepeat.byday.includes(w.code))
      .map((w) => DOW[w.code])
      .join(",");
    if (!days) {
      return {
        error: tx(
          "每周重复请至少选择一天",
          "Pick at least one weekday",
          "Selecione ao menos um dia da semana",
          "कृपया सप्ताह का कम से कम एक दिन चुनें",
        ),
      };
    }
    return { cron: `${minute} ${hour} * * ${days}` };
  }
  // MONTHLY：月字段步长表达「每 N 个月」，日固定 1 号（界面没有「几号」选项，不偷偷用今天）。
  return { cron: `${minute} ${hour} 1 */${interval} *` };
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

/* ===========================================================================
 * 执行时间选择器（antd/vben 风格：日历面板 + 时/分 + 快捷项）
 * taskDraft.scheduledAt 仍存 "YYYY-MM-DDTHH:mm"（与原生 datetime-local 同格式），
 * 交互全部由面板接管，提交逻辑不变。
 * =========================================================================== */
const dtOpen = ref(false);
const dtRoot = ref<HTMLElement | null>(null);
const dtPanel = ref<HTMLElement | null>(null);
const dtPos = reactive({ top: 0, left: 0 });
const dtView = reactive({ y: new Date().getFullYear(), m: new Date().getMonth() });
const dtTemp = reactive({ date: "", time: "09:00" });

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

const dtDisplay = computed(() => (taskDraft.scheduledAt ? taskDraft.scheduledAt.replace("T", " ") : ""));

function openDtPicker() {
  if (taskDraft.scheduledAt) {
    const [d, t] = taskDraft.scheduledAt.split("T");
    dtTemp.date = d;
    dtTemp.time = t || "09:00";
    dtView.y = +d.slice(0, 4);
    dtView.m = +d.slice(5, 7) - 1;
  } else {
    const n = new Date();
    dtView.y = n.getFullYear();
    dtView.m = n.getMonth();
    dtTemp.date = "";
    dtTemp.time = "09:00";
  }
  dtOpen.value = true;
  void nextTick(updateDtPos);
}

/** 面板 Teleport 到 body 用 fixed 定位：弹窗 overflow:auto 会裁剪 absolute 面板。 */
function updateDtPos() {
  const el = dtRoot.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const panelH = dtPanel.value?.offsetHeight ?? 340;
  const below = window.innerHeight - r.bottom;
  const top = below >= panelH + 8 || below >= r.top ? r.bottom + 6 : Math.max(8, r.top - panelH - 6);
  dtPos.top = Math.round(top);
  dtPos.left = Math.round(Math.min(Math.max(8, r.left), window.innerWidth - 272));
}

function syncDtPos() {
  if (dtOpen.value) updateDtPos();
}

function commitDt() {
  taskDraft.scheduledAt = dtTemp.date ? `${dtTemp.date}T${dtTemp.time}` : "";
}

function pickDay(day: number) {
  dtTemp.date = `${dtView.y}-${pad2(dtView.m + 1)}-${pad2(day)}`;
  commitDt();
}

function shiftMonth(delta: number) {
  const t = new Date(dtView.y, dtView.m + delta, 1);
  dtView.y = t.getFullYear();
  dtView.m = t.getMonth();
}

function setDtTo(base: Date, time?: string) {
  dtView.y = base.getFullYear();
  dtView.m = base.getMonth();
  dtTemp.date = `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(base.getDate())}`;
  dtTemp.time = time ?? `${pad2(base.getHours())}:${pad2(base.getMinutes())}`;
  commitDt();
}

const DT_SHORTCUTS: Array<{ zh: string; en: string; pt: string; hi: string; fn: () => void }> = [
  { zh: "此刻", en: "Now", pt: "Agora", hi: "अभी", fn: () => setDtTo(new Date()) },
  { zh: "1 小时后", en: "In 1 hour", pt: "Em 1 hora", hi: "1 घंटे बाद", fn: () => setDtTo(new Date(Date.now() + 3600e3)) },
  {
    zh: "明天 09:00",
    en: "Tomorrow 9:00",
    pt: "Amanhã 9:00",
    hi: "कल सुबह 9:00",
    fn: () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      setDtTo(d);
    },
  },
];

const DT_WEEKDAYS: Array<{ zh: string; en: string; pt: string; hi: string }> = [
  { zh: "一", en: "Mo", pt: "Seg", hi: "सोम" },
  { zh: "二", en: "Tu", pt: "Ter", hi: "मंगल" },
  { zh: "三", en: "We", pt: "Qua", hi: "बुध" },
  { zh: "四", en: "Th", pt: "Qui", hi: "गुरु" },
  { zh: "五", en: "Fr", pt: "Sex", hi: "शुक्र" },
  { zh: "六", en: "Sa", pt: "Sáb", hi: "शनि" },
  { zh: "日", en: "Su", pt: "Dom", hi: "रवि" },
];

const dtMonthLabel = computed(() => {
  const enNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const ptNames = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
  const hiNames = ["जनवरी","फ़रवरी","मार्च","अप्रैल","मई","जून","जुलाई","अगस्त","सितंबर","अक्तूबर","नवंबर","दिसंबर"];
  return tx(
    `${dtView.y}年${dtView.m + 1}月`,
    `${enNames[dtView.m]} ${dtView.y}`,
    `${ptNames[dtView.m]} de ${dtView.y}`,
    `${hiNames[dtView.m]} ${dtView.y}`,
  );
});

/** 当前月视图格子（周一开头，null = 前置空白）。 */
const dtCells = computed<(number | null)[]>(() => {
  const first = new Date(dtView.y, dtView.m, 1);
  const offset = (first.getDay() + 6) % 7;
  const days = new Date(dtView.y, dtView.m + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < offset; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  return cells;
});

function dtDateStr(day: number): string {
  return `${dtView.y}-${pad2(dtView.m + 1)}-${pad2(day)}`;
}

function isDtToday(day: number): boolean {
  const n = new Date();
  return dtDateStr(day) === `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`;
}

function isDtPicked(day: number): boolean {
  return dtTemp.date === dtDateStr(day);
}

const DT_HOURS = Array.from({ length: 24 }, (_, i) => pad2(i));
const DT_MINUTES = Array.from({ length: 60 }, (_, i) => pad2(i));

const dtHour = computed({
  get: () => dtTemp.time.slice(0, 2),
  set: (v: string) => {
    dtTemp.time = `${v}:${dtTemp.time.slice(3)}`;
    commitDt();
  },
});
const dtMinute = computed({
  get: () => dtTemp.time.slice(3),
  set: (v: string) => {
    dtTemp.time = `${dtTemp.time.slice(0, 3)}${v}`;
    commitDt();
  },
});

/* 时刻支持手动输入：输入过程不写回数据源（避免 "8" → "8:00" 破坏 HH:mm 不变量再被 slice 回显成 "8:"），
 * 两位合法值即时提交；失焦/回车时钳制补零，非法输入回退当前值。 */
function makeDtTimePart(max: number, get: () => string, set: (v: string) => void) {
  let editing: string | null = null;
  return {
    onInput(e: Event) {
      const el = e.target as HTMLInputElement;
      editing = el.value;
      const n = parseInt(el.value, 10);
      if (/^\d{2}$/.test(el.value) && n >= 0 && n <= max) {
        set(pad2(n));
        editing = null;
      }
    },
    onChange(e: Event) {
      const el = e.target as HTMLInputElement;
      const n = parseInt(editing ?? el.value, 10);
      editing = null;
      const v = Number.isFinite(n) ? pad2(Math.min(max, Math.max(0, n))) : get();
      if (el.value !== v) el.value = v;
      set(v);
    },
  };
}

const dtHourPart = makeDtTimePart(23, () => dtHour.value, (v) => (dtHour.value = v));
const dtMinutePart = makeDtTimePart(59, () => dtMinute.value, (v) => (dtMinute.value = v));

/** 点击面板外关闭（面板已 Teleport 到 body，需同时排除触发器与面板本体）。 */
function onOutsideDt(e: MouseEvent) {
  if (!dtOpen.value) return;
  const t = e.target;
  if (!(t instanceof Node)) return;
  const inTrigger = dtRoot.value?.contains(t) ?? false;
  const inPanel = dtPanel.value?.contains(t) ?? false;
  if (!inTrigger && !inPanel) dtOpen.value = false;
}

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
  taskMcpExpanded.value = "";
  taskError.value = "";
  showTaskForm.value = true;
  // 任务表单也要选 MCP / 技能 / 通知通道：确保列表都已加载；新建时按服务端 defaultEnabled 预选 MCP。
  void refreshMcpAvailable().then(() => {
    if (!task && !taskDraft.mcpServers.length) {
      taskDraft.mcpServers = mcpAvailable.value.filter((s) => s.defaultEnabled).map((s) => s.id);
    }
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

const runStatusFilter = ref<"all" | "success" | "failed">("all");

function runMatchesFilter(status?: string): boolean {
  if (runStatusFilter.value === "all") return true;
  if (runStatusFilter.value === "success") return status === "success";
  return status === "failed" || status === "error" || status === "cancelled";
}

function filteredRuns<T extends { status?: string }>(runs: T[]): T[] {
  return runs.filter((r) => runMatchesFilter(r.status));
}

function taskNextRunText(t: ScheduleDto): string {
  if (!t.enabled) return tx("已暂停", "Paused", "Pausada", "रुका हुआ");
  // 一次性任务跑完即停用：停在目标时刻上展示，不要显示一个不存在的「下次」。
  if (t.onceAt) {
    return t.lastRunAt
      ? tx("已执行", "Ran", "Executada", "निष्पादित")
      : tx("执行于 ", "Runs at ", "Executa em ", "निष्पादन: ") + formatShortTime(t.onceAt);
  }
  return t.nextRunAt ? tx("下次 ", "Next ", "Próxima ", "अगली: ") + formatShortTime(t.nextRunAt) : "—";
}

/**
 * 一行卡片上的紧凑时间：今天的任务只显示时刻（省掉「9/21 」那截，给标题让出宽度），
 * 其余沿用 formatShortTime 的「9/21 16:00」。完整语义（含「下次 / 执行于」前缀）在 title 里。
 */
function taskNextShort(t: ScheduleDto): string {
  if (!t.enabled) return tx("已暂停", "Paused", "Pausada", "रुका हुआ");
  if (t.onceAt) return t.lastRunAt ? tx("已执行", "Ran", "Executada", "निष्पादित") : formatShortTime(t.onceAt);
  if (!t.nextRunAt) return "—";
  const d = new Date(t.nextRunAt);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : formatShortTime(t.nextRunAt);
}

/**
 * 一行卡片放不下的信息全进悬浮提示：类型 + 下次 + 任务内容 + 结果回到 + 工具 + 通知。
 * 卡面上只留标题/状态/时间，侧栏 200 来像素塞不下这些行。
 */
function taskCardTip(t: ScheduleDto): string {
  const head = tx("编辑", "Edit", "Editar", "संपादित करें") + "：" + (t.name || t.prompt);
  const lines = [head, `${taskKindText(t)} · ${taskNextRunText(t)}`];
  if (t.name) lines.push(t.prompt);
  lines.push(tx("健康", "Health", "Saúde", "स्थिति") + "：" + taskHealthShort(t));
  const runDetail = taskRunText(t);
  if (runDetail) lines.push(runDetail);
  if (t.notifyPolicy === "on_alert") {
    lines.push(
      tx(
        "通知：仅异常时推（正常 / 无数据不推）",
        "Notify: alerts only (normal / no-data stay silent)",
        "Notificar: só anomalias (normal / sem dados ficam quietos)",
        "सूचना: केवल असामान्य (सामान्य / बिना डेटा चुप)",
      ),
    );
  }
  lines.push(tx("结果回到", "Results to", "Resultado em", "परिणाम यहाँ") + "：" + taskConvText(t));
  lines.push(tx("工具", "Tools", "Ferramentas", "टूल") + "：" + taskToolsFact(t));
  const notify = taskNotifyFact(t);
  if (notify) lines.push(tx("通知通道", "Channels", "Canais", "चैनल") + "：" + notify);
  return lines.filter(Boolean).join("\n");
}

/** 卡片上的周期标签：一次性 / 周期（服务端用 onceAt 与 cron 区分）。 */
function taskKindText(t: ScheduleDto): string {
  return t.onceAt
    ? tx("一次性", "Once", "Única", "एक बार")
    : tx("周期", "Recurring", "Recorrente", "आवधिक");
}

/** 任务绑定的对话标题（结果回投到这里）；对话已被删则如实回显 id，不假装还在。 */
function taskConvText(t: ScheduleDto): string {
  return conversations.value.find((c) => c.id === t.conversationId)?.title || t.conversationId;
}

/** 正在编辑的任务（弹窗里展示「结果回到哪个对话」用）。 */
const editingTask = computed(() => tasks.value.find((t) => t.id === editingTaskId.value) || null);

/**
 * 打开某个结果会话：本地列表没有（换设备 / 刚被重建）就先刷新一次列表再选；
 * 实在没有则提示等下次运行时自动重建。任务对话与某一期对话共用这一段逻辑。
 */
async function openConversationById(convId: string, notFound: "task" | "run"): Promise<void> {
  let conv = conversations.value.find((c) => c.id === convId);
  if (!conv) {
    const list = await fetchConversations(showArchived.value, AGENT_ID).catch(() => null);
    if (list) {
      conversations.value = list;
      resortConversations();
      conv = list.find((c) => c.id === convId);
    }
  }
  if (!conv) {
    showSettingsError(
      notFound === "task"
        ? tx("该任务的对话已不存在，下次到点运行时会自动重建", "This task's chat is gone — it will be recreated on the next run", "A conversa desta tarefa não existe — será recriada na próxima execução", "इस कार्य की चैट मौजूद नहीं है — अगली रन पर फिर बनेगी")
        : tx("这一期的结果会话已不存在", "This run's chat no longer exists", "A conversa desta execução não existe mais", "इस रन की चैट अब मौजूद नहीं है"),
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

/** 工具步骤状态。`interrupted` = 没等到结果（连接中断 / 服务进程重启），如实展示，不冒充「失败」。 */
type StepStatus = "running" | "ok" | "error" | "cancelled" | "interrupted";

/** 子代理状态（独立事件维度）。`interrupted` 同 StepStatus 语义。 */
type SubagentStatus = "running" | "done" | "cancelled" | "error" | "interrupted";

/** 气泡里的一个工具步骤（MCP 工具调用）。 */
interface ToolStep {
  id: string;
  name: string;
  server?: string;
  args?: string;
  status: StepStatus;
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
  /** 等待用户确认的工具调用（write/destructive 级别或服务器级 requireConfirm；批准必须用一次性票据）。 */
  pending?: {
    id: string;
    ticket: string;
    name: string;
    server?: string;
    args?: string;
    level?: "read" | "write" | "destructive";
    reason?: string;
    argSummary?: Array<{ key: string; value: string }>;
    canGrantRead?: boolean;
    grantRead?: boolean;
    /** 票据有效期（服务端下发）：超时按拒绝处理，前端据此提示并自动作废卡片。 */
    expiresInMs?: number;
  } | null;
  /**
   * 结构化澄清（工具 request_clarification）：把模型的「散文追问」变成可点选的选项卡，
   * 复用确认通道回传用户选中的选项值。
   */
  clarification?: {
    id: string;
    ticket: string;
    question: string;
    options: Array<{ label: string; description?: string }>;
    /** 模型声明的「缺的是哪个决策点」与「为什么它会影响答案」（可选；未声明时不显示）。 */
    missingField?: string;
    whyItMatters?: string;
    expiresInMs?: number;
  } | null;
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
  /** 前端本地渲染图表（render_chart 产出；零外链，浏览器用 AntV 绘制）。一轮可出多张，按顺序展示。 */
  charts?: ChartSpec[];
  /** 可下载产物（export_data 产出；随对话快照恢复，前端渲染下载卡片，点一下即可拿走文件）。 */
  artifacts?: ArtifactSpec[];
  /** 子代理（task）实时状态：独立事件维度，随流式进度更新，仅作展示（不落库）。 */
  subagents?: Array<{
    id: string;
    parentId: string;
    description: string;
    status: SubagentStatus;
    text: string;
  }>;
  /** 扩展思考（thinking 增量拼接，支持思考的模型才有；仅作展示，不回灌模型上下文）。 */
  thinking?: string;
  /** 累计思考耗时（毫秒）：各思考段相加，工具执行/回灌的间隙不计；展示用（对齐 ChatGPT「Thought for Ns」）。 */
  thinkMs?: number;
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
  /** 用户为本对话勾选的技能（skills 目录名）；空 = 全部走索引 + read_skill 按需加载。 */
  skillsEnabled: string[];
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
  /** 待发的文档附件（PDF / Word / Excel / md / txt / csv）：随消息发 attachments，由服务端解析后注入上下文。 */
  pendingDocs: UploadResult[];
  /** 该对话最近一次错误（侧栏状态点用）。 */
  error: string;
  /** 对话级设置（模型 / 语言 / MCP 启用集 / 技能启用集）。 */
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
    pendingDocs: [],
    error: "",
    settings: { modelId: "", locale: "", mcpEnabled: [], skillsEnabled: [] },
    queue: [],
  };
}

const threadEl = ref<HTMLElement | null>(null);
const models = ref<ModelInfo[]>([]);
const conversations = ref<ConversationDto[]>([]);

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
const router = useRouter();
const agentProps = defineProps<{ agentId?: string; agentLabel?: string }>();
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
/** 触发菜单的元素（会话项 / ⋯ 按钮）：Esc 关闭后把焦点还回去（WAI-ARIA menu pattern）。 */
let ctxTriggerEl: HTMLElement | null = null;
/**
 * 菜单里「清空对话」的二次确认态（空 = 无）：首次点击只进入待确认，再点一次才执行；
 * 「关闭其它对话」改为走 confirmDialog 确认弹窗。菜单关闭即复位。
 */
const ctxConfirm = ref<"" | "clear">("");
/** 正在内联重命名的会话（id 为空 = 无）。 */
const renaming = ref<{ id: string; value: string }>({ id: "", value: "" });
const renameInputEl = ref<HTMLInputElement | null>(null);
/** 标题长度上限：只做体验层收敛，防误粘贴超长文本。 */
const RENAME_MAX = 100;
/** 删除撤销窗口：窗口内可撤销，超时才真正落库删除。 */
const UNDO_DELETE_MS = 5000;
const undoDelete = ref<{ conv: ConversationDto; index: number; wasCurrent: boolean } | null>(null);
let undoDeleteTimer: ReturnType<typeof setTimeout> | null = null;

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

/** 当前对话的模型选择；空 = 自动模式（运行时挑可用模型），UI 兜底展示「自动」。 */
const modelId = computed({
  get: () => current.value.settings.modelId || MODEL_AUTO_ID,
  set: (value: string) => {
    void saveModelChoice(value);
  },
});

/**
 * 「自动」模式解析：把 auto（或空/失效值）落到具体模型。
 * 优先用「上次成功用过的模型」，否则按列表顺序挑第一个「近期未失败」的——
 * 实现「哪个能用用哪个」：失败过的模型会被跳过，直到全部失败才重置黑名单重新探测。
 */
const lastGoodModelId = ref<string>("");
const failedModelIds = ref<Set<string>>(new Set());
function resolveModel(value: string): string {
  const ids = models.value.map((m) => m.id);
  const usable = (id: string | undefined) => !!id && ids.includes(id) && !failedModelIds.value.has(id);
  if (value && value !== MODEL_AUTO_ID && usable(value)) return value;
  if (usable(lastGoodModelId.value)) return lastGoodModelId.value;
  const next = ids.find((id) => !failedModelIds.value.has(id));
  if (next) return next;
  // 全部失败过：清空黑名单，给一次重新探测的机会。
  failedModelIds.value.clear();
  return ids[0] ?? "";
}

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
  if (!convId) return;
  try {
    await patchConversation(convId, { model: value });
    syncConvLocal(convId, { model: value });
  } catch (err) {
    state.settings.modelId = prev;
    showSettingsError(
      localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("模型保存失败", "Failed to save model", "Falha ao salvar o modelo", "मॉडल सहेजने में विफल")),
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
      localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("语言保存失败", "Failed to save language", "Falha ao salvar o idioma", "भाषा सहेजने में विफल")),
    );
  }
}

/** 实际生效的模型（auto 已解析为具体模型），用于图片能力等预判。 */
const resolvedModelId = computed(() => resolveModel(modelId.value));

/** 当前模型是否支持直读图片（由服务端 /models 的 vision 字段给出）。 */
const modelSupportsImages = computed(
  () => models.value.find((m) => m.id === resolvedModelId.value)?.vision === "direct",
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

let seq = 0;
let scrollQueued = false;

const canSend = computed(
  () => Boolean(current.value.input.trim() || current.value.pendingImages.length) && !current.value.sending,
);

/** 气泡更新时是否要跟随滚动：只有"正在看的这个对话"才滚，后台流不抢滚动条。 */
function queueScrollIfCurrent(convId: string) {
  if (currentId.value === convId) queueScroll();
}

/**
 * 跟底开关（stick-to-bottom）：流式增量只在「当前已贴近底部」（48px 容差）时才自动跟随。
 * 没有它，用户在生成中上滚阅读历史会被下一片增量拉回底部——「回到顶部」也就形同虚设。
 * 判定挂在滚动容器的 scroll 事件上（程序滚动同样触发），滚回底部附近即自动恢复跟随。
 */
let followBottom = true;
function nearBottom(el: HTMLElement, gap = 48): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < gap;
}
function onThreadScroll() {
  const el = threadEl.value;
  if (el) followBottom = nearBottom(el);
}

function queueScroll(force = false) {
  if (!force && !followBottom) return;
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    void nextTick(() => {
      const el = threadEl.value;
      if (!el) return;
      // 执行时再按实时几何复核（阈值放宽到 240px：单片增量一般长不了这么多，超出只可能是用户上滚）。
      // 只靠标记有个窗口：rAF+nextTick 双重延迟下，密集增量可能先于 scroll 事件把用户刚上滚的位置盖掉。
      if (!force && !nearBottom(el, 240)) return;
      if (force) followBottom = true;
      el.scrollTop = el.scrollHeight;
    });
  });
}

// ---- 推理过程（任务计划 + 工具步骤）折叠：生成中默认展开，收束后自动折叠，避免长过程刷屏 ----
const openReasoning = reactive(new Set<number>());

function toggleReasoning(id: number) {
  if (openReasoning.has(id)) openReasoning.delete(id);
  else openReasoning.add(id);
}

/**
 * 单步结果的展开态（键 = 气泡 id + 步骤 id）。
 * 结果默认收起：一次工具循环常有 3-8 步，全部铺开会把气泡撑得很长；收起时用一行摘要交代
 * 「这步拿到了什么」，要看全文再点开（对齐 antd Collapse 的「默认收起 + 摘要」）。
 */
const openSteps = reactive(new Set<string>());

function stepKey(b: Bubble, step: ToolStep): string {
  return `${b.id}::${step.id}`;
}

function toggleStep(b: Bubble, step: ToolStep) {
  if (!step.result) return;
  const key = stepKey(b, step);
  if (openSteps.has(key)) openSteps.delete(key);
  else openSteps.add(key);
}

/** 收起时的摘要：取结果首个非空行并截断（只作提示，全文点开看）。 */
function stepSummary(step: ToolStep): string {
  const line = (step.result || "")
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (!line) return "";
  // 抓正文的步骤结果首行是 markdown 标题（`# 标题`）：摘要里去掉标记，省得像乱码。
  return line.replace(/^#{1,6}\s*/, "").slice(0, 90);
}

function hasRunningStep(b: Bubble): boolean {
  return !!b.steps?.some((s) => s.status === "running");
}

/**
 * 是否真的有思考内容。流式片段常常只推来空白（换行/空格），
 * 直接判 `b.thinking` 会把「空白的推理面板」渲染出来，所以统一按去空白后判断。
 */
function hasThinking(b: Bubble): boolean {
  return !!b.thinking && b.thinking.trim().length > 0;
}

// 意图识别：只认模型显式写的「意图：/Intent:」前缀。
// 不做「取首句」兜底——推理流首行经常是半截话（如「用户只输入了"123"，没有明确的请求或问题。这可能是：」），
// 截断后放进高亮卡里像坏数据，也是推理面板观感差的主要来源之一（ChatGPT/Claude 都不做这种二次高亮）。
const INTENT_RE = /^(意图|Intent)\s*[:：]\s*(.+)$/i;

function intentOf(b: Bubble): string | undefined {
  const firstLine = (b.thinking || "").split("\n", 1)[0].trim();
  const m = firstLine.match(INTENT_RE);
  return m ? m[2].trim() : undefined;
}

// 去掉首行意图（作为意图行展示）后的思考流，避免重复；无意图时不剥离。
function thinkingDisplay(b: Bubble): string {
  if (!intentOf(b)) return b.thinking || "";
  const t = b.thinking || "";
  const nl = t.indexOf("\n");
  return nl >= 0 ? t.slice(nl + 1).replace(/^\s*\n/, "") : "";
}

// ---- 思考耗时（对齐 ChatGPT「Thought for Ns」的口径）----
// 各思考段分别计时后累加：工具执行 / 结果回灌的间隙不算思考；
// 计时起点放模块级 Map（气泡 id → 该段首个思考增量时刻），不进响应式状态。
const thinkStarts = new Map<number, number>();

function thinkPhaseStart(id: number) {
  if (!thinkStarts.has(id)) thinkStarts.set(id, Date.now());
}

/** 结束当前思考段并累加进气泡：正文到达 / 收束 / 出错时都要调，否则该段时长丢失。 */
function thinkPhaseEnd(reply: Bubble) {
  const start = thinkStarts.get(reply.id);
  if (!start) return;
  thinkStarts.delete(reply.id);
  reply.thinkMs = (reply.thinkMs || 0) + (Date.now() - start);
}

/** 展示用耗时（如「8 秒」）；累计不足 0.8s 不显示，避免短轮次凑热闹。 */
function thinkLabel(b: Bubble): string {
  if (!b.thinkMs || b.thinkMs < 800) return "";
  const s = Math.round(b.thinkMs / 1000);
  return tx(`${s} 秒`, `${s}s`, `${s}s`, `${s} सेकंड`);
}

// 思考流跟底：面板限高内滚，不跟底就只能盯着开头（推理增量很密，rAF 合并避免每片都触发布局）。
let thinkStickQueued = false;
function stickThinkingToBottom() {
  if (thinkStickQueued) return;
  thinkStickQueued = true;
  requestAnimationFrame(() => {
    thinkStickQueued = false;
    // 取最后一个思考区：正在流式的通常就是最新一条助手气泡。
    const bodies = threadEl.value?.querySelectorAll<HTMLElement>(".reasoning__thinking");
    const last = bodies?.length ? bodies[bodies.length - 1] : null;
    if (last) last.scrollTop = last.scrollHeight;
  });
}

function reasoningTitle(b: Bubble): string {
  const n = b.steps?.length || 0;
  const sn = b.subagents?.length || 0;
  // 思考期（流式、已收到 thinking 但还没具体步骤）：有意图识别则标「理解意图」，否则「思考中」。
  if (b.streaming && hasThinking(b) && !b.steps?.length && !b.todos?.length && !b.subagents?.length)
    return intentOf(b)
      ? tx("理解意图…", "Understanding intent…", "Entendendo a intenção…", "इरादा समझ रहा है…")
      : tx("思考中…", "Thinking…", "Pensando…", "सोच रहा है…");
  // 已在出正文但尚无步骤/子代理（模型未显式规划，直接作答）：标「回答中」，避免还挂着「正在规划」像卡死。
  if (b.streaming && b.text && !b.steps?.length && !b.todos?.length && !b.subagents?.length)
    return tx("回答中…", "Answering…", "Respondendo…", "उत्तर दे रहा है…");
  // 静默规划期（流式但还没有任何步骤/子代理，也没有思考流、也没出正文）：显式标「正在规划」。
  if (b.streaming && !b.steps?.length && !b.todos?.length && !b.subagents?.length)
    return tx("正在规划…", "Planning…", "Planejando…", "योजना बना रहा है…");
  if (b.streaming && hasRunningStep(b)) return tx("推理中…", "Reasoning…", "Pensando…", "तर्क कर रहा है…");
  if (b.streaming && sn) {
    return tx(`子代理运行中 · ${sn} 个`, `Subagents running · ${sn}`, `Subagentes rodando · ${sn}`, `उप-एजेंट चल रहे · ${sn}`);
  }
  if (n) return tx(`推理过程 · ${n} 步`, `Reasoning · ${n} step${n > 1 ? "s" : ""}`, `Raciocínio · ${n} passos`, `तर्क · ${n} चरण`);
  if (b.todos?.length) return tx("任务计划", "Plan", "Plano", "कार्य योजना");
  if (sn) return tx(`子代理 · ${sn} 个`, `Subagents · ${sn}`, `Subagentes · ${sn}`, `उप-एजेंट · ${sn}`);
  return tx("推理过程", "Reasoning", "Raciocínio", "तर्क प्रक्रिया");
}

/** 读取快照里的图表 spec（兼容旧的单张 chart 字段：并入 charts）。 */
function chartsOf(m: StoredMessage): ChartSpec[] {
  const list = Array.isArray(m.charts) ? m.charts : [];
  return m.chart ? [...list, m.chart] : list;
}

/**
 * 快照的状态归一：**快照里不存在「正在跑」**。
 * 落库与恢复都过这一遍——终态没收到的步骤（连接被切断 / 服务进程重启）若以 running 存进库，
 * 刷新后会被当成实时状态永久转圈（用户看到的「卡住」就是这个）。宁可如实记中断，也不冒充仍在执行。
 */
function settleStep(step: ToolStep): ToolStep {
  return step.status === "running" ? { ...step, status: "interrupted" } : step;
}

function toStored(list: Bubble[]): StoredMessage[] {
  return list
    // 只出图、没有正文的气泡也必须落库：否则整条消息（连图一起）刷新后消失。
    .filter((b) => b.text || b.images?.length || b.charts?.length || b.artifacts?.length)
    .map((b) => ({
      role: b.role,
      text: b.text,
      images: b.images,
      // 推理面板相关字段一并落库：刷新后从后端快照恢复，思考过程 / 工具步骤 / 任务规划不丢。
      ...(b.thinking ? { thinking: b.thinking } : {}),
      ...(b.thinkMs ? { thinkMs: b.thinkMs } : {}),
      ...(b.steps?.length ? { steps: b.steps.map(settleStep) } : {}),
      ...(b.todos?.length ? { todos: b.todos } : {}),
      // 图表 spec 也要落库：图是浏览器现场画的、产物只在内存，不存就会「刷新即消失」。
      ...(b.charts?.length ? { charts: b.charts } : {}),
      // 下载卡片同理：产物实体在服务端，快照只存 spec，刷新后由卡片按 path 重绘。
      ...(b.artifacts?.length ? { artifacts: b.artifacts } : {}),
    }));
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
  // 定时任务表单/任务页开着时点其它对话 = 放下它们切过去（不能挡住侧栏导航）。
  if (showTaskForm.value) closeTaskForm();
  showTaskList.value = false;
  const state = stateOf(conv.id);
  // 切走时若上一个对话仍在生成：交给后台守望，跑完提醒一次（免打扰的对话不提醒）。
  const leaving = currentId.value;
  if (leaving && leaving !== conv.id) {
    const leavingState = states.get(leaving);
    if (leavingState?.sending || leavingState?.controller) watchBackgroundDone(leaving);
  }
  currentId.value = conv.id;
  sidebarOpen.value = false; // 移动端选中对话后收起抽屉
  reportActiveConversation(conv.id);
  // 打开的是某一期的结果 → 该任务的未读清零（放在选中之后：即便清零请求失败也不影响阅读）。
  clearTaskUnread(conv.id);
  // 仅首次载入时用服务端快照建气泡；已有气泡说明本地状态更新（可能正在流式），不能覆盖。
  if (!state.bubbles.length) {
    state.bubbles = (conv.messages || []).map((m) => ({
      id: ++seq,
      role: m.role,
      text: m.role === "assistant" ? dedupeRepeats(m.text || "") : (m.text || ""),
      images: m.images,
      // 推理面板相关字段恢复（与 toStored 对称）：思考过程 / 工具步骤 / 任务规划。
      ...(m.thinking ? { thinking: m.thinking } : {}),
      ...(m.thinkMs ? { thinkMs: m.thinkMs } : {}),
      // 历史快照里可能存着 running（收不到终态的轮次）：读回来先归一，否则刷新即「永久转圈」。
      ...(Array.isArray(m.steps) && m.steps.length
        ? { steps: (m.steps as ToolStep[]).map(settleStep) }
        : {}),
      ...(Array.isArray(m.todos) && m.todos.length ? { todos: m.todos as TodoItem[] } : {}),
      // 图表卡片恢复（与 toStored 对称）：刷新后由 ChartCard 按 spec 重绘。
      ...(chartsOf(m).length ? { charts: chartsOf(m) } : {}),
      // 下载卡片恢复（与 toStored 对称）：刷新后由卡片按 spec 重绘。
      ...(Array.isArray(m.artifacts) && m.artifacts.length ? { artifacts: m.artifacts as ArtifactSpec[] } : {}),
    }));
  }
  // 设置按对话灌入（列表条目在每次写成功后都会同步，故不会用过期值覆盖）。
  state.settings.modelId = conv.model || "";
  state.settings.mcpEnabled = conv.mcpServers || [];
  state.settings.skillsEnabled = conv.skillsEnabled || [];
  state.settings.locale = isUiLocale(conv.locale) ? conv.locale : "";
  state.queue = conv.pendingQueue || [];
  applyConversationLocale(state.settings.locale);
  // 面板的可用服务器列表是全局的；启用集来自该对话。
  void loadMcp(conv.id);
  // 技能面板：可用列表全局，启用集按对话。
  void loadSkills(conv.id);
  queueScroll(true); // 切对话是用户动作：无条件回底，并重置跟底状态
  // 服务端还有这个对话的任务在跑（刷新 / 换设备进来）：接回事件流继续显示，而不是干等结果回投。
  void attachRunningTask(conv.id);
}

/**
 * 新建对话 = 进入「草稿态」（对齐 CodeBuddy）：不立即调接口建会话，
 * 编辑器切到空白（共享 blank 态），列表也不加「新对话」空壳；
 * 首条消息真正发出时才创建会话入列表（见 send 的草稿分支 → createConvFromDraft）。
 * 点开没说话就切走 / 刷新，什么残留都没有；草稿里输入的文字再次进入草稿时保留。
 */
function newConversation() {
  // 任务表单/任务页开着时点「新建对话」= 关掉进草稿态（与 selectConversation 同口径）。
  if (showTaskForm.value) closeTaskForm();
  showTaskList.value = false;
  // 草稿本身没有流；离开正在生成的对话时交给后台守望（与 selectConversation 同口径）。
  const leaving = currentId.value;
  if (leaving) {
    const leavingState = states.get(leaving);
    if (leavingState?.sending || leavingState?.controller) watchBackgroundDone(leaving);
  }
  currentId.value = "";
  sidebarOpen.value = false; // 移动端点「新建对话」后收起抽屉
  queueScroll(true);
}

/**
 * 草稿态首条消息 → 此刻才真正创建会话：标题取首条消息截断（对齐 CodeBuddy），
 * 草稿里已选的设置（模型 / MCP / 技能）一并继承落库，语言始终继承当前界面语言。
 * 创建失败时把错误写回草稿态并返回空串（调用方收口，输入内容不丢，可重试）。
 */
async function createConvFromDraft(firstText: string): Promise<string> {
  const draft = current.value; // 草稿态即共享 blank
  const collapsed = firstText.replace(/\s+/g, " ").trim();
  const fallback = tx("新对话", "New chat", "Nova conversa", "नई चैट");
  const title = collapsed ? (collapsed.length > 30 ? `${collapsed.slice(0, 30)}…` : collapsed) : fallback;
  let conv: ConversationDto;
  try {
    conv = await createConversation({ title, agentId: AGENT_ID });
  } catch (err) {
    draft.error = localizeToken(
      uiLocale.value,
      getApiErrorToken(err),
      (err as Error)?.message || tx("对话创建失败", "Failed to create conversation", "Falha ao criar conversa", "बातचीत बनाने में विफल"),
    );
    return "";
  }
  conversations.value = [conv, ...conversations.value.filter((c) => c.id !== conv.id)];
  // 直接前插会让新对话跑到置顶区之上：按统一排序规则归位（新对话在普通区最上）。
  resortConversations();
  // 手动排序模式下，新对话没有 sortOrder 会沉到普通区底部：显式把它排到普通区最前。
  if (sortMode.value === "manual") {
    const firstRegular = conversations.value.find((c) => !c.pinnedAt && c.id !== conv.id);
    if (firstRegular) void applyConversationOrder(conv.id, firstRegular.id, false);
  }
  // 草稿里挑过的设置带进新对话（runTurn 读的是新对话自己的 state，必须先搬再发）。
  const st = stateOf(conv.id);
  st.settings = { ...draft.settings, locale: uiLocale.value };
  currentId.value = conv.id;
  reportActiveConversation(conv.id);
  const patch: { locale?: string; model?: string; mcpServers?: string[]; skillsEnabled?: string[] } = {
    locale: st.settings.locale,
  };
  if (st.settings.modelId) patch.model = st.settings.modelId;
  if (st.settings.mcpEnabled.length) patch.mcpServers = [...st.settings.mcpEnabled];
  if (st.settings.skillsEnabled.length) patch.skillsEnabled = [...st.settings.skillsEnabled];
  // 首条消息紧接着就开跑，服务端按对话文档里的启用集取工具。必须等落库完成再拉列表，
  // 否则 loadMcp 会用新建对话的空启用集把草稿勾选盖掉，这一轮也用不上连接器。
  try {
    await patchConversation(conv.id, patch);
    syncConvLocal(conv.id, patch);
  } catch {
    /* 落库失败不阻断发送；前端 state 已带上设置，下次保存会再写 */
  }
  void loadMcp(conv.id);
  void loadSkills(conv.id);
  return conv.id;
}

/** 手动顺序步长（须与服务端 `ORDER_STEP` 一致）：相邻项间隔，便于中间插入。 */
const CONV_ORDER_STEP = 1000;

/**
 * 排序规则：
 * ① 归档组永远在最末（归档 = 收起来，不与在用对话混排；也不参与置顶组）；
 * ② 置顶组在普通组之上；
 * ③ 组内：`manual` 模式先按手动顺序（没排过的沉到最后），否则按默认序；
 * ④ 默认序：置顶组按置顶时间（新的在上），普通组按最近活动。
 */
function convRank(a: ConversationDto, b: ConversationDto): number {
  const aa = a.archived ? 1 : 0;
  const ba = b.archived ? 1 : 0;
  if (aa !== ba) return aa - ba;
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
    conversations.value = await fetchConversations(false, AGENT_ID).catch(() => prevOrder);
    resortConversations();
    showSettingsError(
      localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("排序失败", "Reorder failed", "Falha ao reordenar", "क्रम बदलने में विफल")),
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

/** 菜单当前指向的会话（模板渲染菜单项状态用）。 */
const ctxTarget = computed(() => conversations.value.find((c) => c.id === ctxMenu.value.targetId) || null);

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

/** 菜单锚点：键盘触发（Shift+F10 / 菜单键）时 clientX/Y 为 0，退回到触发项自身定位。 */
function ctxAnchorPos(e: MouseEvent): { x: number; y: number } {
  const itemRect = ctxTriggerEl?.getBoundingClientRect();
  const keyboardTriggered = !e.clientX && !e.clientY && !!itemRect;
  return {
    x: keyboardTriggered && itemRect ? itemRect.left + 12 : e.clientX,
    y: keyboardTriggered && itemRect ? itemRect.bottom : e.clientY,
  };
}

/** 渲染后按菜单实际尺寸做视口边界翻转，并把焦点移入首个菜单项（WAI-ARIA menu pattern）。 */
async function placeCtxMenu(anchor: { x: number; y: number }) {
  await nextTick();
  const el = ctxMenuEl.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const pad = 8;
  let { x, y } = ctxMenu.value;
  if (x + rect.width + pad > window.innerWidth) x = Math.max(pad, anchor.x - rect.width);
  if (y + rect.height + pad > window.innerHeight) y = Math.max(pad, anchor.y - rect.height);
  ctxMenu.value = { ...ctxMenu.value, x, y };
  el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
}

/** 打开会话上下文菜单（右键触发）。 */
async function openCtxMenu(e: MouseEvent, conv: ConversationDto) {
  e.preventDefault();
  e.stopPropagation();
  ctxTriggerEl = (e.currentTarget as HTMLElement | null) || null;
  const anchor = ctxAnchorPos(e);
  ctxMenu.value = { open: true, x: anchor.x, y: anchor.y, targetId: conv.id, taskId: "" };
  await placeCtxMenu(anchor);
}

/** 打开定时任务上下文菜单（右键触发）：编辑 / 暂停恢复 / 打开结果对话 / 标记已读 / 删除。 */
async function openTaskCtxMenu(e: MouseEvent, task: ScheduleDto) {
  e.preventDefault();
  e.stopPropagation();
  ctxTriggerEl = (e.currentTarget as HTMLElement | null) || null;
  const anchor = ctxAnchorPos(e);
  ctxMenu.value = { open: true, x: anchor.x, y: anchor.y, targetId: "", taskId: task.id };
  await placeCtxMenu(anchor);
}

/** 关闭上下文菜单；restoreFocus 用于键盘路径（Esc）把焦点还给触发元素。 */
function closeCtxMenu(restoreFocus = false) {
  if (!ctxMenu.value.open) return;
  ctxMenu.value = { ...ctxMenu.value, open: false };
  ctxConfirm.value = "";
  if (restoreFocus) ctxTriggerEl?.focus();
  ctxTriggerEl = null;
}

/** 首次点击「不可撤销」菜单项：进入待确认态并把焦点带到确认项（菜单保持打开，菜单项被替换后焦点会掉到 body）。 */
async function armCtxConfirm(kind: "clear") {
  ctxConfirm.value = kind;
  await nextTick();
  ctxMenuEl.value?.querySelector<HTMLElement>("[data-ctx-confirm]")?.focus();
}

// ---- 对话 P2 留档项：归档 / 复制 / 导出 ----

/**
 * 重新拉取侧栏列表（切换「显示归档」时调用）。
 * 开关写进设备偏好（刷新 / 换设备后保持），并保住撤销窗口里那笔待删对话的「已删除」状态
 * —— 服务端要等窗口结束才真删，直接覆盖会让它闪回来。
 */
async function reloadConversations() {
  void saveChatPreferences({ showArchived: showArchived.value }).catch(() => undefined);
  const list = await fetchConversations(showArchived.value, AGENT_ID).catch(() => null);
  // 拉取失败保持原列表：静默清空会让人以为对话都丢了。
  if (!list) return;
  const pendingDeleted = undoDelete.value?.conv.id;
  conversations.value = pendingDeleted ? list.filter((c) => c.id !== pendingDeleted) : list;
  resortConversations();
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
  // 归档对话不在「其它对话」之列：归档本就是把它收起来，批量关闭不该连带删掉看不见的对话。
  const others = conversations.value.filter((c) => c.id !== keepId && !c.archived);
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

/** 忙时入队（排队语义）：先本地、后落库，失败回滚并提示。 */
async function enqueueMessage(convId: string, text: string, imageIds: string[], docIds: string[] = []) {
  const state = stateOf(convId);
  if (state.queue.length >= MAX_QUEUE) {
    showSettingsError(tx("排队消息已达上限，请先处理队列", "The queue is full; handle it first", "A fila está cheia; resolva-a primeiro", "कतार भरी हुई है; पहले उसे संभालें"));
    return;
  }
  const item: PendingMessage = {
    text,
    ...(imageIds.length ? { images: imageIds } : {}),
    ...(docIds.length ? { docs: docIds } : {}),
    at: Date.now(),
  };
  const prev = state.queue;
  state.queue = [...prev, item];
  try {
    await patchConversation(convId, { pendingQueue: state.queue });
    syncConvLocal(convId, { pendingQueue: state.queue });
  } catch (err) {
    state.queue = prev;
    showSettingsError(
      localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("排队失败", "Failed to queue message", "Falha ao enfileirar", "कतार में जोड़ने में विफल")),
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
      localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("队列保存失败", "Failed to save queue", "Falha ao salvar a fila", "कतार सहेजने में विफल")),
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
  await runTurn(convId, next.text, next.images || [], undefined, next.docs || []);
}

async function send() {
  const state = current.value;
  let convId = currentId.value;
  const text = state.input.trim();
  if (!text && !state.pendingImages.length && !state.pendingDocs.length) return;
  followBottom = true; // 用户发送：无条件回底（新一轮回复从底部开始展示）
  if (!convId) {
    // 草稿态首条消息：此刻才创建会话入列表（对齐 CodeBuddy）；失败则保留输入不丢内容。
    convId = await createConvFromDraft(text);
    if (!convId) return;
  }
  if (state.sending) {
    // 排队语义：同一对话在生成时，新消息进待发队列（服务端 409 是并发标签页的兜底）。
    await enqueueMessage(
      convId,
      text,
      state.pendingImages.map((i) => i.id),
      state.pendingDocs.map((i) => i.id),
    );
    state.input = "";
    state.pendingImages = [];
    state.pendingDocs = [];
    return;
  }
  const images = state.pendingImages.slice();
  const docs = state.pendingDocs.slice();
  // 发送后清空输入框与待发附件（仅在这条「用户主动发送」路径清；出队/立即发送走各自入参，不碰当前输入）。
  state.input = "";
  state.pendingImages = [];
  state.pendingDocs = [];
  await runTurn(
    convId,
    text,
    images.map((i) => i.id),
    images.map((i) => ({ id: i.id, name: i.name })),
    docs.map((i) => i.id),
  );
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
  /** 本轮请求的模型（auto 模式下用于失败黑名单）。 */
  chosenModel: string;
  /** 是否收到过终态事件（done / 服务端 error）：没收到就结束的流 = 中断，必须收口。 */
  sawTerminal: boolean;
  /** 已消费到的最后一个事件序号 = 续传游标（服务端据它只回放更新的部分）。 */
  lastSeq: number;
  /** 本轮的任务 id（`POST /chat/stream` 的响应头给出）：续传时带回去，确认接的还是**同一轮**。 */
  taskId?: string;
  /** 服务端终态错误码（决定要不要把该模型记进失败黑名单）。 */
  serverErrorCode?: string;
}

/**
 * 把一条服务端事件应用到气泡上：首连与续传共用同一条路径。
 * `seq` 只用于记账（游标），渲染分支完全不关心它；`ping` 是保活事件，忽略即可。
 */
function applyChatEvent(run: TurnRun, event: ChatEvent): void {
  if (typeof event.seq === "number" && event.seq > run.lastSeq) run.lastSeq = event.seq;
  const { convId, reply, state } = run;
  if (event.type === "text_delta") {
    reply.text += event.text;
    thinkPhaseEnd(reply);
    queueScrollIfCurrent(convId);
  } else if (event.type === "text") {
    // 替换语义：终稿全文、以及续传时服务端补发的正文快照都走这里（幂等，不会把正文拼两遍）。
    reply.text = event.text;
    thinkPhaseEnd(reply);
  } else if (event.type === "thinking_delta") {
    // 扩展思考增量：拼接进 reasoning 面板，实时展示模型规划过程，取代「正在规划」占位。
    reply.thinking = (reply.thinking || "") + event.text;
    thinkPhaseStart(reply.id);
    openReasoning.add(reply.id);
    queueScrollIfCurrent(convId);
    stickThinkingToBottom();
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
    // 安全判定只在服务端（工具级别声明 + 策略），前端只做展示：是否弹卡、用什么级别弹卡都由事件决定。
    reply.pending = {
      id: event.id,
      ticket: event.ticket,
      name: event.name,
      server: event.server,
      args: event.args,
      level: event.level,
      reason: event.reason,
      argSummary: event.argSummary,
      canGrantRead: event.canGrantRead,
      expiresInMs: event.expiresInMs,
    };
    scheduleConfirmExpiry(reply, event.expiresInMs);
    queueScrollIfCurrent(convId);
  } else if (event.type === "confirmation_response") {
    reply.pending = null;
  } else if (event.type === "clarification_required") {
    // 结构化澄清：选项由模型给出，用户点选后把选项值回传（与确认卡同通道、同票据机制）。
    reply.clarification = {
      id: event.id,
      ticket: event.ticket,
      question: event.question,
      options: event.options,
      ...(event.missingField ? { missingField: event.missingField } : {}),
      ...(event.whyItMatters ? { whyItMatters: event.whyItMatters } : {}),
      expiresInMs: event.expiresInMs,
    };
    queueScrollIfCurrent(convId);
  } else if (event.type === "clarification_response") {
    reply.clarification = null;
  } else if (event.type === "error") {
    // 服务端明确宣告的终态：这条之后流再断也算「有结论」，不走中断收口。
    run.sawTerminal = true;
    run.serverErrorCode = String(event.error?.code || event.code || "");
    const message = localizeToken(uiLocale.value, event.error, event.message || "GENERIC_UNKNOWN_ERROR");
    reply.error = message;
    state.error = message;
    // 终态已到，但本地可能还挂着「执行中」的步骤 / 子代理（例如无进展收口 / 服务重启中断）：
    // 一并按「中断」归一，否则气泡会一直显示「执行中」——与「快照里不存在正在跑」同一条纪律。
    for (const step of reply.steps || []) if (step.status === "running") step.status = "interrupted";
    for (const sa of reply.subagents || []) if (sa.status === "running") sa.status = "interrupted";
    reply.pending = null;
    reply.clarification = null;
  } else if (event.type === "todos") {
    // 任务规划（write_todos）：挂到当前回复气泡上，随执行推进状态。
    reply.todos = event.todos;
    openReasoning.add(reply.id);
    queueScrollIfCurrent(convId);
  } else if (event.type === "chart") {
    // 本地渲染图表（render_chart）：追加到当前回复气泡，由 ChartCard 用 AntV 绘制。
    // 一轮可能出多张（如「两张图对比」），必须逐张累积——单字段会让后一张覆盖前一张。
    reply.charts = reply.charts || [];
    reply.charts.push({
      title: event.title,
      chartType: event.chartType,
      data: event.data,
      encode: event.encode,
      options: event.options,
    });
    queueScrollIfCurrent(convId);
  } else if (event.type === "artifact") {
    // 可下载产物（export_data）：累积到当前回复气泡，刷新后由下载卡片按 spec 重绘。
    // 同一文件可能被同一轮重试多次产出，按 path 去重（保留最后一次，字节数以最新为准）。
    reply.artifacts = reply.artifacts || [];
    const existing = reply.artifacts.find((a) => a.path === event.path);
    if (existing) {
      existing.name = event.name;
      existing.bytes = event.bytes;
      existing.mime = event.mime;
    } else {
      reply.artifacts.push({ path: event.path, name: event.name, bytes: event.bytes, mime: event.mime });
    }
    queueScrollIfCurrent(convId);
  } else if (event.type === "subagent_start") {
    reply.subagents = reply.subagents || [];
    reply.subagents.push({
      id: event.id,
      parentId: event.parentId,
      description: event.description,
      status: "running",
      text: "",
    });
    // 与 tool_call / todos 同约定：结构化进度一出现就展开「推理过程」，否则子代理面板默认收看不到。
    openReasoning.add(reply.id);
    queueScrollIfCurrent(convId);
  } else if (event.type === "subagent_delta") {
    const sa = (reply.subagents || []).find((s) => s.id === event.id);
    if (sa) sa.text += event.text;
    queueScrollIfCurrent(convId);
  } else if (event.type === "subagent_end") {
    const sa = (reply.subagents || []).find((s) => s.id === event.id);
    if (sa) {
      sa.status = event.status;
      sa.text = event.text;
    }
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
    run.sawTerminal = true;
    // 收束时清理模型回声式重复（只改内存展示，不改落库文本）。
    reply.text = dedupeRepeats(reply.text);
    thinkPhaseEnd(reply);
    reply.streaming = false;
    openReasoning.delete(reply.id);
    // 本轮成功：记下来实际用到的具体模型，供「自动」模式下次优先复用（哪个能用用哪个）。
    if (!reply.error) lastGoodModelId.value = run.chosenModel;
    // 正常收束时理论上不该再有「执行中」的步骤 / 子代理（结果事件可能因缓冲裁剪等缺口没到）：
    // 顺手归一，让「气泡里不留永久转圈的步骤」这条不变量在任何路径上都成立。
    for (const step of reply.steps || []) if (step.status === "running") step.status = "interrupted";
    for (const sa of reply.subagents || []) if (sa.status === "running") sa.status = "interrupted";
  }
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
  if (state.sending) {
    // 并发兜底（例如另一标签页正在生成同对话）：入队而不是报错，消息不丢。
    // 图片与文档附件都必须带上：漏传 docIds 会让「排队才发的那条」静默丢附件（正文在、文件没了）。
    await enqueueMessage(convId, text, imageIds, docIds);
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
    clarification: null,
    subagents: [],
  });
  state.bubbles.push(reply);
  // 流式开始即展开推理面板：loading 期直接显示「正在规划…」，避免只剩空白/圆点像卡死。
  openReasoning.add(reply.id);
  state.sending = true;
  state.error = "";
  const chosenModel = resolveModel(state.settings.modelId);
  // 中断句柄存进「该对话自己的」状态：切到别的对话后按停止不会误伤这一条。
  const controller = new AbortController();
  state.controller = controller;
  queueScrollIfCurrent(convId);

  // 本轮上下文：事件处理与续传共用同一个对象（游标 lastSeq 随事件推进）。
  const run: TurnRun = { convId, reply, state, chosenModel, sawTerminal: false, lastSeq: 0 };
  let stopped = false;
  let queued = false;
  let interrupted = false;
  try {
    await streamChat(
      text,
      // conversationId 显式带上：不依赖服务端的活跃对话回退（多标签页时会串）；agentId 供服务端按角色分流。
      { conversationId: convId, model: chosenModel || undefined, images: imageIds, attachments: docIds, agentId: AGENT_ID },
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
      // 服务端并发保护（如另一标签页在跑）：消息不丢，进队列等下一轮自动发。
      queued = true;
      reply.text = tx("（该对话正在生成中，此消息已加入待发队列）", "(Chat is busy; the message was queued)", "(A conversa está ocupada; a mensagem entrou na fila)", "(चैट व्यस्त है; संदेश कतार में जोड़ दिया गया)");
      await enqueueMessage(convId, text, imageIds, docIds);
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
    state.sending = false;
    state.controller = null;
    // auto 模式：本轮失败则把该模型记入黑名单（下次解析跳过），成功则清除其失败标记。
    // 仅「模型真的不可用」计入——用户主动停止 / 对话繁忙 / 后台继续 / 中断 / 无进展收口 都不算。
    if (reply.error && !NOT_MODEL_FAULT_CODES.has(run.serverErrorCode || "")) failedModelIds.value.add(chosenModel);
    else failedModelIds.value.delete(chosenModel);
    // 显式带上 convId：此刻用户可能已经切到别的对话，不能写错对话。
    await persist(convId, state.bubbles);
    queueScrollIfCurrent(convId);
    // 出队决策：停止 / 中断 / 出错 / 已再入队 / 仍有待确认 → 停下等用户，不自动发下一条
    // （中断的轮次连接已经不可靠，接着发下一条大概率也失败，交给用户决定）。
    void drainQueue(convId, !stopped && !interrupted && !queued && !reply.error && !reply.pending);
  }
}

/** 停止只作用于「当前正在看的这个对话」，不影响其它对话的流。
 *  执行与推送解耦后，断开连接不再中止生成——必须显式调取消端点。 */
function stop() {
  const convId = currentId.value;
  current.value.controller?.abort();
  if (convId) void cancelChatTask(convId).catch(() => undefined);
}

// ---- 后台任务完成提醒（免打扰的作用对象）----
// 场景：多会话并行 —— 用户切走后任务仍在后台跑，跑完给一次提醒；该对话免打扰则静默。
const doneToast = ref<{ id: string; title: string } | null>(null);
let doneToastTimer: ReturnType<typeof setTimeout> | null = null;
const bgWatch = new Map<string, ReturnType<typeof setInterval>>();

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
    const running = await isChatTaskRunning(convId).catch(() => false);
    if (running && ticks < 180) return;
    clearInterval(timer);
    bgWatch.delete(convId);
    if (running) return; // 超时：不再打扰
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
          "（连接已中断，生成仍在后台继续；完成后重新打开该对话即可看到结果）",
          "(Connection lost; generation continues in the background — reopen this conversation to see the result)",
          "(Conexão perdida; a geração continua em segundo plano — reabra esta conversa para ver o resultado)",
          "(कनेक्शन टूट गया; निर्माण पृष्ठभूमि में जारी है — परिणाम देखने के लिए यह चैट दोबारा खोलें)",
        )
      : tx(
          "（本轮已中断：连接结束且服务端没有在跑的任务，未完成的部分请重新发起）",
          "(This turn was interrupted — the connection ended and no task is running on the server; please retry)",
          "(Este turno foi interrompido — a conexão terminou e não há tarefa em execução no servidor; tente novamente)",
          "(यह चरण बाधित हुआ — कनेक्शन समाप्त और सर्वर पर कोई कार्य नहीं चल रहा; कृपया फिर से प्रयास करें)",
        ),
  );
  if (backgroundRunning) watchBackgroundDone(convId);
  openReasoning.delete(reply.id);
  queueScrollIfCurrent(convId);
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
  const reply = reactive<Bubble>({
    id: ++seq,
    role: "assistant",
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
  fresh.controller = controller;
  fresh.sending = true;
  try {
    const attached = await resumeChatTaskEvents(
      convId,
      { from: 0, ...(run.taskId ? { taskId: run.taskId } : {}) },
      (event) => applyChatEvent(run, event),
      controller.signal,
    );
    if (!attached) {
      fresh.bubbles = fresh.bubbles.filter((b) => b.id !== reply.id);
      openReasoning.delete(reply.id);
      return;
    }
    // 挂上了却没跑到终态（连接又断）：与首连同一条路径——先退避续传，仍不行才如实收口。
    if (!run.sawTerminal && !(await resumeRun(run, controller.signal))) await settleInterruptedRun(run);
  } catch {
    // 网络不通 / 用户按了停止：留下气泡并如实说明这一轮没能拿到终态（不假装还在跑）。
    await settleInterruptedRun(run);
  } finally {
    fresh.sending = false;
    fresh.controller = null;
    reply.streaming = false;
    thinkPhaseEnd(reply);
    openReasoning.delete(reply.id);
    await persist(convId, fresh.bubbles);
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
  setTimeout(() => {
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

// ---- MCP 连接面板 ----
/**
 * 拉取某对话的可用服务器与启用集（必须显式传 conversationId：
 * 不带会回退到服务端 activeConversationId，读到的是别的对话）。
 * 响应可能晚于对话切换，所以写回「发起时那个对话」的状态，避免串味。
 */
async function loadMcp(convId = currentId.value) {
  // 草稿态没有对话 id。不带 conversationId 的 GET 会回退到服务端 activeConversationId，
  // 只能取全局 available，不能把别的对话的启用集写进草稿。
  if (!convId) {
    const data = await fetchChatMcpServers().catch(() => null);
    if (data) mcpAvailable.value = data.available;
    return;
  }
  const data = await fetchChatMcpServers(convId).catch(() => null);
  if (!data) return;
  mcpAvailable.value = data.available;
  const state = states.get(convId);
  if (state) state.settings.mcpEnabled = data.enabled;
}

/**
 * 打开连接器飞出面板（互斥：同时只开一个飞出）。
 * @param focusSearch 是否把焦点放进搜索框：点击打开要（可直接打字），悬停打开不要
 *   （否则鼠标扫过菜单就把焦点从消息输入框抢走）。
 */
function openMcpPanel(focusSearch = true) {
  // 已展开则保持：仅确保互斥，不重置搜索框/焦点/重新拉取（hover 重复进入不应清空用户输入）。
  if (mcpOpen.value) {
    skillOpen.value = false;
    expertOpen.value = false;
    return;
  }
  mcpOpen.value = true;
  skillOpen.value = false;
  expertOpen.value = false;
  mcpQuery.value = "";
  searchAutofocus.value = focusSearch;
  loadPinyin();
  void loadMcp();
}

/** 勾选/取消某个 MCP 服务器（乐观更新 + 失败回滚）。 */
async function toggleMcp(id: string, on: boolean) {
  const convId = currentId.value;
  const state = current.value;
  const prev = state.settings.mcpEnabled;
  const next = on ? [...new Set([...prev, id])] : prev.filter((item) => item !== id);
  state.settings.mcpEnabled = next;
  if (!on && mcpExpanded.value === id) mcpExpanded.value = "";
  // 草稿态只改内存，对齐模型选择：首条消息创建对话时再落库（createConvFromDraft）。
  // 勾选时预热连接，行状态才能从「未启用」变成连接中/已连接。
  if (!convId) {
    if (on) void connectTaskMcp(id);
    return;
  }
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
      (err as Error)?.message || tx("操作失败", "Request failed", "Falha na solicitação", "अनुरोध विफल"),
    );
  } finally {
    mcpBusy.value = false;
  }
}

/** 取消全部启用（面板是纯选择语义，不再提供断开/删除服务端）。 */
async function clearMcpSelection() {
  const convId = currentId.value;
  const state = current.value;
  const prev = state.settings.mcpEnabled;
  state.settings.mcpEnabled = [];
  mcpExpanded.value = "";
  if (!convId) return;
  mcpBusy.value = true;
  mcpError.value = "";
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
      (err as Error)?.message || tx("操作失败", "Request failed", "Falha na solicitação", "अनुरोध विफल"),
    );
  } finally {
    mcpBusy.value = false;
  }
}

async function reconnectMcp(id: string) {
  const convId = currentId.value;
  mcpBusy.value = true;
  mcpError.value = "";
  try {
    await reloadMcpServer(id);
    // 任务表单可能没有对话 id：仍要刷新 available 才能看到「已连接」。
    if (convId) await loadMcp(convId);
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
): { cls: string; text: string } {
  if (!enabled.includes(s.id)) {
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

// ---- 技能面板（与 MCP 面板同构：列表全局、启用集按对话持久化）----
const skillOpen = ref(false);
const skillAvailable = ref<SkillMeta[]>([]);
const skillBusy = ref(false);
const skillError = ref("");

async function loadSkills(convId = currentId.value) {
  const data = await fetchChatSkills(convId || undefined).catch(() => null);
  if (!data) return;
  skillAvailable.value = data.available;
  // 草稿态：不带 id 的响应会带回服务端当前活动对话的勾选，不能写进草稿。
  if (!convId) return;
  const state = stateOf(convId);
  state.settings.skillsEnabled = data.enabled;
}

/** 打开技能飞出面板（互斥：同时只开一个飞出；focusSearch 语义同 toggleMcpPanel）。 */
function openSkillPanel(focusSearch = true) {
  // 已展开则保持：仅确保互斥，不重置搜索框/焦点/重新拉取（hover 重复进入不应清空用户输入）。
  if (skillOpen.value) {
    mcpOpen.value = false;
    expertOpen.value = false;
    return;
  }
  skillOpen.value = true;
  mcpOpen.value = false;
  expertOpen.value = false;
  // 每次从关闭→打开都从空关键词开始，避免残留上次搜索词导致列表看着「少了几项」。
  skillQuery.value = "";
  searchAutofocus.value = focusSearch;
  loadPinyin();
  void loadSkills();
}

/** 勾选/取消某个技能（乐观更新 + 失败回滚；语义：勾选 = 全文注入系统提示，不勾 = 按需加载）。 */
async function toggleSkill(dir: string, on: boolean) {
  const convId = currentId.value;
  if (skillBusy.value) return;
  const state = convId ? stateOf(convId) : current.value;
  const prev = state.settings.skillsEnabled;
  const next = on ? [...prev, dir] : prev.filter((x) => x !== dir);
  state.settings.skillsEnabled = next;
  // 草稿态只改内存；创建对话时再落库（对齐 toggleMcp / saveModelChoice）。
  if (!convId) return;
  skillBusy.value = true;
  skillError.value = "";
  try {
    const data = await setChatSkills(next, convId);
    stateOf(convId).settings.skillsEnabled = data.enabled;
    syncConvLocal(convId, { skillsEnabled: data.enabled });
  } catch (err) {
    state.settings.skillsEnabled = prev;
    skillError.value = localizeToken(
      uiLocale.value,
      getApiErrorToken(err),
      (err as Error)?.message || tx("技能勾选失败", "Failed to update skills", "Falha ao atualizar habilidades", "स्किल अपडेट विफल"),
    );
  } finally {
    skillBusy.value = false;
  }
}

async function clearSkillSelection() {
  const convId = currentId.value;
  const state = convId ? stateOf(convId) : current.value;
  const prev = state.settings.skillsEnabled;
  state.settings.skillsEnabled = [];
  if (!convId) return;
  skillBusy.value = true;
  skillError.value = "";
  try {
    const data = await setChatSkills([], convId);
    stateOf(convId).settings.skillsEnabled = data.enabled;
    syncConvLocal(convId, { skillsEnabled: data.enabled });
  } catch (err) {
    state.settings.skillsEnabled = prev;
    skillError.value = localizeToken(
      uiLocale.value,
      getApiErrorToken(err),
      (err as Error)?.message || tx("技能勾选失败", "Failed to update skills", "Falha ao atualizar habilidades", "स्किल अपडेट विफल"),
    );
  } finally {
    skillBusy.value = false;
  }
}

// ---- 输入框左下角「工具」入口（对齐 ima：菜单 + 右侧飞出面板）----
const toolsMenuOpen = ref(false);
const toolsRoot = ref<HTMLElement | null>(null);
const skillQuery = ref("");
const mcpQuery = ref("");
/** 本次打开飞出面板是否把焦点放进搜索框（点击 = true，悬停 = false）。 */
const searchAutofocus = ref(true);

const skillFiltered = computed(() => {
  const q = skillQuery.value.trim().toLowerCase();
  // 读 pinyinReady 建立依赖：字典异步就绪后触发重算，启用拼音匹配。
  void pinyinReady.value;
  if (!q) return skillAvailable.value;
  // 单字母关键词只匹配可见名称；目录名与描述归「长字段」，避免任意字母命中一堆英文标识。
  return skillAvailable.value.filter((s) => matchesFuzzyScoped([s.name], [s.dir, s.description], q));
});

const mcpFiltered = computed(() => {
  const q = mcpQuery.value.trim().toLowerCase();
  void pinyinReady.value;
  if (!q) return mcpAvailable.value;
  return mcpAvailable.value.filter((s) => matchesFuzzyScoped([s.label], [s.id], q));
});

/**
 * 连接器角标只数「当前列表里确实存在」的 id：服务器若被从服务端配置里移除，
 * 对话的启用集里可能残留悬空 id，直接按数组长度算就会出现「面板里一个勾都没有、角标却显示 1」。
 * 列表还没拉到（首次打开菜单的预取窗口）时不判定，避免角标先亮后灭。
 */
const enabledMcpCount = computed(() => {
  const ids = current.value.settings.mcpEnabled;
  if (!mcpAvailable.value.length) return ids.length;
  return ids.filter((id) => mcpAvailable.value.some((s) => s.id === id)).length;
});

function toggleToolsMenu() {
  toolsMenuOpen.value = !toolsMenuOpen.value;
  if (toolsMenuOpen.value) {
    // 打开菜单就预取两份列表：飞出面板秒开无等待。
    void loadSkills();
    void loadMcp();
    // 后台拉起拼音字典，之后打开任一搜索面板都能用拼音（首屏不背这体积）。
    loadPinyin();
  } else {
    skillOpen.value = false;
    mcpOpen.value = false;
    expertOpen.value = false;
  }
}

/** 连接器一行描述：transport · 工具数 (+ 首个错误)，同时用于悬浮全文。 */
function mcpDescText(s: McpServerStatus): string {
  const parts = [`${s.transport} · ${s.tools} ${tx("工具", "tools", "ferramentas", "टूल")}`];
  if (s.error) parts.push(s.error);
  else if (s.toolsError) parts.push(s.toolsError);
  return parts.join(" · ");
}

const expertOpen = ref(false);
// 专家菜单只列「有专门角色」的 Agent：观影助手属独立项目（/movie）不在此列，
// 通用助手是默认形态也不算专家；其余专家（如客服）在此列出。
const expertAgents: AgentEntry[] = AGENTS.filter((a) => a.id !== "movie" && a.id !== "generic");
// 当前选中的专家（无 = 通用，对齐 CodeBuddy：chip 存在即已选专家，无 chip 即通用）。
const currentExpert = computed(() => expertAgents.find((a) => a.id === AGENT_ID));

const expertQuery = ref("");
/**
 * 专家搜索：单字符关键词只匹配「当前界面语言的名称」（否则英文名/长描述里的字母会让任意
 * 字母都命中，如输入 a 命中「Support assistant」）；≥2 个字符才扩展到 id、四语名称与描述。
 */
const expertFiltered = computed(() => {
  const q = expertQuery.value.trim().toLowerCase();
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

/** 打开专家飞出面板（互斥：同时只开一个飞出；focusSearch 语义同 toggleMcpPanel）。 */
function openExpertPanel(focusSearch = true) {
  // 已展开则保持：仅确保互斥，不重置搜索框/焦点（hover 重复进入不应清空用户输入）。
  if (expertOpen.value) {
    skillOpen.value = false;
    mcpOpen.value = false;
    return;
  }
  expertOpen.value = true;
  skillOpen.value = false;
  mcpOpen.value = false;
  expertQuery.value = "";
  searchAutofocus.value = focusSearch;
  loadPinyin();
}

// 收起所有工具面板（专家/技能/连接器/主菜单），切换专家或取消选中前调用。
function closeToolsPanels() {
  toolsMenuOpen.value = false;
  expertOpen.value = false;
  skillOpen.value = false;
  mcpOpen.value = false;
}

function onPickExpert(agent: AgentEntry) {
  closeToolsPanels();
  router.push(agent.path);
}

// chip 上的 ×：取消选中专家，回到 /chat（generic）。
function onClearExpert() {
  closeToolsPanels();
  router.push("/chat");
}

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
  if (status === "error" || status === "cancelled" || status === "interrupted") return "err";
  return "running";
}

function stepStatusText(status: StepStatus): string {
  if (status === "ok") return tx("已完成", "done", "concluído", "पूर्ण");
  if (status === "error") return tx("失败", "failed", "falhou", "विफल");
  if (status === "cancelled") return tx("已拒绝", "denied", "recusado", "अस्वीकृत");
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

/** 停止标记：历史消息把「已停止生成」拼在文本尾部，渲染/复制时拆出来单独展示。 */
const STOP_TEXT_MARKERS = [
  "（已停止生成）",
  " (stopped)",
  "(stopped)",
  " (geração interrompida)",
  "(geração interrompida)",
  " (उत्पादन रोक दिया गया)",
  "(उत्पादन रोक दिया गया)",
];

function isStoppedBubble(b: Bubble): boolean {
  return STOP_TEXT_MARKERS.some((m) => b.text.endsWith(m));
}

/** 气泡正文（去掉尾部停止标记），用于渲染与复制。 */
function bubbleBody(b: Bubble): string {
  for (const m of STOP_TEXT_MARKERS) {
    if (b.text.endsWith(m)) return b.text.slice(0, b.text.length - m.length).trimEnd();
  }
  return b.text;
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
function reportActiveConversation(convId: string) {
  if (!convId) return;
  // 活跃对话槽按角色分存（generic 才写旧字段；其余角色由服务端 stream 时的 activeByAgent 维护）。
  if (AGENT_ID !== "generic") return;
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
  // 移动端抽屉：Esc 关闭（桌面端无抽屉、此监听无害）。
  window.addEventListener("keydown", onSidebarEsc);
  models.value = await fetchModels().catch(() => []);
  // 不在这里写 modelId：它已按对话派生（空 = 自动模式，UI 兜底展示「自动」），
  // 赋值会触发一次无意义的 PATCH。
  // 不在这里 loadMcp()：此刻还没选中对话，请求会回退到服务端的 activeConversationId（可能是别的对话）。
  // 交给下面的 selectConversation / newConversation 按对话加载。
  window.addEventListener("mousedown", onOutsideTools);
  window.addEventListener("keydown", onEscTools);
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
    initialConversationId = prefs.activeConversationId;
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
  const target = list.find((c) => c.id === (linkedConvId || initialConversationId)) || list[0];
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

onBeforeUnmount(() => {
  stopTasksPoll();
  window.removeEventListener("keydown", onSidebarEsc);
  window.removeEventListener("mousedown", onOutsideTools);
  window.removeEventListener("keydown", onEscTools);
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
});
</script>

<template>
  <div class="chat" @click="closeCtxMenu()">
    <aside class="sidebar" :class="{ open: sidebarOpen, collapsed: sidebarCollapsed }" :aria-label="tx('会话列表', 'Conversations', 'Conversas', 'चैट सूची')">
      <div class="sidebar__inner">
      <div class="brand">
        <h1 class="brand__name">{{ AGENT_LABEL || tx("小助手", "Assistant", "Assistente", "सहायक") }}</h1>
        <RouterLink to="/" class="brand__home" :title="tx('返回门户', 'Back to portal', 'Voltar ao portal', 'पोर्टल पर वापस')">⌂</RouterLink>
        <button
          v-if="!isMobile"
          type="button"
          class="brand__collapse"
          :aria-label="tx('收起会话列表', 'Collapse conversations', 'Recolher conversas', 'सूची समेटें')"
          :title="tx('收起会话列表', 'Collapse conversations', 'Recolher conversas', 'सूची समेटें')"
          @click="toggleSidebar()"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="9" y1="4" x2="9" y2="20" />
          </svg>
        </button>
      </div>
      <!-- CodeBuddy 版式：顶部「图标 + 文字」操作导航行（创建入口集中在这），分组列表收在下方。 -->
      <nav class="side-nav" :aria-label="tx('快捷操作', 'Quick actions', 'Ações rápidas', 'त्वरित क्रियाएँ')">
        <button class="side-nav__item" type="button" @click="newConversation">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v8M8 12h8" />
          </svg>
          <span>{{ tx("新建对话", "New chat", "Nova conversa", "नई चैट") }}</span>
        </button>
        <button class="side-nav__item" type="button" @click="openTaskListPage()">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          <span>{{ tx("定时任务", "Scheduled tasks", "Tarefas agendadas", "अनुसूचित कार्य") }}</span>
        </button>
      </nav>
      <div class="conv-search" role="search">
        <svg class="conv-search__icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7"></circle>
          <path d="m20 20-3.2-3.2"></path>
        </svg>
        <input
          v-model="convQuery"
          class="conv-search__input"
          type="text"
          :placeholder="tx('搜索对话', 'Search chats', 'Buscar conversas', 'चैट खोजें')"
          :aria-label="tx('搜索对话', 'Search chats', 'Buscar conversas', 'चैट खोजें')"
          @input="onConvSearchInput"
        />
      </div>
      <label class="conv-archived-toggle" :title="tx('显示已归档的对话', 'Show archived chats', 'Mostrar conversas arquivadas', 'आर्काइव की चैट दिखाएं')">
        <input type="checkbox" v-model="showArchived" @change="reloadConversations" />
        {{ tx("显示归档", "Archived", "Arquivadas", "आर्काइव") }}
      </label>
      <div ref="convListEl" class="conv-list">
        <!-- 定时任务区（docs/scheduled-task-sessions-plan.md §3.10）：置顶为可折叠分组。
             父 = 任务（未读角标 + 下次运行），子 = 各期会话（时间 + 状态点），默认折叠。
             与 CodeBuddy「定时任务收在任务名下」、Finder/VS Code「分组置顶 + 箭头折叠」同口径：
             分组头整行可点、chevron 箭头旋转、带 aria-expanded。 -->
        <template v-if="!convQuery.trim()">
          <button
            class="group-head"
            type="button"
            :aria-expanded="taskSectionOpen ? 'true' : 'false'"
            :aria-label="tx('定时任务', 'Scheduled', 'Agendados', 'अनुसूचित कार्य')"
            @click="toggleTaskSection"
          >
            <span class="group-head__label">{{ tx("定时任务", "Scheduled", "Agendados", "अनुसूचित कार्य") }}</span>
            <span class="group-head__count">({{ taskGroups.length }})</span>
            <span class="group-head__caret" :class="{ open: taskSectionOpen }" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
            </span>
          </button>
          <div v-if="taskSectionOpen && taskGroups.length" class="run-filter" role="group" :aria-label="tx('按结果筛选', 'Filter runs', 'Filtrar execuções', 'रन फ़िल्टर')">
            <button type="button" :class="{ active: runStatusFilter === 'all' }" :aria-pressed="runStatusFilter === 'all'" @click="runStatusFilter = 'all'">{{ tx("全部", "All", "Todas", "सभी") }}</button>
            <button type="button" :class="{ active: runStatusFilter === 'success' }" :aria-pressed="runStatusFilter === 'success'" @click="runStatusFilter = 'success'">{{ tx("成功", "Success", "Sucesso", "सफल") }}</button>
            <button type="button" :class="{ active: runStatusFilter === 'failed' }" :aria-pressed="runStatusFilter === 'failed'" @click="runStatusFilter = 'failed'">{{ tx("失败", "Failed", "Falhou", "विफल") }}</button>
          </div>
          <div v-if="taskSectionOpen && !taskGroups.length" class="task-groups-empty">
            {{ tx("还没有定时任务，点上方「新建」即可创建", "No tasks yet — click “New” above", "Nenhuma tarefa ainda — clique em “Novo” acima", "अभी कोई कार्य नहीं — ऊपर “नया” पर क्लिक करें") }}
          </div>
          <div v-if="taskSectionOpen" class="task-groups">
            <div v-for="g in taskGroups" :key="g.schedule.id" class="task-group">
              <div
                class="task-group__head"
                role="button"
                tabindex="0"
                :aria-expanded="expandedTasks[g.schedule.id] ? 'true' : 'false'"
                :aria-label="g.schedule.name || g.schedule.prompt"
                @click="toggleTaskGroup(g.schedule.id)"
                @keydown="onTaskGroupKeydown($event, g.schedule.id)"
                @contextmenu.prevent="openTaskCtxMenu($event, g.schedule)"
              >
                <span class="task-group__caret" :class="{ open: expandedTasks[g.schedule.id] }" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                </span>
                <span
                  class="conv-dot"
                  :class="taskDotClass(g.schedule)"
                  :title="taskCardTip(g.schedule)"
                  :aria-label="taskHealthShort(g.schedule)"
                  role="img"
                ></span>
                <span class="task-group__main">
                  <span class="task-group__title" :title="taskCardTip(g.schedule)">{{ g.schedule.name || g.schedule.prompt }}</span>
                  <span class="task-group__health" :title="taskCardTip(g.schedule)">{{ taskHealthShort(g.schedule) }}</span>
                </span>
                <span
                  v-if="g.schedule.unreadRuns"
                  class="task-group__unread"
                  :title="tx('有新的运行结果', 'New run results', 'Novos resultados de execução', 'नए रन परिणाम')"
                  :aria-label="tx('有新的运行结果', 'New run results', 'Novos resultados de execução', 'नए रन परिणाम')"
                >{{ g.schedule.unreadRuns }}</span>
                <span class="task-group__next">{{ taskRightShort(g.schedule) }}</span>
                <button
                  class="task-group__open"
                  type="button"
                  :title="tx('打开最近一期', 'Open latest run', 'Abrir execução mais recente', 'नवीनतम रन खोलें')"
                  :aria-label="tx('打开最近一期', 'Open latest run', 'Abrir execução mais recente', 'नवीनतम रन खोलें')"
                  @click.stop="openTaskConversation(g.schedule)"
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M7 17 17 7" />
                    <path d="M9 7h8v8" />
                  </svg>
                </button>
              </div>
              <template v-if="expandedTasks[g.schedule.id]">
                <div v-if="!filteredRuns(g.runs).length" class="task-groups-empty">
                  {{ tx("没有符合筛选的运行记录", "No runs match this filter", "Nenhuma execução neste filtro", "इस फ़िल्टर में कोई रन नहीं") }}
                </div>
                <div
                  v-for="r in filteredRuns(g.runs)"
                  :key="r.conversationId"
                  class="conv-item conv-item--run"
                  :class="{ active: r.conversationId === currentId }"
                  role="button"
                  tabindex="0"
                  :aria-current="r.conversationId === currentId ? 'true' : undefined"
                  @click="openRunConversation(r)"
                  @keydown="onRunKeydown($event, r)"
                  @contextmenu.prevent="r.conv && openCtxMenu($event, r.conv)"
                >
                  <span
                    v-if="r.status || r.marker"
                    class="conv-dot"
                    :class="r.marker === 'SPIKE' ? 'alert' : r.marker === 'NO_DATA' ? 'nodata' : (r.status || 'idle')"
                    :title="(r.marker ? taskMarkerText(r.marker) + ' · ' : '') + taskStatusText({ ...g.schedule, lastStatus: r.status as ScheduleDto['lastStatus'] })"
                    role="img"
                  ></span>
                  <span class="conv-title">{{ r.conv?.title || runTimeText(r.at) }}{{ r.marker ? ` · ${taskMarkerText(r.marker)}` : "" }}</span>
                  <span class="conv-run-at">{{ runMetaText(r) }}</span>
                </div>
              </template>
            </div>
          </div>
        </template>
        <!-- 对话分组头：与定时任务分组头同款（CodeBuddy「名称 (数量) ›」口径），可整列折叠；搜索时直接让位给结果。 -->
        <button
          v-if="!convQuery.trim() && conversationsFiltered.length"
          class="group-head"
          type="button"
          :aria-expanded="convSectionOpen ? 'true' : 'false'"
          :aria-label="tx('对话', 'Chats', 'Conversas', 'चैट')"
          @click="toggleConvSection"
        >
          <span class="group-head__label">{{ tx("对话", "Chats", "Conversas", "चैट") }}</span>
          <span class="group-head__count">({{ conversationsFiltered.length }})</span>
          <span class="group-head__caret" :class="{ open: convSectionOpen }" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
          </span>
        </button>
        <template v-if="convSectionOpen || convQuery.trim()">
        <!-- 首屏慢加载才亮骨架行；快加载时不闪，直接等真实条目出现。 -->
        <template v-if="showSkeleton">
          <div class="conv-skeleton" aria-hidden="true"></div>
          <div class="conv-skeleton" aria-hidden="true"></div>
          <div class="conv-skeleton" aria-hidden="true"></div>
        </template>
        <template v-for="(conv, i) in conversationsFiltered" :key="conv.id">
          <div v-if="!convQuery.trim() && pinnedCount > 0 && i === pinnedCount" class="conv-divider" role="separator">
            {{ tx("置顶", "Pinned", "Fixadas", "पिन किए गए") }}
          </div>
          <!-- 归档区固定在列表末尾（由 convRank 保证），勾选「显示归档」后才有内容。 -->
          <div v-if="!convQuery.trim() && archivedCount > 0 && i === firstArchivedIndex" class="conv-divider" role="separator">
            {{ tx("归档", "Archived", "Arquivadas", "आर्काइव") }}
          </div>
          <div
            class="conv-item"
            :class="{
              active: conv.id === currentId,
              pinned: !!conv.pinnedAt,
              'conv-archived': !!conv.archived,
              dragging: draggingId === conv.id,
              'drop-before': dropTarget?.id === conv.id && !dropTarget?.after,
              'drop-after': dropTarget?.id === conv.id && !!dropTarget?.after,
            }"
            :data-conv-id="conv.id"
            role="button"
            tabindex="0"
            :aria-current="conv.id === currentId ? 'true' : undefined"
            aria-haspopup="menu"
            :draggable="renaming.id !== conv.id && !conv.archived && !convQuery.trim()"
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
              :aria-label="tx('重命名对话', 'Rename chat', 'Renomear conversa', 'चैट का नाम बदलें')"
              @keydown="onRenameKeydown"
              @blur="commitRename"
              @click.stop
            />
            <template v-else>
              <span class="conv-title">{{ conv.title || tx("新对话", "New chat", "Nova conversa", "नई चैट") }}</span>
              <span
                v-if="conv.muted"
                class="conv-muted"
                :title="tx('免打扰：该对话的完成提醒已静默', 'Muted: completion alerts are silenced', 'Silenciado: alertas silenciados', 'मूक: पूर्णता सूचनाएं बंद')"
                :aria-label="tx('免打扰', 'Muted', 'Silenciado', 'मूक')"
              >{{ tx("免打扰", "Muted", "Silenciado", "मूक") }}</span>
              <span
                v-if="queueCount(conv)"
                class="conv-queue"
                :title="tx('有排队消息', 'Has queued messages', 'Mensagens na fila', 'कतार में संदेश हैं')"
                :aria-label="tx('有排队消息', 'Has queued messages', 'Mensagens na fila', 'कतार में संदेश हैं')"
              >{{ queueCount(conv) }}</span>
              <button
                class="conv-del"
                type="button"
                :title="tx('删除对话', 'Delete chat', 'Excluir conversa', 'चैट हटाएं')"
                @click.stop="askDeleteConversation(conv)"
              >
                ×
              </button>
            </template>
          </div>
        </template>
        </template>
      </div>
      <p v-if="convQuery.trim() && !conversationsFiltered.length" class="conv-empty">
        {{ tx("没有匹配的对话", "No matching chats", "Nenhuma conversa correspondente", "कोई मेल खाने वाली चैट नहीं") }}
      </p>
      <button
        class="ghost-btn"
        :class="{ 'ghost-btn-danger': clearArmed }"
        type="button"
        @click="onClearCurrentClick"
      >
        {{
          clearArmed
            ? tx("确认清空（不可恢复）", "Confirm clear (can't be undone)", "Confirmar limpeza (irreversível)", "खाली करने की पुष्टि (अपरिवर्तनीय)")
            : tx("清空当前对话", "Clear current chat", "Limpar conversa atual", "वर्तमान चैट खाली करें")
        }}
      </button>
      </div>
    </aside>
    <!-- 移动端抽屉遮罩：仅抽屉打开时渲染，点击关闭；桌面端汉堡隐藏、不会打开（指南 §6 阻断项 #2）。 -->
    <div
      v-if="sidebarOpen"
      class="sidebar-backdrop"
      aria-hidden="true"
      @click="sidebarOpen = false"
    ></div>
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
        <!-- 定时任务菜单：右键任务分组头时渲染；与对话菜单互斥（ctxTargetTask / ctxTarget 二选一）。 -->
        <template v-if="ctxTargetTask">
          <button type="button" class="ctx-item" role="menuitem" :disabled="!!ctxTargetTask.runRequestedAt" @click="ctxRunTaskNow">
            {{ ctxTargetTask.runRequestedAt ? tx("即将执行", "Queued", "Na fila", "कतार में") : tx("立即执行", "Run now", "Executar agora", "अभी चलाएँ") }}
          </button>
          <button type="button" class="ctx-item" role="menuitem" @click="ctxOpenTaskConv">
            {{ tx("打开结果对话", "Open results chat", "Abrir conversa de resultados", "परिणाम चैट खोलें") }}
          </button>
          <button type="button" class="ctx-item" role="menuitem" @click="ctxEditTask">
            {{ tx("编辑任务", "Edit task", "Editar tarefa", "कार्य संपादित करें") }}
          </button>
          <button type="button" class="ctx-item" role="menuitem" @click="ctxToggleTaskEnabled">
            {{ ctxTargetTask.enabled ? tx("暂停任务", "Pause task", "Pausar tarefa", "कार्य रोकें") : tx("恢复任务", "Resume task", "Retomar tarefa", "कार्य फिर से चलाएं") }}
          </button>
          <button v-if="ctxTargetTask.unreadRuns" type="button" class="ctx-item" role="menuitem" @click="ctxMarkTaskRead">
            {{ tx("标记已读", "Mark read", "Marcar como lido", "पढ़ा हुआ मार्क करें") }}
          </button>
          <div class="ctx-sep" role="separator"></div>
          <button type="button" class="ctx-item danger" role="menuitem" @click="ctxRemoveTask">
            {{ tx("删除任务", "Delete task", "Excluir tarefa", "कार्य हटाएं") }}
          </button>
        </template>
        <template v-else>
        <button type="button" class="ctx-item" role="menuitem" @click="ctxTarget && startRename(ctxTarget)">
          <span>{{ tx("重命名", "Rename", "Renomear", "नाम बदलें") }}</span>
          <kbd class="ctx-kbd">F2</kbd>
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="ctxTarget && togglePin(ctxTarget)">
          {{ ctxTarget?.pinnedAt ? tx("取消置顶", "Unpin", "Desafixar", "अनपिन करें") : tx("置顶", "Pin", "Fixar", "पिन करें") }}
        </button>
        <button
          v-if="sortMode === 'manual'"
          type="button"
          class="ctx-item"
          role="menuitem"
          @click="restoreRecentSort"
        >
          {{ tx("恢复自动排序", "Sort by recent", "Ordenar por recentes", "हाल के अनुसार क्रम") }}
        </button>
        <div class="ctx-sep" role="separator"></div>
        <!-- 清空对话无撤销入口：首点进入待确认，再点才执行；关闭其它对话走下方确认弹窗。 -->
        <button
          v-if="ctxConfirm !== 'clear'"
          type="button"
          class="ctx-item"
          role="menuitem"
          @click="armCtxConfirm('clear')"
        >
          {{ tx("清空对话", "Clear chat", "Limpar conversa", "चैट खाली करें") }}
        </button>
        <button
          v-else
          data-ctx-confirm
          type="button"
          class="ctx-item danger"
          role="menuitem"
          @click="clearConversationById(ctxMenu.targetId)"
        >
          {{ tx("确认清空（不可恢复）", "Confirm clear (can't be undone)", "Confirmar limpeza (irreversível)", "खाली करने की पुष्टि (अपरिवर्तनीय)") }}
        </button>
        <button
          type="button"
          class="ctx-item danger"
          role="menuitem"
          @click="askCloseOthers()"
        >
          {{ tx("关闭其它对话", "Close other chats", "Fechar outras conversas", "अन्य चैट बंद करें") }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="toggleArchive(ctxMenu.targetId)">
          {{ ctxTarget?.archived ? tx("取消归档", "Unarchive", "Desarquivar", "अनआर्काइव करें") : tx("归档", "Archive", "Arquivar", "आर्काइव करें") }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="toggleMute(ctxMenu.targetId)">
          {{
            ctxTarget?.muted
              ? tx("取消免打扰", "Unmute", "Reativar notificações", "सूचनाएं चालू करें")
              : tx("免打扰", "Mute", "Silenciar", "सूचनाएं बंद करें")
          }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="toggleFullAccess(ctxMenu.targetId)">
          {{
            ctxTarget?.fullAccess === false
              ? tx("开启完全访问", "Enable full access", "Ativar acesso total", "पूर्ण एक्सेस चालू करें")
              : tx("关闭完全访问", "Disable full access", "Desativar acesso total", "पूर्ण एक्सेस बंद करें")
          }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="duplicateCurrent(ctxMenu.targetId)">
          {{ tx("复制对话", "Duplicate", "Duplicar", "डुप्लिकेट करें") }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="exportConversation(ctxMenu.targetId, 'md')">
          {{ tx("导出 Markdown", "Export Markdown", "Exportar Markdown", "मार्कडाउन निर्यात") }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="exportConversation(ctxMenu.targetId, 'json')">
          {{ tx("导出 JSON", "Export JSON", "Exportar JSON", "JSON निर्यात") }}
        </button>
        <div class="ctx-sep" role="separator"></div>
        <button type="button" class="ctx-item danger" role="menuitem" @click="askDeleteFromCtx()">
          {{ tx("删除对话", "Delete chat", "Excluir conversa", "चैट हटाएं") }}
        </button>
        </template>
      </div>
    </Teleport>

    <!-- 后台任务完成提醒：切走的对话跑完后提示一次；免打扰的对话静默。 -->
    <Teleport to="body">
      <div v-if="doneToast" class="done-toast" role="status" aria-live="polite">
        <span class="done-toast__text">
          {{ tx("「", '"', '"', '"') }}{{ doneToast.title }}{{ tx("」已完成", '" finished', '" concluído', '" पूर्ण') }}
        </span>
        <button type="button" class="done-toast__view" @click="openDoneToast">
          {{ tx("查看", "View", "Ver", "देखें") }}
        </button>
        <button
          type="button"
          class="done-toast__close"
          :aria-label="tx('关闭', 'Close', 'Fechar', 'बंद करें')"
          @click="doneToast = null"
        >
          ×
        </button>
      </div>
    </Teleport>

    <!-- 删除确认弹窗：点删除先弹这里，确定才真正删除（撤销条仍兜底）。 -->
    <Teleport to="body">
      <div v-if="confirmDialog" class="modal-mask" @click.self="closeConfirm">
        <div
          ref="confirmDialogEl"
          class="modal modal--confirm"
          role="alertdialog"
          aria-modal="true"
          :aria-label="confirmDialog.title"
          tabindex="-1"
          @keydown.esc.stop="closeConfirm"
          @keydown.tab="trapConfirmFocus"
        >
          <div class="modal__body confirm-body">
            <span
              class="confirm-icon"
              :class="{ 'confirm-icon--danger': confirmDialog.danger }"
              aria-hidden="true"
            >
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
                <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
              </svg>
            </span>
            <div class="confirm-text">
              <div class="confirm-title">{{ confirmDialog.title }}</div>
              <p class="confirm-message">{{ confirmDialog.message }}</p>
            </div>
          </div>
          <div class="modal__foot">
            <button type="button" class="ghost-btn" @click="closeConfirm">
              {{ tx("取消", "Cancel", "Cancelar", "रद्द करें") }}
            </button>
            <button
              ref="confirmPrimaryBtn"
              type="button"
              class="ghost-btn"
              :class="{ 'ghost-btn-danger': confirmDialog.danger }"
              @click="confirmDialogConfirm"
            >
              {{ confirmDialog.confirmLabel }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="previewHtml" class="modal-mask" @click.self="closeArtifactPreview">
        <div class="modal modal--preview" role="dialog" aria-modal="true" :aria-label="previewHtml.name">
          <div class="modal__head">
            <span class="modal__title">{{ previewHtml.name }}</span>
            <div class="modal__head-actions">
              <a
                class="ghost-btn"
                :href="workspaceDownloadUrl(currentId, previewHtml.path)"
                :download="previewHtml.name"
              >{{ tx("下载", "Download", "Descargar", "डाउनलोड") }}</a>
              <button class="modal__close" type="button" aria-label="Close" @click="closeArtifactPreview">×</button>
            </div>
          </div>
          <div class="modal__body preview-body">
            <div v-if="previewLoading" class="preview-loading">{{ tx("加载中…", "Loading…", "Cargando…", "लोड हो रहा है…") }}</div>
            <iframe v-else class="preview-frame" :srcdoc="previewHtml.content" sandbox="allow-scripts"></iframe>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- v-if 挂在 Teleport 上：宿主 #task-panel-host 在 <main> 里、由本组件渲染，
         若 Teleport 随组件一起挂载会在宿主存在前解析目标而报错；
         推迟到表单打开时才挂载，此时宿主早已就位。 -->
    <Teleport v-if="showTaskForm" to="#task-panel-host">
      <!-- 内嵌主区的定时任务表单（不再是弹窗）：只有「取消」/「×」/ Esc 能退出（见 onTaskFormEsc）。 -->
      <div class="task-panel" role="region" :aria-label="tx('定时任务表单', 'Scheduled task form', 'Formulário de tarefa agendada', 'अनुसूचित कार्य फ़ॉर्म')">
        <div class="task-panel__head">
          <span class="task-panel__title">{{
            editingTaskId
              ? tx("编辑定时任务", "Edit scheduled task", "Editar tarefa agendada", "अनुसूचित कार्य संपादित करें")
              : tx("新建定时任务", "New scheduled task", "Nova tarefa agendada", "नया अनुसूचित कार्य")
          }}</span>
          <!-- 操作按钮放标题行右上角（对齐 CodeBuddy）：底部不再占一条，composer 直接贴住表单底缘。 -->
          <div class="task-panel__head-actions">
            <button class="ghost-btn" type="button" @click="closeTaskForm">{{ tx("取消", "Cancel", "Cancelar", "रद्द करें") }}</button>
            <button class="primary-btn" type="button" :disabled="tasksBusy" @click="submitTask">
              {{ editingTaskId ? tx("保存", "Save", "Salvar", "सहेजें") : tx("创建", "Create", "Criar", "बनाएं") }}
            </button>
          </div>
        </div>
        <div class="task-panel__body">
            <label class="field field--name">
              <span class="field__label"
                >{{ tx("名称", "Name", "Nome", "नाम") }}<span class="field__req" aria-hidden="true">*</span></span
              >
              <input class="field__input" v-model="taskDraft.name" :placeholder="tx('例如：每日流量日报', 'e.g. Daily traffic report', 'Ex.: relatório diário de tráfego', 'उदा. दैनिक ट्रैफ़िक रिपोर्ट')" />
            </label>
            <!-- 用途：报告 / 预警一键带默认（对齐 ChatGPT Monitoring + Datadog 主路径），不是参数仓库。 -->
            <div class="task-row">
              <span class="task-row__label">{{ tx("用途", "Purpose", "Finalidade", "उद्देश्य") }}</span>
              <div class="task-row__body">
                <div
                  class="seg seg--inline"
                  role="radiogroup"
                  :title='taskDraft.purpose === "alert" ? tx(
                    "数据预警：到点检查，仅异常时推送",
                    "Data alert: check on schedule, notify only on anomaly",
                    "Alerta de dados: verifica no horário, notifica só em anomalia",
                    "डेटा अलर्ट: शेड्यूल पर जाँच, केवल असामान्य पर सूचित",
                  ) : tx(
                    "周期报告：到点出报告并推送结果",
                    "Recurring report: produce and push a report on schedule",
                    "Relatório periódico: produz e envia no horário",
                    "आवधिक रिपोर्ट: शेड्यूल पर रिपोर्ट बनाकर भेजें",
                  )'
                >
                  <button
                    type="button"
                    role="radio"
                    :aria-checked="taskDraft.purpose === 'report'"
                    class="seg__btn"
                    :class="{ active: taskDraft.purpose === 'report' }"
                    @click="applyTaskPurpose('report')"
                  >{{ tx("周期报告", "Report", "Relatório", "रिपोर्ट") }}</button>
                  <button
                    type="button"
                    role="radio"
                    :aria-checked="taskDraft.purpose === 'alert'"
                    class="seg__btn"
                    :class="{ active: taskDraft.purpose === 'alert' }"
                    @click="applyTaskPurpose('alert')"
                  >{{ tx("数据预警", "Data alert", "Alerta de dados", "डेटा अलर्ट") }}</button>
                </div>
              </div>
            </div>
            <!-- 分组：任务标识（名称）之后是「到点怎么跑、结果往哪送」；任务内容（要执行的指令）放在表单最底部。 -->
            <div class="task-section">
              <span class="task-section__label">{{
                tx("到点运行时", "At run time", "Na execução", "रन के समय")
              }}</span>
              <!-- 结果去向：每个任务独占一个对话（服务端创建），每期结果只回到那里。
                   只在编辑已有任务时显示（显示专属对话名 + 打开入口）；新建时是改不了的静态事实，不占一行。 -->
              <div
                v-if="editingTask"
                class="task-row"
                :title='tx(
                  "本任务专属对话，每期结果只写这里",
                  "This chat is exclusive to this task; each run result is written here",
                  "Conversa exclusiva desta tarefa; cada resultado é escrito aqui",
                  "यह चैट केवल इस कार्य की है; हर रन का परिणाम यहीं",
                )'
              >
                <span class="task-row__label">{{ tx("结果回到", "Results go to", "Resultado em", "परिणाम यहाँ") }}</span>
                <div class="task-row__body">
                  <span class="task-row__value">{{ taskConvText(editingTask!) }}</span>
                </div>
                <button
                  class="notify-btn"
                  type="button"
                  @click="openTaskConversation(editingTask!)"
                >{{ tx("打开", "Open", "Abrir", "खोलें") }}</button>
              </div>
              <!-- 结果落点（docs/scheduled-task-sessions-plan.md §3.11）：对齐 ChatGPT 的 standalone / in-chat 两种任务；
                   切换只影响**此后**的运行，不动已有会话。两种落点的差异说明放悬浮提示，不铺段落。 -->
              <div class="task-row">
                <span class="task-row__label">{{ tx("结果落点", "Where results land", "Onde os resultados ficam", "परिणाम कहाँ जाएँ") }}</span>
                <div class="task-row__body">
                  <div
                    class="seg seg--inline"
                    role="radiogroup"
                    :title='taskDraft.runMode === "same" ? tx(
                      "同一会话：沿用上下文，适合连续跟踪",
                      "Same chat: keeps context, for continuous tracking",
                      "Mesma conversa: mantém contexto, para acompanhamento contínuo",
                      "वही चैट: संदर्भ बनाए रखती है, निरंतर ट्रैकिंग के लिए",
                    ) : tx(
                      "每期新会话：可单独回看与对比（默认）",
                      "New chat per run: reviewable and comparable (default)",
                      "Nova conversa por execução: revisável e comparável (padrão)",
                      "हर रन के लिए नई चैट: अलग देखी/तुलना की जा सके (डिफ़ॉल्ट)",
                    )'
                  >
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="taskDraft.runMode === 'new'"
                      class="seg__btn"
                      :class="{ active: taskDraft.runMode === 'new' }"
                      @click="taskDraft.runMode = 'new'"
                    >{{ tx("每期新会话", "New chat per run", "Nova conversa por execução", "हर रन के लिए नई चैट") }}</button>
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="taskDraft.runMode === 'same'"
                      class="seg__btn"
                      :class="{ active: taskDraft.runMode === 'same' }"
                      @click="taskDraft.runMode = 'same'"
                    >{{ tx("同一会话", "Same chat", "Mesma conversa", "वही चैट") }}</button>
                  </div>
                </div>
              </div>
              <!-- 结果通知策略：通道仍由「启用」总闸控制；这里只选「每期都推 / 仅异常时推」。 -->
              <div
                class="task-row"
                :title='taskDraft.notifyPolicy === "on_alert" ? tx(
                  "仅异常时推送：正常期静默，失败仍推",
                  "On alert only: quiet when normal, failures still push",
                  "Só em alerta: silêncio no normal, falhas ainda notificam",
                  "केवल अलर्ट पर: सामान्य में चुप, विफलता पर भी भेजें",
                ) : tx(
                  "每期都推：成功与失败都推",
                  "Every run: success and failure both push",
                  "Cada execução: sucesso e falha ambos enviam",
                  "हमेशा सूचित: सफल व विफल दोनों भेजें",
                )'
              >
                <span class="task-row__label">{{ tx("通知策略", "Notify policy", "Política de notificação", "सूचना नीति") }}</span>
                <div class="task-row__body">
                  <div class="seg seg--inline" role="radiogroup">
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="taskDraft.notifyPolicy === 'always'"
                      class="seg__btn"
                      :class="{ active: taskDraft.notifyPolicy === 'always' }"
                      @click="taskDraft.notifyPolicy = 'always'"
                    >{{ tx("每期都推", "Every run", "Cada execução", "हर रन") }}</button>
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="taskDraft.notifyPolicy === 'on_alert'"
                      class="seg__btn"
                      :class="{ active: taskDraft.notifyPolicy === 'on_alert' }"
                      @click="taskDraft.notifyPolicy = 'on_alert'"
                    >{{ tx("仅异常时推", "On alert only", "Só em alerta", "केवल अलर्ट पर") }}</button>
                  </div>
                </div>
              </div>
              <!-- 结果通知通道：任务到点跑完即向所有已启用通道推送（由通道「启用」开关控制，无需逐任务勾选）。 -->
              <div
                class="task-row"
                :title='tx(
                  "向哪些通道推：由下方「管理」里各通道的启用开关控制。",
                  "Which channels get the push: controlled by each channel’s enabled switch under Manage.",
                  "Para quais canais enviar: controlado pelo interruptor de cada canal em Gerenciar.",
                  "किन चैनलों पर भेजें: प्रबंधित में प्रत्येक चैनल के सक्षम स्विच से।",
                )'
              >
                <span class="task-row__label">{{ tx("通知通道", "Notify channels", "Canais de notificação", "अधिसूचना चैनल") }}</span>
                <div class="task-row__body">
                  <span class="task-row__value">{{ notifySummary }}</span>
                </div>
                <button class="notify-btn" type="button" @click="notifyDialogOpen = true">{{
                  tx("管理", "Manage", "Gerenciar", "प्रबंधित करें")
                }}</button>
              </div>
              <!-- 通知通道管理弹窗：通道增删改 / 启停 / 测试都在弹窗里做，主表单只留一行摘要（整体不超一屏）。
                   modal-mask 是 position:fixed，放在任务表单的 Teleport 内不影响层级。 -->
              <div v-if="notifyDialogOpen" class="modal-mask" @click.self="notifyDialogOpen = false">
                <div class="modal" role="dialog" :aria-label="tx('通知通道', 'Notify channels', 'Canais de notificação', 'अधिसूचना चैनल')">
                  <div class="modal__head">
                    <span class="modal__title">{{ tx("通知通道", "Notify channels", "Canais de notificação", "अधिसूचना चैनल") }}</span>
                    <button class="modal__close" type="button" :aria-label="tx('关闭', 'Close', 'Fechar', 'बंद करें')" @click="notifyDialogOpen = false">×</button>
                  </div>
                  <div class="modal__body">
                    <p class="repeat-preview">{{
                      tx(
                        "任务到点运行结束时，会向所有已启用的通知通道推送结果（成功与失败都推）；只需启用通道、无需逐任务勾选。",
                        "On completion the result is pushed to every enabled notify channel (success and failure); no per-task selection needed.",
                        "Ao concluir, o resultado é enviado a todo canal de notificação ativado (sucesso e falha); sem seleção por tarefa.",
                        "पूर्ण होने पर परिणाम हर सक्षम अधिसूचना चैनल को भेजा जाता है (सफल/विफल); कोई कार्य-वार चयन नहीं।",
                      )
                    }}</p>
                    <div class="notify-manage">
                <details class="notify-collapse" open>
                  <summary>{{ tx("管理通知通道", "Manage channels", "Gerenciar canais", "चैनल प्रबंधित करें") }}</summary>
                  <div class="notify-form">
                  <!-- 自定义下拉（antd/vben 风格）：原生 select 的 option 样式无法控制，与弹窗风格割裂。 -->
                  <UiSelect
                    v-model="channelDraft.kind"
                    class="notify-kind"
                    block
                    :options="[
                      { value: 'dingtalk', label: 'DingTalk' },
                      { value: 'feishu', label: 'Feishu' },
                      { value: 'wecom', label: '企业微信' },
                    ]"
                    :aria-label="tx('通道类型', 'Channel type', 'Tipo de canal', 'चैनल प्रकार')"
                  />
                  <input class="field__input" v-model="channelDraft.label" :placeholder="tx('备注名（如：数据群）', 'Label (e.g. data group)', 'Nome (ex.: grupo de dados)', 'नाम (जैसे: डेटा ग्रुप)')" />
                  <input class="field__input notify-wide" v-model="channelDraft.webhook" placeholder="Webhook URL" />
                  <input class="field__input" v-model="channelDraft.secret" :placeholder="tx('加签密钥（可选）', 'Sign secret (optional)', 'Segredo da assinatura (opcional)', 'हस्ताक्षर सीक्रेट (वैकल्पिक)')" />
                  <input class="field__input" v-model="channelDraft.keyword" :placeholder="tx('关键词（可选）', 'Keyword (optional)', 'Palavra-chave (opcional)', 'कीवर्ड (वैकल्पिक)')" />
                  <button class="primary-btn" type="button" :disabled="notifyBusy" @click="saveChannelDraft">
                    {{ tx("保存通道", "Save channel", "Salvar canal", "चैनल सहेजें") }}
                  </button>
                </div>
                </details>
                <ul v-if="notifyChannels.length" class="notify-list">
                  <li v-for="ch in notifyChannels" :key="ch.id" class="notify-item">
                    <button
                      type="button"
                      class="notify-item__switch"
                      role="switch"
                      :aria-checked="Boolean(ch.enabled)"
                      :aria-label="tx('通道启用', 'Channel enabled', 'Canal ativo', 'चैनल सक्रिय')"
                      @click="toggleChannelEnabled(ch)"
                    >
                      <span class="notify-switch" :class="{ on: Boolean(ch.enabled) }" aria-hidden="true">
                        <span class="notify-switch__knob"></span>
                      </span>
                    </button>
                    <span class="notify-item__text">
                      <span class="notify-item__label">{{ ch.label }}</span>
                      <span class="notify-item__host"
                        >{{ notifyKindLabel(ch.kind) }} · {{ ch.host }}<template v-if="ch.hasSecret"> · {{ tx("已配密钥", "secret set", "com segredo", "सीक्रेट सेट") }}</template></span
                      >
                    </span>
                    <button class="notify-btn" type="button" :disabled="notifyBusy" @click="testChannel(ch.id)">
                      {{ tx("测试", "Test", "Testar", "टेस्ट") }}
                    </button>
                    <button class="notify-btn notify-btn--danger" type="button" :disabled="notifyBusy" :title="tx('删除通道', 'Delete channel', 'Excluir canal', 'चैनल हटाएँ')" @click="removeChannel(ch.id)">×</button>
                  </li>
                </ul>
                <p v-if="notifyNote" class="notify-note">{{ notifyNote }}</p>
              </div>
                </div>
                <div class="modal__foot">
                  <button class="primary-btn" type="button" @click="notifyDialogOpen = false">{{
                    tx("完成", "Done", "Concluído", "पूर्ण")
                  }}</button>
                </div>
              </div>
            </div>
              <div class="task-row">
                <span class="task-row__label">{{ tx("执行频率", "Frequency", "Frequência", "आवृत्ति") }}</span>
                <div class="task-row__body">
                  <span class="task-row__value">{{ taskFreqSummary }}</span>
                </div>
                <button class="notify-btn" type="button" @click="freqDialogOpen = true">{{
                  tx("设置", "Configure", "Configurar", "कॉन्फ़िगर करें")
                }}</button>
              </div>
            <!-- 执行频率弹窗：周期 / 时刻 / 星期多选 / 高级表达式只读展示收进来，主表单只留一行摘要。 -->
            <div v-if="freqDialogOpen" class="modal-mask" @click.self="freqDialogOpen = false">
              <div class="modal" role="dialog" :aria-label="tx('执行频率', 'Frequency', 'Frequência', 'आवृत्ति')">
                <div class="modal__head">
                  <span class="modal__title">{{ tx("执行频率", "Frequency", "Frequência", "आवृत्ति") }}</span>
                  <button class="modal__close" type="button" :aria-label="tx('关闭', 'Close', 'Fechar', 'बंद करें')" @click="freqDialogOpen = false">×</button>
                </div>
                <div class="modal__body">
              <div class="freq-row">
                <div class="seg seg--inline" role="radiogroup">
                  <button type="button" role="radio" :aria-checked="taskDraft.scheduleType === 'recurring'" class="seg__btn" :disabled="cronUnparsed" :class="{ active: taskDraft.scheduleType === 'recurring' }" @click="taskDraft.scheduleType = 'recurring'">{{ tx("周期", "Recurring", "Recorrente", "आवधिक") }}</button>
                  <button type="button" role="radio" :aria-checked="taskDraft.scheduleType === 'once'" class="seg__btn" :disabled="cronUnparsed" :class="{ active: taskDraft.scheduleType === 'once' }" @click="taskDraft.scheduleType = 'once'">{{ tx("一次性", "Once", "Única", "एक बार") }}</button>
                </div>
                <template v-if="!cronUnparsed && taskDraft.scheduleType === 'recurring'">
                  <span class="freq-text">{{ tx("每", "Every", "A cada", "हर") }}</span>
                  <input
                    class="field__input freq-num"
                    type="number"
                    min="1"
                    max="99"
                    :aria-label="tx('间隔', 'Interval', 'Intervalo', 'अंतराल')"
                    v-model.number="taskRepeat.interval"
                    @change="taskRepeat.freq === 'MINUTELY' && (taskRepeat.interval = (MINUTELY_INTERVALS as readonly number[]).includes(Number(taskRepeat.interval)) ? Number(taskRepeat.interval) : 10)"
                  />
                  <UiSelect
                    v-model="taskRepeat.freq"
                    class="freq-unit"
                    :options="REPEAT_FREQS.map((f) => ({ value: f.code, label: tx(f.unitZh, f.unitEn, f.unitPt, f.unitHi) }))"
                    :aria-label="tx('重复频率', 'Repeat', 'Repetição', 'दोहराव')"
                  />
                  <template v-if="taskRepeat.freq !== 'HOURLY' && taskRepeat.freq !== 'MINUTELY'">
                    <span class="freq-text">{{ tx("于", "at", "às", "को") }}</span>
                    <input class="field__input freq-time" type="time" v-model="taskRepeat.time" :aria-label="tx('执行时刻', 'Run at', 'Horário', 'समय')" />
                  </template>
                </template>
                <!-- 显式 else-if：cronUnparsed 时两边都不渲染（那种任务只在下面展示原表达式）。 -->
                <template v-else-if="taskDraft.scheduleType === 'once'">
                  <div ref="dtRoot" class="dt dt--inline">
                <button
                  type="button"
                  class="field__input dt__field"
                  :aria-expanded="dtOpen"
                  @click="dtOpen ? (dtOpen = false) : openDtPicker()"
                >
                  <span :class="{ 'dt__placeholder': !taskDraft.scheduledAt }">{{
                    taskDraft.scheduledAt ? dtDisplay : tx("选择日期和时间", "Select date and time", "Selecione data e hora", "तारीख और समय चुनें")
                  }}</span>
                  <svg class="dt__icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                    <rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6" />
                    <path d="M3 9.5h18" stroke="currentColor" stroke-width="1.6" />
                    <path d="M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                  </svg>
                </button>
                <Teleport to="body">
                  <div
                    v-if="dtOpen"
                    ref="dtPanel"
                    class="dt__panel"
                    :style="{ top: dtPos.top + 'px', left: dtPos.left + 'px' }"
                  >
                  <div class="dt__short">
                    <button v-for="s in DT_SHORTCUTS" :key="s.en" type="button" class="dt__short-btn" @click="s.fn()">
                      {{ tx(s.zh, s.en, s.pt, s.hi) }}
                    </button>
                  </div>
                  <div class="dt__head">
                    <span class="dt__nav">
                      <button type="button" class="dt__nav-btn" :aria-label="tx('上一年', 'Previous year', 'Ano anterior', 'पिछला वर्ष')" @click="shiftMonth(-12)">«</button>
                      <button type="button" class="dt__nav-btn" :aria-label="tx('上个月', 'Previous month', 'Mês anterior', 'पिछला महीना')" @click="shiftMonth(-1)">‹</button>
                    </span>
                    <span class="dt__month">{{ dtMonthLabel }}</span>
                    <span class="dt__nav">
                      <button type="button" class="dt__nav-btn" :aria-label="tx('下个月', 'Next month', 'Próximo mês', 'अगला महीना')" @click="shiftMonth(1)">›</button>
                      <button type="button" class="dt__nav-btn" :aria-label="tx('下一年', 'Next year', 'Próximo ano', 'अगला वर्ष')" @click="shiftMonth(12)">»</button>
                    </span>
                  </div>
                  <div class="dt__grid" role="grid">
                    <span v-for="w in DT_WEEKDAYS" :key="w.en" class="dt__wd">{{ tx(w.zh, w.en, w.pt, w.hi) }}</span>
                    <template v-for="(c, i) in dtCells" :key="i">
                      <span v-if="c === null" class="dt__cell dt__cell--empty"></span>
                      <button
                        v-else
                        type="button"
                        class="dt__cell"
                        :class="{ today: isDtToday(c), sel: isDtPicked(c) }"
                        @click="pickDay(c)"
                      >{{ c }}</button>
                    </template>
                  </div>
                  <div class="dt__foot">
                    <span class="dt__time-label">{{ tx("时刻", "Time", "Hora", "समय") }}</span>
                    <input
                      class="dt__sel"
                      list="dt-hour-list"
                      maxlength="2"
                      inputmode="numeric"
                      :value="dtHour"
                      :aria-label="tx('小时', 'Hour', 'Hora', 'घंटा')"
                      @input="dtHourPart.onInput"
                      @change="dtHourPart.onChange"
                    />
                    <datalist id="dt-hour-list">
                      <option v-for="h in DT_HOURS" :key="h" :value="h"></option>
                    </datalist>
                    <span class="dt__colon">:</span>
                    <input
                      class="dt__sel"
                      list="dt-minute-list"
                      maxlength="2"
                      inputmode="numeric"
                      :value="dtMinute"
                      :aria-label="tx('分钟', 'Minute', 'Minuto', 'मिनट')"
                      @input="dtMinutePart.onInput"
                      @change="dtMinutePart.onChange"
                    />
                    <datalist id="dt-minute-list">
                      <option v-for="m in DT_MINUTES" :key="m" :value="m"></option>
                    </datalist>
                    <button type="button" class="dt__ok" @click="dtOpen = false">{{ tx("确定", "OK", "OK", "ठीक है") }}</button>
                  </div>
                  </div>
                </Teleport>
                  </div>
                </template>
              </div>
              <!-- 每周：星期多选单独一行（7 个圆片塞不进频率行）。 -->
              <div v-if="!cronUnparsed && taskDraft.scheduleType === 'recurring' && taskRepeat.freq === 'WEEKLY'" class="repeat-row">
                <button
                  v-for="w in WEEKDAYS"
                  :key="w.code"
                  type="button"
                  class="wd-chip"
                  :class="{ active: taskRepeat.byday.includes(w.code) }"
                  @click="toggleWeekday(w.code)"
                >{{ tx(w.zh, w.en, w.pt, w.hi) }}</button>
              </div>
              <!-- 外部建的表达式：只读展示原样，不猜一个相近的覆盖它（保存时整段频率都不回传）。 -->
              <p v-if="cronUnparsed" class="repeat-preview">
                {{
                  tx(
                    "该任务用的是外部创建的高级表达式，下方选项表达不了它，本次保存不会改动频率：",
                    "This task uses an advanced expression created outside the UI; the options below cannot express it, so saving leaves the schedule untouched:",
                    "Esta tarefa usa uma expressão avançada criada fora da interface; salvar não altera o agendamento:",
                    "यह कार्य UI के बाहर बनाई गई उन्नत अभिव्यक्ति का उपयोग करता है; सहेजने पर समय-सारिणी नहीं बदलेगी:",
                  )
                }}
                <code class="cron-raw">{{ editingCron }}</code>
              </p>
              <!-- 周期任务的纯文本预览（保存的是 cron，用户看的是这句话）。 -->
              <p v-else-if="taskDraft.scheduleType === 'recurring'" class="repeat-preview">{{ repeatPreview }}</p>
                </div>
                <div class="modal__foot">
                  <button class="primary-btn" type="button" @click="freqDialogOpen = false">{{
                    tx("完成", "Done", "Concluído", "पूर्ण")
                  }}</button>
                </div>
              </div>
            </div>
          </div>
            <div class="field task-composer">
              <span class="field__label field__label--row"
                >{{ tx("任务内容", "Task prompt", "Conteúdo da tarefa", "कार्य निर्देश") }}<span class="field__req" aria-hidden="true">*</span></span>
              <!-- 直接复用对话输入区那套外壳（PromptBox）；工具选择也照对话区的样子放进底部工具条，
                   不再单独占一块字段——「要执行的指令」和「带哪些工具」本来就是同一件事的两半。 -->
              <PromptBox
                v-model="taskDraft.prompt"
                :min-height="104"
                auto-grow
                :aria-label="tx('任务内容', 'Task prompt', 'Conteúdo da tarefa', 'कार्य निर्देश')"
                :placeholder="taskDraft.purpose === 'alert'
                  ? tx(
                      '写清：数据源、范围、时间窗口、超过多少算异常；取不到不要猜。例：Zoho 统计印度(IN)最近 60 分钟对话数，>300 异常。短窗口+最少字段。',
                      'State source, scope, window, threshold; do not guess if incomplete. e.g. Zoho India (IN) chats in last 60m; alert if >300. Prefer short window + minimal fields.',
                      'Fonte, escopo, janela, limiar; não invente se incompleto. Ex.: Zoho Índia (IN) últimos 60 min; alerta se >300. Janela curta + poucos campos.',
                      'स्रोत, दायरा, विंडो, थ्रेशोल्ड; अधूरा हो तो अनुमान न लगाएँ। उदा. Zoho भारत (IN) 60 मिनट; >300 अलर्ट। छोटी विंडो + कम फ़ील्ड।',
                    )
                  : tx('智能体要自动执行的自然语言指令…', 'Natural-language instruction for the agent…', 'Instrução em linguagem natural para o agente executar…', 'एजेंट के लिए स्वतः निष्पादित होने वाला प्राकृतिक-भाषा निर्देश…')"
                :hint="tx('Shift+Enter 换行', 'Shift+Enter for a new line', 'Shift+Enter nova linha', 'Shift+Enter नई पंक्ति')"
              >
                <template #toolbar-left>
                  <div ref="taskToolsRoot" class="tools-menu-box">
                    <button
                      type="button"
                      class="icon-btn"
                      :class="{ on: taskToolsOpen || taskSkillOpen || taskMcpOpen || taskExpertOpen }"
                      :aria-expanded="taskToolsOpen || taskSkillOpen || taskMcpOpen || taskExpertOpen"
                      aria-haspopup="menu"
                      :title="tx('任务工具（到点运行时生效）', 'Task tools (apply at run time)', 'Ferramentas da tarefa (valem na execução)', 'कार्य टूल (रन के समय लागू)')"
                      :aria-label="tx('任务工具（到点运行时生效）', 'Task tools (apply at run time)', 'Ferramentas da tarefa (valem na execução)', 'कार्य टूल (रन के समय लागू)')"
                      @click="toggleTaskTools"
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </button>
                  </div>
                  <!-- 菜单与飞出整体 Teleport 到 body（弹窗 overflow:auto 会裁剪 absolute 面板）：
                       锚盒 fixed 钉在触发器（左/底/高一致），内部复用对话区同款菜单/飞出样式。 -->
                  <Teleport to="body">
                    <div
                      v-if="taskToolsOpen"
                      ref="taskToolsPanel"
                      class="tools-menu-box task-tools-pop"
                      :style="{
                        left: taskToolsPos.left + 'px',
                        bottom: taskToolsPos.bottom + 'px',
                        height: taskToolsPos.height + 'px',
                      }"
                    >
                      <div class="tools-menu" role="menu">
                        <button
                          class="tools-menu__row"
                          type="button"
                          role="menuitem"
                          :aria-expanded="taskSkillOpen"
                          @click="openTaskFlyout('skills')"
                          @mouseenter="hoverTaskFlyout('skills')"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M12 3l2.2 5.4L20 10l-4.4 3.6L16.8 20 12 17l-4.8 3 1.2-6.4L4 10l5.8-1.6z" />
                          </svg>
                          <span>{{ tx("技能", "Skills", "Habilidades", "स्किल") }}</span>
                          <span v-if="taskDraft.skills.length" class="tools-badge">{{ taskDraft.skills.length }}</span>
                          <span class="tools-menu__chev">›</span>
                        </button>
                        <button
                          class="tools-menu__row"
                          type="button"
                          role="menuitem"
                          :aria-expanded="taskMcpOpen"
                          @click="openTaskFlyout('mcp')"
                          @mouseenter="hoverTaskFlyout('mcp')"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M9 6a3 3 0 1 1 6 0v1h2.5A1.5 1.5 0 0 1 19 8.5v3a3 3 0 0 1-3 3h-1v1a3 3 0 0 1-6 0v-1H7a3 3 0 0 1-3-3v-3A1.5 1.5 0 0 1 5.5 7H9z" />
                          </svg>
                          <span>{{ tx("连接器", "Connectors", "Conectores", "कनेक्टर") }}</span>
                          <span v-if="taskMcpCount" class="tools-badge">{{ taskMcpCount }}</span>
                          <span class="tools-menu__chev">›</span>
                        </button>
                        <button
                          class="tools-menu__row"
                          type="button"
                          role="menuitem"
                          :aria-expanded="taskExpertOpen"
                          @click="openTaskFlyout('expert')"
                          @mouseenter="hoverTaskFlyout('expert')"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <circle cx="12" cy="8" r="3.4" />
                            <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
                          </svg>
                          <span>{{ tx("助手", "Assistant", "Assistente", "सहायक") }}</span>
                          <span v-if="taskAgentLabel" class="tools-badge">1</span>
                          <span class="tools-menu__chev">›</span>
                        </button>
                      </div>

                      <!-- 技能飞出：勾选写入任务草稿；面板结构对齐对话区（搜索 / 列表 / 取消全部）。 -->
                      <div v-if="taskSkillOpen" class="tools-flyout" role="dialog" :aria-label="tx('任务技能', 'Task skills', 'Habilidades da tarefa', 'कार्य स्किल')">
                        <ToolsSearch v-model="taskSkillQuery" :placeholder="tx('搜索技能', 'Search skills', 'Buscar habilidades', 'स्किल खोजें')" :autofocus="taskSearchAutofocus" />
                        <div class="tools-list">
                          <div v-if="!taskSkillFiltered.length" class="empty-hint">
                            {{
                              skillAvailable.length
                                ? tx("没有匹配的技能", "No matching skills", "Nenhuma habilidade correspondente", "कोई मेल खाता स्किल नहीं")
                                : tx("没有可勾选的技能（默认技能无需勾选即已生效）", "No selectable skills (default skills are already in effect)", "Nenhuma habilidade selecionável (as padrão já estão ativas)", "कोई चयन-योग्य स्किल नहीं (डिफ़ॉल्ट स्किल पहले से लागू हैं)")
                            }}
                          </div>
                          <button
                            v-for="s in taskSkillFiltered"
                            :key="s.dir"
                            type="button"
                            class="tools-item"
                            :class="{ on: taskDraft.skills.includes(s.dir) }"
                            @click="toggleTaskSkill(s.dir)"
                          >
                            <span class="tools-item__icon" :style="iconStyle(s.dir)" aria-hidden="true">{{ iconChar(s.name) }}</span>
                            <span class="tools-item__body">
                              <span class="tools-item__name">{{ s.name }}</span>
                              <span class="tools-item__desc" :title="s.description || ''">{{ s.description || tx("（无描述）", "(no description)", "(sem descrição)", "(कोई विवरण नहीं)") }}</span>
                            </span>
                            <svg v-if="taskDraft.skills.includes(s.dir)" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <path d="m5 12.5 4.5 4.5L19 7.5" />
                            </svg>
                          </button>
                        </div>
                        <div class="tools-flyout__foot">
                          <p class="flyout-hint">
                            {{ tx("勾选的技能随任务每期运行注入；默认生效的技能无需勾选。", "Checked skills are injected on every run; default skills need no check.", "Habilidades marcadas são injetadas a cada execução; as padrão dispensam marcação.", "चुने गए स्किल हर रन में लगते हैं; डिफ़ॉल्ट स्किल को चिह्नित करने की आवश्यकता नहीं।") }}
                          </p>
                          <button
                            class="tools-flyout__action"
                            type="button"
                            :disabled="!taskDraft.skills.length"
                            @click="clearTaskSkills"
                          >
                            {{ tx("取消全部已选技能", "Deselect all skills", "Desmarcar todas as habilidades", "सभी चयन हटाएँ") }}
                          </button>
                        </div>
                      </div>

                      <!-- 连接器飞出：结构对齐对话区（搜索 / 状态点 / 工具清单 / 取消全部）；勾选写入任务草稿。 -->
                      <div v-if="taskMcpOpen" class="tools-flyout" role="dialog" :aria-label="tx('任务连接器', 'Task connectors', 'Conectores da tarefa', 'कार्य कनेक्टर')">
                        <ToolsSearch v-model="taskMcpQuery" :placeholder="tx('搜索连接器', 'Search connectors', 'Buscar conectores', 'कनेक्टर खोजें')" :autofocus="taskSearchAutofocus" />
                        <div class="tools-list">
                          <div v-if="!taskMcpFiltered.length" class="empty-hint">
                            {{
                              mcpAvailable.length
                                ? tx("没有匹配的连接器", "No matching connectors", "Nenhum conector correspondente", "कोई मेल खाता कनेक्टर नहीं")
                                : tx("没有可选的 MCP 服务器", "No MCP server available", "Nenhum servidor MCP disponível", "कोई MCP सर्वर उपलब्ध नहीं")
                            }}
                          </div>
                          <div
                            v-for="s in taskMcpFiltered"
                            :key="s.id"
                            class="tools-item"
                            :class="{ on: taskDraft.mcpServers.includes(s.id) }"
                          >
                            <button
                              type="button"
                              class="tools-item__main"
                              @click="toggleTaskServer(s.id)"
                            >
                              <span class="tools-item__icon" :style="iconStyle(s.id)" aria-hidden="true">{{ iconChar(s.label) }}</span>
                              <span class="tools-item__body">
                                <span class="tools-item__name">
                                  {{ s.label }}
                                  <span class="mcp-status" :class="taskRowState(s).cls">
                                    <span class="mcp-dot" :class="taskRowState(s).cls"></span>
                                    {{ taskRowState(s).text }}
                                  </span>
                                </span>
                                <span class="tools-item__desc" :title="mcpDescText(s)">{{ mcpDescText(s) }}</span>
                                <span v-if="taskMcpExpanded === s.id && s.toolNames.length" class="tools-item__tools">{{ s.toolNames.join("、") }}</span>
                              </span>
                            </button>
                            <!-- 勾选位固定宽，避免与右侧操作挤在一起；无勾时留空位保持列对齐。 -->
                            <span class="tools-item__check-slot" aria-hidden="true">
                              <svg v-if="taskDraft.mcpServers.includes(s.id)" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="m5 12.5 4.5 4.5L19 7.5" />
                              </svg>
                            </span>
                            <span class="tools-item__ops">
                              <!-- 无工具清单也占位，保证各行 ⟳ 纵向对齐。 -->
                              <button
                                class="mcp-mini"
                                :class="{ 'is-ghost': !s.toolNames.length }"
                                type="button"
                                :disabled="!s.toolNames.length"
                                :tabindex="s.toolNames.length ? undefined : -1"
                                :title="s.toolNames.length ? tx('工具清单', 'Tool list', 'Lista de ferramentas', 'टूल सूची') : undefined"
                                :aria-hidden="!s.toolNames.length"
                                @click.stop="s.toolNames.length && (taskMcpExpanded = taskMcpExpanded === s.id ? '' : s.id)"
                              >
                                {{ taskMcpExpanded === s.id ? "▴" : "▾" }}
                              </button>
                              <button
                                class="mcp-mini"
                                type="button"
                                :disabled="mcpBusy || !taskDraft.mcpServers.includes(s.id) || !!s.connecting"
                                :title="tx('重连', 'Reconnect', 'Reconectar', 'पुनः कनेक्ट')"
                                @click.stop="reconnectMcp(s.id)"
                              >
                                ⟳
                              </button>
                            </span>
                          </div>
                        </div>
                        <div class="tools-flyout__foot">
                          <p class="flyout-hint">
                            {{ tx("不勾选不带 MCP；写操作到点仍按风险策略确认。", "Unchecked = no MCP; writes still confirm at run time.", "Desmarcado = sem MCP; escritas ainda confirmam na execução.", "अनचेक = बिना MCP; रन पर राइट की पुष्टि रहेगी।") }}
                          </p>
                          <button
                            class="tools-flyout__action"
                            type="button"
                            :disabled="!taskMcpCount"
                            @click="clearTaskMcp"
                          >
                            {{ tx("取消全部已选连接器", "Deselect all connectors", "Desmarcar todos os conectores", "सभी चयन हटाएँ") }}
                          </button>
                        </div>
                      </div>

                      <!-- 助手飞出：任务角色（选入草稿，不跳转页面）；面板结构对齐对话区（搜索 / 列表）。 -->
                      <div v-if="taskExpertOpen" class="tools-flyout" role="dialog" :aria-label="tx('任务助手', 'Task assistant', 'Assistente da tarefa', 'कार्य सहायक')">
                        <ToolsSearch v-model="taskExpertQuery" :placeholder="tx('搜索助手', 'Search assistants', 'Buscar assistentes', 'सहायक खोजें')" :autofocus="taskSearchAutofocus" />
                        <div class="tools-list">
                          <div v-if="taskExpertQuery.trim() && !taskExpertFiltered.length" class="empty-hint">
                            {{ tx("没有匹配的助手", "No matching assistants", "Nenhum assistente correspondente", "कोई मेल खाता सहायक नहीं") }}
                          </div>
                          <button
                            v-if="!taskExpertQuery.trim()"
                            type="button"
                            class="tools-item"
                            :class="{ on: !taskDraft.agentId }"
                            @click="taskDraft.agentId = ''"
                          >
                            <span class="tools-item__icon" :style="iconStyle(AGENT_ID)" aria-hidden="true">{{ iconChar(AGENT_ID) }}</span>
                            <span class="tools-item__body">
                              <span class="tools-item__name">{{ tx("跟随当前入口", "Follow this page", "Seguir esta página", "इस पेज के अनुसार") }}</span>
                              <span class="tools-item__desc">{{ tx("用打开本页的角色运行任务", "Run the task as this page's agent", "Executar a tarefa como o agente desta página", "इस पेज के एजेंट के रूप में चलें") }}</span>
                            </span>
                            <svg v-if="!taskDraft.agentId" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <path d="m5 12.5 4.5 4.5L19 7.5" />
                            </svg>
                          </button>
                          <button
                            v-for="a in taskExpertFiltered"
                            :key="a.id"
                            type="button"
                            class="tools-item"
                            :class="{ on: taskDraft.agentId === a.id }"
                            @click="taskDraft.agentId = a.id"
                          >
                            <span class="tools-item__icon" :style="iconStyle(a.id)" aria-hidden="true">{{ a.icon }}</span>
                            <span class="tools-item__body">
                              <span class="tools-item__name">{{ agentText(a.label, uiLocale) }}</span>
                              <span class="tools-item__desc" :title="agentText(a.description, uiLocale)">{{ agentText(a.description, uiLocale) }}</span>
                            </span>
                            <svg v-if="taskDraft.agentId === a.id" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <path d="m5 12.5 4.5 4.5L19 7.5" />
                            </svg>
                          </button>
                        </div>
                        <div class="tools-flyout__foot">
                          <p class="flyout-hint">
                            {{ tx("角色决定每期运行的人设与技能可见性；编辑时选「跟随当前入口」保持任务原有角色不变。", "The agent decides each run's persona and skill visibility; \"Follow this page\" when editing keeps the task's current agent.", "O papel define a persona e a visibilidade de habilidades; ao editar, \"Seguir esta página\" mantém o papel atual.", "भूमिका हर रन की persona और स्किल दृश्यता तय करती है; संपादन में \"इस पेज के अनुसार\" मौजूदा भूमिका रखता है।") }}
                          </p>
                        </div>
                      </div>
                </div>
              </Teleport>
            </template>
            <template #toolbar-right>
              <button class="primary-btn" type="button" :disabled="tasksBusy" @click="submitTask">
                {{ editingTaskId ? tx("保存", "Save", "Salvar", "सहेजें") : tx("创建", "Create", "Criar", "बनाएं") }}
              </button>
            </template>
          </PromptBox>
            </div>

            <p v-if="taskError" class="field__error">{{ taskError }}</p>
        </div>
      </div>
    </Teleport>

    <main class="main">
      <header class="top">
        <button
          v-show="!navExpanded"
          type="button"
          class="hamburger"
          :aria-expanded="navExpanded"
          :aria-label="tx('打开会话列表', 'Open conversations', 'Abrir conversas', 'चैट खोलें')"
          @click="toggleSidebar()"
        >
          <span class="hamburger__bar" aria-hidden="true"></span>
        </button>
        <div class="top-actions">
          <ModelSelect v-model="modelId" :models="models" />
          <span v-if="false" ref="resRoot" class="mcp-box">
            <button
              type="button"
              class="mcp-btn"
              :aria-expanded="resOpen"
              aria-haspopup="dialog"
              :title="tx('长期记忆与工作区文件', 'Memory & workspace files', 'Memória e arquivos', 'मेमोरी और वर्कस्पेस')"
              @click="toggleResPanel"
            >
              {{ tx("资源", "Files", "Arquivos", "फ़ाइलें") }}
            </button>
            <div v-if="resOpen" class="mcp-panel res-panel" role="dialog" :aria-label="tx('资源', 'Resources', 'Recursos', 'संसाधन')">
              <div class="mcp-panel__head">
                <span>{{ tx("长期记忆", "Long-term memory", "Memória de longo prazo", "दीर्घकालिक मेमोरी") }}</span>
                <span class="mcp-row__sub">{{ memoryItems.length }}{{ tx(" 条", " items", " itens", " आइटम") }}</span>
              </div>
              <div class="res-memory-add">
                <input
                  v-model="memoryText"
                  class="res-memory-input"
                  type="text"
                  :placeholder="tx('要长期记住的事实或偏好…', 'A fact or preference to remember…', 'Un hecho o preferencia para recordar…', 'याद रखने के लिए तथ्य…')"
                  maxlength="500"
                  @keydown="onInlineSubmitKeydown($event, addMemoryEntry)"
                />
                <button class="mcp-mini" type="button" :disabled="memoryBusy || !memoryText.trim()" @click="addMemoryEntry">＋</button>
              </div>
              <div class="res-list">
                <div v-if="!memoryItems.length" class="empty-hint">
                  {{ tx("还没有长期记忆", "No long-term memory yet", "Aún no hay memoria", "अभी कोई मेमोरी नहीं") }}
                </div>
                <div v-for="m in memoryItems" :key="m.id" class="res-row">
                  <span class="res-row__text">{{ m.text }}</span>
                  <button class="mcp-mini" type="button" :title="tx('删除', 'Delete', 'Excluir', 'हटाएं')" @click="removeMemoryEntry(m.id)">×</button>
                </div>
              </div>

              <div class="mcp-panel__head res-head">
                <span>{{ tx("工作区文件", "Workspace files", "Archivos del espacio", "वर्कस्पेस फ़ाइलें") }}</span>
                <button class="mcp-link" type="button" @click="loadWorkspaceFiles">
                  {{ tx("刷新", "Refresh", "Actualizar", "रिफ्रेश") }}
                </button>
              </div>
              <div class="res-list">
                <div v-if="wsLoading" class="empty-hint">{{ tx("加载中…", "Loading…", "Cargando…", "लोड हो रहा है…") }}</div>
                <div v-else-if="!wsFiles.length" class="empty-hint">
                  {{ tx("工作区为空（对话里可用 fs_write 保存文件）", "Workspace is empty (use fs_write in chat to save files)", "El espacio está vacío (usa fs_write)", "वर्कस्पेस खाली है (fs_write का उपयोग करें)") }}
                </div>
                <div
                  v-for="f in wsFiles"
                  :key="f.path"
                  class="res-file"
                >
                  <button
                    class="res-file__view"
                    type="button"
                    :title="tx('查看', 'View', 'Ver', 'देखें')"
                    @click="openWorkspaceFile(f.path)"
                  >
                    <span class="res-row__text">{{ f.path }}</span>
                    <span class="mcp-row__sub">{{ formatBytes(f.bytes) }}</span>
                  </button>
                  <a
                    class="res-file__dl"
                    :href="workspaceDownloadUrl(currentId, f.path)"
                    :download="f.path.split('/').pop() || f.path"
                    :title="tx('下载', 'Download', 'Descargar', 'डाउनलोड')"
                  >⤓</a>
                </div>
              </div>
              <pre v-if="wsFileContent" class="res-preview">{{ wsFileContent?.content }}</pre>
            </div>
          </span>
          <UiLocaleSelect @change="onLocaleChange" />
          <ThemeToggle />
        </div>

        <!-- 删除撤销条：挂在头部内做绝对定位，left:50% 才是「对话区中心」而非「视口中心」。
             之前 Teleport 到 body + position:fixed，桌面端会偏左半个侧栏宽（256/2=128px），
             并且 top:20px 正好压住模型/语言选择器。 -->
        <div v-if="undoDelete" class="undo-toast" role="status" aria-live="polite">
          <span class="undo-toast__text">{{ tx("已删除对话", "Chat deleted", "Conversa excluída", "चैट हटा दी गई") }}</span>
          <button type="button" class="undo-toast__undo" @click="undoRemoveConversation">
            {{ tx("撤销", "Undo", "Desfazer", "पूर्ववत करें") }}
          </button>
        </div>
      </header>

      <div v-if="settingsError" class="warn-line header-warn" role="status">{{ settingsError }}</div>

      <!-- 定时任务表单宿主：表单不再是弹窗，直接内嵌主区（Teleport 目标；空态时零占位）。 -->
      <div id="task-panel-host" class="task-host"></div>

      <!-- 主区「定时任务」页（对齐 CodeBuddy）：标题 + 右上主按钮；列表行 = 名称 + 元信息 + 状态 + 行内操作
           （暂停/启用、编辑、删除、打开最近一期），行点击展开各期运行（与侧栏分组共用数据源与展开状态）。
           右键行 = 原任务上下文菜单（与侧栏同口径）。 -->
      <section
        v-show="showTaskList && !showTaskForm"
        class="task-page"
        role="region"
        :aria-label="tx('定时任务', 'Scheduled tasks', 'Tarefas agendadas', 'अनुसूचित कार्य')"
      >
        <header class="task-page__head">
          <span class="task-page__title">{{ tx("定时任务", "Scheduled tasks", "Tarefas agendadas", "अनुसूचित कार्य") }}</span>
          <span v-if="taskGroups.length" class="task-page__count">({{ taskGroups.length }})</span>
          <div class="task-page__actions">
            <div class="run-filter" role="group" :aria-label="tx('按结果筛选', 'Filter runs', 'Filtrar execuções', 'रन फ़िल्टर')">
              <button type="button" :class="{ active: runStatusFilter === 'all' }" :aria-pressed="runStatusFilter === 'all'" @click="runStatusFilter = 'all'">{{ tx("全部", "All", "Todas", "सभी") }}</button>
              <button type="button" :class="{ active: runStatusFilter === 'success' }" :aria-pressed="runStatusFilter === 'success'" @click="runStatusFilter = 'success'">{{ tx("成功", "Success", "Sucesso", "सफल") }}</button>
              <button type="button" :class="{ active: runStatusFilter === 'failed' }" :aria-pressed="runStatusFilter === 'failed'" @click="runStatusFilter = 'failed'">{{ tx("失败", "Failed", "Falhou", "विफल") }}</button>
            </div>
            <button class="primary-btn" type="button" @click="openTaskForm()">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              {{ tx("新建定时任务", "New scheduled task", "Nova tarefa agendada", "नया अनुसूचित कार्य") }}
            </button>
          </div>
        </header>
        <div class="task-page__list">
          <div v-if="!taskGroups.length" class="task-page__empty">
            <p>{{ tx("还没有定时任务", "No scheduled tasks yet", "Nenhuma tarefa agendada", "कोई अनुसूचित कार्य नहीं") }}</p>
            <button class="primary-btn" type="button" @click="openTaskForm()">
              {{ tx("新建第一个定时任务", "Create your first task", "Criar a primeira tarefa", "पहला कार्य बनाएँ") }}
            </button>
          </div>
          <div
            v-for="g in taskGroups"
            :key="g.schedule.id"
            class="task-page__item"
            :class="{ open: expandedTasks[g.schedule.id] }"
          >
            <div
              class="task-page__row"
              role="button"
              tabindex="0"
              :aria-expanded="expandedTasks[g.schedule.id] ? 'true' : 'false'"
              :aria-label="g.schedule.name || g.schedule.prompt"
              @click="toggleTaskGroup(g.schedule.id)"
              @keydown="onTaskGroupKeydown($event, g.schedule.id)"
              @contextmenu.prevent="openTaskCtxMenu($event, g.schedule)"
            >
              <span class="task-page__caret" :class="{ open: expandedTasks[g.schedule.id] }" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
              </span>
              <div class="task-page__text">
                <span class="task-page__name" :title="taskCardTip(g.schedule)">{{ g.schedule.name || g.schedule.prompt }}</span>
                <span class="task-page__meta">
                  {{ taskKindText(g.schedule) }} · {{ taskNextShort(g.schedule) }} ·
                  {{ tx("结果回到", "Results to", "Resultado em", "परिणाम यहाँ") }}：{{ taskConvText(g.schedule) }}
                </span>
              </div>
              <span
                v-if="g.schedule.unreadRuns"
                class="task-page__unread"
                :title="tx('有新的运行结果', 'New run results', 'Novos resultados de execução', 'नए रन परिणाम')"
              >{{ g.schedule.unreadRuns }}</span>
              <span class="task-page__status" :class="{ paused: !g.schedule.enabled }">
                {{ g.schedule.enabled ? tx("启用中", "Active", "Ativa", "सक्रिय") : tx("已暂停", "Paused", "Pausada", "रुका हुआ") }}
              </span>
              <button
                class="notify-btn"
                type="button"
                :disabled="!!g.schedule.runRequestedAt || !!runningNow[g.schedule.id]"
                :title="tx('多跑一期，不改变下次定时', 'Run once without moving the next slot', 'Executa uma vez sem mudar o próximo horário', 'अगला समय बदले बिना एक बार चलाएँ')"
                @click.stop="runTaskNow(g.schedule.id)"
              >
                {{ g.schedule.runRequestedAt ? tx("即将执行", "Queued", "Na fila", "कतार में") : tx("立即执行", "Run now", "Executar agora", "अभी चलाएँ") }}
              </button>
              <button class="notify-btn" type="button" @click.stop="toggleTask(g.schedule.id)">
                {{ g.schedule.enabled ? tx("暂停", "Pause", "Pausar", "रोकें") : tx("启用", "Resume", "Retomar", "फिर से चलाएँ") }}
              </button>
              <button class="notify-btn" type="button" @click.stop="openTaskForm(g.schedule)">
                {{ tx("编辑", "Edit", "Editar", "संपादित करें") }}
              </button>
              <button
                class="notify-btn notify-btn--danger"
                type="button"
                @click.stop="removeTask(g.schedule.id)"
              >{{ tx("删除", "Delete", "Excluir", "हटाएँ") }}</button>
              <button
                class="notify-btn"
                type="button"
                :title="tx('打开最近一期', 'Open latest run', 'Abrir execução mais recente', 'नवीनतम रन खोलें')"
                :aria-label="tx('打开最近一期', 'Open latest run', 'Abrir execução mais recente', 'नवीनतम रन खोलें')"
                @click.stop="openTaskConversation(g.schedule)"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M7 17 17 7" />
                  <path d="M9 7h8v8" />
                </svg>
              </button>
            </div>
            <div v-if="expandedTasks[g.schedule.id]" class="task-page__runs">
              <p v-if="!filteredRuns(g.runs).length" class="task-page__run-empty">
                {{ tx("没有符合筛选的运行记录", "No runs match this filter", "Nenhuma execução neste filtro", "इस फ़िल्टर में कोई रन नहीं") }}
              </p>
              <button
                v-for="r in filteredRuns(g.runs)"
                :key="r.conversationId"
                class="task-page__run"
                :class="{ active: r.conversationId === currentId }"
                type="button"
                @click="openRunConversation(r)"
              >
                <span
                  v-if="r.status"
                  class="conv-dot"
                  :class="r.status"
                  :title="taskStatusText({ ...g.schedule, lastStatus: r.status as ScheduleDto['lastStatus'] })"
                  role="img"
                ></span>
                <span class="task-page__run-title">{{ r.conv?.title || runTimeText(r.at) }}</span>
                <span class="task-page__run-at">{{ runMetaText(r) }}</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- tabindex="-1"：给「回到顶部」点击后的焦点落点（不进入 Tab 序列），也方便键盘直接滚动对话区。 -->
      <div v-show="!showTaskForm && !showTaskList" ref="threadEl" class="thread" tabindex="-1" @scroll="onThreadScroll">
        <!-- 首屏慢加载才亮骨架；快加载时 booting 期间留空、不闪空态，直接等真实内容出现。 -->
        <div v-if="showSkeleton" class="boot-skeleton" aria-hidden="true">
          <div class="boot-skeleton__row boot-skeleton__row--agent"></div>
          <div class="boot-skeleton__row boot-skeleton__row--user"></div>
          <div class="boot-skeleton__row boot-skeleton__row--agent boot-skeleton__row--short"></div>
        </div>
        <div v-else-if="!booting && !current.bubbles.length" class="empty">
          {{ tx("想聊点什么？", "Want to chat about something?", "Quer conversar sobre algo?", "कुछ बात करना चाहते हैं?") }}
        </div>
        <div v-for="b in current.bubbles" :key="b.id" class="row" :class="b.role">
          <!-- has-chart：带图表的气泡要给确定宽度（否则气泡按文字收缩，图表卡片的百分比宽度会塌成窄条）。 -->
          <div class="bubble-wrap" :class="{ 'has-chart': !!b.charts?.length }">
          <div class="bubble">
            <div
              v-if="b.todos?.length || b.steps?.length || b.subagents?.length || hasThinking(b) || (b.streaming && !b.text)"
              class="reasoning"
              :class="{ open: openReasoning.has(b.id) }"
            >
              <button
                class="reasoning__head"
                :class="{ 'is-streaming': b.streaming }"
                type="button"
                :aria-expanded="openReasoning.has(b.id)"
                @click="toggleReasoning(b.id)"
              >
                <span class="reasoning__caret" aria-hidden="true"></span>
                <span class="reasoning__title">{{ reasoningTitle(b) }}</span>
                <span v-if="thinkLabel(b)" class="reasoning__time">{{ thinkLabel(b) }}</span>
                <span v-if="b.streaming" class="reasoning__spinner" aria-hidden="true"></span>
              </button>
              <div v-show="openReasoning.has(b.id)" class="reasoning__body">
                <!-- 意图行：仅当模型显式声明「意图：」才渲染；无框弱标签，替代原高亮卡
                     （原「取首句」兜底经常截出半截话，且与思考流首行重复）。 -->
                <div v-if="intentOf(b)" class="intent-line">
                  <span class="intent-line__label">{{ tx("意图", "Intent", "Intenção", "इरादा") }}</span>
                  <span class="intent-line__text">{{ intentOf(b) }}</span>
                </div>
                <!-- 扩展思考流：实时展示模型规划过程（已剥离显式意图行）；正文同族无衬线、限高内滚 + 流式跟底。 -->
                <pre v-if="thinkingDisplay(b)" class="reasoning__thinking">{{ thinkingDisplay(b) }}</pre>
                <!-- 规划阶段但尚无思考流（模型不支持 thinking）：给一个「正在规划」状态，避免静默加载像卡死；
                     一旦正文开始流式（b.text 已非空）即隐藏，转为「回答中」，不再误导地停在规划态。 -->
                <div
                  v-else-if="b.streaming && !b.text && !hasThinking(b) && !b.steps?.length && !b.todos?.length && !b.subagents?.length"
                  class="reasoning__planning"
                >
                  <span class="reasoning__planning-dot" aria-hidden="true"></span>
                  {{ tx("正在分析你的请求，规划执行步骤…", "Analyzing your request and planning the next steps…", "Analisando sua solicitação e planejando os próximos passos…", "आपका अनुरोध विश्लेषण कर रहा हूँ और अगले चरणों की योजना बना रहा हूँ…") }}
                </div>
                <div v-if="b.todos?.length" class="todos">
                  <div class="todos__head">{{ tx("任务计划", "Plan", "Plano", "कार्य योजना") }}</div>
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
                  <div
                    v-for="step in b.steps"
                    :key="step.id"
                    class="step"
                    :class="[stepClass(step.status), { expanded: openSteps.has(stepKey(b, step)) }]"
                  >
                    <!-- 有结果的步骤整行可点开（原生 button：键盘可达、禁用态即「纯静态行」）。 -->
                    <button
                      class="step-head"
                      type="button"
                      :disabled="!step.result"
                      :aria-expanded="step.result ? openSteps.has(stepKey(b, step)) : undefined"
                      :aria-controls="step.result ? `step-result-${step.id}` : undefined"
                      @click="toggleStep(b, step)"
                    >
                      <span class="mcp-dot" :class="stepClass(step.status)"></span>
                      <span class="step-name">{{ step.name }}</span>
                      <span v-if="step.server" class="step-server">{{ step.server }}</span>
                      <span v-if="step.result && !openSteps.has(stepKey(b, step))" class="step-hint">
                        {{ stepSummary(step) }}
                      </span>
                      <span class="step-status">{{ stepStatusText(step.status) }}</span>
                      <span v-if="step.result" class="step-caret" aria-hidden="true"></span>
                    </button>
                    <pre
                      v-if="step.result"
                      v-show="openSteps.has(stepKey(b, step))"
                      :id="`step-result-${step.id}`"
                      class="step-result"
                    >{{ step.result }}</pre>
                  </div>
                </div>
                <div v-if="b.subagents?.length" class="subagents">
                  <div class="subagents__head">{{ tx("子代理", "Subagents", "Subagentes", "उप-एजेंट") }}</div>
                  <div v-for="sa in b.subagents" :key="sa.id" class="subagent" :class="sa.status">
                    <div class="subagent__head">
                      <span class="mcp-dot" :class="subagentDotClass(sa.status)"></span>
                      <span class="subagent__desc">{{ sa.description }}</span>
                      <span class="subagent__status">{{ subagentStatusText(sa.status) }}</span>
                      <button
                        v-if="sa.status === 'running'"
                        class="subagent__cancel"
                        type="button"
                        :title="tx('取消该子代理', 'Cancel this subagent', 'Cancelar este subagente', 'इस उप-एजेंट को रद्द करें')"
                        @click="cancelSubagent(b.id, sa.id)"
                      >×</button>
                    </div>
                    <pre v-if="sa.text" class="subagent__text">{{ sa.text }}</pre>
                  </div>
                </div>
              </div>
            </div>
            <div v-if="b.pending" class="confirm-card">
              <div class="confirm-text">
                {{ tx("工具调用需要确认", "This tool call needs your approval", "Esta chamada de ferramenta precisa da sua aprovação", "इस टूल कॉल को आपकी अनुमति चाहिए") }}：<b>{{ b.pending.name }}</b>
                <span v-if="b.pending.server" class="step-server">{{ b.pending.server }}</span>
                <span
                  v-if="b.pending.level"
                  class="confirm-level"
                  :class="`confirm-level-${b.pending.level}`"
                >{{ confirmLevelText(b.pending.level) }}</span>
              </div>
              <div v-if="b.pending.reason" class="confirm-reason">{{ b.pending.reason }}</div>
              <table v-if="b.pending.argSummary?.length" class="confirm-args-table">
                <tbody>
                  <tr v-for="row in b.pending.argSummary" :key="row.key">
                    <td class="confirm-arg-key">{{ row.key }}</td>
                    <td class="confirm-arg-val">{{ row.value }}</td>
                  </tr>
                </tbody>
              </table>
              <pre v-else-if="b.pending.args" class="confirm-args">{{ b.pending.args }}</pre>
              <label v-if="b.pending.canGrantRead" class="confirm-grant">
                <input v-model="b.pending.grantRead" type="checkbox" />
                {{ tx("本对话内，把该服务器上未声明级别的工具按只读处理", "Treat undeclared tools on this server as read-only for this conversation", "Nesta conversa, tratar ferramentas sem nível declarado deste servidor como somente leitura", "इस चैट में, इस सर्वर पर अघोषित स्तर वाले टूल को केवल-पढ़ने योग्य मानें") }}
              </label>
              <div v-if="confirmExpiryText(b.pending.expiresInMs)" class="confirm-expiry">
                {{ confirmExpiryText(b.pending.expiresInMs) }}
              </div>
              <div class="confirm-ops">
                <button type="button" class="mcp-primary" @click="answerToolConfirm(b, true)">
                  {{ tx("允许", "Allow", "Permitir", "अनुमति दें") }}
                </button>
                <button type="button" class="mcp-link" @click="answerToolConfirm(b, false)">
                  {{ tx("拒绝", "Deny", "Recusar", "अस्वीकार करें") }}
                </button>
              </div>
            </div>
            <div v-if="b.clarification" class="confirm-card">
              <div class="confirm-text">
                {{ tx("需要你确认一下", "Need your input", "Preciso de uma confirmação", "आपकी पुष्टि आवश्यक") }}：{{ b.clarification.question }}
              </div>
              <div v-if="b.clarification.missingField || b.clarification.whyItMatters" class="clarify-why">
                <span v-if="b.clarification.missingField" class="clarify-why__field">
                  {{ tx("待定项", "Open point", "Ponto em aberto", "खुला बिंदु") }}：{{ b.clarification.missingField }}
                </span>
                <span v-if="b.clarification.whyItMatters" class="clarify-why__text">
                  {{ b.clarification.whyItMatters }}
                </span>
              </div>
              <div class="clarify-options">
                <button
                  v-for="opt in b.clarification.options"
                  :key="opt.label"
                  type="button"
                  class="clarify-opt"
                  @click="answerClarification(b, opt.label)"
                >
                  <span class="clarify-label">{{ opt.label }}</span>
                  <span v-if="opt.description" class="clarify-desc">{{ opt.description }}</span>
                </button>
              </div>
              <!-- 自由文本回退：选项都不贴切时可直接补充说明（点选项不补充 = 模型拿到零信息）。 -->
              <div class="clarify-free">
                <input
                  v-model="clarifyDraft[b.id]"
                  type="text"
                  class="clarify-free__input"
                  :placeholder="tx('以上都不是？直接补充说明', 'None of these? Add your own answer', 'Nenhuma delas? Escreva a sua', 'इनमें से कोई नहीं? अपना उत्तर लिखें')"
                  @keydown="onInlineSubmitKeydown($event, () => submitClarifyFreeform(b))"
                />
                <button
                  type="button"
                  class="clarify-free__send"
                  :disabled="!(clarifyDraft[b.id] || '').trim()"
                  @click="submitClarifyFreeform(b)"
                >
                  {{ tx("发送", "Send", "Enviar", "भेजें") }}
                </button>
              </div>
              <div v-if="confirmExpiryText(b.clarification.expiresInMs)" class="confirm-expiry">
                {{ confirmExpiryText(b.clarification.expiresInMs) }}
              </div>
              <div class="confirm-ops">
                <button type="button" class="mcp-link" @click="answerClarification(b)">
                  {{ tx("跳过，按你的理解继续", "Skip and use your best guess", "Pular e usar seu melhor palpite", "छोड़ें, अपनी समझ से आगे बढ़ें") }}
                </button>
              </div>
            </div>
            <div v-if="b.images?.length" class="thumbs">
              <img v-for="img in b.images" :key="img.id" :src="`/agent/chat/upload/${img.id}`" :alt="img.name" />
            </div>
            <div v-if="b.role === 'user'" class="plain">{{ b.text }}</div>
            <template v-else>
              <!-- 流式 loading 态完全交给推理面板（正在规划/思考中/步骤/子代理），
                   答案气泡在出正文前保持空，避免与推理面板重复出现「思考中」指示。 -->
              <div v-if="b.text" class="md" v-html="renderChatMarkdown(bubbleBody(b), uiLocale)"></div>
            </template>
            <!-- 图表卡片（render_chart 产出）：必须挂在气泡内容层——放进可折叠的推理面板会被默认折叠态
                 的 display:none 隐藏，容器量到 0×0、图表完全不可见。一张一个卡片，逐张渲染、不互相覆盖。 -->
            <div v-for="(c, ci) in b.charts || []" :key="`chart-${ci}`" class="chart-card-wrap">
              <ChartCard
                :title="c.title"
                :chart-type="c.chartType"
                :data="c.data"
                :encode="c.encode"
                :options="c.options"
              />
            </div>
            <div v-for="(a, ai) in b.artifacts || []" :key="`artifact-${ai}`" class="artifact-card">
              <span class="artifact-card__name" :title="a.name">{{ a.name }}</span>
              <span class="artifact-card__meta">{{ formatBytes(a.bytes) }}</span>
              <button
                v-if="isHtmlArtifact(a)"
                type="button"
                class="artifact-card__btn"
                @click="openArtifactPreview(a)"
              >{{ tx('预览', 'Preview', 'Vista', 'पूर्वावलोकन') }}</button>
              <a
                class="artifact-card__btn"
                :href="workspaceDownloadUrl(currentId, a.path)"
                :download="a.name"
              >{{ tx('下载', 'Download', 'Descargar', 'डाउनलोड') }}</a>
            </div>
            <div v-if="isStoppedBubble(b)" class="stopped-tag">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
              {{ tx("已停止生成", "Stopped", "Geração interrompida", "उत्पादन रोक दिया गया") }}
            </div>
            <div v-if="b.error" class="err">{{ b.error }}</div>
            <div v-if="b.usage" class="usage-line">{{ usageText(b.usage) }}</div>
          </div>
            <div class="bubble-actions">
            <button
              v-if="b.role === 'user'"
              type="button"
              class="bubble-act"
              :title="tx('编辑', 'Edit', 'Editar', 'संपादित करें')"
              :aria-label="tx('编辑', 'Edit', 'Editar', 'संपादित करें')"
              @click="editUserBubble(b)"
            ><span class="flip-x">✎</span></button>
            <button
              v-if="isLatestAlertMarkerBubble(b)"
              type="button"
              class="bubble-act bubble-act--text"
              :title="tx('把本轮试跑设为定时数据预警（指令与连接器会带入表单）', 'Turn this check into a scheduled data alert (prompt + connectors go to the form)', 'Transformar esta verificação em alerta agendado (prompt + conectores no formulário)', 'इस जाँच को शेड्यूल्ड डेटा अलर्ट बनाएँ (प्रॉम्प्ट + कनेक्टर फ़ॉर्म में)')"
              :aria-label="tx('设为数据预警', 'Set as data alert', 'Definir como alerta', 'डेटा अलर्ट सेट करें')"
              @click="openAlertScheduleFromChat(b)"
            >{{ tx("设为数据预警", "Set as alert", "Como alerta", "अलर्ट सेट") }}</button>
            <button
              type="button"
              class="bubble-act"
              :title="tx('复制', 'Copy', 'Copiar', 'कॉपी करें')"
              :aria-label="tx('复制', 'Copy', 'Copiar', 'कॉपी करें')"
              @click="copyBubble(b)"
            >⧉</button>
          </div>
          </div>
        </div>
        <!-- 回到顶部：挂在对话滚动容器内（滚动容器由组件自动识别），长对话翻久了可一键回顶；
             avoid-selector 让按钮抬到底部输入区上方，不压住输入框与发送键。
             threshold 用 120（约一个气泡高）：对话区可滚高度常常只有一两百像素（几轮对话），
             沿用页面级的 240 会几乎不出现。 -->
        <BackToTop :threshold="120" avoid-selector=".composer" focus-target=".thread" />

      </div>

      <footer v-show="!showTaskForm && !showTaskList" class="composer">
        <div v-if="current.queue.length" class="queue" role="region" :aria-label="tx('待发队列', 'Message queue', 'Fila de envio', 'प्रेषण कतार')">
          <div class="queue__head">
            <span>{{ tx("排队中", "Queued", "Na fila", "कतार में") }} · {{ current.queue.length }}</span>
            <span class="queue__hint">{{ tx("生成结束后按序自动发送", "Sent in order after the current reply", "Enviadas em ordem após a resposta atual", "वर्तमान उत्तर के बाद क्रम से स्वतः भेजा जाएगा") }}</span>
          </div>
          <div v-for="(item, i) in current.queue" :key="item.at" class="queue__item">
            <span class="queue__text">{{ item.text || (item.docs && item.docs.length ? `（${item.docs.length} 个附件）` : tx("（仅图片）", "(images only)", "(apenas imagens)", "(केवल छवियाँ)")) }}</span>
            <span class="queue__ops">
              <button
                type="button"
                :disabled="i === 0"
                :title="tx('上移', 'Move up', 'Mover para cima', 'ऊपर ले जाएं')"
                :aria-label="tx('上移', 'Move up', 'Mover para cima', 'ऊपर ले जाएं')"
                @click="moveQueueItem(i, -1)"
              >
                ↑
              </button>
              <button
                type="button"
                :disabled="i === current.queue.length - 1"
                :title="tx('下移', 'Move down', 'Mover para baixo', 'नीचे ले जाएं')"
                :aria-label="tx('下移', 'Move down', 'Mover para baixo', 'नीचे ले जाएं')"
                @click="moveQueueItem(i, 1)"
              >
                ↓
              </button>
              <button type="button" @click="editQueueItem(i)">{{ tx("编辑", "Edit", "Editar", "संपादित करें") }}</button>
              <button type="button" :title="tx('移除', 'Remove', 'Remover', 'हटाएं')" :aria-label="tx('移除', 'Remove', 'Remover', 'हटाएं')" @click="removeQueueItem(i)">
                ×
              </button>
              <button type="button" class="queue__send" @click="sendQueueItemNow(i)">
                {{ tx("立即发送", "Send now", "Enviar agora", "अभी भेजें") }}
              </button>
            </span>
          </div>
        </div>
        <div v-if="current.pendingImages.length" class="pending">
          <span v-for="img in current.pendingImages" :key="img.id" class="chip">
            {{ img.name }}
            <button
              type="button"
              :title="tx('移除', 'Remove', 'Remover', 'हटाएं')"
              :aria-label="tx('移除', 'Remove', 'Remover', 'हटाएं')"
              @click="removePendingImage(img.id)"
            >
              ×
            </button>
          </span>
        </div>
        <div v-if="current.pendingDocs.length" class="pending">
          <span v-for="doc in current.pendingDocs" :key="doc.id" class="chip">
            📎 {{ doc.name }}
            <button
              type="button"
              :title="tx('移除', 'Remove', 'Remover', 'हटाएं')"
              :aria-label="tx('移除', 'Remove', 'Remover', 'हटाएं')"
              @click="removePendingDoc(doc.id)"
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
              "O modelo atual não suporta imagens, então elas não serão enviadas. Escolha um modelo com suporte a visão.",
              "वर्तमान मॉडल छवियों का समर्थन नहीं करता, इसलिए वे भेजी नहीं जाएंगी। छवि-सक्षम मॉडल चुनें।",
            )
          }}
        </div>
        <div class="composer-row">
          <input
            id="chat-file-input"
            ref="fileInput"
            type="file"
            name="files"
            accept="image/*,.pdf,.docx,.xlsx,.md,.txt,.csv"
            multiple
            hidden
            @change="pickFiles"
          />
          <PromptBox
            ref="promptBoxEl"
            v-model="current.input"
            id="chat-input"
            name="message"
            rows="1"
            :min-height="COMPOSER_BASE"
            :max-height="COMPOSER_AUTO_MAX"
            :pad-top="6"
            :placeholder="tx('输入消息…', 'Type a message…', 'Digite uma mensagem…', 'संदेश लिखें…')"
            :hint="tx('Enter 发送 · Shift+Enter 换行', 'Enter to send · Shift+Enter for a new line', 'Enter envia · Shift+Enter nova linha', 'भेजने के लिए Enter · नई पंक्ति के लिए Shift+Enter')"
            @input="autoGrow"
            @keydown="onKeydown"
          >
            <template #top>
              <div
                class="composer-grip"
                :title="tx('拖拽调整输入框高度，双击恢复自动', 'Drag to resize the input, double-click to reset', 'Arraste para redimensionar a entrada; duplo clique para restaurar', 'इनपुट का आकार बदलने के लिए खींचें; स्वतः बहाल करने के लिए डबल-क्लिक करें')"
                @mousedown.prevent="startComposerResize"
                @dblclick="resetComposerSize"
              >
                <span class="composer-grip__bar"></span>
              </div>
            </template>
            <template #toolbar-left>
              <div ref="toolsRoot" class="tools-menu-box">
                <button
                  type="button"
                  class="icon-btn"
                  :class="{ on: toolsMenuOpen || mcpOpen || skillOpen || expertOpen }"
                  :aria-expanded="toolsMenuOpen || mcpOpen || skillOpen || expertOpen"
                  aria-haspopup="menu"
                  :title="tx('工具', 'Tools', 'Ferramentas', 'टूल')"
                  :aria-label="tx('工具', 'Tools', 'Ferramentas', 'टूल')"
                  @click="toggleToolsMenu"
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
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>

                <!-- 已选专家 chip（对齐 CodeBuddy）：选中专家后显示在 + 旁，仅点 × 取消选中回通用；无 chip = 通用。 -->
                <div
                  v-if="currentExpert"
                  class="expert-chip"
                >
                  <span class="expert-chip__label">{{ agentText(currentExpert.label, uiLocale) }}</span>
                  <button
                    type="button"
                    class="expert-chip__close"
                    :title="tx('取消选中助手，回到通用助手', 'Deselect assistant, back to general assistant', 'Desmarcar assistente, voltar ao assistente geral', 'सहायक चयन रद्द करें, सामान्य सहायक पर वापस')"
                    aria-label="取消选中助手"
                    @click.stop="onClearExpert"
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>

                <div v-if="toolsMenuOpen" class="tools-menu" role="menu">
                  <button
                    class="tools-menu__row"
                    type="button"
                    role="menuitem"
                    @click="fileInput?.click(); closeToolsPanels()"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
                      <circle cx="8.75" cy="10" r="1.5" />
                      <path d="M20.5 15.5 15.75 11 9.5 17.5" />
                    </svg>
                    <span>{{ tx("添加文件", "Add files", "Adicionar arquivos", "फ़ाइल जोड़ें") }}</span>
                  </button>
                  <button
                    class="tools-menu__row"
                    type="button"
                    role="menuitem"
                    :aria-expanded="skillOpen"
                    @click="openSkillPanel()"
                    @mouseenter="hoverFlyout('skills')"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M12 3l2.2 5.4L20 10l-4.4 3.6L16.8 20 12 17l-4.8 3 1.2-6.4L4 10l5.8-1.6z" />
                    </svg>
                    <span>{{ tx("技能", "Skills", "Habilidades", "स्किल") }}</span>
                    <span v-if="current.settings.skillsEnabled.length" class="tools-badge">{{ current.settings.skillsEnabled.length }}</span>
                    <span class="tools-menu__chev">›</span>
                  </button>
                  <button
                    class="tools-menu__row"
                    type="button"
                    role="menuitem"
                    :aria-expanded="mcpOpen"
                    @click="openMcpPanel()"
                    @mouseenter="hoverFlyout('mcp')"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M9 6a3 3 0 1 1 6 0v1h2.5A1.5 1.5 0 0 1 19 8.5v3a3 3 0 0 1-3 3h-1v1a3 3 0 0 1-6 0v-1H7a3 3 0 0 1-3-3v-3A1.5 1.5 0 0 1 5.5 7H9z" />
                    </svg>
                    <span>{{ tx("连接器", "Connectors", "Conectores", "कनेक्टर") }}</span>
                    <span v-if="enabledMcpCount" class="tools-badge">{{ enabledMcpCount }}</span>
                    <span class="tools-menu__chev">›</span>
                  </button>
                  <button
                    class="tools-menu__row"
                    type="button"
                    role="menuitem"
                    :aria-expanded="expertOpen"
                    @click="openExpertPanel()"
                    @mouseenter="hoverFlyout('expert')"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <circle cx="12" cy="8" r="3.4" />
                      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
                    </svg>
                    <span>{{ tx("助手", "Assistant", "Assistente", "सहायक") }}</span>
                    <span v-if="currentExpert" class="tools-badge">1</span>
                    <span class="tools-menu__chev">›</span>
                  </button>
                </div>

                <div v-if="skillOpen" class="tools-flyout" role="dialog" :aria-label="tx('技能', 'Skills', 'Habilidades', 'स्किल')">
                  <ToolsSearch v-model="skillQuery" :placeholder="tx('搜索技能', 'Search skills', 'Buscar habilidades', 'स्किल खोजें')" :autofocus="searchAutofocus" />

                  <div class="tools-list">
                    <div v-if="!skillFiltered.length" class="empty-hint">
                      {{
                        skillAvailable.length
                          ? tx("没有匹配的技能", "No matching skills", "Nenhuma habilidade correspondente", "कोई मेल खाता स्किल नहीं")
                          : tx("没有可勾选的技能（默认技能无需勾选即已生效）", "No selectable skills (default skills are already in effect)", "Nenhuma habilidade selecionável (as padrão já estão ativas)", "कोई चयन-योग्य स्किल नहीं (डिफ़ॉल्ट स्किल पहले से लागू हैं)")
                      }}
                    </div>
                    <button
                      v-for="s in skillFiltered"
                      :key="s.dir"
                      type="button"
                      class="tools-item"
                      :class="{ on: current.settings.skillsEnabled.includes(s.dir) }"
                      :disabled="skillBusy"
                      @click="toggleSkill(s.dir, !current.settings.skillsEnabled.includes(s.dir))"
                    >
                      <span class="tools-item__icon" :style="iconStyle(s.dir)" aria-hidden="true">{{ iconChar(s.name) }}</span>
                      <span class="tools-item__body">
                        <span class="tools-item__name">{{ s.name }}</span>
                        <span class="tools-item__desc" :title="s.description || ''">{{ s.description || tx("（无描述）", "(no description)", "(sem descrição)", "(कोई विवरण नहीं)") }}</span>
                      </span>
                      <svg v-if="current.settings.skillsEnabled.includes(s.dir)" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="m5 12.5 4.5 4.5L19 7.5" />
                      </svg>
                    </button>
                  </div>

                  <div class="tools-flyout__foot">
                    <p class="flyout-hint">
                      {{
                        tx(
                          "勾选的技能全文会注入本对话的系统提示；未勾选的技能模型仍可按需加载。",
                          "Checked skills are injected in full into this conversation's system prompt; unchecked ones load on demand.",
                          "Habilidades marcadas são injetadas por completo; as demais são carregadas sob demanda.",
                          "चुने गए स्किल पूर्ण रूप से इंजेक्ट होते हैं; बाकी ऑन-डिमांड लोड होते हैं।",
                        )
                      }}
                    </p>
                    <button
                      class="tools-flyout__action"
                      type="button"
                      :disabled="!current.settings.skillsEnabled.length || skillBusy"
                      @click="clearSkillSelection"
                    >
                      {{ tx("取消全部已选技能", "Deselect all skills", "Desmarcar todas as habilidades", "सभी चयन हटाएँ") }}
                    </button>
                  </div>
                  <div v-if="skillError" class="mcp-error">{{ skillError }}</div>
                </div>

                <div v-if="mcpOpen" class="tools-flyout" role="dialog" :aria-label="tx('MCP 连接', 'MCP connections', 'Conexões MCP', 'MCP कनेक्शन')">
                  <ToolsSearch v-model="mcpQuery" :placeholder="tx('搜索连接器', 'Search connectors', 'Buscar conectores', 'कनेक्टर खोजें')" :autofocus="searchAutofocus" />

                  <div class="tools-list">
                    <div v-if="!mcpFiltered.length" class="empty-hint">
                      {{
                        mcpAvailable.length
                          ? tx("没有匹配的连接器", "No matching connectors", "Nenhum conector correspondente", "कोई मेल खाता कनेक्टर नहीं")
                          : tx("没有可选的 MCP 服务器", "No MCP server available", "Nenhum servidor MCP disponível", "कोई MCP सर्वर उपलब्ध नहीं")
                      }}
                    </div>
                    <div
                      v-for="s in mcpFiltered"
                      :key="s.id"
                      class="tools-item"
                      :class="{ on: current.settings.mcpEnabled.includes(s.id) }"
                    >
                      <button
                        type="button"
                        class="tools-item__main"
                        :disabled="mcpBusy"
                        @click="toggleMcp(s.id, !current.settings.mcpEnabled.includes(s.id))"
                      >
                        <span class="tools-item__icon" :style="iconStyle(s.id)" aria-hidden="true">{{ iconChar(s.label) }}</span>
                        <span class="tools-item__body">
                          <span class="tools-item__name">
                            {{ s.label }}
                            <span class="mcp-status" :class="mcpRowState(s).cls">
                              <span class="mcp-dot" :class="mcpRowState(s).cls"></span>
                              {{ mcpRowState(s).text }}
                            </span>
                          </span>
                          <span class="tools-item__desc" :title="mcpDescText(s)">{{ mcpDescText(s) }}</span>
                          <span v-if="mcpExpanded === s.id && s.toolNames.length" class="tools-item__tools">{{ s.toolNames.join("、") }}</span>
                        </span>
                      </button>
                      <span class="tools-item__check-slot" aria-hidden="true">
                        <svg v-if="current.settings.mcpEnabled.includes(s.id)" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="m5 12.5 4.5 4.5L19 7.5" />
                        </svg>
                      </span>
                      <span class="tools-item__ops">
                        <button
                          class="mcp-mini"
                          :class="{ 'is-ghost': !s.toolNames.length }"
                          type="button"
                          :disabled="!s.toolNames.length"
                          :tabindex="s.toolNames.length ? undefined : -1"
                          :title="s.toolNames.length ? tx('工具清单', 'Tool list', 'Lista de ferramentas', 'टूल सूची') : undefined"
                          :aria-hidden="!s.toolNames.length"
                          @click.stop="s.toolNames.length && (mcpExpanded = mcpExpanded === s.id ? '' : s.id)"
                        >
                          {{ mcpExpanded === s.id ? "▴" : "▾" }}
                        </button>
                        <button
                          class="mcp-mini"
                          type="button"
                          :disabled="mcpBusy || !current.settings.mcpEnabled.includes(s.id)"
                          :title="tx('重连', 'Reconnect', 'Reconectar', 'पुनः कनेक्ट')"
                          @click.stop="reconnectMcp(s.id)"
                        >
                          ⟳
                        </button>
                      </span>
                    </div>
                  </div>

                  <div class="tools-flyout__foot">
                    <button
                      class="tools-flyout__action"
                      type="button"
                      :disabled="!enabledMcpCount || mcpBusy"
                      @click="clearMcpSelection"
                    >
                      {{ tx("取消全部已选连接器", "Deselect all connectors", "Desmarcar todos os conectores", "सभी चयन हटाएँ") }}
                    </button>
                  </div>
                  <div v-if="mcpError" class="mcp-error">{{ mcpError }}</div>
                </div>

                <div v-if="expertOpen" class="tools-flyout" role="dialog" :aria-label="tx('助手', 'Assistant', 'Assistente', 'सहायक')">
                  <ToolsSearch v-model="expertQuery" :placeholder="tx('搜索助手', 'Search assistants', 'Buscar assistentes', 'सहायक खोजें')" :autofocus="searchAutofocus" />

                  <div class="tools-list">
                    <div v-if="!expertFiltered.length" class="empty-hint">
                      {{ tx("没有匹配的助手", "No matching assistants", "Nenhum assistente correspondente", "कोई मेल खाता सहायक नहीं") }}
                    </div>
                    <button
                      v-for="a in expertFiltered"
                      :key="a.id"
                      type="button"
                      class="tools-item"
                      :class="{ on: a.id === AGENT_ID }"
                      @click="onPickExpert(a)"
                    >
                      <span class="tools-item__icon" :style="iconStyle(a.id)" aria-hidden="true">{{ a.icon }}</span>
                      <span class="tools-item__body">
                        <span class="tools-item__name">{{ agentText(a.label, uiLocale) }}</span>
                        <span class="tools-item__desc" :title="agentText(a.description, uiLocale)">{{ agentText(a.description, uiLocale) }}</span>
                      </span>
                      <svg v-if="a.id === AGENT_ID" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="m5 12.5 4.5 4.5L19 7.5" />
                      </svg>
                    </button>
                  </div>
                  <div class="tools-flyout__foot">
                    <p class="flyout-hint">
                      {{
                        tx(
                          "切换助手会跳转到对应角色页面，会话按角色隔离。",
                          "Switching expert jumps to that role's page; conversations are isolated per role.",
                          "Trocar especialista vai para a página daquele papel; conversas isoladas por papel.",
                          "विशेषज्ञ बदलने से उस भूमिका के पृष्ठ पर जाता है; वार्तालाप भूमिका के अनुसार अलग रहते हैं।",
                        )
                      }}
                    </p>
                  </div>
                </div>
              </div>
            </template>
            <template #toolbar-right>
              <button
                v-if="current.sending"
                ref="stopBtnRef"
                class="send stop"
                type="button"
                :title="tx('停止', 'Stop', 'Parar', 'रोकें')"
                :aria-label="tx('停止', 'Stop', 'Parar', 'रोकें')"
                @click="stop"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
              <button
                v-else
                class="send"
                type="button"
                :disabled="!canSend"
                :title="tx('发送', 'Send', 'Enviar', 'भेजें')"
                :aria-label="tx('发送', 'Send', 'Enviar', 'भेजें')"
                @click="send"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              </button>
            </template>
          </PromptBox>
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
  /* 同 .mc：dvh 大于真实视口时（动态工具栏/设备模拟）钳回 #app-main，防 body 滚动露出底色。 */
  max-height: 100%;
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
  /* min-width:0 让折叠态真正能缩到 0（否则被内部内容最小宽度撑住，
     文字会 reflow 闪现）；overflow:hidden 把固定宽度的 inner 裁掉而非重排。 */
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  /* 桌面端折叠时平滑收起（移动端媒体查询会改用 transform 过渡）。 */
  transition:
    flex-basis 0.2s ease,
    width 0.2s ease;
}

/* 固定宽度的内部容器：折叠时整体被外层裁切，文字不会重新换行/抖动闪现。 */
.sidebar__inner {
  width: 256px;
  flex: none;
  height: 100%;
  padding: 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.brand {
  display: flex;
  align-items: center;
  padding: 4px 6px 2px;
}

.brand__name {
  margin: 0;
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

/* 返回门户入口：低调，悬停才点亮 */
.brand__home {
  margin-left: 6px;
  color: var(--muted);
  text-decoration: none;
  font-size: 15px;
  line-height: 1;
}

.brand__home:hover,
.brand__home:focus-visible {
  color: var(--ink);
}

/* 侧栏收起按钮（仅桌面端渲染）：放侧栏头部右侧，收起后由顶栏汉堡负责展开。 */
.brand__collapse {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-left: auto;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
  transition:
    color 0.15s ease,
    background 0.15s ease;
}

.brand__collapse:hover {
  color: var(--ink);
  background: var(--fill-soft);
}

.brand__collapse:focus-visible {
  box-shadow: var(--ring);
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

/* 定时任务：新建/编辑走分组头 + 与右键菜单，表单为共用弹窗 */
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

/* ---- 任务表单：结果通知（仅通道管理；逐任务勾选已移除，通知由通道启用开关控制）---- */

/* antd / vben 风格开关：关=浅底灰轨，开=主题绿（与任务卡片启用色一致）。 */
.notify-switch {
  position: relative;
  width: 38px;
  height: 22px;
  flex: none;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 22%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 14%, transparent);
  transition:
    background 0.2s ease,
    box-shadow 0.2s ease;
}

.notify-switch__knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--ink) 30%, transparent);
  transition: transform 0.2s ease;
}

.notify-switch.on {
  background: color-mix(in srgb, var(--success) 82%, transparent);
  box-shadow: inset 0 0 0 1px transparent;
}

.notify-switch.on .notify-switch__knob {
  transform: translateX(16px);
}

.notify-item__switch {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 24px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: 6px;
}

.notify-item__switch:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

/* 通道管理：外层卡片；其中「添加通道」表单可折叠，通道列表是同级、始终可见。 */
.notify-manage {
  margin-top: 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  overflow: hidden;
}

/* 可折叠区：标题 + 添加表单；收起时只剩标题，列表不受影响。 */
.notify-collapse {
  border-bottom: 1px solid var(--line);
}

.notify-collapse summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
  cursor: pointer;
  user-select: none;
  list-style: none;
}

.notify-collapse summary::-webkit-details-marker {
  display: none;
}

.notify-collapse summary::before {
  content: "▸";
  font-size: 10px;
  transition: transform 0.15s ease;
}

.notify-collapse[open] summary::before {
  transform: rotate(90deg);
}

/* 两列对齐：类型 | 备注名，URL 整行，密钥 | 关键词，按钮右下角 */
.notify-form {
  display: grid;
  grid-template-columns: minmax(96px, 120px) minmax(0, 1fr);
  align-items: center;
  gap: 10px 10px;
  padding: 12px 12px 6px;
}

/* 表单里的输入框沿用 .field__input 的边框/圆角，这里只压尺寸（弹窗内要紧凑）。 */
.notify-form .field__input {
  width: 100%;
  min-width: 0;
  padding: 7px 10px;
  font-size: 12px;
}

/* 通道类型下拉（UiSelect）：字号与同排输入框一致（高度已是 38px 同档）。 */
.notify-form .notify-kind :deep(.uisel__trigger) {
  font-size: 12px;
}

.notify-form .notify-wide {
  grid-column: 1 / -1;
}

.notify-form .primary-btn {
  grid-column: 2;
  justify-self: end;
  padding: 7px 14px;
  font-size: 12px;
}

.notify-list {
  list-style: none;
  margin: 4px 0 0;
  padding: 0 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.notify-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  font-size: 12px;
  color: var(--muted);
}

.notify-item__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.notify-item__label {
  color: var(--ink);
  font-weight: 600;
}

.notify-item__host {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}

/* 行内操作按钮：antd 小号默认钮——有边框有底色（必须一眼看出是按钮），但保持小而轻。 */
.notify-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--panel);
  color: var(--ink);
  font: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

.notify-btn:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--ink) 45%, var(--line));
  background: var(--fill-soft);
  color: var(--ink);
}

.notify-btn--danger {
  color: var(--danger);
}

.notify-btn--danger:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--danger) 45%, var(--line));
  background: color-mix(in srgb, var(--danger) 8%, var(--panel));
}

.notify-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.notify-btn:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

.notify-note {
  margin: 0;
  padding: 0 12px 12px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

/* 外部建的 cron 表达式：等宽字体 + 底纹，和普通说明文字区分开。 */
.cron-raw {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--fill-soft);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 11px;
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
  max-width: 640px;
  max-height: 88dvh;
  /* 头/底固定，只有内容区滚动 */
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
}

.modal__head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--line);
}

.modal__title {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0.01em;
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
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 22px 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* ---- 定时任务表单（内嵌主区，不再是弹窗）----
   宿主平时零占位（:empty 隐藏）；表单打开时铺满 header 以下区域，内容列限宽居中（同弹窗的阅读宽度）。 */
.task-host {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.task-host:empty {
  display: none;
}

/* 表单直接铺在主区上（左右填满、无内层卡片框）：标题一条细线与表单分隔。 */
.task-panel {
  flex: 1;
  min-height: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  padding: 8px 24px 14px;
}

.task-panel__head {
  flex: none;
  display: flex;
  align-items: center;
  padding: 2px 0 10px;
  border-bottom: 1px solid var(--line);
}

.task-panel__title {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.task-panel__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 2px 8px;
  /* 纵向单列：像对话框那样从上往下读——标识 → 运行配置 → 指令（底部 composer）。 */
  display: flex;
  flex-direction: column;
  gap: 18px;
  align-items: stretch;
}

/* 分组、错误提示、指令 composer 都整行通栏。 */
.task-panel__body > .task-section,
.task-panel__body > .field__error,
.task-panel__body > .task-composer {
  width: 100%;
}

/* 每条字段占满整行（不再双列并排导致宽字段被压窄）。 */
.task-panel__body > .field {
  width: 100%;
  min-width: 0;
}

/* 标题行右上角的操作按钮（取消 / 创建）。 */
.task-panel__head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

/* antd 对齐：头部按钮成对等高（32px）+ 88px 等宽下限，取消=默认钮、创建=主钮；主钮不做上浮。 */
.task-panel__head-actions .ghost-btn,
.task-panel__head-actions .primary-btn {
  height: 32px;
  min-width: 88px;
  padding: 0 16px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1;
}

.task-panel__head-actions .primary-btn:hover {
  transform: none;
  box-shadow: none;
}

/* 表单标签提到 14px（antd 表单标签档）。 */
.task-panel .field__label {
  font-size: 14px;
}

/* ---- 主区「定时任务」页（对齐 CodeBuddy）：标题 + 右上主按钮 + 列表行；行点击展开各期运行 ---- */
.task-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px 24px 14px;
}

.task-page__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 0 12px;
  border-bottom: 1px solid var(--line);
}

.task-page__title {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.task-page__count {
  color: var(--muted);
  font-size: 13px;
}

.task-page__actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

.run-filter {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 6px 8px 2px;
}

.task-page__actions .run-filter {
  margin: 0;
}

.run-filter button {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}

.run-filter button.active {
  color: var(--text);
  border-color: var(--text);
}

.task-page__run-empty {
  margin: 0;
  padding: 4px 8px 8px;
  color: var(--muted);
  font-size: 12px;
}

/* 主按钮内联 svg 与文字对齐（primary-btn 是 inline-flex + gap 6，无需额外处理）。 */
.task-page__actions .primary-btn svg {
  flex: none;
}

.task-page__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 0;
}

.task-page__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 80px 0;
  color: var(--muted);
  font-size: 13px;
}

.task-page__item {
  border-bottom: 1px solid color-mix(in srgb, var(--line) 65%, transparent);
}

.task-page__row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 8px 4px;
  cursor: pointer;
  border-radius: var(--radius);
  transition: background 0.15s ease;
}

.task-page__row:hover {
  background: var(--fill-soft);
}

.task-page__caret {
  flex: none;
  display: inline-flex;
  color: var(--muted);
  transition: transform 0.15s ease;
}

.task-page__caret.open {
  transform: rotate(90deg);
}

.task-page__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.task-page__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 元信息一行：类型 · 下次运行/已暂停 · 结果回到的对话（CodeBuddy 的「来源 · 每天 09:00」同位）。 */
.task-page__meta {
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-page__unread {
  flex: none;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--danger);
  color: var(--panel);
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  text-align: center;
}

.task-page__status {
  flex: none;
  font-size: 12px;
  color: var(--muted);
}

.task-page__status.paused {
  color: var(--danger);
}

/* 展开的各期运行：缩进对齐标题列，行点击打开该期会话。 */
.task-page__runs {
  padding: 0 4px 10px 29px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.task-page__run {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 4px 10px;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--ink-2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s ease;
}

.task-page__run:hover {
  background: var(--fill-soft);
}

.task-page__run.active {
  background: var(--fill-soft);
  color: var(--ink);
}

.task-page__run-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-page__run-at {
  flex: none;
  font-size: 11px;
  color: var(--muted);
}

/* 名称：作为任务标题，输入框略放大，更像对话里「给这件事起个名」。 */
.task-panel__body > .field--name .field__input {
  font-size: 15px;
  padding: 11px 12px;
}

/* 指令 composer：外层一张「输入框卡片」，让任务内容看起来和底部对话框同一观感——
   圆角、轻描边、微投影；PromptBox 本身（对话输入区外壳）撑满卡片，工具条在框内。 */
.task-composer {
  /* 对齐对话区：① 输入框永远在表单底部（空间富余时 margin-top:auto 顶到底，
     内容超长需要滚动时 sticky 保证不跟着滚走）；② PromptBox 本身就是那张卡片，
     外层不再包框——框里套框（双描边双圆角）是上一版观感发闷的主因；
     背景色仅用于 sticky 滚动时遮挡身后内容。 */
  position: sticky;
  bottom: 0;
  z-index: 2;
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--panel);
}

.task-composer .field__label {
  font-size: 14px;
}

/* PromptBox 在卡片里撑满。 */
.task-composer :deep(.prompt-box) {
  width: 100%;
}

/* 窄屏：设置列表行允许换行，标签保持固定列宽。 */
@media (max-width: 720px) {
  .task-row {
    flex-wrap: wrap;
  }
}

/* 分组：设置列表风格——每行「标签 | 值/控件 | 行尾操作」，发丝分割线分隔（对齐 CodeBuddy 的紧凑配置行）。
   不再包卡片底/框：整页只有底部输入框一张强卡片，层次干净；长说明收进各行的悬浮提示（title）。 */
.task-section {
  display: flex;
  flex-direction: column;
}

.task-section > .task-section__label {
  padding: 10px 0 6px;
}

/* 设置列表行。 */
.task-row {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 52px;
  padding: 10px 0;
  border-top: 1px solid color-mix(in srgb, var(--line) 65%, transparent);
}

/* 首行紧贴分组标题，不画分割线。 */
.task-section__label + .task-row {
  border-top: none;
}

/* 行标签对齐 antd Descriptions：弱灰、常规字重；正文才是 14px 主色。 */
.task-row__label {
  flex: 0 0 96px;
  font-size: 13px;
  color: var(--muted);
}

.task-row__body {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.task-row__value {
  font-size: 14px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-section__label {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-2);
}

/* vben 分区标题的左侧竖条 */
.task-section__label::before {
  content: "";
  width: 3px;
  height: 13px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--ink) 45%, transparent);
}

.modal__foot {
  flex: none;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 24px;
  border-top: 1px solid var(--line);
  background: var(--panel);
}

/* 底部按钮：antd 的按钮等高 + 主/次按钮等宽下限（88px），不再随文案长短忽宽忽窄。 */
.modal__foot .ghost-btn,
.modal__foot .primary-btn {
  min-width: 88px;
  height: 36px;
  padding: 0 16px;
}

/* 删除确认弹窗：antd / Vben 风格——左侧危险图标 + 文本块，底部右对齐双按钮。 */
.modal--confirm {
  max-width: 420px;
}

.confirm-body {
  flex-direction: row;
  align-items: flex-start;
  gap: 12px;
}

.confirm-icon {
  flex: none;
  width: 32px;
  height: 32px;
  margin-top: 2px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.confirm-icon--danger {
  background: color-mix(in srgb, var(--danger) 16%, transparent);
}

.confirm-text {
  min-width: 0;
}

.confirm-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--ink);
}

.confirm-message {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--muted);
  overflow-wrap: anywhere;
}

/* 表单项：标签 8px 间距 + 深色标签（antd 的 label 是 rgba(0,0,0,.88) 而非灰）。 */
.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field__label {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--ink-2);
}

.field__label--row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

/* 必填星号（antd required mark）。 */
.field__req {
  margin-left: 3px;
  color: var(--danger);
  font-weight: 600;
}

.field__input {
  width: 100%;
  /* 与 antd 一致：所有控件同一高度档（38px），select / time / number 才不会参差不齐。 */
  min-height: 38px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 10px 12px;
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

/* 卡片式输入框的样式在 components/PromptBox.vue 里（对话输入区与任务表单共用，不在这里重复一份）。 */

.field__error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}

/* 分段控件对齐 antd Segmented：无外框、浅底容器、选中项白底浮起。 */
.seg {
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: 8px;
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
  padding: 6px 14px;
  border-radius: 6px;
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

/* 分段控件禁用（编辑外部建的表达式时，频率区只读） */
.seg__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.primary-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

.repeat-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* 执行频率行：周期/一次性 + 「每 N 单位 于 时刻」，一行内联，窄屏自动换行。 */
.freq-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

/* 行内的分段控件不撑满：按钮按内容宽度排。 */
.seg--inline {
  flex: none;
}

.seg--inline .seg__btn {
  flex: none;
  min-width: 60px;
}

.freq-text {
  font-size: 13px;
  color: var(--muted);
}

.freq-num {
  width: 72px;
  flex: none;
  text-align: center;
}

/* time 原生控件不吃 min-height：显式定高 + 去掉上下内边距，才能和输入框对齐。 */
.freq-time {
  width: auto;
  flex: none;
  height: 38px;
  padding-top: 0;
  padding-bottom: 0;
}

/* 频率下拉已是自定义组件（UiSelect）：行内收缩、不参与换行拉伸。 */
.freq-unit {
  width: auto;
  flex: none;
}

.dt--inline {
  flex: 1 1 220px;
  min-width: 0;
}

/* 周几圆片：独立命名，避免与待发图片的 .chip（同文件后文定义）互相覆盖 */
.wd-chip {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 5px 12px;
  background: var(--fill);
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    color 0.15s ease,
    background 0.15s ease,
    border-color 0.15s ease;
}

.wd-chip:hover {
  color: var(--ink);
}

.wd-chip.active {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--panel);
}

.wd-chip:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

/* 说明/预览文案：弱化成普通辅助文字，避免弹窗里连着几块灰底显得杂乱。 */
.repeat-preview {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--muted);
  opacity: 0.9;
  overflow-wrap: anywhere;
}

/* MCP 服务器选择下拉框（antd Select 风格，可多选） */
.mcp-select {
  position: relative;
}

/* 任务表单的「+ 工具」浮层：锚盒 Teleport 到 body 后改 fixed 定位，
   左/底/高由内联样式钉成触发器同位矩形，内部菜单上弹/飞出右展与对话区完全同款。 */
.task-tools-pop {
  position: fixed;
  width: 0; /* 不占横向空间；菜单/飞出均 absolute，不依赖父宽 */
  pointer-events: none; /* 锚盒本身不挡点击；子面板再打开交互 */
  /* 需要压过任务弹窗的遮罩层：浮层是 body 直挂节点，不在弹窗的层叠上下文里。 */
  z-index: 120;
}

.task-tools-pop .tools-menu,
.task-tools-pop .tools-flyout {
  pointer-events: auto;
}

/* 面板底部说明：原来写在字段下方的那一句，工具条上放不下。 */
.mcp-select__foot {
  margin: 4px 0 0;
  padding: 8px 8px 6px;
  border-top: 1px solid color-mix(in srgb, var(--line) 60%, transparent);
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted);
}

.mcp-select__trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 38px;
  padding: 5px 10px;
  text-align: left;
  font: inherit;
  color: var(--ink);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.mcp-select__trigger:hover {
  border-color: color-mix(in srgb, var(--ink) 35%, var(--line));
}

.mcp-select__trigger.open {
  border-color: var(--ink);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 18%, transparent);
}

.mcp-select__trigger:focus-visible {
  box-shadow: var(--ring);
}

.mcp-select__placeholder {
  flex: 1;
  color: var(--muted);
  opacity: 0.75;
}

.mcp-select__chips {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.mcp-select__chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  font-size: 12px;
  color: var(--ink);
  background: var(--fill-soft);
  border: 1px solid var(--line);
  border-radius: 999px;
}

.mcp-select__caret {
  flex: none;
  color: var(--muted);
  transition: transform 0.15s ease;
}

.mcp-select__caret.flip {
  transform: rotate(180deg);
}

.mcp-select__panel {
  position: fixed;
  z-index: 1200;
  padding: 4px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 240px;
  overflow-y: auto;
}

.mcp-select__opt {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  font: inherit;
  color: var(--ink);
  text-align: left;
  background: transparent;
  border: none;
  border-radius: 8px;
  cursor: pointer;
}

.mcp-select__opt:hover {
  background: var(--fill-soft);
}

.mcp-select__opt.active {
  background: color-mix(in srgb, var(--ink) 8%, var(--panel));
}

.mcp-select__opt-label {
  font-size: 13px;
  font-weight: 600;
}

.mcp-select__opt-sub {
  font-size: 11px;
  color: var(--muted);
}

.mcp-select__check {
  margin-left: auto;
  flex: none;
  color: var(--ink);
  font-size: 12px;
}

.mcp-select__empty {
  margin: 0;
  padding: 10px;
  font-size: 12px;
  color: var(--muted);
  text-align: center;
}

/* 执行时间选择器（antd/vben 风格面板） */
.dt {
  position: relative;
}

.dt__field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
  text-align: left;
  font: inherit;
}

.dt__placeholder {
  color: var(--muted);
  opacity: 0.7;
}

.dt__icon {
  flex: none;
  color: var(--muted);
}

.dt__panel {
  position: fixed;
  z-index: 1200;
  width: 264px;
  padding: 10px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dt__short {
  display: flex;
  gap: 6px;
}

.dt__short-btn {
  flex: 1;
  appearance: none;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 4px 6px;
  background: var(--fill-soft);
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.dt__short-btn:hover {
  color: var(--ink);
  border-color: var(--ink);
}

.dt__short-btn:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

.dt__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.dt__month {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}

.dt__nav {
  display: flex;
  gap: 2px;
}

.dt__nav-btn {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 14px;
  line-height: 1;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
}

.dt__nav-btn:hover {
  color: var(--ink);
  background: var(--fill-soft);
}

.dt__nav-btn:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

.dt__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}

.dt__wd {
  font-size: 11px;
  color: var(--muted);
  text-align: center;
  padding: 3px 0;
}

.dt__cell {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 12px;
  aspect-ratio: 1;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.dt__cell--empty {
  cursor: default;
}

.dt__cell:hover {
  background: var(--fill-soft);
}

.dt__cell:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

.dt__cell.today {
  color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--ink);
  font-weight: 600;
}

.dt__cell.sel {
  background: var(--ink);
  color: var(--panel);
  font-weight: 600;
}

.dt__foot {
  display: flex;
  align-items: center;
  gap: 6px;
  border-top: 1px solid var(--line);
  padding-top: 8px;
}

.dt__time-label {
  font-size: 12px;
  color: var(--muted);
  margin-right: auto;
}

.dt__sel {
  appearance: auto;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--fill);
  color: var(--ink);
  font: inherit;
  font-size: 12px;
  padding: 3px 4px;
  width: 46px;
  text-align: center;
}

.dt__colon {
  color: var(--muted);
}

.dt__ok {
  appearance: none;
  border: 1px solid var(--ink);
  border-radius: var(--radius);
  background: var(--ink);
  color: var(--panel);
  font: inherit;
  font-size: 12px;
  padding: 4px 12px;
  cursor: pointer;
}

.dt__ok:hover {
  opacity: 0.85;
}

.dt__ok:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

/* 快捷操作导航行（CodeBuddy 版式）：图标 + 文字，创建入口集中在此。 */
.side-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 8px;
}

.side-nav__item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}

.side-nav__item svg {
  flex: none;
  color: var(--muted);
}

.side-nav__item:hover {
  background: var(--fill-soft);
}

.side-nav__item:hover svg {
  color: var(--ink);
}

.side-nav__item:focus-visible {
  outline: none;
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

/* 侧栏首屏骨架行（加载中占位，避免「空列表 → 条目」闪现）。 */
.conv-skeleton {
  height: 34px;
  border-radius: var(--radius-sm);
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--ink) 6%, transparent) 25%,
    color-mix(in srgb, var(--ink) 12%, transparent) 37%,
    color-mix(in srgb, var(--ink) 6%, transparent) 63%
  );
  background-size: 400% 100%;
  animation: boot-shimmer 1.4s ease infinite, skeleton-fade 0.18s ease-out;
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

/* 定时任务分组里的结果状态点：跑成 / 失败 / 跳过（颜色之外还有 title/aria 文案，不靠颜色单打独斗）。 */
.conv-dot.success {
  background: var(--success);
}

.conv-dot.failed {
  background: var(--danger);
}

.conv-dot.skipped,
.conv-dot.cancelled,
.conv-dot.idle,
.conv-dot.paused {
  background: var(--muted);
}

.conv-dot.alert {
  background: color-mix(in srgb, #e05a3c 90%, var(--ink));
}

.conv-dot.nodata {
  background: color-mix(in srgb, #d99a1f 75%, var(--muted));
}

/* ---- 定时任务分组区（docs/scheduled-task-sessions-plan.md §3.10）----
   置顶为可折叠分组：分组头（名称 (数量) + 右侧 chevron）整行可点收起整块，CodeBuddy「任务/空间」同口径；
   父 = 任务（未读角标 + 下次时间 + 直达最近一期），子 = 各期会话。缩进靠 padding，与 .conv-item 对齐。 */
.group-head {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 6px 10px 6px 4px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  letter-spacing: 0.04em;
  text-align: left;
  cursor: pointer;
}

.group-head:hover {
  background: var(--fill-soft);
}

.group-head:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

.group-head__label {
  flex: none;
  font-weight: 600;
}

.group-head__count {
  flex: none;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

/* 分组头 chevron：折叠时指向右、展开时旋转 90° 指向下，固定在行末（CodeBuddy 同款）。 */
.group-head__caret {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: auto;
  color: var(--muted);
  transition: transform 0.15s ease;
}

.group-head__caret.open {
  transform: rotate(90deg);
}

/* 空分组提示：0 个任务时展开给一行弱文案（创建入口在上方导航行）。 */
.task-groups-empty {
  padding: 2px 10px 6px 18px;
  color: var(--muted);
  font-size: 11px;
}

.task-groups {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
}

.task-group__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px 7px 4px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
}

.task-group__head:hover {
  background: var(--fill-soft);
}

.task-group__head:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

/* 折叠箭头：SVG chevron，展开时旋转 90° 指向下方（对齐文件树最佳实践，非图标字体）。 */
.task-group__caret {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  color: var(--muted);
  transition: transform 0.15s ease;
}

.task-group__caret.open {
  transform: rotate(90deg);
}

.task-group__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.task-group__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.task-group__main .task-group__title {
  flex: none;
  width: 100%;
}

.task-group__health {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 10px;
  font-weight: 500;
  line-height: 1.2;
}

/* 未读角标：与 ChatGPT「Scheduled 视图当收件箱」同口径——有新结果要一眼看见。 */
.task-group__unread {
  flex: none;
  min-width: 16px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--accent, #4f7cff);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}

.task-group__next {
  flex: none;
  max-width: 76px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 10px;
}

.task-group__open {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.task-group__open:hover {
  color: var(--ink);
  background: var(--fill-soft);
}

/* 某一期：比普通会话缩进一格，视觉上属于上面的任务。 */
.conv-item--run {
  padding-left: 26px;
}

.conv-item--run .conv-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-run-at {
  flex: none;
  color: var(--muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
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

/* 定时任务专属对话标记：标题前的小时钟图标（结果只回投到这里，区别于普通对话）。 */
.conv-task {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: color-mix(in srgb, var(--accent, #2f6df6) 80%, var(--ink));
  opacity: 0.85;
}

/* 免打扰标记：小字提示，避免占用标题空间 */
.conv-muted {
  flex: none;
  padding: 1px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--line) 55%, transparent);
  color: var(--muted);
  font-size: 10px;
  line-height: 1.4;
  white-space: nowrap;
}

/* 后台任务完成提醒（免打扰的对话不弹） */
.done-toast {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(360px, calc(100vw - 40px));
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm, 8px);
  background: var(--panel, #fff);
  box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
  font-size: 12px;
  animation: done-toast-in 0.22s var(--ease, ease);
}

.done-toast__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.done-toast__view,
.done-toast__close {
  flex: none;
  border: none;
  background: transparent;
  color: var(--accent, #4f7cff);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.done-toast__close {
  color: var(--muted);
  font-size: 14px;
  line-height: 1;
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

/* 归档项：视觉弱化（它在列表里只是「收起来」），仍可点击打开，只是不参与排序。 */
.conv-item.conv-archived {
  opacity: 0.72;
}

.conv-item.conv-archived .conv-title {
  font-style: italic;
}

.conv-item.conv-archived.active {
  opacity: 1;
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

/* 删除撤销条：挂在 .top 内做绝对定位，不再是 body 上的 fixed 元素，scoped 直接命中。
   left:50% 以头部（= 对话区整宽）为参照，是「对话区居中」而非「视口居中」；
   top:calc(100% + 12px) 恒等于头部下方，不必硬编码头部高度（窄屏头部 padding 会变）。 */
.undo-toast {
  position: absolute;
  left: 50%;
  top: calc(100% + 12px);
  transform: translateX(-50%);
  z-index: 70;
  display: flex;
  align-items: center;
  gap: 14px;
  max-width: min(92%, 420px);
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
  color: var(--ink);
  font-size: 13px;
  box-shadow: 0 10px 30px color-mix(in srgb, var(--ink) 22%, transparent);
  animation: undo-toast-in 0.22s var(--ease, ease);
}

.undo-toast__undo {
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
  /* 文案换行时按钮不跟着被压扁。 */
  flex: none;
}

.undo-toast__text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.undo-toast__undo:hover,
.undo-toast__undo:focus-visible {
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

/* 二次确认态：把破坏性动作显式标红，避免「再点一次」被当成无变化的重复点击。 */
.ghost-btn-danger {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 40%, var(--line));
}

.ghost-btn-danger:hover {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  border-color: color-mix(in srgb, var(--danger) 46%, var(--line));
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
  /* 撤销条的定位参照：让 top:calc(100% + Npx) 恒等于「头部下方」，不必硬编码头部高度。 */
  position: relative;
}

.brand {
  font-family: var(--font-display);
  font-size: 17px;
}

.top-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  /* 始终靠右：删掉左侧品牌字后 space-between 只剩单子元素会掉到左边，用 auto 边距兜住。 */
  margin-left: auto;
}

/* ---- 资源/MCP 面板共用部件 ---- */
.tools-badge {
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

/* ---- 输入框左下角「工具」入口：菜单向上弹、飞出面板向右展开（对齐 ima）---- */
.tools-menu-box {
  position: relative;
  display: inline-flex;
  /* 菜单宽度：飞出面板按同一变量右移，保证二级面板落在菜单右侧而不是压在菜单上 */
  --tools-menu-w: 208px;
}

.tools-menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  z-index: 40;
  width: var(--tools-menu-w, 208px);
  padding: 6px;
  border: 1px solid color-mix(in srgb, var(--line) 88%, var(--ink) 12%);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--panel) 92%, white 8%);
  box-shadow:
    0 16px 40px color-mix(in srgb, var(--ink) 16%, transparent),
    0 2px 10px color-mix(in srgb, var(--ink) 8%, transparent);
  backdrop-filter: blur(10px);
  display: flex;
  flex-direction: column;
  gap: 2px;
  animation: tools-pop 0.12s ease-out;
}

.tools-menu__row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s ease;
}

.tools-menu__row:hover {
  background: var(--fill-soft);
}

.tools-menu__row[aria-expanded="true"] {
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}

.tools-menu__row > svg {
  flex: none;
  color: var(--muted);
}

.tools-menu__row[aria-expanded="true"] > svg {
  color: var(--accent, var(--ink));
}

/* 菜单宽度是飞出面板的水平锚点：文案过长时截断，避免撑破固定宽度 */
.tools-menu__row > span:not(.tools-menu__chev):not(.tools-badge) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tools-menu__chev {
  margin-left: auto;
  color: var(--muted);
  font-size: 15px;
  line-height: 1;
}

/* 飞出面板：贴在菜单右侧（锚点 = 菜单宽度，不是触发按钮宽度），底边与触发按钮底边对齐 */
.tools-flyout {
  position: absolute;
  left: calc(var(--tools-menu-w, 208px) + 8px);
  bottom: 0;
  z-index: 41;
  width: 372px;
  max-width: min(372px, calc(100vw - 48px));
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--line) 88%, var(--ink) 12%);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--panel) 92%, white 8%);
  box-shadow:
    0 16px 40px color-mix(in srgb, var(--ink) 16%, transparent),
    0 2px 10px color-mix(in srgb, var(--ink) 8%, transparent);
  backdrop-filter: blur(10px);
  color: var(--ink);
  font-size: 13px;
  animation: tools-slide 0.14s ease-out;
}

@keyframes tools-pop {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes tools-slide {
  from {
    opacity: 0;
    transform: translateX(-6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tools-menu,
  .tools-flyout {
    animation: none;
  }

  /* 骨架屏去掉流光动画（保留静态占位块）。 */
  .boot-skeleton__row,
  .conv-skeleton {
    animation: none;
  }
}

/* 窄屏：飞出改为在菜单上方展开，避免右侧越界 */
@media (max-width: 620px) {
.tools-flyout {
  left: 0;
  bottom: calc(100% + 8px);
  width: min(372px, calc(100vw - 32px));
}
}

/* 搜索框样式随组件走（本文件是 scoped，子选择器到不了子组件内部元素），见 ToolsSearch.vue。 */

.tools-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 320px;
  overflow-y: auto;
}

.tools-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s ease;
}

.tools-item:hover {
  background: var(--fill-soft);
}

.tools-item.on {
  background: color-mix(in srgb, var(--ink) 9%, transparent);
}

.tools-item:disabled {
  cursor: progress;
  opacity: 0.65;
}

.tools-item__main {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.tools-item__icon {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
}

/* 已选专家 chip（对齐 CodeBuddy）：+ 旁的小胶囊，× 可取消选中回通用。 */
.expert-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 6px;
  padding: 4px 4px 4px 10px;
  border: 1px solid var(--border, #d5dae2);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  color: var(--ink);
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.expert-chip:hover {
  background: color-mix(in srgb, var(--ink) 10%, transparent);
  border-color: color-mix(in srgb, var(--ink) 25%, transparent);
}

.expert-chip__label {
  cursor: default;
  user-select: none;
}

.expert-chip__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--muted, #8a93a3);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.expert-chip__close:hover {
  background: color-mix(in srgb, var(--ink) 12%, transparent);
  color: var(--ink);
}

.tools-item__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.tools-item__name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
}

.tools-item__desc {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tools-item__tools {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.4;
  word-break: break-all;
}

.tools-item__check {
  flex: none;
  display: block;
  color: var(--ink);
}

/* 勾选列固定宽：有无勾选都不挤占正文，也不跟右侧操作叠在一起。 */
.tools-item__check-slot {
  flex: none;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: center;
}

.tools-item__ops {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  flex: none;
  /* 两格操作位（清单 + 重连），无清单时用 ghost 占位，⟳ 纵向对齐。 */
  width: calc(24px + 2px + 24px);
  margin-top: 0;
}

.mcp-mini.is-ghost {
  visibility: hidden;
  pointer-events: none;
}

.tools-flyout__foot {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tools-flyout__foot .flyout-hint {
  margin-top: 8px;
}

.tools-flyout__action {
  align-self: flex-start;
  padding: 6px 2px;
  margin-top: 6px;
  border: none;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.tools-flyout__action:hover:not(:disabled) {
  color: var(--ink);
  text-decoration: underline;
}

.tools-flyout__action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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

/* 飞出面板底部的语义说明（技能 / 专家共用，原名 skill-hint 语义过窄）。 */
.flyout-hint {
  margin: 8px 2px 0;
  padding-top: 8px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
}

.mcp-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
}

/* 通用空态占位：飞出面板（技能/连接器/专家）与资源面板（记忆/工作区）共用。 */
.empty-hint {
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
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: none;
  min-width: 0;
  cursor: pointer;
}

.mcp-check {
  width: 15px;
  height: 15px;
  flex: none;
  margin: 0;
  cursor: pointer;
  accent-color: var(--ink);
}

.mcp-row__main:has(.mcp-check:disabled) {
  cursor: default;
}

.mcp-row__detail {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
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
  flex: none;
  white-space: nowrap;
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
  /* 用带 alpha 的颜色而不是 opacity：避免与父级透明度叠加出不可控的灰。 */
  background: color-mix(in srgb, var(--muted) 55%, transparent);
}

/* 状态语义（对齐 antd 的 success/error/processing）：
   ok = 绿、err = 红、running = 品牌金 + 呼吸光环（比「忽明忽暗闪烁」更稳，久看不刺眼）。 */
.mcp-dot.ok {
  background: var(--success);
}

.mcp-dot.err {
  background: var(--danger);
}

.mcp-dot.running {
  background: var(--accent);
  animation: mcp-pulse 1.4s var(--ease) infinite;
}

@keyframes mcp-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 50%, transparent); }
  70% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 0%, transparent); }
  100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent); }
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

.mcp-mini:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  background: transparent;
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

/* ---- 气泡里的工具步骤与确认卡 ----
   步骤采用「时间轴」形态（节点 + 竖轨，对齐 antd Timeline / vben 的执行记录）：
   比「每个步骤各套一个灰盒子」更轻、层次更清、多步连排也不糊成一片。 */
.steps {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 0;
}

/* 竖轨只在 ≥2 步时出现（单步没有「连接」语义，画线反而多余）。 */
.steps:has(.step + .step)::before {
  content: "";
  position: absolute;
  left: 4.5px;
  top: 16px;
  bottom: 14px;
  width: 2px;
  background: var(--rail);
  border-radius: 2px;
}

.step {
  position: relative;
  padding: 5px 6px 6px 24px;
  border-radius: 8px;
  transition: background-color 0.18s var(--ease);
}

/* 展开的步骤给一层极淡底，表达「这一条正在被查看」（对齐 Claude 步骤高亮）。 */
.step.expanded {
  background: color-mix(in srgb, var(--ink) 3.5%, transparent);
}

/* 步骤行头：有结果时整行可点开（对齐 antd Collapse：默认收起、收起时给一行摘要、点开看全文）。
   无结果的步骤同一结构但 disabled —— 一半的样式与键盘可达性都走原生 button，不用 div 模拟。 */
.step-head {
  /* button 默认 shrink-to-fit：摘要长文本会把整行撑出气泡（横向溢出）。
     必须显式占满父级宽度，flex 子项的 min-width:0 省略号链路才生效。 */
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 -6px;
  padding: 3px 6px;
  min-height: 24px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  border-radius: 6px;
  transition: background-color 0.18s var(--ease);
}

button.step-head {
  cursor: pointer;
}

button.step-head:not(:disabled):hover {
  background: color-mix(in srgb, var(--ink) 5%, transparent);
}

button.step-head:disabled {
  cursor: default;
}

/* 时间轴节点：绝对定位落在竖轨上（中心 4.5px = 轨道位置）。
   注意不要给 .step-head 加 position —— 它一旦成为定位祖先，节点就会跟着行头跑偏。 */
.step-head .mcp-dot {
  position: absolute;
  left: 1px;
  top: 11px;
  width: 9px;
  height: 9px;
  /* 白圈把节点从竖轨上「托起」，避免和轨道线粘在一起。 */
  box-shadow: 0 0 0 3px var(--panel);
}

/* 完成 / 失败节点加语义光环（halo），让时间轴一眼可读，不靠文字颜色。 */
.step.ok .mcp-dot {
  box-shadow: 0 0 0 3px var(--panel), 0 0 0 5px color-mix(in srgb, var(--success) 30%, transparent);
}

.step.err .mcp-dot {
  box-shadow: 0 0 0 3px var(--panel), 0 0 0 5px color-mix(in srgb, var(--danger) 30%, transparent);
}

.step-name {
  flex: 0 1 auto;
  min-width: 0;
  /* 工具名是标识符，给足宽度但留白给右侧摘要；过长才省略。 */
  max-width: 42%;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 500;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 收起时的摘要行：不点开也能知道这步拿到了什么（取结果首行，超长省略）。 */
.step-hint {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 11.5px;
  /* 比工具名弱一档，扫读时先看到「做了什么」再看「结果是什么」。 */
  opacity: 0.92;
}

/* 展开指示：收起指向右、展开指向下（与外层推理面板同一个语汇）。 */
.step-caret {
  flex: none;
  width: 6px;
  height: 6px;
  border-right: 1.5px solid color-mix(in srgb, var(--muted) 80%, transparent);
  border-bottom: 1.5px solid color-mix(in srgb, var(--muted) 80%, transparent);
  transform: rotate(-45deg);
  transition: transform 0.2s var(--ease);
}

.step.expanded .step-caret {
  transform: rotate(45deg);
}

/* 来源服务器：antd Tag 形态（发丝边框 + 低饱和底 + 小字号），
   与右侧状态药丸明确区分——原来两者同为灰色小字，扫读时完全分不开。 */
.step-server {
  flex: none;
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--line) 85%, transparent);
  border-radius: 5px;
  background: color-mix(in srgb, var(--fill-soft) 65%, transparent);
  color: color-mix(in srgb, var(--muted) 88%, var(--ink));
  font-size: 10px;
  line-height: 15px;
  letter-spacing: 0.02em;
}

.step-status {
  flex: none;
  margin-left: auto;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 10.5px;
  line-height: 18px;
  font-weight: 500;
  color: var(--muted);
  background: color-mix(in srgb, var(--ink) 6%, transparent);
}

/* 状态药丸配色：只上语义色，不染整块（状态值由模板给的 stepClass 落到 .step 上）。 */
.step.running .step-status {
  color: color-mix(in srgb, var(--accent) 85%, var(--ink));
  background: var(--accent-soft);
}

.step.ok .step-status {
  color: color-mix(in srgb, var(--success) 78%, var(--ink));
  background: var(--success-soft);
}

.step.err .step-status {
  color: color-mix(in srgb, var(--danger) 82%, var(--ink));
  background: var(--danger-soft);
}

.step-result {
  margin: 8px 0 2px;
  max-height: 220px;
  overflow: auto;
  background: var(--surface-2);
  border: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  border-radius: 8px;
  padding: 10px 12px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.55;
  color: color-mix(in srgb, var(--ink) 82%, var(--panel));
  white-space: pre-wrap;
  word-break: break-word;
}

/* 子代理（task 委派）实时面板：独立事件维度，随流式进度更新。 */
.subagents {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.subagents__head {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}

.subagent {
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  border-radius: 8px;
  background: var(--surface-2);
}

.subagent__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
}

.subagent__desc {
  flex: 1;
  min-width: 0;
  color: var(--ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 状态药丸与步骤共用同一套尺寸 + 语义配色，保证「过程面板」里所有状态读起来是一套语言。
   尺寸/字重/对比系数都与 .step-status 逐值对齐，避免两处药丸「差一点点」。 */
.subagent__status {
  flex: none;
  margin-left: auto;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 500;
  line-height: 18px;
  color: var(--muted);
  background: color-mix(in srgb, var(--ink) 6%, transparent);
}

.subagent.running .subagent__status {
  color: color-mix(in srgb, var(--accent) 85%, var(--ink));
  background: var(--accent-soft);
}

.subagent.done .subagent__status {
  color: color-mix(in srgb, var(--success) 78%, var(--ink));
  background: var(--success-soft);
}

.subagent.error .subagent__status {
  color: color-mix(in srgb, var(--danger) 82%, var(--ink));
  background: var(--danger-soft);
}

.subagent__cancel {
  flex: none;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.subagent__cancel:hover {
  color: var(--danger, #d33);
  border-color: var(--danger, #d33);
}

.subagent__text {
  margin: 8px 0 0;
  max-height: 200px;
  overflow: auto;
  background: var(--surface-3);
  border: 1px solid color-mix(in srgb, var(--line) 60%, transparent);
  border-radius: 8px;
  padding: 8px 10px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.6;
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

/* ---- 对话列表：归档开关 ---- */
.conv-archived-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 2px 10px 6px;
  padding: 4px 7px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}

.conv-archived-toggle:hover {
  background: color-mix(in srgb, var(--line) 30%, transparent);
}

.conv-archived-toggle input {
  accent-color: var(--accent, #4f7cff);
}

.conv-search {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 8px 10px 2px;
  padding: 0 10px;
  height: 34px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--muted);
}

.conv-search:focus-within {
  border-color: color-mix(in srgb, var(--accent, #4f7cff) 55%, var(--line));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #4f7cff) 16%, transparent);
}

.conv-search__icon {
  flex: none;
}

.conv-search__input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 13px;
}

/* 聚焦指示只画在外层容器上（见上面的 .conv-search:focus-within）：
   内层 input 是透明无边框的，全局 input:focus-visible 的焦点环落在它身上
   会在输入框内部糊出一圈黑框（比容器小一圈）。 */
.conv-search__input:focus,
.conv-search__input:focus-visible {
  outline: none;
  border: none;
  box-shadow: none;
}

.conv-search__input::placeholder {
  color: var(--muted);
}

.conv-empty {
  margin: 14px 12px;
  color: var(--muted);
  font-size: 13px;
}

/* ---- 资源面板（长期记忆 + 工作区文件）---- */
.res-panel {
  width: min(420px, calc(100vw - 32px));
  max-height: min(560px, calc(100vh - 120px));
  overflow: auto;
}

.res-head {
  margin-top: 10px;
  border-top: 1px solid color-mix(in srgb, var(--line) 60%, transparent);
  padding-top: 8px;
}

.res-memory-add {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}

.res-memory-input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--ink);
  font-size: 12px;
}

.res-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.res-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.res-row:hover {
  background: color-mix(in srgb, var(--line) 30%, transparent);
}

.res-row__text {
  flex: 1;
  min-width: 0;
  word-break: break-all;
  text-align: left;
}

.res-file {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 4px 6px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--ink);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.res-file:hover {
  background: color-mix(in srgb, var(--line) 30%, transparent);
}

.res-file__view {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.res-file__dl {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  text-decoration: none;
}

.res-file__dl:hover {
  background: color-mix(in srgb, var(--line) 30%, transparent);
  color: var(--ink);
}

.artifact-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  margin-top: 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--bg) 75%, var(--line));
}

.artifact-card__name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  word-break: break-all;
}

.artifact-card__meta {
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}

.artifact-card__btn {
  flex: 0 0 auto;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--ink);
  text-decoration: none;
  cursor: pointer;
}

.artifact-card__btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

/* HTML 产物预览模态（对齐 CodeBuddy / Cursor 的 artifact 预览面板）。 */
.modal--preview {
  width: min(960px, 92vw);
  height: min(720px, 88vh);
  display: flex;
  flex-direction: column;
  padding: 0;
}

.modal--preview .modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}

.modal__head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.modal--preview .modal__body.preview-body {
  flex: 1;
  min-height: 0;
  padding: 0;
  overflow: hidden;
}

.preview-frame {
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}

.preview-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--muted);
}

.res-preview {
  margin: 8px 0 0;
  max-height: 200px;
  overflow: auto;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 风险级别徽标：不只靠颜色，文字 + 色彩双通道。 */
.confirm-level {
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.confirm-level-read {
  color: var(--ok, #2e7d32);
  border: 1px solid currentColor;
}

.confirm-level-write {
  color: var(--warn, #b26a00);
  border: 1px solid currentColor;
}

.confirm-level-destructive {
  color: var(--stop, #c62828);
  border: 1px solid currentColor;
}

.confirm-args-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.confirm-args-table td {
  padding: 2px 6px;
  border-top: 1px solid color-mix(in srgb, var(--line) 60%, transparent);
  vertical-align: top;
  word-break: break-word;
}

.confirm-arg-key {
  font-family: var(--font-mono);
  color: var(--muted);
  white-space: nowrap;
  width: 1%;
}

.confirm-arg-val {
  font-family: var(--font-mono);
}

.confirm-grant {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}

.confirm-grant input {
  margin-top: 2px;
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

.confirm-expiry {
  font-size: 12px;
  color: var(--muted);
}

/* 结构化澄清卡（request_clarification）：复用确认卡容器，选项做成可点选按钮。 */
.clarify-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.clarify-opt {
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.clarify-opt:hover {
  border-color: color-mix(in srgb, var(--stop) 45%, var(--line));
  background: color-mix(in srgb, var(--stop) 8%, transparent);
}

.clarify-label {
  font-size: 13px;
  font-weight: 600;
}

.clarify-desc {
  font-size: 12px;
  color: var(--muted);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 澄清契约字段：写明「待定的是哪一项、为什么它会影响答案」，让这一问的必要性可见。 */
.clarify-why {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--muted);
}

.clarify-why__field {
  font-weight: 600;
}

.clarify-why__text {
  white-space: pre-wrap;
  word-break: break-word;
}

/* 自由文本回退：选项都不贴切时可直接补充说明。 */
.clarify-free {
  display: flex;
  gap: 6px;
}

.clarify-free__input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  font: inherit;
  font-size: 13px;
  color: inherit;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 8px;
}

.clarify-free__input:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--stop) 45%, var(--line));
}

.clarify-free__send {
  padding: 6px 10px;
  font-size: 13px;
  color: inherit;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 8px;
  cursor: pointer;
}

.clarify-free__send:disabled {
  opacity: 0.45;
  cursor: default;
}

.thread {
  flex: 1;
  overflow-y: auto;
  /* 窄屏小留白、宽屏渐增，但不再额外叠加内层限宽 */
  padding: 24px clamp(12px, 3vw, 28px) 8px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 0;
}

.empty {
  margin: auto;
  color: var(--muted);
  font-size: 14px;
}

/* 对话区首屏骨架：加载期间占位，避免先闪「想聊点什么？」空态再被真实消息覆盖。 */
.boot-skeleton {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 8px 0;
  /* 骨架是「等久了才出现」的东西，淡入比硬切更不突兀。 */
  animation: skeleton-fade 0.18s ease-out;
}

.boot-skeleton__row {
  height: 44px;
  border-radius: 14px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--ink) 6%, transparent) 25%,
    color-mix(in srgb, var(--ink) 12%, transparent) 37%,
    color-mix(in srgb, var(--ink) 6%, transparent) 63%
  );
  background-size: 400% 100%;
  animation: boot-shimmer 1.4s ease infinite;
}

.boot-skeleton__row--agent {
  width: 62%;
}

.boot-skeleton__row--user {
  width: 48%;
  align-self: flex-end;
}

.boot-skeleton__row--short {
  width: 40%;
}

@keyframes boot-shimmer {
  from {
    background-position: 100% 50%;
  }
  to {
    background-position: 0 50%;
  }
}

/* 骨架整体淡入（与 shimmer 并存，故用逗号并列两个动画）。 */
@keyframes skeleton-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* 对话列：流式全宽（只留响应式内边距），超宽屏也不留大空白 */
.row {
  display: flex;
  width: 100%;
}

.row.user {
  justify-content: flex-end;
}

.row.assistant {
  justify-content: flex-start;
}

/* 气泡 + 其下方操作栏绑成一组：宽度随气泡收缩，操作栏右对齐到气泡右侧，
   故按钮始终落在「气泡下方的右侧」，而非整屏最右。
   布局为流式全宽（.row 不限宽），这里 100% 只防超长内容撑破行。 */
.bubble-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  max-width: 100%;
  min-width: 0;
}

/* 带图表的气泡需要一个「确定宽度」：气泡默认按文字宽度收缩，而图表卡片内部是「百分比 + autoFit」，
   父级宽度不确定时会被反向钳成窄条（实测 159px 的细长图）。
   但也不能直接 100% 撑满对话列——那样正文行宽会被拉到 1249px（正常气泡 338px），
   可读性崩掉、图表还孤零零靠左。这里给一个「够放图、又不拉长正文」的上限，
   卡片一律 width:100% 跟随它（宽度决策只留这一处；保留 align-items: flex-end 让操作栏仍右对齐）。 */
.bubble-wrap.has-chart {
  width: min(100%, 760px);
}

.bubble-wrap.has-chart > .bubble {
  width: 100%;
}

/* 用户气泡：着色 + 不对称圆角（右下收角指向发言方）；
   助手气泡：通透无边框（对齐 ChatGPT/Claude 正文直排风格），代码块/表格自带底色。 */
.bubble {
  position: relative;
  max-width: 100%;
  border: 1px solid transparent;
  border-radius: 18px;
  padding: 10px 14px;
  font-size: 14px;
  line-height: 1.7;
}

.row.user .bubble {
  background: var(--fill-soft);
  border-color: var(--line);
  border-radius: 18px 18px 6px 18px;
}

.row.assistant .bubble {
  background: transparent;
  padding: 4px 2px;
  border-radius: 18px 18px 18px 6px;
}

.plain {
  white-space: pre-wrap;
  word-break: break-word;
}

/* 助手消息正文容器：长无空格串（URL/JSON/代码残留）允许断词，避免横向溢出气泡。 */
.md {
  overflow-wrap: anywhere;
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
  /* 错误串常含无空格的长 URL/JSON/HTML，必须允许断词，否则撑破气泡横向溢出。 */
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* 「已停止生成」徽标：虚线胶囊，弱化展示，不混入正文 */
.stopped-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding: 3px 10px;
  border: 1px dashed var(--line);
  border-radius: 999px;
  background: var(--fill-soft);
  color: var(--muted);
  font-size: 12px;
  user-select: none;
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

/* ✎ 笔尖默认朝右下，水平镜像让笔尖朝左。 */
.flip-x {
  display: inline-block;
  transform: scaleX(-1);
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

.bubble-act--text {
  width: auto;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--accent, #2563eb);
  white-space: nowrap;
}
.bubble-act--text:hover,
.bubble-act--text:focus-visible {
  color: var(--accent, #2563eb);
  background: color-mix(in srgb, var(--accent, #2563eb) 12%, transparent);
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
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  border-radius: 8px;
  background: var(--surface-2);
  font-size: 12.5px;
}

.todos__head {
  margin-bottom: 6px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}

.todos__item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 3px 0;
  line-height: 1.55;
  color: var(--ink-2);
}

.todos__mark {
  flex: none;
  width: 14px;
  text-align: center;
  color: color-mix(in srgb, var(--muted) 70%, transparent);
}

.todos__mark.completed {
  color: var(--success);
}

.todos__mark.in_progress {
  color: var(--accent);
}

.todos__mark.cancelled {
  color: var(--danger);
}

.todos__text.done {
  color: var(--muted);
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--muted) 55%, transparent);
}

/* 推理过程（思考流 + 工具步骤 + 任务计划）内联披露：
   对齐 ChatGPT「Thought for Ns」/ Claude「Thought process」的形态——不再套卡片边框
   （气泡本身已是容器，此前的「盒中盒再套盒」是观感差的主因）；头部收成一行弱化文字，
   展开内容用 2px 左轨缩进表达「这是过程、不是结论」。 */
.reasoning {
  margin: 0 0 10px;
}

.reasoning__head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 3px 8px 3px 2px;
  margin-left: -2px;
  border: none;
  background: transparent;
  border-radius: 6px;
  color: var(--muted);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 18px;
  cursor: pointer;
  text-align: left;
  transition: color 0.15s var(--ease), background-color 0.15s var(--ease);
}

.reasoning__head:hover {
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 5%, transparent);
}

/* 流式中的标题：微光扫过（ChatGPT/Claude「Thinking…」的招牌动效）——
   比 spinner 更轻地传达「正在生成思考」，且不复用 spinner 的品牌色（动效语言分离）。 */
.reasoning__head.is-streaming .reasoning__title {
  background: linear-gradient(
    90deg,
    var(--muted) 38%,
    color-mix(in srgb, var(--ink) 82%, var(--muted)) 50%,
    var(--muted) 62%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: reason-shimmer 2.4s linear infinite;
}

@keyframes reason-shimmer {
  from { background-position: 180% 0; }
  to { background-position: -180% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .reasoning__head.is-streaming .reasoning__title {
    background: none;
    -webkit-text-fill-color: currentColor;
    animation: none;
  }
}

.reasoning__caret {
  flex: none;
  width: 6px;
  height: 6px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg);
  transition: transform 0.2s var(--ease);
}

.reasoning:not(.open) .reasoning__caret {
  transform: rotate(-45deg);
}

.reasoning__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 思考耗时：弱化小字 + 等宽数字（ChatGPT「Thought for Ns」的口径），不给面板添第二種颜色。 */
.reasoning__time {
  flex: none;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

/* 进行中指示：环形转圈。轨道只给 20% 的抓色——整圈同亮度会显得笨重（antd Spin 的处理）。 */
.reasoning__spinner {
  flex: none;
  width: 13px;
  height: 13px;
  border: 1.6px solid color-mix(in srgb, var(--accent) 22%, transparent);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: reason-spin 0.8s linear infinite;
}

@keyframes reason-spin {
  to { transform: rotate(360deg); }
}

/* 展开内容：过程面板——极淡底 + 发丝描边 + 圆角，把「思考流 / 工具步骤 / 任务计划 / 子代理」
   收束成一块「过程区」，与气泡里的「结论正文」形成明确分层
   （对齐 Cursor / Claude Code 的 agent trace：过程成组、结论直排）。 */
.reasoning__body {
  margin: 6px 0 0;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid color-mix(in srgb, var(--line) 55%, transparent);
  border-radius: 10px;
  /* 底色只给「一丝」tint：面板内 todos / 步骤结果 / 子代理卡片是实色 --surface-2，
     面板若压到同一档，嵌套卡片就会融进底里（浅色约 #f7f6f2、深色约 #171716，
     两个主题下 20%+ 的 fill-soft 叠出来都正好落在这一档）。分层交给描边，
     让「有底的卡片」始终是层级里更明显的那一层。 */
  background: color-mix(in srgb, var(--fill-soft) 14%, transparent);
  /* v-show 从 display:none 切回时会重放该动画：展开即有 3px 轻落 + 淡入，
     折叠/展开不再「闪现」，对齐 Cursor 步骤面板的入场手感。 */
  animation: reason-open 0.22s var(--ease);
}

@keyframes reason-open {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .reasoning__body {
    animation: none;
  }
}

/* 规划/思考阶段的状态行：比纯圆点更明确地传达「agent 正在规划」，缓解静默加载的卡顿感。 */
.reasoning__planning {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 状态点对齐到时间轴竖轨（轨中心 5.5px），让「规划中」与思考流 / 步骤落同一竖直栅格。 */
  margin-left: 2.5px;
  padding: 2px 0;
  font-size: 12.5px;
  color: var(--muted);
}

.reasoning__planning-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent);
  animation: reason-pulse 1.6s var(--ease) infinite;
}

@keyframes reason-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent); }
  70% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 0%, transparent); }
  100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent); }
}

/* 意图行：仅当模型显式声明「意图：」才渲染；弱标签改成小药丸 + 正文色。
   替代原「理解意图」高亮卡——它与思考流首行重复、且「取首句」兜底常截出半截话。 */
.intent-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.intent-line__label {
  flex: none;
  margin-top: 2px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  line-height: 15px;
  color: color-mix(in srgb, var(--accent) 80%, var(--ink));
  background: var(--accent-soft);
}

.intent-line__text {
  font-size: 12.8px;
  color: var(--ink-2);
  line-height: 1.6;
}

/* 思考流：与正文同族的无衬线——中文没有像样的等宽族，mono 回退参差是「难看」的另一主因
   （ChatGPT/Claude 的思考文本都用正文字体）；只弱一档对比、不再套灰底描边的小盒子。 */
.reasoning__thinking {
  /* 左轨与正文缩进都对齐步骤时间轴（轨 4.5px、正文 ~21.5px），
     让「思考流 → 工具步骤」在同一竖直栅格上，读起来是一件事的两段而非两个区块。 */
  margin: 0 0 0 4.5px;
  padding: 1px 0 1px 15px;
  max-height: 280px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.65;
  /* 思考流是「过程」而非结论：比正文/步骤名弱一档，但仍保证可读（不用 --muted 那样虚）。 */
  color: color-mix(in srgb, var(--ink) 74%, var(--panel));
  /* 细左轨保留「这是推理过程」的纵向语义（面板内再收一层，不额外套盒子）。
     用 --rail（而非 --line）：深色主题下连接线需要比边框更亮，否则会「断成几个点」。 */
  border-left: 2px solid var(--rail);
  /* 细滚动条：思考流限高内滚，原生宽滚动条在窄面板里喧宾夺主。 */
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 18%, transparent) transparent;
}

.reasoning__thinking::-webkit-scrollbar {
  width: 6px;
}

.reasoning__thinking::-webkit-scrollbar-thumb {
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--ink) 16%, transparent);
}

.reasoning__thinking::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--ink) 26%, transparent);
}

.reasoning__thinking::-webkit-scrollbar-track {
  background: transparent;
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

.composer {
  border-top: 1px solid var(--line);
  padding: 12px clamp(12px, 3vw, 28px) calc(12px + var(--safe-bottom));
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

/* 输入区与上方对话列同宽（流式），只留与 thread 一致的内边距 */
.composer .queue,
.composer .pending,
.composer .warn-line,
.composer-row {
  width: 100%;
}

.composer-row {
  display: flex;
}

/* 输入框外壳（描边/圆角/底纹/聚焦态）在 components/PromptBox.vue，这里只留对话区自己的东西。
   注意：组件要占满这一行，得在外层给宽度（组件内是 width:100%，靠父级 .composer-row 撑开）。 */
.composer-row > :deep(.prompt-box) {
  flex: 1;
  min-width: 0;
}

/* 顶部拖拽把手：上下拖调整高度，双击恢复自动 */
.composer-grip {
  display: flex;
  justify-content: center;
  padding: 5px 0 0;
  cursor: ns-resize;
  user-select: none;
  touch-action: none;
}

.composer-grip__bar {
  width: 36px;
  height: 4px;
  border-radius: 999px;
  background: var(--line);
  transition: background 0.15s ease;
}

.composer-grip:hover .composer-grip__bar,
.composer-grip:focus-visible .composer-grip__bar {
  background: var(--muted);
}

/* textarea 与底部工具条的样式也在 PromptBox 里（min/max 高度由 COMPOSER_BASE / COMPOSER_AUTO_MAX 传入）。 */

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex: none;
  border: none;
  background: transparent;
  color: var(--muted);
  border-radius: 10px;
  padding: 0;
  cursor: pointer;
  transition:
    color 0.15s ease,
    background 0.15s ease;
}

.icon-btn:hover {
  color: var(--ink);
  background: var(--fill-soft);
}

.icon-btn.on {
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 10%, transparent);
}

.icon-btn:focus-visible {
  box-shadow: var(--ring);
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 输入框提示文案（.prompt-hint）与窄屏隐藏规则随组件走，见 components/PromptBox.vue。 */

.send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 推到工具栏最右侧（左侧留给附件/提示，发送按钮固定靠右）。 */
  margin-left: auto;
  width: 34px;
  height: 34px;
  flex: none;
  border: none;
  border-radius: 50%;
  background: var(--ink);
  color: var(--bg);
  padding: 0;
  cursor: pointer;
  transition:
    transform 0.15s var(--ease),
    box-shadow 0.2s ease,
    opacity 0.2s ease,
    background 0.2s ease;
}

/* hover 抬 2px、active 反向压 1px：三态位移分明（原来 hover 1px / active 0 几乎看不出反应）。 */
.send:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 8px 18px color-mix(in srgb, var(--ink) 28%, transparent);
}

.send:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: none;
}

.send:focus-visible {
  box-shadow: var(--ring);
}

.send:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.send.stop {
  background: var(--stop);
  /* 字色跟随面板色：浅色主题近白、深色主题近黑。写死 #fff 时深色主题的 --stop 是浅杏金，
     白字对比只有约 1.8:1（图形几乎糊在一起）；改用 --panel 后两种主题都 ≥ 4.2:1。 */
  color: var(--panel);
  border-radius: 10px;
}

@media (max-width: 860px) {
  /* 侧栏改为离屏抽屉：桌面端可见、移动端滑入（指南 §6 阻断项 #2 / infra 第 16 章反模式）。 */
  .sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: min(82vw, 320px);
    z-index: 60;
    transform: translateX(-100%);
    transition: transform 0.22s ease;
    box-shadow: 0 12px 40px rgb(16 24 40 / 18%);
  }

  .sidebar.open {
    transform: translateX(0);
  }

  /* 移动端抽屉宽度不固定，inner 改为填满抽屉宽度（桌面端固定 256px 防止折叠闪现）。 */
  .sidebar__inner {
    width: 100%;
    padding: 16px 14px;
  }
}

/* 桌面端折叠态：侧栏收起、聊天区占满整屏（汉堡按钮负责重新展开）。 */
@media (min-width: 861px) {
  .sidebar.collapsed {
    flex-basis: 0;
    width: 0;
    padding: 0;
    border-right: none;
    overflow: hidden;
  }
}

/* 抽屉遮罩（仅移动端渲染；桌面端不渲染）。 */
.sidebar-backdrop {
  position: fixed;
  inset: 0;
  background: rgb(16 24 40 / 42%);
  z-index: 50;
}

/* 汉堡按钮：桌面端隐藏，移动端显示（≤860px）。 */
.hamburger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  flex: none;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
  cursor: pointer;
  padding: 0;
}

.hamburger__bar,
.hamburger__bar::before,
.hamburger__bar::after {
  display: block;
  width: 18px;
  height: 2px;
  border-radius: 2px;
  background: var(--ink);
  position: relative;
  content: "";
}

.hamburger__bar::before {
  position: absolute;
  top: -6px;
  left: 0;
}

.hamburger__bar::after {
  position: absolute;
  top: 6px;
  left: 0;
}

@media (max-width: 720px) {
  .top {
    gap: 8px;
    /* 顶部留出刘海屏安全区，避免被状态栏遮挡。 */
    padding: calc(10px + env(safe-area-inset-top, 0px)) 12px 10px;
  }

  .top-actions {
    gap: 6px;
  }

  /* 窄屏收掉顶栏冗余品牌字、收窄模型选择器，防止控件溢出换行。 */
  .top .brand {
    display: none;
  }

  .top :deep(.msel__trigger) {
    min-width: 92px;
    max-width: 132px;
  }

  /* 触摸目标 ≥40px（移动端最佳实践）。 */
  .send,
  .icon-btn {
    width: 40px;
    height: 40px;
  }
}
</style>
