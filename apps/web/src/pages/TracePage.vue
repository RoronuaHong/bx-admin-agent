<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from "vue";
import { RouterLink, useRouter } from "vue-router";
import {
  fetchMe,
  getApiErrorToken,
  fetchTraceRun,
  fetchTraceRuns,
  logout,
  type Me,
  type TraceRunSummary,
  type TraceRunsStats,
  type TraceSpanDto,
} from "../api";
import AgentChromeNav from "../components/AgentChromeNav.vue";
import ChatShell from "../components/ChatShell.vue";
import ThemeToggle from "../components/ThemeToggle.vue";
import UiLocaleSelect from "../components/UiLocaleSelect.vue";
import { localizeToken } from "../localize";
import { getUiLocale } from "../ui-locale";

const router = useRouter();
const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;
const me = shallowRef<Me | null>(null);
const loading = ref(false);
const error = ref("");
const stats = shallowRef<TraceRunsStats | null>(null);
const runs = shallowRef<TraceRunSummary[]>([]);
const selectedId = ref("");
const spans = shallowRef<TraceSpanDto[]>([]);
const spanRelease = ref("");
const detailLoading = ref(false);

const selected = computed(() => runs.value.find((r) => r.runId === selectedId.value) || null);

const runsCountLabel = computed(() => {
  const n = runs.value.length;
  if (uiLocale.value === "zh") return `${n} 条`;
  if (uiLocale.value === "pt-BR") return `${n} itens`;
  if (uiLocale.value === "hi") return `${n} आइटम`;
  return `${n} items`;
});

async function redirectTraceAccessFallback(status?: number) {
  if (status === 401) {
    await router.replace({ path: "/agents/admin/login", query: { next: "/trace" } });
    return;
  }
  if (status === 403) {
    await router.replace({
      path: "/",
      query: {
        denied: "canViewTrace",
        deniedSource: me.value?.permissions.traceAccessSource || "denied-allowlist",
        deniedFrom: "/trace",
      },
    });
  }
}

