<script setup lang="ts">
// 运行追踪（可观测，agent-infrastructure §可观测）：把 run 级 JSONL 落到界面上。
// 服务端已按 owner 过滤，这里只做展示——全局视角仍走 CLI 直读 JSONL（见 docs）。
// 它回答的是「最近这些运行发生了什么」：轮次、token、耗时、模型切换、接地纠正与事后核验。
import { computed, onMounted, ref } from "vue";
import { fetchTraceRuns, type RunTraceDto } from "../api";

const loading = ref(false);
const errorText = ref("");
const release = ref("");
const runs = ref<RunTraceDto[]>([]);
const limit = ref(50);

const stats = computed(() => {
  const list = runs.value;
  const ok = list.filter((r) => r.status === "success").length;
  const sum = (pick: (r: RunTraceDto) => number) => list.reduce((acc, r) => acc + (pick(r) || 0), 0);
  return {
    total: list.length,
    ok,
    failed: list.filter((r) => r.status === "failed").length,
    cancelled: list.filter((r) => r.status === "cancelled").length,
    avgRounds: list.length ? (sum((r) => r.rounds ?? 0) / list.length).toFixed(1) : "-",
    tokens: sum((r) => r.tokens ?? 0),
    verified: list.filter((r) => (r.groundingVerifications ?? 0) > 0).length,
    retried: list.filter((r) => (r.groundingRetries ?? 0) > 0).length,
    ungrounded: list.filter((r) => r.ungrounded === true).length,
    fallbacks: sum((r) => r.modelFallbacks ?? 0),
  };
});

async function load() {
  loading.value = true;
  errorText.value = "";
  try {
    const data = await fetchTraceRuns(limit.value);
    runs.value = data.runs || [];
    release.value = data.release || "";
  } catch (err) {
    errorText.value = String((err as Error)?.message || err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function fmtTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

const statusLabel: Record<string, string> = { success: "成功", failed: "失败", cancelled: "取消" };
</script>

<template>
  <div class="trace">
    <header class="trace__head">
      <div>
        <h1 class="trace__title">运行追踪</h1>
        <p class="trace__sub">
          最近 {{ limit }} 次运行（只看本设备）。接地纠正 / 事后核验两列是护栏是否介入的信号，不是错误。
        </p>
      </div>
      <div class="trace__actions">
        <select v-model.number="limit" class="trace__select" @change="load">
          <option :value="20">20</option>
          <option :value="50">50</option>
          <option :value="100">100</option>
        </select>
        <button class="trace__btn" :disabled="loading" @click="load">{{ loading ? "加载中…" : "刷新" }}</button>
        <RouterLink class="trace__btn trace__btn--ghost" to="/">返回门户</RouterLink>
      </div>
    </header>

    <p v-if="errorText" class="trace__error">加载失败：{{ errorText }}</p>

    <section class="trace__cards">
      <div class="trace__card"><span class="trace__k">运行数</span><span class="trace__v">{{ stats.total }}</span></div>
      <div class="trace__card"><span class="trace__k">成功 / 失败 / 取消</span><span class="trace__v">{{ stats.ok }} / {{ stats.failed }} / {{ stats.cancelled }}</span></div>
      <div class="trace__card"><span class="trace__k">平均轮次</span><span class="trace__v">{{ stats.avgRounds }}</span></div>
      <div class="trace__card"><span class="trace__k">token 合计</span><span class="trace__v">{{ stats.tokens }}</span></div>
      <div class="trace__card"><span class="trace__k">事后核验介入</span><span class="trace__v">{{ stats.verified }}</span></div>
      <div class="trace__card"><span class="trace__k">接地纠正</span><span class="trace__v">{{ stats.retried }}</span></div>
      <div class="trace__card"><span class="trace__k">未取证拒答</span><span class="trace__v">{{ stats.ungrounded }}</span></div>
      <div class="trace__card"><span class="trace__k">模型切换</span><span class="trace__v">{{ stats.fallbacks }}</span></div>
    </section>

    <p v-if="!loading && !runs.length && !errorText" class="trace__empty">还没有运行记录。</p>

    <div v-else-if="runs.length" class="trace__table-wrap">
      <table class="trace__table">
        <thead>
          <tr>
            <th>时间</th>
            <th>模型</th>
            <th>状态</th>
            <th>轮次</th>
            <th>工具</th>
            <th>token</th>
            <th>耗时</th>
            <th>核验</th>
            <th>纠正</th>
            <th>版本</th>
            <th>用户输入</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="run in runs" :key="run.runId">
            <td>{{ fmtTime(run.at) }}</td>
            <td>{{ run.model || "-" }}</td>
            <td>
              <span class="trace__status" :class="`trace__status--${run.status}`">
                {{ statusLabel[run.status] || run.status }}
              </span>
              <span v-if="run.ungrounded" class="trace__flag" title="纠正用尽仍未取得工具数据，以确定性拒答收束">未取证</span>
            </td>
            <td>{{ run.rounds ?? "-" }}</td>
            <td>{{ run.toolCalls ?? "-" }}</td>
            <td>{{ run.tokens ?? "-" }}</td>
            <td>{{ fmtDuration(run.durationMs) }}</td>
            <td>{{ run.groundingVerifications ?? 0 }}</td>
            <td>{{ run.groundingRetries ?? 0 }}</td>
            <td>{{ run.release || "-" }}</td>
            <td class="trace__input" :title="run.userText || ''">{{ (run.userText || "-").slice(0, 40) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <footer v-if="release" class="trace__foot">当前版本 {{ release }}</footer>
  </div>
</template>

<style scoped>
.trace {
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px 20px 64px;
  color: var(--text, #1f2328);
}
.trace__head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-start;
  justify-content: space-between;
}
.trace__title {
  margin: 0;
  font-size: 20px;
}
.trace__sub {
  margin: 6px 0 0;
  font-size: 13px;
  opacity: 0.7;
}
.trace__actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.trace__select,
.trace__btn {
  border: 1px solid var(--border, #d8dee4);
  background: var(--surface, #fff);
  color: inherit;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px;
  cursor: pointer;
}
.trace__btn--ghost {
  text-decoration: none;
  display: inline-block;
}
.trace__btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.trace__error {
  margin-top: 12px;
  color: #c0392b;
  font-size: 13px;
}
.trace__cards {
  margin-top: 16px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}
.trace__card {
  border: 1px solid var(--border, #d8dee4);
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.trace__k {
  font-size: 12px;
  opacity: 0.65;
}
.trace__v {
  font-size: 16px;
  font-weight: 600;
}
.trace__empty {
  margin-top: 24px;
  font-size: 13px;
  opacity: 0.7;
}
.trace__table-wrap {
  margin-top: 16px;
  overflow-x: auto;
  border: 1px solid var(--border, #d8dee4);
  border-radius: 10px;
}
.trace__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.trace__table th,
.trace__table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--border, #eaeef2);
  white-space: nowrap;
}
.trace__table th {
  background: var(--surface-2, #f6f8fa);
  font-weight: 600;
}
.trace__table tr:last-child td {
  border-bottom: none;
}
.trace__input {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.trace__status--success {
  color: #1a7f37;
}
.trace__status--failed {
  color: #c0392b;
}
.trace__status--cancelled {
  opacity: 0.7;
}
.trace__flag {
  margin-left: 6px;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: #fff4e5;
  color: #9a6700;
}
.trace__foot {
  margin-top: 14px;
  font-size: 12px;
  opacity: 0.6;
}
</style>
