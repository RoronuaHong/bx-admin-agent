<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { useRoute, RouterLink } from "vue-router";
import {
  analyticsUploadUrl,
  askAnalytics,
  createAnalyticsConversation,
  deleteAnalyticsConversation,
  fetchAnalyticsConversations,
  fetchAnalyticsModels,
  getAnalyticsScanJob,
  getApiErrorToken,
  listAnalyticsScanJobs,
  runAnalyticsScan,
  saveAnalyticsConversationMessages,
  submitAnalyticsFeedback,
  uploadAnalyticsFiles,
  type AnalyticsAskResult,
  type AnalyticsAskTable,
  type AnalyticsScanJob,
  type ModelInfo,
  type StoredMessage,
  type UploadResult,
} from "../api";
import AgentChromeNav from "../components/AgentChromeNav.vue";
import AnalyticsCapabilitiesHelp from "../components/AnalyticsCapabilitiesHelp.vue";
import ChatShell from "../components/ChatShell.vue";
import ResultTable from "../components/ResultTable.vue";
import ThemeToggle from "../components/ThemeToggle.vue";
import UiLocaleSelect from "../components/UiLocaleSelect.vue";
import { resizeComposerBox, startComposerResizeDrag } from "../chat-composer";
import { renderChatMarkdown } from "../chat-richtext";
import {
  displayConversationTitleForLocale,
  isDefaultConversationTitle,
  newConversationId,
  readModelCache,
  writeModelCache,
} from "../chat-storage";
import { createTabMenuPosition, type TabMenuState } from "../chat-tab-menu";
import { copyText } from "../clipboard";
import { bindCustomScrollbar } from "../custom-scrollbar";
import { localizeToken } from "../localize";
import type { ChartView, TableView } from "../types";
import { enrichTableView } from "../table-columns";
import { getUiLocale } from "../ui-locale";
import { buildClarifyContinuation } from "../analytics-clarify";

const ResultChart = defineAsyncComponent(() => import("../components/ResultChart.vue"));

type BubbleRole = "user" | "assistant";

type AnalyticsBubble = {
  id: string;
  role: BubbleRole;
  text: string;
  status?: AnalyticsAskResult["status"];
  timeEcho?: string;
  tables?: AnalyticsAskTable[];
  sqls?: string[];
  probeSummary?: string;
  clarifySlot?: string;
  clarifyOptions?: Array<{ id: string; label: string }>;
  error?: string;
  pending?: boolean;
  welcome?: boolean;
  cancelled?: boolean;
  images?: Array<{ id: string; name: string }>;
  files?: Array<{ id: string; name: string }>;
  askId?: string;
  modelId?: string;
  packVersion?: string;
  userNl?: string;
  feedback?: "useful" | "wrong";
  charts?: ChartView[];
};

type AnalyticsConversation = {
  id: string;
  title: string;
  messages: AnalyticsBubble[];
  createdAt: number;
  updatedAt: number;
};

const STORAGE_KEY = "bx-analytics-conversations-v1";
/** 与后台 Agent 共用模型偏好，切换 Agent 后模型选择一致 */
const MODEL_CACHE_KEY = "bx-admin-agent-model-v1";
const ACTIVE_KEY = "bx-analytics-active-conv-v1";

const route = useRoute();
const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

const renderMarkdown = renderChatMarkdown;

const WELCOME_EXAMPLES = [
  {
    zh: "八月二十到二十一印度A按天观看人数",
    en: "viewers by day for India A from Aug 20–21",
    pt: "visualizadores por dia India A de 20–21 ago",
    hi: "भारत A 20–21 अगस्त दैनिक व्यूअर्स",
  },
  {
    zh: "最近7天各渠道观看人数",
    en: "viewers by channel for the last 7 days",
    pt: "visualizadores por canal nos ultimos 7 dias",
    hi: "पिछले 7 दिनों में चैनल अनुसार व्यूअर्स",
  },
  {
    zh: "昨天印度A和印度B对比观看人数",
    en: "compare India A vs India B viewers yesterday",
    pt: "compare visualizadores India A vs India B ontem",
    hi: "कल भारत A बनाम भारत B व्यूअर्स की तुलना",
  },
  {
    zh: "本周FoxA按语言观看人数",
    en: "viewers by language for Fox A this week",
    pt: "visualizadores por idioma Fox A nesta semana",
    hi: "इस सप्ताह Fox A भाषा अनुसार व्यूअर्स",
  },
] as const;

function pickWelcomeText(): string {
  const example = WELCOME_EXAMPLES[Math.floor(Math.random() * WELCOME_EXAMPLES.length)]!;
  const ex = (locale: "zh" | "en" | "pt" | "hi") => example[locale];
  const variants = [
    () =>
      tx(
        `你好，我是数据分析 Agent。用自然语言问数即可，结果来自 Metabase。尽量写明日期或时间范围，例如：「${ex("zh")}」。`,
        `Hi, I'm the Analytics Agent. Ask in natural language — results come from Metabase. Prefer an explicit date or range, e.g. “${ex("en")}”.`,
        `Ola, sou o Agent de Analise. Pergunte em linguagem natural — resultados do Metabase. Prefira data ou intervalo, ex.: ${ex("pt")}.`,
        `नमस्ते, मैं एनालिटिक्स एजेंट हूँ। प्राकृतिक भाषा में पूछें — परिणाम Metabase से। स्पष्ट तिथि दें, जैसे ${ex("hi")}।`,
      ),
    () =>
      tx(
        `嗨，我是数据分析 Agent。直接用中文描述指标与范围就行，数据走 Metabase。试试：「${ex("zh")}」。`,
        `Hey — Analytics Agent here. Describe the metric and time window in plain language; data comes from Metabase. Try: “${ex("en")}”.`,
        `Oi — Agent de Analise aqui. Descreva metrica e periodo em linguagem natural; dados do Metabase. Experimente: ${ex("pt")}.`,
        `नमस्ते — एनालिटिक्स एजेंट। मेट्रिक और समय सीमा साधारण भाषा में बताएं; डेटा Metabase से। कोशिश करें: ${ex("hi")}।`,
      ),
    () =>
      tx(
        `欢迎使用数据分析 Agent。问数请带上日期或时间范围，避免口径模糊。示例：「${ex("zh")}」。`,
        `Welcome to the Analytics Agent. Include a date or range so the metric scope is clear. Example: “${ex("en")}”.`,
        `Bem-vindo ao Agent de Analise. Inclua data ou intervalo para deixar o escopo claro. Exemplo: ${ex("pt")}.`,
        `एनालिटिक्स एजेंट में आपका स्वागत है। स्पष्ट तिथि/अवधि लिखें। उदाहरण: ${ex("hi")}।`,
      ),
    () =>
      tx(
        `我可以帮你查 Metabase 指标。把渠道、维度和日期写清楚会更准，比如：「${ex("zh")}」。`,
        `I can pull Metabase metrics for you. Naming channel, dimension, and dates helps — e.g. “${ex("en")}”.`,
        `Posso buscar metricas no Metabase. Nomear canal, dimensao e datas ajuda — ex.: ${ex("pt")}.`,
        `मैं Metabase से मेट्रिक ला सकता हूँ। चैनल, आयाम और तिथि साफ़ लिखें — जैसे ${ex("hi")}।`,
      ),
  ];
  return variants[Math.floor(Math.random() * variants.length)]!();
}

function welcomeBubble(): AnalyticsBubble {
  return {
    id: "welcome",
    role: "assistant",
    welcome: true,
    text: pickWelcomeText(),
  };
}

function defaultConversationTitle() {
  return tx("新对话", "New Chat", "Novo Chat", "नई चैट");
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function blankConversation(): AnalyticsConversation {
  const now = Date.now();
  return {
    id: newConversationId(),
    title: defaultConversationTitle(),
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

const STORE_TABLE_ROWS = 80;
const MAX_REMOTE_CONVERSATIONS = 20;
const MAX_REMOTE_MESSAGES = 80;

function settleStalePending(m: AnalyticsBubble): AnalyticsBubble {
  if (!m.pending) return m;
  return {
    ...m,
    pending: false,
    cancelled: true,
    text: "",
  };
}

function bubbleToStored(m: AnalyticsBubble): StoredMessage | null {
  if (m.pending || m.welcome) return null;
  return {
    id: m.id,
    role: m.role,
    text: m.text || "",
    status: m.status,
    timeEcho: m.timeEcho,
    tables: m.tables?.map((t) => ({
      ...t,
      rows: Array.isArray(t.rows) ? t.rows.slice(0, STORE_TABLE_ROWS) : t.rows,
    })),
    sqls: m.sqls,
    probeSummary: m.probeSummary,
    clarifySlot: m.clarifySlot,
    error: m.error,
    cancelled: m.cancelled,
    images: m.images,
    files: m.files,
    askId: m.askId,
    modelId: m.modelId,
    packVersion: m.packVersion,
    userNl: m.userNl,
    feedback: m.feedback,
    charts: m.charts,
  };
}

function storedToBubble(m: StoredMessage, fallbackId: string): AnalyticsBubble {
  return {
    id: m.id != null ? String(m.id) : fallbackId,
    role: m.role === "user" || m.role === "assistant" ? m.role : "assistant",
    text: m.text || "",
    status: m.status as AnalyticsAskResult["status"] | undefined,
    timeEcho: m.timeEcho,
    tables: m.tables as AnalyticsAskTable[] | undefined,
    sqls: m.sqls,
    probeSummary: m.probeSummary,
    clarifySlot: m.clarifySlot,
    error: m.error,
    cancelled: m.cancelled,
    images: m.images,
    files: m.files as AnalyticsBubble["files"],
    askId: m.askId,
    modelId: m.modelId,
    packVersion: m.packVersion,
    userNl: m.userNl,
    feedback: m.feedback === "useful" || m.feedback === "wrong" ? m.feedback : undefined,
    charts: m.charts as ChartView[] | undefined,
    welcome: m.welcome,
    pending: false,
  };
}

function slimAnalyticsBubble(m: AnalyticsBubble): AnalyticsBubble {
  const settled = settleStalePending(m);
  if (!settled.tables?.length) return settled;
  return {
    ...settled,
    tables: settled.tables.map((t) => ({
      ...t,
      rows: Array.isArray(t.rows) ? t.rows.slice(0, STORE_TABLE_ROWS) : t.rows,
    })),
  };
}

function slimAnalyticsConversations(list: AnalyticsConversation[]): AnalyticsConversation[] {
  return list.map((c) => ({
    ...c,
    messages: c.messages.map(slimAnalyticsBubble).filter(
      (m) =>
        m.welcome ||
        m.role === "user" ||
        Boolean(m.text?.trim()) ||
        Boolean(m.tables?.length) ||
        Boolean(m.sqls?.length) ||
        Boolean(m.images?.length) ||
        Boolean(m.files?.length) ||
        Boolean(m.error) ||
        Boolean(m.cancelled),
    ),
  }));
}

function loadConversationsFromStorage(): { list: AnalyticsConversation[]; activeId: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as AnalyticsConversation[]) : [];
    const list = Array.isArray(parsed)
      ? slimAnalyticsConversations(
          parsed.filter((c) => c && typeof c.id === "string" && Array.isArray(c.messages)),
        )
      : [];
    const savedActive = localStorage.getItem(ACTIVE_KEY) || "";
    if (!list.length) return { list: [], activeId: "" };
    const activeId = list.some((c) => c.id === savedActive) ? savedActive : list[0]!.id;
    return { list, activeId };
  } catch {
    return { list: [], activeId: "" };
  }
}

const conversations = ref<AnalyticsConversation[]>([]);
const activeId = ref("");
let suppressConversationSave = false;
const deletedConversationIds = new Set<string>();

function cacheLocally() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slimAnalyticsConversations(conversations.value)));
    localStorage.setItem(ACTIVE_KEY, activeId.value);
  } catch {
    /* ignore quota */
  }
}

