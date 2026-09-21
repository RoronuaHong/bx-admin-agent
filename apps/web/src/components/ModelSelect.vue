<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { MODEL_AUTO_ID, type ModelInfo } from "../api";
import { getUiLocale } from "../ui-locale";
import { matchesFuzzy, loadPinyin, pinyinReady } from "../pinyin";
import { useSelectPanel } from "../composables/useSelectPanel";

const props = defineProps<{
  models: ModelInfo[];
  modelValue: string;
}>();
const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();

const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

interface OptionTag {
  text: string;
  tone: "vision" | "ocr";
}

interface SelectOption {
  id: string;
  label: string;
  tags: OptionTag[];
}

interface SelectGroup {
  label: string;
  /** 分组色点（按出现顺序取调色板，纯展示用，不承载业务语义）。 */
  tone: string;
  items: SelectOption[];
}

const searchEl = ref<HTMLInputElement | null>(null);
const query = ref("");

const {
  root,
  triggerEl,
  listEl,
  open,
  activeIndex,
  indexOfId,
  scrollActiveIntoView,
  moveActive,
  openPanel: openPanelBase,
  closePanel,
  choose: chooseBase,
} = useSelectPanel({
  flatOptions: () => flatOptions.value,
  currentId: () => props.modelValue,
  onChoose: (id) => emit("update:modelValue", id),
});

/** 能力标签：让「能不能读图」这类类型差异在列表里一眼可见。 */
function tagsOf(model: ModelInfo): OptionTag[] {
  if (model.vision === "direct") return [{ text: tx("图片直读", "Vision", "Visão", "विज़न"), tone: "vision" }];
  if (model.vision === "ocr") return [{ text: "OCR", tone: "ocr" }];
  return [];
}

/** 分组键：优先端点来源（基础设施信息），缺失回退 provider。 */
function groupKeyOf(model: ModelInfo): string {
  return model.source || model.provider || "other";
}

/** 按来源分组 + 关键词过滤（分组标题始终保留，与 antd 分组选择器一致）。 */
const groups = computed<SelectGroup[]>(() => {
  // 读 pinyinReady 建立依赖：字典异步就绪后重算，启用拼音匹配（未就绪时仅原文匹配）。
  void pinyinReady.value;
  const keyword = query.value.trim().toLowerCase();
  const buckets = new Map<string, SelectOption[]>();
  for (const model of props.models) {
    // 与工具飞出面板一致：原文子串 + 拼音（首字母/全拼/缩写）。
    if (keyword && !matchesFuzzy([model.label, model.id], keyword)) continue;
    const key = groupKeyOf(model);
    const option: SelectOption = { id: model.id, label: model.label, tags: tagsOf(model) };
    const list = buckets.get(key);
    if (list) list.push(option);
    else buckets.set(key, [option]);
  }
  return [...buckets.entries()].map(([label, items], index) => ({ label, tone: `t${index % 5}`, items }));
});

const AUTO_LABELS = { zh: "自动", en: "Auto", "pt-BR": "Automático", hi: "स्वतः" } as const;

const isAuto = computed(() => props.modelValue === MODEL_AUTO_ID);
const autoLabel = computed(() => AUTO_LABELS[uiLocale.value] ?? AUTO_LABELS.en);
const autoItem = computed<SelectOption>(() => ({ id: MODEL_AUTO_ID, label: autoLabel.value, tags: [] }));

const flatOptions = computed<SelectOption[]>(() => [autoItem.value, ...groups.value.flatMap((group) => group.items)]);

const currentModel = computed(() => props.models.find((model) => model.id === props.modelValue) || null);
const currentLabel = computed(() =>
  isAuto.value ? autoLabel.value : (currentModel.value?.label || ""),
);
const currentSource = computed(() => (currentModel.value ? groupKeyOf(currentModel.value) : ""));
const currentTags = computed(() => (currentModel.value ? tagsOf(currentModel.value) : []));