function fmtMs(ms?: number) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(n?: number) {
  if (n == null) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function shortText(t?: string, n = 48) {
  if (!t) return "—";
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

function traceText(tokenLike?: { code: string; params?: Record<string, string | number | boolean | null> } | null, fallbackCode = "TRACE_DEGRADE_GENERIC") {
  return localizeToken(uiLocale.value, tokenLike, fallbackCode);
}

async function loadRuns() {
  loading.value = true;
  error.value = "";
  try {
    const data = await fetchTraceRuns(30);
    stats.value = data.stats;
    runs.value = data.runs;
    if (selectedId.value && !data.runs.some((r) => r.runId === selectedId.value)) {
      selectedId.value = "";
      spans.value = [];
    }
  } catch (err) {
    error.value = localizeToken(uiLocale.value, getApiErrorToken(err), "GENERIC_UNKNOWN_ERROR");
    const status = (err as Error & { status?: number }).status;
    if (status === 401 || status === 403) {
      await redirectTraceAccessFallback(status);
    }
  } finally {
    loading.value = false;
  }
}

async function selectRun(runId: string) {
  if (selectedId.value === runId) return;
  selectedId.value = runId;
  detailLoading.value = true;
  spans.value = [];
  try {
    const data = await fetchTraceRun(runId);
    spans.value = data.spans;
    spanRelease.value = data.release || "";
  } catch (err) {
    error.value = localizeToken(uiLocale.value, getApiErrorToken(err), "GENERIC_UNKNOWN_ERROR");
    const status = (err as Error & { status?: number }).status;
    if (status === 401 || status === 403) {
      await redirectTraceAccessFallback(status);
    }
    spans.value = [];
  } finally {
    detailLoading.value = false;
  }
}

async function onLogout() {
  await logout();
  me.value = null;
  await router.replace("/");
}

onMounted(async () => {
  me.value = await fetchMe();
  if (!me.value) {
    await redirectTraceAccessFallback(401);
    return;
  }
  if (!me.value.permissions.entries.trace) {
    await redirectTraceAccessFallback(403);
    return;
  }
  await loadRuns();
});
</script>

<template>
  <ChatShell accent="trace">
    <template #header>
      <div class="identity">
        <p class="brand-kicker">{{ tx("门户只读 · Trace 观察", "Portal read-only · Trace", "Portal somente leitura · Trace", "पोर्टल रीड-ओनली · ट्रेस") }}</p>
        <RouterLink class="brand-mark" to="/">{{ tx("调用观察", "Trace", "Rastreamento", "ट्रेस") }}</RouterLink>
      </div>
      <div class="actions">
        <div v-if="me" class="meta">
          <span>{{ me.country.label }}</span>
          <span>·</span>
          <span>{{ me.user.name || me.user.loginName }}</span>
        </div>
        <button class="ghost" type="button" :disabled="loading" @click="loadRuns">{{ tx("刷新", "Refresh", "Atualizar", "रीफ्रेश") }}</button>
        <RouterLink class="ghost" :to="me ? '/agents/admin/chat' : '/agents/admin/login'">
          {{ me ? tx("工作台", "Workspace", "Espaco de trabalho", "वर्कस्पेस") : tx("登录后台 Agent", "Sign in to Admin Agent", "Entrar no Admin Agent", "एडमिन एजेंट में साइन इन") }}
        </RouterLink>
        <button v-if="me" class="ghost" type="button" @click="onLogout">{{ tx("退出", "Logout", "Sair", "लॉगआउट") }}</button>
        <AgentChromeNav />
        <UiLocaleSelect />
        <ThemeToggle />
      </div>
    </template>

    <template #thread>
      <div class="trace-board">
        <p v-if="error" class="error">{{ error }}</p>

        <section v-if="stats" class="stats" :aria-label="tx('汇总', 'Summary', 'Resumo', 'सारांश')">
          <div class="stat">
            <span class="stat-k">{{ tx("运行数", "Runs", "Execucoes", "रन") }}</span>
            <span class="stat-v">{{ stats.runs }}</span>
          </div>
          <div class="stat">
            <span class="stat-k">{{ tx("平均轮次", "Avg rounds", "Media de rodadas", "औसत राउंड") }}</span>
            <span class="stat-v">{{ stats.avgRounds }}</span>
          </div>
          <div class="stat">
            <span class="stat-k">{{ tx("Token", "Tokens", "Tokens", "टोकन") }}</span>
            <span class="stat-v">{{ fmtTokens(stats.tokens) }}</span>
          </div>
          <div class="stat" :class="{ warn: stats.emptyRoundRate >= 0.2 }">
            <span class="stat-k">{{ tx("空轮率", "Empty round rate", "Taxa de rodadas vazias", "खाली राउंड दर") }}</span>
            <span class="stat-v">{{ stats.emptyRoundRate }}</span>
          </div>
          <div class="stat" :class="{ warn: stats.shortCircuitRuns > 0 }">
            <span class="stat-k">{{ tx("短路次数", "Short circuit", "Curto-circuito", "शॉर्ट सर्किट") }}</span>
            <span class="stat-v">{{ stats.shortCircuitRuns }}</span>
          </div>
          <div class="stat">
            <span class="stat-k">{{ tx("空轮重试", "Empty retries", "Tentativas vazias", "खाली पुनःप्रयास") }}</span>
            <span class="stat-v">{{ stats.emptyRetries }}</span>
          </div>
        </section>

        <p v-if="stats?.degradeHintToken || stats?.degradeHint" class="hint warn-hint">
          {{ traceText(stats?.degradeHintToken, "TRACE_DEGRADE_GENERIC") }}
        </p>
        <p v-else class="hint">
          {{
            tx(
              "门户级只读视图 · 展示主 Agent 的 trace run 与 span 树 · 数据来自 /trace/runs",
              "Portal-level read-only view · shows main agent trace runs and span trees · data from /trace/runs",
              "Visualizacao somente leitura em nivel de portal · mostra execucoes trace e arvores de span do agente principal · dados de /trace/runs",
              "पोर्टल-स्तरीय केवल-पढ़ने योग्य दृश्य · मुख्य एजेंट के ट्रेस रन और स्पैन ट्री दिखाता है · डेटा /trace/runs से",
            )
          }}
        </p>

        <div class="split">
          <section class="pane list-pane">
            <div class="pane-head">
              <h2>{{ tx("最近请求", "Recent Requests", "Solicitacoes Recentes", "हाल की रिक्वेस्ट") }}</h2>
              <span class="muted">{{ loading ? tx("加载中…", "Loading…", "Carregando…", "लोड हो रहा है…") : runsCountLabel }}</span>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{{ tx("时间", "Time", "Hora", "समय") }}</th>
                    <th>{{ tx("模型", "Model", "Modelo", "मॉडल") }}</th>
                    <th>{{ tx("轮次", "Rounds", "Rodadas", "राउंड") }}</th>
                    <th>{{ tx("空轮", "Empty", "Vazio", "खाली") }}</th>
                    <th>{{ tx("Token", "Tokens", "Tokens", "टोकन") }}</th>
                    <th>{{ tx("耗时", "Duration", "Duracao", "अवधि") }}</th>
                    <th>{{ tx("输入", "Input", "Entrada", "इनपुट") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="r in runs"
                    :key="r.runId"
                    :class="{ active: r.runId === selectedId, bad: !!r.error || r.emptyRounds > 0 }"
                    @click="selectRun(r.runId)"
                  >
                    <td class="mono">{{ r.startedAt.slice(11, 19) }}</td>
                    <td>{{ r.model || "—" }}</td>
                    <td class="num">{{ r.llmRounds }}</td>
                    <td class="num">{{ r.emptyRounds }}{{ r.emptyRetries ? `+${r.emptyRetries}` : "" }}</td>
                    <td class="num">{{ fmtTokens(r.totalTokens) }}</td>
                    <td class="num">{{ fmtMs(r.durationMs) }}</td>
                    <td class="clip">{{ shortText(r.userText) }}</td>
                  </tr>
                  <tr v-if="!runs.length && !loading">
                    <td colspan="7" class="empty">{{ tx("暂无 trace", "No trace yet", "Ainda sem trace", "अभी तक कोई ट्रेस नहीं") }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section class="pane detail-pane">
            <div class="pane-head">
              <h2>{{ tx("Span 树", "Span Tree", "Arvore de Span", "स्पैन ट्री") }}</h2>
              <span class="muted mono">{{ selectedId ? selectedId.slice(0, 8) : tx("选中左侧一行", "Select a row on the left", "Selecione uma linha a esquerda", "बाईं ओर एक पंक्ति चुनें") }}</span>
            </div>
            <p v-if="selected" class="detail-meta">
              <span>release {{ selected.release || spanRelease || "—" }}</span>
              <span>·</span>
              <span>{{ selected.model || "—" }}</span>
              <span>·</span>
              <span>{{ fmtTokens(selected.totalTokens) }} tok</span>
            </p>
            <p v-if="detailLoading" class="muted">{{ tx("加载 span…", "Loading span…", "Carregando span…", "स्पैन लोड हो रहा है…") }}</p>
            <ol v-else-if="spans.length" class="spans">
              <li
                v-for="s in spans"
                :key="s.spanId"
                :class="['span', `k-${s.kind}`, { err: s.status === 'error' || s.status === 'reject' }]"
              >
                <span class="kind">{{ s.kind }}</span>
                <span class="name">{{ s.name }}</span>
                <span class="dur">{{ fmtMs(s.durationMs) }}</span>
                <span v-if="s.usage?.totalTokens" class="tok">{{ fmtTokens(s.usage.totalTokens) }}</span>
                <span v-if="s.noteToken || s.note" class="note">{{ traceText(s.noteToken, "TRACE_DEGRADE_GENERIC") }}</span>
                <span v-if="s.errorToken || s.error" class="err-txt">{{ traceText(s.errorToken, "GENERIC_UNKNOWN_ERROR") }}</span>
              </li>
            </ol>
            <p v-else-if="selectedId" class="muted">{{ tx("无 span", "No span", "Sem span", "कोई स्पैन नहीं") }}</p>
            <p v-else class="muted empty-detail">{{ tx("点击左侧请求查看 span 详情", "Click a request on the left to inspect spans", "Clique em uma solicitacao a esquerda para ver os spans", "स्पैन देखने के लिए बाईं ओर अनुरोध पर क्लिक करें") }}</p>
          </section>
        </div>
      </div>
    </template>
  </ChatShell>
</template>

<style scoped>
.trace-board {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  flex: 1;
  width: 100%;
}

.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--agent-accent) 16%, var(--line));
  border-radius: 16px;
  background: color-mix(in srgb, var(--panel) 82%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, white 14%, transparent),
    0 8px 20px color-mix(in srgb, var(--ink) 4%, transparent);
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 88px;
  flex: 1 1 88px;
  padding: 8px 10px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--fill-soft) 70%, transparent);
}