function persistConversationRemote(id: string, messages: AnalyticsBubble[], title?: string) {
  if (deletedConversationIds.has(id)) return;
  const stored = messages.map(bubbleToStored).filter((m): m is StoredMessage => Boolean(m));
  saveAnalyticsConversationMessages(id, stored, title)
    .then(() => {
      if (deletedConversationIds.has(id)) {
        deleteAnalyticsConversation(id).catch(() => {});
      }
    })
    .catch(() => {
      /* network fail: local cache remains */
    });
}

function saveConversations() {
  if (suppressConversationSave) {
    cacheLocally();
    return;
  }
  const slim = slimAnalyticsConversations(conversations.value).filter(
    (c) => !deletedConversationIds.has(c.id),
  );
  cacheLocally();
  for (const c of slim) {
    persistConversationRemote(c.id, c.messages, c.title);
  }
}

async function restoreConversations() {
  const local = loadConversationsFromStorage();
  if (local.list.length) {
    conversations.value = local.list;
    activeId.value = local.activeId || local.list[0]!.id;
  }

  try {
    const remote = await fetchAnalyticsConversations();
    if (!remote.length) {
      if (!conversations.value.length) ensureBlankConversation(true);
      return;
    }
    const convs: AnalyticsConversation[] = remote
      .filter((c) => c && c.id && !deletedConversationIds.has(c.id))
      .slice(0, MAX_REMOTE_CONVERSATIONS)
      .map((c) => ({
        id: c.id,
        title: displayConversationTitleOf(c),
        messages: (c.messages || [])
          .filter((m) => m && (m.role === "user" || m.role === "assistant"))
          .slice(-MAX_REMOTE_MESSAGES)
          .map((m, i) => storedToBubble(m, `${c.id}_${i}`)),
        createdAt: c.createdAt || 0,
        updatedAt: c.updatedAt || 0,
      }));
    if (convs.length) {
      conversations.value = convs;
      activeId.value = convs.some((c) => c.id === local.activeId) ? local.activeId : convs[0]!.id;
      cacheLocally();
    } else if (!conversations.value.length) {
      ensureBlankConversation(true);
    }
  } catch {
    if (!conversations.value.length) ensureBlankConversation(true);
  }
}

const shellRef = ref<{ threadEl: HTMLElement | null } | null>(null);
const threadTrackEl = ref<HTMLElement | null>(null);
const threadThumbEl = ref<HTMLElement | null>(null);
const input = ref("");
const sending = ref(false);
const composerInput = ref<HTMLTextAreaElement | null>(null);
const composerH = ref<number | null>(null);
const scrollTop = ref(0);
const copiedId = ref<string | null>(null);
const copiedSqlKey = ref<string | null>(null);
const helpOpen = ref(false);
const activeController = ref<AbortController | null>(null);
let threadScrollbarCleanup: (() => void) | null = null;

const activeConversation = computed(
  () => conversations.value.find((c) => c.id === activeId.value) || conversations.value[0],
);

const messages = computed(() => {
  const list = activeConversation.value?.messages || [];
  return list.length ? list : [welcomeBubble()];
});

const hasUserMessages = computed(() =>
  (activeConversation.value?.messages || []).some((m) => m.role === "user" && !m.welcome),
);

function displayConversationTitleOf(conv: { title?: string | null }) {
  return displayConversationTitleForLocale(conv.title, defaultConversationTitle(), uiLocale.value);
}

function touchConversation(convId: string, mutator: (conv: AnalyticsConversation) => void) {
  const idx = conversations.value.findIndex((c) => c.id === convId);
  if (idx < 0) return;
  const next = { ...conversations.value[idx], messages: [...conversations.value[idx].messages] };
  mutator(next);
  next.updatedAt = Date.now();
  const copy = [...conversations.value];
  copy[idx] = next;
  conversations.value = copy;
  saveConversations();
}

function touchActive(mutator: (conv: AnalyticsConversation) => void) {
  touchConversation(activeId.value, mutator);
}

function resizeComposer() {
  resizeComposerBox(composerInput, composerH);
}

function startComposerDrag(e: PointerEvent | MouseEvent | TouchEvent) {
  startComposerResizeDrag({
    event: e,
    composerInput,
    composerHeight: composerH,
    resizeComposer,
  });
}

const scanOpen = ref(false);
const scanDryRun = ref(false);
const scanRunning = ref(false);
const scanJobs = shallowRef<AnalyticsScanJob[]>([]);
const scanError = ref("");
const scanNote = ref("");
const scanRefreshing = ref(false);

function toTableView(table: AnalyticsAskTable): TableView {
  const columns = table.cols.map((col) => ({ key: col, title: col }));
  const rows = table.rows.map((row) => {
    const out: Record<string, string> = {};
    for (let i = 0; i < table.cols.length; i += 1) {
      const key = table.cols[i];
      const raw = row[i];
      out[key] = raw == null ? "" : String(raw);
    }
    return out;
  });
  return enrichTableView({
    title: table.grain ? `${table.title} · ${table.grain}` : table.title,
    total: rows.length,
    columns,
    rows,
  });
}