/** 打开时清空搜索并聚焦输入框（composable 只管开合与键盘，不感知 search 框）。 */
async function openPanel() {
  if (open.value || !props.models.length) return;
  openPanelBase();
  loadPinyin();
  query.value = "";
  const currentIndex = indexOfId(props.modelValue);
  activeIndex.value = currentIndex >= 0 ? currentIndex : 0;
  await nextTick();
  searchEl.value?.focus();
  scrollActiveIntoView();
}

function togglePanel() {
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

function choose(id: string) {
  chooseBase(id);
}

function onSearchKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveActive(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveActive(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const option = flatOptions.value[activeIndex.value];
    if (option) choose(option.id);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closePanel(true);
  } else if (event.key === "Home") {
    event.preventDefault();
    activeIndex.value = 0;
    scrollActiveIntoView();
  } else if (event.key === "End") {
    event.preventDefault();
    activeIndex.value = Math.max(flatOptions.value.length - 1, 0);
    scrollActiveIntoView();
  } else if (event.key === "Tab") {
    closePanel();
  }
}

watch(query, () => {
  activeIndex.value = 0;
  scrollActiveIntoView();
});

// 模型列表异步加载完成后，若当前无选中项则自动落位到第一项（与旧的 select 行为一致）。
watch(
  () => props.models,
  (list) => {
    if (!props.modelValue && list.length) emit("update:modelValue", list[0]!.id);
  },
);
</script>

<template>
  <div ref="root" class="msel">
    <button
      id="chat-model"
      ref="triggerEl"
      type="button"
      class="msel__trigger"
      :class="{ 'is-open': open }"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :aria-label="`${tx('模型', 'Model', 'Modelo', 'मॉडल')}${currentSource ? ` ${currentSource}` : ''}${currentLabel ? ` ${currentLabel}` : ''}`"
      :title="currentLabel || ''"
      @click="togglePanel"
      @keydown="onTriggerKeydown"
    >
      <span v-if="isAuto" class="msel__source msel__source--auto" aria-hidden="true">AUTO</span>
      <span v-else-if="currentSource" class="msel__source" aria-hidden="true">{{ currentSource }}</span>
      <span class="msel__value">
        {{ currentLabel || tx("选择模型", "Select a model", "Selecionar um modelo", "मॉडल चुनें") }}
      </span>
      <span v-if="!isAuto && currentTags.length" class="msel__tag is-vision">{{ currentTags[0]!.text }}</span>
      <span class="msel__caret" aria-hidden="true"></span>
    </button>

    <div v-if="open" class="msel__panel" role="dialog" :aria-label="tx('模型', 'Model', 'Modelo', 'मॉडल')">
      <div class="msel__search">
        <span class="msel__search-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m16.5 16.5 4 4" />
          </svg>
        </span>
        <input
          ref="searchEl"
          v-model="query"
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="msel-listbox"
          :aria-expanded="open"
          :aria-activedescendant="flatOptions[activeIndex] ? `msel-opt-${flatOptions[activeIndex]!.id}` : undefined"
          :placeholder="tx('搜索模型', 'Search models', 'Buscar modelos', 'मॉडल खोजें')"
          @keydown="onSearchKeydown"
        />
        <button
          v-if="query"
          class="msel__clear"
          type="button"
          :title="tx('清除', 'Clear', 'Limpar', 'साफ़ करें')"
          @click="query = ''"
        >
          ×
        </button>
      </div>

      <ul id="msel-listbox" ref="listEl" class="msel__list" role="listbox" :aria-label="tx('模型', 'Model', 'Modelo', 'मॉडल')">
        <li
          :id="`msel-opt-${MODEL_AUTO_ID}`"
          class="msel__option msel__option--auto"
          role="option"
          :aria-selected="isAuto"
          :data-index="0"
          :class="{ 'is-selected': isAuto, 'is-active': activeIndex === 0 }"
          @click="choose(MODEL_AUTO_ID)"
          @mouseenter="activeIndex = 0"
        >
          <span class="msel__option-text">
            <span class="msel__option-label">
              {{ autoLabel }}
              <span class="msel__auto-badge" aria-hidden="true">AUTO</span>
            </span>
            <span class="msel__option-id msel__auto-desc">
              {{ tx("自动选择可用模型", "Auto-pick a working model", "Selecionar automaticamente um modelo funcional", "स्वतः एक कार्यशील मॉडल चुनें") }}
            </span>
          </span>
          <span class="msel__option-side">
            <span v-if="isAuto" class="msel__check" aria-hidden="true">✓</span>
          </span>
        </li>

        <template v-for="group in groups" :key="group.label">
          <li class="msel__group" role="presentation">
            <span class="msel__group-dot" :class="group.tone" aria-hidden="true"></span>
            <span class="msel__group-name">{{ group.label }}</span>
            <span class="msel__group-count">{{ group.items.length }}</span>
          </li>
          <li
            v-for="item in group.items"
            :id="`msel-opt-${item.id}`"
            :key="item.id"
            class="msel__option"
            role="option"
            :aria-selected="item.id === modelValue"
            :data-model-id="item.id"
            :data-index="indexOfId(item.id)"
            :class="{ 'is-selected': item.id === modelValue, 'is-active': indexOfId(item.id) === activeIndex }"
            @click="choose(item.id)"
            @mouseenter="activeIndex = indexOfId(item.id)"
          >
            <span class="msel__option-text">
              <span class="msel__option-label">{{ item.label }}</span>
              <span class="msel__option-id">{{ item.id }}</span>
            </span>
            <span class="msel__option-side">
              <span v-for="tag in item.tags" :key="tag.text" class="msel__tag" :class="`is-${tag.tone}`">
                {{ tag.text }}
              </span>
              <span v-if="item.id === modelValue" class="msel__check" aria-hidden="true">✓</span>
            </span>
          </li>
        </template>
        <li v-if="!groups.length" class="msel__empty">
          {{ tx("没有匹配的模型", "No matching model", "Nenhum modelo correspondente", "कोई मेल खाता मॉडल नहीं") }}
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.msel {
  position: relative;
  display: inline-flex;
}

.msel__trigger {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 178px;
  max-width: 300px;
  height: var(--ctrl-h);
  padding: 0 10px 0 11px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--ink);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  overflow: hidden;
  transition:
    color 0.15s ease,
    background 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.msel__trigger:hover,
.msel__trigger.is-open {
  background: var(--fill-soft);
  border-color: color-mix(in srgb, var(--ink) 28%, var(--line));
}

.msel__trigger.is-open {
  box-shadow: var(--ring);
}

.msel__trigger:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--ink) 30%, var(--line));
  box-shadow: var(--ring);
}

