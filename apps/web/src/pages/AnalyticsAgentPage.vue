<script setup lang="ts">
import { computed, ref, shallowRef } from "vue";
import { RouterLink, useRouter } from "vue-router";
import {
  askAnalytics,
  fetchMe,
  getApiErrorToken,
  logout,
  type AnalyticsAskResult,
  type AnalyticsAskTable,
  type Me,
} from "../api";
import ResultTable from "../components/ResultTable.vue";
import ThemeToggle from "../components/ThemeToggle.vue";
import UiLocaleSelect from "../components/UiLocaleSelect.vue";
import { localizeToken } from "../localize";
import type { TableView } from "../types";
import { getUiLocale } from "../ui-locale";

const router = useRouter();
const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

const me = shallowRef<Me | null>(null);
const input = ref("");
const loading = ref(false);
const lastQuestion = ref("");
const result = shallowRef<AnalyticsAskResult | null>(null);
const requestError = ref("");

fetchMe().then((session) => {
  me.value = session;
});

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

const displayTables = computed(() => (result.value?.tables || []).map(toTableView));

const statusTone = computed(() => {
  const status = result.value?.status;
  if (status === "ok") return "ok";
  if (status === "clarify") return "clarify";
  if (status === "refuse" || status === "error") return "error";
  return "";
});

async function onLogout() {
  await logout();
  me.value = null;
  await router.replace({ path: "/agents/admin/login", query: { next: "/analytics" } });
}

async function send() {
  const text = input.value.trim();
  if (!text || loading.value) return;
  loading.value = true;
  requestError.value = "";
  result.value = null;
  lastQuestion.value = text;
  try {
    const data = await askAnalytics(text);
    result.value = data;
    input.value = "";
  } catch (err) {
    const status = (err as Error & { status?: number }).status;
    if (status === 401) {
      await router.replace({ path: "/agents/admin/login", query: { next: "/analytics" } });
      return;
    }
    requestError.value = localizeToken(uiLocale.value, getApiErrorToken(err), "GENERIC_UNKNOWN_ERROR")
      || (err instanceof Error ? err.message : tx("请求失败", "Request failed"));
  } finally {
    loading.value = false;
  }
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    void send();
  }
}
</script>

<template>
  <main class="stage">
    <header class="top">
      <div class="identity">
        <RouterLink class="back" to="/">{{ tx("返回门户", "Back to portal", "Voltar ao portal", "पोर्टल पर वापस") }}</RouterLink>
        <h1>{{ tx("数据分析 Agent", "Analytics Agent", "Agent de Analise", "एनालिटिक्स एजेंट") }}</h1>
        <p class="lead">
          {{ tx(
            "用自然语言问数，结果来自 Metabase。请尽量写明日期或时间范围。",
            "Ask in natural language; results come from Metabase. Prefer an explicit date or time range.",
            "Pergunte em linguagem natural; os resultados vem do Metabase. Prefira uma data ou intervalo explicito.",
            "प्राकृतिक भाषा में पूछें; परिणाम Metabase से आते हैं। स्पष्ट तिथि या समय सीमा दें।",
          ) }}
        </p>
      </div>
      <div class="top-actions">
        <span v-if="me" class="session">{{ me.country.label }} · {{ me.user.name || me.user.loginName }}</span>
        <button v-if="me" type="button" class="ghost" @click="onLogout">{{ tx("退出", "Sign out", "Sair", "साइन आउट") }}</button>
        <UiLocaleSelect />
        <ThemeToggle />
      </div>
    </header>

    <section class="composer" aria-label="analytics ask">
      <textarea
        v-model="input"
        rows="3"
        :disabled="loading"
        :placeholder="tx(
          '例如：八月二十到二十一印度A按天观看人数',
          'e.g. viewers by day for India A from Aug 20–21',
          'ex.: visualizadores por dia India A de 20–21 ago',
          'उदा.: भारत A 20–21 अगस्त दैनिक व्यूअर्स',
        )"
        @keydown="onKeydown"
      />
      <div class="composer-actions">
        <button type="button" class="solid" :disabled="loading || !input.trim()" @click="send">
          {{ loading ? tx("查询中…", "Asking…", "Consultando…", "पूछ रहा है…") : tx("发送", "Send", "Enviar", "भेजें") }}
        </button>
      </div>
    </section>

    <p v-if="requestError" class="banner error" role="alert">{{ requestError }}</p>

    <section v-if="result || lastQuestion" class="result" aria-live="polite">
      <p v-if="lastQuestion" class="question">
        <span class="label">{{ tx("问题", "Question", "Pergunta", "प्रश्न") }}</span>
        {{ lastQuestion }}
      </p>

      <template v-if="result">
        <p v-if="result.timeEcho" class="echo">
          <span class="label">{{ tx("时间", "Time", "Tempo", "समय") }}</span>
          {{ result.timeEcho }}
        </p>

        <p class="message" :class="statusTone">
          <span class="status">{{ result.status }}</span>
          {{ result.message || result.error || "" }}
        </p>

        <div v-for="(table, idx) in displayTables" :key="`${table.title}-${idx}`" class="table-block">
          <ResultTable :table="table" />
        </div>

        <details v-if="result.sqls?.length" class="sql">
          <summary>{{ tx("查看 SQL", "View SQL", "Ver SQL", "SQL देखें") }} ({{ result.sqls.length }})</summary>
          <pre v-for="(sql, idx) in result.sqls" :key="idx">{{ sql }}</pre>
        </details>

        <p v-if="result.probeSummary" class="probe">
          <span class="label">probe</span>
          {{ result.probeSummary }}
        </p>
      </template>
    </section>
  </main>
