<script setup lang="ts">
import { computed, ref, useSlots } from "vue";

export type ChatShellAccent = "analytics" | "admin" | "knowledge" | "viewing" | "home" | "default";

const props = withDefaults(
  defineProps<{
    accent?: ChatShellAccent;
  }>(),
  { accent: "default" },
);

defineEmits<{
  threadScroll: [event: Event];
}>();

const slots = useSlots();
const threadEl = ref<HTMLElement | null>(null);
const hasSubnav = computed(() => Boolean(slots.subnav));

defineExpose({ threadEl });
</script>

<template>
  <div
    class="chat-shell booth"
    :class="[`accent-${props.accent}`, { 'has-subnav': hasSubnav }]"
  >
    <header v-if="slots.header" class="top">
      <slot name="header" />
    </header>

    <slot name="subnav" />

    <div class="thread-frame">
      <main
        ref="threadEl"
        class="thread"
        @scroll.passive="$emit('threadScroll', $event)"
      >
        <slot name="thread" />
      </main>
      <slot name="thread-aside" />
    </div>

    <slot name="float" />

    <div v-if="slots.composer" class="composer">
      <slot name="composer" />
    </div>

    <slot name="modals" />
  </div>
</template>

<style>
/*
  Shared multi-agent chat chrome. Prefixed with .chat-shell to avoid global leaks.
  Accent themes align with AgentPortalPage card colors so each sub-agent feels unique
  while sharing the same shell geometry / atmosphere as the portal.
*/
.chat-shell.booth {
  --agent-accent: #52525b;
  --agent-accent-2: #71717a;
  /* Align legacy --accent usages (send/caret) to the active agent theme. */
  --accent: var(--agent-accent);
  --agent-glow-a: color-mix(in srgb, var(--agent-accent) 18%, transparent);
  --agent-glow-b: color-mix(in srgb, var(--agent-accent-2) 12%, transparent);
  position: relative;
  isolation: isolate;
  height: 100dvh;
  width: 100%;
  max-width: 100vw;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto 1fr auto;
  overflow-x: hidden;
  background:
    radial-gradient(820px 420px at 6% -8%, var(--agent-glow-a), transparent 58%),
    radial-gradient(640px 380px at 96% 0%, var(--agent-glow-b), transparent 55%),
    radial-gradient(560px 320px at 70% 110%, color-mix(in srgb, var(--agent-accent) 10%, transparent), transparent 50%),
    linear-gradient(
      165deg,
      color-mix(in srgb, var(--bg) 90%, var(--agent-accent)) 0%,
      var(--bg) 46%,
      color-mix(in srgb, var(--bg) 92%, var(--agent-accent-2)) 100%
    );
}

.chat-shell.booth::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 0.28;
  background-image:
    linear-gradient(color-mix(in srgb, var(--ink) 5%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--ink) 5%, transparent) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(ellipse 78% 68% at 50% 18%, #000 18%, transparent 72%);
}

.chat-shell.booth > * {
  position: relative;
  z-index: 1;
}

.chat-shell.booth.has-subnav {
  grid-template-rows: auto auto 1fr auto;
}

.chat-shell.accent-analytics {
  --agent-accent: #0f766e;
  --agent-accent-2: #0369a1;
}

.chat-shell.accent-admin {
  --agent-accent: #c2410c;
  --agent-accent-2: #b45309;
}

.chat-shell.accent-knowledge {
  --agent-accent: #4d7c0f;
  --agent-accent-2: #a16207;
}

.chat-shell.accent-viewing {
  --agent-accent: #0369a1;
  --agent-accent-2: #0e7490;
}

.chat-shell.accent-home {
  --agent-accent: #0f766e;
  --agent-accent-2: #ea580c;
}

.chat-shell .top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: calc(14px + var(--safe-top)) var(--pad) 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--agent-accent) 22%, var(--line));
  background: color-mix(in srgb, var(--panel) 78%, transparent);
  backdrop-filter: blur(20px) saturate(1.2);
  -webkit-backdrop-filter: blur(20px) saturate(1.2);
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--ink) 5%, transparent),
    inset 0 1px 0 color-mix(in srgb, white 16%, transparent);
  position: relative;
  z-index: 20;
}

.chat-shell .identity {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
}

.chat-shell .brand-kicker {
  margin: 0;
  color: color-mix(in srgb, var(--agent-accent) 72%, var(--muted));
  font-size: 10px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  font-weight: 700;
}

.chat-shell .brand-mark {
  font-size: 20px;
  line-height: 1;
  letter-spacing: 0.06em;
  font-weight: 700;
  color: color-mix(in srgb, var(--agent-accent) 35%, var(--ink));
  text-decoration: none;
}

.chat-shell .brand-mark:hover {
  color: var(--agent-accent);
}

