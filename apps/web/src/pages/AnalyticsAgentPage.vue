<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import {
  askAnalytics,
  getAnalyticsScanJob,
  getApiErrorToken,
  listAnalyticsScanJobs,
  runAnalyticsScan,
  type AnalyticsAskResult,
  type AnalyticsAskTable,
  type AnalyticsScanJob,
} from "../api";
import AgentChromeNav from "../components/AgentChromeNav.vue";
import ChatShell from "../components/ChatShell.vue";
import ResultTable from "../components/ResultTable.vue";
import ThemeToggle from "../components/ThemeToggle.vue";
import UiLocaleSelect from "../components/UiLocaleSelect.vue";
import { resizeComposerBox, startComposerResizeDrag } from "../chat-composer";
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
};

const route = useRoute();
const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

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

const shellRef = ref<{ threadEl: HTMLElement | null } | null>(null);
const input = ref("");
const sending = ref(false);
const messages = shallowRef<AnalyticsBubble[]>([welcomeBubble()]);
const composerInput = ref<HTMLTextAreaElement | null>(null);
const composerH = ref<number | null>(null);

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

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

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
  // Metabase 拉取可能超过 10s；约 2 分钟内持续轮询，关闭弹窗即中止。
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
      /* 瞬时失败继续试 */
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
    scanNote.value = tx(
      `已入队 ${shortJobId(jobId)}`,
      `Queued ${shortJobId(jobId)}`,
    );
    // 先插入占位，避免列表空白到首轮 poll
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

onUnmounted(() => {
  scanPollEpoch += 1;
  window.removeEventListener("keydown", onScanKeydown);
});

function clearThread() {
  if (sending.value) return;
  messages.value = [welcomeBubble()];
  composerH.value = null;
  document.documentElement.style.setProperty("--composer-max", "");
  nextTick(resizeComposer);
}

const hasUserMessages = computed(() => messages.value.some((m) => !m.welcome));

watch(uiLocale, () => {
  if (!hasUserMessages.value) messages.value = [welcomeBubble()];
});

async function send() {
  const text = input.value.trim();
  if (!text || sending.value) return;
  sending.value = true;
  const userBubble: AnalyticsBubble = { id: uid(), role: "user", text };
  const pendingId = uid();
  messages.value = [
    ...messages.value.filter((m) => !m.welcome),
    userBubble,
    {
      id: pendingId,
      role: "assistant",
      text: tx("正在查询…", "Asking…"),
      pending: true,
    },
  ];
  input.value = "";
  composerH.value = null;
  document.documentElement.style.setProperty("--composer-max", "");
  await nextTick();
  resizeComposer();
  await scrollBottom();
  try {
    const data = await askAnalytics(text);
    const assistant: AnalyticsBubble = {
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
    };
    messages.value = messages.value.map((m) => (m.id === pendingId ? assistant : m));
  } catch (err) {
    messages.value = messages.value.map((m) =>
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
  } finally {
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

onMounted(() => {
  const q = typeof route.query.q === "string" ? route.query.q.trim() : "";
  const from = typeof route.query.from === "string" ? route.query.from.trim() : "";
  const to = typeof route.query.to === "string" ? route.query.to.trim() : "";
  if (q) {
    input.value = q;
  } else if (from && to) {
    input.value = tx(
      `${from}到${to}按天观看人数`,
      `daily users from ${from} to ${to}`,
    );
  } else if (from) {
    input.value = tx(`${from}观看人数`, `users on ${from}`);
  }
  nextTick(() => {
    resizeComposer();
    composerInput.value?.focus();
  });
});
</script>

<template>
  <ChatShell ref="shellRef" accent="analytics">
    <template #header>
      <div class="identity">
        <p class="brand-kicker">{{ tx("数据分析 · Metabase", "Analytics · Metabase") }}</p>
        <RouterLink class="brand-mark" to="/">{{ tx("数据分析 Agent", "Analytics Agent", "Agent de Analise", "एनालिटिक्स एजेंट") }}</RouterLink>
      </div>
      <div class="actions">
        <button type="button" class="ghost" @click="openScan">{{ tx("巡检", "Scan", "Varredura", "स्कैन") }}</button>
        <button type="button" class="ghost" :disabled="sending || !hasUserMessages" @click="clearThread">
          {{ tx("清空", "Clear", "Limpar", "साफ़ करें") }}
        </button>
        <AgentChromeNav current-key="analytics" />
        <UiLocaleSelect />
        <ThemeToggle />
      </div>
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
        <div class="body">
          <p v-if="item.status && item.role === 'assistant' && !item.pending" class="status-line" :data-status="item.status">
            <span class="status-pill">{{ item.status }}</span>
            <span v-if="item.timeEcho" class="time-echo">{{ item.timeEcho }}</span>
          </p>
          <p class="text" :class="{ pending: item.pending, error: item.status === 'error' || item.status === 'refuse' }">
            {{ item.text }}
          </p>
          <div v-for="(table, idx) in item.tables || []" :key="`${item.id}-t${idx}`" class="table-block">
            <ResultTable :table="toTableView(table)" />
          </div>
          <details v-if="item.sqls?.length" class="sql">
            <summary>{{ tx("查看 SQL", "View SQL", "Ver SQL", "SQL देखें") }} ({{ item.sqls.length }})</summary>
            <pre v-for="(sql, idx) in item.sqls" :key="idx">{{ sql }}</pre>
          </details>
          <p v-if="item.probeSummary" class="probe">
            <span class="label">probe</span>
            {{ item.probeSummary }}
          </p>
        </div>
      </article>
    </template>

    <template #composer>
      <form @submit.prevent="send">
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
            <div class="toolbar-right">
              <button
                type="submit"
                class="send-btn"
                :class="{ stopping: sending }"
                :title="sending ? tx('查询中', 'Asking') : tx('发送', 'Send', 'Enviar', 'भेजें')"
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
}

.ghost:hover:not(:disabled) {
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 6%, transparent);
}

.ghost:disabled {
  opacity: 0.4;
  cursor: not-allowed;
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

.text {
  margin: 0;
  white-space: pre-wrap;
}

.text.pending {
  color: var(--muted);
}

.text.error {
  color: #b91c1c;
}

.table-block {
  margin-top: 12px;
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
  letter-spacing: 0.02em;
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
