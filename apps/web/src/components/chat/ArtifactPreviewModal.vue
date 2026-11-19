<script setup lang="ts">
import { getUiLocale } from "../../ui-locale";

defineProps<{
  previewHtml: { name: string; path: string; content: string } | null;
  previewLoading: boolean;
  downloadUrl: string;
}>();
const emit = defineEmits<{ close: [] }>();

const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;
</script>

<template>
  <Teleport to="body">
    <div v-if="previewHtml" class="modal-mask" @click.self="emit('close')">
      <div class="modal modal--preview" role="dialog" aria-modal="true" :aria-label="previewHtml.name">
        <div class="modal__head">
          <span class="modal__title">{{ previewHtml.name }}</span>
          <div class="modal__head-actions">
            <a class="ghost-btn" :href="downloadUrl" :download="previewHtml.name">{{
              tx("下载", "Download", "Descargar", "डाउनलोड")
            }}</a>
            <button class="modal__close" type="button" aria-label="Close" @click="emit('close')">×</button>
          </div>
        </div>
        <div class="modal__body preview-body">
          <div v-if="previewLoading" class="preview-loading">{{
            tx("加载中…", "Loading…", "Cargando…", "लोड हो रहा है…")
          }}</div>
          <iframe v-else class="preview-frame" :srcdoc="previewHtml.content" sandbox="allow-scripts"></iframe>
        </div>
      </div>
    </div>
  </Teleport>
</template>
