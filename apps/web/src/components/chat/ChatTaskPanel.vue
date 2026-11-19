<script setup lang="ts">
import { ref } from "vue";
import PromptBox from "../PromptBox.vue";
import ToolsSearch from "../ToolsSearch.vue";
import SkillAddForm from "../SkillAddForm.vue";
import McpAddForm from "../McpAddForm.vue";
import UiSelect from "../UiSelect.vue";
import type {
  ConversationDto,
  McpServerStatus,
  NotifyChannelDto,
  NotifyChannelKind,
  ScheduleDto,
  ScheduleNotifyPolicy,
  SchedulePurpose,
  SkillMeta,
} from "../../api";
import { agentText, type AgentEntry } from "../../agents";
import { getUiLocale, type UiLocale } from "../../ui-locale";

type TaskDraftState = {
  name: string;
  prompt: string;
  scheduleType: "recurring" | "once";
  scheduledAt: string;
  mcpServers: string[];
  skills: string[];
  agentId: string;
  runMode: "new" | "same";
  purpose: SchedulePurpose;
  notifyPolicy: ScheduleNotifyPolicy;
};
type TaskRepeatState = {
  freq: "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";
  interval: number;
  byday: string[];
  time: string;
};
type ChannelDraftState = {
  kind: NotifyChannelKind;
  label: string;
  webhook: string;
  secret: string;
  keyword: string;
};
type RepeatFreq = {
  code: TaskRepeatState["freq"];
  unitZh: string;
  unitEn: string;
  unitPt: string;
  unitHi: string;
};
type Weekday = { code: string; zh: string; en: string; pt: string; hi: string };
type DtShortcut = { zh: string; en: string; pt: string; hi: string; fn: () => void };
type DtLabel = { zh: string; en: string; pt: string; hi: string };
type DtTimePart = { onInput: (event: Event) => void; onChange: (event: Event) => void };
type McpPanelRow = { server: McpServerStatus; state: { cls: string; text: string } };

const props = defineProps<{
  visible: boolean;
  editingTaskId: string;
  editingTask: ScheduleDto | null;
  tasksBusy: boolean;
  taskDraft: TaskDraftState;
  taskError: string;
  notifySummary: string;
  notifyDialogOpen: boolean;
  notifyChannels: NotifyChannelDto[];
  channelDraft: ChannelDraftState;
  notifyBusy: boolean;
  notifyNote: string;
  freqDialogOpen: boolean;
  taskFreqSummary: string;
  cronUnparsed: boolean;
  editingCron: string;
  repeatPreview: string;
  taskRepeat: TaskRepeatState;
  repeatFreqs: RepeatFreq[];
  minutelyIntervals: readonly number[];
  weekdays: Weekday[];
  dtOpen: boolean;
  dtPos: { top: number; left: number };
  dtDisplay: string;
  dtShortcuts: DtShortcut[];
  dtMonthLabel: string;
  dtWeekdays: DtLabel[];
  dtCells: Array<number | null>;
  isDtToday: (day: number) => boolean;
  isDtPicked: (day: number) => boolean;
  dtHour: string;
  dtMinute: string;
  dtHours: string[];
  dtMinutes: string[];
  dtHourPart: DtTimePart;
  dtMinutePart: DtTimePart;
  taskSearchAutofocus: boolean;
  taskToolsOpen: boolean;
  taskToolsPos: { left: number; bottom: number; height: number };
  taskSkillOpen: boolean;
  taskSkillQuery: string;
  taskSkillFiltered: SkillMeta[];
  skillAvailable: SkillMeta[];
  taskSkillAddOpen: boolean;
  taskMcpOpen: boolean;
  taskMcpQuery: string;
  taskMcpFiltered: McpPanelRow[];
  mcpAvailable: McpServerStatus[];
  taskMcpCount: number;
  mcpReconnecting: Set<string>;
  mcpBusy: boolean;
  taskMcpAddOpen: boolean;
  taskExpertOpen: boolean;
  taskExpertQuery: string;
  taskExpertFiltered: AgentEntry[];
  taskAgentLabel: AgentEntry | undefined;
  agentId: string;
  uiLocale: UiLocale;
  iconStyle: (key: string) => Record<string, string>;
  iconChar: (name: string) => string;
  mcpDescText: (server: McpServerStatus) => string;
  taskConvText: (task: ScheduleDto) => string;
  notifyKindLabel: (kind: NotifyChannelKind) => string;
}>();

const emit = defineEmits<{
  "close-task-form": [];
  "submit-task": [];
  "apply-task-purpose": [purpose: SchedulePurpose];
  "open-task-conversation": [task: ScheduleDto];
  "patch-task-draft": [patch: Partial<TaskDraftState>];
  "update:notifyDialogOpen": [value: boolean];
  "save-channel": [];
  "toggle-channel": [channel: NotifyChannelDto];
  "test-channel": [id: string];
  "remove-channel": [id: string];
  "patch-channel-draft": [patch: Partial<ChannelDraftState>];
  "update:freqDialogOpen": [value: boolean];
  "patch-task-repeat": [patch: Partial<TaskRepeatState>];
  "toggle-weekday": [code: string];
  "open-dt-picker": [];
  "update:dtOpen": [value: boolean];
  "shift-month": [delta: number];
  "pick-day": [day: number];
  "dt-hour-input": [event: Event];
  "dt-hour-change": [event: Event];
  "dt-minute-input": [event: Event];
  "dt-minute-change": [event: Event];
  "update:taskSkillQuery": [value: string];
  "toggle-task-skill": [dir: string];
  "task-skill-created": [dir: string];
  "toggle-task-skill-add": [];
  "cancel-task-skill-add": [];
  "clear-task-skills": [];
  "update:taskMcpQuery": [value: string];
  "toggle-task-server": [id: string];
  "reconnect-mcp": [id: string];
  "remove-custom-mcp": [id: string];
  "task-mcp-created": [id: string];
  "toggle-task-mcp-add": [];
  "cancel-task-mcp-add": [];
  "clear-task-mcp": [];
  "update:taskExpertQuery": [value: string];
  "toggle-task-tools": [];
  "open-task-flyout": [kind: "skills" | "mcp" | "expert"];
  "hover-task-flyout": [kind: "skills" | "mcp" | "expert"];
}>();

const dtRoot = ref<HTMLElement | null>(null);
const dtPanel = ref<HTMLElement | null>(null);
const taskToolsRoot = ref<HTMLElement | null>(null);
const taskToolsPanel = ref<HTMLElement | null>(null);
defineExpose({ dtRoot, dtPanel, taskToolsRoot, taskToolsPanel });

