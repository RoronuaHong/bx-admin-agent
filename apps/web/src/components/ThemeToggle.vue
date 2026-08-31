<script setup lang="ts">
import { useTheme } from "../theme";

const { theme, toggle } = useTheme();
</script>

<template>
  <button
    class="theme-toggle"
    type="button"
    :aria-label="theme === 'dark' ? '切换到浅色' : '切换到深色'"
    :title="theme === 'dark' ? '浅色' : '深色'"
    @click="toggle"
  >
    <span class="icon" aria-hidden="true">{{ theme === "dark" ? "○" : "●" }}</span>
    <span class="label">{{ theme === "dark" ? "浅色" : "深色" }}</span>
  </button>
</template>

<style scoped>
.theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 32px;
  min-width: 32px;
  padding: 0 12px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
  border-radius: var(--radius-sm);
  transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}

.theme-toggle:hover {
  color: var(--ink);
  background: var(--fill-soft);
  border-color: color-mix(in srgb, var(--ink) 15%, var(--line));
}

.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  font-size: 14px;
  line-height: 1;
}

.label {
  line-height: 1;
}

@media (max-width: 720px) {
  .label {
    display: none;
  }

  .theme-toggle {
    padding: 0;
    min-width: 28px;
    height: 28px;
  }
}
</style>
