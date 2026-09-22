<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

/**
 * 通用自定义下拉选择（antd / vben 风格）：触发框 + Teleport 到 body 的浮层面板。
 * 替代原生 <select>（原生下拉的 option 样式无法控制，与整体风格割裂）。
 *
 * - 触发框视觉与 .field__input 对齐（同高度/边框/焦点环）；
 * - 面板 fixed 定位（弹窗 overflow:auto 会裁剪 absolute 面板），空间不足自动上翻；
 * - 键盘：上下移动 / 回车选择 / Esc 收回 / Tab 收回，与 ModelSelect 一致。
 */
export interface UiSelectOption {
  value: string;
  label: string;
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: UiSelectOption[];
    placeholder?: string;
    ariaLabel?: string;
    /** 占满父容器宽度（表单字段用）；默认收缩到内容宽（行内用）。 */
    block?: boolean;
    /** md=38px 与 .field__input 同高；sm=30px 紧凑表单用。 */
    size?: "md" | "sm";
    /** 面板最小宽度：触发框太窄时保证选项可读。 */
    panelMinWidth?: number;
  }>(),
  {
    placeholder: "",
    ariaLabel: "",
    block: false,
    size: "md",
    panelMinWidth: 128,
  },
);

const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();

const root = ref<HTMLElement | null>(null);
const triggerEl = ref<HTMLButtonElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
const panelEl = ref<HTMLElement | null>(null);
const open = ref(false);
const activeIndex = ref(0);
const pos = reactive({ top: 0, left: 0, width: 0 });

const currentLabel = computed(
  () => props.options.find((o) => o.value === props.modelValue)?.label ?? "",
);

function scrollActiveIntoView() {
  void nextTick(() => {
    listEl.value
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex.value}"]`)
      ?.scrollIntoView({ block: "nearest" });
  });
}

function moveActive(delta: number) {
  const total = props.options.length;
  if (!total) return;
  activeIndex.value = (activeIndex.value + delta + total) % total;
  scrollActiveIntoView();
}

/** 打开：计算触发框位置（下空间不足上翻），并聚焦列表承接键盘。 */
async function openPanel() {
  if (open.value || !props.options.length) return;
  open.value = true;
  activeIndex.value = Math.max(
    props.options.findIndex((o) => o.value === props.modelValue),
    0,
  );
  await nextTick();
  const tr = root.value?.getBoundingClientRect();
  const panel = panelEl.value;
  if (!tr || !panel) return;
  pos.width = Math.max(tr.width, props.panelMinWidth);
  const panelHeight = panel.offsetHeight;
  const spaceBelow = window.innerHeight - tr.bottom;
  pos.top =
    spaceBelow < panelHeight + 12 && tr.top > spaceBelow
      ? Math.max(8, tr.top - panelHeight - 6)
      : tr.bottom + 6;
  pos.left = Math.min(Math.max(8, tr.left), window.innerWidth - pos.width - 8);
  scrollActiveIntoView();
  listEl.value?.focus();
}

function closePanel(refocus = false) {
  if (!open.value) return;
  open.value = false;
  if (refocus) void nextTick(() => triggerEl.value?.focus());
}

function choose(value: string) {
  emit("update:modelValue", value);
  closePanel(true);
}

function onTriggerClick() {
  if (open.value) closePanel();
  else void openPanel();
}

function onTriggerKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    void openPanel();
  } else if (event.key === "Escape") {
    closePanel();
  }
}

function onListKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveActive(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveActive(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const option = props.options[activeIndex.value];
    if (option) choose(option.value);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closePanel(true);
  } else if (event.key === "Tab") {
    closePanel();
  }
}

/** 面板 Teleport 到 body，外点关闭必须同时认触发框和面板两块区域。 */
function onPointerDown(event: MouseEvent) {
  if (!open.value) return;
  const t = event.target as Node;
  if (!root.value?.contains(t) && !panelEl.value?.contains(t)) closePanel();
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && open.value) closePanel(true);
}

/** 滚动 / 改窗时面板会脱离锚点，直接收回（比跟着重算更可预期）。 */
function onScroll() {
  closePanel();
}

watch(open, (v) => {
  if (!v) activeIndex.value = Math.max(props.options.findIndex((o) => o.value === props.modelValue), 0);
});

onMounted(() => {
  window.addEventListener("mousedown", onPointerDown);
  window.addEventListener("keydown", onWindowKeydown);
  window.addEventListener("scroll", onScroll, true);
});

onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onPointerDown);
  window.removeEventListener("keydown", onWindowKeydown);
  window.removeEventListener("scroll", onScroll, true);
});
</script>

<template>
  <div ref="root" class="uisel" :class="[`uisel--${size}`, { 'uisel--block': block }]">
    <button
      ref="triggerEl"
      type="button"
      class="uisel__trigger"
      :class="{ 'is-open': open }"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :aria-label="ariaLabel || undefined"
      :title="currentLabel || undefined"
      @click="onTriggerClick"
      @keydown="onTriggerKeydown"
    >
      <span class="uisel__value" :class="{ 'is-placeholder': !currentLabel }">{{
        currentLabel || placeholder
      }}</span>
      <span class="uisel__caret" :class="{ flip: open }" aria-hidden="true"></span>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="panelEl"
        class="uisel__panel"
        :style="{ top: pos.top + 'px', left: pos.left + 'px', width: pos.width + 'px' }"
      >
        <ul ref="listEl" class="uisel__list" role="listbox" tabindex="-1" :aria-label="ariaLabel || undefined" @keydown="onListKeydown">
          <li
            v-for="(option, index) in options"
            :key="option.value"
            class="uisel__option"
            :class="{ 'is-selected': option.value === modelValue, 'is-active': index === activeIndex }"
            role="option"
            :aria-selected="option.value === modelValue"
            :data-index="index"
            @click="choose(option.value)"
            @mouseenter="activeIndex = index"
          >
            <span class="uisel__option-label">{{ option.label }}</span>
            <span v-if="option.value === modelValue" class="uisel__check" aria-hidden="true">✓</span>
          </li>
        </ul>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.uisel {
  position: relative;
  display: inline-flex;
  max-width: 100%;
}

.uisel--block {
  display: flex;
  width: 100%;
}

.uisel--block .uisel__trigger {
  width: 100%;
}

.uisel__trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 38px;
  padding: 0 10px 0 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--fill);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

/* 紧凑档：通知通道等小表单 */
.uisel--sm .uisel__trigger {
  height: 30px;
  padding: 0 8px 0 10px;
  font-size: 12px;
}

.uisel__trigger:hover,
.uisel__trigger.is-open {
  border-color: color-mix(in srgb, var(--ink) 45%, var(--line));
}

.uisel__trigger.is-open,
.uisel__trigger:focus-visible {
  outline: none;
  border-color: var(--ink);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ink) 14%, transparent);
}

.uisel__value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.uisel__value.is-placeholder {
  color: var(--muted);
  opacity: 0.75;
}

/* antd 式下拉箭头：细 chevron，展开时上翻 */
.uisel__caret {
  width: 7px;
  height: 7px;
  flex: none;
  border-right: 1.4px solid currentColor;
  border-bottom: 1.4px solid currentColor;
  transform: rotate(45deg) translateY(-2px);
  opacity: 0.55;
  transition: transform 0.18s ease, opacity 0.15s ease;
}

.uisel__trigger:hover .uisel__caret,
.uisel__trigger.is-open .uisel__caret {
  opacity: 1;
}

.uisel__caret.flip {
  transform: rotate(-135deg) translateY(-1px);
}

/* ---- 浮层面板 ---- */
.uisel__panel {
  position: fixed;
  z-index: 1200;
  min-width: 0;
  padding: 4px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: calc(var(--radius) + 2px);
  box-shadow:
    0 12px 28px color-mix(in srgb, var(--ink) 12%, transparent),
    0 2px 8px color-mix(in srgb, var(--ink) 6%, transparent);
  animation: uisel-in 0.14s ease;
}

@keyframes uisel-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.uisel__list {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 240px;
  overflow-y: auto;
  outline: none;
}

.uisel__option {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--ink);
  cursor: pointer;
  transition: background 0.12s ease;
}

.uisel--sm .uisel__option {
  min-height: 28px;
  padding: 4px 9px;
  font-size: 12px;
}

.uisel__option.is-active {
  background: color-mix(in srgb, var(--ink) 6%, transparent);
}

.uisel__option.is-selected {
  background: color-mix(in srgb, var(--ink) 9%, transparent);
  font-weight: 600;
}

.uisel__option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.uisel__check {
  flex: none;
  font-size: 12px;
  color: color-mix(in srgb, var(--ink) 72%, var(--muted));
}
</style>