.stat-k {
  font-size: 0.7rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}

.stat-v {
  font-family: var(--font-mono);
  font-size: 1.05rem;
  color: color-mix(in srgb, var(--agent-accent) 28%, var(--ink));
}

.stat.warn .stat-v {
  color: var(--danger);
}

.hint {
  margin: 0;
  font-size: 0.85rem;
  color: var(--muted);
  line-height: 1.5;
}

.warn-hint {
  color: var(--danger);
}

.error {
  margin: 0;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--danger) 28%, var(--line));
  background: color-mix(in srgb, var(--danger) 8%, var(--panel));
  color: var(--danger);
}

.split {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
  gap: 14px;
  flex: 1;
  min-height: 0;
}

.pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  border: 1px solid color-mix(in srgb, var(--agent-accent) 14%, var(--line));
  border-radius: 16px;
  background: color-mix(in srgb, var(--panel) 86%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, white 12%, transparent),
    0 10px 24px color-mix(in srgb, var(--ink) 5%, transparent);
  overflow: hidden;
}

.pane-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 14px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--agent-accent) 12%, var(--line));
}

.pane-head h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.05rem;
  font-weight: 600;
  color: color-mix(in srgb, var(--agent-accent) 22%, var(--ink));
}

.muted {
  color: var(--muted);
  font-size: 0.82rem;
}