const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

function patchDraft(patch: Partial<TaskDraftState>) {
  emit('patch-task-draft', patch);
}
function patchRepeat(patch: Partial<TaskRepeatState>) {
  emit('patch-task-repeat', patch);
}
function patchChannel(patch: Partial<ChannelDraftState>) {
  emit('patch-channel-draft', patch);
}
function patchName(event: Event) {
  patchDraft({ name: (event.target as HTMLInputElement).value });
}
function patchPrompt(value: string) {
  patchDraft({ prompt: value });
}
function patchInterval(event: Event) {
  const raw = Number((event.target as HTMLInputElement).value);
  const value =
    props.taskRepeat.freq === "MINUTELY" && !(props.minutelyIntervals as readonly number[]).includes(raw)
      ? 10
      : raw;
  patchRepeat({ interval: value });
}
function patchRepeatFreq(value: string) {
  patchRepeat({ freq: value as TaskRepeatState["freq"] });
}
function patchRepeatTime(event: Event) {
  patchRepeat({ time: (event.target as HTMLInputElement).value });
}
function patchChannelKind(value: string) {
  patchChannel({ kind: value as NotifyChannelKind });
}
function patchChannelField(key: "label" | "webhook" | "secret" | "keyword", event: Event) {
  patchChannel({ [key]: (event.target as HTMLInputElement).value });
}
function patchAgentId(id: string) {
  patchDraft({ agentId: id });
}
</script>

