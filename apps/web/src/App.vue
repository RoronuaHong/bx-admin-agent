<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { RouterView, useRoute } from "vue-router";
import { provideTheme } from "./theme";
import { getUiLocale } from "./ui-locale";

provideTheme();

const route = useRoute();
const routeFocus = ref<HTMLElement | null>(null);
const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

watch(
  () => route.fullPath,
  () => {
    nextTick(() => routeFocus.value?.focus());
  },
);
</script>

<template>
  <a class="skip-link" href="#app-main">{{ tx("跳到主要内容", "Skip to content", "Pular para o conteudo", "मुख्य सामग्री पर जाएं") }}</a>
  <div ref="routeFocus" class="route-focus-anchor" tabindex="-1" aria-hidden="true"></div>
  <div id="app-main">
    <RouterView />
  </div>
</template>

<style scoped>
.skip-link {
  position: fixed;
  left: 12px;
  top: 12px;
  z-index: 9999;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--ink);
  color: var(--bg);
  text-decoration: none;
  transform: translateY(-140%);
  transition: transform 0.16s ease;
}

.skip-link:focus {
  transform: translateY(0);
}

.route-focus-anchor {
  position: fixed;
  top: 0;
  left: 0;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
</style>
