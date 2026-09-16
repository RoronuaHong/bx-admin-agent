<script setup lang="ts">
import { useTheme } from "../theme";
import { getUiLocale } from "../ui-locale";

const { theme, toggle } = useTheme();
const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;
</script>

<template>
  <button
    class="theme-toggle"
    type="button"
    :aria-label="theme === 'dark' ? tx('切换到浅色', 'Switch to light mode', 'Mudar para modo claro', 'लाइट मोड पर स्विच करें') : tx('切换到深色', 'Switch to dark mode', 'Mudar para modo escuro', 'डार्क मोड पर स्विच करें')"
    :title="theme === 'dark' ? tx('浅色', 'Light', 'Claro', 'लाइट') : tx('深色', 'Dark', 'Escuro', 'डार्क')"
    @click="toggle"
  >
    <span class="icon" aria-hidden="true">
      <svg v-if="theme === 'dark'" viewBox="0 0 24 24" width="15" height="15">
        <path
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"
        />
      </svg>
      <svg v-else viewBox="0 0 24 24" width="15" height="15">
        <circle cx="12" cy="12" r="4.2" fill="currentColor" />
        <g stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <line x1="12" y1="2.5" x2="12" y2="5" />
          <line x1="12" y1="19" x2="12" y2="21.5" />
          <line x1="2.5" y1="12" x2="5" y2="12" />
          <line x1="19" y1="12" x2="21.5" y2="12" />
          <line x1="4.9" y1="4.9" x2="6.7" y2="6.7" />
          <line x1="17.3" y1="17.3" x2="19.1" y2="19.1" />
          <line x1="4.9" y1="19.1" x2="6.7" y2="17.3" />
          <line x1="17.3" y1="6.7" x2="19.1" y2="4.9" />
        </g>
      </svg>
    </span>
    <span class="label">{{ theme === "dark" ? tx("浅色", "Light", "Claro", "लाइट") : tx("深色", "Dark", "Escuro", "डार्क") }}</span>
  </button>
</template>

<style scoped>
.theme-toggle {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 32px;
  min-height: 32px;
  min-width: 32px;
  padding: 0 12px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  line-height: 1;
  border-radius: 6px;
  transition:
    color 0.2s ease,
    background 0.2s ease,
    border-color 0.2s ease;
  white-space: nowrap;
  flex: none;
}

.theme-toggle:hover {
  color: var(--accent, #0f766e);
  background: var(--panel);
  border-color: var(--accent, #0f766e);
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
    min-width: 32px;
    width: 32px;
    height: 32px;
  }
}
</style>