function formatRequestError(err: unknown): string {
  const token = getApiErrorToken(err);
  if (token) return localizeToken(uiLocale.value, token, "GENERIC_UNKNOWN_ERROR");
  return err instanceof Error ? err.message : tx("请求失败", "Request failed");
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

function jobStatusLabel(status: AnalyticsScanJob["status"]): string {
  switch (status) {
    case "queued":
      return tx("排队中", "Queued");
    case "running":
      return tx("运行中", "Running");
    case "succeeded":
      return tx("成功", "Succeeded");
    case "partial":
      return tx("部分成功", "Partial");
    case "failed":
      return tx("失败", "Failed");
    case "cancelled":
      return tx("已取消", "Cancelled");
    case "skipped":
      return tx("已跳过", "Skipped");
    default:
      return status;
  }
}

function jobSummary(job: AnalyticsScanJob): string {
  const s = job.resultSummary;
  if (s?.skippedReason) return String(s.skippedReason);
  const parts: string[] = [];
  if (typeof s?.criticalCount === "number") parts.push(`critical=${s.criticalCount}`);
  if (typeof s?.warnCount === "number") parts.push(`warn=${s.warnCount}`);
  if (typeof s?.entityCount === "number") parts.push(`entities=${s.entityCount}`);
  const parent = (job.alerts || []).find((a) => a.parent) || job.alerts?.[0];
  if (parent) {
    const sev = parent.severity ? `[${parent.severity}] ` : "";
    parts.push(`${sev}${parent.message}`);
  } else if (job.errorMessage) {
    parts.push(job.errorMessage);
  }
  return parts.join(" · ") || (job.status === "running" || job.status === "queued"
    ? tx("执行中…", "In progress…")
    : "—");
}

function jobSeverity(job: AnalyticsScanJob): "critical" | "warn" | "ok" | "idle" {
  if (job.status === "failed" || job.status === "cancelled") return "critical";
  const s = job.resultSummary;
  if ((s?.criticalCount ?? 0) > 0) return "critical";
  if ((s?.warnCount ?? 0) > 0) return "warn";
  if (job.status === "succeeded" || job.status === "partial") return "ok";
  return "idle";
}

function shortJobId(jobId: string): string {
  return jobId.length > 12 ? `${jobId.slice(0, 8)}…` : jobId;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrollBottom() {
  await nextTick();
  const el = shellRef.value?.threadEl;
  if (el) el.scrollTop = el.scrollHeight;
}

function scrollToTop() {
  const el = shellRef.value?.threadEl;
  if (el) el.scrollTo({ top: 0, behavior: "smooth" });
}

function onThreadScroll() {
  scrollTop.value = shellRef.value?.threadEl?.scrollTop ?? 0;
}

let scanPollEpoch = 0;

async function refreshScanJobs() {
  scanRefreshing.value = true;
  scanError.value = "";
  try {
    scanJobs.value = await listAnalyticsScanJobs(10);
  } catch (err) {
    scanError.value = formatRequestError(err);
  } finally {
    scanRefreshing.value = false;
  }
}

async function pollScanJob(jobId: string) {
  const epoch = ++scanPollEpoch;
  const terminal = new Set(["succeeded", "partial", "failed", "cancelled", "skipped"]);
  for (let i = 0; i < 48; i += 1) {
    if (epoch !== scanPollEpoch || !scanOpen.value) return;
    await sleep(i === 0 ? 600 : 2500);
    if (epoch !== scanPollEpoch || !scanOpen.value) return;
    try {
      const job = await getAnalyticsScanJob(jobId);
      scanJobs.value = [job, ...scanJobs.value.filter((j) => j.jobId !== jobId)].slice(0, 10);
      if (terminal.has(job.status)) {
        scanNote.value = tx(
          `巡检${jobStatusLabel(job.status)} · ${job.scanDate}`,
          `Scan ${job.status} · ${job.scanDate}`,
        );
        return;
      }
    } catch {
      /* keep polling */
    }
  }
  if (epoch !== scanPollEpoch || !scanOpen.value) return;
  scanNote.value = tx(
    "巡检仍在后台执行，可点「刷新」查看最新状态。",
    "Scan is still running in the background — tap Refresh for the latest status.",
  );
  await refreshScanJobs();
}

async function runScan() {
  if (scanRunning.value) return;
  scanRunning.value = true;
  scanError.value = "";
  scanNote.value = "";
  try {
    const { jobId } = await runAnalyticsScan({
      ruleSetId: "watch-users",
      dryRun: scanDryRun.value,
    });
    scanNote.value = tx(`已入队 ${shortJobId(jobId)}`, `Queued ${shortJobId(jobId)}`);
    scanJobs.value = [
      {
        jobId,
        ruleSetId: "watch-users",
        scanDate: "—",
        status: "queued",
        dryRun: scanDryRun.value,
        forceRerun: false,
        rerunSeq: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      ...scanJobs.value.filter((j) => j.jobId !== jobId),
    ].slice(0, 10);
    await pollScanJob(jobId);
  } catch (err) {
    scanError.value = formatRequestError(err);
    void refreshScanJobs();
  } finally {
    scanRunning.value = false;
  }
}

function openScan() {
  modelMenuOpen.value = false;
  scanOpen.value = true;
}

function closeScan() {
  scanPollEpoch += 1;
  scanOpen.value = false;
}

function onScanKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape") closeScan();
}

watch(scanOpen, (open) => {
  if (open) {
    scanError.value = "";
    scanNote.value = "";
    void refreshScanJobs();
    window.addEventListener("keydown", onScanKeydown);
  } else {
    window.removeEventListener("keydown", onScanKeydown);
  }
});

function newConversation() {
  if (sending.value) cancelSend();
  const conv = blankConversation();
  conversations.value = [...conversations.value, conv];
  activeId.value = conv.id;
  saveConversations();
  createAnalyticsConversation({ id: conv.id, title: conv.title }).catch(() => {});
  input.value = "";
  composerH.value = null;
  document.documentElement.style.setProperty("--composer-max", "");
  nextTick(() => {
    resizeComposer();
    scrollBottom();
    composerInput.value?.focus();
  });
}

function switchConversation(id: string) {
  if (id === activeId.value) return;
  hideTabMenu();
  if (sending.value) cancelSend();
  activeId.value = id;
  cacheLocally();
  nextTick(() => {
    resizeComposer();
    scrollBottom();
  });
}

const tabMenu = ref<TabMenuState | null>(null);

function hideTabMenu() {
  tabMenu.value = null;
}

function openTabMenu(ev: MouseEvent, convId: string, idx: number) {
  tabMenu.value = { convId, idx, ...createTabMenuPosition(ev) };
}

function ensureBlankConversation(createRemote = false) {
  const conv = blankConversation();
  conversations.value = [...conversations.value, conv];
  activeId.value = conv.id;
  if (createRemote) {
    createAnalyticsConversation({ id: conv.id, title: conv.title }).catch(() => {});
    cacheLocally();
  }
}

function closeConversations(ids: string[], keepId?: string) {
  if (!ids.length) {
    hideTabMenu();
    return;
  }
  const idSet = new Set(ids);
  if (sending.value && idSet.has(activeId.value)) cancelSend();
  suppressConversationSave = true;
  for (const id of ids) {
    deletedConversationIds.add(id);
    deleteAnalyticsConversation(id).catch(() => {});
  }
  const prevActive = activeId.value;
  const prevIdx = conversations.value.findIndex((c) => c.id === prevActive);
  conversations.value = conversations.value.filter((c) => !idSet.has(c.id));
  if (keepId && conversations.value.some((c) => c.id === keepId)) {
    activeId.value = keepId;
  } else if (!conversations.value.length) {
    ensureBlankConversation(true);
  } else if (idSet.has(prevActive)) {
    const next = conversations.value[Math.min(Math.max(prevIdx, 0), conversations.value.length - 1)];
    activeId.value = next!.id;
  }
  suppressConversationSave = false;
  cacheLocally();
  hideTabMenu();
  nextTick(scrollBottom);
}

function closeConversation(id: string) {
  closeConversations([id]);
}

function closeOtherConversations(id: string) {
  closeConversations(
    conversations.value.filter((c) => c.id !== id).map((c) => c.id),
    id,
  );
}

function closeLeftConversations(id: string) {
  const idx = conversations.value.findIndex((c) => c.id === id);
  if (idx <= 0) {
    hideTabMenu();
    return;
  }
  closeConversations(
    conversations.value.slice(0, idx).map((c) => c.id),
    id,
  );
}

function closeRightConversations(id: string) {
  const idx = conversations.value.findIndex((c) => c.id === id);
  if (idx < 0 || idx >= conversations.value.length - 1) {
    hideTabMenu();
    return;
  }
  closeConversations(
    conversations.value.slice(idx + 1).map((c) => c.id),
    id,
  );
}

function closeAllConversations() {
  closeConversations(conversations.value.map((c) => c.id));
}

function onClearContext() {
  if (sending.value) return;
  touchActive((conv) => {
    conv.messages = [];
    conv.title = defaultConversationTitle();
  });
  input.value = "";
  composerH.value = null;
  document.documentElement.style.setProperty("--composer-max", "");
  nextTick(() => {
    resizeComposer();
    scrollBottom();
  });
}

function useHelpExample(text: string) {
  input.value = text;
  composerH.value = null;
  document.documentElement.style.setProperty("--composer-max", "");
  nextTick(() => {
    resizeComposer();
    composerInput.value?.focus();
    composerInput.value?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

async function copyBody(item: AnalyticsBubble) {
  if (!item.text) return;
  const ok = await copyText(item.text);
  if (ok) {
    copiedId.value = item.id;
    setTimeout(() => {
      if (copiedId.value === item.id) copiedId.value = null;
    }, 1200);
  } else {
    alert(
      tx(
        "复制失败：当前浏览器环境不允许访问剪贴板，请手动选中文本复制。",
        "Copy failed: clipboard access is not available in this browser.",
      ),
    );
  }
}

async function copySqls(item: AnalyticsBubble) {
  const sql = (item.sqls || []).filter(Boolean).join("\n\n---\n\n");
  if (!sql) return;
  const key = `${item.id}:sql`;
  const ok = await copyText(sql);
  if (ok) {
    copiedSqlKey.value = key;
    setTimeout(() => {
      if (copiedSqlKey.value === key) copiedSqlKey.value = null;
    }, 1200);
  } else {
    alert(
      tx(
        "复制失败：当前浏览器环境不允许访问剪贴板，请手动选中文本复制。",
        "Copy failed: clipboard access is not available in this browser.",
      ),
    );
  }
}

async function sendFeedback(item: AnalyticsBubble, verdict: "useful" | "wrong") {
  if (!item.askId || item.feedback) return;
  let reasonTags: string[] | undefined;
  let note: string | undefined;
  if (verdict === "wrong") {
    const pick = window.prompt(
      tx(
        "错因标签（可选，逗号分隔）：wrong_number, wrong_grain, wrong_filter, wrong_entity, other",
        "Reason tags (optional, comma-separated): wrong_number, wrong_grain, wrong_filter, wrong_entity, other",
      ),
      "wrong_number",
    );
    if (pick === null) return;
    reasonTags = pick
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 8);
    note = reasonTags.join(",");
  }
  try {
    await submitAnalyticsFeedback({
      askId: item.askId,
      verdict,
      reasonTags,
      note,
      nl: item.userNl,
      sqls: item.sqls,
      status: item.status,
      packVersion: item.packVersion,
      modelId: item.modelId,
    });
    touchConversation(activeId.value, (conv) => {
      conv.messages = conv.messages.map((m) => (m.id === item.id ? { ...m, feedback: verdict } : m));
    });
  } catch (err) {
    alert(formatRequestError(err));
  }
}

function editInComposer(item: AnalyticsBubble) {
  input.value = item.text;
  composerH.value = null;
  document.documentElement.style.setProperty("--composer-max", "");
  nextTick(() => {
    resizeComposer();
    composerInput.value?.focus();
    composerInput.value?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

const availableModels = ref<ModelInfo[]>([]);
const selectedModel = ref<string | null>(null);
const selectedModelLabel = ref("Auto");
const modelMenuOpen = ref(false);
const modelMenuEl = ref<HTMLElement | null>(null);
const scrollbarTrackEl = ref<HTMLElement | null>(null);
const scrollbarThumbEl = ref<HTMLElement | null>(null);
let modelScrollbarCleanup: (() => void) | null = null;

const textModels = computed(() => availableModels.value.filter((m) => m.vision === "none"));
const visionModels = computed(() => availableModels.value.filter((m) => m.vision !== "none"));

function selectModel(id: string | null) {
  selectedModel.value = id;
  const label = id ? availableModels.value.find((m) => m.id === id)?.label ?? id : "Auto";
  selectedModelLabel.value = label;
  writeModelCache(MODEL_CACHE_KEY, id, label);
  modelMenuOpen.value = false;
}

// ---- 粘贴图片 / 上传 / 语音（对齐后台 ChatPage，上传走 /analytics/upload）----
interface PastedImage {
  id: string;
  previewUrl: string;
  name: string;
}
const pastingImages = ref<PastedImage[]>([]);
const pastingFiles = ref<UploadResult[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

interface Capabilities {
  voice: boolean;
}
const caps = ref<Capabilities>({ voice: false });
const recording = ref(false);
const recognitionRef = shallowRef<SpeechRecognition | null>(null);

const attachmentSummary = computed(() => {
  const imageCount = pastingImages.value.length;
  const fileCount = pastingFiles.value.length;
  const total = imageCount + fileCount;
  if (!total) {
    return tx("未附加文件", "No attachments", "Nenhum anexo", "कोई अटैचमेंट नहीं");
  }
  if (imageCount && fileCount) {
    return tx(
      `已附加 ${imageCount} 张图片和 ${fileCount} 个文件`,
      `${imageCount} image(s) and ${fileCount} file(s) attached`,
    );
  }
  if (imageCount) {
    return tx(`已附加 ${imageCount} 张图片`, `${imageCount} image(s) attached`);
  }
  return tx(`已附加 ${fileCount} 个文件`, `${fileCount} file(s) attached`);
});

function removePastedImage(index: number) {
  const [item] = pastingImages.value.splice(index, 1);
  if (item) URL.revokeObjectURL(item.previewUrl);
}

function removePastedFile(index: number) {
  pastingFiles.value.splice(index, 1);
}

async function onComposerPaste(e: ClipboardEvent) {
  if (sending.value) return;
  const items = Array.from(e.clipboardData?.items || []);
  const files: File[] = [];
  for (const item of items) {
    if (!item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (!file) continue;
    if (!IMAGE_TYPES.includes(file.type)) {
      alert(tx(`不支持的图片格式：${file.type}，仅支持 png/jpeg/webp`, `Unsupported image format: ${file.type}. Only png/jpeg/webp are supported.`));
      continue;
    }
    if (file.size > 2 * 1024 * 1024) {
      alert(tx("图片过大，单张不超过 2MB", "The image is too large. Each image must be 2 MB or smaller."));
      continue;
    }
    files.push(file);
  }
  if (!files.length) return;
  e.preventDefault();
  try {
    const saved = await uploadAnalyticsFiles(files.slice(0, 4));
    const itemsToAdd: PastedImage[] = files.slice(0, saved.length).map((file, i) => ({
      id: saved[i].id,
      previewUrl: URL.createObjectURL(file),
      name: file.name,
    }));
    pastingImages.value.push(...itemsToAdd);
    nextTick(scrollBottom);
  } catch (err) {
    alert(localizeToken(uiLocale.value, getApiErrorToken(err), "UPLOAD_FAILED"));
  }
}

async function onFileChange(e: Event) {
  const el = e.target as HTMLInputElement;
  const files = Array.from(el.files || []);
  el.value = "";
  if (!files.length) return;
  try {
    const saved = await uploadAnalyticsFiles(files.slice(0, 4));
    const images: PastedImage[] = [];
    const texts: UploadResult[] = [];
    for (let i = 0; i < saved.length; i += 1) {
      const meta = saved[i];
      const file = files[i];
      if (meta.kind === "image") {
        images.push({
          id: meta.id,
          previewUrl: file ? URL.createObjectURL(file) : analyticsUploadUrl(meta.id),
          name: meta.name || file?.name || meta.id,
        });
      } else {
        texts.push(meta);
      }
    }
    pastingImages.value.push(...images);
    pastingFiles.value.push(...texts);
    nextTick(scrollBottom);
  } catch (err) {
    alert(localizeToken(uiLocale.value, getApiErrorToken(err), "UPLOAD_FAILED"));
  }
}

function initVoice(): SpeechRecognition | null {
  const SR =
    (window as unknown as Record<string, unknown>).SpeechRecognition ||
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  if (!SR) return null;
  const r = new (SR as new () => SpeechRecognition)();
  r.lang = uiLocale.value === "zh" ? "zh-CN" : uiLocale.value === "pt-BR" ? "pt-BR" : uiLocale.value === "hi" ? "hi-IN" : "en-US";
  r.continuous = false;
  r.interimResults = true;
  r.onresult = (ev: SpeechRecognitionEvent) => {
    let transcript = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      transcript += ev.results[i][0].transcript;
    }
    if (transcript) {
      input.value = input.value ? `${input.value}${transcript}` : transcript;
      nextTick(resizeComposer);
    }
  };
  r.onerror = () => {
    recording.value = false;
  };
  r.onend = () => {
    recording.value = false;
  };
  return r;
}

function stopVoice() {
  if (recording.value && recognitionRef.value) {
    recognitionRef.value.stop();
  }
  recording.value = false;
}

function toggleVoice() {
  if (!recognitionRef.value) {
    recognitionRef.value = initVoice();
  }
  if (!recognitionRef.value) {
    alert(tx("当前浏览器不支持语音输入", "Voice input is not supported in this browser"));
    return;
  }
  if (recording.value) {
    stopVoice();
  } else {
    recognitionRef.value.start();
    recording.value = true;
  }
}

function detectCapabilities(): Capabilities {
  const SR =
    (window as unknown as Record<string, unknown>).SpeechRecognition ||
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  return { voice: !!SR };
}

watch(modelMenuOpen, async (open) => {
  if (!open) {
    modelScrollbarCleanup?.();
    modelScrollbarCleanup = null;
    return;
  }
  await nextTick();
  modelScrollbarCleanup?.();
  modelScrollbarCleanup = bindCustomScrollbar(
    () => modelMenuEl.value,
    () => scrollbarTrackEl.value,
    () => scrollbarThumbEl.value,
  );
});

function cancelSend() {
  const controller = activeController.value;
  if (!controller || controller.signal.aborted) return;
  controller.abort();
}

async function send() {
  const text = input.value.trim();
  const imageIds = pastingImages.value.map((i) => i.id);
  const fileIds = pastingFiles.value.map((f) => f.id);
  if ((!text && !imageIds.length && !fileIds.length) || sending.value) return;
  stopVoice();
  sending.value = true;
  const controller = new AbortController();
  activeController.value = controller;
  const requestConvId = activeId.value;

  const priorMessages = [...(activeConversation.value?.messages || [])];
  const askPayload = buildClarifyContinuation(priorMessages, text);
  const conversationMessages = [
    ...priorMessages
      .filter((m) => !m.welcome && !m.pending && !m.cancelled)
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        text: String(m.text || "").trim(),
      }))
      .filter((m) => m.text),
    {
      role: "user" as const,
      text: text || (imageIds.length || fileIds.length ? tx("（附件问数）", "(ask with attachments)") : ""),
    },
  ].filter((m) => m.text);

  const attachedImages = pastingImages.value.map((i) => ({ id: i.id, name: i.name }));
  const attachedFiles = pastingFiles.value.map((f) => ({ id: f.id, name: f.name }));
  const userBubble: AnalyticsBubble = {
    id: uid(),
    role: "user",
    text: text || (attachedImages.length || attachedFiles.length ? tx("（附件问数）", "(ask with attachments)") : ""),
    images: attachedImages.length ? attachedImages : undefined,
    files: attachedFiles.length ? attachedFiles : undefined,
  };
  const pendingId = uid();
  touchConversation(requestConvId, (conv) => {
    conv.messages = [
      ...conv.messages.filter((m) => !m.welcome),
      userBubble,
      {
        id: pendingId,
        role: "assistant",
        text: tx("正在查询…", "Asking…"),
        pending: true,
      },
    ];
    if (isDefaultConversationTitle(conv.title)) {
      conv.title = (text || attachedFiles[0]?.name || attachedImages[0]?.name || "").slice(0, 28) || defaultConversationTitle();
    }
  });
  for (const img of pastingImages.value) URL.revokeObjectURL(img.previewUrl);
  pastingImages.value = [];
  pastingFiles.value = [];
  input.value = "";
  composerH.value = null;
  document.documentElement.style.setProperty("--composer-max", "");
  await nextTick();
  resizeComposer();
  await scrollBottom();

  const patchPending = (patch: Partial<AnalyticsBubble>) => {
    touchConversation(requestConvId, (conv) => {
      conv.messages = conv.messages.map((m) => (m.id === pendingId ? { ...m, ...patch, id: pendingId, role: "assistant" } : m));
    });
  };

  try {
    const data = await askAnalytics(text || askPayload.text, {
      model: selectedModel.value ?? undefined,
      signal: controller.signal,
      images: imageIds.length ? imageIds : undefined,
      files: fileIds.length ? fileIds : undefined,
      slotAnswers: askPayload.slotAnswers,
      messages: conversationMessages,
    });
    if (data.error === "aborted" || (data.status === "error" && data.message === "已取消")) {
      patchPending({ text: "", pending: false, cancelled: true, status: undefined, error: undefined });
    } else {
      patchPending({
        text: data.message || data.error || (data.status === "ok" ? tx("查询完成", "Done") : ""),
        status: data.status,
        timeEcho: data.timeEcho,
        tables: data.tables,
        sqls: data.sqls,
        probeSummary: data.probeSummary,
        clarifySlot: data.clarifySlot,
        clarifyOptions: data.clarifyOptions,
        error: data.status === "error" && !(data.message || "").trim() ? data.error || data.message : undefined,
        pending: false,
        cancelled: false,
        askId: data.askId,
        modelId: data.modelId,
        packVersion: data.packVersion,
        userNl: askPayload.text,
        charts: data.charts,
      });
    }
  } catch (err) {
    if (isAbortError(err)) {
      patchPending({ text: "", pending: false, cancelled: true, status: undefined, error: undefined });
    } else {
      const msg = formatRequestError(err);
      patchPending({
        text: "",
        status: "error",
        error: msg,
        pending: false,
        cancelled: false,
      });
    }
  } finally {
    if (activeController.value === controller) activeController.value = null;
    sending.value = false;
    if (activeId.value === requestConvId) {
      await scrollBottom();
      composerInput.value?.focus();
    }
  }
}

function onComposerKeydown(ev: KeyboardEvent) {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    void send();
  }
}

function onWindowClickAway(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (!t || !t.closest(".model-switch")) modelMenuOpen.value = false;
}

function onWindowKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  if (tabMenu.value) {
    hideTabMenu();
    return;
  }
  if (helpOpen.value) return;
  if (modelMenuOpen.value) {
    modelMenuOpen.value = false;
    return;
  }
  lightboxUrl.value = "";
}

const lightboxUrl = ref("");
function openLightbox(id: string) {
  lightboxUrl.value = analyticsUploadUrl(id);
}

watch(uiLocale, () => {
  if (selectedModel.value === null) {
    selectedModelLabel.value = "Auto";
  }
  // 语言切换后重建语音识别，避免 lang 卡在首次初始化
  if (recognitionRef.value) {
    stopVoice();
    recognitionRef.value = null;
  }
});

onMounted(async () => {
  caps.value = detectCapabilities();
  window.addEventListener("click", onWindowClickAway);
  window.addEventListener("keydown", onWindowKeydown);
  await restoreConversations();
  if (!conversations.value.length) ensureBlankConversation(true);
  await nextTick();
  threadScrollbarCleanup = bindCustomScrollbar(
    () => shellRef.value?.threadEl ?? null,
    () => threadTrackEl.value,
    () => threadThumbEl.value,
  );

  const cached = readModelCache(MODEL_CACHE_KEY);
  if (cached) {
    selectedModel.value = cached.id;
    selectedModelLabel.value = cached.label || (cached.id ? cached.id : "Auto");
  }
  try {
    availableModels.value = await fetchAnalyticsModels();
    // 仅在成功拉到非空列表且当前 id 不在库中时才重置；空列表/失败不得清掉与后台共用的模型偏好
    if (
      selectedModel.value &&
      availableModels.value.length > 0 &&
      !availableModels.value.some((m) => m.id === selectedModel.value)
    ) {
      selectModel(null);
    } else if (selectedModel.value) {
      const hit = availableModels.value.find((m) => m.id === selectedModel.value);
      if (hit) selectedModelLabel.value = hit.label;
    }
  } catch {
    availableModels.value = [];
  }

  const q = typeof route.query.q === "string" ? route.query.q.trim() : "";
  const from = typeof route.query.from === "string" ? route.query.from.trim() : "";
  const to = typeof route.query.to === "string" ? route.query.to.trim() : "";
  if (q) {
    input.value = q;
  } else if (from && to) {
    input.value = tx(`${from}到${to}按天观看人数`, `daily users from ${from} to ${to}`);
  } else if (from) {
    input.value = tx(`${from}观看人数`, `users on ${from}`);
  }
  nextTick(() => {
    resizeComposer();
    composerInput.value?.focus();
  });
});

onUnmounted(() => {
  scanPollEpoch += 1;
  window.removeEventListener("keydown", onScanKeydown);
  window.removeEventListener("click", onWindowClickAway);
  window.removeEventListener("keydown", onWindowKeydown);
  stopVoice();
  threadScrollbarCleanup?.();
  threadScrollbarCleanup = null;
  modelScrollbarCleanup?.();
  modelScrollbarCleanup = null;
  activeController.value?.abort();
  for (const img of pastingImages.value) URL.revokeObjectURL(img.previewUrl);
});
</script>

<template>
  <ChatShell ref="shellRef" accent="analytics" @thread-scroll="onThreadScroll">
    <template #header>
      <div class="identity">
        <p class="brand-kicker">{{ tx("数据分析 · Metabase", "Analytics · Metabase") }}</p>
        <RouterLink class="brand-mark" to="/">{{ tx("数据分析 Agent", "Analytics Agent", "Agent de Analise", "एनालिटिक्स एजेंट") }}</RouterLink>
      </div>
      <div class="actions">
        <button type="button" class="ghost" @click="openScan">{{ tx("巡检", "Scan", "Varredura", "स्कैन") }}</button>
        <AgentChromeNav current-key="analytics" />
        <UiLocaleSelect />
        <ThemeToggle />
        <button class="ghost" type="button" @click="helpOpen = true">{{ tx("操作说明", "Help", "Ajuda", "सहायता") }}</button>
        <button class="ghost" type="button" :disabled="sending || !hasUserMessages" @click="onClearContext">
          {{ tx("重置对话", "Reset Chat", "Redefinir Chat", "चैट रीसेट करें") }}
        </button>
      </div>
    </template>

    <template #subnav>
      <nav class="tabs" :aria-label="tx('会话切换', 'Conversation Tabs', 'Abas de Conversa', 'वार्तालाप टैब')">
        <div
          v-for="(conv, idx) in conversations"
          :key="conv.id"
          class="tab"
          :class="{ active: conv.id === activeId }"
          @contextmenu.prevent="openTabMenu($event, conv.id, idx)"
        >
          <button
            class="tab-main"
            :class="{ active: conv.id === activeId }"
            type="button"
            @click="switchConversation(conv.id)"
          >
            <span class="tab-index">{{ idx + 1 }}</span>
            <span class="tab-title">{{ displayConversationTitleOf(conv) }}</span>
          </button>
          <button
            class="tab-close"
            type="button"
            :aria-label="tx('关闭会话', 'Close conversation', 'Fechar conversa', 'वार्तालाप बंद करें')"
            :title="tx('关闭会话', 'Close conversation', 'Fechar conversa', 'वार्तालाप बंद करें')"
            @click.stop="closeConversation(conv.id)"
          >
            ×
          </button>
        </div>
        <button
          class="tab-new"
          type="button"
          :title="tx('新建会话', 'New conversation', 'Nova conversa', 'नई वार्तालाप')"
          @click="newConversation"
        >
          ＋
        </button>
      </nav>
    </template>

    <template #thread>
      <article
        v-for="item in messages"
        :key="item.id"
        :class="['msg', item.role === 'user' ? 'user' : '']"
      >
        <div class="who" :class="{ me: item.role === 'user' }">
          <span class="dot" />
          {{ item.role === "user" ? tx("你", "You", "Voce", "आप") : tx("助手", "Assistant", "Assistente", "सहायक") }}
        </div>

        <div
          v-if="item.text || item.tables?.length || item.charts?.length || item.sqls?.length || item.probeSummary || item.images?.length || item.files?.length"
          class="body-wrap"
        >
          <p v-if="item.status && item.role === 'assistant' && !item.pending" class="status-line" :data-status="item.status">
            <span class="status-pill">{{ item.status }}</span>
            <span v-if="item.timeEcho" class="time-echo">{{ item.timeEcho }}</span>
            <span v-if="item.packVersion || item.modelId" class="meta-echo">
              <template v-if="item.packVersion">pack {{ item.packVersion }}</template>
              <template v-if="item.packVersion && item.modelId"> · </template>
              <template v-if="item.modelId">{{ item.modelId }}</template>
            </span>
          </p>

          <div v-if="item.images?.length" class="msg-images" :class="item.images.length > 1 ? 'grid' : 'single'">
            <img
              v-for="img in item.images"
              :key="img.id"
              class="msg-img"
              :src="analyticsUploadUrl(img.id)"
              :alt="img.name"
              loading="lazy"
              @click="openLightbox(img.id)"
              @error="(e) => ((e.target as HTMLImageElement).style.display = 'none')"
            />
          </div>
          <div v-if="item.files?.length" class="msg-files-inline">
            <span v-for="f in item.files" :key="f.id" class="msg-file-chip">{{ f.name }}</span>
          </div>

          <div
            v-if="item.text && !item.pending"
            class="body"
            :class="{ error: item.status === 'error' || item.status === 'refuse' }"
            v-html="renderMarkdown(item.text)"
          />

          <details v-if="item.sqls?.length" class="sql">
            <summary class="sql-summary">
              <span>{{ tx("SQL", "SQL", "SQL", "SQL") }} ({{ item.sqls.length }})</span>
              <button
                type="button"
                class="sql-copy"
                :title="copiedSqlKey === `${item.id}:sql` ? tx('已复制', 'Copied') : tx('复制 SQL', 'Copy SQL')"
                @click.stop.prevent="copySqls(item)"
              >
                {{ copiedSqlKey === `${item.id}:sql` ? tx("已复制", "Copied") : tx("复制", "Copy") }}
              </button>
            </summary>
            <pre v-for="(sql, idx) in item.sqls" :key="idx">{{ sql }}</pre>
          </details>

          <div v-if="item.charts?.length" class="msg-charts">
            <ResultChart
              v-for="(ch, ci) in item.charts"
              :key="`${item.id}-c${ci}-${ch.title}-${ch.categories?.length || 0}`"
              :chart="ch"
            />
          </div>

          <div v-if="item.tables?.length" class="msg-tables">
            <ResultTable
              v-for="(table, idx) in item.tables"
              :key="`${item.id}-t${idx}`"
              :table="toTableView(table)"
              :empty-hint="item.timeEcho || undefined"
            />
          </div>

          <p v-if="item.probeSummary && item.status !== 'ok'" class="probe">
            <span class="label">probe</span>
            {{ item.probeSummary }}
          </p>

          <div
            v-if="item.role === 'assistant' && item.askId && !item.pending && !item.welcome && !item.cancelled"
            class="feedback-row"
          >
            <span class="feedback-label">{{ tx("这题结果", "This answer", "Esta resposta", "यह उत्तर") }}</span>
            <button
              type="button"
              class="feedback-btn"
              :class="{ on: item.feedback === 'useful' }"
              :disabled="!!item.feedback"
              @click="sendFeedback(item, 'useful')"
            >
              {{ tx("有用", "Useful", "Util", "उपयोगी") }}
            </button>
            <button
              type="button"
              class="feedback-btn"
              :class="{ on: item.feedback === 'wrong' }"
              :disabled="!!item.feedback"
              @click="sendFeedback(item, 'wrong')"
            >
              {{ tx("有误", "Wrong", "Errado", "गलत") }}
            </button>
            <span v-if="item.feedback" class="feedback-done">
              {{
                item.feedback === "useful"
                  ? tx("已记录", "Saved", "Salvo", "सहेजा")
                  : tx("已进候选池（待人工确认）", "Queued for review", "Na fila de revisao", "समीक्षा कतार में")
              }}
            </span>
          </div>

          <div v-if="!item.welcome && !item.pending" class="body-actions">
            <button
              type="button"
              class="act"
              :title="tx('编辑', 'Edit', 'Editar', 'संपादित करें')"
              @click="editInComposer(item)"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"
                />
              </svg>
            </button>
            <button
              type="button"
              class="act"
              :title="copiedId === item.id ? tx('已复制', 'Copied', 'Copiado', 'कॉपी हो गया') : tx('复制', 'Copy', 'Copiar', 'कॉपी करें')"
              @click="copyBody(item)"
            >
              <svg v-if="copiedId !== item.id" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2" />
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M5 15V5a2 2 0 0 1 2-2h10"
                />
              </svg>
              <svg v-else viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </button>
          </div>
        </div>

        <div
          v-if="item.role === 'assistant' && item.pending"
          class="loading"
          role="status"
          :aria-label="tx('正在查询', 'Asking')"
        >
          <span class="loading-dot" />
          <span class="loading-dot" />
          <span class="loading-dot" />
          <span class="loading-text">{{ item.text || tx("正在查询…", "Asking…") }}</span>
        </div>
        <p v-if="item.error && !item.pending && !item.text" class="error">{{ item.error }}</p>
        <div v-else-if="item.cancelled" class="cancelled-note">{{ tx("已取消", "Cancelled", "Cancelado", "रद्द") }}</div>
      </article>
    </template>

    <template #thread-aside>
      <div class="thread-scrollbar" ref="threadTrackEl">
        <div class="thread-scrollbar-thumb" ref="threadThumbEl" />
      </div>
    </template>

    <template #float>
      <Transition name="back-top">
        <button
          v-if="scrollTop > 300"
          class="back-top-btn"
          type="button"
          :title="tx('返回顶部', 'Back to top', 'Voltar ao topo', 'शीर्ष पर वापस जाएं')"
          @click="scrollToTop"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M18 15l-6-6-6 6" />
          </svg>
        </button>
      </Transition>
      <div
        v-if="lightboxUrl"
        class="lightbox"
        role="dialog"
        :aria-label="tx('图片预览', 'Image preview', 'Pre-visualizacao da imagem', 'छवि पूर्वावलोकन')"
        @click.self="lightboxUrl = ''"
      >
        <img :src="lightboxUrl" :alt="tx('图片大图', 'Large preview image', 'Imagem ampliada', 'बड़ी पूर्वावलोकन छवि')" />
      </div>
    </template>

    <template #composer>
      <form @submit.prevent>
        <div class="composer-card">
          <div
            class="composer-grip"
            :title="tx('上下拖动调整输入框高度', 'Drag up or down to resize the composer', 'Arraste para cima ou para baixo para redimensionar a caixa de entrada', 'कंपोज़र का आकार बदलने के लिए ऊपर या नीचे खींचें')"
            @pointerdown="startComposerDrag"
            @mousedown="startComposerDrag"
            @touchstart="startComposerDrag"
          />

          <div v-if="pastingImages.length || pastingFiles.length" class="image-preview">
            <div v-for="(item, index) in pastingImages" :key="item.id" class="image-chip">
              <img :src="item.previewUrl" :alt="tx('粘贴的图片', 'Pasted image')" />
              <button
                type="button"
                class="image-remove"
                :title="tx('移除图片', 'Remove image')"
                :disabled="sending"
                @click="removePastedImage(index)"
              >
                ×
              </button>
            </div>
            <div v-for="(item, index) in pastingFiles" :key="item.id" class="file-chip">
              <span class="file-chip-name" :title="item.name">{{ item.name }}</span>
              <button
                type="button"
                class="image-remove"
                :title="tx('移除文件', 'Remove file')"
                :disabled="sending"
                @click="removePastedFile(index)"
              >
                ×
              </button>
            </div>
          </div>

          <textarea
            ref="composerInput"
            v-model="input"
            class="composer-input"
            name="analytics-ask"
            rows="1"
            enterkeyhint="send"
            :style="composerH != null ? { height: composerH + 'px' } : undefined"
            :disabled="sending"
            :placeholder="recording
              ? tx('正在聆听…', 'Listening…', 'Ouvindo…', 'सुन रहा है…')
              : tx(
                '输入问数内容，回车发送；支持粘贴图片 / 上传文件',
                'Ask in natural language; paste images or upload files',
                'Pergunte em linguagem natural; cole imagens ou envie arquivos',
                'प्राकृतिक भाषा में पूछें; चित्र पेस्ट या फ़ाइल अपलोड करें',
              )"
            @keydown="onComposerKeydown"
            @input="resizeComposer"
            @paste="onComposerPaste"
          />
          <div class="composer-toolbar">
            <div class="model-switch">
              <button
                type="button"
                class="model-btn"
                :class="{ active: modelMenuOpen }"
                :title="tx('切换模型', 'Switch model', 'Trocar modelo', 'मॉडल बदलें')"
                :disabled="sending"
                @click="modelMenuOpen = !modelMenuOpen"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                  <path
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M12 3v3m0 12v3m9-9h-3M6 12H3m13.5-6.5l-2 2m-7 7l-2 2m11 0l-2-2m-7-7l-2-2"
                  />
                  <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2" />
                </svg>
                <span class="model-btn-label">{{ selectedModelLabel }}</span>
                <svg class="model-btn-caret" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                  <path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
                </svg>
              </button>
              <Transition name="model-menu-fade">
                <div
                  v-if="modelMenuOpen && availableModels.length"
                  ref="modelMenuEl"
                  class="model-menu"
                  @click.stop
                >
                  <div class="model-menu-header">
                    <div class="model-menu-title">{{ tx("选择模型", "Choose Model", "Escolher modelo", "मॉडल चुनें") }}</div>
                    <span class="model-menu-count">
                      {{
                        tx(
                          `${availableModels.length} 个可用`,
                          `${availableModels.length} available`,
                          `${availableModels.length} disponiveis`,
                          `${availableModels.length} उपलब्ध`,
                        )
                      }}
                    </span>
                  </div>
                  <button
                    type="button"
                    class="model-item model-item-auto"
                    :class="{ selected: selectedModel === null }"
                    :title="tx('Auto（服务端自动）· 智能路由', 'Auto (server managed) · Smart routing', 'Auto (gerenciado pelo servidor) · Roteamento inteligente', 'Auto (सर्वर प्रबंधित) · स्मार्ट रूटिंग')"
                    @click="selectModel(null)"
                  >
                    <span class="model-auto-dot"></span>
                    <span class="model-label">{{ tx("Auto（服务端自动）", "Auto (server managed)", "Auto (gerenciado pelo servidor)", "Auto (सर्वर प्रबंधित)") }}</span>
                    <span class="model-provider">{{ tx("智能路由", "Smart routing", "Roteamento inteligente", "स्मार्ट रूटिंग") }}</span>
                  </button>
                  <template v-if="textModels.length">
                    <div class="model-group">
                      <div class="model-group-title">{{ tx("文本对话", "Text Chat", "Chat de texto", "टेक्स्ट चैट") }}</div>
                      <div class="model-list">
                        <button
                          v-for="m in textModels"
                          :key="m.id"
                          type="button"
                          class="model-item"
                          :class="{ selected: selectedModel === m.id }"
                          :title="`${m.label} · ${m.source || m.provider} · ${m.id}`"
                          @click="selectModel(m.id)"
                        >
                          <span class="model-label">{{ m.label }}</span>
                          <span class="model-provider">{{ m.source || m.provider }}</span>
                        </button>
                      </div>
                    </div>
                  </template>
                  <template v-if="visionModels.length">
                    <div class="model-group">
                      <div class="model-group-title">{{ tx("视觉 / 多模态", "Vision / Multimodal", "Visao / Multimodal", "विज़न / मल्टीमॉडल") }}</div>
                      <div class="model-list">
                        <button
                          v-for="m in visionModels"
                          :key="m.id"
                          type="button"
                          class="model-item"
                          :class="{ selected: selectedModel === m.id }"
                          :title="`${m.label} · ${m.source || m.provider} · ${m.id}`"
                          @click="selectModel(m.id)"
                        >
                          <span class="model-label">{{ m.label }}</span>
                          <span class="model-badge">{{ tx("视觉", "Vision", "Visao", "विज़न") }}</span>
                          <span class="model-provider">{{ m.source || m.provider }}</span>
                        </button>
                      </div>
                    </div>
                  </template>
                  <div class="model-scrollbar" ref="scrollbarTrackEl">
                    <div class="model-scrollbar-thumb" ref="scrollbarThumbEl" />
                  </div>
                </div>
              </Transition>
            </div>
            <div class="toolbar-right">
              <button
                type="button"
                class="tool-btn"
                :title="tx('上传文件（txt/md/json/csv，或图片）', 'Upload files (txt/md/json/csv or images)')"
                :aria-label="tx('上传文件', 'Upload files')"
                :disabled="sending"
                @click="fileInput?.click()"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                  <path
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
                  />
                </svg>
              </button>
              <input
                ref="fileInput"
                type="file"
                multiple
                class="hidden-file-input"
                tabindex="-1"
                aria-hidden="true"
                @change="onFileChange"
              />
              <span class="attachment-status" :title="attachmentSummary">{{ attachmentSummary }}</span>
              <button
                v-if="caps.voice"
                type="button"
                class="tool-btn"
                :class="{ active: recording }"
                :title="tx('语音输入', 'Voice input', 'Entrada por voz', 'वॉइस इनपुट')"
                @click="toggleVoice"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                  <path
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"
                  />
                  <path
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M19 10v2a7 7 0 0 1-14 0v-2m7 9v3"
                  />
                </svg>
              </button>
              <button
                type="submit"
                class="send-btn"
                :class="{ stopping: sending }"
                :title="sending ? tx('停止生成', 'Stop generating', 'Parar geracao', 'जनरेशन रोकें') : tx('发送', 'Send', 'Enviar', 'भेजें')"
                @click.prevent="sending ? cancelSend() : send()"
              >
                <svg v-if="sending" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <rect x="7" y="7" width="10" height="10" rx="3" fill="currentColor" />
                </svg>
                <svg v-else viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M12 19V5m-7 7l7-7 7 7"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </form>
    </template>

    <template #modals>
      <AnalyticsCapabilitiesHelp v-model:open="helpOpen" @use-example="useHelpExample" />

      <Teleport to="body">
        <template v-if="tabMenu">
          <div class="tab-ctx-backdrop" @click="hideTabMenu" @contextmenu.prevent="hideTabMenu" />
          <ul
            class="tab-ctx-menu"
            role="menu"
            :style="{ left: `${tabMenu.x}px`, top: `${tabMenu.y}px` }"
            @click.stop
          >
            <li role="none">
              <button type="button" role="menuitem" @click="closeConversation(tabMenu.convId)">{{ tx("关闭", "Close", "Fechar", "बंद करें") }}</button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                :disabled="conversations.length <= 1"
                @click="closeOtherConversations(tabMenu.convId)"
              >
                {{ tx("关闭其他", "Close Others", "Fechar Outros", "अन्य बंद करें") }}
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                :disabled="tabMenu.idx <= 0"
                @click="closeLeftConversations(tabMenu.convId)"
              >
                {{ tx("关闭左侧", "Close Left", "Fechar a Esquerda", "बाईं ओर बंद करें") }}
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                :disabled="tabMenu.idx >= conversations.length - 1"
                @click="closeRightConversations(tabMenu.convId)"
              >
                {{ tx("关闭右侧", "Close Right", "Fechar a Direita", "दाईं ओर बंद करें") }}
              </button>
            </li>
            <li class="tab-ctx-sep" role="separator" />
            <li role="none">
              <button type="button" role="menuitem" @click="closeAllConversations">{{ tx("全部关闭", "Close All", "Fechar Tudo", "सभी बंद करें") }}</button>
            </li>
          </ul>
        </template>
      </Teleport>

      <Teleport to="body">
        <div
          v-if="scanOpen"
          class="scan-overlay"
          role="presentation"
          @click.self="closeScan"
        >
          <div
            class="scan-dialog"
            role="dialog"
            aria-modal="true"
            :aria-label="tx('巡检', 'Scan', 'Varredura', 'स्कैन')"
          >
            <header class="scan-dialog-head">
              <div class="scan-dialog-title">
                <h2>{{ tx("巡检", "Scan", "Varredura", "स्कैन") }}</h2>
                <p class="scan-lead">
                  {{ tx(
                    "手动触发 watch-users 规则集。仅启用 scan worker 的实例可入队；dryRun 不发钉钉。",
                    "Enqueue watch-users. Only the scan-worker instance accepts runs; dryRun skips DingTalk.",
                  ) }}
                </p>
              </div>
              <button type="button" class="ghost icon" :aria-label="tx('关闭', 'Close')" @click="closeScan">×</button>
            </header>

            <div class="scan-toolbar">
              <label class="dry-run">
                <input v-model="scanDryRun" type="checkbox" :disabled="scanRunning" />
                <span>{{ tx("dryRun（不发钉钉）", "dryRun (no DingTalk)") }}</span>
              </label>
              <div class="scan-toolbar-actions">
                <button type="button" class="ghost" :disabled="scanRefreshing || scanRunning" @click="refreshScanJobs">
                  {{ scanRefreshing ? tx("刷新中…", "Refreshing…") : tx("刷新", "Refresh") }}
                </button>
                <button type="button" class="solid" :disabled="scanRunning" @click="runScan">
                  {{ scanRunning ? tx("巡检中…", "Scanning…") : tx("运行巡检", "Run scan") }}
                </button>
              </div>
            </div>

            <p v-if="scanNote" class="scan-note" role="status">{{ scanNote }}</p>
            <p v-if="scanError" class="banner error" role="alert">{{ scanError }}</p>

            <div class="scan-list-wrap">
              <div class="scan-list-head">
                <span>{{ tx("最近任务", "Recent jobs") }}</span>
                <span class="scan-list-count">{{ scanJobs.length }}</span>
              </div>
              <ul v-if="scanJobs.length" class="scan-jobs">
                <li
                  v-for="job in scanJobs"
                  :key="job.jobId"
                  class="scan-job"
                  :data-severity="jobSeverity(job)"
                >
                  <div class="job-meta">
                    <span class="job-status" :data-status="job.status">{{ jobStatusLabel(job.status) }}</span>
                    <span class="job-date">{{ job.scanDate }}</span>
                    <span v-if="job.dryRun" class="job-dry">dryRun</span>
                    <span class="job-id" :title="job.jobId">{{ shortJobId(job.jobId) }}</span>
                  </div>
                  <p class="job-summary">{{ jobSummary(job) }}</p>
                </li>
              </ul>
              <p v-else class="scan-empty">{{ tx("暂无巡检任务", "No scan jobs yet") }}</p>
            </div>
          </div>
        </div>
      </Teleport>
    </template>
  </ChatShell>
</template>

<style scoped>
.ghost {
  background: transparent;
  color: var(--muted);
  border: 1px solid transparent;
  cursor: pointer;
  height: 32px;
  padding: 0 10px;
  font-size: 12.5px;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: inherit;
}

.ghost:hover:not(:disabled) {
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 6%, transparent);
}

.ghost:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

:deep(.chat-shell .thread) {
  scrollbar-width: none;
  -ms-overflow-style: none;
}

:deep(.chat-shell .thread::-webkit-scrollbar) {
  display: none;
}

.tabs {
  display: flex;
  align-items: flex-end;
  gap: 1px;
  overflow-x: auto;
  padding: 0 var(--pad);
  position: relative;
  scrollbar-width: none;
  background: var(--panel);
}

.tabs::-webkit-scrollbar {
  display: none;
}

.tabs::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  background: var(--line);
  pointer-events: none;
}

.tab {
  position: relative;
  display: flex;
  align-items: center;
  max-width: 200px;
  flex-shrink: 0;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  background: transparent;
  color: var(--muted);
  font-size: 12.5px;
  letter-spacing: 0.01em;
  transition: background 0.16s ease, color 0.16s ease, border-color 0.16s ease;
}

.tab.active {
  color: var(--ink);
  font-weight: 600;
  background: var(--panel);
  border-color: var(--line);
  margin-bottom: -1px;
  padding-bottom: 9px;
  z-index: 1;
}

.tab.active::before {
  content: "";
  position: absolute;
  bottom: 0;
  left: 12px;
  right: 12px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--ink);
}

