<script setup lang="ts">
import { ref } from "vue";
import PromptBox from "../PromptBox.vue";
import ToolsSearch from "../ToolsSearch.vue";
import SkillAddForm from "../SkillAddForm.vue";
import McpAddForm from "../McpAddForm.vue";
import type { McpServerStatus, SkillMeta } from "../../api";
import { agentText, type AgentEntry } from "../../agents";
import type { ConvState } from "../../composables/chat/chat-page-types";
import { getUiLocale, type UiLocale } from "../../ui-locale";

type McpPanelRow =
  | { kind: "label"; key: string; text: string }
  | {
      kind: "server";
      key: string;
      server: McpServerStatus;
      bound: boolean;
      state: { cls: string; text: string };
    };

defineProps<{
  visible: boolean;
  current: ConvState;
  modelValue: string;
  canSend: boolean;
  imagesUnsupported: boolean;
  composerPlaceholder: string;
  minHeight: number;
  maxHeight: number;
  toolsMenuOpen: boolean;
  skillOpen: boolean;
  mcpOpen: boolean;
  expertOpen: boolean;
  currentSendMode: "preempt" | "queue";
  currentExpert: AgentEntry | undefined;
  uiLocale: UiLocale;
  agentId: string;
  enabledMcpCount: number;
  skillQuery: string;
  skillAvailable: SkillMeta[];
  skillFiltered: SkillMeta[];
  skillBusy: boolean;
  skillAddOpen: boolean;
  skillError: string;
  searchAutofocus: boolean;
  iconStyle: (key: string) => Record<string, string>;
  iconChar: (name: string) => string;
  mcpQuery: string;
  mcpAvailable: McpServerStatus[];
  mcpFiltered: McpServerStatus[];
  mcpPanelRows: McpPanelRow[];
  mcpBusy: boolean;
  boundMcpIds: string[];
  mcpReconnecting: Set<string>;
  canClearOptionalMcp: boolean;
  mcpAddOpen: boolean;
  mcpError: string;
  mcpDescText: (server: McpServerStatus) => string;
  expertQuery: string;
  expertFiltered: AgentEntry[];
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  "composer-input": [event: Event];
  keydown: [event: KeyboardEvent];
  "move-queue-item": [index: number, dir: 1 | -1];
  "edit-queue-item": [index: number];
  "remove-queue-item": [index: number];
  "send-queue-item-now": [index: number];
  "remove-pending-image": [id: string];
  "remove-pending-doc": [id: string];
  "pick-files": [event: Event];
  "start-composer-resize": [event: MouseEvent];
  "reset-composer-size": [];
  "toggle-tools-menu": [];
  "close-tools-panels": [];
  "toggle-send-mode": [];
  "clear-expert": [];
  "open-skill-panel": [];
  "open-mcp-panel": [];
  "open-expert-panel": [];
  "hover-flyout": [kind: "skills" | "mcp" | "expert"];
  "update:skillQuery": [value: string];
  "toggle-skill": [dir: string, enabled: boolean];
  "skill-created": [dir: string];
  "toggle-skill-add": [];
  "cancel-skill-add": [];
  "clear-skill-selection": [];
  "update:mcpQuery": [value: string];
  "toggle-mcp": [id: string, enabled: boolean];
  "reconnect-mcp": [id: string];
  "remove-custom-mcp": [id: string];
  "mcp-created": [id: string];
  "toggle-mcp-add": [];
  "cancel-mcp-add": [];
  "clear-mcp-selection": [];
  "update:expertQuery": [value: string];
  "pick-expert": [agent: AgentEntry];
  stop: [];
  send: [];
}>();

const fileInput = ref<HTMLInputElement | null>(null);
const promptBoxEl = ref<InstanceType<typeof PromptBox> | null>(null);
const stopBtnRef = ref<HTMLButtonElement | null>(null);
const toolsRoot = ref<HTMLElement | null>(null);
defineExpose({ fileInput, promptBoxEl, stopBtnRef, toolsRoot });

const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

