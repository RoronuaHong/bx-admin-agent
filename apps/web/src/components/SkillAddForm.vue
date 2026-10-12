<script setup lang="ts">
/** 飞出面板里的「添加技能」。写入本地技能目录，不离开对话。 */
import { ref } from "vue";
import { createSkill } from "../api";
import { getUiLocale } from "../ui-locale";

const emit = defineEmits<{ created: [dir: string]; cancel: [] }>();
const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

const busy = ref(false);
const errorText = ref("");
const dir = ref("");
const name = ref("");
const description = ref("");
const body = ref("");

async function submit() {
  busy.value = true;
  errorText.value = "";
  try {
    const result = await createSkill({
      dir: dir.value.trim(),
      name: name.value.trim(),
      description: description.value.trim(),
      roles: [],
      body: body.value,
    });
    emit("created", result.skill.dir);
  } catch (err) {
    errorText.value = String((err as Error)?.message || err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="add-form" @submit.prevent="submit" @keydown.stop>
    <div class="add-form__pair">
      <label>{{ tx("显示名", "Name", "Nome", "नाम") }}<input v-model="name" required maxlength="80" /></label>
      <label>{{ tx("目录名", "Folder", "Pasta", "फ़ोल्डर") }}<input v-model="dir" required placeholder="weekly-report" /></label>
    </div>
    <label>{{ tx("描述", "Description", "Descrição", "विवरण") }}
      <textarea v-model="description" required maxlength="1024" rows="2" :placeholder="tx('做什么，以及什么时候用', 'What it does and when to use it', 'O que faz e quando usar', 'क्या करता है और कब')" />
    </label>
    <label>{{ tx("步骤", "Steps", "Passos", "चरण") }}<textarea v-model="body" required rows="3" /></label>
    <p v-if="errorText" class="add-form__error">{{ errorText }}</p>
    <div class="add-form__row">
      <button class="add-form__save" type="submit" :disabled="busy">{{ busy ? tx("保存中…", "Saving…", "Salvando…", "सहेजा जा रहा है…") : tx("保存并勾选", "Save and select", "Salvar e marcar", "सहेजें और चुनें") }}</button>
      <button class="add-form__cancel" type="button" @click="emit('cancel')">{{ tx("取消", "Cancel", "Cancelar", "रद्द करें") }}</button>
    </div>
  </form>
</template>

<style scoped>
.add-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 240px;
  overflow: auto;
  padding: 2px 2px 0;
  font-size: 12px;
}
.add-form__pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.add-form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--muted, #66708a);
}
.add-form input,
.add-form textarea {
  font: inherit;
  color: var(--ink, inherit);
  border: 1px solid var(--line, #d8dee4);
  border-radius: 8px;
  padding: 6px 8px;
  background: var(--panel, #fff);
}
.add-form textarea {
  resize: vertical;
  min-height: 44px;
}
.add-form__row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.add-form__save,
.add-form__cancel {
  border-radius: 8px;
  padding: 6px 10px;
  font: inherit;
  cursor: pointer;
}
.add-form__save {
  border: none;
  background: var(--ink, #1f2328);
  color: var(--bg, #fff);
}
.add-form__save:disabled {
  opacity: 0.55;
  cursor: default;
}
.add-form__cancel {
  border: none;
  background: transparent;
  color: var(--muted, #66708a);
}
.add-form__error {
  margin: 0;
  color: #c0392b;
}
</style>
