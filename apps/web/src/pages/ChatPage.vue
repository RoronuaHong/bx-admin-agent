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
import ModelSelect from "../components/ModelSelect.vue";
import ToolsSearch from "../components/ToolsSearch.vue";
import ThemeToggle from "../components/ThemeToggle.vue";
import UiLocaleSelect from "../components/UiLocaleSelect.vue";
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
  deleteConversation as apiDeleteConversation,
  duplicateConversation,
  fetchChatMcpServers,
  fetchChatPreferences,
  fetchChatSkills,
  fetchConversations,
  fetchModels,
  fetchMemory,
  fetchWorkspaceFiles,
  getApiErrorToken,
  getApiErrorCode,
  addMemoryItem,
  readWorkspaceFile,
  removeMemoryItem,
  isChatTaskRunning,
  patchConversation,
  reloadMcpServer,
  reorderConversations,
  saveChatPreferences,
  saveConversationMessages,
  setChatMcpServers,
  setChatSkills,
  streamChat,
  uploadFiles,
  MODEL_AUTO_ID,
  type ChatPreferences,
  type ConversationDto,
  type ConvSortMode,
  type McpServerStatus,
  type MemoryItemDto,
  type ModelInfo,
  type PendingMessage,
  type SkillMeta,
  type StoredMessage,
  type UploadResult,
  type WorkspaceFile,
} from "../api";
import type { TodoItem } from "@bx/shared";

/** 侧栏视图：对话列表 / 定时任务。为后续接入定时任务预留结构化入口（占位面板）。 */
const view = ref<"chat" | "tasks">("chat");

/* ===========================================================================
 * 定时任务（前端脚手架）
 * 数据暂存 localStorage，结构对齐真实接口：
 *   { id, name, prompt, scheduleType: 'recurring'|'once',
 *     rrule?, scheduledAt?, mcpServers?, status: 'active'|'paused', createdAt, nextRun? }
 * 接入后端时只需把 load/save 换成 GET/POST /agent/automations。
 * =========================================================================== */
interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  scheduleType: "recurring" | "once";
  rrule?: string;
  scheduledAt?: string;
  /** 任务级 MCP 允许清单：到点运行时只注入这些服务器的工具（无人值守 Agent 的通行最小权限做法）。 */
  mcpServers?: string[];
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
  scheduledAt: "",
  /** 本任务允许使用的 MCP 服务器（空 = 不带任何 MCP 工具运行）。 */
  mcpServers: [] as string[],
});

/** 任务表单里切换某台 MCP 服务器的勾选状态。 */
function toggleTaskServer(id: string) {
  const i = taskDraft.mcpServers.indexOf(id);
  if (i >= 0) taskDraft.mcpServers.splice(i, 1);
  else taskDraft.mcpServers.push(id);
}

/** 任务卡片上的服务器标签文本（服务器列表未加载时诚实显示数量）。 */
function taskServersText(t: ScheduledTask): string {
  const ids = t.mcpServers || [];
  if (!ids.length) return tx("不使用 MCP 工具", "No MCP tools", "Sem ferramentas MCP", "कोई MCP टूल नहीं");
  const labels = ids.map((id) => mcpAvailable.value.find((s) => s.id === id)?.label || id);
  return tx("工具", "Tools", "Ferramentas", "टूल") + "：" + labels.join(tx("、", ", ", ", ", ", "));
}

// ---- 任务表单里 MCP 服务器选择（下拉框，可多选）----
const taskMcpOpen = ref(false);
const taskMcpRoot = ref<HTMLElement | null>(null);
const taskMcpPanel = ref<HTMLElement | null>(null);
const taskMcpPos = reactive({ top: 0, left: 0, width: 0 });

/** 面板 Teleport 到 body 用 fixed 定位：弹窗 overflow:auto 会裁剪 absolute 面板。 */
function updateTaskMcpPos() {
  const el = taskMcpRoot.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  taskMcpPos.top = Math.round(r.bottom + 6);
  taskMcpPos.left = Math.round(r.left);
  taskMcpPos.width = Math.round(r.width);
}

function syncTaskMcpPos() {
  if (taskMcpOpen.value) updateTaskMcpPos();
}

function openTaskMcpPicker() {
  taskMcpOpen.value = true;
  void nextTick(updateTaskMcpPos);
}

function toggleTaskMcp() {
  if (taskMcpOpen.value) taskMcpOpen.value = false;
  else openTaskMcpPicker();
}

/** 点击面板外关闭（面板已 Teleport 到 body，需同时排除触发器与面板本体）。 */
function onOutsideTaskMcp(e: MouseEvent) {
  if (!taskMcpOpen.value) return;
  const t = e.target;
  if (!(t instanceof Node)) return;
  const inTrigger = taskMcpRoot.value?.contains(t) ?? false;
  const inPanel = taskMcpPanel.value?.contains(t) ?? false;
  if (!inTrigger && !inPanel) taskMcpOpen.value = false;
}

/** 友好的重复设置：频率/间隔/周几/时刻，提交时自动拼成 RRULE 字符串。 */
const taskRepeat = reactive({
  freq: "DAILY" as "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY",
  interval: 1,
  byday: ["MO"] as string[],
  time: "09:00",
});

const REPEAT_FREQS: Array<{ code: typeof taskRepeat.freq; zh: string; en: string; pt: string; hi: string; unitZh: string; unitEn: string; unitPt: string; unitHi: string }> = [
  { code: "HOURLY", zh: "每小时", en: "Hourly", pt: "A cada hora", hi: "हर घंटे", unitZh: "小时", unitEn: "hour(s)", unitPt: "hora(s)", unitHi: "घंटे" },
  { code: "DAILY", zh: "每天", en: "Daily", pt: "Diariamente", hi: "हर दिन", unitZh: "天", unitEn: "day(s)", unitPt: "dia(s)", unitHi: "दिन" },
  { code: "WEEKLY", zh: "每周", en: "Weekly", pt: "Semanalmente", hi: "हर सप्ताह", unitZh: "周", unitEn: "week(s)", unitPt: "semana(s)", unitHi: "सप्ताह" },
  { code: "MONTHLY", zh: "每月", en: "Monthly", pt: "Mensalmente", hi: "हर महीने", unitZh: "个月", unitEn: "month(s)", unitPt: "mês(es)", unitHi: "महीने" },
];

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

/** 由友好选项拼出后端可用的 RRULE（BYHOUR/BYMINUTE 对齐系统支持）。 */
function buildRrule(): string {
  const interval = Math.min(99, Math.max(1, Math.floor(taskRepeat.interval || 1)));
  const parts = [`FREQ=${taskRepeat.freq}`, `INTERVAL=${interval}`];
  if (taskRepeat.freq === "WEEKLY" && taskRepeat.byday.length)
    parts.push(`BYDAY=${WEEKDAYS.filter((w) => taskRepeat.byday.includes(w.code)).map((w) => w.code).join(",")}`);
  if (taskRepeat.freq !== "HOURLY") {
    const [h, m] = taskRepeat.time.split(":").map((x) => parseInt(x, 10));
    if (!Number.isNaN(h)) {
      parts.push(`BYHOUR=${h}`);
      if (!Number.isNaN(m)) parts.push(`BYMINUTE=${m}`);
    }
  }
  return parts.join(";");
}

