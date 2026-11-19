<script setup lang="ts">
import { ref } from "vue";
import { getUiLocale } from "../../ui-locale";

type ConfirmState = {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  onConfirm: () => void;
};

defineProps<{ confirmDialog: ConfirmState | null }>();
const emit = defineEmits<{
  confirm: [];
  cancel: [];
  trap: [event: KeyboardEvent];
}>();

const confirmDialogEl = ref<HTMLElement | null>(null);
const confirmPrimaryBtn = ref<HTMLElement | null>(null);
defineExpose({ confirmDialogEl, confirmPrimaryBtn });

const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;
</script>

<template>
  <Teleport to="body">
    <div v-if="confirmDialog" class="modal-mask" @click.self="emit('cancel')">
      <div
        ref="confirmDialogEl"
        class="modal modal--confirm"
        role="alertdialog"
        aria-modal="true"
        :aria-label="confirmDialog.title"
        tabindex="-1"
        @keydown.esc.stop="emit('cancel')"
        @keydown.tab="emit('trap', $event)"
      >
        <div class="modal__body confirm-body">
          <span
            class="confirm-icon"
            :class="{ 'confirm-icon--danger': confirmDialog.danger }"
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
              <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
            </svg>
          </span>
          <div class="confirm-text">
            <div class="confirm-title">{{ confirmDialog.title }}</div>
            <p class="confirm-message">{{ confirmDialog.message }}</p>
          </div>
        </div>
        <div class="modal__foot">
          <button type="button" class="ghost-btn" @click="emit('cancel')">
            {{ tx("取消", "Cancel", "Cancelar", "रद्द करें") }}
          </button>
          <button
            ref="confirmPrimaryBtn"
            type="button"
            class="ghost-btn"
            :class="{ 'ghost-btn-danger': confirmDialog.danger }"
            @click="emit('confirm')"
          >
            {{ confirmDialog.confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
