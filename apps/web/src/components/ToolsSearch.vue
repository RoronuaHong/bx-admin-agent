<script setup lang="ts">
/**
 * 工具飞出面板的搜索框（技能 / 连接器 / 专家共用一份，避免三处重复 DOM）。
 * 能力：图标 + 输入 + 清空按钮 + 打开即聚焦；拼音匹配由调用方的过滤逻辑负责。
 */
import { nextTick, onMounted, ref } from "vue";
import { getUiLocale } from "../ui-locale";

const props = defineProps<{
  modelValue: string;
  /** 占位文案（四语由调用方用 tx() 给出）。 */
  placeholder: string;
  /** 挂载后是否聚焦；悬停展开面板时应传 false，避免抢走消息输入框的焦点。 */
  autofocus?: boolean;
}>();
const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();

const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

const inputEl = ref<HTMLInputElement | null>(null);

onMounted(async () => {
  if (!props.autofocus) return;
  await nextTick();
  inputEl.value?.focus();
});
</script>

<template>
  <div class="tools-flyout__search">
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </svg>
    <input
      ref="inputEl"
      :value="props.modelValue"
      type="text"
      :placeholder="props.placeholder"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <button
      v-if="props.modelValue"
      class="tools-flyout__clear"
      type="button"
      :title="tx('清空', 'Clear', 'Limpar', 'साफ़ करें')"
      :aria-label="tx('清空', 'Clear', 'Limpar', 'साफ़ करें')"
      @click="emit('update:modelValue', '')"
    >
      ×
    </button>
  </div>
</template>

<style scoped>
.tools-flyout__search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  margin-bottom: 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--panel) 88%, var(--ink) 4%);
  color: var(--muted);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

/* 聚焦指示放到外层容器上：内层 input 是透明无边框的，若把聚焦环画在它身上
   会糊在边框盒子里变成一圈黑线。容器整体聚焦才像正常的输入框聚焦。 */
.tools-flyout__search:focus-within {
  border-color: color-mix(in srgb, var(--ink) 32%, var(--line));
  box-shadow: var(--ring);
}

.tools-flyout__search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 13px;
}

.tools-flyout__search input:focus,
.tools-flyout__search input:focus-visible {
  outline: none;
  border: none;
  box-shadow: none;
}

.tools-flyout__search input::placeholder {
  color: var(--muted);
}

.tools-flyout__clear {
  flex: none;
  padding: 0 2px;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.tools-flyout__clear:hover {
  color: var(--ink);
}
</style>
