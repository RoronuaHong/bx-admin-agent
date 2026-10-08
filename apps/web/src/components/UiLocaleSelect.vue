<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { getUiLocale, setUiLocale, type UiLocale } from "../ui-locale";

const emit = defineEmits<{ change: [UiLocale] }>();

const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;
const root = ref<HTMLElement | null>(null);
const open = ref(false);
const triggerRef = ref<HTMLButtonElement | null>(null);
const menuWrap = ref<HTMLElement | null>(null);
const optionEls = ref<HTMLLIElement[]>([]);
const currentIndex = ref(0);

// 浮层定位：Teleport 到 body 后用 fixed 坐标，右缘对齐触发按钮（与原 right:0 行为一致）。
const pos = reactive({ top: 0, right: 0, minWidth: 0 });

function updatePos() {
  const tr = triggerRef.value?.getBoundingClientRect();
  const panel = menuWrap.value;
  if (!tr) return;
  const w = panel ? panel.offsetWidth : Math.max(tr.width, 160);
  const h = panel ? panel.offsetHeight : options.value.length * 36 + 12;
  pos.minWidth = tr.width;
  // 下方空间不足且上方更宽裕时翻到按钮上方，避免被视口底边裁掉。
  const spaceBelow = window.innerHeight - tr.bottom;
  pos.top =
    spaceBelow < h + 12 && tr.top > spaceBelow ? Math.max(8, tr.top - h - 6) : tr.bottom + 8;
  // 右缘对齐触发按钮，并夹在视口内（窄屏不溢出左边）。
  const right = window.innerWidth - tr.right;
  pos.right = Math.min(Math.max(8, right), window.innerWidth - w - 8);
}

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
  // 面板已 Teleport 到 body，不在 root 内，必须同时认触发框与面板两块区域，否则点选项会被误判为外点先关闭。
  if (!root.value?.contains(e.target as Node) && !menuWrap.value?.contains(e.target as Node)) {
    open.value = false;
  }
}

function onWindowKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && open.value) closeMenu(true);
}

// 滚动/缩放时跟随触发按钮，避免浮层与按钮脱节。
function reposition() {
  if (open.value) updatePos();
}

onMounted(() => {
  window.addEventListener("mousedown", onPointerDown);
  window.addEventListener("keydown", onWindowKeydown);
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);
});

onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onPointerDown);
  window.removeEventListener("keydown", onWindowKeydown);
  window.removeEventListener("scroll", reposition, true);
  window.removeEventListener("resize", reposition);
});

// 打开后把焦点送到「当前选中项」：键盘用户不必先 Tab 一遍才落到菜单里。
watch(open, (o) => {
  if (o) {
    syncIndex();
    nextTick(() => {
      updatePos();
      focusOption(currentIndex.value);
    });
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
    <Teleport to="body">
      <div
        v-if="open"
        ref="menuWrap"
        class="locale-menu-wrap"
        :style="{ top: pos.top + 'px', right: pos.right + 'px', minWidth: pos.minWidth + 'px' }"
      >
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
    </Teleport>
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

/* 浮层 Teleport 到 body：fixed 定位 + 高 z-index，脱离任何祖先的层叠上下文/裁剪，
   不再被头部兄弟面板或页面内容盖住（对齐 UiSelect/ModelSelect 的浮层方案）。
   top/right/minWidth 由脚本按触发按钮矩形计算（右缘对齐按钮，与原 right:0 行为一致）。 */
.locale-menu-wrap {
  position: fixed;
  z-index: 1200;
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

  /* 浮层坐标已由脚本按视口夹紧（right ≥ 8px），这里只兜 max-width 防长标签溢出。 */
  .locale-menu-wrap {
    max-width: calc(100vw - 24px);
  }
}
</style>