.chat-shell .meta {
  color: var(--muted);
  font-size: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.chat-shell .actions {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  backdrop-filter: none;
  box-shadow: none;
}

.chat-shell .ghost {
  background: transparent;
  color: var(--muted);
  border: 1px solid transparent;
  cursor: pointer;
  height: 32px;
  padding: 0 10px;
  font-size: 12.5px;
  border-radius: var(--radius-sm);
  transition:
    color 0.15s ease,
    background 0.15s ease,
    border-color 0.15s ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  text-decoration: none;
}

.chat-shell .ghost:hover:not(:disabled) {
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  border-color: transparent;
}

.chat-shell .ghost:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.chat-shell .thread-frame {
  position: relative;
  min-height: 0;
}

.chat-shell .thread {
  position: relative;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 28px var(--pad) 24px;
  display: flex;
  flex-direction: column;
  gap: 26px;
  width: 100%;
  min-width: 0;
  justify-self: stretch;
  -webkit-overflow-scrolling: touch;
  scroll-behavior: smooth;
}

.chat-shell .composer {
  padding: 14px var(--pad) calc(16px + var(--safe-bottom));
  border-top: 1px solid color-mix(in srgb, var(--agent-accent) 18%, var(--line));
  background: color-mix(in srgb, var(--panel) 82%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}

.chat-shell .composer-card {
  display: flex;
  flex-direction: column;
  gap: 0;
  width: 100%;
  border: 1px solid color-mix(in srgb, var(--agent-accent) 16%, var(--line));
  background: color-mix(in srgb, var(--fill) 92%, var(--agent-accent));
  border-radius: 22px;
  padding: 4px 8px 4px 14px;
  box-shadow: 0 2px 8px color-mix(in srgb, var(--ink) 4%, transparent);
  transition:
    border-color 0.25s ease,
    box-shadow 0.25s ease;
}

.chat-shell .composer-card:focus-within {
  border-color: color-mix(in srgb, var(--agent-accent) 42%, var(--line));
  box-shadow:
    0 2px 12px color-mix(in srgb, var(--agent-accent) 12%, transparent),
    0 0 0 3px color-mix(in srgb, var(--agent-accent) 12%, transparent);
}

.chat-shell .composer-input {
  flex: 0 0 auto;
  min-width: 0;
  width: 100%;
  max-height: var(--composer-max, 70vh);
  min-height: 130px;
  resize: none;
  border: 0;
  background: transparent;
  padding: 8px 2px 4px;
  font-size: 15px;
  line-height: 1.5;
  font-family: inherit;
  color: var(--ink);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.chat-shell .composer-input::placeholder {
  color: color-mix(in srgb, var(--muted) 70%, transparent);
}

.chat-shell .composer-input:focus,
.chat-shell .composer-input:focus-visible {
  outline: none;
  box-shadow: none;
}

.chat-shell .composer-grip {
  flex-shrink: 0;
  height: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: row-resize;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

.chat-shell .composer-grip::after {
  content: "";
  width: 44px;
  height: 3px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 16%, transparent);
  transition: background 0.15s ease, transform 0.15s ease;
}

.chat-shell .composer-grip:hover::after,
.chat-shell .composer-grip:active::after {
  background: color-mix(in srgb, var(--ink) 35%, transparent);
  transform: scaleX(1.12);
}

.chat-shell .composer-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding-top: 2px;
}

.chat-shell .toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.chat-shell .send-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: linear-gradient(
    150deg,
    var(--accent, var(--agent-accent)) 0%,
    color-mix(in srgb, var(--accent, var(--agent-accent)) 70%, #000) 100%
  );
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s ease, opacity 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease;
}

.chat-shell .send-btn:not(:disabled) {
  box-shadow: 0 2px 8px color-mix(in srgb, var(--accent, var(--agent-accent)) 30%, transparent);
}

.chat-shell .send-btn.stopping,
.chat-shell .send-btn.busy {
  background: linear-gradient(
    150deg,
    color-mix(in srgb, var(--stop) 80%, #fff) 0%,
    var(--stop) 48%,
    color-mix(in srgb, var(--stop) 70%, #000) 100%
  );
  color: #fff;
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #fff 30%, transparent),
    inset 0 -1px 0 color-mix(in srgb, #000 12%, transparent),
    0 2px 10px color-mix(in srgb, var(--stop) 30%, transparent);
  animation: chat-shell-stop-breathe 2.4s ease-in-out infinite;
}

.chat-shell .send-btn.stopping svg rect,
.chat-shell .send-btn.busy svg rect {
  transform-box: fill-box;
  transform-origin: center;
  animation: chat-shell-stop-icon-breathe 2.4s ease-in-out infinite;
}

@keyframes chat-shell-stop-breathe {
  0%,
  100% {
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 30%, transparent),
      inset 0 -1px 0 color-mix(in srgb, #000 12%, transparent),
      0 2px 8px color-mix(in srgb, var(--stop) 24%, transparent),
      0 0 0 0 color-mix(in srgb, var(--stop) 0%, transparent);
  }
  50% {
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 34%, transparent),
      inset 0 -1px 0 color-mix(in srgb, #000 12%, transparent),
      0 2px 10px color-mix(in srgb, var(--stop) 32%, transparent),
      0 0 0 7px color-mix(in srgb, var(--stop) 12%, transparent);
  }
}

@keyframes chat-shell-stop-icon-breathe {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(0.9);
    opacity: 0.66;
  }
}

.chat-shell .send-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ink) 82%, var(--line-strong));
}

.chat-shell .send-btn.stopping:hover:not(:disabled),
.chat-shell .send-btn.busy:hover:not(:disabled) {
  background: linear-gradient(
    150deg,
    color-mix(in srgb, var(--stop) 84%, #fff) 0%,
    color-mix(in srgb, var(--stop) 92%, #000) 100%
  );
  animation: none;
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #fff 32%, transparent),
    0 0 0 4px color-mix(in srgb, var(--stop) 16%, transparent);
  transform: scale(1.05);
}

.chat-shell .send-btn.stopping:hover svg rect,
.chat-shell .send-btn.busy:hover svg rect {
  animation: none;
  transform: scale(1);
  opacity: 1;
}

.chat-shell .send-btn:active:not(:disabled) {
  transform: scale(0.92);
}

.chat-shell .send-btn:disabled {
  opacity: 0.28;
  cursor: not-allowed;
}

.chat-shell .send-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 35%, transparent);
}

.chat-shell .msg {
  max-width: min(860px, 100%);
  min-width: 0;
  align-self: flex-start;
  width: fit-content;
  margin-right: auto;
  animation: chat-shell-rise 0.35s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.chat-shell .msg.user {
  max-width: min(520px, 100%);
  align-self: flex-end;
  margin-right: 0;
  margin-left: auto;
}

.chat-shell .who {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 8px;
  font-weight: 500;
}

.chat-shell .who.me {
  justify-content: flex-end;
}

.chat-shell .who .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--agent-accent) 55%, var(--muted));
  flex-shrink: 0;
}

