<script setup lang="ts">
import { getUiLocale } from "../ui-locale";

defineProps<{
  title: string;
  intro: string;
  how: string[];
  examples: string[];
  note: string;
}>();

const emit = defineEmits<{
  "use-example": [text: string];
  "open-docs": [];
}>();

const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;
</script>

<template>
  <section class="help-card" aria-label="help">
    <h3 class="help-title">{{ title }}</h3>
    <p class="help-intro">{{ intro }}</p>
    <ul v-if="how.length" class="help-how">
      <li v-for="line in how" :key="line">{{ line }}</li>
    </ul>
    <p v-if="examples.length" class="help-label">{{ tx("点一下填入输入框", "Click to fill the input", "Clique para preencher", "क्लिक करके भरें") }}</p>
    <div class="help-chips">
      <button
        v-for="ex in examples"
        :key="ex"
        type="button"
        class="help-chip"
        @click="emit('use-example', ex)"
      >
        {{ ex }}
      </button>
    </div>
    <footer class="help-foot">
      <p class="help-note">{{ note }}</p>
      <button type="button" class="help-docs" @click="emit('open-docs')">
        {{ tx("操作说明", "Help", "Ajuda", "सहायता") }}
      </button>
    </footer>
  </section>
</template>

<style scoped>
.help-card {
  width: min(520px, 100%);
  padding: 14px 16px 12px;
  background: var(--panel, var(--fill));
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: 0 8px 24px color-mix(in srgb, var(--ink) 6%, transparent);
}

.help-title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 650;
  letter-spacing: 0.01em;
}

.help-intro {
  margin: 0 0 12px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  border-left: 3px solid color-mix(in srgb, #0f766e 55%, transparent);
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.55;
  color: color-mix(in srgb, var(--ink) 92%, transparent);
}

.help-how {
  margin: 0 0 12px;
  padding-left: 1.15em;
  font-size: 13px;
  line-height: 1.55;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
}

.help-how li {
  margin: 4px 0;
}

.help-label {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}

.help-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.help-chip {
  border: 1px solid var(--line);
  background: var(--fill);
  color: var(--ink);
  border-radius: 999px;
  padding: 7px 11px;
  font-size: 12.5px;
  line-height: 1.35;
  cursor: pointer;
  text-align: left;
}

.help-chip:hover {
  border-color: color-mix(in srgb, #0f766e 40%, var(--line));
  background: color-mix(in srgb, #0f766e 8%, var(--fill));
}

.help-foot {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
}

.help-note {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.help-docs {
  flex-shrink: 0;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--ink);
  border-radius: 10px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
}

.help-docs:hover {
  border-color: color-mix(in srgb, #0f766e 40%, var(--line));
}
</style>
