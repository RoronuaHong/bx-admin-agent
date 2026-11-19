<script setup lang="ts">
import { ref } from "vue";
import BackToTop from "../BackToTop.vue";
import ChatBubble from "../ChatBubble.vue";
import ConversationOutline from "../ConversationOutline.vue";
import { agentText, type AgentEntry } from "../../agents";
import type { Bubble } from "../../chat-types";
import { getUiLocale } from "../../ui-locale";

interface OutlineItem {
  id: number;
  label: string;
}

defineProps<{
  visible: boolean;
  booting: boolean;
  showSkeleton: boolean;
  bubbleCount: number;
  visibleBubbles: Bubble[];
  modelSwitchHint: string;
  currentExpert: AgentEntry | undefined;
  expertStarters: string[];
  latestAlertMarkerId: number | undefined;
  open: boolean;
  outlineItems: OutlineItem[];
  activeOutlineId: number | null;
  outlineBand: number;
  pinnedOutlineId: number | null;
  isMobile: boolean;
  sidebarOpen: boolean;
}>();
const emit = defineEmits<{
  scroll: [event: Event];
  outlineUserScrollIntent: [event: Event];
  showEarlier: [];
  dismissModelHint: [];
  askStarter: [prompt: string];
  jump: [id: number];
  active: [id: number | null];
  "update:open": [value: boolean];
}>();

const threadEl = ref<HTMLElement | null>(null);
defineExpose({ threadEl });

const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;
</script>

<template>
  <!-- tabindex="-1"：给「回到顶部」点击后的焦点落点（不进入 Tab 序列），也方便键盘直接滚动对话区。 -->
  <div
    ref="threadEl"
    v-show="visible"
    class="thread"
    tabindex="-1"
    @scroll="emit('scroll', $event)"
    @wheel.passive="emit('outlineUserScrollIntent', $event)"
    @touchstart.passive="emit('outlineUserScrollIntent', $event)"
    @keydown="emit('outlineUserScrollIntent', $event)"
  >
    <!-- 首屏慢加载才亮骨架；快加载时 booting 期间留空、不闪空态，直接等真实内容出现。 -->
    <div v-if="showSkeleton" class="boot-skeleton" aria-hidden="true">
      <div class="boot-skeleton__row boot-skeleton__row--agent"></div>
      <div class="boot-skeleton__row boot-skeleton__row--user"></div>
      <div class="boot-skeleton__row boot-skeleton__row--agent boot-skeleton__row--short"></div>
    </div>
    <div v-else-if="!booting && !bubbleCount && currentExpert" class="expert-home">
      <div class="expert-home__mark" aria-hidden="true">{{ currentExpert.icon }}</div>
      <h2 class="expert-home__title">{{ agentText(currentExpert.label, uiLocale) }}</h2>
      <p class="expert-home__desc">{{ agentText(currentExpert.description, uiLocale) }}</p>
      <div v-if="expertStarters.length" class="expert-home__prompts">
        <button
          v-for="prompt in expertStarters"
          :key="prompt"
          type="button"
          class="expert-home__prompt"
          @click="emit('askStarter', prompt)"
        >
          {{ prompt }}
        </button>
      </div>
    </div>
    <div v-else-if="!booting && !bubbleCount" class="empty">
      {{ tx("想聊点什么？", "Want to chat about something?", "Quer conversar sobre algo?", "कुछ बात करना चाहते हैं?") }}
    </div>
    <div v-if="modelSwitchHint" class="model-switch-hint" role="status">
      <span class="model-switch-hint__icon" aria-hidden="true">i</span>
      <span>{{ modelSwitchHint }}</span>
      <button
        type="button"
        class="model-switch-hint__close"
        :aria-label="tx('关闭', 'Dismiss', 'Fechar', 'बंद करें')"
        @click="emit('dismissModelHint')"
      >
        ×
      </button>
    </div>
    <button
      v-if="bubbleCount > visibleBubbles.length"
      type="button"
      class="thread-earlier"
      @click="emit('showEarlier')"
    >
      {{ tx("显示更早的消息", "Show earlier messages", "Mostrar mensagens anteriores", "पुराने संदेश दिखाएं") }}
    </button>
    <ChatBubble v-for="b in visibleBubbles" :key="b.id" :bubble="b" :is-latest="b.id === latestAlertMarkerId" />
    <!-- 回到顶部：挂在对话滚动容器内，长对话翻久了可一键回顶。 -->
    <BackToTop :threshold="120" avoid-selector=".composer" focus-target=".thread" />
    <ConversationOutline
      v-show="!(isMobile && sidebarOpen)"
      :open="open"
      :items="outlineItems"
      :active-id="activeOutlineId"
      :band="outlineBand"
      :pinned-id="pinnedOutlineId"
      @update:open="emit('update:open', $event)"
      @jump="emit('jump', $event)"
      @active="emit('active', $event)"
    />
  </div>
</template>
