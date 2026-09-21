<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { getUiLocale, setUiLocale, type UiLocale } from "../ui-locale";

const emit = defineEmits<{ change: [UiLocale] }>();

const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;
const root = ref<HTMLElement | null>(null);
const open = ref(false);
const triggerRef = ref<HTMLButtonElement | null>(null);
const optionEls = ref<HTMLLIElement[]>([]);
const currentIndex = ref(0);

const options = computed(() => [
  { value: "zh" as UiLocale, label: "中文" },
  { value: "en" as UiLocale, label: "English" },
  { value: "pt-BR" as UiLocale, label: "Português (Brasil)" },
  { value: "hi" as UiLocale, label: "हिन्दी" },
]);

const currentOption = computed(() => options.value.find((item) => item.value === uiLocale.value) || options.value[0]);

function syncIndex() {
  const idx = options.value.findIndex((o) => o.value === uiLocale.value);
  currentIndex.value = idx >= 0 ? idx : 0;
}

function toggleOpen() {
  open.value = !open.value;
}

function closeMenu(returnFocus: boolean) {
  open.value = false;
  if (returnFocus) triggerRef.value?.focus();
}

/** 函数式 ref：把每个选项的 <li> 收集进数组，供方向键在它们之间移动焦点。 */
function assignOptRef(i: number, el: any) {
  if (el) optionEls.value[i] = el as HTMLLIElement;
}

function focusOption(idx: number) {
  const els = optionEls.value;
  if (!els.length) return;
  currentIndex.value = (idx + els.length) % els.length;
  els[currentIndex.value]?.focus();
}

function choose(value: UiLocale) {
  setUiLocale(value);
  // 持久化交给父组件：语言是对话级设置，需要连同 conversationId 一起落库。
  emit("change", value);
  closeMenu(true);
}

// 触发器键盘：方向键 / 回车 / 空格打开并把焦点送进菜单（APG listbox 约定）。
function onTriggerKeydown(e: KeyboardEvent) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (!open.value) {
      syncIndex();
      open.value = true;
    }
  }
}

// 菜单键盘：方向键在选项间移动（roving tabindex），Home/End 跳首尾，回车/空格选中，Esc 关闭并归还焦点。
function onMenuKeydown(e: KeyboardEvent) {
  switch (e.key) {
    case "ArrowDown": e.preventDefault(); focusOption(currentIndex.value + 1); break;
    case "ArrowUp": e.preventDefault(); focusOption(currentIndex.value - 1); break;
    case "Home": e.preventDefault(); focusOption(0); break;
    case "End": e.preventDefault(); focusOption(options.value.length - 1); break;
    case "Enter":
    case " ": e.preventDefault(); choose(options.value[currentIndex.value].value); break;
    case "Escape": e.preventDefault(); closeMenu(true); break;
    case "Tab": closeMenu(false); break;
  }
}

function onPointerDown(e: MouseEvent) {
  if (!root.value?.contains(e.target as Node)) open.value = false;
}

function onWindowKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && open.value) closeMenu(true);
}

onMounted(() => {
  window.addEventListener("mousedown", onPointerDown);
  window.addEventListener("keydown", onWindowKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onPointerDown);
  window.removeEventListener("keydown", onWindowKeydown);
});

// 打开后把焦点送到「当前选中项」：键盘用户不必先 Tab 一遍才落到菜单里。
watch(open, (o) => {
  if (o) {
    syncIndex();
    nextTick(() => focusOption(currentIndex.value));
  }
});
</script>

<template>
  <div ref="root" class="locale-box">
    <button
      ref="triggerRef"
      type="button"
      class="locale-select"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="toggleOpen"
      @keydown="onTriggerKeydown"
    >
      <span class="sr-only">{{ tx("界面语言", "UI language", "Idioma da interface", "इंटरफ़ेस भाषा") }}</span>
      <span class="locale-value">{{ currentOption?.label }}</span>
      <span class="locale-caret" aria-hidden="true"></span>
    </button>
    <div v-if="open" class="locale-menu-wrap">
      <ul
        class="locale-menu"
        role="listbox"
        :aria-label="tx('界面语言', 'UI language', 'Idioma da interface', 'इंटरफ़ेस भाषा')"
        @keydown="onMenuKeydown"
      >
        <!-- role="option" 直接上 <li>：listbox 的必需子元素是 option，读屏才能报「第几项 / 共几项」。
             roving tabindex：仅当前项可 Tab 进入，方向键在选项间移动（APG listbox 约定）；
             当前选中项用 aria-selected 标出。 -->
        <li
          v-for="(item, i) in options"
          :key="item.value"
          :ref="(el) => assignOptRef(i, el)"
          class="locale-option"
          role="option"
          :aria-selected="item.value === uiLocale"
          :tabindex="i === currentIndex ? 0 : -1"
          :class="{ active: item.value === uiLocale }"
          @click="choose(item.value)"
        >
          <span class="locale-option__label">{{ item.label }}</span>
          <span v-if="item.value === uiLocale" class="locale-option__check" aria-hidden="true">✓</span>
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
  gap: 7px;
  height: var(--ctrl-h);
  padding: 0 11px 0 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--muted);
  cursor: pointer;
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
  white-space: nowrap;
  color: var(--ink);
  font-size: 13px;
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

.locale-select:hover,
.locale-select[aria-expanded="true"] {
  background: var(--fill-soft);
  border-color: color-mix(in srgb, var(--ink) 28%, var(--line));
}

.locale-select:hover .locale-value,
.locale-select[aria-expanded="true"] .locale-value {
  color: var(--ink);
}

.locale-select[aria-expanded="true"] {
  box-shadow: var(--ring);
}

.locale-select[aria-expanded="true"] .locale-caret,
.locale-select:hover .locale-caret {
  opacity: 1;
}

.locale-select:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--ink) 30%, var(--line));
  box-shadow: var(--ring);
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
  white-space: nowrap;
}

.locale-option__check {
  color: color-mix(in srgb, var(--ink) 72%, var(--muted));
  font-size: 12px;
}

@media (max-width: 720px) {
  .locale-select {
    padding: 0 10px;
    gap: 7px;
  }

  .locale-value {
    font-size: 12px;
  }

  /* 保持右缘对齐向左展开：控件通常靠在右侧，改成 left:0 会让菜单向右溢出视口被裁切。 */
  .locale-menu-wrap {
    right: 0;
    left: auto;
    max-width: calc(100vw - 24px);
  }
}
</style>
