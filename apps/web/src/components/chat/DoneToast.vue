<script setup lang="ts">
import { getUiLocale } from "../../ui-locale";

defineProps<{ doneToast: { id: string; title: string } | null }>();
const emit = defineEmits<{ view: []; close: [] }>();

const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;
</script>

<template>
  <Teleport to="body">
    <div v-if="doneToast" class="done-toast" role="status" aria-live="polite">
      <span class="done-toast__text">
        {{ tx("「", '"', '"', '"') }}{{ doneToast.title }}{{ tx("」已完成", '" finished', '" concluído', '" पूर्ण') }}
      </span>
      <button type="button" class="done-toast__view" @click="emit('view')">
        {{ tx("查看", "View", "Ver", "देखें") }}
      </button>
      <button
        type="button"
        class="done-toast__close"
        :aria-label="tx('关闭', 'Close', 'Fechar', 'बंद करें')"
        @click="emit('close')"
      >
        ×
      </button>
    </div>
  </Teleport>
</template>
