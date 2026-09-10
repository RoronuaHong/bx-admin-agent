<script setup lang="ts">
import { RouterLink } from "vue-router";
import type { ChatShellAccent } from "./ChatShell.vue";
import AgentChromeNav from "./AgentChromeNav.vue";
import ChatShell from "./ChatShell.vue";
import ThemeToggle from "./ThemeToggle.vue";
import UiLocaleSelect from "./UiLocaleSelect.vue";
import { getUiLocale } from "../ui-locale";
import { pickLocalized, type LocalizedText } from "../localize";

withDefaults(
  defineProps<{
    title: LocalizedText;
    kicker: LocalizedText;
    welcome: LocalizedText;
    lead: LocalizedText;
    bullets: LocalizedText[];
    accent?: ChatShellAccent;
    /** Portal card key for AgentChromeNav (exclude current). */
    currentKey?: string;
  }>(),
  { accent: "default" },
);

const uiLocale = getUiLocale();

function pickText(item: LocalizedText) {
  return pickLocalized(uiLocale.value, item);
}
</script>

<template>
  <ChatShell :accent="accent">
    <template #header>
      <div class="identity">
        <p class="brand-kicker">{{ pickText(kicker) }}</p>
        <RouterLink class="brand-mark" to="/">{{ pickText(title) }}</RouterLink>
      </div>
      <div class="actions">
        <AgentChromeNav :current-key="currentKey" />
        <UiLocaleSelect />
        <ThemeToggle />
      </div>
    </template>

    <template #thread>
      <article class="msg">
        <div class="who">
          <span class="dot" />
          {{ pickText({ zh: "助手", en: "Assistant", pt: "Assistente", hi: "सहायक" }) }}
        </div>
        <div class="body">
          <p class="welcome">{{ pickText(welcome) }}</p>
        </div>
      </article>
      <article class="msg">
        <div class="who">
          <span class="dot" />
          {{ pickText({ zh: "助手", en: "Assistant", pt: "Assistente", hi: "सहायक" }) }}
        </div>
        <div class="body">
          <p class="lead">{{ pickText(lead) }}</p>
          <ul class="list">
            <li v-for="(item, idx) in bullets" :key="idx">{{ pickText(item) }}</li>
          </ul>
          <div class="inline-actions">
            <RouterLink class="ghost" to="/">{{ pickText({ zh: "返回门户", en: "Back to portal", pt: "Voltar ao portal", hi: "पोर्टल पर लौटें" }) }}</RouterLink>
            <RouterLink class="ghost" to="/analytics">{{ pickText({ zh: "先去问数", en: "Try analytics", pt: "Ir para analise", hi: "एनालिटिक्स खोलें" }) }}</RouterLink>
          </div>
        </div>
      </article>
    </template>

    <template #composer>
      <form @submit.prevent>
        <div class="composer-card is-disabled" aria-disabled="true">
          <div class="composer-grip" aria-hidden="true" />
          <textarea
            class="composer-input"
            rows="1"
            disabled
            name="agent-placeholder-input"
            :placeholder="pickText({
              zh: '对话能力即将上线（独立鉴权，不与后台账号混用）',
              en: 'Chat coming soon (own auth, not shared with admin)',
              pt: 'Chat em breve (auth propria, nao compartilhada com admin)',
              hi: 'चैट जल्द (अपना auth, एडमिन से अलग)',
            })"
          />
          <div class="composer-toolbar">
            <div class="toolbar-right">
              <button type="button" class="send-btn" disabled :title="pickText({ zh: '暂不可用', en: 'Unavailable' })">
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
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
  </ChatShell>
</template>

<style scoped>
.welcome {
  margin: 0;
  line-height: 1.75;
  white-space: pre-wrap;
}

.lead {
  margin: 0;
  line-height: 1.75;
}

.list {
  margin: 14px 0 0;
  padding-left: 18px;
  line-height: 1.8;
}

.inline-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}

.inline-actions .ghost {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 14px;
  border: 1px solid color-mix(in srgb, var(--agent-accent, #4d7c0f) 22%, var(--line));
  border-radius: var(--radius-sm);
  color: var(--muted);
  text-decoration: none;
  font-size: 12.5px;
  background: transparent;
}

.inline-actions .ghost:hover {
  color: color-mix(in srgb, var(--agent-accent, #4d7c0f) 55%, var(--ink));
  background: color-mix(in srgb, var(--agent-accent, #4d7c0f) 10%, var(--fill-soft));
}

.composer-card.is-disabled {
  opacity: 0.72;
  pointer-events: none;
}

.composer-card.is-disabled .composer-grip {
  cursor: default;
}
</style>
