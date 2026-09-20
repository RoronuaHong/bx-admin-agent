<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { agentText, type AgentEntry } from "../agents";
import { getUiLocale } from "../ui-locale";
import { useSelectPanel } from "../composables/useSelectPanel";

const props = defineProps<{
  /** 全部已注册专家（含通用助手自身），来自前端镜像 `agents.ts`，与服务端 `roles.ts` 一一对应。 */
  agents: AgentEntry[];
  /** 当前会话所属专家 id（路由注入，如 /chat=generic、/movie=观影助手）。 */
  currentId: string;
}>();

const router = useRouter();
const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

const { root, triggerEl, listEl, open, activeIndex, indexOfId, openPanel, onTriggerKeydown, onListKeydown, togglePanel, choose } =
  useSelectPanel({
    flatOptions: () => props.agents,
    currentId: () => props.currentId,
    onChoose: (id) => {
      // 选专家 = 跳到该专家路由（/chat=generic、/movie=观影助手…）。
      // 会话按 agent 分槽、创建时写死 agentId，不能把当前对话改成另一个专家，
      // 故切换走路由跳转（落到该专家的会话列表 / 新建页），与门户卡片行为一致。
      const agent = props.agents.find((a) => a.id === id);
      if (!agent || id === props.currentId) return;
      router.push(agent.path);
    },
  });

const current = computed(() => props.agents.find((a) => a.id === props.currentId) || null);
const currentLabel = computed(() => (current.value ? agentText(current.value.label, uiLocale.value) : ""));
</script>

<template>
  <div ref="root" class="esel">
    <button
      id="chat-expert"
      ref="triggerEl"
      type="button"
      class="esel__trigger"
      :class="{ 'is-open': open }"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :aria-label="`${tx('专家', 'Expert', 'Especialista', 'विशेषज्ञ')}${currentLabel ? ` ${currentLabel}` : ''}`"
      :title="currentLabel || ''"
      @click="togglePanel"
      @keydown="onTriggerKeydown"
    >
      <span class="esel__icon" aria-hidden="true">{{ current?.icon || "◎" }}</span>
      <span class="esel__value">{{ currentLabel || tx("选择专家", "Select expert", "Selecionar especialista", "विशेषज्ञ चुनें") }}</span>
      <span class="esel__caret" aria-hidden="true"></span>
    </button>

    <div v-if="open" class="esel__panel" role="dialog" :aria-label="tx('专家', 'Expert', 'Especialista', 'विशेषज्ञ')">
      <ul ref="listEl" class="esel__list" role="listbox" tabindex="-1" :aria-label="tx('专家', 'Expert', 'Especialista', 'विशेषज्ञ')" @keydown="onListKeydown">
        <li
          v-for="(agent, i) in agents"
          :id="`esel-opt-${agent.id}`"
          :key="agent.id"
          class="esel__option"
          role="option"
          :aria-selected="agent.id === currentId"
          :data-index="i"
          :class="{ 'is-selected': agent.id === currentId, 'is-active': i === activeIndex }"
          @click="choose(agent.id)"
          @mouseenter="activeIndex = i"
        >
          <span class="esel__option-icon" aria-hidden="true">{{ agent.icon }}</span>
          <span class="esel__option-text">
            <span class="esel__option-label">{{ agentText(agent.label, uiLocale) }}</span>
            <span class="esel__option-desc">{{ agentText(agent.description, uiLocale) }}</span>
          </span>
          <span class="esel__option-side">
            <span v-if="agent.id === currentId" class="esel__check" aria-hidden="true">✓</span>
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.esel {
  position: relative;
  display: inline-flex;
}

.esel__trigger {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 150px;
  max-width: 240px;
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

.esel__trigger:hover,
.esel__trigger.is-open {
  background: var(--fill-soft);
  border-color: color-mix(in srgb, var(--ink) 28%, var(--line));
}

.esel__trigger.is-open {
  box-shadow: var(--ring);
}

.esel__trigger:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--ink) 30%, var(--line));
  box-shadow: var(--ring);
}

.esel__icon {
  flex: none;
  font-size: 14px;
  line-height: 1;
  color: color-mix(in srgb, var(--accent, #2f7d5a) 82%, var(--ink));
}

.esel__value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.esel__caret {
  width: 6px;
  height: 6px;
  flex: none;
  border-right: 1.25px solid currentColor;
  border-bottom: 1.25px solid currentColor;
  transform: rotate(45deg) translateY(-2px);
  opacity: 0.58;
  transition: opacity 0.15s ease;
}

.esel__trigger:hover .esel__caret,
.esel__trigger.is-open .esel__caret {
  opacity: 1;
}

.esel__panel {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 30;
  width: 280px;
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

.esel__list {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: min(340px, 64vh);
  overflow-y: auto;
}

.esel__option {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 44px;
  padding: 7px 9px;
  border-radius: calc(var(--radius-sm) - 2px);
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s ease;
}

.esel__option.is-active {
  background: color-mix(in srgb, var(--ink) 6%, transparent);
}

.esel__option.is-selected {
  background: color-mix(in srgb, var(--ink) 10%, transparent);
}

.esel__option.is-selected .esel__option-label {
  font-weight: 600;
}

.esel__option-icon {
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent, #2f7d5a) 12%, transparent);
  color: color-mix(in srgb, var(--accent, #2f7d5a) 88%, var(--ink));
  font-size: 13px;
  line-height: 1;
}

.esel__option-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.esel__option-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.esel__option-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--muted);
}

.esel__option-side {
  display: inline-flex;
  align-items: center;
  flex: none;
}

.esel__check {
  flex: none;
  color: color-mix(in srgb, var(--ink) 72%, var(--muted));
  font-size: 12px;
}

@media (max-width: 900px) {
  .esel__trigger {
    min-width: 120px;
    max-width: 168px;
  }
}
</style>