.tab:not(.active):hover {
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  color: var(--ink);
}

.tab-main {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 8px 8px 14px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.tab-main:focus-visible,
.tab-close:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 24%, transparent);
  outline-offset: -1px;
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 0 1 auto;
}

.tab-index {
  flex-shrink: 0;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: var(--muted);
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}

.tab.active .tab-index {
  color: #fff;
  background: var(--accent);
}

.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 18px;
  height: 18px;
  margin-right: 10px;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 5px;
  font-size: 13px;
  line-height: 1;
  color: var(--muted);
  opacity: 0.45;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}

.tab:hover .tab-close,
.tab.active .tab-close {
  opacity: 1;
}

.tab-close:hover {
  color: var(--danger, #b91c1c);
  background: color-mix(in srgb, var(--danger, #ef4444) 12%, transparent);
}

.tab-new {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  align-self: center;
  margin: 0 0 1px 4px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.tab-new:hover {
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  color: var(--ink);
}

.tab-ctx-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
}

.tab-ctx-menu {
  position: fixed;
  z-index: 81;
  min-width: 168px;
  margin: 0;
  padding: 6px;
  list-style: none;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--panel);
  box-shadow: 0 10px 28px color-mix(in srgb, var(--ink) 16%, transparent);
}

.tab-ctx-menu button {
  display: block;
  width: 100%;
  padding: 8px 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ink);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.tab-ctx-menu button:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ink) 7%, transparent);
}

