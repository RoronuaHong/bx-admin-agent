<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { getUiLocale, setUiLocale, type UiLocale } from "../ui-locale";

const uiLocale = getUiLocale();
const root = ref<HTMLElement | null>(null);
const open = ref(false);

const options = computed(() => [
  { value: "zh" as UiLocale, label: "中文" },
  { value: "en" as UiLocale, label: "English" },
  { value: "pt-BR" as UiLocale, label: "Português (Brasil)" },
  { value: "hi" as UiLocale, label: "हिन्दी" },
]);

const currentOption = computed(() => options.value.find((item) => item.value === uiLocale.value) || options.value[0]);

function toggleOpen() {
  open.value = !open.value;
}

function choose(value: UiLocale) {
  setUiLocale(value);
  open.value = false;
}

function onPointerDown(e: MouseEvent) {
  if (!root.value?.contains(e.target as Node)) open.value = false;
}

function onWindowKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") open.value = false;
}

onMounted(() => {
  window.addEventListener("mousedown", onPointerDown);
  window.addEventListener("keydown", onWindowKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onPointerDown);
  window.removeEventListener("keydown", onWindowKeydown);
});
</script>

<template>
  <div ref="root" class="locale-box">
    <button
      type="button"
      class="locale-select"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="toggleOpen"
    >
      <span class="sr-only">UI language</span>
      <span class="locale-value">{{ currentOption?.label }}</span>
      <span class="locale-caret" aria-hidden="true"></span>
    </button>
    <div v-if="open" class="locale-menu-wrap">
      <ul class="locale-menu" role="listbox" aria-label="UI language">
        <li v-for="item in options" :key="item.value">
          <button
            type="button"
            class="locale-option"
            :class="{ active: item.value === uiLocale }"
            @click="choose(item.value)"
          >
            <span class="locale-option__label">{{ item.label }}</span>
            <span v-if="item.value === uiLocale" class="locale-option__check" aria-hidden="true">✓</span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.locale-box {
  position: relative;
}

.locale-select {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 148px;
  height: 32px;
  padding: 0 11px 0 12px;
  border: 1px solid color-mix(in srgb, var(--line) 92%, var(--ink) 8%);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--panel) 84%, var(--fill));
  color: var(--muted);
  cursor: pointer;
  overflow: hidden;
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, white 22%, transparent),
    0 1px 1px color-mix(in srgb, var(--ink) 3%, transparent);
  transition:
    color 0.15s ease,
    background 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease;
  font: inherit;
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

.locale-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1;
}

.locale-caret {
  width: 6px;
  height: 6px;
  flex: none;
  border-right: 1.25px solid currentColor;
  border-bottom: 1.25px solid currentColor;
  transform: rotate(45deg) translateY(-2px);
  opacity: 0.58;
}

.locale-select:hover {
  color: var(--ink);
  background: color-mix(in srgb, var(--panel) 76%, var(--fill-soft));
  border-color: color-mix(in srgb, var(--ink) 14%, var(--line));
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, white 28%, transparent),
    0 2px 8px color-mix(in srgb, var(--ink) 5%, transparent);
}

.locale-select:focus-within {
  color: var(--ink);
  background: color-mix(in srgb, var(--panel) 78%, var(--fill-soft));
  border-color: color-mix(in srgb, var(--ink) 18%, var(--line));
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, white 24%, transparent),
    0 0 0 3px color-mix(in srgb, var(--ink) 8%, transparent);
}

.locale-select:focus-within .locale-caret {
  opacity: 1;
}

.locale-select:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 28%, transparent);
  outline-offset: 2px;
}

.locale-menu-wrap {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 30;
  min-width: 100%;
}

.locale-menu {
  margin: 0;
  padding: 6px;
  list-style: none;
  border: 1px solid color-mix(in srgb, var(--line) 88%, var(--ink) 12%);
  border-radius: calc(var(--radius-sm) + 2px);
  background: color-mix(in srgb, var(--panel) 92%, white 8%);
  box-shadow:
    0 12px 28px color-mix(in srgb, var(--ink) 12%, transparent),
    0 2px 8px color-mix(in srgb, var(--ink) 6%, transparent);
  backdrop-filter: blur(10px);
}

.locale-option {
  width: 100%;
  min-height: 36px;
  padding: 0 10px;
  border: none;
  border-radius: calc(var(--radius-sm) - 2px);
  background: transparent;
  color: var(--ink);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font: inherit;
  font-size: 13px;
  text-align: left;
  transition: background 0.15s ease, color 0.15s ease;
}

.locale-option:hover,
.locale-option:focus-visible {
  background: color-mix(in srgb, var(--fill-soft) 78%, var(--panel));
  outline: none;
}

.locale-option.active {
  background: color-mix(in srgb, var(--ink) 8%, var(--panel));
  font-weight: 600;
}

.locale-option__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.locale-option__check {
  color: color-mix(in srgb, var(--ink) 72%, var(--muted));
  font-size: 12px;
}

@media (max-width: 720px) {
  .locale-select {
    min-width: 128px;
    padding: 0 10px;
    gap: 7px;
  }

  .locale-value {
    font-size: 12px;
  }

  .locale-menu-wrap {
    right: auto;
    left: 0;
  }
}
</style>