<template>
  <Teleport v-if="visible" to="#task-panel-host">
      <!-- 内嵌主区的定时任务表单（不再是弹窗）：只有「取消」/「×」/ Esc 能退出（见 onTaskFormEsc）。 -->
      <div class="task-panel" role="region" :aria-label="tx('定时任务表单', 'Scheduled task form', 'Formulário de tarefa agendada', 'अनुसूचित कार्य फ़ॉर्म')">
        <div class="task-panel__head">
          <span class="task-panel__title">{{
            editingTaskId
              ? tx("编辑定时任务", "Edit scheduled task", "Editar tarefa agendada", "अनुसूचित कार्य संपादित करें")
              : tx("新建定时任务", "New scheduled task", "Nova tarefa agendada", "नया अनुसूचित कार्य")
          }}</span>
          <!-- 操作按钮放标题行右上角（对齐 CodeBuddy）：底部不再占一条，composer 直接贴住表单底缘。 -->
          <div class="task-panel__head-actions">
            <button class="ghost-btn" type="button" @click="emit('close-task-form')">{{ tx("取消", "Cancel", "Cancelar", "रद्द करें") }}</button>
            <button class="primary-btn" type="button" :disabled="tasksBusy" @click="emit('submit-task')">
              {{ editingTaskId ? tx("保存", "Save", "Salvar", "सहेजें") : tx("创建", "Create", "Criar", "बनाएं") }}
            </button>
          </div>
        </div>
        <div class="task-panel__body">
            <label class="field field--name">
              <span class="field__label"
                >{{ tx("名称", "Name", "Nome", "नाम") }}<span class="field__req" aria-hidden="true">*</span></span
              >
              <input class="field__input" :value="taskDraft.name" :placeholder="tx('例如：每日流量日报', 'e.g. Daily traffic report', 'Ex.: relatório diário de tráfego', 'उदा. दैनिक ट्रैफ़िक रिपोर्ट')" @input="patchName" />
            </label>
            <!-- 用途：报告 / 预警一键带默认（对齐 ChatGPT Monitoring + Datadog 主路径），不是参数仓库。 -->
            <div class="task-row">
              <span class="task-row__label">{{ tx("用途", "Purpose", "Finalidade", "उद्देश्य") }}</span>
              <div class="task-row__body">
                <div
                  class="seg seg--inline"
                  role="radiogroup"
                  :title='taskDraft.purpose === "alert" ? tx(
                    "数据预警：保存后马上检查一次并发启动确认，之后仅异常时推送",
                    "Data alert: runs once on save and sends a start confirmation, then notifies only on anomaly",
                    "Alerta de dados: roda uma vez ao salvar e confirma o início, depois só em anomalia",
                    "डेटा अलर्ट: सहेजते ही एक बार जाँच और आरंभ पुष्टि, फिर केवल असामान्य पर सूचित",
                  ) : tx(
                    "周期报告：到点出报告并推送结果",
                    "Recurring report: produce and push a report on schedule",
                    "Relatório periódico: produz e envia no horário",
                    "आवधिक रिपोर्ट: शेड्यूल पर रिपोर्ट बनाकर भेजें",
                  )'
                >
                  <button
                    type="button"
                    role="radio"
                    :aria-checked="taskDraft.purpose === 'report'"
                    class="seg__btn"
                    :class="{ active: taskDraft.purpose === 'report' }"
                    @click="emit('apply-task-purpose', 'report')"
                  >{{ tx("周期报告", "Report", "Relatório", "रिपोर्ट") }}</button>
                  <button
                    type="button"
                    role="radio"
                    :aria-checked="taskDraft.purpose === 'alert'"
                    class="seg__btn"
                    :class="{ active: taskDraft.purpose === 'alert' }"
                    @click="emit('apply-task-purpose', 'alert')"
                  >{{ tx("数据预警", "Data alert", "Alerta de dados", "डेटा अलर्ट") }}</button>
                </div>
              </div>
            </div>
            <!-- 分组：任务标识（名称）之后是「到点怎么跑、结果往哪送」；任务内容（要执行的指令）放在表单最底部。 -->
            <div class="task-section">
              <span class="task-section__label">{{
                tx("到点运行时", "At run time", "Na execução", "रन के समय")
              }}</span>
              <!-- 结果去向：每个任务独占一个对话（服务端创建），每期结果只回到那里。
                   只在编辑已有任务时显示（显示专属对话名 + 打开入口）；新建时是改不了的静态事实，不占一行。 -->
              <div
                v-if="editingTask"
                class="task-row"
                :title='tx(
                  "本任务专属对话，每期结果只写这里",
                  "This chat is exclusive to this task; each run result is written here",
                  "Conversa exclusiva desta tarefa; cada resultado é escrito aqui",
                  "यह चैट केवल इस कार्य की है; हर रन का परिणाम यहीं",
                )'
              >
                <span class="task-row__label">{{ tx("结果回到", "Results go to", "Resultado em", "परिणाम यहाँ") }}</span>
                <div class="task-row__body">
                  <span class="task-row__value">{{ taskConvText(editingTask) }}</span>
                </div>
                <button
                  class="notify-btn"
                  type="button"
                  @click="emit('open-task-conversation', editingTask)"
                >{{ tx("打开", "Open", "Abrir", "खोलें") }}</button>
              </div>
              <!-- 结果落点（docs/scheduled-task-sessions-plan.md §3.11）：对齐 ChatGPT 的 standalone / in-chat 两种任务；
                   切换只影响**此后**的运行，不动已有会话。两种落点的差异说明放悬浮提示，不铺段落。 -->
              <div class="task-row">
                <span class="task-row__label">{{ tx("结果落点", "Where results land", "Onde os resultados ficam", "परिणाम कहाँ जाएँ") }}</span>
                <div class="task-row__body">
                  <div
                    class="seg seg--inline"
                    role="radiogroup"
                    :title='taskDraft.runMode === "same" ? tx(
                      "同一会话：沿用上下文，适合连续跟踪",
                      "Same chat: keeps context, for continuous tracking",
                      "Mesma conversa: mantém contexto, para acompanhamento contínuo",
                      "वही चैट: संदर्भ बनाए रखती है, निरंतर ट्रैकिंग के लिए",
                    ) : tx(
                      "每期新会话：可单独回看与对比（默认）",
                      "New chat per run: reviewable and comparable (default)",
                      "Nova conversa por execução: revisável e comparável (padrão)",
                      "हर रन के लिए नई चैट: अलग देखी/तुलना की जा सके (डिफ़ॉल्ट)",
                    )'
                  >
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="taskDraft.runMode === 'new'"
                      class="seg__btn"
                      :class="{ active: taskDraft.runMode === 'new' }"
                      @click="patchDraft({ runMode: 'new' })"
                    >{{ tx("每期新会话", "New chat per run", "Nova conversa por execução", "हर रन के लिए नई चैट") }}</button>
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="taskDraft.runMode === 'same'"
                      class="seg__btn"
                      :class="{ active: taskDraft.runMode === 'same' }"
                      @click="patchDraft({ runMode: 'same' })"
                    >{{ tx("同一会话", "Same chat", "Mesma conversa", "वही चैट") }}</button>
                  </div>
                </div>
              </div>
              <!-- 结果通知策略：通道仍由「启用」总闸控制；这里只选「每期都推 / 仅异常时推」。 -->
              <div
                class="task-row"
                :title='taskDraft.notifyPolicy === "on_alert" ? tx(
                  "仅异常时推送：正常不推，破线每期都推。没写完结论的失败先推一条，满 60 分钟再推。模型接口报错每期写明对应状态码和原因。启用后第一次会发启动确认",
                  "On alert only: quiet when normal, every breach is pushed. A run with no conclusion notifies once, then again after 60 minutes. A model API error states its status code every run. The first run after enabling sends a start confirmation",
                  "Só em alerta: silêncio no normal, cada ruptura é enviada. Sem conclusão, avisa uma vez e de novo após 60 minutos. Erro da API do modelo informa o código em cada execução. A primeira após ativar confirma o início",
                  "केवल अलर्ट पर: सामान्य में चुप, हर उल्लंघन भेजें। बिना निष्कर्ष एक बार, फिर 60 मिनट बाद। मॉडल API त्रुटि हर बार कोड लिखे। चालू करने के बाद पहली बार आरंभ पुष्टि जाती है",
                ) : tx(
                  "每期都推。新建后马上跑一期，并发一条启动确认",
                  "Every run. A new task runs once right away and sends a start confirmation",
                  "Cada execução. Uma tarefa nova roda na hora e confirma o início",
                  "हर बार भेजें। नया कार्य तुरंत एक बार चलता है और आरंभ पुष्टि भेजता है",
                )'
              >
                <span class="task-row__label">{{ tx("通知策略", "Notify policy", "Política de notificação", "सूचना नीति") }}</span>
                <div class="task-row__body">
                  <div class="seg seg--inline" role="radiogroup">
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="taskDraft.notifyPolicy === 'always'"
                      class="seg__btn"
                      :class="{ active: taskDraft.notifyPolicy === 'always' }"
                      @click="patchDraft({ notifyPolicy: 'always' })"
                    >{{ tx("每期都推", "Every run", "Cada execução", "हर रन") }}</button>
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="taskDraft.notifyPolicy === 'on_alert'"
                      class="seg__btn"
                      :class="{ active: taskDraft.notifyPolicy === 'on_alert' }"
                      @click="patchDraft({ notifyPolicy: 'on_alert' })"
                    >{{ tx("仅异常时推", "On alert only", "Só em alerta", "केवल अलर्ट पर") }}</button>
                  </div>
                </div>
              </div>
              <!-- 结果通知通道：任务到点跑完即向所有已启用通道推送（由通道「启用」开关控制，无需逐任务勾选）。 -->
              <div
                class="task-row"
                :title='tx(
                  "向哪些通道推：由下方「管理」里各通道的启用开关控制。",
                  "Which channels get the push: controlled by each channel’s enabled switch under Manage.",
                  "Para quais canais enviar: controlado pelo interruptor de cada canal em Gerenciar.",
                  "किन चैनलों पर भेजें: प्रबंधित में प्रत्येक चैनल के सक्षम स्विच से।",
                )'
              >
                <span class="task-row__label">{{ tx("通知通道", "Notify channels", "Canais de notificação", "अधिसूचना चैनल") }}</span>
                <div class="task-row__body">
                  <span class="task-row__value">{{ notifySummary }}</span>
                </div>
                <button class="notify-btn" type="button" @click="emit('update:notifyDialogOpen', true)">{{
                  tx("管理", "Manage", "Gerenciar", "प्रबंधित करें")
                }}</button>
              </div>
              <!-- 通知通道管理弹窗：通道增删改 / 启停 / 测试都在弹窗里做，主表单只留一行摘要（整体不超一屏）。
                   modal-mask 是 position:fixed，放在任务表单的 Teleport 内不影响层级。 -->
              <div v-if="notifyDialogOpen" class="modal-mask" @click.self="emit('update:notifyDialogOpen', false)">
                <div class="modal" role="dialog" :aria-label="tx('通知通道', 'Notify channels', 'Canais de notificação', 'अधिसूचना चैनल')">
                  <div class="modal__head">
                    <span class="modal__title">{{ tx("通知通道", "Notify channels", "Canais de notificação", "अधिसूचना चैनल") }}</span>
                    <button class="modal__close" type="button" :aria-label="tx('关闭', 'Close', 'Fechar', 'बंद करें')" @click="emit('update:notifyDialogOpen', false)">×</button>
                  </div>
                  <div class="modal__body">
                    <p class="repeat-preview">{{
                      tx(
                        "任务到点运行结束时，会向所有已启用的通知通道推送结果（成功与失败都推）；只需启用通道、无需逐任务勾选。",
                        "On completion the result is pushed to every enabled notify channel (success and failure); no per-task selection needed.",
                        "Ao concluir, o resultado é enviado a todo canal de notificação ativado (sucesso e falha); sem seleção por tarefa.",
                        "पूर्ण होने पर परिणाम हर सक्षम अधिसूचना चैनल को भेजा जाता है (सफल/विफल); कोई कार्य-वार चयन नहीं।",
                      )
                    }}</p>
                    <div class="notify-manage">
                <details class="notify-collapse" open>
                  <summary>{{ tx("管理通知通道", "Manage channels", "Gerenciar canais", "चैनल प्रबंधित करें") }}</summary>
                  <div class="notify-form">
                  <!-- 自定义下拉（antd/vben 风格）：原生 select 的 option 样式无法控制，与弹窗风格割裂。 -->
                  <UiSelect
                    :model-value="channelDraft.kind"
                    class="notify-kind"
                    block
                    :options="[
                      { value: 'dingtalk', label: 'DingTalk' },
                      { value: 'feishu', label: 'Feishu' },
                      { value: 'wecom', label: '企业微信' },
                    ]"
                    :aria-label="tx('通道类型', 'Channel type', 'Tipo de canal', 'चैनल प्रकार')"
                    @update:model-value="patchChannelKind"
                  />
                  <input class="field__input" :value="channelDraft.label" :placeholder="tx('备注名（如：数据群）', 'Label (e.g. data group)', 'Nome (ex.: grupo de dados)', 'नाम (जैसे: डेटा ग्रुप)')" @input="patchChannelField('label', $event)" />
                  <input class="field__input notify-wide" :value="channelDraft.webhook" placeholder="Webhook URL" @input="patchChannelField('webhook', $event)" />
                  <input class="field__input" :value="channelDraft.secret" :placeholder="tx('加签密钥（可选）', 'Sign secret (optional)', 'Segredo da assinatura (opcional)', 'हस्ताक्षर सीक्रेट (वैकल्पिक)')" @input="patchChannelField('secret', $event)" />
                  <input class="field__input" :value="channelDraft.keyword" :placeholder="tx('关键词（可选）', 'Keyword (optional)', 'Palavra-chave (opcional)', 'कीवर्ड (वैकल्पिक)')" @input="patchChannelField('keyword', $event)" />
                  <button class="primary-btn" type="button" :disabled="notifyBusy" @click="emit('save-channel')">
                    {{ tx("保存通道", "Save channel", "Salvar canal", "चैनल सहेजें") }}
                  </button>
                </div>
                </details>
                <ul v-if="notifyChannels.length" class="notify-list">
                  <li v-for="ch in notifyChannels" :key="ch.id" class="notify-item">
                    <button
                      type="button"
                      class="notify-item__switch"
                      role="switch"
                      :aria-checked="Boolean(ch.enabled)"
                      :aria-label="tx('通道启用', 'Channel enabled', 'Canal ativo', 'चैनल सक्रिय')"
                      @click="emit('toggle-channel', ch)"
                    >
                      <span class="notify-switch" :class="{ on: Boolean(ch.enabled) }" aria-hidden="true">
                        <span class="notify-switch__knob"></span>
                      </span>
                    </button>
                    <span class="notify-item__text">
                      <span class="notify-item__label">{{ ch.label }}</span>
                      <span class="notify-item__host"
                        >{{ notifyKindLabel(ch.kind) }} · {{ ch.host }}<template v-if="ch.hasSecret"> · {{ tx("已配密钥", "secret set", "com segredo", "सीक्रेट सेट") }}</template></span
                      >
                    </span>
                    <button class="notify-btn" type="button" :disabled="notifyBusy" @click="emit('test-channel', ch.id)">
                      {{ tx("测试", "Test", "Testar", "टेस्ट") }}
                    </button>
                    <button class="notify-btn notify-btn--danger" type="button" :disabled="notifyBusy" :title="tx('删除通道', 'Delete channel', 'Excluir canal', 'चैनल हटाएँ')" @click="emit('remove-channel', ch.id)">×</button>
                  </li>
                </ul>
                <p v-if="notifyNote" class="notify-note">{{ notifyNote }}</p>
              </div>
                </div>
                <div class="modal__foot">
                  <button class="primary-btn" type="button" @click="emit('update:notifyDialogOpen', false)">{{
                    tx("完成", "Done", "Concluído", "पूर्ण")
                  }}</button>
                </div>
              </div>
            </div>
              <div class="task-row">
                <span class="task-row__label">{{ tx("执行频率", "Frequency", "Frequência", "आवृत्ति") }}</span>
                <div class="task-row__body">
                  <span class="task-row__value">{{ taskFreqSummary }}</span>
                </div>
                <button class="notify-btn" type="button" @click="emit('update:freqDialogOpen', true)">{{
                  tx("设置", "Configure", "Configurar", "कॉन्फ़िगर करें")
                }}</button>
              </div>
            <!-- 执行频率弹窗：周期 / 时刻 / 星期多选 / 高级表达式只读展示收进来，主表单只留一行摘要。 -->
            <div v-if="freqDialogOpen" class="modal-mask" @click.self="emit('update:freqDialogOpen', false)">
              <div class="modal" role="dialog" :aria-label="tx('执行频率', 'Frequency', 'Frequência', 'आवृत्ति')">
                <div class="modal__head">
                  <span class="modal__title">{{ tx("执行频率", "Frequency", "Frequência", "आवृत्ति") }}</span>
                  <button class="modal__close" type="button" :aria-label="tx('关闭', 'Close', 'Fechar', 'बंद करें')" @click="emit('update:freqDialogOpen', false)">×</button>
                </div>
                <div class="modal__body">
              <div class="freq-row">
                <div class="seg seg--inline" role="radiogroup">
                  <button type="button" role="radio" :aria-checked="taskDraft.scheduleType === 'recurring'" class="seg__btn" :disabled="cronUnparsed" :class="{ active: taskDraft.scheduleType === 'recurring' }" @click="patchDraft({ scheduleType: 'recurring' })">{{ tx("周期", "Recurring", "Recorrente", "आवधिक") }}</button>
                  <button type="button" role="radio" :aria-checked="taskDraft.scheduleType === 'once'" class="seg__btn" :disabled="cronUnparsed" :class="{ active: taskDraft.scheduleType === 'once' }" @click="patchDraft({ scheduleType: 'once' })">{{ tx("一次性", "Once", "Única", "एक बार") }}</button>
                </div>
                <template v-if="!cronUnparsed && taskDraft.scheduleType === 'recurring'">
                  <span class="freq-text">{{ tx("每", "Every", "A cada", "हर") }}</span>
                  <input
                    class="field__input freq-num"
                    type="number"
                    min="1"
                    max="99"
                    :aria-label="tx('间隔', 'Interval', 'Intervalo', 'अंतराल')"
                    :value="taskRepeat.interval"
                    @input="patchInterval"
                  />
                  <UiSelect
                    :model-value="taskRepeat.freq"
                    class="freq-unit"
                    :options="repeatFreqs.map((f) => ({ value: f.code, label: tx(f.unitZh, f.unitEn, f.unitPt, f.unitHi) }))"
                    :aria-label="tx('重复频率', 'Repeat', 'Repetição', 'दोहराव')"
                    @update:model-value="patchRepeatFreq"
                  />
                  <template v-if="taskRepeat.freq !== 'HOURLY' && taskRepeat.freq !== 'MINUTELY'">
                    <span class="freq-text">{{ tx("于", "at", "às", "को") }}</span>
                    <input class="field__input freq-time" type="time" :value="taskRepeat.time" :aria-label="tx('执行时刻', 'Run at', 'Horário', 'समय')" @input="patchRepeatTime" />
                  </template>
                </template>
                <!-- 显式 else-if：cronUnparsed 时两边都不渲染（那种任务只在下面展示原表达式）。 -->
                <template v-else-if="taskDraft.scheduleType === 'once'">
                  <div ref="dtRoot" class="dt dt--inline">
                <button
                  type="button"
                  class="field__input dt__field"
                  :aria-expanded="dtOpen"
                  @click="dtOpen ? emit('update:dtOpen', false) : emit('open-dt-picker')"
                >
                  <span :class="{ 'dt__placeholder': !taskDraft.scheduledAt }">{{
                    taskDraft.scheduledAt ? dtDisplay : tx("选择日期和时间", "Select date and time", "Selecione data e hora", "तारीख और समय चुनें")
                  }}</span>
                  <svg class="dt__icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                    <rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6" />
                    <path d="M3 9.5h18" stroke="currentColor" stroke-width="1.6" />
                    <path d="M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                  </svg>
                </button>
                <Teleport to="body">
                  <div
                    v-if="dtOpen"
                    ref="dtPanel"
                    class="dt__panel"
                    :style="{ top: dtPos.top + 'px', left: dtPos.left + 'px' }"
                  >
                  <div class="dt__short">
                    <button v-for="s in dtShortcuts" :key="s.en" type="button" class="dt__short-btn" @click="s.fn()">
                      {{ tx(s.zh, s.en, s.pt, s.hi) }}
                    </button>
                  </div>
                  <div class="dt__head">
                    <span class="dt__nav">
                      <button type="button" class="dt__nav-btn" :aria-label="tx('上一年', 'Previous year', 'Ano anterior', 'पिछला वर्ष')" @click="emit('shift-month', -12)">«</button>
                      <button type="button" class="dt__nav-btn" :aria-label="tx('上个月', 'Previous month', 'Mês anterior', 'पिछला महीना')" @click="emit('shift-month', -1)">‹</button>
                    </span>
                    <span class="dt__month">{{ dtMonthLabel }}</span>
                    <span class="dt__nav">
                      <button type="button" class="dt__nav-btn" :aria-label="tx('下个月', 'Next month', 'Próximo mês', 'अगला महीना')" @click="emit('shift-month', 1)">›</button>
                      <button type="button" class="dt__nav-btn" :aria-label="tx('下一年', 'Next year', 'Próximo ano', 'अगला वर्ष')" @click="emit('shift-month', 12)">»</button>
                    </span>
                  </div>
                  <div class="dt__grid" role="grid">
                    <span v-for="w in dtWeekdays" :key="w.en" class="dt__wd">{{ tx(w.zh, w.en, w.pt, w.hi) }}</span>
                    <template v-for="(c, i) in dtCells" :key="i">
                      <span v-if="c === null" class="dt__cell dt__cell--empty"></span>
                      <button
                        v-else
                        type="button"
                        class="dt__cell"
                        :class="{ today: isDtToday(c), sel: isDtPicked(c) }"
                        @click="emit('pick-day', c)"
                      >{{ c }}</button>
                    </template>
                  </div>
                  <div class="dt__foot">
                    <span class="dt__time-label">{{ tx("时刻", "Time", "Hora", "समय") }}</span>
                    <input
                      class="dt__sel"
                      list="dt-hour-list"
                      maxlength="2"
                      inputmode="numeric"
                      :value="dtHour"
                      :aria-label="tx('小时', 'Hour', 'Hora', 'घंटा')"
                      @input="emit('dt-hour-input', $event)"
                      @change="emit('dt-hour-change', $event)"
                    />
                    <datalist id="dt-hour-list">
                      <option v-for="h in dtHours" :key="h" :value="h"></option>
                    </datalist>
                    <span class="dt__colon">:</span>
                    <input
                      class="dt__sel"
                      list="dt-minute-list"
                      maxlength="2"
                      inputmode="numeric"
                      :value="dtMinute"
                      :aria-label="tx('分钟', 'Minute', 'Minuto', 'मिनट')"
                      @input="emit('dt-minute-input', $event)"
                      @change="emit('dt-minute-change', $event)"
                    />
                    <datalist id="dt-minute-list">
                      <option v-for="m in dtMinutes" :key="m" :value="m"></option>
                    </datalist>
                    <button type="button" class="dt__ok" @click="emit('update:dtOpen', false)">{{ tx("确定", "OK", "OK", "ठीक है") }}</button>
                  </div>
                  </div>
                </Teleport>
                  </div>
                </template>
              </div>
              <!-- 每周：星期多选单独一行（7 个圆片塞不进频率行）。 -->
              <div v-if="!cronUnparsed && taskDraft.scheduleType === 'recurring' && taskRepeat.freq === 'WEEKLY'" class="repeat-row">
                <button
                  v-for="w in weekdays"
                  :key="w.code"
                  type="button"
                  class="wd-chip"
                  :class="{ active: taskRepeat.byday.includes(w.code) }"
                  @click="emit('toggle-weekday', w.code)"
                >{{ tx(w.zh, w.en, w.pt, w.hi) }}</button>
              </div>
              <!-- 外部建的表达式：只读展示原样，不猜一个相近的覆盖它（保存时整段频率都不回传）。 -->
              <p v-if="cronUnparsed" class="repeat-preview">
                {{
                  tx(
                    "该任务用的是外部创建的高级表达式，下方选项表达不了它，本次保存不会改动频率：",
                    "This task uses an advanced expression created outside the UI; the options below cannot express it, so saving leaves the schedule untouched:",
                    "Esta tarefa usa uma expressão avançada criada fora da interface; salvar não altera o agendamento:",
                    "यह कार्य UI के बाहर बनाई गई उन्नत अभिव्यक्ति का उपयोग करता है; सहेजने पर समय-सारिणी नहीं बदलेगी:",
                  )
                }}
                <code class="cron-raw">{{ editingCron }}</code>
              </p>
              <!-- 周期任务的纯文本预览（保存的是 cron，用户看的是这句话）。 -->
              <p v-else-if="taskDraft.scheduleType === 'recurring'" class="repeat-preview">{{ repeatPreview }}</p>
                </div>
                <div class="modal__foot">
                  <button class="primary-btn" type="button" @click="emit('update:freqDialogOpen', false)">{{
                    tx("完成", "Done", "Concluído", "पूर्ण")
                  }}</button>
                </div>
              </div>
            </div>
          </div>
            <div class="field task-composer">
              <span class="field__label field__label--row"
                >{{ tx("任务内容", "Task prompt", "Conteúdo da tarefa", "कार्य निर्देश") }}<span class="field__req" aria-hidden="true">*</span></span>
              <!-- 直接复用对话输入区那套外壳（PromptBox）；工具选择也照对话区的样子放进底部工具条，
                   不再单独占一块字段——「要执行的指令」和「带哪些工具」本来就是同一件事的两半。 -->
              <PromptBox
                :model-value="taskDraft.prompt"
                @update:model-value="patchPrompt"
                :min-height="104"
                auto-grow
                :aria-label="tx('任务内容', 'Task prompt', 'Conteúdo da tarefa', 'कार्य निर्देश')"
                :placeholder="taskDraft.purpose === 'alert'
                  ? tx(
                      '写清：数据源、范围、时间窗口、超过多少算异常；取不到不要猜。例：Zoho 统计印度(IN)最近 60 分钟对话数，>300 异常。短窗口+最少字段。',
                      'State source, scope, window, threshold; do not guess if incomplete. e.g. Zoho India (IN) chats in last 60m; alert if >300. Prefer short window + minimal fields.',
                      'Fonte, escopo, janela, limiar; não invente se incompleto. Ex.: Zoho Índia (IN) últimos 60 min; alerta se >300. Janela curta + poucos campos.',
                      'स्रोत, दायरा, विंडो, थ्रेशोल्ड; अधूरा हो तो अनुमान न लगाएँ। उदा. Zoho भारत (IN) 60 मिनट; >300 अलर्ट। छोटी विंडो + कम फ़ील्ड।',
                    )
                  : tx('智能体要自动执行的自然语言指令…', 'Natural-language instruction for the agent…', 'Instrução em linguagem natural para o agente executar…', 'एजेंट के लिए स्वतः निष्पादित होने वाला प्राकृतिक-भाषा निर्देश…')"
                :hint="tx('Shift+Enter 换行', 'Shift+Enter for a new line', 'Shift+Enter nova linha', 'Shift+Enter नई पंक्ति')"
              >
                <template #toolbar-left>
                  <div ref="taskToolsRoot" class="tools-menu-box">
                    <button
                      type="button"
                      class="icon-btn"
                      :class="{ on: taskToolsOpen || taskSkillOpen || taskMcpOpen || taskExpertOpen }"
                      :aria-expanded="taskToolsOpen || taskSkillOpen || taskMcpOpen || taskExpertOpen"
                      aria-haspopup="menu"
                      :title="tx('任务工具（到点运行时生效）', 'Task tools (apply at run time)', 'Ferramentas da tarefa (valem na execução)', 'कार्य टूल (रन के समय लागू)')"
                      :aria-label="tx('任务工具（到点运行时生效）', 'Task tools (apply at run time)', 'Ferramentas da tarefa (valem na execução)', 'कार्य टूल (रन के समय लागू)')"
                      @click="emit('toggle-task-tools')"
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </button>
                  </div>
                  <!-- 菜单与飞出整体 Teleport 到 body（弹窗 overflow:auto 会裁剪 absolute 面板）：
                       锚盒 fixed 钉在触发器（左/底/高一致），内部复用对话区同款菜单/飞出样式。 -->
                  <Teleport to="body">
                    <div
                      v-if="taskToolsOpen"
                      ref="taskToolsPanel"
                      class="tools-menu-box task-tools-pop"
                      :style="{
                        left: taskToolsPos.left + 'px',
                        bottom: taskToolsPos.bottom + 'px',
                        height: taskToolsPos.height + 'px',
                      }"
                    >
                      <div class="tools-menu" role="menu">
                        <button
                          class="tools-menu__row"
                          type="button"
                          role="menuitem"
                          :aria-expanded="taskSkillOpen"
                          @click="emit('open-task-flyout', 'skills')"
                          @mouseenter="emit('hover-task-flyout', 'skills')"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M12 3l2.2 5.4L20 10l-4.4 3.6L16.8 20 12 17l-4.8 3 1.2-6.4L4 10l5.8-1.6z" />
                          </svg>
                          <span>{{ tx("技能", "Skills", "Habilidades", "स्किल") }}</span>
                          <span v-if="taskDraft.skills.length" class="tools-badge">{{ taskDraft.skills.length }}</span>
                          <span class="tools-menu__chev">›</span>
                        </button>
                        <button
                          class="tools-menu__row"
                          type="button"
                          role="menuitem"
                          :aria-expanded="taskMcpOpen"
                          @click="emit('open-task-flyout', 'mcp')"
                          @mouseenter="emit('hover-task-flyout', 'mcp')"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M9 6a3 3 0 1 1 6 0v1h2.5A1.5 1.5 0 0 1 19 8.5v3a3 3 0 0 1-3 3h-1v1a3 3 0 0 1-6 0v-1H7a3 3 0 0 1-3-3v-3A1.5 1.5 0 0 1 5.5 7H9z" />
                          </svg>
                          <span>{{ tx("连接器", "Connectors", "Conectores", "कनेक्टर") }}</span>
                          <span v-if="taskMcpCount" class="tools-badge">{{ taskMcpCount }}</span>
                          <span class="tools-menu__chev">›</span>
                        </button>
                        <button
                          class="tools-menu__row"
                          type="button"
                          role="menuitem"
                          :aria-expanded="taskExpertOpen"
                          @click="emit('open-task-flyout', 'expert')"
                          @mouseenter="emit('hover-task-flyout', 'expert')"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <circle cx="12" cy="8" r="3.4" />
                            <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
                          </svg>
                          <span>{{ tx("助手", "Assistant", "Assistente", "सहायक") }}</span>
                          <span v-if="taskAgentLabel" class="tools-badge">1</span>
                          <span class="tools-menu__chev">›</span>
                        </button>
                      </div>

                      <!-- 技能飞出：勾选写入任务草稿；面板结构对齐对话区（搜索 / 列表 / 取消全部）。 -->
                      <div v-if="taskSkillOpen" class="tools-flyout" role="dialog" :aria-label="tx('任务技能', 'Task skills', 'Habilidades da tarefa', 'कार्य स्किल')">
                        <ToolsSearch :model-value="taskSkillQuery" @update:model-value="(value) => emit('update:taskSkillQuery', value)" :placeholder="tx('搜索技能', 'Search skills', 'Buscar habilidades', 'स्किल खोजें')" :autofocus="taskSearchAutofocus" />
                        <div class="tools-list">
                          <div v-if="!taskSkillFiltered.length" class="empty-hint">
                            {{
                              skillAvailable.length
                                ? tx("没有匹配的技能", "No matching skills", "Nenhuma habilidade correspondente", "कोई मेल खाता स्किल नहीं")
                                : tx("没有可勾选的技能（默认技能无需勾选即已生效）", "No selectable skills (default skills are already in effect)", "Nenhuma habilidade selecionável (as padrão já estão ativas)", "कोई चयन-योग्य स्किल नहीं (डिफ़ॉल्ट स्किल पहले से लागू हैं)")
                            }}
                          </div>
                          <button
                            v-for="s in taskSkillFiltered"
                            :key="s.dir"
                            type="button"
                            class="tools-item"
                            :class="{ on: taskDraft.skills.includes(s.dir) }"
                            @click="emit('toggle-task-skill', s.dir)"
                          >
                            <span class="tools-item__icon" :style="iconStyle(s.dir)" aria-hidden="true">{{ iconChar(s.name) }}</span>
                            <span class="tools-item__body">
                              <span class="tools-item__name"
                                ><span class="tools-item__label" :title="s.name">{{ s.name }}</span></span
                              >
                              <span class="tools-item__desc" :title="s.description || ''">{{ s.description || tx("（无描述）", "(no description)", "(sem descrição)", "(कोई विवरण नहीं)") }}</span>
                            </span>
                            <svg v-if="taskDraft.skills.includes(s.dir)" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <path d="m5 12.5 4.5 4.5L19 7.5" />
                            </svg>
                          </button>
                        </div>
                        <div class="tools-flyout__foot">
                          <p class="flyout-hint">
                            {{ tx("勾选的技能随任务每期运行注入；默认生效的技能无需勾选。", "Checked skills are injected on every run; default skills need no check.", "Habilidades marcadas são injetadas a cada execução; as padrão dispensam marcação.", "चुने गए स्किल हर रन में लगते हैं; डिफ़ॉल्ट स्किल को चिह्नित करने की आवश्यकता नहीं।") }}
                          </p>
                          <SkillAddForm v-if="taskSkillAddOpen" @created="(dir) => emit('task-skill-created', dir)" @cancel="emit('cancel-task-skill-add')" />
                          <div class="tools-flyout__foot-row">
                            <button class="tools-flyout__add" type="button" :aria-expanded="taskSkillAddOpen" @click="emit('toggle-task-skill-add')">
                              <span class="tools-flyout__add-plus" aria-hidden="true">+</span>
                              {{ tx("添加技能", "Add skill", "Adicionar habilidade", "स्किल जोड़ें") }}
                            </button>
                            <RouterLink class="tools-flyout__manage" to="/skills">{{ tx("管理", "Manage", "Gerenciar", "प्रबंधित करें") }}</RouterLink>
                            <button
                              class="tools-flyout__action"
                              type="button"
                              :disabled="!taskDraft.skills.length"
                              @click="emit('clear-task-skills')"
                            >
                              {{ tx("取消全部", "Clear", "Limpar", "साफ़ करें") }}
                            </button>
                          </div>
                        </div>
                      </div>

                      <!-- 连接器飞出：结构对齐对话区（搜索 / 状态点 / 工具清单 / 取消全部）；勾选写入任务草稿。 -->
                      <div v-if="taskMcpOpen" class="tools-flyout" role="dialog" :aria-label="tx('任务连接器', 'Task connectors', 'Conectores da tarefa', 'कार्य कनेक्टर')">
                        <ToolsSearch :model-value="taskMcpQuery" @update:model-value="(value) => emit('update:taskMcpQuery', value)" :placeholder="tx('搜索连接器', 'Search connectors', 'Buscar conectores', 'कनेक्टर खोजें')" :autofocus="taskSearchAutofocus" />
                        <div class="tools-list">
                          <div v-if="!taskMcpFiltered.length" class="empty-hint">
                            {{
                              mcpAvailable.length
                                ? tx("没有匹配的连接器", "No matching connectors", "Nenhum conector correspondente", "कोई मेल खाने वाला कनेक्टर नहीं")
                                : tx("没有可选的 MCP 服务器", "No MCP server available", "Nenhum servidor MCP disponível", "कोई MCP सर्वर उपलब्ध नहीं")
                            }}
                          </div>
                          <div
                            v-for="item in taskMcpFiltered"
                            :key="item.server.id"
                            class="tools-item"
                            :class="{ on: taskDraft.mcpServers.includes(item.server.id) }"
                          >
                            <button
                              type="button"
                              class="tools-item__main"
                              @click="emit('toggle-task-server', item.server.id)"
                            >
                              <span class="tools-item__icon" :style="iconStyle(item.server.id)" aria-hidden="true">{{ iconChar(item.server.label) }}</span>
                              <span class="tools-item__body">
                                <span class="tools-item__name"
                                  ><span class="tools-item__label" :title="item.server.label">{{ item.server.label }}</span>
                                  <span class="mcp-status" :class="item.state.cls">
                                    <span class="mcp-dot" :class="item.state.cls"></span>
                                    {{ item.state.text }}
                                  </span>
                                </span>
                                <span class="tools-item__desc" :title="mcpDescText(item.server)">{{ mcpDescText(item.server) }}</span>
                              </span>
                              <!-- 勾选圆点在按钮内：整行（含圆圈）都是点击目标，与对话区连接器面板同构。 -->
                              <span class="tools-item__check-slot" aria-hidden="true">
                                <svg v-if="taskDraft.mcpServers.includes(item.server.id)" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                                </svg>
                              </span>
                            </button>
                            <span class="tools-item__ops">
                              <button
                                class="mcp-mini"
                                type="button"
                                :disabled="!taskDraft.mcpServers.includes(item.server.id) || !!item.server.connecting || mcpReconnecting.has(item.server.id)"
                                :title="tx('重连', 'Reconnect', 'Reconectar', 'पुनः कनेक्ट')"
                                @click.stop="emit('reconnect-mcp', item.server.id)"
                              >
                                ⟳
                              </button>
                              <!-- 不可移除时占位（ghost），保证各行 ⟳ 纵向对齐。 -->
                              <button
                                class="mcp-mini"
                                :class="{ 'is-ghost': !item.server.removable }"
                                type="button"
                                :disabled="!item.server.removable || mcpBusy"
                                :tabindex="item.server.removable ? undefined : -1"
                                :title="item.server.removable ? tx('移除', 'Remove', 'Remover', 'हटाएँ') : undefined"
                                :aria-hidden="!item.server.removable"
                                @click.stop="item.server.removable && emit('remove-custom-mcp', item.server.id)"
                              >
                                ×
                              </button>
                            </span>
                          </div>
                        </div>
                        <div class="tools-flyout__foot">
                          <p class="flyout-hint">
                            {{ tx("不勾选不带 MCP；写操作到点仍按风险策略确认。", "Unchecked = no MCP; writes still confirm at run time.", "Desmarcado = sem MCP; escritas ainda confirmam na execução.", "अनचेक = बिना MCP; रन पर राइट की पुष्टि रहेगी।") }}
                          </p>
                          <McpAddForm v-if="taskMcpAddOpen" @created="(id) => emit('task-mcp-created', id)" @cancel="emit('cancel-task-mcp-add')" />
                          <div class="tools-flyout__foot-row">
                            <button class="tools-flyout__add" type="button" :aria-expanded="taskMcpAddOpen" @click="emit('toggle-task-mcp-add')">
                              <span class="tools-flyout__add-plus" aria-hidden="true">+</span>
                              {{ tx("添加连接器", "Add connector", "Adicionar conector", "कनेक्टर जोड़ें") }}
                            </button>
                            <button
                              class="tools-flyout__action"
                              type="button"
                              :disabled="!taskMcpCount"
                              @click="emit('clear-task-mcp')"
                            >
                              {{ tx("取消全部", "Clear", "Limpar", "साफ़ करें") }}
                            </button>
                          </div>
                        </div>
                      </div>

                      <!-- 助手飞出：任务角色（选入草稿，不跳转页面）；面板结构对齐对话区（搜索 / 列表）。 -->
                      <div v-if="taskExpertOpen" class="tools-flyout" role="dialog" :aria-label="tx('任务助手', 'Task assistant', 'Assistente da tarefa', 'कार्य सहायक')">
                        <ToolsSearch :model-value="taskExpertQuery" @update:model-value="(value) => emit('update:taskExpertQuery', value)" :placeholder="tx('搜索助手', 'Search assistants', 'Buscar assistentes', 'सहायक खोजें')" :autofocus="taskSearchAutofocus" />

                        <div class="tools-list">
                          <div v-if="taskExpertQuery.trim() && !taskExpertFiltered.length" class="empty-hint">
                            {{ tx("没有匹配的助手", "No matching assistants", "Nenhum assistente correspondente", "कोई मेल खाने वाला सहायक नहीं") }}
                          </div>
                          <button
                            v-if="!taskExpertQuery.trim()"
                            type="button"
                            class="tools-item"
                            :class="{ on: !taskDraft.agentId }"
                            @click="patchAgentId('')"
                          >
                            <span class="tools-item__icon" :style="iconStyle(agentId)" aria-hidden="true">{{ iconChar(agentId) }}</span>
                            <span class="tools-item__body">
                              <span class="tools-item__name"
                                ><span class="tools-item__label">{{ tx("跟随当前入口", "Follow this page", "Seguir esta página", "इस पेज के अनुसार") }}</span></span
                              >
                              <span class="tools-item__desc">{{ tx("用打开本页的角色运行任务", "Run the task as this page's agent", "Executar a tarefa como o agente desta página", "इस पेज के एजेंट के रूप में चलें") }}</span>
                            </span>
                            <svg v-if="!taskDraft.agentId" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <path d="m5 12.5 4.5 4.5L19 7.5" />
                            </svg>
                          </button>
                          <button
                            v-for="a in taskExpertFiltered"
                            :key="a.id"
                            type="button"
                            class="tools-item"
                            :class="{ on: taskDraft.agentId === a.id }"
                            @click="patchAgentId(a.id)"
                          >
                            <span class="tools-item__icon" :style="iconStyle(a.id)" aria-hidden="true">{{ a.icon }}</span>
                            <span class="tools-item__body">
                              <span class="tools-item__name"
                                ><span class="tools-item__label" :title="agentText(a.label, uiLocale)">{{ agentText(a.label, uiLocale) }}</span></span
                              >
                              <span class="tools-item__desc" :title="agentText(a.description, uiLocale)">{{ agentText(a.description, uiLocale) }}</span>
                            </span>
                            <svg v-if="taskDraft.agentId === a.id" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <path d="m5 12.5 4.5 4.5L19 7.5" />
                            </svg>
                          </button>
                        </div>
                        <div class="tools-flyout__foot">
                          <p class="flyout-hint">
                            {{ tx("角色决定每期运行的人设与技能可见性；编辑时选「跟随当前入口」保持任务原有角色不变。", "The agent decides each run's persona and skill visibility; \"Follow this page\" when editing keeps the task's current agent.", "O papel define a persona e a visibilidade de habilidades; ao editar, \"Seguir esta página\" mantém o papel atual.", "भूमिका हर रन की persona और स्किल दृश्यता तय करती है; संपादन में \"इस पेज के अनुसार\" मौजूदा भूमिका रखता है।") }}
                          </p>
                        </div>
                      </div>
                </div>
              </Teleport>
            </template>
            <template #toolbar-right>
              <button class="primary-btn" type="button" :disabled="tasksBusy" @click="emit('submit-task')">
                {{ editingTaskId ? tx("保存", "Save", "Salvar", "सहेजें") : tx("创建", "Create", "Criar", "बनाएं") }}
              </button>
            </template>
          </PromptBox>
            </div>

            <p v-if="taskError" class="field__error">{{ taskError }}</p>
        </div>
      </div>
  </Teleport>
</template>