</template>

<style scoped>
.stage {
  min-height: 100dvh;
  padding: calc(20px + var(--safe-top)) var(--pad) calc(28px + var(--safe-bottom));
  max-width: 1100px;
  margin: 0 auto;
}

.top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
}

.identity {
  display: grid;
  gap: 10px;
}

.back {
  color: var(--muted);
  text-decoration: none;
  font-size: 12px;
  width: fit-content;
}

.back:hover {
  color: var(--ink);
}

h1 {
  margin: 0;
  font-size: clamp(28px, 5vw, 44px);
  line-height: 1.05;
}

.lead {
  margin: 0;
  max-width: 62ch;
  color: var(--muted);
  line-height: 1.65;
  font-size: 14px;
}

.top-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px;
  border: 1px solid color-mix(in srgb, var(--line) 88%, var(--ink) 12%);
  border-radius: calc(var(--radius) + 2px);
  background: color-mix(in srgb, var(--panel) 88%, var(--fill));
}

.session {
  font-size: 12px;
  color: var(--muted);
  padding: 0 6px;
}

.ghost {
  height: 32px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.ghost:hover {
  color: var(--ink);
  background: color-mix(in srgb, var(--panel) 72%, var(--fill));
  border-color: color-mix(in srgb, var(--line) 76%, var(--ink) 24%);
}

.composer {
  margin-top: 28px;
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: calc(var(--radius) + 4px);
  background: color-mix(in srgb, var(--panel) 88%, var(--fill));
}

.composer textarea {
  width: 100%;
  resize: vertical;
  min-height: 84px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--fill);
  color: var(--ink);
  font: inherit;
  line-height: 1.55;
}

.composer textarea:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--ink) 28%, var(--line));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ink) 10%, transparent);
}

.composer-actions {
  display: flex;
  justify-content: flex-end;
}

.solid {
  height: 36px;
  padding: 0 18px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--ink);
  color: var(--fill);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.solid:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.banner {
  margin: 16px 0 0;
  padding: 10px 12px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.55;
}

.banner.error {
  border: 1px solid color-mix(in srgb, #ef4444 28%, var(--line));
  color: #b91c1c;
  background: color-mix(in srgb, #ef4444 10%, var(--panel));
}

.result {
  margin-top: 22px;
  display: grid;
  gap: 14px;
}

.question,
.echo,
.message,
.probe {
  margin: 0;
  line-height: 1.6;
  font-size: 14px;
}

.label {
  display: inline-block;
  margin-right: 8px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.message {
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--fill-soft, color-mix(in srgb, var(--fill) 70%, var(--panel)));
}

.message .status {
  display: inline-flex;
  margin-right: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}

.message.ok .status {
  color: #0b8a5f;
  background: color-mix(in srgb, #12b981 14%, transparent);
}

.message.clarify .status {
  color: #9a6700;
  background: color-mix(in srgb, #f59e0b 14%, transparent);
}

.message.error .status {
  color: #b91c1c;
  background: color-mix(in srgb, #ef4444 14%, transparent);
}

.table-block {
  min-width: 0;
}

.sql {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 10px 14px;
  background: var(--fill);
}

.sql summary {
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}

.sql pre {
  margin: 10px 0 0;
  padding: 12px;
  overflow: auto;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink) 92%, var(--fill));
  color: color-mix(in srgb, var(--fill) 92%, white);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
}

.probe {
  color: var(--muted);
  font-size: 12px;
}

@media (max-width: 720px) {
  .top {
    flex-direction: column;
  }

  .top-actions {
    width: 100%;
  }
}
</style>
