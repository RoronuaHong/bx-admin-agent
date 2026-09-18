<script setup lang="ts">
import { ref } from "vue";
import { listAgents } from "../agents";
import { detectDefaultLocale, getUiLocale, isUiLocale, setUiLocale, type UiLocale } from "../ui-locale";

// 门户：Agent 卡片列表（领域适配指南 §8.3「枢纽型」推荐起步）。
// 角色清单来自前端镜像的 agents 配置；角色判断与分流只在后端，这里只做展示与跳转。
const locale = ref<UiLocale>(isUiLocale(getUiLocale()) ? getUiLocale() : detectDefaultLocale());
function switchLocale() {
  const order: UiLocale[] = ["zh", "en", "pt-BR", "hi"];
  locale.value = order[(order.indexOf(locale.value) + 1) % order.length];
  setUiLocale(locale.value);
}
function tx(zh: string, en: string, pt: string, hi: string): string {
  return { zh, en, "pt-BR": pt, hi }[locale.value];
}
</script>

<template>
  <div class="portal">
    <header class="portal__head">
      <span class="portal__brand">{{ tx("小助手", "Assistant", "Assistente", "सहायक") }}</span>
      <button type="button" class="portal__locale" @click="switchLocale">{{ locale }}</button>
    </header>

    <main class="portal__main">
      <h1 class="portal__title">{{ tx("选择一个助手开始", "Pick an assistant", "Escolha um assistente", "एक सहायक चुनें") }}</h1>
      <p class="portal__sub">
        {{ tx("每个助手有各自的人设、技能与工具，会话互相独立。", "Each assistant has its own persona, skills and tools; conversations are independent.", "Cada assistente tem persona, habilidades e ferramentas próprias; conversas independentes.", "प्रत्येक सहायक की अपनी persona, skills और tools हैं; बातचीत स्वतंत्र है।") }}
      </p>

      <div class="portal__grid">
        <RouterLink
          v-for="agent in listAgents()"
          :key="agent.id"
          class="agent-card"
          :class="{ movie: agent.id === 'movie' }"
          :to="agent.path"
        >
          <span class="agent-card__icon" aria-hidden="true">{{ agent.icon }}</span>
          <span class="agent-card__body">
            <span class="agent-card__name">{{ agent.label }}</span>
            <span class="agent-card__desc">{{ agent.description }}</span>
          </span>
          <span class="agent-card__go" aria-hidden="true">→</span>
        </RouterLink>
      </div>
    </main>
  </div>
</template>

<style scoped>
.portal {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg, #f6f7fb);
  color: var(--ink, #1c2333);
}

.portal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 22px;
}

.portal__brand {
  font-size: 17px;
  font-weight: 700;
}

.portal__locale {
  border: 1px solid var(--line, #dfe3ee);
  background: transparent;
  border-radius: 8px;
  padding: 4px 10px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  text-transform: uppercase;
}

.portal__main {
  flex: 1;
  width: min(760px, calc(100vw - 32px));
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 14px;
  padding: 24px 0 48px;
}

.portal__title {
  font-size: 26px;
  margin: 0;
}

.portal__sub {
  margin: 0 0 12px;
  color: var(--muted, #66708a);
  font-size: 13px;
}

.portal__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px;
}

.agent-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px;
  border: 1px solid var(--line, #dfe3ee);
  border-radius: 14px;
  background: var(--panel, #fff);
  text-decoration: none;
  color: inherit;
  transition: box-shadow 0.18s ease, transform 0.18s ease;
}

.agent-card:hover,
.agent-card:focus-visible {
  transform: translateY(-2px);
  box-shadow: 0 10px 28px rgb(16 24 40 / 10%);
}

.agent-card__icon {
  flex: none;
  width: 46px;
  height: 46px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: color-mix(in srgb, #4f7cff 12%, transparent);
  font-size: 22px;
}

.agent-card__body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.agent-card__name {
  font-size: 15px;
  font-weight: 600;
}

.agent-card__desc {
  font-size: 12px;
  color: var(--muted, #66708a);
  line-height: 1.5;
}

.agent-card__go {
  margin-left: auto;
  color: var(--muted, #66708a);
}
</style>
