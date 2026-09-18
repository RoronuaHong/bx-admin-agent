<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, nextTick } from "vue";
import UiLocaleSelect from "../components/UiLocaleSelect.vue";
import ThemeToggle from "../components/ThemeToggle.vue";
import { renderChatMarkdown } from "../chat-richtext";
import { getUiLocale, type UiLocale } from "../ui-locale";
import { localizeToken } from "../localize";
import {
  streamChat,
  fetchConversations,
  createConversation,
  saveConversationMessages,
  patchConversation,
  clearConversation,
  clearConversationContext,
  getApiErrorToken,
  getApiErrorCode,
} from "../api";

/**
 * 观影助手独立页面：只保留对话框 + 输入框，无侧栏 / 模型选择器 / 工具菜单。
 * 不复用 ChatPage 的任何条件分支——这是一套干净、独立的 UI。
 * 底层能力（流式、markdown、表格、会话持久化）复用 api 与 chat-richtext。
 */

const AGENT_ID = "movie";
const AGENT_LABEL = "观影助手";

const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

interface Bubble {
  id: number;
  role: "user" | "assistant";
  text: string;
  images?: Array<{ id: string; name: string }>;
  streaming?: boolean;
  error?: string;
}

const bubbles = ref<Bubble[]>([]);
const input = ref("");
const sending = ref(false);
const notice = ref("");
const scroller = ref<HTMLElement | null>(null);
let seq = 0;
let convId = "";
let controller: AbortController | null = null;

/** 「清空对话」确认弹窗：清空不可撤销，用弹窗显式确认，避免「点错一下就没了」。 */
const showClearModal = ref(false);

/** 服务端并发保护（同会话已有任务在跑）：另一标签页、或刷新后后台任务尚未收束时会出现。 */
function isBusyError(err: unknown): boolean {
  return getApiErrorCode(err) === "CONVERSATION_BUSY";
}