.tab-ctx-menu button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.tab-ctx-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--line);
}

.thread-scrollbar {
  position: absolute;
  top: 12px;
  right: 4px;
  bottom: 12px;
  width: 8px;
  z-index: 3;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  opacity: 0.35;
  transition: opacity 0.18s ease;
}

:deep(.thread-frame:hover) .thread-scrollbar,
.thread-scrollbar.is-dragging {
  opacity: 1;
}

.thread-scrollbar.is-off {
  display: none;
}

.thread-scrollbar-thumb {
  position: absolute;
  left: 1px;
  width: 6px;
  border-radius: 999px;
  cursor: pointer;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--ink) 42%, transparent),
    color-mix(in srgb, var(--ink) 26%, transparent)
  );
  transition: background 0.14s ease;
}

.thread-scrollbar-thumb:hover,
.thread-scrollbar.is-dragging .thread-scrollbar-thumb {
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--accent, #2f6df6) 62%, var(--ink)),
    color-mix(in srgb, var(--accent, #2f6df6) 40%, var(--ink))
  );
}

/* Markdown 渲染内容的排版（气泡基础样式在 ChatShell） */
.msg:not(.user) .body:hover {
  background: color-mix(in srgb, var(--ink) 3%, transparent);
}

.body :deep(p) {
  margin: 0 0 10px;
  white-space: pre-wrap;
}
.body :deep(p:last-child) {
  margin-bottom: 0;
}
.body :deep(h1),
.body :deep(h2),
.body :deep(h3),
.body :deep(h4) {
  margin: 16px 0 8px;
  line-height: 1.4;
  font-weight: 700;
}
.body :deep(h1:first-child),
.body :deep(h2:first-child),
.body :deep(h3:first-child),
.body :deep(h4:first-child) {
  margin-top: 0;
}
.body :deep(h1) {
  font-size: 20px;
}
.body :deep(h2) {
  font-size: 18px;
}
.body :deep(h3) {
  font-size: 16px;
}
.body :deep(h4) {
  font-size: 14.5px;
}
.body :deep(strong) {
  font-weight: 700;
}
.body :deep(em) {
  font-style: italic;
}
.body :deep(ul),
.body :deep(ol) {
  margin: 0 0 10px;
  padding-left: 22px;
}
.body :deep(ul:last-child),
.body :deep(ol:last-child) {
  margin-bottom: 0;
}
.body :deep(li) {
  margin: 3px 0;
}
.body :deep(li > p) {
  margin: 0;
  white-space: normal;
}
.body :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.9em;
  background: color-mix(in srgb, var(--ink) 9%, transparent);
  border-radius: 4px;
  padding: 1px 5px;
}
.body :deep(pre) {
  margin: 10px 0;
  padding: 12px 14px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  border: 1px solid var(--line);
  overflow-x: auto;
  line-height: 1.6;
}
.body :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: 13px;
}
.body :deep(a) {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.body :deep(a:hover) {
  opacity: 0.8;
}
.body :deep(blockquote) {
  margin: 10px 0;
  padding: 2px 14px;
  border-left: 3px solid color-mix(in srgb, var(--ink) 25%, transparent);
  color: color-mix(in srgb, var(--ink) 75%, transparent);
}
.body :deep(hr) {
  border: none;
  border-top: 1px solid var(--line);
  margin: 14px 0;
}
.body :deep(img) {
  max-width: 100%;
  height: auto;
  display: block;
  border-radius: 6px;
}
.body :deep(.table-wrapper) {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  margin: 10px 0;
  border-radius: 10px;
  border: 1px solid var(--line);
}
.body :deep(table) {
  border-collapse: collapse;
  margin: 0;
  width: max-content;
  min-width: 100%;
  font-size: 13px;
  line-height: 1.6;
}
.body :deep(.table-wrapper th),
.body :deep(.table-wrapper td) {
  border: none;
  border-bottom: 1px solid var(--line);
  border-right: 1px solid var(--line);
}
.body :deep(.table-wrapper tr:last-child th),
.body :deep(.table-wrapper tr:last-child td) {
  border-bottom: none;
}
.body :deep(.table-wrapper th:last-child),
.body :deep(.table-wrapper td:last-child) {
  border-right: none;
}
.body :deep(th),
.body :deep(td) {
  border: 1px solid var(--line);
  padding: 6px 12px;
  text-align: left;
  white-space: nowrap;
}
.body :deep(th) {
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  font-weight: 600;
  position: sticky;
  top: 0;
}
.body :deep(thead th) {
  position: sticky;
  top: 0;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  font-weight: 600;
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
.body :deep(tbody td) {
  padding: 7px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
}
.body :deep(tbody tr:nth-child(even)) {
  background: color-mix(in srgb, var(--ink) 2.5%, transparent);
}
.body :deep(tbody tr:hover) {
  background: color-mix(in srgb, var(--accent, #4f7cff) 8%, transparent);
}

.msg.user .body :deep(code) {
  background: color-mix(in srgb, var(--bg) 18%, transparent);
}
.msg.user .body :deep(pre) {
  background: color-mix(in srgb, var(--bg) 12%, transparent);
  border-color: color-mix(in srgb, var(--bg) 20%, transparent);
}
.msg.user .body :deep(blockquote) {
  border-left-color: color-mix(in srgb, var(--bg) 40%, transparent);
  color: color-mix(in srgb, var(--bg) 80%, transparent);
}
.msg.user .body :deep(th),
.msg.user .body :deep(td) {
  border-color: color-mix(in srgb, var(--bg) 25%, transparent);
}
.msg.user .body :deep(th) {
  background: color-mix(in srgb, var(--bg) 12%, transparent);
}
.msg.user .body :deep(.table-wrapper) {
  border-color: color-mix(in srgb, var(--bg) 25%, transparent);
}

.body-wrap {
  position: relative;
  width: fit-content;
  max-width: 100%;
  min-width: 0;
}

.status-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
}

.status-pill {
  display: inline-flex;
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.status-line[data-status="ok"] .status-pill {
  background: color-mix(in srgb, #12b981 16%, transparent);
  color: #047857;
}

.status-line[data-status="clarify"] .status-pill {
  background: color-mix(in srgb, #f59e0b 16%, transparent);
  color: #b45309;
}

.status-line[data-status="error"] .status-pill,
.status-line[data-status="refuse"] .status-pill {
  background: color-mix(in srgb, #ef4444 14%, transparent);
  color: #b91c1c;
}

.time-echo {
  color: var(--muted);
  font-size: 12px;
}

.meta-echo {
  color: var(--muted);
  font-size: 11px;
}

.feedback-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 10px 0 4px;
  font-size: 12px;
  color: var(--muted);
}

.feedback-label {
  margin-right: 2px;
}

.feedback-btn {
  appearance: none;
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  background: color-mix(in srgb, var(--ink) 4%, transparent);
  color: var(--ink);
  border-radius: 6px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
}

.feedback-btn:disabled {
  cursor: default;
  opacity: 0.7;
}

.feedback-btn.on {
  border-color: color-mix(in srgb, #12b981 40%, transparent);
  background: color-mix(in srgb, #12b981 12%, transparent);
}

.feedback-done {
  color: var(--muted);
}

.body.error {
  color: #b91c1c;
}

.msg-charts {
  margin-top: 10px;
  display: grid;
  gap: 12px;
  max-width: min(860px, 100%);
}

.msg-tables {
  margin-top: 10px;
  display: grid;
  gap: 12px;
  max-width: min(860px, 100%);
  overflow: auto;
}

.sql {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--panel) 80%, transparent);
}

.sql-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  cursor: pointer;
  list-style: none;
}

.sql-summary::-webkit-details-marker {
  display: none;
}

.sql-copy {
  flex-shrink: 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: color-mix(in srgb, var(--panel) 90%, transparent);
  color: var(--ink);
  font-size: 12px;
  line-height: 1.2;
  padding: 3px 8px;
  cursor: pointer;
}

.sql-copy:hover {
  border-color: color-mix(in srgb, var(--accent, #3b82f6) 45%, var(--line));
}

.sql pre {
  margin: 10px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.5;
}

.probe {
  margin: 10px 0 0;
  color: var(--muted);
  font-size: 12px;
}

.probe .label {
  display: inline-flex;
  margin-right: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.body-actions {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 8px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
}

.body-wrap:hover .body-actions,
.body-actions:focus-within {
  opacity: 1;
  pointer-events: auto;
}

.act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--muted);
  cursor: pointer;
  border-radius: 6px;
}

.act:hover {
  color: var(--ink);
  background: var(--fill-soft);
  border-color: color-mix(in srgb, var(--ink) 15%, var(--line));
}

.act:active {
  transform: scale(0.95);
}

.loading {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 14px 18px;
  margin-top: 10px;
  background: var(--fill);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--ink) 3%, transparent);
}

.loading-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
  opacity: 0.4;
  animation: load-bounce 1.2s ease-in-out infinite;
}

.loading-text {
  font-size: 13px;
  color: var(--muted);
  white-space: nowrap;
}

.loading-dot:nth-child(2) {
  animation-delay: 0.15s;
}

.loading-dot:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes load-bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

.error {
  color: var(--danger, #b91c1c);
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.5;
}

.cancelled-note {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0 0;
  padding: 8px 14px;
  background: var(--fill);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1;
}

.msg-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 0 6px;
  justify-content: flex-end;
}

.msg-images.single .msg-img {
  width: auto;
  height: auto;
  max-width: min(480px, 100%);
  max-height: 380px;
}

.msg-images.grid .msg-img {
  width: 152px;
  height: 152px;
  object-fit: cover;
}

.msg-img {
  border-radius: 6px;
  background: var(--panel);
  display: block;
  cursor: zoom-in;
  transition: filter 0.15s ease, transform 0.15s ease;
}

.msg-img:hover {
  filter: brightness(0.97);
}

.lightbox {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.74);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  animation: lightbox-fade-in 0.2s ease both;
}

.lightbox img {
  max-width: 92vw;
  max-height: 86vh;
  object-fit: contain;
  border-radius: 14px;
  background: var(--panel);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55);
  animation: lightbox-zoom-in 0.24s cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes lightbox-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes lightbox-zoom-in {
  from {
    opacity: 0;
    transform: scale(0.94);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.msg-files-inline {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 10px;
}

.msg-file-chip {
  display: inline-flex;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 4px 8px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--fill);
  color: var(--muted);
  font-size: 12px;
}

.image-preview {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 4px 2px;
}

.image-chip {
  position: relative;
  width: 64px;
  height: 64px;
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
  background: var(--panel);
}

.image-chip img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.file-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 180px;
  height: 34px;
  padding: 0 24px 0 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  font-size: 12px;
}

.file-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: color-mix(in srgb, var(--bg) 85%, transparent);
  color: var(--ink);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s ease;
}

.file-chip .image-remove {
  top: 50%;
  right: 4px;
  transform: translateY(-50%);
}

.image-remove:hover:not(:disabled) {
  background: var(--danger, #ef4444);
  color: #fff;
}

.image-remove:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.hidden-file-input {
  display: none;
}

.attachment-status {
  min-width: 0;
  max-width: 180px;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.tool-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  color: var(--ink);
}

.tool-btn:active:not(:disabled) {
  transform: scale(0.92);
}

.tool-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.tool-btn:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--ink) 30%, var(--line));
}

