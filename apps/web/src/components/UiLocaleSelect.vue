<script setup lang="ts">
import { computed } from "vue";
import { getUiLocale, setUiLocale, type UiLocale } from "../ui-locale";

const uiLocale = getUiLocale();

const options = computed(() => [
  { value: "zh" as UiLocale, label: uiLocale.value === "en" ? "Chinese" : "中文" },
  { value: "en" as UiLocale, label: uiLocale.value === "en" ? "English" : "英文" },
]);

function onChange(e: Event) {
  const value = (e.target as HTMLSelectElement).value === "en" ? "en" : "zh";
  setUiLocale(value);
}
</script>

<template>
  <label class="locale-select">
    <span class="sr-only">UI language</span>
    <select :value="uiLocale" @change="onChange">
      <option v-for="item in options" :key="item.value" :value="item.value">{{ item.label }}</option>
    </select>
  </label>
</template>

<style scoped>
.locale-select {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

select {
  height: 32px;
  min-width: 104px;
  padding: 0 32px 0 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background:
    linear-gradient(45deg, transparent 50%, var(--muted) 50%) calc(100% - 16px) 13px / 6px 6px no-repeat,
    linear-gradient(135deg, var(--muted) 50%, transparent 50%) calc(100% - 11px) 13px / 6px 6px no-repeat,
    transparent;
  color: var(--muted);
  font: inherit;
  cursor: pointer;
  appearance: none;
}

select:hover {
  color: var(--ink);
  border-color: color-mix(in srgb, var(--ink) 15%, var(--line));
  background-color: var(--fill-soft);
}

select:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 25%, transparent);
  outline-offset: 2px;
}

@media (max-width: 720px) {
  select {
    min-width: 92px;
  }
}
</style>
