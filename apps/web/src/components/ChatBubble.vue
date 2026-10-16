<script setup lang="ts">
import { computed, inject, toRef } from "vue";
import ChartCard from "./ChartCard.vue";
import { bubbleContextKey } from "./bubble-context";
import type { Bubble } from "../chat-types";

const props = defineProps<{ bubble: Bubble; isLatest: boolean }>();

// 把父页面 setup 期 provide 的全部依赖一次性取回；函数与响应式集合按原名直接使用。
const ctx = inject(bubbleContextKey)!;
const {
  openReasoning,
  openSteps,
  clarifyDraft,
  uiLocale,
  currentId,
  toggleReasoning,
  toggleStep,
  cancelSubagent,
  answerToolConfirm,
  submitClarifyFreeform,
  answerClarification,
  copyBubble,
  editUserBubble,
  openArtifactPreview,
  openAlertScheduleFromChat,
  onInlineSubmitKeydown,
  formatBytes,
  reasoningTitle,
  thinkLabel,
  hasThinking,
  intentOf,
  thinkingDisplay,
  stepKey,
  stepClass,
  stepStatusText,
  toolDisplayName,
  showToolServer,
  stepSummary,
  subagentDotClass,
  subagentStatusText,
  confirmLevelText,
  confirmExpiryText,
  usageText,
  alertChipText,
  bubbleTimeText,
  isHtmlArtifact,
  renderChatMarkdown,
  alertMarkerInfo,
  bubbleBody,
  isStoppedBubble,
  workspaceDownloadUrl,
} = ctx;

// 与 ChatPage 同款的 i18n 闭包（本地定义，避免透传）。
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

// toRef 保证：流式原地改 text（同一对象）时 computed 跟踪 .text 重算；
// 整段对话重载（数组被替换、bubble 换成新对象）时也能跟随 prop 更新。
const b = toRef(props, "bubble");

// markdown 渲染是重活，按气泡缓存：仅当本气泡 text / 语言变化才重算，父组件重渲染不触发。
const alert = computed(() => alertMarkerInfo(b.value));
const bodyHtml = computed(() => renderChatMarkdown(bubbleBody(b.value), uiLocale.value));
const alertBodyHtml = computed(() =>
  alert.value ? renderChatMarkdown(alert.value.body, uiLocale.value) : "",
);
</script>

