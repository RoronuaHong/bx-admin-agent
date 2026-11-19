<script setup lang="ts">
import { ref } from "vue";
import type { ConversationDto, ConvSortMode, ScheduleDto } from "../../api";
import { getUiLocale } from "../../ui-locale";

type CtxMenuState = { open: boolean; x: number; y: number; targetId: string; taskId: string };

defineProps<{
  ctxMenu: CtxMenuState;
  ctxTarget: ConversationDto | null;
  ctxTargetTask: ScheduleDto | null;
  ctxConfirm: "" | "clear";
  sortMode: ConvSortMode;
}>();

const emit = defineEmits<{
  keydown: [event: KeyboardEvent];
  "run-task-now": [];
  "open-task-conv": [];
  "edit-task": [];
  "toggle-task-enabled": [];
  "mark-task-read": [];
  "remove-task": [];
  rename: [conv: ConversationDto | null];
  "toggle-pin": [conv: ConversationDto | null];
  "restore-recent-sort": [];
  "arm-clear": [];
  "confirm-clear": [id: string];
  "ask-close-others": [];
  "toggle-archive": [id: string];
  "toggle-mute": [id: string];
  "toggle-full-access": [id: string];
  "toggle-send-mode": [id: string];
  duplicate: [id: string];
  export: [id: string, format: "md" | "json"];
  "ask-delete": [];
}>();

const ctxMenuEl = ref<HTMLElement | null>(null);
defineExpose({ ctxMenuEl });

const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;
</script>

