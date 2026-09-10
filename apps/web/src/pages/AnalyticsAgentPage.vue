<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { useRoute } from "vue-router";
import {
  askAnalytics,
  fetchAnalyticsModels,
  getAnalyticsScanJob,
  getApiErrorToken,
  listAnalyticsScanJobs,
  runAnalyticsScan,
  type AnalyticsAskResult,
  type AnalyticsAskTable,
  type AnalyticsScanJob,
  type ModelInfo,
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
import type { TableView } from "../types";
import { getUiLocale } from "../ui-locale";

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
  error?: string;
  pending?: boolean;
  welcome?: boolean;
  cancelled?: boolean;
};

type AnalyticsConversation = {
  id: string;
  title: string;
  messages: AnalyticsBubble[];
  createdAt: number;
  updatedAt: number;
};

const STORAGE_KEY = "bx-analytics-conversations-v1";
const MODEL_CACHE_KEY = "bx-analytics-agent-model-v1";
const ACTIVE_KEY = "bx-analytics-active-conv-v1";

const route = useRoute();
const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

const renderMarkdown = renderChatMarkdown;

function welcomeBubble(): AnalyticsBubble {
  return {
    id: "welcome",
    role: "assistant",
    welcome: true,
    text: tx(
      "你好，我是数据分析 Agent。用自然语言问数即可，结果来自 Metabase。尽量写明日期或时间范围，例如：「八月二十到二十一印度A按天观看人数」。",
      "Hi, I'm the Analytics Agent. Ask in natural language — results come from Metabase. Prefer an explicit date or range, e.g. “viewers by day for India A from Aug 20–21”.",
      "Ola, sou o Agent de Analise. Pergunte em linguagem natural — resultados do Metabase. Prefira data ou intervalo, ex.: visualizadores por dia India A de 20–21 ago.",
      "नमस्ते, मैं एनालिटिक्स एजेंट हूँ। प्राकृतिक भाषा में पूछें — परिणाम Metabase से। स्पष्ट तिथि दें, जैसे भारत A 20–21 अगस्त दैनिक व्यूअर्स।",
    ),
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

function loadConversations(): { list: AnalyticsConversation[]; activeId: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as AnalyticsConversation[]) : [];
    const list = Array.isArray(parsed)
      ? parsed.filter((c) => c && typeof c.id === "string" && Array.isArray(c.messages))
      : [];
    const savedActive = localStorage.getItem(ACTIVE_KEY) || "";
    if (!list.length) {
      const first = blankConversation();
      return { list: [first], activeId: first.id };
    }
    const activeId = list.some((c) => c.id === savedActive) ? savedActive : list[0].id;
    return { list, activeId };
  } catch {
    const first = blankConversation();
    return { list: [first], activeId: first.id };
  }
}

const boot = loadConversations();
const conversations = ref<AnalyticsConversation[]>(boot.list);
const activeId = ref(boot.activeId);

const shellRef = ref<{ threadEl: HTMLElement | null } | null>(null);
const threadTrackEl = ref<HTMLElement | null>(null);
const threadThumbEl = ref<HTMLElement | null>(null);
const input = ref("");
const sending = ref(false);
const composerInput = ref<HTMLTextAreaElement | null>(null);
const composerH = ref<number | null>(null);
const scrollTop = ref(0);
const copiedId = ref<string | null>(null);
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

function persistConversations() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations.value));
    localStorage.setItem(ACTIVE_KEY, activeId.value);
  } catch {
    /* ignore quota */
  }
}

