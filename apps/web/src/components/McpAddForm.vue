<script setup lang="ts">
/** 飞出面板里的「添加连接器」。只添加远程 HTTP MCP，不启动本机命令。 */
import { ref } from "vue";
import { saveCustomMcpServer } from "../api";
import { getUiLocale } from "../ui-locale";

const emit = defineEmits<{ created: [id: string]; cancel: [] }>();
const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

const busy = ref(false);
const errorText = ref("");
const id = ref("");
const label = ref("");
const url = ref("");
const headerName = ref("");
const headerValue = ref("");

async function submit() {
  busy.value = true;
  errorText.value = "";
  try {
    const server = await saveCustomMcpServer({
      id: id.value.trim(),
      label: label.value.trim(),
      url: url.value.trim(),
      ...(headerName.value.trim() ? { headerName: headerName.value.trim() } : {}),
      ...(headerValue.value ? { headerValue: headerValue.value } : {}),
    });
    emit("created", server.id);
  } catch (err) {
    errorText.value = String((err as Error)?.message || err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="add-form" @submit.prevent="submit" @keydown.stop>
    <p class="add-form__hint">{{ tx("远程地址。令牌只保存，不再显示。", "Remote URL. The token is stored and not shown again.", "URL remota. O token fica guardado e não volta a aparecer.", "रिमोट URL। टोकन सहेजा जाता है, फिर नहीं दिखता।") }}</p>
    <div class="add-form__pair">
      <label>{{ tx("名称", "Name", "Nome", "नाम") }}<input v-model="label" required /></label>
      <label>{{ tx("标识", "Id", "Id", "आईडी") }}<input v-model="id" required placeholder="my-docs" /></label>
    </div>
    <label>{{ tx("地址", "URL", "URL", "URL") }}<input v-model="url" required type="url" placeholder="https://example.com/mcp" /></label>
    <div class="add-form__pair">
      <label>{{ tx("请求头", "Header", "Cabeçalho", "हेडर") }}<input v-model="headerName" placeholder="Authorization" /></label>
      <label>{{ tx("值", "Value", "Valor", "मान") }}<input v-model="headerValue" type="password" autocomplete="off" /></label>
    </div>
    <p v-if="errorText" class="add-form__error">{{ errorText }}</p>
    <div class="add-form__row">
      <button class="add-form__save" type="submit" :disabled="busy">{{ busy ? tx("添加中…", "Adding…", "Adicionando…", "जोड़ा जा रहा है…") : tx("添加并勾选", "Add and select", "Adicionar e marcar", "जोड़ें और चुनें") }}</button>
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
.add-form__hint {
  margin: 0;
  color: var(--muted, #66708a);
  line-height: 1.4;
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
.add-form input {
  font: inherit;
  color: var(--ink, inherit);
  border: 1px solid var(--line, #d8dee4);
  border-radius: 8px;
  padding: 6px 8px;
  background: var(--panel, #fff);
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
