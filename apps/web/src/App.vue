<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { RouterView, useRoute } from "vue-router";
import { provideTheme } from "./theme";

provideTheme();

const route = useRoute();
const routeFocus = ref<HTMLElement | null>(null);

watch(
  () => route.fullPath,
  () => {
    nextTick(() => routeFocus.value?.focus());
  },
);
</script>

<template>
  <a class="skip-link" href="#app-main">Skip to content</a>
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