function touchActive(mutator: (conv: AnalyticsConversation) => void) {
  const idx = conversations.value.findIndex((c) => c.id === activeId.value);
  if (idx < 0) return;
  const next = { ...conversations.value[idx], messages: [...conversations.value[idx].messages] };
  mutator(next);
  next.updatedAt = Date.now();
  const copy = [...conversations.value];
  copy[idx] = next;
  conversations.value = copy;
  persistConversations();
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
  return {
    title: table.grain ? `${table.title} · ${table.grain}` : table.title,
    total: rows.length,
    columns,
    rows,
  };
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
  const conv = blankConversation();
  conversations.value = [...conversations.value, conv];
  activeId.value = conv.id;
  persistConversations();
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
  if (sending.value) cancelSend();
  activeId.value = id;
  persistConversations();
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

function ensureBlankConversation() {
  const conv = blankConversation();
  conversations.value = [...conversations.value, conv];
  activeId.value = conv.id;
}

function closeConversations(ids: string[], keepId?: string) {
  if (!ids.length) {
    hideTabMenu();
    return;
  }
  const idSet = new Set(ids);
  const prevActive = activeId.value;
  const prevIdx = conversations.value.findIndex((c) => c.id === prevActive);
  conversations.value = conversations.value.filter((c) => !idSet.has(c.id));
  if (keepId && conversations.value.some((c) => c.id === keepId)) {
    activeId.value = keepId;
  } else if (!conversations.value.length) {
    ensureBlankConversation();
  } else if (idSet.has(prevActive)) {
    const next = conversations.value[Math.min(Math.max(prevIdx, 0), conversations.value.length - 1)];
    activeId.value = next.id;
  }
  persistConversations();
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
  const label = id
    ? availableModels.value.find((m) => m.id === id)?.label || id
    : tx("Auto（服务端自动）", "Auto (server managed)", "Auto (gerenciado pelo servidor)", "Auto (सर्वर प्रबंधित)");
  selectedModelLabel.value = id ? label : "Auto";
  writeModelCache(MODEL_CACHE_KEY, id, selectedModelLabel.value);
  modelMenuOpen.value = false;
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
  if (!text || sending.value) return;
  sending.value = true;
  const controller = new AbortController();
  activeController.value = controller;

  const userBubble: AnalyticsBubble = { id: uid(), role: "user", text };
  const pendingId = uid();
  touchActive((conv) => {
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
      conv.title = text.slice(0, 28) || defaultConversationTitle();
    }
  });
  input.value = "";
  composerH.value = null;
  document.documentElement.style.setProperty("--composer-max", "");
  await nextTick();
  resizeComposer();
  await scrollBottom();

  try {
    const data = await askAnalytics(text, {
      model: selectedModel.value ?? undefined,
      signal: controller.signal,
    });
    touchActive((conv) => {
      conv.messages = conv.messages.map((m) =>
        m.id === pendingId
          ? {
              id: pendingId,
              role: "assistant",
              text: data.message || data.error || (data.status === "ok" ? tx("查询完成", "Done") : ""),
              status: data.status,
              timeEcho: data.timeEcho,
              tables: data.tables,
              sqls: data.sqls,
              probeSummary: data.probeSummary,
              error: data.status === "error" ? data.error || data.message : undefined,
              pending: false,
            }
          : m,
      );
    });
  } catch (err) {
    if (isAbortError(err)) {
      touchActive((conv) => {
        conv.messages = conv.messages.map((m) =>
          m.id === pendingId
            ? {
                id: pendingId,
                role: "assistant",
                text: "",
                pending: false,
                cancelled: true,
              }
            : m,
        );
      });
    } else {
      touchActive((conv) => {
        conv.messages = conv.messages.map((m) =>
          m.id === pendingId
            ? {
                id: pendingId,
                role: "assistant",
                text: formatRequestError(err),
                status: "error",
                error: formatRequestError(err),
                pending: false,
              }
            : m,
        );
      });
    }
  } finally {
    if (activeController.value === controller) activeController.value = null;
    sending.value = false;
    await scrollBottom();
    composerInput.value?.focus();
  }
}

function onComposerKeydown(ev: KeyboardEvent) {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    void send();
  }
}

function onWindowPointerDown(e: MouseEvent) {
  if (tabMenu.value) hideTabMenu();
  if (!modelMenuOpen.value) return;
  const t = e.target as HTMLElement | null;
  if (!t || !t.closest(".model-switch")) modelMenuOpen.value = false;
}

watch(uiLocale, () => {
  for (const conv of conversations.value) {
    if (!conv.messages.some((m) => m.role === "user")) {
      /* welcome is virtual when empty */
    }
  }
  if (selectedModel.value === null) {
    selectedModelLabel.value = "Auto";
  }
});