.msel__source {
  flex: none;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--muted);
}

.msel__source--auto {
  color: color-mix(in srgb, var(--accent, #2f7d5a) 82%, var(--ink));
  background: color-mix(in srgb, var(--accent, #2f7d5a) 12%, transparent);
  border-radius: var(--radius-pill);
  padding: 1px 5px;
  letter-spacing: 0.05em;
}

.msel__value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.msel__caret {
  width: 6px;
  height: 6px;
  flex: none;
  border-right: 1.25px solid currentColor;
  border-bottom: 1.25px solid currentColor;
  transform: rotate(45deg) translateY(-2px);
  opacity: 0.58;
  transition: opacity 0.15s ease;
}

.msel__trigger:hover .msel__caret,
.msel__trigger.is-open .msel__caret {
  opacity: 1;
}

/* ---- 下拉面板 ---- */
.msel__panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 30;
  width: 322px;
  max-width: calc(100vw - 32px);
  padding: 6px;
  border: 1px solid color-mix(in srgb, var(--line) 88%, var(--ink) 12%);
  border-radius: calc(var(--radius-sm) + 2px);
  background: color-mix(in srgb, var(--panel) 92%, white 8%);
  box-shadow:
    0 12px 28px color-mix(in srgb, var(--ink) 12%, transparent),
    0 2px 8px color-mix(in srgb, var(--ink) 6%, transparent);
  backdrop-filter: blur(10px);
}

.msel__search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px 6px;
  border-bottom: 1px solid var(--line);
}

.msel__search-icon {
  display: inline-flex;
  flex: none;
  color: var(--muted);
}

.msel__search input {
  flex: 1;
  min-width: 0;
  padding: 3px 0;
  border: none;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 13px;
}

.msel__search input:focus,
.msel__search input:focus-visible {
  outline: none;
  border: none;
  box-shadow: none;
}

.msel__search input::placeholder {
  color: var(--muted);
}

.msel__clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex: none;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  color: var(--muted);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}

.msel__clear:hover {
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 14%, transparent);
}