function openFilePicker() {
  fileInput.value?.click();
  emit('close-tools-panels');
}
</script>

<template>
  <footer v-show="visible" class="composer">
        <div v-if="current.queue.length" class="queue" role="region" :aria-label="tx('待发队列', 'Message queue', 'Fila de envio', 'प्रेषण कतार')">
          <div class="queue__head">
            <span>{{ tx("排队中", "Queued", "Na fila", "कतार में") }} · {{ current.queue.length }}</span>
            <span class="queue__hint">{{ tx("生成结束后按序自动发送", "Sent in order after the current reply", "Enviadas em ordem após a resposta atual", "वर्तमान उत्तर के बाद क्रम से स्वतः भेजा जाएगा") }}</span>
          </div>
          <div v-for="(item, i) in current.queue" :key="item.at" class="queue__item">
            <span class="queue__text">{{ item.text || (item.docs && item.docs.length ? `（${item.docs.length} 个附件）` : tx("（仅图片）", "(images only)", "(apenas imagens)", "(केवल छवियाँ)")) }}</span>
            <span class="queue__ops">
              <button
                type="button"
                :disabled="i === 0"
                :title="tx('上移', 'Move up', 'Mover para cima', 'ऊपर ले जाएं')"
                :aria-label="tx('上移', 'Move up', 'Mover para cima', 'ऊपर ले जाएं')"
                @click="emit('move-queue-item', i, -1)"
              >
                ↑
              </button>
              <button
                type="button"
                :disabled="i === current.queue.length - 1"
                :title="tx('下移', 'Move down', 'Mover para baixo', 'नीचे ले जाएं')"
                :aria-label="tx('下移', 'Move down', 'Mover para baixo', 'नीचे ले जाएं')"
                @click="emit('move-queue-item', i, 1)"
              >
                ↓
              </button>
              <button type="button" @click="emit('edit-queue-item', i)">{{ tx("编辑", "Edit", "Editar", "संपादित करें") }}</button>
              <button type="button" :title="tx('移除', 'Remove', 'Remover', 'हटाएं')" :aria-label="tx('移除', 'Remove', 'Remover', 'हटाएं')" @click="emit('remove-queue-item', i)">
                ×
              </button>
              <button type="button" class="queue__send" @click="emit('send-queue-item-now', i)">
                {{ tx("立即发送", "Send now", "Enviar agora", "अभी भेजें") }}
              </button>
            </span>
          </div>
        </div>
        <div v-if="current.pendingImages.length" class="pending">
          <span v-for="img in current.pendingImages" :key="img.id" class="chip">
            {{ img.name }}
            <button
              type="button"
              :title="tx('移除', 'Remove', 'Remover', 'हटाएं')"
              :aria-label="tx('移除', 'Remove', 'Remover', 'हटाएं')"
              @click="emit('remove-pending-image', img.id)"
            >
              ×
            </button>
          </span>
        </div>
        <div v-if="current.pendingDocs.length" class="pending">
          <span v-for="doc in current.pendingDocs" :key="doc.id" class="chip">
            📎 {{ doc.name }}
            <button
              type="button"
              :title="tx('移除', 'Remove', 'Remover', 'हटाएं')"
              :aria-label="tx('移除', 'Remove', 'Remover', 'हटाएं')"
              @click="emit('remove-pending-doc', doc.id)"
            >
              ×
            </button>
          </span>
        </div>
        <div v-if="imagesUnsupported" class="warn-line">
          {{
            tx(
              "当前模型不支持图片，这些图片不会被发送给模型。请改用支持图片的模型。",
              "The current model can't read images, so they won't be sent. Pick a vision-capable model.",
              "O modelo atual não suporta imagens, então elas não serão enviadas. Escolha um modelo com suporte a visão.",
              "वर्तमान मॉडल छवियों का समर्थन नहीं करता, इसलिए वे भेजी नहीं जाएंगी। छवि-सक्षम मॉडल चुनें।",
            )
          }}
        </div>
        <div class="composer-row">
          <input
            id="chat-file-input"
            ref="fileInput"
            type="file"
            name="files"
            accept="image/*,.pdf,.docx,.xlsx,.md,.txt,.csv"
            multiple
            hidden
            @change="emit('pick-files', $event)"
          />
          <PromptBox
            ref="promptBoxEl"
            :model-value="modelValue"
            @update:model-value="(value) => emit('update:modelValue', value)"
            id="chat-input"
            name="message"
            rows="1"
            :min-height="minHeight"
            :max-height="maxHeight"
            :pad-top="6"
            :placeholder="composerPlaceholder"
            :hint="tx('Enter 发送 · Shift+Enter 换行', 'Enter to send · Shift+Enter for a new line', 'Enter envia · Shift+Enter nova linha', 'भेजने के लिए Enter · नई पंक्ति के लिए Shift+Enter')"
            @input="emit('composer-input', $event)"
            @keydown="emit('keydown', $event)"
          >
            <template #top>
              <div
                class="composer-grip"
                :title="tx('拖拽调整输入框高度，双击恢复自动', 'Drag to resize the input, double-click to reset', 'Arraste para redimensionar a entrada; duplo clique para restaurar', 'इनपुट का आकार बदलने के लिए खींचें; स्वतः बहाल करने के लिए डबल-क्लिक करें')"
                @mousedown.prevent="emit('start-composer-resize', $event)"
                @dblclick="emit('reset-composer-size')"
              >
                <span class="composer-grip__bar"></span>
              </div>
            </template>
            <template #toolbar-left>
              <div ref="toolsRoot" class="tools-menu-box">
                <button
                  type="button"
                  class="icon-btn"
                  :class="{ on: toolsMenuOpen || mcpOpen || skillOpen || expertOpen }"
                  :aria-expanded="toolsMenuOpen || mcpOpen || skillOpen || expertOpen"
                  aria-haspopup="menu"
                  :title="tx('工具', 'Tools', 'Ferramentas', 'टूल')"
                  :aria-label="tx('工具', 'Tools', 'Ferramentas', 'टूल')"
                  @click="emit('toggle-tools-menu')"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.7"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>

                <!-- 发送模式快捷切换（与 + 并列）：抢占 / 排队。右键菜单里也有同一开关。 -->
                <button
                  type="button"
                  class="sendmode-btn"
                  :class="{ 'is-queue': currentSendMode === 'queue' }"
                  :title="currentSendMode === 'preempt'
                    ? tx('当前：抢占式 · 点击查看排队模式（新消息等本轮完成）', 'Preempt: new message takes over · click to queue', 'Atual: preemptiva · clique para enfileirar', 'वर्तमान: preempt · कतार चुनने के लिए क्लिक करें')
                    : tx('当前：排队等待 · 点击切回抢占式（新消息接管本轮）', 'Queue: new messages wait · click to preempt', 'Atual: fila · clique para preemptar', 'वर्तमान: कतार · preempt पर लौटने के लिए क्लिक करें')"
                  :aria-label="currentSendMode === 'preempt'
                    ? tx('发送模式：抢占式，点击切换到排队等待', 'Send mode: preempt, click to switch to queue', 'Modo: preemptiva, clique para fila', 'मोड: preempt, कतार पर बदलें')
                    : tx('发送模式：排队等待，点击切换到抢占式', 'Send mode: queue, click to switch to preempt', 'Modo: fila, clique para preemptiva', 'मोड: कतार, preempt पर बदलें')"
                  @click="emit('toggle-send-mode')"
                >
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <template v-if="currentSendMode === 'preempt'">
                      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
                    </template>
                    <template v-else>
                      <path d="M4 6h16M4 12h16M4 18h16" />
                    </template>
                  </svg>
                </button>

                <!-- 已选专家 chip（对齐 CodeBuddy）：选中专家后显示在 + 旁，仅点 × 取消选中回通用；无 chip = 通用。 -->
                <div
                  v-if="currentExpert"
                  class="expert-chip"
                >
                  <span class="expert-chip__label">{{ agentText(currentExpert.label, uiLocale) }}</span>
                  <button
                    type="button"
                    class="expert-chip__close"
                    :title="tx('取消选中助手，回到通用助手', 'Deselect assistant, back to general assistant', 'Desmarcar assistente, voltar ao assistente geral', 'सहायक चयन रद्द करें, सामान्य सहायक पर वापस')"
                    aria-label="取消选中助手"
                    @click.stop="emit('clear-expert')"
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>

                <div v-if="toolsMenuOpen" class="tools-menu" role="menu">
                  <button
                    class="tools-menu__row"
                    type="button"
                    role="menuitem"
                    @click="openFilePicker"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
                      <circle cx="8.75" cy="10" r="1.5" />
                      <path d="M20.5 15.5 15.75 11 9.5 17.5" />
                    </svg>
                    <span>{{ tx("添加文件", "Add files", "Adicionar arquivos", "फ़ाइल जोड़ें") }}</span>
                  </button>
                  <button
                    class="tools-menu__row"
                    type="button"
                    role="menuitem"
                    :aria-expanded="skillOpen"
                    @click="emit('open-skill-panel')"
                    @mouseenter="emit('hover-flyout', 'skills')"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M12 3l2.2 5.4L20 10l-4.4 3.6L16.8 20 12 17l-4.8 3 1.2-6.4L4 10l5.8-1.6z" />
                    </svg>
                    <span>{{ tx("技能", "Skills", "Habilidades", "स्किल") }}</span>
                    <span v-if="current.settings.skillsEnabled.length" class="tools-badge">{{ current.settings.skillsEnabled.length }}</span>
                    <span class="tools-menu__chev">›</span>
                  </button>
                  <button
                    class="tools-menu__row"
                    type="button"
                    role="menuitem"
                    :aria-expanded="mcpOpen"
                    @click="emit('open-mcp-panel')"
                    @mouseenter="emit('hover-flyout', 'mcp')"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M9 6a3 3 0 1 1 6 0v1h2.5A1.5 1.5 0 0 1 19 8.5v3a3 3 0 0 1-3 3h-1v1a3 3 0 0 1-6 0v-1H7a3 3 0 0 1-3-3v-3A1.5 1.5 0 0 1 5.5 7H9z" />
                    </svg>
                    <span>{{ tx("连接器", "Connectors", "Conectores", "कनेक्टर") }}</span>
                    <span v-if="enabledMcpCount" class="tools-badge">{{ enabledMcpCount }}</span>
                    <span class="tools-menu__chev">›</span>
                  </button>
                  <button
                    class="tools-menu__row"
                    type="button"
                    role="menuitem"
                    :aria-expanded="expertOpen"
                    @click="emit('open-expert-panel')"
                    @mouseenter="emit('hover-flyout', 'expert')"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <circle cx="12" cy="8" r="3.4" />
                      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
                    </svg>
                    <span>{{ tx("助手", "Assistant", "Assistente", "सहायक") }}</span>
                    <span v-if="currentExpert" class="tools-badge">1</span>
                    <span class="tools-menu__chev">›</span>
                  </button>
                </div>

                <div v-if="skillOpen" class="tools-flyout" role="dialog" :aria-label="tx('技能', 'Skills', 'Habilidades', 'स्किल')">
                  <ToolsSearch :model-value="skillQuery" @update:model-value="(value) => emit('update:skillQuery', value)" :placeholder="tx('搜索技能', 'Search skills', 'Buscar habilidades', 'स्किल खोजें')" :autofocus="searchAutofocus" />

                  <div class="tools-list">
                    <div v-if="!skillFiltered.length" class="empty-hint">
                      {{
                        skillAvailable.length
                          ? tx("没有匹配的技能", "No matching skills", "Nenhuma habilidade correspondente", "कोई मेल खाता स्किल नहीं")
                          : tx("没有可勾选的技能（默认技能无需勾选即已生效）", "No selectable skills (default skills are already in effect)", "Nenhuma habilidade selecionável (as padrão já estão ativas)", "कोई चयन-योग्य स्किल नहीं (डिफ़ॉल्ट स्किल पहले से लागू हैं)")
                      }}
                    </div>
                    <button
                      v-for="s in skillFiltered"
                      :key="s.dir"
                      type="button"
                      class="tools-item"
                      :class="{ on: current.settings.skillsEnabled.includes(s.dir) }"
                      :disabled="skillBusy"
                      @click="emit('toggle-skill', s.dir, !current.settings.skillsEnabled.includes(s.dir))"
                    >
                      <span class="tools-item__icon" :style="iconStyle(s.dir)" aria-hidden="true">{{ iconChar(s.name) }}</span>
                      <span class="tools-item__body">
                        <span class="tools-item__name"
                          ><span class="tools-item__label" :title="s.name">{{ s.name }}</span></span
                        >
                        <span class="tools-item__desc" :title="s.description || ''">{{ s.description || tx("（无描述）", "(no description)", "(sem descrição)", "(कोई विवरण नहीं)") }}</span>
                      </span>
                      <svg v-if="current.settings.skillsEnabled.includes(s.dir)" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="m5 12.5 4.5 4.5L19 7.5" />
                      </svg>
                    </button>
                  </div>

                  <div class="tools-flyout__foot">
                    <p class="flyout-hint">
                      {{
                        tx(
                          "勾选的技能全文会注入本对话的系统提示；未勾选的技能模型仍可按需加载。",
                          "Checked skills are injected in full into this conversation's system prompt; unchecked ones load on demand.",
                          "Habilidades marcadas são injetadas por completo; as demais são carregadas sob demanda.",
                          "चुने गए स्किल पूर्ण रूप से इंजेक्ट होते हैं; बाकी ऑन-डिमांड लोड होते हैं।",
                        )
                      }}
                    </p>
                    <SkillAddForm v-if="skillAddOpen" @created="(dir) => emit('skill-created', dir)" @cancel="emit('cancel-skill-add')" />
                    <div class="tools-flyout__foot-row">
                      <button class="tools-flyout__add" type="button" :aria-expanded="skillAddOpen" @click="emit('toggle-skill-add')">
                        <span class="tools-flyout__add-plus" aria-hidden="true">+</span>
                        {{ tx("添加技能", "Add skill", "Adicionar habilidade", "स्किल जोड़ें") }}
                      </button>
                      <RouterLink class="tools-flyout__manage" to="/skills">{{ tx("管理", "Manage", "Gerenciar", "प्रबंधित करें") }}</RouterLink>
                      <button
                        class="tools-flyout__action"
                        type="button"
                        :disabled="!current.settings.skillsEnabled.length || skillBusy"
                        @click="emit('clear-skill-selection')"
                      >
                        {{ tx("取消全部", "Clear", "Limpar", "साफ़ करें") }}
                      </button>
                    </div>
                  </div>
                  <div v-if="skillError" class="mcp-error">{{ skillError }}</div>
                </div>

                <div v-if="mcpOpen" class="tools-flyout" role="dialog" :aria-label="tx('MCP 连接', 'MCP connections', 'Conexões MCP', 'MCP कनेक्शन')">
                  <ToolsSearch :model-value="mcpQuery" @update:model-value="(value) => emit('update:mcpQuery', value)" :placeholder="tx('搜索连接器', 'Search connectors', 'Buscar conectores', 'कनेक्टर खोजें')" :autofocus="searchAutofocus" />

                  <div class="tools-list">
                    <div v-if="!mcpFiltered.length" class="empty-hint">
                      {{
                        mcpAvailable.length
                          ? tx("没有匹配的连接器", "No matching connectors", "Nenhum conector correspondente", "कोई मेल खाने वाला कनेक्टर नहीं")
                          : tx("没有可选的 MCP 服务器", "No MCP server available", "Nenhum servidor MCP disponível", "कोई MCP सर्वर उपलब्ध नहीं")
                      }}
                    </div>
                    <template v-for="row in mcpPanelRows" :key="row.key">
                    <div v-if="row.kind === 'label'" class="tools-section">{{ row.text }}</div>
                    <div
                      v-else
                      class="tools-item"
                      :class="{ on: row.bound || current.settings.mcpEnabled.includes(row.server.id), 'is-bound': row.bound }"
                    >
                      <button
                        type="button"
                        class="tools-item__main"
                        :disabled="mcpBusy"
                        @click="row.bound || emit('toggle-mcp', row.server.id, !current.settings.mcpEnabled.includes(row.server.id))"
                      >
                        <span class="tools-item__icon" :style="iconStyle(row.server.id)" aria-hidden="true">{{ iconChar(row.server.label) }}</span>
                        <span class="tools-item__body">
                          <span class="tools-item__name">
                            <span class="tools-item__label" :title="row.server.label">{{ row.server.label }}</span>
                            <span v-if="row.bound" class="tools-item__pin">{{ tx("已启用", "On", "Ativo", "चालू") }}</span>
                            <span class="mcp-status" :class="row.state.cls">
                              <span class="mcp-dot" :class="row.state.cls"></span>
                              {{ row.state.text }}
                            </span>
                          </span>
                          <span class="tools-item__desc" :title="row.bound ? tx('客服助手自带，不能在这里关闭', 'Included with the support assistant and cannot be turned off here', 'Incluído no assistente de suporte e não pode ser desligado aqui', 'सहायता सहायक के साथ शामिल, यहाँ बंद नहीं किया जा सकता') : mcpDescText(row.server)">{{ row.bound ? tx("客服助手自带，不能在这里关闭", "Included with the support assistant and cannot be turned off here", "Incluído no assistente de suporte e não pode ser desligado aqui", "सहायता सहायक के साथ शामिल, यहाँ बंद नहीं किया जा सकता") : mcpDescText(row.server) }}</span>
                        </span>
                        <!-- 勾选圆点在按钮内：整行（含圆圈）都是点击目标。圆点是可见控件，
                             放在按钮外会形成「看得见点不着」的死区（曾有点击圆圈无反应的反馈）。 -->
                        <span class="tools-item__check-slot" aria-hidden="true">
                          <svg v-if="!row.bound && current.settings.mcpEnabled.includes(row.server.id)" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="m5 12.5 4.5 4.5L19 7.5" />
                          </svg>
                        </span>
                      </button>
                      <span class="tools-item__ops">
                        <button
                          class="mcp-mini"
                          type="button"
                          :disabled="!current.settings.mcpEnabled.includes(row.server.id) || mcpReconnecting.has(row.server.id)"
                          :title="tx('重连', 'Reconnect', 'Reconectar', 'पुनः कनेक्ट')"
                          @click.stop="emit('reconnect-mcp', row.server.id)"
                        >
                          ⟳
                        </button>
                        <!-- 不可移除时占位（ghost），保证各行 ⟳ 纵向对齐。 -->
                        <button
                          class="mcp-mini"
                          :class="{ 'is-ghost': !row.server.removable }"
                          type="button"
                          :disabled="!row.server.removable || mcpBusy"
                          :tabindex="row.server.removable ? undefined : -1"
                          :title="row.server.removable ? tx('移除', 'Remove', 'Remover', 'हटाएँ') : undefined"
                          :aria-hidden="!row.server.removable"
                          @click.stop="row.server.removable && emit('remove-custom-mcp', row.server.id)"
                        >
                          ×
                        </button>
                      </span>
                    </div>
                    </template>
                  </div>

                  <div class="tools-flyout__foot">
                    <p v-if="boundMcpIds.length" class="flyout-hint">
                      {{
                        tx(
                          "带「已启用」的是客服助手自带的数据源，不能在这里关闭。下面的连接器仍可按需勾选。",
                          "Items marked On come with the support assistant and cannot be turned off here. Connectors below can still be selected.",
                          "Itens marcados Ativo vêm com o assistente e não podem ser desligados aqui. Os conectores abaixo ainda podem ser escolhidos.",
                          "「चालू」 सहायता सहायक के साथ आता है और यहाँ बंद नहीं होता। नीचे के कनेक्टर चुने जा सकते हैं।",
                        )
                      }}
                    </p>
                    <McpAddForm v-if="mcpAddOpen" @created="(id) => emit('mcp-created', id)" @cancel="emit('cancel-mcp-add')" />
                    <div class="tools-flyout__foot-row">
                      <button class="tools-flyout__add" type="button" :aria-expanded="mcpAddOpen" @click="emit('toggle-mcp-add')">
                        <span class="tools-flyout__add-plus" aria-hidden="true">+</span>
                        {{ tx("添加连接器", "Add connector", "Adicionar conector", "कनेक्टर जोड़ें") }}
                      </button>
                      <button
                        class="tools-flyout__action"
                        type="button"
                        :disabled="!canClearOptionalMcp || mcpBusy"
                        @click="emit('clear-mcp-selection')"
                      >
                        {{ tx("取消全部", "Clear", "Limpar", "साफ़ करें") }}
                      </button>
                    </div>
                  </div>
                  <div v-if="mcpError" class="mcp-error">{{ mcpError }}</div>
                </div>

                <div v-if="expertOpen" class="tools-flyout" role="dialog" :aria-label="tx('助手', 'Assistant', 'Assistente', 'सहायक')">
                  <ToolsSearch :model-value="expertQuery" @update:model-value="(value) => emit('update:expertQuery', value)" :placeholder="tx('搜索助手', 'Search assistants', 'Buscar assistentes', 'सहायक खोजें')" :autofocus="searchAutofocus" />

                  <div class="tools-list">
                    <div v-if="!expertFiltered.length" class="empty-hint">
                      {{ tx("没有匹配的助手", "No matching assistants", "Nenhum assistente correspondente", "कोई मेल खाने वाला सहायक नहीं") }}
                    </div>
                    <button
                      v-for="a in expertFiltered"
                      :key="a.id"
                      type="button"
                      class="tools-item"
                      :class="{ on: a.id === agentId }"
                      @click="emit('pick-expert', a)"
                    >
                      <span class="tools-item__icon" :style="iconStyle(a.id)" aria-hidden="true">{{ a.icon }}</span>
                      <span class="tools-item__body">
                        <span class="tools-item__name"
                          ><span class="tools-item__label" :title="agentText(a.label, uiLocale)">{{ agentText(a.label, uiLocale) }}</span></span
                        >
                        <span class="tools-item__desc" :title="agentText(a.description, uiLocale)">{{ agentText(a.description, uiLocale) }}</span>
                      </span>
                      <svg v-if="a.id === agentId" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="m5 12.5 4.5 4.5L19 7.5" />
                      </svg>
                    </button>
                  </div>
                  <div class="tools-flyout__foot">
                    <p class="flyout-hint">
                      {{
                        tx(
                          "切换助手会跳转到对应角色页面，会话按角色隔离。",
                          "Switching expert jumps to that role's page; conversations are isolated per role.",
                          "Trocar especialista vai para a página daquele papel; conversas isoladas por papel.",
                          "विशेषज्ञ बदलने से उस भूमिका के पृष्ठ पर जाता है; वार्तालाप भूमिका के अनुसार अलग रहते हैं।",
                        )
                      }}
                    </p>
                  </div>
                </div>
              </div>
            </template>
            <template #toolbar-right>
              <button
                v-if="current.sending"
                ref="stopBtnRef"
                class="send stop"
                type="button"
                :title="tx('停止', 'Stop', 'Parar', 'रोकें')"
                :aria-label="tx('停止', 'Stop', 'Parar', 'रोकें')"
                @click="emit('stop')"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
              <button
                v-else
                class="send"
                type="button"
                :disabled="!canSend"
                :title="tx('发送', 'Send', 'Enviar', 'भेजें')"
                :aria-label="tx('发送', 'Send', 'Enviar', 'भेजें')"
                @click="emit('send')"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              </button>
            </template>
          </PromptBox>
        </div>
  </footer>
</template>
