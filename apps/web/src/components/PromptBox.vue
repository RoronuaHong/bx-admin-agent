<script setup lang="ts">
/**
 * 通用「卡片式输入框」：对话输入区与定时任务「任务内容」共用同一套外壳——
 * 外层描边卡片 + 内部无边框 textarea + 底部一条工具条。不各写一份版本，避免两处样式/交互走偏。
 *
 * 差异部分全走插槽与 props：
 * - #top：输入框上方的东西（对话区用它挂拖拽把手）
 * - #toolbar-left / #toolbar-right：底部工具条左右两侧（对话区放工具菜单 / 发送按钮）
 * - hint：右侧提示文案（margin-left:auto 顶到右边）
 *
 * 未声明的 attrs（id / name / rows / aria-* / @keydown / @input …）一律落到内部 textarea，不落到外壳。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string;
    hint?: string;
    /** textarea 最小高度（px）：对话区用 COMPOSER_BASE，弹窗里给更高的默认值。 */
    minHeight?: number;
    /** 自动增长上限（px）。 */
    maxHeight?: number;
    /** textarea 顶部内边距：挂了 #top（拖拽把手）时调用方通常要压小一点。 */
    padTop?: number;
    /**
     * 随内容自动长高（minHeight ~ maxHeight 之间）。
     * 对话区不要开：它有自己的拖拽定高 + autoGrow 逻辑，开了会互相覆盖拖出来的高度。
     * 任务表单这类「纯内容输入」场景开启——否则长指令被压在 minHeight 的小框里内部滚动。
     */
    autoGrow?: boolean;
  }>(),
  {
    placeholder: "",
    hint: "",
    minHeight: 96,
    maxHeight: 420,
    padTop: 12,
    autoGrow: false,
  },
);

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

defineOptions({ inheritAttrs: false });

const el = ref<HTMLTextAreaElement | null>(null);

const boxStyle = computed(() => ({
  minHeight: `${props.minHeight}px`,
  maxHeight: `${props.maxHeight}px`,
  paddingTop: `${props.padTop}px`,
}));

/**
 * 自动增高：先置 height:auto 再读 scrollHeight（scrollHeight 返回 max(内容高, 当前高)，
 * 不重置读不到收缩后的真实内容高），再夹在 minHeight ~ maxHeight 之间。
 * 与对话区 autoGrow 同一套「两次 reflow」手法；目标高度与上次相同时写回原值，避免无谓样式失效。
 */
function resize() {
  const ta = el.value;
  if (!ta || !props.autoGrow) return;
  const prev = ta.style.height;
  ta.style.height = "auto";
  const next = `${Math.min(Math.max(ta.scrollHeight, props.minHeight), props.maxHeight)}px`;
  if (prev !== next) ta.style.height = next;
  else ta.style.height = prev;
}

watch(
  () => props.modelValue,
  () => nextTick(resize),
);

onMounted(() => {
  resize();
  // 窗口缩放改变换行宽度 → 所需高度变化，需重算。
  window.addEventListener("resize", resize);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", resize);
});

function onInput(event: Event) {
  emit("update:modelValue", (event.target as HTMLTextAreaElement).value);
}

defineExpose({ el });
</script>

<template>
  <div class="prompt-box">
    <slot name="top" />
    <textarea
      ref="el"
      class="prompt-input"
      :value="modelValue"
      :placeholder="placeholder"
      :style="boxStyle"
      v-bind="$attrs"
      @input="onInput"
    ></textarea>
    <div class="prompt-bar">
      <slot name="toolbar-left" />
      <span v-if="hint" class="prompt-hint">{{ hint }}</span>
      <slot name="toolbar-right" />
    </div>
  </div>
</template>

<style scoped>
/* 卡片式输入区：外层描边，内部元素一律无边框（与对话输入区同款）。 */
.prompt-box {
  display: flex;
  flex-direction: column;
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--fill);
  transition:
    border-color 0.15s ease,
    box-shadow 0.2s ease;
}

.prompt-box:focus-within {
  border-color: color-mix(in srgb, var(--ink) 55%, var(--line));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ink) 10%, transparent);
}

.prompt-input {
  width: 100%;
  /* 不挂原生拖拽把手：右下角的把手会和底部工具条的提示挤在一起（对话区有自己的顶部把手）。 */
  resize: none;
  border: none;
  padding: 0 14px 4px;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.5;
}

.prompt-input::placeholder {
  color: color-mix(in srgb, var(--muted) 80%, transparent);
}

.prompt-input:focus,
.prompt-input:focus-visible {
  outline: none;
  border: none;
  box-shadow: none;
}

/* 底部工具条：左侧内容 → 提示顶到右边 → 右侧内容。 */
.prompt-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px 8px;
}

.prompt-hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--muted);
  user-select: none;
}

/* 窄屏：提示文案先让位给输入区。 */
@media (max-width: 720px) {
  .prompt-hint {
    display: none;
  }
}
</style>