.msel__list {
  margin: 0;
  padding: 4px 0 0;
  list-style: none;
  max-height: min(320px, 62vh);
  overflow-y: auto;
}

.msel__group {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px 5px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

.msel__group:not(:first-child) {
  margin-top: 4px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.msel__group-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--muted);
  opacity: 0.75;
}

/* 分组色点：低饱和调色板，融入纸感主题（仅用于快速区分来源） */
.msel__group-dot.t0 { background: #6b7f8c; }
.msel__group-dot.t1 { background: #8a7a5e; }
.msel__group-dot.t2 { background: #6f7f6a; }
.msel__group-dot.t3 { background: #8a6f78; }
.msel__group-dot.t4 { background: #7a6f8c; }

.msel__group-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msel__group-count {
  margin-left: auto;
  flex: none;
  min-width: 16px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  font-size: 10px;
  font-weight: 500;
  line-height: 15px;
  letter-spacing: 0;
  text-align: center;
}

.msel__option {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 6px 9px;
  border-radius: calc(var(--radius-sm) - 2px);
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s ease;
}

/* 「自动」置顶项：用左侧色条 + 浅底突出为推荐入口。 */
.msel__option--auto {
  background: color-mix(in srgb, var(--accent, #2f7d5a) 7%, transparent);
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent, #2f7d5a) 60%, transparent);
}

.msel__option--auto.is-active {
  background: color-mix(in srgb, var(--accent, #2f7d5a) 13%, transparent);
}

.msel__auto-badge {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--accent, #2f7d5a) 16%, transparent);
  color: color-mix(in srgb, var(--accent, #2f7d5a) 88%, var(--ink));
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  line-height: 15px;
}

.msel__auto-desc {
  margin-top: 1px;
  font-family: inherit;
  font-size: 11px;
  color: var(--muted);
}

/* 高亮用半透明 ink 叠加（浅色压暗、深色提亮），避免依赖固定底色在深色下失效 */
.msel__option.is-active {
  background: color-mix(in srgb, var(--ink) 6%, transparent);
}

.msel__option.is-selected {
  background: color-mix(in srgb, var(--ink) 10%, transparent);
}

.msel__option.is-selected .msel__option-label {
  font-weight: 600;
}

.msel__option-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.msel__option-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msel__option-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
}

.msel__option-side {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
}

.msel__tag {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--fill-soft) 60%, transparent);
  color: var(--muted);
  font-size: 10px;
  font-weight: 500;
  line-height: 15px;
  white-space: nowrap;
}

.msel__tag.is-vision {
  border-color: color-mix(in srgb, #2f7d5a 34%, var(--line));
  background: color-mix(in srgb, #2f7d5a 9%, transparent);
  color: color-mix(in srgb, #2f7d5a 72%, var(--ink));
}

.msel__tag.is-ocr {
  border-color: color-mix(in srgb, #8a7a5e 36%, var(--line));
  background: color-mix(in srgb, #8a7a5e 10%, transparent);
  color: color-mix(in srgb, #8a7a5e 78%, var(--ink));
}

.msel__check {
  flex: none;
  color: color-mix(in srgb, var(--ink) 72%, var(--muted));
  font-size: 12px;
}

.msel__empty {
  padding: 12px 8px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}

@media (max-width: 900px) {
  .msel__trigger {
    min-width: 132px;
    max-width: 200px;
  }

  .msel__source {
    display: none;
  }
}
</style>