<template>
  <Teleport to="body">
    <div
      v-if="ctxMenu.open"
      ref="ctxMenuEl"
      class="ctx-menu"
      role="menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @click.stop
      @contextmenu.prevent
      @keydown="emit('keydown', $event)"
    >
      <!-- 定时任务菜单：右键任务分组头时渲染；与对话菜单互斥（ctxTargetTask / ctxTarget 二选一）。 -->
      <template v-if="ctxTargetTask">
        <button type="button" class="ctx-item" role="menuitem" :disabled="!!ctxTargetTask.runRequestedAt" @click="emit('run-task-now')">
          {{ ctxTargetTask.runRequestedAt ? tx("即将执行", "Queued", "Na fila", "कतार में") : tx("立即执行", "Run now", "Executar agora", "अभी चलाएँ") }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="emit('open-task-conv')">
          {{ tx("打开结果对话", "Open results chat", "Abrir conversa de resultados", "परिणाम चैट खोलें") }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="emit('edit-task')">
          {{ tx("编辑任务", "Edit task", "Editar tarefa", "कार्य संपादित करें") }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="emit('toggle-task-enabled')">
          {{ ctxTargetTask.enabled ? tx("暂停任务", "Pause task", "Pausar tarefa", "कार्य रोकें") : tx("恢复任务", "Resume task", "Retomar tarefa", "कार्य फिर से चलाएं") }}
        </button>
        <button v-if="ctxTargetTask.unreadRuns" type="button" class="ctx-item" role="menuitem" @click="emit('mark-task-read')">
          {{ tx("标记已读", "Mark read", "Marcar como lido", "पढ़ा हुआ मार्क करें") }}
        </button>
        <div class="ctx-sep" role="separator"></div>
        <button type="button" class="ctx-item danger" role="menuitem" @click="emit('remove-task')">
          {{ tx("删除任务", "Delete task", "Excluir tarefa", "कार्य हटाएं") }}
        </button>
      </template>
      <template v-else>
        <button type="button" class="ctx-item" role="menuitem" @click="emit('rename', ctxTarget)">
          <span>{{ tx("重命名", "Rename", "Renomear", "नाम बदलें") }}</span>
          <kbd class="ctx-kbd">F2</kbd>
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="emit('toggle-pin', ctxTarget)">
          {{ ctxTarget?.pinnedAt ? tx("取消置顶", "Unpin", "Desafixar", "अनपिन करें") : tx("置顶", "Pin", "Fixar", "पिन करें") }}
        </button>
        <button
          v-if="sortMode === 'manual'"
          type="button"
          class="ctx-item"
          role="menuitem"
          @click="emit('restore-recent-sort')"
        >
          {{ tx("恢复自动排序", "Sort by recent", "Ordenar por recentes", "हाल के अनुसार क्रम") }}
        </button>
        <div class="ctx-sep" role="separator"></div>
        <!-- 清空对话无撤销入口：首点进入待确认，再点才执行；关闭其它对话走下方确认弹窗。 -->
        <button
          v-if="ctxConfirm !== 'clear'"
          type="button"
          class="ctx-item"
          role="menuitem"
          @click="emit('arm-clear')"
        >
          {{ tx("清空对话", "Clear chat", "Limpar conversa", "चैट खाली करें") }}
        </button>
        <button
          v-else
          data-ctx-confirm
          type="button"
          class="ctx-item danger"
          role="menuitem"
          @click="emit('confirm-clear', ctxMenu.targetId)"
        >
          {{ tx("确认清空（不可恢复）", "Confirm clear (can't be undone)", "Confirmar limpeza (irreversível)", "खाली करने की पुष्टि (अपरिवर्तनीय)") }}
        </button>
        <button
          type="button"
          class="ctx-item danger"
          role="menuitem"
          @click="emit('ask-close-others')"
        >
          {{ tx("关闭其它对话", "Close other chats", "Fechar outras conversas", "अन्य चैट बंद करें") }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="emit('toggle-archive', ctxMenu.targetId)">
          {{ ctxTarget?.archived ? tx("取消归档", "Unarchive", "Desarquivar", "अनआर्काइव करें") : tx("归档", "Archive", "Arquivar", "आर्काइव करें") }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="emit('toggle-mute', ctxMenu.targetId)">
          {{
            ctxTarget?.muted
              ? tx("取消免打扰", "Unmute", "Reativar notificações", "सूचनाएं चालू करें")
              : tx("免打扰", "Mute", "Silenciar", "सूचनाएं बंद करें")
          }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="emit('toggle-full-access', ctxMenu.targetId)">
          {{
            ctxTarget?.fullAccess === false
              ? tx("开启完全访问", "Enable full access", "Ativar acesso total", "पूर्ण एक्सेस चालू करें")
              : tx("关闭完全访问", "Disable full access", "Desativar acesso total", "पूर्ण एक्सेस बंद करें")
          }}
        </button>
        <button
          type="button"
          class="ctx-item"
          role="menuitem"
          :title="(ctxTarget?.sendMode ?? 'preempt') === 'preempt'
            ? tx('当前：抢占式（新消息接管正在生成的回复）', 'Current: preempt (new message takes over)', 'Atual: preemptiva (nova mensagem assume)', 'वर्तमान: preempt (नया संदेश अधिग्रहण करेगा)')
            : tx('当前：排队等待（新消息等本轮完成后按顺序发出）', 'Current: queue (new messages wait for the current turn)', 'Atual: fila (novas mensagens esperam a vez)', 'वर्तमान: कतार (नया संदेश अपनी बारी का इंतजार करेगा)')"
          @click="emit('toggle-send-mode', ctxMenu.targetId)"
        >
          {{
            (ctxTarget?.sendMode ?? "preempt") === "preempt"
              ? tx("发送模式：切到排队等待", "Send mode: switch to queue", "Modo de envio: mudar para fila", "भेजने का मोड: कतार पर बदलें")
              : tx("发送模式：切到抢占式", "Send mode: switch to preempt", "Modo de envio: mudar para preemptiva", "भेजने का मोड: preempt पर बदलें")
          }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="emit('duplicate', ctxMenu.targetId)">
          {{ tx("复制对话", "Duplicate", "Duplicar", "डुप्लिकेट करें") }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="emit('export', ctxMenu.targetId, 'md')">
          {{ tx("导出 Markdown", "Export Markdown", "Exportar Markdown", "मार्कडाउन निर्यात") }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="emit('export', ctxMenu.targetId, 'json')">
          {{ tx("导出 JSON", "Export JSON", "Exportar JSON", "JSON निर्यात") }}
        </button>
        <div class="ctx-sep" role="separator"></div>
        <button type="button" class="ctx-item danger" role="menuitem" @click="emit('ask-delete')">
          {{ tx("删除对话", "Delete chat", "Excluir conversa", "चैट हटाएं") }}
        </button>
      </template>
    </div>
  </Teleport>
</template>
