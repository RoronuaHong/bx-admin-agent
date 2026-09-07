<script setup lang="ts">
import { RouterLink } from "vue-router";
import ThemeToggle from "./ThemeToggle.vue";
import UiLocaleSelect from "./UiLocaleSelect.vue";
import { getUiLocale } from "../ui-locale";
import { pickLocalized, type LocalizedText } from "../localize";

const props = defineProps<{
  title: LocalizedText;
  kicker: LocalizedText;
  lead: LocalizedText;
  bullets: LocalizedText[];
}>();

const uiLocale = getUiLocale();

function pickText(item: LocalizedText) {
  return pickLocalized(uiLocale.value, item);
}
</script>

<template>
  <main class="stage">
    <header class="top">
      <div class="identity">
        <RouterLink class="back" to="/">{{ pickText({ zh: "返回门户", en: "Back to portal", pt: "Voltar ao portal", hi: "पोर्टल पर वापस" }) }}</RouterLink>
        <h1>{{ pickText(title) }}</h1>
      </div>
      <div class="top-actions">
        <UiLocaleSelect />
        <ThemeToggle />
      </div>
    </header>

    <section class="panel">
      <p class="kicker">{{ pickText(kicker) }}</p>
      <p class="lead">{{ pickText(lead) }}</p>
      <ul class="list">
        <li v-for="(item, idx) in bullets" :key="idx">{{ pickText(item) }}</li>
      </ul>
      <div class="actions">
        <RouterLink class="ghost" to="/">{{ pickText({ zh: "返回 Agent 门户", en: "Return to portal", pt: "Voltar ao portal", hi: "पोर्टल पर लौटें" }) }}</RouterLink>
        <RouterLink class="solid" to="/agents/admin/chat">{{ pickText({ zh: "查看已上线 Agent", en: "Open live agent", pt: "Abrir agente ativo", hi: "सक्रिय एजेंट खोलें" }) }}</RouterLink>
      </div>
    </section>
  </main>
</template>

<style scoped>
.stage {
  min-height: 100dvh;
  padding: calc(20px + var(--safe-top)) var(--pad) calc(24px + var(--safe-bottom));
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
}

.back:hover {
  color: var(--ink);
}

h1 {
  margin: 0;
  font-size: clamp(30px, 5vw, 48px);
}

.top-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.panel {
  max-width: 760px;
  margin-top: 28px;
  padding: 24px;
  border: 1px solid var(--line);
  border-radius: calc(var(--radius) + 4px);
  background: color-mix(in srgb, var(--panel) 88%, var(--fill));
}

.kicker {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.lead {
  margin: 16px 0 0;
  line-height: 1.75;
  color: var(--muted);
}

.list {
  margin: 18px 0 0;
  padding-left: 18px;
  color: var(--ink);
  line-height: 1.8;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 24px;
}

.ghost,
.solid {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 36px;
  padding: 0 14px;
  border-radius: var(--radius-sm);
  text-decoration: none;
  font-size: 13px;
}

.ghost {
  border: 1px solid var(--line);
  color: var(--muted);
}

.ghost:hover {
  color: var(--ink);
  background: var(--fill-soft);
}

.solid {
  border: 1px solid var(--ink);
  background: var(--ink);
  color: var(--bg);
}

@media (max-width: 720px) {
  .top {
    flex-direction: column;
  }
}
</style>