onMounted(async () => {
  window.addEventListener("mousedown", onWindowPointerDown);
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
    if (selectedModel.value && !availableModels.value.some((m) => m.id === selectedModel.value)) {
      selectModel(null);
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
  window.removeEventListener("mousedown", onWindowPointerDown);
  threadScrollbarCleanup?.();
  threadScrollbarCleanup = null;
  modelScrollbarCleanup?.();
  modelScrollbarCleanup = null;
  activeController.value?.abort();
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
          v-if="item.text || item.tables?.length || item.sqls?.length || item.probeSummary || item.pending"
          class="body-wrap"
        >
          <p v-if="item.status && item.role === 'assistant' && !item.pending" class="status-line" :data-status="item.status">
            <span class="status-pill">{{ item.status }}</span>
            <span v-if="item.timeEcho" class="time-echo">{{ item.timeEcho }}</span>
          </p>

          <div
            v-if="item.text && !item.pending"
            class="body"
            :class="{ error: item.status === 'error' || item.status === 'refuse' }"
            v-html="renderMarkdown(item.text)"
          />

          <div v-if="item.tables?.length" class="msg-tables">
            <ResultTable
              v-for="(table, idx) in item.tables"
              :key="`${item.id}-t${idx}`"
              :table="toTableView(table)"
            />
          </div>

          <details v-if="item.sqls?.length" class="sql">
            <summary>{{ tx("查看 SQL", "View SQL", "Ver SQL", "SQL देखें") }} ({{ item.sqls.length }})</summary>
            <pre v-for="(sql, idx) in item.sqls" :key="idx">{{ sql }}</pre>
          </details>

          <p v-if="item.probeSummary" class="probe">
            <span class="label">probe</span>
            {{ item.probeSummary }}
          </p>

          <div v-if="!item.welcome && !item.pending && (item.text || item.tables?.length)" class="body-actions">
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
          class="loading status-busy"
          role="status"
          :aria-label="tx('正在查询', 'Asking')"
        >
          <span class="loading-dot" />
          <span class="loading-text">{{ item.text || tx("正在查询…", "Asking…") }}</span>
        </div>
        <p v-if="item.error && !item.pending" class="error">{{ item.error }}</p>
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
    </template>

    <template #composer>
      <form @submit.prevent="sending ? cancelSend() : send()">
        <div class="composer-card">
          <div
            class="composer-grip"
            :title="tx('上下拖动调整输入框高度', 'Drag up or down to resize the composer', 'Arraste para cima ou para baixo para redimensionar a caixa de entrada', 'कंपोज़र का आकार बदलने के लिए ऊपर या नीचे खींचें')"
            @pointerdown="startComposerDrag"
            @mousedown="startComposerDrag"
            @touchstart="startComposerDrag"
          />
          <textarea
            ref="composerInput"
            v-model="input"
            class="composer-input"
            name="analytics-ask"
            rows="1"
            enterkeyhint="send"
            :style="composerH != null ? { height: composerH + 'px' } : undefined"
            :disabled="sending"
            :placeholder="tx(
              '例如：八月二十到二十一印度A按天观看人数',
              'e.g. viewers by day for India A from Aug 20–21',
              'ex.: visualizadores por dia India A de 20–21 ago',
              'उदा.: भारत A 20–21 अगस्त दैनिक व्यूअर्स',
            )"
            @keydown="onComposerKeydown"
            @input="resizeComposer"
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
                  v-if="modelMenuOpen"
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
                    @click="selectModel(null)"
                  >
                    <span class="model-auto-dot" />
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
                type="submit"
                class="send-btn"
                :class="{ stopping: sending }"
                :title="sending ? tx('停止生成', 'Stop generating', 'Parar geracao', 'जनरेशन रोकें') : tx('发送', 'Send', 'Enviar', 'भेजें')"
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
  background: var(--agent-accent, var(--ink));
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

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-index {
  flex: none;
  min-width: 1.1em;
  color: var(--muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.tab.active .tab-index {
  color: var(--agent-accent, var(--ink));
}

.tab-close {
  flex: none;
  width: 22px;
  height: 22px;
  margin-right: 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease;
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
  width: 6px;
  z-index: 5;
  opacity: 0.35;
  transition: opacity 0.15s ease;
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
  left: 0;
  width: 100%;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 28%, transparent);
  cursor: grab;
}

.thread-scrollbar-thumb:hover,
.thread-scrollbar.is-dragging .thread-scrollbar-thumb {
  background: color-mix(in srgb, var(--agent-accent, var(--ink)) 55%, transparent);
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

.body.error {
  color: #b91c1c;
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
}

.model-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ink) 7%, transparent);
}

.model-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.model-btn.active {
  background: color-mix(in srgb, var(--ink) 10%, transparent);
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
}

.model-menu::-webkit-scrollbar {
  display: none;
}

.model-menu-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.model-menu-title {
  font-size: 13px;
  font-weight: 600;
}

.model-menu-count {
  color: var(--muted);
  font-size: 12px;
}

.model-group-title {
  margin: 10px 0 6px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.model-list {
  display: grid;
  gap: 4px;
}

.model-item {
  width: 100%;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 10px;
  align-items: center;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--ink);
  text-align: left;
  cursor: pointer;
  font: inherit;
}

.model-item:hover {
  background: color-mix(in srgb, var(--ink) 6%, transparent);
}

.model-item.selected {
  border-color: color-mix(in srgb, var(--agent-accent, var(--ink)) 35%, var(--line));
  background: color-mix(in srgb, var(--agent-accent, var(--ink)) 8%, transparent);
}

.model-item-auto {
  grid-template-columns: auto 1fr auto;
}

.model-auto-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--agent-accent, #0f766e);
}

.model-label {
  font-size: 13px;
  font-weight: 500;
}

.model-badge {
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, #0369a1 14%, transparent);
  color: #0369a1;
  font-size: 10px;
  font-weight: 700;
}

.model-provider {
  grid-column: 2;
  color: var(--muted);
  font-size: 11px;
}

.model-item-auto .model-provider {
  grid-column: 3;
}

.model-scrollbar {
  position: absolute;
  top: 12px;
  right: 4px;
  bottom: 12px;
  width: 6px;
  opacity: 0;
  transition: opacity 0.15s ease;
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
  left: 0;
  width: 100%;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 28%, transparent);
  cursor: grab;
}

.model-menu-fade-enter-active,
.model-menu-fade-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.model-menu-fade-enter-from,
.model-menu-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
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
  color: var(--ink);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.back-top-btn:hover {
  background: var(--ink);
  color: var(--panel);
  transform: translateY(-2px);
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

@media (max-width: 720px) {
  .body-actions {
    opacity: 1;
    pointer-events: auto;
  }

  .back-top-btn {
    bottom: 88px;
    right: 14px;
  }
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