.mono {
  font-family: var(--font-mono);
  font-size: 0.82rem;
}

.table-wrap {
  overflow: auto;
  flex: 1;
  min-height: 280px;
  max-height: calc(100dvh - 280px);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.86rem;
}

th,
td {
  text-align: left;
  padding: 9px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 90%, transparent);
  vertical-align: top;
}

th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: color-mix(in srgb, var(--panel) 94%, var(--agent-accent));
  color: var(--muted);
  font-weight: 500;
  font-size: 0.72rem;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

tbody tr {
  cursor: pointer;
  transition: background 0.12s ease;
}

tbody tr:hover {
  background: color-mix(in srgb, var(--agent-accent) 6%, var(--fill-soft));
}

tbody tr.active {
  background: color-mix(in srgb, var(--agent-accent) 10%, transparent);
}

tbody tr.bad .num {
  color: var(--danger);
}

.num {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.clip {
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--muted);
}

.empty,
.empty-detail {
  text-align: center;
  color: var(--muted);
  padding: 28px 12px !important;
}

.detail-pane {
  padding-bottom: 8px;
}

.detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 10px 14px 0;
  font-size: 0.82rem;
  color: var(--muted);
}

.spans {
  list-style: none;
  margin: 0;
  padding: 4px 14px 12px;
  overflow: auto;
  flex: 1;
  min-height: 280px;
  max-height: calc(100dvh - 300px);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.45;
}

.span {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) auto auto;
  gap: 6px 10px;
  padding: 8px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 88%, transparent);
  align-items: baseline;
}

.span .kind {
  color: var(--muted);
  text-transform: uppercase;
  font-size: 0.7rem;
}

.span .name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.span .dur,
.span .tok {
  color: var(--muted);
}

.span .note {
  grid-column: 2 / -1;
  color: var(--ok);
}

.span.err .name,
.span .err-txt {
  color: var(--danger);
}

.span .err-txt {
  grid-column: 2 / -1;
}

@media (max-width: 900px) {
  .split {
    grid-template-columns: 1fr;
  }

  .table-wrap,
  .spans {
    max-height: 42dvh;
  }
}
</style>
