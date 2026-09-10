<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { PORTAL_CARDS, type PortalCardAccent } from "../agent-portal";
import { pickLocalized } from "../localize";
import { getUiLocale } from "../ui-locale";

const props = defineProps<{
  /** Exclude this portal card key from the switcher (current agent). */
  currentKey?: string;
}>();

const uiLocale = getUiLocale();
const router = useRouter();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

const root = ref<HTMLElement | null>(null);
const open = ref(false);

type SwitchTarget = {
  key: string;
  label: string;
  to: string;
  accent: PortalCardAccent;
};

const currentCard = computed(() => PORTAL_CARDS.find((card) => card.key === props.currentKey));

const currentLabel = computed(() => {
  if (currentCard.value) return pickLocalized(uiLocale.value, currentCard.value.title);
  return tx("导航", "Navigate", "Navegar", "नेविगेट");
});

const targets = computed<SwitchTarget[]>(() =>
  PORTAL_CARDS.filter((card) => Boolean(card.href) && card.key !== props.currentKey).map((card) => ({
    key: card.key,
    label: pickLocalized(uiLocale.value, card.title),
    to: card.authHref || card.href || "/",
    accent: card.accent,
  })),
);

function toggleOpen() {
  open.value = !open.value;
}

function choose(to: string) {
  open.value = false;
  void router.push(to);
}

function onPointerDown(e: MouseEvent) {
  if (!root.value?.contains(e.target as Node)) open.value = false;
}

function onWindowKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") open.value = false;
}

onMounted(() => {
  window.addEventListener("mousedown", onPointerDown);
  window.addEventListener("keydown", onWindowKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onPointerDown);
  window.removeEventListener("keydown", onWindowKeydown);
});
</script>

<template>
  <div ref="root" class="nav-box">
    <button
      type="button"
      class="nav-trigger"
      :class="{ open }"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click="toggleOpen"
    >
      <span class="nav-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14">
          <rect x="3" y="3" width="7" height="7" rx="1.5" fill="currentColor" opacity="0.9" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" fill="currentColor" opacity="0.55" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" fill="currentColor" opacity="0.55" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" fill="currentColor" opacity="0.9" />
        </svg>
      </span>
      <span class="sr-only">{{ tx("Agent 导航", "Agent navigation", "Navegacao de Agent", "एजेंट नेविगेशन") }}</span>
      <span class="nav-value">{{ currentLabel }}</span>
      <span class="nav-caret" aria-hidden="true" />
    </button>

    <Transition name="nav-fade">
      <div v-if="open" class="nav-menu-wrap">
        <div class="nav-menu" role="menu" :aria-label="tx('Agent 导航', 'Agent navigation', 'Navegacao de Agent', 'एजेंट नेविगेशन')">
          <div class="nav-group-label">{{ tx("切换到", "Switch to", "Trocar para", "इस पर स्विच करें") }}</div>
          <button
            v-for="item in targets"
            :key="item.key"
            type="button"
            class="nav-item"
            role="menuitem"
            @click="choose(item.to)"
          >
            <span class="nav-dot" :data-accent="item.accent" aria-hidden="true" />
            <span class="nav-item-label">{{ item.label }}</span>
          </button>

          <div class="nav-divider" role="separator" />

          <button type="button" class="nav-item nav-item-portal" role="menuitem" @click="choose('/')">
            <span class="nav-home" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M4 11.5L12 4l8 7.5M7 10.5V20h10v-9.5"
                />
              </svg>
            </span>
            <span class="nav-item-label">{{ tx("返回门户", "Back to portal", "Voltar ao portal", "पोर्टल पर लौटें") }}</span>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.nav-box {
  position: relative;
}

.nav-trigger {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 148px;
  max-width: 220px;
  height: 32px;
  padding: 0 11px 0 10px;
  border: 1px solid color-mix(in srgb, var(--line) 92%, var(--ink) 8%);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--panel) 84%, var(--fill));
  color: var(--muted);
  cursor: pointer;
  overflow: hidden;
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, white 22%, transparent),
    0 1px 1px color-mix(in srgb, var(--ink) 3%, transparent);
  transition:
    color 0.15s ease,
    background 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease;
  font: inherit;
}

.nav-trigger:hover,
.nav-trigger.open {
  color: var(--ink);
  background: color-mix(in srgb, var(--panel) 76%, var(--fill-soft));
  border-color: color-mix(in srgb, var(--ink) 14%, var(--line));
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, white 28%, transparent),
    0 2px 8px color-mix(in srgb, var(--ink) 5%, transparent);
}

.nav-trigger.open {
  border-color: color-mix(in srgb, var(--agent-accent, var(--ink)) 36%, var(--line));
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, white 24%, transparent),
    0 0 0 3px color-mix(in srgb, var(--agent-accent, var(--ink)) 12%, transparent);
}

.nav-trigger:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 28%, transparent);
  outline-offset: 2px;
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

.nav-icon {
  display: inline-flex;
  flex: none;
  color: color-mix(in srgb, var(--agent-accent, var(--ink)) 70%, var(--muted));
}

.nav-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1;
  text-align: left;
}

.nav-caret {
  width: 6px;
  height: 6px;
  flex: none;
  border-right: 1.25px solid currentColor;
  border-bottom: 1.25px solid currentColor;
  transform: rotate(45deg) translateY(-2px);
  opacity: 0.58;
  transition: transform 0.15s ease, opacity 0.15s ease;
}

.nav-trigger.open .nav-caret {
  opacity: 1;
  transform: rotate(225deg) translateY(-1px);
}

.nav-menu-wrap {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 40;
  min-width: max(100%, 220px);
}

.nav-menu {
  margin: 0;
  padding: 6px;
  border: 1px solid color-mix(in srgb, var(--line) 88%, var(--ink) 12%);
  border-radius: 8px;
  background: color-mix(in srgb, var(--panel) 96%, white 4%);
  box-shadow:
    0 6px 16px color-mix(in srgb, var(--ink) 10%, transparent),
    0 3px 6px -4px color-mix(in srgb, var(--ink) 12%, transparent);
}

.nav-group-label {
  padding: 6px 10px 4px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.nav-item {
  width: 100%;
  min-height: 34px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ink);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font: inherit;
  font-size: 13px;
  text-align: left;
  transition: background 0.12s ease, color 0.12s ease;
}

.nav-item:hover,
.nav-item:focus-visible {
  background: color-mix(in srgb, var(--agent-accent, var(--ink)) 8%, var(--fill-soft));
  outline: none;
}

.nav-item-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: #71717a;
}

.nav-dot[data-accent="analytics"] {
  background: #0f766e;
}

.nav-dot[data-accent="admin"] {
  background: #c2410c;
}

.nav-dot[data-accent="knowledge"] {
  background: #4d7c0f;
}

.nav-dot[data-accent="viewing"] {
  background: #0369a1;
}

.nav-divider {
  height: 1px;
  margin: 6px 4px;
  background: color-mix(in srgb, var(--line) 90%, var(--ink) 10%);
}

.nav-home {
  display: inline-flex;
  flex: none;
  color: var(--muted);
}

.nav-item-portal:hover .nav-home {
  color: var(--agent-accent, var(--ink));
}

.nav-fade-enter-active,
.nav-fade-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.nav-fade-enter-from,
.nav-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@media (max-width: 720px) {
  .nav-trigger {
    min-width: 128px;
    max-width: 168px;
    padding: 0 10px;
    gap: 7px;
  }

  .nav-value {
    font-size: 12px;
  }

  .nav-menu-wrap {
    right: auto;
    left: 0;
  }
}
</style>