.tool-btn.active {
  background: color-mix(in srgb, var(--danger, #ef4444) 14%, transparent);
  color: var(--danger, #b91c1c);
}

.tool-btn.active svg {
  animation: mic-pulse 1.4s ease-in-out infinite;
}

@keyframes mic-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

.model-switch {
  position: relative;
}

.model-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: transparent;
  color: var(--ink);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
}

.model-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  color: var(--ink);
}

.model-btn:active:not(:disabled) {
  transform: scale(0.97);
}

.model-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.model-btn.active {
  background: color-mix(in srgb, var(--ink) 10%, transparent);
  color: var(--ink);
  border-color: color-mix(in srgb, var(--ink) 30%, var(--line));
}

.model-btn-label {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.model-btn-caret {
  opacity: 0.6;
}

.model-menu {
  position: absolute;
  bottom: calc(100% + 12px);
  left: 0;
  z-index: 30;
  width: min(600px, 88vw);
  box-sizing: border-box;
  max-height: 64vh;
  overflow-y: auto;
  padding: 12px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--bg), #ffffff 0%);
  border: 1px solid var(--line);
  box-shadow: 0 16px 48px color-mix(in srgb, var(--ink) 24%, transparent);
  backdrop-filter: blur(8px);
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.model-menu::-webkit-scrollbar {
  display: none;
}

.model-menu-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 2px 10px 10px;
  position: sticky;
  top: -12px;
  background: var(--bg);
  z-index: 2;
}

.model-menu-title {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.01em;
  color: var(--ink);
}

.model-menu-count {
  font-size: 10.5px;
  color: var(--muted);
}

.model-group-title {
  position: sticky;
  top: 16px;
  margin: 8px 4px 6px;
  padding: 6px 10px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(4px);
  border-radius: 8px;
}

.model-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.model-item {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 36px;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--ink) 3%, transparent);
  color: var(--ink);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease, transform 0.08s ease;
}