<template>
  <div class="row" :class="b.role">
    <p v-if="b.role === 'notice'" class="model-switch">{{ b.text }}</p>
    <!-- has-chart：带图表的气泡要给确定宽度（否则气泡按文字收缩，图表卡片的百分比宽度会塌成窄条）。 -->
    <div v-else class="bubble-wrap" :class="{ 'has-chart': !!b.charts?.length }">
      <div class="bubble">
        <div
          v-if="b.todos?.length || b.steps?.length || b.subagents?.length || hasThinking(b) || (b.streaming && !b.text)"
          class="reasoning"
          :class="{ open: openReasoning.has(b.id) }"
        >
          <button
            class="reasoning__head"
            :class="{ 'is-streaming': b.streaming }"
            type="button"
            :aria-expanded="openReasoning.has(b.id)"
            @click="toggleReasoning(b.id)"
          >
            <span class="reasoning__caret" aria-hidden="true"></span>
            <span class="reasoning__title">{{ reasoningTitle(b) }}</span>
            <span v-if="thinkLabel(b)" class="reasoning__time">{{ thinkLabel(b) }}</span>
            <span v-if="b.streaming" class="reasoning__spinner" aria-hidden="true"></span>
          </button>
          <div v-show="openReasoning.has(b.id)" class="reasoning__body">
            <!-- 意图行：仅当模型显式声明「意图：」才渲染；无框弱标签，替代原高亮卡
                 （原「取首句」兜底经常截出半截话，且与思考流首行重复）。 -->
            <div v-if="intentOf(b)" class="intent-line">
              <span class="intent-line__label">{{ tx("意图", "Intent", "Intenção", "इरादा") }}</span>
              <span class="intent-line__text">{{ intentOf(b) }}</span>
            </div>
            <!-- 扩展思考流：实时展示模型规划过程（已剥离显式意图行）；正文同族无衬线、限高内滚 + 流式跟底。 -->
            <pre v-if="thinkingDisplay(b)" class="reasoning__thinking">{{ thinkingDisplay(b) }}</pre>
            <p v-else-if="hasThinking(b)" class="reasoning__foreign">
              {{ tx("内部推理与当前语言不一致，已收起", "Internal reasoning is in another language and is hidden", "O raciocínio interno está em outro idioma e foi ocultado", "आंतरिक तर्क दूसरी भाषा में है, छिपा दिया गया") }}
            </p>
            <!-- 规划阶段但尚无思考流（模型不支持 thinking）：给一个「正在规划」状态，避免静默加载像卡死；
                 一旦正文开始流式（b.text 已非空）即隐藏，转为「回答中」，不再误导地停在规划态。 -->
            <div
              v-else-if="b.streaming && !b.text && !hasThinking(b) && !b.steps?.length && !b.todos?.length && !b.subagents?.length"
              class="reasoning__planning"
            >
              <span class="reasoning__planning-dot" aria-hidden="true"></span>
              {{ tx("正在分析你的请求，规划执行步骤…", "Analyzing your request and planning the next steps…", "Analisando sua solicitação e planejando os próximos passos…", "आपका अनुरोध विश्लेषण कर रहा हूँ और अगले चरणों की योजना बना रहा हूँ…") }}
            </div>
            <div v-if="b.todos?.length" class="todos">
              <div class="todos__head">{{ tx("任务计划", "Plan", "Plano", "कार्य योजना") }}</div>
              <div v-for="(item, i) in b.todos" :key="i" class="todos__item">
                <span class="todos__mark" :class="item.status" aria-hidden="true">
                  {{
                    item.status === "completed"
                      ? "✓"
                      : item.status === "in_progress"
                        ? "•"
                        : item.status === "cancelled"
                          ? "×"
                          : "○"
                  }}
                </span>
                <span
                  class="todos__text"
                  :class="{ done: item.status === 'completed' || item.status === 'cancelled' }"
                >{{ item.content }}</span>
              </div>
            </div>
            <div v-if="b.steps?.length" class="steps">
              <div
                v-for="step in b.steps"
                :key="step.id"
                class="step"
                :class="[stepClass(step.status), { expanded: openSteps.has(stepKey(b, step)) }]"
              >
                <!-- 有结果的步骤整行可点开（原生 button：键盘可达、禁用态即「纯静态行」）。 -->
                <button
                  class="step-head"
                  type="button"
                  :disabled="!step.result"
                  :aria-expanded="step.result ? openSteps.has(stepKey(b, step)) : undefined"
                  :aria-controls="step.result ? `step-result-${step.id}` : undefined"
                  @click="toggleStep(b, step)"
                >
                  <span class="mcp-dot" :class="stepClass(step.status)"></span>
                  <span class="step-name" :title="step.name">{{ toolDisplayName(step.name, uiLocale) }}</span>
                  <span v-if="showToolServer(step.name, step.server)" class="step-server">{{ step.server }}</span>
                  <span v-if="step.result && !openSteps.has(stepKey(b, step))" class="step-hint">
                    {{ stepSummary(step) }}
                  </span>
                  <span class="step-status">{{ stepStatusText(step.status) }}</span>
                  <span v-if="step.result" class="step-caret" aria-hidden="true"></span>
                </button>
                <pre
                  v-if="step.result"
                  v-show="openSteps.has(stepKey(b, step))"
                  :id="`step-result-${step.id}`"
                  class="step-result"
                >{{ step.result }}</pre>
              </div>
            </div>
            <div v-if="b.subagents?.length" class="subagents">
              <div class="subagents__head">{{ tx("子代理", "Subagents", "Subagentes", "उप-एजेंट") }}</div>
              <div v-for="sa in b.subagents" :key="sa.id" class="subagent" :class="sa.status">
                <div class="subagent__head">
                  <span class="mcp-dot" :class="subagentDotClass(sa.status)"></span>
                  <span class="subagent__desc">{{ sa.description }}</span>
                  <span class="subagent__status">{{ subagentStatusText(sa.status) }}</span>
                  <button
                    v-if="sa.status === 'running'"
                    class="subagent__cancel"
                    type="button"
                    :title="tx('取消该子代理', 'Cancel this subagent', 'Cancelar este subagente', 'इस उप-एजेंट को रद्द करें')"
                    @click="cancelSubagent(b.id, sa.id)"
                  >×</button>
                </div>
                <pre v-if="sa.text" class="subagent__text">{{ sa.text }}</pre>
              </div>
            </div>
          </div>
        </div>
        <div v-if="b.pending" class="confirm-card">
          <div class="confirm-text">
            {{ tx("工具调用需要确认", "This tool call needs your approval", "Esta chamada de ferramenta precisa da sua aprovação", "इस टूल कॉल को आपकी अनुमति चाहिए") }}：<b :title="b.pending.name">{{ toolDisplayName(b.pending.name, uiLocale) }}</b>
            <span v-if="showToolServer(b.pending.name, b.pending.server)" class="step-server">{{ b.pending.server }}</span>
            <span
              v-if="b.pending.level"
              class="confirm-level"
              :class="`confirm-level-${b.pending.level}`"
            >{{ confirmLevelText(b.pending.level) }}</span>
          </div>
          <div v-if="b.pending.reason" class="confirm-reason">{{ b.pending.reason }}</div>
          <table v-if="b.pending.argSummary?.length" class="confirm-args-table">
            <tbody>
              <tr v-for="row in b.pending.argSummary" :key="row.key">
                <td class="confirm-arg-key">{{ row.key }}</td>
                <td class="confirm-arg-val">{{ row.value }}</td>
              </tr>
            </tbody>
          </table>
          <pre v-else-if="b.pending.args" class="confirm-args">{{ b.pending.args }}</pre>
          <label v-if="b.pending.canGrantRead" class="confirm-grant">
            <input v-model="b.pending.grantRead" type="checkbox" />
            {{ tx("本对话内，把该服务器上未声明级别的工具按只读处理", "Treat undeclared tools on this server as read-only for this conversation", "Nesta conversa, tratar ferramentas sem nível declarado deste servidor como somente leitura", "इस चैट में, इस सर्वर पर अघोषित स्तर वाले टूल को केवल-पढ़ने योग्य मानें") }}
          </label>
          <div v-if="confirmExpiryText(b.pending.expiresInMs)" class="confirm-expiry">
            {{ confirmExpiryText(b.pending.expiresInMs) }}
          </div>
          <div class="confirm-ops">
            <button type="button" class="mcp-primary" @click="answerToolConfirm(b, true)">
              {{ tx("允许", "Allow", "Permitir", "अनुमति दें") }}
            </button>
            <button type="button" class="mcp-link" @click="answerToolConfirm(b, false)">
              {{ tx("拒绝", "Deny", "Recusar", "अस्वीकार करें") }}
            </button>
          </div>
        </div>
        <div v-if="b.clarification" class="confirm-card">
          <div class="confirm-text">
            {{ tx("需要你确认一下", "Need your input", "Preciso de uma confirmação", "आपकी पुष्टि आवश्यक") }}：{{ b.clarification.question }}
          </div>
          <div v-if="b.clarification.missingField || b.clarification.whyItMatters" class="clarify-why">
            <span v-if="b.clarification.missingField" class="clarify-why__field">
              {{ tx("待定项", "Open point", "Ponto em aberto", "खुला बिंदु") }}：{{ b.clarification.missingField }}
            </span>
            <span v-if="b.clarification.whyItMatters" class="clarify-why__text">
              {{ b.clarification.whyItMatters }}
            </span>
          </div>
          <div class="clarify-options">
            <button
              v-for="opt in b.clarification.options"
              :key="opt.label"
              type="button"
              class="clarify-opt"
              @click="answerClarification(b, opt.label)"
            >
              <span class="clarify-label">{{ opt.label }}</span>
              <span v-if="opt.description" class="clarify-desc">{{ opt.description }}</span>
            </button>
          </div>
          <!-- 自由文本回退：选项都不贴切时可直接补充说明（点选项不补充 = 模型拿到零信息）。 -->
          <div class="clarify-free">
            <input
              v-model="clarifyDraft[b.id]"
              type="text"
              class="clarify-free__input"
              :placeholder="tx('以上都不是？直接补充说明', 'None of these? Add your own answer', 'Nenhuma delas? Escreva a sua', 'इनमें से कोई नहीं? अपना उत्तर लिखें')"
              @keydown="onInlineSubmitKeydown($event, () => submitClarifyFreeform(b))"
            />
            <button
              type="button"
              class="clarify-free__send"
              :disabled="!(clarifyDraft[b.id] || '').trim()"
              @click="submitClarifyFreeform(b)"
            >
              {{ tx("发送", "Send", "Enviar", "भेजें") }}
            </button>
          </div>
          <div v-if="confirmExpiryText(b.clarification.expiresInMs)" class="confirm-expiry">
            {{ confirmExpiryText(b.clarification.expiresInMs) }}
          </div>
          <div class="confirm-ops">
            <button type="button" class="mcp-link" @click="answerClarification(b)">
              {{ tx("跳过，按你的理解继续", "Skip and use your best guess", "Pular e usar seu melhor palpite", "छोड़ें, अपनी समझ से आगे बढ़ें") }}
            </button>
          </div>
        </div>
        <div v-if="b.images?.length" class="thumbs">
          <img v-for="img in b.images" :key="img.id" :src="`/agent/chat/upload/${img.id}`" :alt="img.name" />
        </div>
        <div v-if="b.role === 'user'" class="plain">{{ b.text }}</div>
        <template v-else>
          <div v-if="b.supportLabels?.items?.length" class="support-labels">
            <span
              v-for="item in b.supportLabels.items"
              :key="item.id"
              class="support-label"
              :class="`support-label--${item.band}`"
            >{{ item.label }} {{ item.value }}</span>
          </div>
          <!-- 流式 loading 态完全交给推理面板（正在规划/思考中/步骤/子代理），
               答案气泡在出正文前保持空，避免与推理面板重复出现「思考中」指示。 -->
          <template v-if="b.text && alert">
            <!-- 预警协议标记渲染成状态徽章，正文在徽章下继续；原始文本不动，复制/导出仍是协议原文。 -->
            <span class="alert-chip" :class="`alert-chip--${alert!.marker.toLowerCase()}`">{{
              alertChipText(alert!.marker)
            }}</span>
            <div v-if="alert!.body" class="md" v-html="alertBodyHtml"></div>
            <!-- 「先测后跑」的下一步 CTA：挂在试跑结论末尾（内容所属处），是流程推进动作，
                 不与复制/编辑等气泡工具混排在时间戳行（此前挤在工具行里像误植，2026-10-08 用户反馈）。 -->
            <div v-if="isLatest" class="alert-cta">
              <button
                type="button"
                class="alert-cta__btn"
                :title="tx('把本轮试跑设为定时数据预警（指令与连接器会带入表单）', 'Turn this check into a scheduled data alert (prompt + connectors go to the form)', 'Transformar esta verificação em alerta agendado (prompt + conectores no formulário)', 'इस जाँच को शेड्यूल्ड डेटा अलर्ट बनाएँ (प्रॉम्प्ट + कनेक्टर फ़ॉर्म में)')"
                :aria-label="tx('设为数据预警', 'Set as data alert', 'Definir como alerta', 'डेटा अलर्ट सेट करें')"
                @click="openAlertScheduleFromChat(b)"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>
                {{ tx("设为数据预警", "Set as data alert", "Definir como alerta", "डेटा अलर्ट सेट करें") }}
              </button>
            </div>
          </template>
          <div v-else-if="b.text" class="md" v-html="bodyHtml"></div>
        </template>
        <!-- 图表卡片（render_chart 产出）：必须挂在气泡内容层——放进可折叠的推理面板会被默认折叠态
             的 display:none 隐藏，容器量到 0×0、图表完全不可见。一张一个卡片，逐张渲染、不互相覆盖。 -->
        <div v-for="(c, ci) in b.charts || []" :key="`chart-${ci}`" class="chart-card-wrap">
          <ChartCard
            :title="c.title"
            :chart-type="c.chartType"
            :data="c.data"
            :encode="c.encode"
            :options="c.options"
          />
        </div>
        <div v-for="(a, ai) in b.artifacts || []" :key="`artifact-${ai}`" class="artifact-card">
          <span class="artifact-card__name" :title="a.name">{{ a.name }}</span>
          <span class="artifact-card__meta">{{ formatBytes(a.bytes) }}</span>
          <button
            v-if="isHtmlArtifact(a)"
            type="button"
            class="artifact-card__btn"
            @click="openArtifactPreview(a)"
          >{{ tx('预览', 'Preview', 'Vista', 'पूर्वावलोकन') }}</button>
          <a
            class="artifact-card__btn"
            :href="workspaceDownloadUrl(currentId, a.path)"
            :download="a.name"
          >{{ tx('下载', 'Download', 'Descargar', 'डाउनलोड') }}</a>
        </div>
        <div v-if="isStoppedBubble(b)" class="stopped-tag">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
          {{ tx("已停止生成", "Stopped", "Geração interrompida", "उत्पादन रोक दिया गया") }}
        </div>
        <div v-if="b.error" class="err">{{ b.error }}</div>
        <div v-if="b.usage" class="usage-line">{{ usageText(b.usage) }}</div>
      </div>
        <time v-if="b.at" class="bubble-time" :datetime="new Date(b.at).toISOString()">{{ bubbleTimeText(b.at) }}</time>
        <div class="bubble-actions">
        <button
          v-if="b.role === 'user'"
          type="button"
          class="bubble-act"
          :title="tx('编辑', 'Edit', 'Editar', 'संपादित करें')"
          :aria-label="tx('编辑', 'Edit', 'Editar', 'संपादित करें')"
          @click="editUserBubble(b)"
        ><span class="flip-x">✎</span></button>
        <button
          type="button"
          class="bubble-act"
          :title="tx('复制', 'Copy', 'Copiar', 'कॉपी करें')"
          :aria-label="tx('复制', 'Copy', 'Copiar', 'कॉपी करें')"
          @click="copyBubble(b)"
        >⧉</button>
      </div>
    </div>
  </div>
</template>

<!-- 气泡专用样式：从 chat-page.css 拆出，仅含 .row/.bubble/.md :deep(...) 等气泡规则，
     以本组件作用域编译命中气泡 DOM。共享类（.mcp-dot/.mcp-link/.confirm-text）在本文件与
     chat-page.css 各留一份，分别服务气泡与页面两侧 DOM，避免任一侧漏样式。

     ⚠️ 改 bubble.css 之后**必须重启 web-dev**（vite dev）才会生效：本文件用
     <style scoped src="..."> 引入，vite 不会因这个 .css 依赖变更去重新编译本 SFC，
     改完刷新页面也看不到新规则（2026-10-17 实测：新增 .mcp-dot.warn 后页面 styleSheets
     里只有 chat-page.css 那份 [data-v-32b89a82]，气泡侧 [data-v-3555f277] 规则缺失、
     圆点没有背景色），重启 dev server 后气泡侧规则才编译进去。 -->
<style scoped src="./bubble.css"></style>