.chat-shell .who.me .dot {
  background: var(--agent-accent);
  order: 2;
}

.chat-shell .body {
  margin: 0;
  word-break: break-word;
  overflow-wrap: anywhere;
  font-family: var(--font-body);
  font-size: 14.5px;
  line-height: 1.75;
  background: var(--fill);
  border: 1px solid var(--line);
  padding: 16px 18px;
  border-radius: var(--radius);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--ink) 3%, transparent);
}

.chat-shell .msg:not(.user) .body {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
  padding-left: 4px;
  padding-right: 4px;
}

.chat-shell .msg:not(.user) .body:hover {
  background: color-mix(in srgb, var(--agent-accent) 6%, transparent);
}

.chat-shell .msg.user .body {
  background: color-mix(in srgb, var(--agent-accent) 88%, var(--ink));
  color: #fff;
  border-color: transparent;
  border-top-right-radius: 4px;
  box-shadow: 0 2px 8px color-mix(in srgb, var(--agent-accent) 22%, transparent);
}

.chat-shell .empty-hint {
  margin: auto;
  max-width: 42ch;
  text-align: center;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.7;
  padding: 18px 20px;
  border: 1px dashed color-mix(in srgb, var(--agent-accent) 28%, var(--line));
  border-radius: calc(var(--radius) + 6px);
  background: color-mix(in srgb, var(--panel) 70%, transparent);
  backdrop-filter: blur(8px);
}

@keyframes chat-shell-rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (max-width: 720px) {
  .chat-shell .top {
    flex-wrap: wrap;
    align-items: flex-start;
  }

  .chat-shell .actions {
    width: 100%;
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  .chat-shell .thread {
    padding: 18px var(--pad) 18px;
    gap: 20px;
  }

  .chat-shell .composer {
    padding-top: 10px;
  }

  .chat-shell .composer-card {
    border-radius: 18px;
    padding: 4px 6px 4px 12px;
  }

  .chat-shell .composer-input {
    padding: 8px 2px 4px;
    font-size: 16px;
  }

  .chat-shell .composer-toolbar {
    flex-wrap: wrap;
  }

  .chat-shell .toolbar-right {
    order: 2;
  }

  .chat-shell .send-btn {
    width: 30px;
    height: 30px;
    border-radius: 10px;
  }
}

html.dark .chat-shell.booth {
  background:
    radial-gradient(820px 420px at 6% -8%, color-mix(in srgb, var(--agent-accent) 22%, transparent), transparent 58%),
    radial-gradient(640px 380px at 96% 0%, color-mix(in srgb, var(--agent-accent-2) 14%, transparent), transparent 55%),
    linear-gradient(
      165deg,
      color-mix(in srgb, var(--bg) 86%, var(--agent-accent)) 0%,
      var(--bg) 50%,
      color-mix(in srgb, var(--bg) 90%, #1c1917) 100%
    );
}
</style>