/** 给用户看的纯中文预览，如「每 1 天，于 09:00 执行」。 */
const repeatPreview = computed(() => {
  const n = Math.min(99, Math.max(1, Math.floor(taskRepeat.interval || 1)));
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
  return tx(
    `每 ${n} ${repeatUnit.value}，${taskRepeat.time} 执行`,
    `Every ${n} ${repeatUnit.value} at ${taskRepeat.time}`,
    `A cada ${n} ${repeatUnit.value} às ${taskRepeat.time}`,
    `हर ${n} ${repeatUnit.value}, ${taskRepeat.time} बजे`,
  );
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

function openTaskForm() {
  taskDraft.name = "";
  taskDraft.prompt = "";
  taskDraft.scheduleType = "recurring";
  taskDraft.scheduledAt = "";
  taskRepeat.freq = "DAILY";
  taskRepeat.interval = 1;
  taskRepeat.byday = ["MO"];
  taskRepeat.time = "09:00";
  taskDraft.mcpServers = [];
  dtOpen.value = false;
  taskError.value = "";
  showTaskForm.value = true;
  // 任务表单也要选 MCP：确保可用服务器列表已加载，并按服务端 defaultEnabled 预选。
  void loadMcp().then(() => {
    if (taskDraft.mcpServers.length) return; // 用户已手动勾选过则不覆盖
    taskDraft.mcpServers = mcpAvailable.value.filter((s) => s.defaultEnabled).map((s) => s.id);
  });
}

function closeTaskForm() {
  taskMcpOpen.value = false;
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
  if (!name) return (taskError.value = tx("请填写任务名称", "Name is required", "Informe o nome da tarefa", "कृपया कार्य का नाम दर्ज करें"));
  if (!prompt) return (taskError.value = tx("请填写任务内容", "Task prompt is required", "Informe o conteúdo da tarefa", "कृपया कार्य का विवरण दर्ज करें"));
  if (taskDraft.scheduleType === "once" && !taskDraft.scheduledAt)
    return (taskError.value = tx("请选择执行时间", "Pick a run time", "Escolha o horário de execução", "कृपया निष्पादन समय चुनें"));
  if (taskDraft.scheduleType === "recurring" && taskRepeat.freq === "WEEKLY" && taskRepeat.byday.length === 0)
    return (taskError.value = tx("每周重复请至少选择一天", "Pick at least one weekday", "Selecione ao menos um dia da semana", "कृपया सप्ताह का कम से कम एक दिन चुनें"));
  tasks.value.unshift({
    id: "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    prompt,
    scheduleType: taskDraft.scheduleType,
    rrule: taskDraft.scheduleType === "recurring" ? buildRrule() : undefined,
    scheduledAt: taskDraft.scheduleType === "once" ? taskDraft.scheduledAt : undefined,
    mcpServers: taskDraft.mcpServers.slice(),
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
  if (t.status !== "active") return tx("已暂停", "Paused", "Pausada", "रुका हुआ");
  if (t.scheduleType === "once") {
    if (!t.scheduledAt) return tx("未设置", "Unscheduled", "Sem horário", "समय निर्धारित नहीं");
    return tx("执行于 ", "Runs at ", "Executa em ", "निष्पादन: ") + new Date(t.scheduledAt).toLocaleString();
  }
  return t.nextRun ? tx("下次 ", "Next ", "Próxima ", "अगली: ") + new Date(t.nextRun).toLocaleString() : "—";
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
  /** 子代理（task）实时状态：独立事件维度，随流式进度更新，仅作展示（不落库）。 */
  subagents?: Array<{
    id: string;
    parentId: string;
    description: string;
    status: "running" | "done" | "cancelled" | "error";
    text: string;
  }>;
  /** 扩展思考（thinking 增量拼接，支持思考的模型才有；仅作展示，不回灌模型上下文）。 */
  thinking?: string;
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
  /** 服务端实际使用的模型名（可能因回退/降级与所选不同）。 */
  activeModelLabel: string;
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
    activeModelLabel: "",
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
  if (!q) return conversations.value;
  return conversations.value.filter((c) => matchesFuzzy([c.title], q));
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
const confirmCancelBtn = ref<HTMLElement | null>(null);
let confirmReturnFocus: HTMLElement | null = null;

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

// 打开时锁背景滚动；关闭时恢复。焦点移到「取消」按钮（安全默认项，回车不会误删）。
watch(
  confirmDialog,
  (val) => {
    if (val) {
      document.body.style.overflow = "hidden";
      nextTick(() => confirmCancelBtn.value?.focus());
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
/** 输入框元素引用：用于按内容自动撑高（交互优化）。 */
const inputEl = ref<HTMLTextAreaElement | null>(null);

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
  state.activeModelLabel = models.value.find((m) => m.id === value)?.label || "";
  if (!convId) return;
  try {
    await patchConversation(convId, { model: value });
    syncConvLocal(convId, { model: value });
  } catch (err) {
    state.settings.modelId = prev;
    state.activeModelLabel = models.value.find((m) => m.id === prev)?.label || "";
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

// 意图识别：取思考流首行作为「理解意图」展示（对齐 ReAct 规划首步）。
// 优先识别显式「意图：/Intent:」前缀；模型未用前缀时，兜底取首句（需是简短自然句，
// 避免把代码块/列表行误判为意图）。这样任何 reasoning 模型都能稳定出意图卡，不依赖严格格式。
const INTENT_RE = /^(意图|Intent)\s*[:：]\s*(.+)$/i;
// 标题/列表/代码/大括号/尖括号首行，或括号内的编号行（如「(1) 步骤」），不算意图。
const FILLER_RE = /^[#\-*`{<>]|^\(\d+[.、]\s/;

function intentOf(b: Bubble): string | undefined {
  const t = b.thinking;
  if (!t) return undefined;
  const firstLine = t.split("\n", 1)[0].trim();
  if (!firstLine) return undefined;
  const m = firstLine.match(INTENT_RE);
  if (m) return m[2].trim();
  if (firstLine.length <= 120 && !FILLER_RE.test(firstLine)) return firstLine;
  return undefined;
}

// 去掉首行意图（作为意图卡展示）后的思考流，避免重复；无意图时不剥离。
function thinkingDisplay(b: Bubble): string {
  if (!intentOf(b)) return b.thinking || "";
  const t = b.thinking || "";
  const nl = t.indexOf("\n");
  return nl >= 0 ? t.slice(nl + 1).replace(/^\s*\n/, "") : "";
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

function toStored(list: Bubble[]): StoredMessage[] {
  return list
    .filter((b) => b.text || b.images?.length)
    .map((b) => ({
      role: b.role,
      text: b.text,
      images: b.images,
      // 推理面板相关字段一并落库：刷新后从后端快照恢复，思考过程 / 工具步骤 / 任务规划不丢。
      ...(b.thinking ? { thinking: b.thinking } : {}),
      ...(b.steps?.length ? { steps: b.steps } : {}),
      ...(b.todos?.length ? { todos: b.todos } : {}),
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
  // 仅首次载入时用服务端快照建气泡；已有气泡说明本地状态更新（可能正在流式），不能覆盖。
  if (!state.bubbles.length) {
    state.bubbles = (conv.messages || []).map((m) => ({
      id: ++seq,
      role: m.role,
      text: m.role === "assistant" ? dedupeRepeats(m.text || "") : (m.text || ""),
      images: m.images,
      // 推理面板相关字段恢复（与 toStored 对称）：思考过程 / 工具步骤 / 任务规划。
      ...(m.thinking ? { thinking: m.thinking } : {}),
      ...(Array.isArray(m.steps) && m.steps.length ? { steps: m.steps as ToolStep[] } : {}),
      ...(Array.isArray(m.todos) && m.todos.length ? { todos: m.todos as TodoItem[] } : {}),
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
  queueScroll();
}

async function newConversation() {
  const conv = await createConversation({ title: tx("新对话", "New chat", "Nova conversa", "नई चैट"), agentId: AGENT_ID });
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
const pinnedCount = computed(() => conversations.value.filter((c) => !c.archived && c.pinnedAt).length);

/** 归档项数量（显示归档时用于在归档区前插入分隔线）。 */
const archivedCount = computed(() => conversations.value.filter((c) => c.archived).length);

/** 第一个归档项的下标：归档区固定在列表最末（由 convRank 保证）。 */
const firstArchivedIndex = computed(() => conversations.value.length - archivedCount.value);

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
  try {
    const saved = await uploadFiles(files);
    state.pendingImages.push(...saved);
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

/** 队列容量上限：超过拒绝入队，避免无限堆积。 */
const MAX_QUEUE = 20;

/** 忙时入队（排队语义）：先本地、后落库，失败回滚并提示。 */
async function enqueueMessage(convId: string, text: string, imageIds: string[]) {
  const state = stateOf(convId);
  if (state.queue.length >= MAX_QUEUE) {
    showSettingsError(tx("排队消息已达上限，请先处理队列", "The queue is full; handle it first", "A fila está cheia; resolva-a primeiro", "कतार भरी हुई है; पहले उसे संभालें"));
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
    clarification: null,
    subagents: [],
  });
  state.bubbles.push(reply);
  // 流式开始即展开推理面板：loading 期直接显示「正在规划…」，避免只剩空白/圆点像卡死。
  openReasoning.add(reply.id);
  state.sending = true;
  state.error = "";
  const chosenModel = resolveModel(state.settings.modelId);
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
      // conversationId 显式带上：不依赖服务端的活跃对话回退（多标签页时会串）；agentId 供服务端按角色分流。
      { conversationId: convId, model: chosenModel || undefined, images: imageIds, agentId: AGENT_ID },
      (event) => {
        if (event.type === "text_delta") {
          reply.text += event.text;
          queueScrollIfCurrent(convId);
        } else if (event.type === "text") {
          reply.text = event.text;
        } else if (event.type === "thinking_delta") {
          // 扩展思考增量：拼接进 reasoning 面板，实时展示模型规划过程，取代「正在规划」占位。
          reply.thinking = (reply.thinking || "") + event.text;
          openReasoning.add(reply.id);
          queueScrollIfCurrent(convId);
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
            expiresInMs: event.expiresInMs,
          };
          queueScrollIfCurrent(convId);
        } else if (event.type === "clarification_response") {
          reply.clarification = null;
        } else if (event.type === "error") {
          const message = localizeToken(uiLocale.value, event.error, event.message || "GENERIC_UNKNOWN_ERROR");
          reply.error = message;
          state.error = message;
        } else if (event.type === "todos") {
          // 任务规划（write_todos）：挂到当前回复气泡上，随执行推进状态。
          reply.todos = event.todos;
          openReasoning.add(reply.id);
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
          // 收束时清理模型回声式重复（只改内存展示，不改落库文本）。
          reply.text = dedupeRepeats(reply.text);
          reply.streaming = false;
          openReasoning.delete(reply.id);
          // 本轮成功：记下来实际用到的具体模型，供「自动」模式下次优先复用（哪个能用用哪个）。
          if (!reply.error) lastGoodModelId.value = chosenModel;
        }
      },
      controller.signal,
    );
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      stopped = true;
      reply.text = reply.text ? `${reply.text}\n\n${tx("（已停止生成）", " (stopped)", " (geração interrompida)", " (उत्पादन रोक दिया गया)")}` : tx("（已停止生成）", "(stopped)", "(geração interrompida)", "(उत्पादन रोक दिया गया)");
    } else if (getApiErrorCode(err) === "CONVERSATION_BUSY") {
      // 服务端并发保护（如另一标签页在跑）：消息不丢，进队列等下一轮自动发。
      queued = true;
      reply.text = tx("（该对话正在生成中，此消息已加入待发队列）", "(Chat is busy; the message was queued)", "(A conversa está ocupada; a mensagem entrou na fila)", "(चैट व्यस्त है; संदेश कतार में जोड़ दिया गया)");
      await enqueueMessage(convId, text, imageIds);
    } else {
      // 连接类错误（断网/刷新/代理断开）：执行与推送已解耦，后台任务可能仍在跑。
      // 查一次任务状态：还在跑 → 如实告知「后台继续，稍后刷新可见」，不要误报为生成失败。
      const backgroundRunning = await isChatTaskRunning(convId).catch(() => false);
      if (backgroundRunning) {
        reply.text = tx(
          "（连接已中断，生成仍在后台继续；完成后重新打开该对话即可看到结果）",
          "(Connection lost; generation continues in the background — reopen this conversation to see the result)",
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
    reply.streaming = false;
  } finally {
    state.sending = false;
    state.controller = null;
    // auto 模式：本轮失败则把该模型记入黑名单（下次解析跳过），成功则清除其失败标记。
    // 仅「真正出错」计入——用户主动停止 / 对话繁忙 / 后台继续 都不算模型不可用。
    if (reply.error) failedModelIds.value.add(chosenModel);
    else failedModelIds.value.delete(chosenModel);
    // 显式带上 convId：此刻用户可能已经切到别的对话，不能写错对话。
    await persist(convId, state.bubbles);
    queueScrollIfCurrent(convId);
    // 出队决策：停止 / 出错 / 已再入队 / 仍有待确认 → 停下等用户，不自动发下一条。
    void drainQueue(convId, !stopped && !queued && !reply.error && !reply.pending);
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
  await runTurn(convId, item.text, item.images || []);
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
 * 应答结构化澄清：选中某个选项即把选项值回传；不带值 = 跳过（模型按自己的理解继续）。
 * 与确认卡共用票据通道（一次性 + 会话绑定），失效处理口径一致。
 */
async function answerClarification(bubble: Bubble, value?: string) {
  const ask = bubble.clarification;
  if (!ask) return;
  bubble.clarification = null;
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
  if (!convId) return;
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
  if (!convId) return;
  const prev = state.settings.mcpEnabled;
  const next = on ? [...new Set([...prev, id])] : prev.filter((item) => item !== id);
  state.settings.mcpEnabled = next;
  mcpBusy.value = true;
  mcpError.value = "";
  if (!on && mcpExpanded.value === id) mcpExpanded.value = "";
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
  if (!convId) return;
  const prev = state.settings.mcpEnabled;
  state.settings.mcpEnabled = [];
  mcpBusy.value = true;
  mcpError.value = "";
  mcpExpanded.value = "";
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
    await loadMcp(convId);
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
 * 行内连接状态展示：按「当前对话是否启用」感知，而不是直接透出服务端连接池状态。
 * 连接池是服务端进程级共享（其它对话建的连、空闲回收期内都活着），与当前对话的启用集无关；
 * 直接透出会出现「复选框没勾却显示已连接」的自相矛盾。未启用的一律显示「未启用」，
 * 工具数仍保留展示（那是服务器能力信息，不随对话变）。
 */
function mcpRowState(s: McpServerStatus): { cls: string; text: string } {
  if (!current.value.settings.mcpEnabled.includes(s.id)) {
    return { cls: "idle", text: tx("未启用", "not enabled", "não ativado", "सक्षम नहीं") };
  }
  if (s.connected) return { cls: "ok", text: tx("已连接", "connected", "conectado", "कनेक्टेड") };
  if (s.connecting) return { cls: "running", text: tx("连接中", "connecting", "conectando", "कनेक्ट हो रहा है") };
  if (s.error) return { cls: "err", text: tx("失败", "failed", "falhou", "विफल") };
  return { cls: "idle", text: tx("未连接", "not connected", "não conectado", "कनेक्ट नहीं") };
}

// ---- 技能面板（与 MCP 面板同构：列表全局、启用集按对话持久化）----
const skillOpen = ref(false);
const skillAvailable = ref<SkillMeta[]>([]);
const skillBusy = ref(false);
const skillError = ref("");

async function loadSkills(convId = currentId.value) {
  const data = await fetchChatSkills(convId).catch(() => null);
  if (!data) return;
  skillAvailable.value = data.available;
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
  if (!convId || skillBusy.value) return;
  const state = stateOf(convId);
  const prev = state.settings.skillsEnabled;
  const next = on ? [...prev, dir] : prev.filter((x) => x !== dir);
  state.settings.skillsEnabled = next;
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
  if (!convId) return;
  const state = stateOf(convId);
  const prev = state.settings.skillsEnabled;
  state.settings.skillsEnabled = [];
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

function stepClass(status: ToolStep["status"]): string {
  if (status === "ok") return "ok";
  if (status === "error" || status === "cancelled") return "err";
  return "running";
}

function stepStatusText(status: ToolStep["status"]): string {
  if (status === "ok") return tx("已完成", "done", "concluído", "पूर्ण");
  if (status === "error") return tx("失败", "failed", "falhou", "विफल");
  if (status === "cancelled") return tx("已拒绝", "denied", "recusado", "अस्वीकृत");
  return tx("执行中", "running", "executando", "चल रहा है");
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

/** 首屏要打开的对话（来自后端 preferences；迁移时可能来自旧本地键）。 */
let initialConversationId = "";
let activeReportTimer: ReturnType<typeof setTimeout> | null = null;

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
  window.addEventListener("mousedown", onOutsideRes);
  window.addEventListener("mousedown", onOutsideDt);
  window.addEventListener("keydown", onCtxEscape);
  // scroll 不冒泡：用捕获阶段才能收到 .conv-list 自身的滚动。
  window.addEventListener("scroll", onCtxDismiss, true);
  window.addEventListener("resize", onCtxDismiss);
  // 日期面板 Teleport 到 body：弹窗滚动/窗口缩放时跟随输入框重算位置。
  window.addEventListener("scroll", syncDtPos, true);
  window.addEventListener("resize", syncDtPos);
  // 任务表单 MCP 下拉框：Teleport 到 body 后，弹窗滚动/窗口缩放时跟随触发器重算位置。
  window.addEventListener("mousedown", onOutsideTaskMcp);
  window.addEventListener("scroll", syncTaskMcpPos, true);
  window.addEventListener("resize", syncTaskMcpPos);
  // 窗口缩放改变输入框换行宽度，高度需重算。
  window.addEventListener("resize", onWindowResizeGrow);
  window.addEventListener("resize", updateIsMobile);

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
  const target = list.find((c) => c.id === initialConversationId) || list[0];
  if (target) selectConversation(target);
  else await newConversation();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onSidebarEsc);
  window.removeEventListener("mousedown", onOutsideTools);
  window.removeEventListener("keydown", onEscTools);
  window.removeEventListener("mousedown", onOutsideRes);
  window.removeEventListener("mousedown", onOutsideDt);
  window.removeEventListener("keydown", onCtxEscape);
  window.removeEventListener("scroll", onCtxDismiss, true);
  window.removeEventListener("resize", onCtxDismiss);
  window.removeEventListener("scroll", syncDtPos, true);
  window.removeEventListener("resize", syncDtPos);
  window.removeEventListener("mousedown", onOutsideTaskMcp);
  window.removeEventListener("scroll", syncTaskMcpPos, true);
  window.removeEventListener("resize", syncTaskMcpPos);
  window.removeEventListener("resize", onWindowResizeGrow);
  window.removeEventListener("resize", updateIsMobile);
  // 离开页面时把还没到点的删除落实，避免撤销窗口内的删除被永久搁置。
  flushPendingDelete();
});
</script>

<template>
  <div class="chat" @click="closeCtxMenu()">
    <aside class="sidebar" :class="{ open: sidebarOpen, collapsed: sidebarCollapsed }" :aria-label="tx('会话列表', 'Conversations', 'Conversas', 'चैट सूची')">
      <div class="brand">
        <span class="brand__name">{{ AGENT_LABEL || tx("小助手", "Assistant", "Assistente", "सहायक") }}</span>
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
      <nav class="nav" :aria-label="tx('主导航', 'Primary', 'Navegação principal', 'मुख्य नेविगेशन')">
        <button
          type="button"
          class="nav-seg"
          :class="{ active: view === 'chat' }"
          :aria-current="view === 'chat' ? 'page' : undefined"
          @click="view = 'chat'"
        >{{ tx("对话", "Chats", "Conversas", "चैट") }}</button>
        <button
          type="button"
          class="nav-seg"
          :class="{ active: view === 'tasks' }"
          :aria-current="view === 'tasks' ? 'page' : undefined"
          @click="view = 'tasks'"
        >{{ tx("定时任务", "Scheduled", "Agendados", "अनुसूचित कार्य") }}</button>
      </nav>
      <template v-if="view === 'chat'">
      <button class="new-chat" type="button" @click="newConversation">
        + {{ tx("新对话", "New chat", "Nova conversa", "नई चैट") }}
      </button>
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
      </div>
      <p v-if="convQuery.trim() && !conversationsFiltered.length" class="conv-empty">
        {{ tx("没有匹配的对话", "No matching chats", "Nenhuma conversa correspondente", "कोई मेल खाने वाली चैट नहीं") }}
      </p>
      <button
        class="ghost-btn"
        :class="{ 'ghost-btn-danger': clearArmedFor === currentId }"
        type="button"
        @click="onClearCurrentClick"
      >
        {{
          clearArmedFor === currentId
            ? tx("确认清空（不可恢复）", "Confirm clear (can't be undone)", "Confirmar limpeza (irreversível)", "खाली करने की पुष्टि (अपरिवर्तनीय)")
            : tx("清空当前对话", "Clear current chat", "Limpar conversa atual", "वर्तमान चैट खाली करें")
        }}
      </button>
      </template>
      <template v-else>
        <div class="tasks">
          <div class="tasks-head">
            <span class="tasks-head__label">{{ tx("定时任务", "Scheduled tasks", "Tarefas agendadas", "अनुसूचित कार्य") }}</span>
            <button v-if="tasks.length" class="primary-btn" type="button" @click="openTaskForm">
              + {{ tx("新建", "New", "Novo", "नया") }}
            </button>
          </div>
          <div v-if="!tasks.length" class="tasks-empty">
            <div class="tasks-empty__card">
              <span class="tasks-empty__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="5" width="18" height="16" rx="3" />
                  <path d="M8 3v4M16 3v4M3 10h18" />
                  <circle cx="12" cy="15.5" r="2.6" />
                  <path d="M12 14.3v1.2l.9.6" />
                </svg>
              </span>
              <div class="tasks-empty__title">{{ tx("还没有定时任务", "No scheduled tasks yet", "Nenhuma tarefa agendada ainda", "अभी कोई अनुसूचित कार्य नहीं") }}</div>
              <p class="tasks-empty__desc">{{ tx("把周期性的查询、监控与报告交给智能体，到点自动执行并把结果送到对话里。", "Let the assistant run recurring queries, monitors and reports on schedule, with results delivered to your chats.", "Deixe o assistente executar consultas, monitoramentos e relatórios recorrentes, com resultados entregues às suas conversas no horário.", "आवधिक क्वेरी, मॉनिटर और रिपोर्ट सहायक को सौंपें; समय पर स्वतः निष्पादित होकर परिणाम आपकी चैट में पहुँचेंगे।") }}</p>
              <div class="tasks-empty__chips">
                <span class="tasks-empty__chip">{{ tx("周期查询", "Recurring queries", "Consultas recorrentes", "आवधिक क्वेरी") }}</span>
                <span class="tasks-empty__chip">{{ tx("定时监控", "Monitors", "Monitoramentos", "मॉनिटर") }}</span>
                <span class="tasks-empty__chip">{{ tx("自动报告", "Reports", "Relatórios", "रिपोर्ट") }}</span>
              </div>
              <button class="primary-btn tasks-empty__cta" type="button" @click="openTaskForm">
                + {{ tx("新建定时任务", "New scheduled task", "Nova tarefa agendada", "नया अनुसूचित कार्य") }}
              </button>
            </div>
          </div>
          <div v-else class="task-list">
            <div v-for="t in tasks" :key="t.id" class="task-card">
              <div class="task-card__main">
                <div class="task-card__title">{{ t.name }}</div>
                <div class="task-card__prompt">{{ t.prompt }}</div>
                <div class="task-card__meta">
                  <span class="task-badge" :class="t.scheduleType">{{ t.scheduleType === 'once' ? tx('一次性', 'Once', 'Única', 'एक बार') : tx('周期', 'Recurring', 'Recorrente', 'आवधिक') }}</span>
                  <span class="task-next">{{ taskNextRunText(t) }}</span>
                </div>
                <div class="task-card__srv">{{ taskServersText(t) }}</div>
              </div>
              <div class="task-card__ops">
                <button
                  class="task-toggle"
                  type="button"
                  :class="{ on: t.status === 'active' }"
                  role="switch"
                  :aria-checked="t.status === 'active'"
                  :title="t.status === 'active' ? tx('暂停', 'Pause', 'Pausar', 'रोकें') : tx('启用', 'Enable', 'Ativar', 'सक्रिय करें')"
                  @click="toggleTask(t.id)"
                ><span class="task-toggle__knob"></span></button>
                <button class="task-del" type="button" :title="tx('删除', 'Delete', 'Excluir', 'हटाएं')" @click="removeTask(t.id)">×</button>
              </div>
            </div>
          </div>
        </div>
      </template>
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
            <button type="button" class="ghost-btn" ref="confirmCancelBtn" @click="closeConfirm">
              {{ tx("取消", "Cancel", "Cancelar", "रद्द करें") }}
            </button>
            <button
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
      <div v-if="showTaskForm" class="modal-mask" @click.self="closeTaskForm">
        <div class="modal" role="dialog" aria-modal="true" :aria-label="tx('新建定时任务', 'New scheduled task', 'Nova tarefa agendada', 'नया अनुसूचित कार्य')">
          <div class="modal__head">
            <span class="modal__title">{{ tx("新建定时任务", "New scheduled task", "Nova tarefa agendada", "नया अनुसूचित कार्य") }}</span>
            <button class="modal__close" type="button" aria-label="Close" @click="closeTaskForm">×</button>
          </div>
          <div class="modal__body">
            <label class="field">
              <span class="field__label">{{ tx("名称", "Name", "Nome", "नाम") }}</span>
              <input class="field__input" v-model="taskDraft.name" :placeholder="tx('例如：每日流量日报', 'e.g. Daily traffic report', 'Ex.: relatório diário de tráfego', 'उदा. दैनिक ट्रैफ़िक रिपोर्ट')" />
            </label>
            <label class="field">
              <span class="field__label">{{ tx("任务内容", "Task prompt", "Conteúdo da tarefa", "कार्य निर्देश") }}</span>
              <textarea class="field__input field__textarea" v-model="taskDraft.prompt" rows="3" :placeholder="tx('智能体要自动执行的自然语言指令…', 'Natural-language instruction for the agent…', 'Instrução em linguagem natural para o agente executar…', 'एजेंट के लिए स्वतः निष्पादित होने वाला प्राकृतिक-भाषा निर्देश…')"></textarea>
            </label>
            <div class="field">
              <span class="field__label">{{ tx("MCP 工具（到点运行时可用）", "MCP tools (available at run time)", "Ferramentas MCP (disponíveis na execução)", "MCP टूल (रन के समय उपलब्ध)") }}</span>
              <div ref="taskMcpRoot" class="mcp-select">
                <button
                  type="button"
                  class="mcp-select__trigger"
                  :class="{ open: taskMcpOpen }"
                  :aria-expanded="taskMcpOpen"
                  @click="toggleTaskMcp()"
                >
                  <span v-if="taskDraft.mcpServers.length" class="mcp-select__chips">
                    <span v-for="id in taskDraft.mcpServers" :key="id" class="mcp-select__chip">{{
                      mcpAvailable.find((s) => s.id === id)?.label || id
                    }}</span>
                  </span>
                  <span v-else class="mcp-select__placeholder">{{
                    tx("选择 MCP 服务器（可多选）", "Choose MCP servers (multi)", "Escolher servidores MCP (múltiplo)", "MCP सर्वर चुनें (बहु-चयन)")
                  }}</span>
                  <span class="mcp-select__caret" :class="{ flip: taskMcpOpen }" aria-hidden="true">▾</span>
                </button>
                <Teleport to="body">
                  <div
                    v-if="taskMcpOpen"
                    ref="taskMcpPanel"
                    class="mcp-select__panel"
                    :style="{ top: taskMcpPos.top + 'px', left: taskMcpPos.left + 'px', width: taskMcpPos.width + 'px' }"
                    role="listbox"
                    aria-multiselectable="true"
                  >
                    <button
                      v-for="s in mcpAvailable"
                      :key="s.id"
                      type="button"
                      class="mcp-select__opt"
                      :class="{ active: taskDraft.mcpServers.includes(s.id) }"
                      role="option"
                      :aria-selected="taskDraft.mcpServers.includes(s.id)"
                      @click="toggleTaskServer(s.id)"
                    >
                      <span class="mcp-dot" :class="s.connected ? 'ok' : 'idle'" aria-hidden="true"></span>
                      <span class="mcp-select__opt-label">{{ s.label }}</span>
                      <span class="mcp-select__opt-sub"
                        >{{ s.tools }} {{ tx("工具", "tools", "ferramentas", "टूल") }}<template
                          v-if="!s.connected"
                          >· {{ tx("未连接", "not connected", "não conectado", "कनेक्ट नहीं") }}</template
                        ></span
                      >
                      <span v-if="taskDraft.mcpServers.includes(s.id)" class="mcp-select__check" aria-hidden="true">✓</span>
                    </button>
                    <p v-if="!mcpAvailable.length" class="mcp-select__empty">
                      {{ tx("暂无可用 MCP 服务器", "No MCP servers available", "Nenhum servidor MCP disponível", "कोई MCP सर्वर उपलब्ध नहीं") }}
                    </p>
                  </div>
                </Teleport>
              </div>
              <p class="repeat-preview">{{ tx("不勾选则不带任何 MCP 工具运行；写操作到点运行时仍按风险策略确认。", "Leave unchecked to run without MCP tools; write actions at run time still follow the risk policy.", "Deixe desmarcado para executar sem ferramentas MCP; ações de escrita na execução ainda seguem a política de risco.", "अनचेक छोड़ें तो MCP टूल के बिना चलेगा; रन के समय राइट एक्शन जोखिम नीति का पालन करेंगे।") }}</p>
            </div>
            <div class="field">
              <span class="field__label">{{ tx("频率", "Schedule", "Agendamento", "शेड्यूल") }}</span>
              <div class="seg">
                <button type="button" class="seg__btn" :class="{ active: taskDraft.scheduleType === 'recurring' }" @click="taskDraft.scheduleType = 'recurring'">{{ tx("周期", "Recurring", "Recorrente", "आवधिक") }}</button>
                <button type="button" class="seg__btn" :class="{ active: taskDraft.scheduleType === 'once' }" @click="taskDraft.scheduleType = 'once'">{{ tx("一次性", "Once", "Única", "एक बार") }}</button>
              </div>
            </div>
            <template v-if="taskDraft.scheduleType === 'recurring'">
              <div class="field">
                <span class="field__label">{{ tx("重复频率", "Repeat", "Repetição", "दोहराव") }}</span>
                <div class="seg">
                  <button
                    v-for="f in REPEAT_FREQS"
                    :key="f.code"
                    type="button"
                    class="seg__btn"
                    :class="{ active: taskRepeat.freq === f.code }"
                    @click="taskRepeat.freq = f.code"
                  >{{ tx(f.zh, f.en, f.pt, f.hi) }}</button>
                </div>
              </div>
              <div class="field">
                <span class="field__label">{{ tx("间隔", "Interval", "Intervalo", "अंतराल") }}</span>
                <div class="repeat-row">
                  <span class="repeat-text">{{ tx("每", "Every", "A cada", "हर") }}</span>
                  <input
                    class="field__input repeat-num"
                    type="number"
                    min="1"
                    max="99"
                    v-model.number="taskRepeat.interval"
                  />
                  <span class="repeat-text">{{ repeatUnit }}</span>
                </div>
              </div>
              <div v-if="taskRepeat.freq === 'WEEKLY'" class="field">
                <span class="field__label">{{ tx("选择星期", "Weekdays", "Dias da semana", "सप्ताह के दिन") }}</span>
                <div class="repeat-row">
                  <button
                    v-for="w in WEEKDAYS"
                    :key="w.code"
                    type="button"
                    class="wd-chip"
                    :class="{ active: taskRepeat.byday.includes(w.code) }"
                    @click="toggleWeekday(w.code)"
                  >{{ tx(w.zh, w.en, w.pt, w.hi) }}</button>
                </div>
              </div>
              <label v-if="taskRepeat.freq !== 'HOURLY'" class="field">
                <span class="field__label">{{ tx("执行时刻", "Run at", "Horário", "समय") }}</span>
                <input class="field__input" type="time" v-model="taskRepeat.time" />
              </label>
              <p class="repeat-preview">{{ repeatPreview }}</p>
            </template>
            <div v-else class="field">
              <span class="field__label">{{ tx("执行时间", "Run at", "Data e hora", "समय") }}</span>
              <div ref="dtRoot" class="dt">
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
            </div>
            <p v-if="taskError" class="field__error">{{ taskError }}</p>
          </div>
          <div class="modal__foot">
            <button class="ghost-btn" type="button" @click="closeTaskForm">{{ tx("取消", "Cancel", "Cancelar", "रद्द करें") }}</button>
            <button class="primary-btn" type="button" @click="createTask">{{ tx("创建", "Create", "Criar", "बनाएं") }}</button>
          </div>
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
          <span
            v-if="current.activeModelLabel && current.activeModelLabel !== selectedModelLabel"
            class="model-tag"
          >
            {{ current.activeModelLabel }}
          </span>
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
                  @keydown.enter.prevent="addMemoryEntry"
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
                <button
                  v-for="f in wsFiles"
                  :key="f.path"
                  class="res-file"
                  type="button"
                  @click="openWorkspaceFile(f.path)"
                >
                  <span class="res-row__text">{{ f.path }}</span>
                  <span class="mcp-row__sub">{{ formatBytes(f.bytes) }}</span>
                </button>
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

      <div ref="threadEl" class="thread">
        <div v-if="!current.bubbles.length" class="empty">
          {{ tx("想聊点什么？", "Want to chat about something?", "Quer conversar sobre algo?", "कुछ बात करना चाहते हैं?") }}
        </div>
        <div v-for="b in current.bubbles" :key="b.id" class="row" :class="b.role">
          <div class="bubble-wrap">
          <div class="bubble">
            <div
              v-if="b.todos?.length || b.steps?.length || b.subagents?.length || hasThinking(b) || (b.streaming && !b.text)"
              class="reasoning"
              :class="{ open: openReasoning.has(b.id) }"
            >
              <button class="reasoning__head" type="button" @click="toggleReasoning(b.id)">
                <span class="reasoning__icon" aria-hidden="true"><span class="reasoning__caret"></span></span>
                <span class="reasoning__title">{{ reasoningTitle(b) }}</span>
                <span v-if="b.streaming && hasRunningStep(b)" class="reasoning__spinner" aria-hidden="true"></span>
              </button>
              <div v-show="openReasoning.has(b.id)" class="reasoning__body">
                <!-- 意图识别卡：模型首行「意图：…」结构化高亮，区别于后续裸思考流（对齐 ReAct 规划首步）。 -->
                <div v-if="intentOf(b)" class="intent-card">
                  <span class="intent-card__label">{{ tx("理解意图", "Intent", "Intenção", "इरादा") }}</span>
                  <span class="intent-card__text">{{ intentOf(b) }}</span>
                </div>
                <!-- 扩展思考流：实时展示模型规划过程，取代静默的「正在规划」占位（已剥离首行意图标记）。 -->
                <div v-if="thinkingDisplay(b)" class="reasoning__thinking-wrap">
                  <pre class="reasoning__thinking">{{ thinkingDisplay(b) }}</pre>
                </div>
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
                      :aria-expanded="step.result ? openSteps.has(stepKey(b, step)) : null"
                      :aria-controls="step.result ? `step-result-${step.id}` : null"
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
                      <span class="mcp-dot" :class="sa.status === 'running' ? 'running' : sa.status === 'error' ? 'error' : 'ok'"></span>
                      <span class="subagent__desc">{{ sa.description }}</span>
                      <span class="subagent__status">{{ sa.status === 'running' ? tx('运行中', 'running', 'rodando', 'चल रहा') : sa.status === 'done' ? tx('完成', 'done', 'concluído', 'पूर्ण') : sa.status === 'cancelled' ? tx('已取消', 'cancelled', 'cancelado', 'रद्द') : tx('失败', 'failed', 'falhou', 'विफल') }}</span>
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
              type="button"
              class="bubble-act"
              :title="tx('复制', 'Copy', 'Copiar', 'कॉपी करें')"
              :aria-label="tx('复制', 'Copy', 'Copiar', 'कॉपी करें')"
              @click="copyBubble(b)"
            >⧉</button>
          </div>
          </div>
        </div>
      </div>

      <footer class="composer">
        <div v-if="current.queue.length" class="queue" role="region" :aria-label="tx('待发队列', 'Message queue', 'Fila de envio', 'प्रेषण कतार')">
          <div class="queue__head">
            <span>{{ tx("排队中", "Queued", "Na fila", "कतार में") }} · {{ current.queue.length }}</span>
            <span class="queue__hint">{{ tx("生成结束后按序自动发送", "Sent in order after the current reply", "Enviadas em ordem após a resposta atual", "वर्तमान उत्तर के बाद क्रम से स्वतः भेजा जाएगा") }}</span>
          </div>
          <div v-for="(item, i) in current.queue" :key="item.at" class="queue__item">
            <span class="queue__text">{{ item.text || tx("（仅图片）", "(images only)", "(apenas imagens)", "(केवल छवियाँ)") }}</span>
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
            accept="image/*"
            multiple
            hidden
            @change="pickFiles"
          />
          <div class="composer-box">
            <div
              class="composer-grip"
              :title="tx('拖拽调整输入框高度，双击恢复自动', 'Drag to resize the input, double-click to reset', 'Arraste para redimensionar a entrada; duplo clique para restaurar', 'इनपुट का आकार बदलने के लिए खींचें; स्वतः बहाल करने के लिए डबल-क्लिक करें')"
              @mousedown.prevent="startComposerResize"
              @dblclick="resetComposerSize"
            >
              <span class="composer-grip__bar"></span>
            </div>
            <textarea
              id="chat-input"
              ref="inputEl"
              v-model="current.input"
              class="input"
              name="message"
              rows="1"
              :placeholder="tx('输入消息…', 'Type a message…', 'Digite uma mensagem…', 'संदेश लिखें…')"
              @input="autoGrow"
              @keydown="onKeydown"
            ></textarea>
            <div class="composer-bar">
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

                <!-- 已选专家 chip（对齐 CodeBuddy）：选中专家后显示在 + 旁，点 × 取消选中回通用；无 chip = 通用。 -->
                <button
                  v-if="currentExpert"
                  type="button"
                  class="expert-chip"
                  :title="tx('取消选中助手，回到通用助手', 'Deselect assistant, back to general assistant', 'Desmarcar assistente, voltar ao assistente geral', 'सहायक चयन रद्द करें, सामान्य सहायक पर वापस')"
                  @click="onClearExpert"
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                  <span>{{ agentText(currentExpert.label, uiLocale) }}</span>
                </button>

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
                    <span v-if="current.settings.mcpEnabled.length" class="tools-badge">{{ current.settings.mcpEnabled.length }}</span>
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
                          : tx("还没有可用的技能（服务端 skills 目录为空）", "No skills available yet", "Nenhuma habilidade disponível", "कोई स्किल उपलब्ध नहीं")
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
                        <svg v-if="current.settings.mcpEnabled.includes(s.id)" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <path d="m5 12.5 4.5 4.5L19 7.5" />
                        </svg>
                      </button>
                      <span class="tools-item__ops">
                        <button
                          v-if="s.toolNames.length"
                          class="mcp-mini"
                          type="button"
                          :title="tx('工具清单', 'Tool list', 'Lista de ferramentas', 'टूल सूची')"
                          @click.stop="mcpExpanded = mcpExpanded === s.id ? '' : s.id"
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
                      :disabled="!current.settings.mcpEnabled.length || mcpBusy"
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
              <span class="composer-hint">{{ tx("Enter 发送 · Shift+Enter 换行", "Enter to send · Shift+Enter for a new line", "Enter envia · Shift+Enter nova linha", "भेजने के लिए Enter · नई पंक्ति के लिए Shift+Enter") }}</span>
              <button
                v-if="current.sending"
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
            </div>
          </div>
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
  /* 桌面端折叠时平滑收起（移动端媒体查询会改用 transform 过渡）。 */
  transition:
    flex-basis 0.2s ease,
    width 0.2s ease;
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

/* 定时任务面板（为后续接入预留结构与入口） */
.tasks {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.tasks-empty {
  flex: 1;
  width: 100%;
  display: flex;
  padding: 6px 0 14px;
}

.tasks-empty__card {
  margin: auto;
  width: 100%;
  padding: 26px 18px 22px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
  border: 1px dashed color-mix(in srgb, var(--ink) 24%, var(--line));
  border-radius: var(--radius-lg);
  background:
    radial-gradient(130% 90% at 50% 0%, color-mix(in srgb, var(--fill-soft) 60%, transparent), transparent 72%),
    var(--panel);
}

.tasks-empty__icon {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 54px;
  height: 54px;
  margin-bottom: 8px;
  border-radius: 16px;
  background: var(--fill-soft);
  color: color-mix(in srgb, var(--stop) 78%, var(--ink));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 9%, transparent);
}

/* 图标右下角的小时刻点缀 */
.tasks-empty__icon::after {
  content: "";
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--stop);
  box-shadow: 0 0 0 3px var(--panel);
}

.tasks-empty__title {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
  color: var(--ink);
}

.tasks-empty__desc {
  max-width: 250px;
  margin: 0;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--muted);
}

.tasks-empty__chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  margin-top: 8px;
}

.tasks-empty__chip {
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--line);
  background: var(--fill);
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted);
}

.tasks-empty__cta {
  margin-top: 14px;
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

/* 定时任务：头部与列表 */
.tasks-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 2px 10px;
}

.tasks-head__label {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--muted);
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
  line-clamp: 2;
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

/* 任务允许的 MCP 服务器（最小权限允许清单的可见化） */
.task-card__srv {
  margin-top: 5px;
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.repeat-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.repeat-num {
  width: 76px;
  flex: none;
  text-align: center;
}

.repeat-text {
  font-size: 13px;
  color: var(--muted);
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

.repeat-preview {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  background: var(--fill-soft);
  border-radius: var(--radius);
  padding: 8px 11px;
}

/* MCP 服务器选择下拉框（antd Select 风格，可多选） */
.mcp-select {
  position: relative;
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
  width: 340px;
  max-width: min(340px, calc(100vw - 48px));
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
}

/* 窄屏：飞出改为在菜单上方展开，避免右侧越界 */
@media (max-width: 620px) {
  .tools-flyout {
    left: 0;
    bottom: calc(100% + 8px);
    width: min(340px, calc(100vw - 32px));
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
  align-items: flex-start;
  gap: 10px;
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
  padding: 4px 10px;
  border: 1px solid var(--border, #d5dae2);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  color: var(--ink);
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.expert-chip:hover {
  background: color-mix(in srgb, var(--ink) 10%, transparent);
  border-color: color-mix(in srgb, var(--ink) 25%, transparent);
}

.expert-chip svg {
  color: var(--muted, #8a93a3);
  flex: none;
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
  margin-top: 6px;
  color: var(--ink);
}

.tools-item__ops {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
  margin-top: 2px;
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
  gap: 2px;
  margin-bottom: 0;
}

/* 竖轨只在 ≥2 步时出现（单步没有「连接」语义，画线反而多余）。 */
.steps:has(.step + .step)::before {
  content: "";
  position: absolute;
  left: 4.5px;
  top: 15px;
  bottom: 15px;
  width: 1px;
  background: var(--rail);
}

.step {
  position: relative;
  padding: 5px 0 6px 18px;
  border-radius: 6px;
}

/* 步骤行头：有结果时整行可点开（对齐 antd Collapse：默认收起、收起时给一行摘要、点开看全文）。
   无结果的步骤同一结构但 disabled —— 一半的样式与键盘可达性都走原生 button，不用 div 模拟。 */
.step-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 -6px;
  padding: 0 6px;
  min-height: 20px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  border-radius: 6px;
  transition: background-color 0.2s var(--ease);
}

button.step-head {
  cursor: pointer;
}

button.step-head:not(:disabled):hover {
  background: color-mix(in srgb, var(--ink) 4%, transparent);
}

button.step-head:disabled {
  cursor: default;
}

/* 时间轴节点：绝对定位落在竖轨上（中心 4.5px = 轨道位置）。
   注意不要给 .step-head 加 position —— 它一旦成为定位祖先，节点就会跟着行头跑偏。 */
.step-head .mcp-dot {
  position: absolute;
  left: 0;
  top: 10px;
  width: 9px;
  height: 9px;
}

.step-name {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 46%;
  font-family: var(--font-mono);
  font-size: 12px;
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
}

/* 展开指示：收起指向右、展开指向下（与外层推理面板同一个语汇）。 */
.step-caret {
  flex: none;
  width: 6px;
  height: 6px;
  border-right: 1.4px solid color-mix(in srgb, var(--muted) 85%, transparent);
  border-bottom: 1.4px solid color-mix(in srgb, var(--muted) 85%, transparent);
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
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--line) 85%, transparent);
  border-radius: 5px;
  background: color-mix(in srgb, var(--fill-soft) 65%, transparent);
  color: var(--muted);
  font-size: 10.5px;
  line-height: 16px;
}

.step-status {
  flex: none;
  margin-left: auto;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 10.5px;
  line-height: 17px;
  color: var(--muted);
  background: color-mix(in srgb, var(--ink) 6%, transparent);
}

/* 状态药丸配色：只上语义色，不染整块（状态值由模板给的 stepClass 落到 .step 上）。 */
.step.running .step-status {
  color: color-mix(in srgb, var(--accent) 82%, var(--ink));
  background: var(--accent-soft);
}

.step.ok .step-status {
  color: color-mix(in srgb, var(--success) 72%, var(--ink));
  background: var(--success-soft);
}

.step.err .step-status {
  color: color-mix(in srgb, var(--danger) 78%, var(--ink));
  background: var(--danger-soft);
}

.step-result {
  margin: 6px 0 0;
  max-height: 200px;
  overflow: auto;
  background: var(--surface-2);
  border: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  border-radius: 8px;
  padding: 8px 10px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.6;
  color: color-mix(in srgb, var(--ink) 80%, var(--panel));
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

/* 状态药丸与步骤共用同一套语义配色，保证「过程面板」里所有状态读起来是一套语言。 */
.subagent__status {
  flex: none;
  margin-left: auto;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 10.5px;
  line-height: 17px;
  color: var(--muted);
  background: color-mix(in srgb, var(--ink) 6%, transparent);
}

.subagent.running .subagent__status {
  color: color-mix(in srgb, var(--accent) 82%, var(--ink));
  background: var(--accent-soft);
}

.subagent.done .subagent__status {
  color: color-mix(in srgb, var(--success) 72%, var(--ink));
  background: var(--success-soft);
}

.subagent.error .subagent__status {
  color: color-mix(in srgb, var(--danger) 78%, var(--ink));
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

/* 推理过程（任务计划 + 工具步骤）折叠：生成中展开、收束后折叠，避免长过程刷屏。 */
.reasoning {
  margin: 0 0 10px;
  border: 1px solid color-mix(in srgb, var(--line) 85%, transparent);
  /* 左侧强调轨：把「系统/agent 过程块」与正文气泡区分开（对齐 Claude 推理块）。
     用 3px 整值——2.5px 在圆角处会出现毛边。 */
  border-left: 3px solid color-mix(in srgb, var(--accent) 62%, var(--line));
  border-radius: 10px;
  /* 实色表面：原来 50% 半透明 fill-soft 叠在气泡上，会随底色漂成不定值的脏灰。 */
  background: var(--panel);
  overflow: hidden;
  transition: box-shadow 0.2s var(--ease);
}

/* 展开时给一层极浅的抬升：过程区与正文的边界更清楚（力度对齐 antd 卡片的克制程度）。 */
.reasoning.open {
  box-shadow: 0 1px 2px color-mix(in srgb, var(--ink) 5%, transparent);
}

.reasoning__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 12px;
  border: none;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 82%, var(--panel));
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: -0.005em;
  line-height: 18px;
  cursor: pointer;
  text-align: left;
  transition: color 0.2s var(--ease), background-color 0.2s var(--ease);
}

.reasoning__head:hover {
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 4%, transparent);
}

/* 展开后表头与内容之间拉一条分隔线（antd Collapse 的做法），省掉一层底色也足够清楚。 */
.reasoning.open .reasoning__head {
  border-bottom: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
}

/* 图标芯片：承载 chevron，给面板一点「卡片」质感（对齐 Notion/Claude 的披露控件）。 */
.reasoning__icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 6px;
  background: var(--accent-soft);
  color: color-mix(in srgb, var(--accent) 78%, var(--ink));
}

.reasoning__caret {
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
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.reasoning__body {
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 规划/思考阶段的状态行：比纯圆点更明确地传达「agent 正在规划」，缓解静默加载的卡顿感。 */
.reasoning__planning {
  display: flex;
  align-items: center;
  gap: 8px;
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

/* 扩展思考流：等宽、弱对比、可滚动，区分于正式正文；收束后随面板折叠（不刷屏）。 */
.reasoning__thinking-wrap {
  margin: 0;
}

/* 意图识别卡：把模型首行「意图：…」高亮成结构化块，区别于后续裸思考流（对齐 ReAct 规划首步）。
   不再加左侧色条——外层过程块已有强调轨，再套一条会变成「线中套线」。 */
.intent-card {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  padding: 8px 10px;
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent);
  border-radius: 8px;
}

.intent-card__label {
  flex: none;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: color-mix(in srgb, var(--accent) 82%, var(--ink));
  text-transform: uppercase;
}

.intent-card__text {
  font-size: 12.5px;
  color: var(--ink-2);
  line-height: 1.55;
}

.reasoning__thinking {
  margin: 0;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  /* 原来写的是 var(--mono, …)：本仓 token 名是 --font-mono，--mono 不存在，
     等于一直在吃系统字体 fallback（与代码块/步骤名的字体不一致）。 */
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.65;
  /* 思考流是「过程」而非结论：比正文/步骤名弱一档，但仍保证可读（不用 --muted 那样虚）。 */
  color: color-mix(in srgb, var(--ink) 74%, var(--panel));
  background: var(--surface-2);
  border: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  border-radius: 8px;
  padding: 10px 12px;
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

/* 卡片式输入区：聚焦时整卡描边，内部元素全部无边框 */
.composer-box {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--fill);
  transition:
    border-color 0.15s ease,
    box-shadow 0.2s ease;
}

.composer-box:focus-within {
  border-color: color-mix(in srgb, var(--ink) 55%, var(--line));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ink) 10%, transparent);
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

.input {
  width: 100%;
  resize: none;
  min-height: 74px; /* 与 COMPOSER_BASE 一致：空/少量输入时固定高度 */
  max-height: 420px;
  border: none;
  padding: 6px 14px 4px;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.5;
}

.input:focus,
.input:focus-visible {
  outline: none;
  border: none;
  box-shadow: none;
}

/* 底部工具栏：左侧附件、右侧快捷键提示 + 圆形发送按钮 */
.composer-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 8px;
}

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

.composer-hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--muted);
  opacity: 0.75;
  user-select: none;
}

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
  .model-tag {
    display: none;
  }

  .composer-hint {
    display: none;
  }

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