.model-item:hover {
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  border-color: color-mix(in srgb, var(--accent, #2f6df6) 35%, var(--line));
  transform: translateY(-1px);
}

.model-item:active {
  transform: translateY(0);
}

.model-item.selected {
  background: color-mix(in srgb, var(--accent, #2f6df6) 12%, transparent);
  border-color: color-mix(in srgb, var(--accent, #2f6df6) 50%, transparent);
  color: color-mix(in srgb, var(--accent, #2f6df6) 78%, var(--ink));
  font-weight: 600;
}

.model-item-auto {
  border-style: dashed;
  border-color: color-mix(in srgb, var(--accent, #2f6df6) 30%, var(--line));
}

.model-auto-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent, #2f6df6);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #2f6df6) 20%, transparent);
  flex: none;
}

.model-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
}

.model-badge {
  flex: none;
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #fff;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--accent, #2f6df6) 90%, #000),
    color-mix(in srgb, var(--accent, #2f6df6) 70%, #5b8bff)
  );
}

.model-provider {
  flex: none;
  margin-left: auto;
  font-size: 10.5px;
  color: var(--muted);
  text-transform: capitalize;
  white-space: nowrap;
}

.model-scrollbar {
  position: absolute;
  top: 12px;
  right: 4px;
  bottom: 12px;
  width: 8px;
  z-index: 3;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  opacity: 0;
  transition: opacity 0.18s ease;
}

.model-menu:hover .model-scrollbar,
.model-scrollbar.is-dragging {
  opacity: 1;
}

.model-scrollbar.is-off {
  display: none;
}

.model-scrollbar-thumb {
  position: absolute;
  left: 1px;
  width: 6px;
  border-radius: 999px;
  cursor: pointer;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--ink) 42%, transparent),
    color-mix(in srgb, var(--ink) 26%, transparent)
  );
  transition: background 0.14s ease;
}

.model-scrollbar-thumb:hover,
.model-scrollbar.is-dragging .model-scrollbar-thumb {
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--accent, #2f6df6) 62%, var(--ink)),
    color-mix(in srgb, var(--accent, #2f6df6) 40%, var(--ink))
  );
}

.model-menu-fade-enter-active,
.model-menu-fade-leave-active {
  transition: opacity 0.14s ease, transform 0.14s ease;
}

.model-menu-fade-enter-from,
.model-menu-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

@media (max-width: 720px) {
  .model-list {
    grid-template-columns: 1fr;
  }

  :deep(.top) {
    gap: 8px;
    padding-top: calc(10px + var(--safe-top));
    padding-bottom: 10px;
  }

  :deep(.actions) {
    gap: 6px;
  }

  :deep(.meta) {
    display: none;
  }

  :deep(.brand-mark) {
    font-size: 17px;
  }

  :deep(.thread) {
    padding: 18px var(--pad) 16px;
    gap: 20px;
  }

  .body {
    padding: 12px 14px;
  }

  .body-actions {
    opacity: 1;
    pointer-events: auto;
  }

  :deep(.composer) {
    padding-top: 10px;
  }

  .composer-toolbar {
    flex-wrap: wrap;
  }

  .toolbar-right {
    order: 2;
  }

  .tool-btn {
    padding: 0;
    gap: 4px;
    width: 30px;
    height: 30px;
    border-radius: 9px;
  }

  .back-top-btn {
    bottom: calc(160px + var(--safe-bottom));
    right: 20px;
    width: 40px;
    height: 40px;
    z-index: 20;
    box-shadow: 0 3px 12px rgba(0, 0, 0, 0.14);
  }
}

@media (min-width: 900px) {
  :deep(.thread),
  :deep(.composer),
  :deep(.top) {
    padding-left: 8vw;
    padding-right: 8vw;
  }

  :deep(.brand-mark) {
    font-size: 24px;
  }
}

.back-top-btn {
  position: fixed;
  bottom: 60px;
  right: 20px;
  z-index: 99;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: var(--surface, var(--panel));
  color: var(--ink-2, var(--ink));
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  transition: background 0.15s, color 0.15s, transform 0.15s, box-shadow 0.15s;
}

.back-top-btn:hover {
  background: var(--ink);
  color: var(--surface, var(--panel));
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
  transform: translateY(-2px);
}

.back-top-btn:active {
  transform: translateY(0) scale(0.92);
}

.back-top-enter-active,
.back-top-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.back-top-enter-from,
.back-top-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

.scan-overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  padding: 24px var(--pad);
  background: color-mix(in srgb, #0f172a 46%, transparent);
  backdrop-filter: blur(5px);
}

.scan-dialog {
  width: min(560px, 100%);
  max-height: min(82dvh, 680px);
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 18px 16px;
  border: 1px solid color-mix(in srgb, #0f766e 24%, var(--line));
  border-radius: calc(var(--radius) + 10px);
  background: var(--panel);
  box-shadow: 0 28px 72px color-mix(in srgb, #0f172a 32%, transparent);
  overflow: hidden;
}

.scan-dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
}

.scan-dialog-title {
  min-width: 0;
}

.scan-dialog h2 {
  margin: 0;
  font-size: 17px;
  letter-spacing: -0.01em;
}

.scan-lead {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.55;
}

.scan-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: color-mix(in srgb, #0f766e 6%, var(--fill-soft));
  flex-shrink: 0;
}

.scan-toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.dry-run {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 12.5px;
  cursor: pointer;
  user-select: none;
}

.dry-run input {
  accent-color: #0f766e;
}

.solid {
  height: 34px;
  padding: 0 14px;
  border: none;
  border-radius: 10px;
  background: #0f766e;
  color: #fff;
  font-size: 12.5px;
  font-weight: 700;
  cursor: pointer;
}

.solid:hover:not(:disabled) {
  background: #0d9488;
}

.solid:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.ghost.icon {
  width: 34px;
  height: 34px;
  padding: 0;
  font-size: 20px;
  line-height: 1;
  flex-shrink: 0;
}

.scan-note {
  margin: 0;
  padding: 8px 11px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, #0f766e 22%, var(--line));
  background: color-mix(in srgb, #0f766e 8%, var(--panel));
  color: color-mix(in srgb, #0f766e 72%, var(--ink));
  font-size: 12.5px;
  line-height: 1.45;
  flex-shrink: 0;
}

.banner {
  margin: 0;
  padding: 10px 12px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.5;
  flex-shrink: 0;
}

.banner.error {
  border: 1px solid color-mix(in srgb, #ef4444 28%, var(--line));
  color: #b91c1c;
  background: color-mix(in srgb, #ef4444 8%, var(--panel));
}

.scan-list-wrap {
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
}

.scan-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  flex-shrink: 0;
}

.scan-list-count {
  min-width: 1.5em;
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.scan-jobs {
  list-style: none;
  margin: 0;
  padding: 0 2px 2px 0;
  display: grid;
  gap: 8px;
  overflow: auto;
  min-height: 0;
}

.scan-job {
  display: grid;
  gap: 8px;
  padding: 11px 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--ink) 2%, var(--panel));
}

.scan-job[data-severity="critical"] {
  border-color: color-mix(in srgb, #ef4444 28%, var(--line));
  background: color-mix(in srgb, #ef4444 5%, var(--panel));
}

.scan-job[data-severity="warn"] {
  border-color: color-mix(in srgb, #d97706 26%, var(--line));
  background: color-mix(in srgb, #d97706 5%, var(--panel));
}

.scan-job[data-severity="ok"] {
  border-color: color-mix(in srgb, #059669 22%, var(--line));
}

.job-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}

.job-status {
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  font-size: 11px;
  font-weight: 700;
}

.job-status[data-status="succeeded"] {
  background: color-mix(in srgb, #12b981 16%, transparent);
  color: #047857;
}

.job-status[data-status="failed"],
.job-status[data-status="cancelled"] {
  background: color-mix(in srgb, #ef4444 14%, transparent);
  color: #b91c1c;
}

.job-status[data-status="running"],
.job-status[data-status="queued"] {
  background: color-mix(in srgb, #0284c7 14%, transparent);
  color: #0369a1;
}

.job-status[data-status="partial"],
.job-status[data-status="skipped"] {
  background: color-mix(in srgb, #d97706 14%, transparent);
  color: #b45309;
}

.job-date {
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.job-dry {
  padding: 1px 6px;
  border-radius: 6px;
  background: color-mix(in srgb, #d97706 14%, transparent);
  color: #b45309;
  font-size: 11px;
  font-weight: 700;
}

.job-id {
  margin-left: auto;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}

.job-summary {
  margin: 0;
  color: var(--ink);
  font-size: 12.5px;
  line-height: 1.55;
  word-break: break-word;
}

.scan-empty {
  margin: 0;
  padding: 28px 12px;
  border: 1px dashed var(--line);
  border-radius: 12px;
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}

@media (max-width: 560px) {
  .scan-toolbar {
    align-items: stretch;
  }

  .scan-toolbar-actions {
    width: 100%;
  }

  .scan-toolbar-actions .ghost,
  .scan-toolbar-actions .solid {
    flex: 1;
  }

  .job-id {
    margin-left: 0;
  }
}
</style>
