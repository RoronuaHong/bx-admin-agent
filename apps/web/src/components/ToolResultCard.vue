<script setup lang="ts">
/**
 * 工具调用结果卡片（对齐 Cursor「工具结果即产出，实时上屏」）：
 * 默认折叠只显示工具名 + 摘要，点击展开查看完整结果。
 * 可选受控模式：父组件传 `expanded` + 监听 `update:expanded` 可批量控制（全部展开/全部折叠）；
 * 不传时退回内部自管理，保持向后兼容。
 */
import { computed, ref } from "vue";

const props = defineProps<{
  name: string;
  result: string;
  expanded?: boolean;
}>();

const emit = defineEmits<{ "update:expanded": [value: boolean] }>();

const internal = ref(false);

/** 受控模式下由父组件决定，否则用内部状态 */
const expanded = computed(() => props.expanded ?? internal.value);

function toggle() {
  if (props.expanded !== undefined) emit("update:expanded", !expanded.value);
  else internal.value = !internal.value;
}

/** 提取可读摘要：去掉 UI_TABLE/【表格输出】等结构标记，取前 160 字符 */
const summary = computed(() => {
  const raw = props.result || "";
  let s = raw
    .replace(/^UI_TABLE\n[\s\S]*?\n(?:\n|$)/, "")
    .replace(/^UI_FILE\n[\s\S]*?\n(?:\n|$)/, "")
    .replace(/^【(?:表格输出|图表摘要)[^\n]*\n?/, "")
    .replace(/^\[已对齐 PC 端字段[^\n]*\n?/, "")
    .trim();
  s = s.replace(/\s+/g, " ").trim();
  // 摘要过长时不再展示截断的残文（尤其中途断掉的 JSON 无意义），改为占位提示，完整内容点击展开查看
  if (s.length > 160) return "(内容较长，点击展开查看完整结果)";
  return s || "(空结果)";
});

const toolLabel = computed(() => {
  const names: Record<string, string> = {
    call_api: "接口调用",
    search_api_module: "检索接口",
    read_api_module: "读取接口源码",
    read_file: "读取文件",
    grep_codebase: "检索代码",
    normalize_output: "字段对齐",
    render_table: "渲染表格",
    get_list_columns: "读取列定义",
    submit_understood_intent: "意图理解",
    parse_intent: "规则校验",
  };
  return names[props.name] || props.name;
});
</script>

<template>
  <div class="tool-card" :class="{ expanded }">
    <button
      type="button"
      class="tool-card__head"
      :aria-expanded="expanded"
      @click="toggle"
    >
      <span class="tool-card__icon" aria-hidden="true">⚙</span>
      <span class="tool-card__name">{{ toolLabel }}</span>
      <span class="tool-card__summary">{{ summary }}</span>
      <span class="tool-card__toggle" aria-hidden="true">{{ expanded ? "▾" : "▸" }}</span>
    </button>
    <pre v-if="expanded" class="tool-card__body">{{ result }}</pre>
  </div>
</template>

<style scoped>
.tool-card {
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 8px;
  margin: 6px 0;
  overflow: hidden;
  background: var(--bg-muted, #f9fafb);
}
.tool-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: transparent;
  border: none;
  cursor: pointer;
  font: inherit;
  color: inherit;
  text-align: left;
}
.tool-card__head:hover {
  background: rgba(0, 0, 0, 0.04);
}
.tool-card__icon {
  flex-shrink: 0;
  font-size: 13px;
  opacity: 0.7;
}
.tool-card__name {
  flex-shrink: 0;
  font-weight: 600;
  font-size: 12px;
  color: #4b5563;
}
.tool-card__summary {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: #6b7280;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tool-card__toggle {
  flex-shrink: 0;
  font-size: 11px;
  color: #9ca3af;
}
.tool-card__body {
  margin: 0;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 320px;
  overflow: auto;
  background: #fff;
  border-top: 1px solid var(--border-color, #e5e7eb);
  color: #374151;
}
</style>
