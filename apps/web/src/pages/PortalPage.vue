<script setup lang="ts">
import { computed, ref, watch } from "vue";
import BackToTop from "../components/BackToTop.vue";
import UiLocaleSelect from "../components/UiLocaleSelect.vue";
import { agentText, findAgent, listAgents } from "../agents";
import { saveChatPreferences } from "../api";
import { getUiLocale, type UiLocale } from "../ui-locale";
import { matchesFuzzyScoped, loadPinyin, pinyinReady } from "../pinyin";

// 门户：Agent 卡片列表（领域适配指南 §8.3「枢纽型」推荐起步）。
// 角色清单来自前端镜像的 agents 配置；角色判断与分流只在后端，这里只做展示与跳转。
// 语言读共享的界面语言 ref（与 Chat/Movie 页同一份内存态），切换交给统一的 UiLocaleSelect。
const locale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  locale.value === "zh" ? zh : locale.value === "pt-BR" ? pt : locale.value === "hi" ? hi : en;
// 门户对齐 CodeBuddy 专家中心：默认助手（generic）单独呈现，专家网格只列真·专家。
const defaultAgent = findAgent("generic");
const experts = computed(() => listAgents().filter((a) => a.id !== "generic"));

// 专家网格搜索（与工具飞出面板一致：原文 + 拼音，且单字母只匹配名称，避免误命中）。
const expertQuery = ref("");
const expertsFiltered = computed(() => {
  // 读 pinyinReady 建立依赖：字典异步就绪后重算，启用拼音。
  void pinyinReady.value;
  const q = expertQuery.value.trim().toLowerCase();
  if (!q) return experts.value;
  return experts.value.filter((a) =>
    matchesFuzzyScoped(
      [agentText(a.label, locale.value)],
      [a.id, ...Object.values(a.label), ...Object.values(a.description)],
      q,
    ),
  );
});
function onExpertSearchInput() {
  // 首次输入才拉起拼音字典（首屏不背这体积）。
  loadPinyin();
}

// 标签页标题跟随界面语言（index.html 里的中文只是首屏兜底）。
watch(
  () => tx("小助手", "Assistant", "Assistente", "सहायक"),
  (name) => {
    document.title = name;
  },
  { immediate: true },
);

/** 门户没有对话上下文，语言落到设备默认（`session.preferences.locale`），进 Chat 时即生效。 */
function onLocaleChange(next: UiLocale) {
  void saveChatPreferences({ locale: next }).catch(() => undefined);
}
</script>

<template>
  <div class="portal">
    <header class="portal__head">
      <span class="portal__brand">{{ tx("小助手", "Assistant", "Assistente", "सहायक") }}</span>
      <UiLocaleSelect @change="onLocaleChange" />
    </header>

    <main class="portal__main">
      <!-- tabindex="-1"：给「返回顶部」点击后的焦点落点（读屏念出页面标题），不进入 Tab 序列。 -->
      <h1 id="portal-title" class="portal__title" tabindex="-1">{{ tx("选择一个助手开始", "Pick an assistant", "Escolha um assistente", "एक सहायक चुनें") }}</h1>
      <p class="portal__sub">
        {{ tx("每个助手有各自的人设、技能与工具，会话互相独立。", "Each assistant has its own persona, skills and tools; conversations are independent.", "Cada assistente tem persona, habilidades e ferramentas próprias; conversas independentes.", "प्रत्येक सहायक की अपनी persona, skills और tools हैं; बातचीत स्वतंत्र है।") }}
      </p>

      <!-- 默认助手（非专家，对应 CodeBuddy 未切换专家时的通用形态） -->
      <RouterLink
        v-if="defaultAgent"
        class="agent-card agent-card--default"
        :to="defaultAgent.path"
      >
        <span class="agent-card__icon" aria-hidden="true">{{ defaultAgent.icon }}</span>
        <span class="agent-card__body">
          <span class="agent-card__name">{{ agentText(defaultAgent.label, locale) }}</span>
          <span class="agent-card__desc">{{ agentText(defaultAgent.description, locale) }}</span>
        </span>
        <span class="agent-card__go" aria-hidden="true">→</span>
      </RouterLink>

      <h2 class="portal__section">{{ tx("助手", "Assistant", "Assistente", "सहायक") }}</h2>
      <div class="portal__search" role="search">
        <svg class="portal__search-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7"></circle>
          <path d="m20 20-3.2-3.2"></path>
        </svg>
        <input
          v-model="expertQuery"
          class="portal__search-input"
          type="text"
          :placeholder="tx('搜索助手', 'Search assistants', 'Buscar assistentes', 'सहायक खोजें')"
          :aria-label="tx('搜索助手', 'Search assistants', 'Buscar assistentes', 'सहायक खोजें')"
          @input="onExpertSearchInput"
        />
      </div>
      <div v-if="expertsFiltered.length" class="portal__grid">
        <RouterLink
          v-for="agent in expertsFiltered"
          :key="agent.id"
          class="agent-card"
          :class="{ movie: agent.id === 'movie' }"
          :to="agent.path"
        >
          <span class="agent-card__icon" aria-hidden="true">{{ agent.icon }}</span>
          <span class="agent-card__body">
            <span class="agent-card__name">{{ agentText(agent.label, locale) }}</span>
            <span class="agent-card__desc">{{ agentText(agent.description, locale) }}</span>
          </span>
          <span class="agent-card__go" aria-hidden="true">→</span>
        </RouterLink>
      </div>
      <p v-else class="portal__empty">{{ tx("没有匹配的助手", "No matching assistants", "Nenhum assistente correspondente", "कोई मेल खाने वाला सहायक नहीं") }}</p>
    </main>

    <!-- 返回顶部：滚动超过一屏 1/3 才出现；点击后平滑回顶并把焦点交给下面的标题（tabindex="-1"）。 -->
    <BackToTop focus-target="#portal-title" />
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

.portal__section {
  margin: 18px 0 0;
  font-size: 15px;
  font-weight: 700;
}

.portal__search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 0;
  padding: 0 12px;
  height: var(--ctrl-h, 40px);
  border: 1px solid var(--line, #dfe3ee);
  border-radius: 12px;
  background: var(--panel, #fff);
  color: var(--muted, #66708a);
}

.portal__search:focus-within {
  border-color: color-mix(in srgb, #4f7cff 55%, var(--line, #dfe3ee));
  box-shadow: 0 0 0 3px color-mix(in srgb, #4f7cff 16%, transparent);
}

.portal__search-icon {
  flex: none;
}

.portal__search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--ink, #1c2333);
  font: inherit;
  font-size: 14px;
}

/* 聚焦指示只画在外层容器上（见上面的 .portal__search:focus-within）：
   内层 input 透明无边框，全局 input:focus-visible 的焦点环落在它身上
   会在输入框内部糊出一圈黑框（比容器小一圈）。 */
.portal__search-input:focus,
.portal__search-input:focus-visible {
  outline: none;
  border: none;
  box-shadow: none;
}

.portal__search-input::placeholder {
  color: var(--muted, #66708a);
}

.portal__empty {
  margin: 14px 0 0;
  color: var(--muted, #66708a);
  font-size: 13px;
}

.agent-card--default {
  border-color: color-mix(in srgb, #4f7cff 45%, var(--line, #dfe3ee));
  background: color-mix(in srgb, #4f7cff 6%, var(--panel, #fff));
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