function scrollToBottom() {
  nextTick(() => {
    const el = scroller.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

async function ensureConversation() {
  const list = await fetchConversations(false, AGENT_ID);
  // 取最近更新的那条（服务端不保证顺序），空会话也复用，避免每次进入都新建空会话。
  const recent = [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  if (recent) {
    convId = recent.id;
    bubbles.value = (recent.messages || []).map((m) => ({
      id: ++seq,
      role: m.role,
      text: m.text || "",
      images: m.images,
    }));
  } else {
    const conv = await createConversation({
      title: tx("观影助手对话", "Movie chat", "Conversa de filme", "फ़िल्म चैट"),
      agentId: AGENT_ID,
    });
    convId = conv.id;
    bubbles.value = [];
  }
  scrollToBottom();
}

async function persist() {
  if (!convId) return;
  // 与 /chat 一致：过滤空气泡（失败轮可能只留一个空 assistant），并用首条用户消息派生标题。
  const stored = bubbles.value
    .filter((b) => b.text || b.images?.length)
    .map((b) => ({ role: b.role, text: b.text, images: b.images }));
  const title = bubbles.value.find((b) => b.role === "user" && b.text)?.text.slice(0, 24) || undefined;
  await saveConversationMessages(convId, stored, title).catch(() => {});
}

/** 语言切换：组件已先改内存（立即生效），这里负责把偏好落到当前会话，刷新后仍生效。 */
async function onLocaleChange(locale: UiLocale) {
  if (!convId) return;
  await patchConversation(convId, { locale }).catch(() => {});
}

async function send() {
  const text = input.value.trim();
  if (!text || sending.value) return;
  // 首屏会话可能仍在建立：确保有 conversationId 再发，避免落到服务端兜底会话。
  if (!convId) await ensureConversation().catch(() => {});
  notice.value = "";
  input.value = "";
  autoGrow();
  const userBubble: Bubble = { id: ++seq, role: "user", text };
  const reply: Bubble = { id: ++seq, role: "assistant", text: "", streaming: true };
  bubbles.value.push(userBubble, reply);
  sending.value = true;
  scrollToBottom();
  controller = new AbortController();
  try {
    await streamChat(
      text,
      { conversationId: convId, agentId: AGENT_ID },
      (event) => {
        if (event.type === "text_delta") {
          reply.text += event.text;
          scrollToBottom();
        } else if (event.type === "text") {
          reply.text = event.text;
        } else if (event.type === "error") {
          // 第三参数是兜底 code 而非文案：token 自带 defaultMessage，直接本地化即可。
          reply.error = localizeToken(uiLocale.value, event.error);
        } else if (event.type === "done") {
          reply.streaming = false;
        }
      },
      controller.signal,
    );
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      // 用户主动停止：不是错误，标注「已停止生成」（与 /chat 行为一致）。
      const stoppedText = tx("（已停止生成）", "(stopped)", "(geração interrompida)", "(उत्पादन रोक दिया गया)");
      reply.text = reply.text ? `${reply.text}\n\n${stoppedText}` : stoppedText;
    } else if (isBusyError(err)) {
      // 该会话仍在生成：回滚这一轮（否则会落下没有回答的孤儿用户消息），把输入还给用户。
      bubbles.value = bubbles.value.filter((b) => b.id !== userBubble.id && b.id !== reply.id);
      input.value = text;
      autoGrow();
      notice.value = tx(
        "上一条还在生成中，请等它完成后再发送",
        "The previous reply is still generating — please wait and try again",
        "A resposta anterior ainda está sendo gerada — aguarde e tente novamente",
        "पिछला उत्तर अभी बन रहा है — कृपया प्रतीक्षा करें",
      );
    } else if (!reply.error) {
      // 不要把失败原因吞成一句「出错了」：有服务端 token 就本地化还原（限流/额度/不支持等），
      // 否则退回原始错误信息，最后才是通用兜底。
      const token = getApiErrorToken(err);
      const raw = ((err as Error)?.message || "").trim();
      reply.error = token
        ? localizeToken(uiLocale.value, token)
        : raw || tx("出错了，请稍后重试", "Something went wrong, please try again", "Algo deu errado, tente novamente", "कुछ गलत हुआ, कृपया पुनः प्रयास करें");
    }
  } finally {
    reply.streaming = false;
    sending.value = false;
    controller = null;
    await persist();
    scrollToBottom();
  }
}

function stop() {
  controller?.abort();
}

/** 打开清空确认弹窗（生成中禁止打开，避免清完又被在途的流写回气泡）。 */
function openClearModal() {
  if (sending.value) return;
  showClearModal.value = true;
}

function closeClearModal() {
  showClearModal.value = false;
}

/**
 * 在弹窗里确认后真正执行清空：本地气泡 + 服务端两条状态一起清。
 * 只清其中一条都会「清了个假空」——服务端 messages 是 UI 快照，context 才是喂给模型的历史，
 * 少了后者，下一轮模型仍会带着旧上下文回答。
 */
async function confirmClear() {
  showClearModal.value = false;
  await clearChat();
}

async function clearChat() {
  bubbles.value = [];
  notice.value = "";
  if (!convId) return;
  await Promise.all([
    clearConversation(convId).catch(() => undefined),
    clearConversationContext(convId).catch(() => undefined),
  ]);
}

/** 悬浮说明 / 无障碍名：把「为什么点不了」讲清楚，而不是给一个沉默的灰按钮。 */
const clearHint = computed(() =>
  sending.value
    ? tx("生成中，请先停止", "Still generating — stop it first", "Gerando — pare antes", "उत्पन्न हो रहा है — पहले रोकें")
    : tx("清空当前对话", "Clear current chat", "Limpar conversa atual", "वर्तमान चैट खाली करें"),
);

const ta = ref<HTMLTextAreaElement | null>(null);
function autoGrow() {
  const el = ta.value;
  if (!el) return;
  el.style.height = "auto";
  // +2 = 上下边框：scrollHeight 不含边框，而全局 box-sizing: border-box 把 height 当作含边框高度。
  // 少算这 2px 会让最后一行贴底被裁掉一点（多行输入时尤其明显）。
  el.style.height = Math.min(el.scrollHeight + 2, 160) + "px";
}

onMounted(async () => {
  document.title = `${AGENT_LABEL} · Agent`;
  await ensureConversation().catch(() => {});
});

onBeforeUnmount(() => {
  controller?.abort();
});
</script>

<template>
  <div class="mc">
    <header class="mc-top">
      <div class="mc-top-inner">
        <span class="mc-title">{{ AGENT_LABEL }}</span>
        <div class="mc-actions">
          <!-- 清空对话：与主题/语言控件同排同高；点击弹出确认框，确认后才真正清空。
               生成中禁用——清完还会被在途的流写回，先停止再清更符合直觉。 -->
          <button
            type="button"
            class="mc-clear"
            :disabled="sending || !bubbles.length"
            :title="clearHint"
            :aria-label="clearHint"
            @click="openClearModal"
          >
            <span class="mc-clear__icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M4 7h16" />
                <path d="M9 7V5h6v2" />
                <path d="M6.5 7l1 12h9l1-12" />
                <path d="M10.5 11v5" />
                <path d="M13.5 11v5" />
              </svg>
            </span>
            <span class="mc-clear__label">{{ tx("清空对话", "Clear chat", "Limpar conversa", "चैट खाली करें") }}</span>
          </button>
          <UiLocaleSelect @change="onLocaleChange" />
          <ThemeToggle />
        </div>
      </div>
    </header>

    <div ref="scroller" class="mc-scroll">
      <div class="mc-inner">
        <!-- 空态：没有对话时给一张渐变欢迎卡，避免整页只剩一片空白。 -->
        <div v-if="!bubbles.length" class="mc-welcome">
          <div class="mc-welcome__title">{{ AGENT_LABEL }}</div>
          <p class="mc-welcome__hint">
            {{
              tx(
                "说说你今天想看什么，我来帮你挑片、讲剧情、找相似的电影。",
                "Tell me what you're in the mood for — picks, plots, and lookalikes.",
                "Diga o que você quer ver — indicações, sinopses e filmes parecidos.",
                "बताइए आज क्या देखना है — सुझाव, कहानी और मिलती-जुलती फ़िल्में।",
              )
            }}
          </p>
        </div>
        <div
          v-for="b in bubbles"
          :key="b.id"
          class="mc-row"
          :class="b.role"
        >
          <div class="mc-bubble">
            <div v-if="b.images?.length" class="mc-imgs">
              <span v-for="img in b.images" :key="img.id" class="mc-img">{{ img.name }}</span>
            </div>
            <div v-if="b.role === 'user'" class="mc-plain">{{ b.text }}</div>
            <div
              v-else-if="b.text"
              class="mc-md"
              v-html="renderChatMarkdown(b.text)"
            ></div>
            <div v-else-if="b.streaming && !b.error" class="mc-typing">
              <span></span><span></span><span></span>
            </div>
            <!-- 已有正文但仍在流式（工具调用/长生成期）：补一个轻量进度提示，避免长时间无反馈。 -->
            <div v-if="b.streaming && b.text" class="mc-generating">
              <span class="mc-generating__dot"></span>
              {{ tx("生成中…", "Generating…", "Gerando…", "उत्पन्न हो रहा है…") }}
            </div>
            <div v-if="b.error" class="mc-error">{{ b.error }}</div>
          </div>
        </div>
      </div>
    </div>

    <form class="mc-composer" @submit.prevent="send">
      <div v-if="notice" class="mc-notice" role="status">{{ notice }}</div>
      <div class="mc-composer-inner">
        <textarea
          ref="ta"
          v-model="input"
          class="mc-input"
          rows="1"
          :placeholder="tx('问问观影助手…', 'Ask the movie assistant…', 'Pergunte ao assistente…', 'फ़िल्म सहायक से पूछें…')"
          @input="autoGrow"
          @keydown.enter.exact.prevent="send"
        ></textarea>
        <!-- 发送/停止统一为同一几何（47px，与输入框单行等高）：切换时不跳动；停止用语义色 + 图标，
             多语言文字放 title/aria，避免「Parar / रोकें」这类长文把按钮撑宽、挤破输入区。 -->
        <button
          v-if="!sending"
          type="submit"
          class="mc-send"
          :disabled="!input.trim()"
          :title="tx('发送', 'Send', 'Enviar', 'भेजें')"
          :aria-label="tx('发送', 'Send', 'Enviar', 'भेजें')"
        >
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 19V5" />
            <path d="M5 12l7-7 7 7" />
          </svg>
        </button>
        <button
          v-else
          type="button"
          class="mc-send mc-send--stop"
          :title="tx('停止', 'Stop', 'Parar', 'रोकें')"
          :aria-label="tx('停止', 'Stop', 'Parar', 'रोकें')"
          @click="stop"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>
      </div>
    </form>

    <!-- 清空确认弹窗：清空不可撤销，显式确认后再执行。 -->
    <Teleport to="body">
      <div v-if="showClearModal" class="mc-modal-mask" @click.self="closeClearModal">
        <div
          class="mc-modal"
          role="alertdialog"
          aria-modal="true"
          :aria-label="tx('清空当前对话', 'Clear current chat', 'Limpar conversa atual', 'वर्तमान चैट खाली करें')"
        >
          <div class="mc-modal__head">
            <span class="mc-modal__title">{{ tx("清空当前对话", "Clear current chat", "Limpar conversa atual", "वर्तमान चैट खाली करें") }}</span>
          </div>
          <div class="mc-modal__body">
            <p>{{ tx("此操作不可恢复，将清空当前对话的全部消息与上下文。确定要清空吗？", "This can't be undone — all messages and context in this chat will be cleared. Continue?", "Esta ação é irreversível — todas as mensagens e o contexto desta conversa serão apagados. Continuar?", "यह क्रिया अपरिवर्तनीय है — इस चैट का सारा संदेश और संदर्भ मिट जाएगा। जारी रखें?") }}</p>
          </div>
          <div class="mc-modal__foot">
            <button type="button" class="mc-btn-ghost" @click="closeClearModal">{{ tx("取消", "Cancel", "Cancelar", "रद्द करें") }}</button>
            <button type="button" class="mc-btn-danger" @click="confirmClear">{{ tx("清空", "Clear", "Limpar", "खाली करें") }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.mc {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  width: 100%;
  color: var(--ink);
  font-family: var(--font-body);
  /* 主色：左上浅蓝 → 右下浅橘的柔和渐变，固定铺满（不随内容滚动走位）。 */
  background: linear-gradient(158deg, #e7f1ff 0%, #f3f9ff 34%, #fff6ec 68%, #ffe7d2 100%);
  background-attachment: fixed;
}

html[data-theme="dark"] .mc {
  background: linear-gradient(158deg, #0a1622 0%, #0c0f14 42%, #17110a 74%, #22170c 100%);
  background-attachment: fixed;
}

.mc-top {
  flex: 0 0 auto;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(59, 130, 246, 0.14);
  /* 玻璃顶栏：浅蓝 → 浅橘半透明，滚动内容从底下透出一点。 */
  background: linear-gradient(120deg, rgba(219, 234, 254, 0.86), rgba(255, 237, 213, 0.7));
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

html[data-theme="dark"] .mc-top {
  border-bottom-color: rgba(147, 197, 253, 0.16);
  background: linear-gradient(120deg, rgba(17, 34, 54, 0.86), rgba(48, 31, 16, 0.72));
}

.mc-top-inner {
  max-width: 760px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.mc-title {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.2px;
  /* 渐变文字：蓝 → 橘，与页面主色一致。 */
  background: linear-gradient(92deg, #2f6fed 0%, #6aa8f5 46%, #ef8a3c 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

html[data-theme="dark"] .mc-title {
  background: linear-gradient(92deg, #93c5fd 0%, #bfdbfe 44%, #fdba74 100%);
  -webkit-background-clip: text;
  background-clip: text;
}

/* 标题前的渐变圆点（呼吸感的小装饰，纯装饰性）。 */
.mc-title::before {
  content: "";
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: linear-gradient(135deg, #60a5fa, #fb923c);
  box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.18);
}

.mc-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 清空按钮：几何与主题/语言控件一致（同一 var(--ctrl-h) / 圆角），避免顶栏参差。
   待确认态转语义红：这是不可撤销操作，颜色先变比只换文案更容易被看见。 */
.mc-clear {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: var(--ctrl-h);
  min-height: var(--ctrl-h);
  min-width: var(--ctrl-h);
  padding: 0 12px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  border-radius: var(--radius-sm);
  transition:
    color 0.15s ease,
    background 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    transform 0.15s var(--ease);
  white-space: nowrap;
  flex: none;
}

.mc-clear:hover:not(:disabled) {
  color: var(--ink);
  background: var(--fill-soft);
  border-color: color-mix(in srgb, var(--ink) 28%, var(--line));
}

.mc-clear:active:not(:disabled) {
  transform: scale(0.97);
}

.mc-clear:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--ink) 30%, var(--line));
  box-shadow: var(--ring);
}

.mc-clear:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 清空确认弹窗：遮罩 + 居中卡片，复用全局主题变量（与 /chat 的 modal 同一套语义）。 */
.mc-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: color-mix(in srgb, var(--ink) 38%, transparent);
  backdrop-filter: blur(2px);
}

.mc-modal {
  width: 100%;
  max-width: 420px;
  background: var(--panel);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
}

.mc-modal__head {
  padding: 16px 18px;
  border-bottom: 1px solid var(--line);
}

.mc-modal__title {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
}

.mc-modal__body {
  padding: 16px 18px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--muted);
}

.mc-modal__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 18px;
  border-top: 1px solid var(--line);
}

.mc-btn-ghost {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  border-radius: var(--radius);
  padding: 8px 16px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.mc-btn-ghost:hover {
  color: var(--ink);
  background: var(--fill-soft);
  border-color: color-mix(in srgb, var(--ink) 26%, var(--line));
}

.mc-btn-ghost:focus-visible,
.mc-btn-danger:focus-visible {
  box-shadow: var(--ring);
}

.mc-btn-danger {
  border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--line));
  background: var(--danger);
  color: #fff;
  border-radius: var(--radius);
  padding: 8px 16px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s var(--ease);
}

.mc-btn-danger:hover {
  background: color-mix(in srgb, var(--danger) 86%, #000);
}

.mc-btn-danger:active {
  transform: scale(0.97);
}

.mc-clear__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
}

@media (max-width: 720px) {
  .mc-clear__label {
    display: none;
  }

  .mc-clear {
    padding: 0;
    min-width: var(--ctrl-h);
    width: var(--ctrl-h);
    height: var(--ctrl-h);
  }
}

.mc-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
  scrollbar-color: rgba(96, 165, 250, 0.45) transparent;
}

.mc-scroll::-webkit-scrollbar {
  width: 8px;
}

.mc-scroll::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: linear-gradient(180deg, rgba(96, 165, 250, 0.5), rgba(251, 146, 60, 0.5));
}

.mc-inner {
  max-width: 760px;
  margin: 0 auto;
  padding: 22px 16px 32px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  /* 内容不足时撑满可视高度，让空态欢迎卡能在中间（不影响有消息时的排布）。 */
  min-height: 100%;
}

.mc-row {
  display: flex;
  animation: mc-rise 0.22s ease-out;
}

@keyframes mc-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.mc-row.user {
  justify-content: flex-end;
}

.mc-row.assistant {
  justify-content: flex-start;
}

.mc-bubble {
  max-width: 88%;
  padding: 11px 15px;
  border-radius: 18px;
  line-height: 1.65;
  word-break: break-word;
}

/* 用户气泡：浅蓝渐变（右下收角，指向发送方）。 */
.mc-row.user .mc-bubble {
  background: linear-gradient(135deg, #dbeafe 0%, #bcd7ff 58%, #a8ccff 100%);
  color: #123a66;
  border-bottom-right-radius: 6px;
  box-shadow: 0 8px 20px rgba(59, 130, 246, 0.16);
}

/* 助手气泡：白 → 浅橘渐变（左下收角）。 */
.mc-row.assistant .mc-bubble {
  background: linear-gradient(135deg, #ffffff 0%, #fff8f1 50%, #ffefe0 100%);
  border: 1px solid rgba(251, 146, 60, 0.18);
  border-bottom-left-radius: 6px;
  box-shadow: 0 8px 22px rgba(249, 115, 22, 0.09);
}

html[data-theme="dark"] .mc-row.user .mc-bubble {
  background: linear-gradient(135deg, #16365a 0%, #1d4a78 100%);
  color: #e8f1ff;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.34);
}

html[data-theme="dark"] .mc-row.assistant .mc-bubble {
  background: linear-gradient(135deg, #191a1c 0%, #231a12 100%);
  border-color: rgba(251, 146, 60, 0.22);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.3);
}

/* 空态欢迎卡：与主色同源的浅蓝 → 浅橘渐变。 */
.mc-welcome {
  /* 在 flex 列容器里上下居中（配合 .mc-inner 的 min-height: 100%）。 */
  margin: auto;
  max-width: 440px;
  text-align: center;
  padding: 28px 24px;
  border-radius: 22px;
  background: linear-gradient(140deg, rgba(219, 234, 254, 0.92), rgba(255, 240, 226, 0.94));
  border: 1px solid rgba(255, 255, 255, 0.7);
  box-shadow: 0 18px 40px rgba(59, 130, 246, 0.13);
}

html[data-theme="dark"] .mc-welcome {
  background: linear-gradient(140deg, rgba(20, 42, 68, 0.9), rgba(46, 30, 16, 0.92));
  border-color: rgba(147, 197, 253, 0.16);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.34);
}

.mc-welcome__title {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.3px;
  background: linear-gradient(92deg, #2f6fed 0%, #7cb3f7 46%, #ef8a3c 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

html[data-theme="dark"] .mc-welcome__title {
  background: linear-gradient(92deg, #93c5fd 0%, #bfdbfe 44%, #fdba74 100%);
  -webkit-background-clip: text;
  background-clip: text;
}

.mc-welcome__hint {
  margin: 10px 0 0;
  font-size: 13.5px;
  line-height: 1.65;
  color: #55637a;
}

html[data-theme="dark"] .mc-welcome__hint {
  color: #a9b6c8;
}

.mc-plain {
  white-space: pre-wrap;
}

.mc-typing {
  display: inline-flex;
  gap: 4px;
  padding: 4px 2px;
}

.mc-typing span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: linear-gradient(135deg, #7cb3f7, #f5a462);
  animation: mc-blink 1.2s infinite ease-in-out;
}

.mc-typing span:nth-child(2) {
  animation-delay: 0.2s;
}

.mc-typing span:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes mc-blink {
  0%, 80%, 100% { opacity: 0.3; }
  40% { opacity: 1; }
}

.mc-error {
  margin-top: 6px;
  color: #c0392b;
  font-size: 13px;
}

html[data-theme="dark"] .mc-error {
  color: #fca5a5;
}

.mc-generating {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--muted);
}

.mc-generating__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: linear-gradient(135deg, #7cb3f7, #f5a462);
  animation: mc-blink 1.2s infinite ease-in-out;
}

.mc-imgs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.mc-img {
  font-size: 12px;
  color: #3d6ea8;
  background: rgba(219, 234, 254, 0.9);
  border: 1px solid rgba(96, 165, 250, 0.28);
  border-radius: 999px;
  padding: 2px 9px;
}

html[data-theme="dark"] .mc-img {
  color: #bcd7ff;
  background: rgba(30, 58, 92, 0.7);
  border-color: rgba(96, 165, 250, 0.3);
}

/* markdown 渲染（表格/代码/列表等） */
.mc-md :deep(> *:first-child) { margin-top: 0; }
.mc-md :deep(> *:last-child) { margin-bottom: 0; }
.mc-md :deep(p) { margin: 8px 0; }
.mc-md :deep(h1),
.mc-md :deep(h2),
.mc-md :deep(h3) { margin: 12px 0 6px; line-height: 1.3; }
.mc-md :deep(ul),
.mc-md :deep(ol) { margin: 8px 0; padding-left: 22px; }
.mc-md :deep(li) { margin: 3px 0; }
.mc-md :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: rgba(255, 237, 213, 0.85);
  color: #9a4a12;
  padding: 1px 6px;
  border-radius: 6px;
}
.mc-md :deep(pre) {
  background: linear-gradient(135deg, rgba(255, 247, 237, 0.95), rgba(239, 246, 255, 0.95));
  border: 1px solid rgba(251, 146, 60, 0.16);
  padding: 12px;
  border-radius: 12px;
  overflow-x: auto;
  margin: 8px 0;
}
html[data-theme="dark"] .mc-md :deep(code) {
  background: rgba(120, 63, 20, 0.35);
  color: #f7c99b;
}
html[data-theme="dark"] .mc-md :deep(pre) {
  background: linear-gradient(135deg, rgba(35, 26, 18, 0.9), rgba(18, 30, 44, 0.9));
  border-color: rgba(251, 146, 60, 0.2);
}
.mc-md :deep(pre code) { background: none; padding: 0; }
.mc-md :deep(table) {
  border-collapse: collapse;
  width: 100%;
  min-width: max-content;
  margin: 8px 0;
  font-size: 13px;
}

/* 宽表横向滚动，避免撑破气泡（渲染器会把 <table> 包进 .table-wrapper）。 */
.mc-md :deep(.table-wrapper) {
  overflow-x: auto;
  margin: 8px 0;
}

/* 渲染器会把「[本轮已执行的工具]」折叠成 details.agent-tool-trace。
   消费者场景不需要内部工具轨迹，直接不展示（样式在 ChatPage 里，独立页不含）。 */
.mc-md :deep(details.agent-tool-trace) {
  display: none;
}

/* 超长数据表的折叠块保留，但弱化成低调样式。 */
.mc-md :deep(details.agent-long-table) {
  border: 1px solid rgba(96, 165, 250, 0.22);
  border-radius: 12px;
  background: rgba(239, 246, 255, 0.7);
  padding: 2px 10px;
  margin: 8px 0;
}
html[data-theme="dark"] .mc-md :deep(details.agent-long-table) {
  border-color: rgba(147, 197, 253, 0.2);
  background: rgba(20, 32, 48, 0.6);
}

.mc-md :deep(details.agent-long-table > summary) {
  cursor: pointer;
  color: var(--muted);
  font-size: 12.5px;
  user-select: none;
  padding: 4px 0;
}
.mc-md :deep(th),
.mc-md :deep(td) {
  border: 1px solid var(--line);
  padding: 6px 10px;
  text-align: left;
}
.mc-md :deep(th) {
  background: linear-gradient(135deg, rgba(219, 234, 254, 0.92), rgba(255, 237, 213, 0.78));
  font-weight: 600;
}
html[data-theme="dark"] .mc-md :deep(th) {
  background: linear-gradient(135deg, rgba(24, 48, 76, 0.86), rgba(48, 31, 16, 0.78));
}
.mc-md :deep(a) {
  color: #2f6fed;
  text-decoration-color: rgba(47, 111, 237, 0.35);
  text-underline-offset: 2px;
}
html[data-theme="dark"] .mc-md :deep(a) {
  color: #93c5fd;
  text-decoration-color: rgba(147, 197, 253, 0.35);
}

.mc-composer {
  flex: 0 0 auto;
  padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
  border-top: 1px solid rgba(59, 130, 246, 0.14);
  /* 与顶栏对称的玻璃底：浅蓝 → 浅橘，与页面渐变呼应。 */
  background: linear-gradient(240deg, rgba(219, 234, 254, 0.9), rgba(255, 237, 213, 0.76));
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

html[data-theme="dark"] .mc-composer {
  border-top-color: rgba(147, 197, 253, 0.16);
  background: linear-gradient(240deg, rgba(17, 34, 54, 0.88), rgba(48, 31, 16, 0.74));
}

.mc-composer-inner {
  max-width: 760px;
  margin: 0 auto;
  display: flex;
  align-items: flex-end;
  gap: 10px;
}

.mc-notice {
  max-width: 760px;
  margin: 0 auto 8px;
  font-size: 12.5px;
  color: #b45309;
}

html[data-theme="dark"] .mc-notice {
  color: #fbbf24;
}

.mc-input {
  flex: 1;
  /* flex 子项默认 min-width:auto：窄屏下长文本会把输入框顶宽、把按钮挤出可视区。 */
  min-width: 0;
  resize: none;
  border: 1px solid rgba(96, 165, 250, 0.32);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.92);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 15px;
  /* 行高/内边距写成定值，是为了让单行高度精确等于右侧按钮的 47px：
     autoGrow 用 scrollHeight 定高（行高 23 + 内边距 11×2 = 45，再加 2px 边框 = 47），
     换字体或语言都不会再出现输入框比按钮高半行的错位。 */
  line-height: 23px;
  padding: 11px 14px;
  max-height: 160px;
  outline: none;
  box-shadow: 0 6px 18px rgba(59, 130, 246, 0.08);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

html[data-theme="dark"] .mc-input {
  background: rgba(20, 26, 34, 0.92);
  border-color: rgba(147, 197, 253, 0.24);
}

.mc-input:focus-visible {
  border-color: rgba(59, 130, 246, 0.7);
  box-shadow:
    0 0 0 3px rgba(96, 165, 250, 0.22),
    0 8px 20px rgba(59, 130, 246, 0.12);
}

/* 发送 / 停止：同一几何（47px 圆钮，与输入框单行高度等高），只换图标与配色 —— 状态切换不跳动；
   多语言文字进 title/aria，不会像文字按钮那样被「Parar / रोकें」撑宽挤破输入区。 */
.mc-send {
  flex: 0 0 auto;
  width: 47px;
  height: 47px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  /* 主按钮：蓝 → 橘渐变，与页面主色一致。 */
  background: linear-gradient(135deg, #5aa2f8 0%, #8ec0fb 42%, #f5a03c 100%);
  color: #fff;
  cursor: pointer;
  box-shadow: 0 8px 18px rgba(245, 158, 11, 0.26);
  transition:
    transform 0.12s ease,
    box-shadow 0.15s ease,
    opacity 0.15s ease,
    filter 0.15s ease;
}

/* 图标按钮：SVG 按块级布局，避免行内基线在圆钮里偏 1px。 */
.mc-send svg {
  display: block;
}

/* hover 抬 2px、active 反向压 1px：三态位移分明（原来 hover 1px / active 0 几乎看不出反应）。 */
.mc-send:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 12px 26px rgba(245, 158, 11, 0.34);
  filter: saturate(1.05);
}

.mc-send:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: 0 4px 10px rgba(245, 158, 11, 0.24);
}

.mc-send:focus-visible {
  box-shadow: var(--ring), 0 8px 18px rgba(245, 158, 11, 0.26);
}

.mc-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  box-shadow: none;
}

/* 停止：同尺寸换暖色系（杏橘）+ 圆角方形，与「发送」一眼区分；
   border 走 border-box（全局 box-sizing），所以尺寸仍是 47px，不与发送钮错位。 */
.mc-send--stop {
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(255, 237, 213, 0.96), rgba(254, 205, 158, 0.96));
  color: #94490f;
  border: 1px solid rgba(251, 146, 60, 0.35);
  box-shadow: none;
}

.mc-send--stop:hover:not(:disabled) {
  box-shadow: 0 10px 20px rgba(251, 146, 60, 0.3);
}

html[data-theme="dark"] .mc-send--stop {
  background: rgba(84, 47, 18, 0.85);
  color: #f7c99b;
  border-color: rgba(251, 146, 60, 0.3);
}
</style>
