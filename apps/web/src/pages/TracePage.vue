<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from "vue";
import { useRouter } from "vue-router";
import {
  fetchMe,
  fetchTraceRun,
  fetchTraceRuns,
  logout,
  type Me,
  type TraceRunSummary,
  type TraceRunsStats,
  type TraceSpanDto,
} from "../api";
import ThemeToggle from "../components/ThemeToggle.vue";

const router = useRouter();
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
    error.value = err instanceof Error ? err.message : "加载失败";
    if ((err as Error & { status?: number }).status === 401) {
      await router.replace("/login");
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
    error.value = err instanceof Error ? err.message : "加载 run 失败";
    spans.value = [];
  } finally {
    detailLoading.value = false;
  }
}

async function onLogout() {
  await logout();
  me.value = null;
  await router.replace("/login");
}

onMounted(async () => {
  me.value = await fetchMe();
  if (!me.value) {
    await router.replace("/login");
    return;
  }
  await loadRuns();
});
</script>

<template>
  <main class="stage">
    <header class="top">
      <div class="identity">
        <RouterLink class="brand-mark" to="/chat">小助手</RouterLink>
        <span class="sep">/</span>
        <span class="page-title">调用观察</span>
      </div>
      <div class="actions">
        <div class="meta">
          <span>{{ me?.country.label }}</span>
          <span>·</span>
          <span>{{ me?.user.name || me?.user.loginName }}</span>
        </div>
        <ThemeToggle />
        <RouterLink class="ghost" to="/chat">对话</RouterLink>
        <button class="ghost" type="button" :disabled="loading" @click="loadRuns">刷新</button>
        <button class="ghost" type="button" @click="onLogout">退出</button>
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <section v-if="stats" class="stats" aria-label="汇总">
      <div class="stat">
        <span class="stat-k">runs</span>
        <span class="stat-v">{{ stats.runs }}</span>
      </div>
      <div class="stat">
        <span class="stat-k">avgRounds</span>
        <span class="stat-v">{{ stats.avgRounds }}</span>
      </div>
      <div class="stat">
        <span class="stat-k">tokens</span>
        <span class="stat-v">{{ fmtTokens(stats.tokens) }}</span>
      </div>
      <div class="stat" :class="{ warn: stats.emptyRoundRate >= 0.2 }">
        <span class="stat-k">emptyRoundRate</span>
        <span class="stat-v">{{ stats.emptyRoundRate }}</span>
      </div>
      <div class="stat" :class="{ warn: stats.shortCircuitRuns > 0 }">
        <span class="stat-k">shortCircuit</span>
        <span class="stat-v">{{ stats.shortCircuitRuns }}</span>
      </div>
      <div class="stat">
        <span class="stat-k">emptyRetries</span>
        <span class="stat-v">{{ stats.emptyRetries }}</span>
      </div>
    </section>

    <p v-if="stats?.degradeHint" class="hint warn-hint">{{ stats.degradeHint }}</p>
    <p v-else class="hint">只读视图 · 仅显示当前登录者的 run · 数据来自 /trace/runs</p>

    <div class="split">
      <section class="list-pane">
        <div class="pane-head">
          <h2>最近请求</h2>
          <span class="muted">{{ loading ? "加载中…" : `${runs.length} 条` }}</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>模型</th>
                <th>轮次</th>
                <th>空轮</th>
                <th>token</th>
                <th>耗时</th>
                <th>输入</th>
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
                <td colspan="7" class="empty">暂无 trace</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="detail-pane">
        <div class="pane-head">
          <h2>Span 树</h2>
          <span class="muted mono">{{ selectedId ? selectedId.slice(0, 8) : "选中左侧一行" }}</span>
        </div>
        <p v-if="selected" class="detail-meta">
          <span>release {{ selected.release || spanRelease || "—" }}</span>
          <span>·</span>
          <span>{{ selected.model || "—" }}</span>
          <span>·</span>
          <span>{{ fmtTokens(selected.totalTokens) }} tok</span>
        </p>
        <p v-if="detailLoading" class="muted">加载 span…</p>
        <ol v-else-if="spans.length" class="spans">
          <li v-for="s in spans" :key="s.spanId" :class="['span', `k-${s.kind}`, { err: s.status === 'error' || s.status === 'reject' }]">
            <span class="kind">{{ s.kind }}</span>
            <span class="name">{{ s.name }}</span>
            <span class="dur">{{ fmtMs(s.durationMs) }}</span>
            <span v-if="s.usage?.totalTokens" class="tok">{{ fmtTokens(s.usage.totalTokens) }}</span>
            <span v-if="s.note" class="note">{{ s.note }}</span>
            <span v-if="s.error" class="err-txt">{{ s.error }}</span>
          </li>
        </ol>
        <p v-else-if="selectedId" class="muted">无 span</p>
      </section>
    </div>
  </main>
</template>

<style scoped>
.stage {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: calc(14px + var(--safe-top)) var(--pad) calc(20px + var(--safe-bottom));
}

.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.identity {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.brand-mark {
  font-family: var(--font-display);
  font-size: 1.35rem;
  font-weight: 600;
  color: var(--ink);
  text-decoration: none;
}

.sep {
  color: var(--muted);
}

.page-title {
  font-size: 0.95rem;
  color: var(--muted);
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.meta {
  display: flex;
  gap: 6px;
  color: var(--muted);
  font-size: 0.88rem;
  margin-right: 4px;
}

.ghost {
  appearance: none;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--ink);
  border-radius: var(--radius-pill);
  padding: 6px 12px;
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
  text-decoration: none;
}

.ghost:hover:not(:disabled) {
  border-color: var(--line-strong);
}

.ghost:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 18px;
  padding: 10px 0;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 72px;
}

.stat-k {
  font-size: 0.72rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}

.stat-v {
  font-family: var(--font-mono);
  font-size: 1.05rem;
}

.stat.warn .stat-v {
  color: var(--danger);
}

.hint {
  margin: 0;
  font-size: 0.85rem;
  color: var(--muted);
}

.warn-hint {
  color: var(--danger);
}

.error {
  margin: 0;
  color: var(--danger);
}

.split {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
  gap: 18px;
  flex: 1;
  min-height: 0;
}

.pane-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}

.pane-head h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.1rem;
  font-weight: 600;
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
  max-height: calc(100dvh - 220px);
  border-top: 1px solid var(--line);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.86rem;
}

th,
td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}

th {
  position: sticky;
  top: 0;
  background: var(--bg);
  color: var(--muted);
  font-weight: 500;
  font-size: 0.75rem;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

tbody tr {
  cursor: pointer;
}

tbody tr:hover {
  background: var(--fill-soft);
}

tbody tr.active {
  background: color-mix(in srgb, var(--ink) 6%, transparent);
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

.empty {
  text-align: center;
  color: var(--muted);
  padding: 24px !important;
}

.detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 10px;
  font-size: 0.82rem;
  color: var(--muted);
}

.spans {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
  max-height: calc(100dvh - 250px);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.45;
}

.span {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) auto auto;
  gap: 6px 10px;
  padding: 7px 0;
  border-bottom: 1px solid var(--line);
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
