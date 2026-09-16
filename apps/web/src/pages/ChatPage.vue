<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import ThemeToggle from "../components/ThemeToggle.vue";
import UiLocaleSelect from "../components/UiLocaleSelect.vue";
import { renderChatMarkdown } from "../chat-richtext";
import { getUiLocale } from "../ui-locale";
import { localizeToken } from "../localize";
import {
  clearConversation,
  createConversation,
  deleteConversation as apiDeleteConversation,
  fetchConversations,
  fetchModels,
  getApiErrorToken,
  saveConversationMessages,
  streamChat,
  uploadFiles,
  type ConversationDto,
  type ModelInfo,
  type StoredMessage,
  type UploadResult,
} from "../api";

interface Bubble {
  id: number;
  role: "user" | "assistant";
  text: string;
  images?: Array<{ id: string; name: string }>;
  streaming?: boolean;
  error?: string;
}

const LAST_CONV_KEY = "bx-chat-last-conversation";

const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

const threadEl = ref<HTMLElement | null>(null);
const bubbles = ref<Bubble[]>([]);
const input = ref("");
const sending = ref(false);
const models = ref<ModelInfo[]>([]);
const modelId = ref("");
const activeModelLabel = ref("");
const conversations = ref<ConversationDto[]>([]);
const currentId = ref("");
const pendingImages = ref<UploadResult[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);

let seq = 0;
let controller: AbortController | null = null;
let scrollQueued = false;

const canSend = computed(() => Boolean(input.value.trim() || pendingImages.value.length) && !sending.value);

// 模型按来源分组（服务端按端点推导 source，缺失时回退 provider）。
const groupedModels = computed(() => {
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models.value) {
    const key = model.source || model.provider || "other";
    const list = groups.get(key);
    if (list) list.push(model);
    else groups.set(key, [model]);
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }));
});

function queueScroll() {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    void nextTick(() => {
      const el = threadEl.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  });
}

function toStored(): StoredMessage[] {
  return bubbles.value
    .filter((b) => b.text || b.images?.length)
    .map((b) => ({ role: b.role, text: b.text, images: b.images }));
}

async function persist() {
  if (!currentId.value) return;
  const title = bubbles.value.find((b) => b.role === "user" && b.text)?.text.slice(0, 24) || undefined;
  try {
    await saveConversationMessages(currentId.value, toStored(), title);
  } catch {
    /* 保存失败不打断对话 */
  }
}

function selectConversation(conv: ConversationDto) {
  currentId.value = conv.id;
  try {
    localStorage.setItem(LAST_CONV_KEY, conv.id);
  } catch {
    /* ignore */
  }
  bubbles.value = (conv.messages || []).map((m) => ({
    id: ++seq,
    role: m.role,
    text: m.text || "",
    images: m.images,
  }));
  queueScroll();
}

async function newConversation() {
  const conv = await createConversation({ title: tx("新对话", "New chat") });
  conversations.value = [conv, ...conversations.value.filter((c) => c.id !== conv.id)];
  bubbles.value = [];
  selectConversation(conv);
}

async function removeConversation(id: string) {
  conversations.value = conversations.value.filter((c) => c.id !== id);
  try {
    await apiDeleteConversation(id);
  } catch {
    /* ignore */
  }
  if (currentId.value === id) {
    const next = conversations.value[0];
    if (next) selectConversation(next);
    else await newConversation();
  }
}

async function clearCurrent() {
  bubbles.value = [];
  if (currentId.value) await clearConversation(currentId.value).catch(() => undefined);
}

async function pickFiles(event: Event) {
  const el = event.target as HTMLInputElement;
  const files = Array.from(el.files || []);
  el.value = "";
  if (!files.length) return;
  try {
    const saved = await uploadFiles(files);
    pendingImages.value.push(...saved.filter((f) => f.kind === "image"));
  } catch (err) {
    bubbles.value.push({
      id: ++seq,
      role: "assistant",
      text: localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("上传失败", "Upload failed")),
    });
  }
}

async function send() {
  const text = input.value.trim();
  if (!text && !pendingImages.value.length) return;
  if (sending.value) return;

  const images = pendingImages.value.slice();
  bubbles.value.push({
    id: ++seq,
    role: "user",
    text,
    images: images.map((i) => ({ id: i.id, name: i.name })),
  });
  const reply: Bubble = { id: ++seq, role: "assistant", text: "", streaming: true };
  bubbles.value.push(reply);
  input.value = "";
  pendingImages.value = [];
  sending.value = true;
  controller = new AbortController();
  queueScroll();

  try {
    await streamChat(
      text,
      { model: modelId.value || undefined, images: images.map((i) => i.id) },
      (event) => {
        if (event.type === "text_delta") {
          reply.text += event.text;
          queueScroll();
        } else if (event.type === "text") {
          reply.text = event.text;
        } else if (event.type === "model") {
          activeModelLabel.value = event.label;
        } else if (event.type === "error") {
          reply.error = localizeToken(uiLocale.value, event.error, event.message || "GENERIC_UNKNOWN_ERROR");
        } else if (event.type === "done") {
          reply.streaming = false;
        }
      },
      controller.signal,
    );
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      reply.text = reply.text ? `${reply.text}\n\n${tx("（已停止生成）", " (stopped)")}` : tx("（已停止生成）", "(stopped)");
    } else {
      reply.error = localizeToken(
        uiLocale.value,
        getApiErrorToken(err),
        (err as Error)?.message || "GENERIC_UNKNOWN_ERROR",
      );
    }
    reply.streaming = false;
  } finally {
    sending.value = false;
    controller = null;
    await persist();
    queueScroll();
  }
}

function stop() {
  controller?.abort();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
}

onMounted(async () => {
  models.value = await fetchModels().catch(() => []);
  if (models.value.length) modelId.value = models.value[0]!.id;
  const list = await fetchConversations().catch(() => [] as ConversationDto[]);
  conversations.value = list;
  let last = "";
  try {
    last = localStorage.getItem(LAST_CONV_KEY) || "";
  } catch {
    /* ignore */
  }
  const target = list.find((c) => c.id === last) || list[0];
  if (target) selectConversation(target);
  else await newConversation();
});
</script>

<template>
  <div class="chat">
    <aside class="sidebar">
      <button class="new-chat" type="button" @click="newConversation">
        + {{ tx("新对话", "New chat") }}
      </button>
      <div class="conv-list">
        <div
          v-for="conv in conversations"
          :key="conv.id"
          class="conv-item"
          :class="{ active: conv.id === currentId }"
          @click="selectConversation(conv)"
        >
          <span class="conv-title">{{ conv.title || tx("新对话", "New chat") }}</span>
          <button
            class="conv-del"
            type="button"
            :title="tx('删除对话', 'Delete chat')"
            @click.stop="removeConversation(conv.id)"
          >
            ×
          </button>
        </div>
      </div>
      <button class="ghost-btn" type="button" @click="clearCurrent">
        {{ tx("清空当前对话", "Clear current chat") }}
      </button>
    </aside>

    <main class="main">
      <header class="top">
        <div class="brand">{{ tx("对话", "Chat") }}</div>
        <div class="top-actions">
          <span v-if="activeModelLabel" class="model-tag">{{ activeModelLabel }}</span>
          <select v-model="modelId" class="select" :aria-label="tx('模型', 'Model')">
            <optgroup v-for="group in groupedModels" :key="group.label" :label="group.label">
              <option v-for="m in group.items" :key="m.id" :value="m.id">{{ m.label }}</option>
            </optgroup>
          </select>
          <UiLocaleSelect />
          <ThemeToggle />
        </div>
      </header>

      <div ref="threadEl" class="thread">
        <div v-if="!bubbles.length" class="empty">
          {{ tx("随便问点什么吧。", "Ask anything to get started.") }}
        </div>
        <div v-for="b in bubbles" :key="b.id" class="row" :class="b.role">
          <div class="bubble">
            <div v-if="b.images?.length" class="thumbs">
              <img v-for="img in b.images" :key="img.id" :src="`/agent/chat/upload/${img.id}`" :alt="img.name" />
            </div>
            <div v-if="b.role === 'user'" class="plain">{{ b.text }}</div>
            <div v-else-if="b.text" class="md" v-html="renderChatMarkdown(b.text)"></div>
            <div v-else-if="!b.error && b.streaming" class="typing">
              <span></span><span></span><span></span>
            </div>
            <div v-if="b.error" class="err">{{ b.error }}</div>
          </div>
        </div>
      </div>

      <footer class="composer">
        <div v-if="pendingImages.length" class="pending">
          <span v-for="img in pendingImages" :key="img.id" class="chip">
            {{ img.name }}
            <button type="button" @click="pendingImages = pendingImages.filter((i) => i.id !== img.id)">×</button>
          </span>
        </div>
        <div class="composer-row">
          <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="pickFiles" />
          <button class="icon-btn" type="button" :title="tx('上传图片', 'Upload image')" @click="fileInput?.click()">
            🖼
          </button>
          <textarea
            v-model="input"
            class="input"
            rows="1"
            :placeholder="tx('输入消息，Enter 发送，Shift+Enter 换行', 'Type a message. Enter to send, Shift+Enter for a new line')"
            @keydown="onKeydown"
          ></textarea>
          <button v-if="sending" class="send stop" type="button" @click="stop">
            {{ tx("停止", "Stop") }}
          </button>
          <button v-else class="send" type="button" :disabled="!canSend" @click="send">
            {{ tx("发送", "Send") }}
          </button>
        </div>
      </footer>
    </main>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  height: 100dvh;
  width: 100%;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font-body);
}

.sidebar {
  width: 248px;
  flex: 0 0 248px;
  border-right: 1px solid var(--line);
  background: var(--panel);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.new-chat {
  border: 1px solid var(--line-strong);
  background: var(--ink);
  color: var(--bg);
  border-radius: var(--radius);
  padding: 10px 12px;
  cursor: pointer;
  font-size: 14px;
}

.conv-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.conv-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
}

.conv-item:hover {
  background: var(--fill-soft);
}

.conv-item.active {
  background: var(--fill-soft);
  border: 1px solid var(--line);
}

.conv-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-del {
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}

.ghost-btn {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  border-radius: var(--radius);
  padding: 8px 10px;
  cursor: pointer;
  font-size: 13px;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--line);
}

.brand {
  font-family: var(--font-display);
  font-size: 17px;
}

.top-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.model-tag {
  font-size: 12px;
  color: var(--muted);
}

.select {
  border: 1px solid var(--line);
  background: var(--fill);
  color: var(--ink);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  font-size: 13px;
}

.thread {
  flex: 1;
  overflow-y: auto;
  padding: 22px 18px 8px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
}

.empty {
  margin: auto;
  color: var(--muted);
  font-size: 14px;
}

.row {
  display: flex;
}

.row.user {
  justify-content: flex-end;
}

.bubble {
  max-width: min(760px, 92%);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 12px 14px;
  background: var(--panel);
  box-shadow: var(--shadow);
  font-size: 14px;
  line-height: 1.65;
}

.row.user .bubble {
  background: var(--fill-soft);
}

.plain {
  white-space: pre-wrap;
  word-break: break-word;
}

.md :deep(p),
.md :deep(ul),
.md :deep(ol),
.md :deep(pre) {
  margin: 0 0 8px;
}

.md :deep(pre) {
  background: var(--fill-soft);
  padding: 10px;
  border-radius: var(--radius-sm);
  overflow-x: auto;
}

.md :deep(code) {
  font-family: var(--font-mono);
  font-size: 13px;
}

.md :deep(table) {
  border-collapse: collapse;
  width: 100%;
}

.md :deep(th),
.md :deep(td) {
  border: 1px solid var(--line);
  padding: 6px 8px;
  text-align: left;
}

.thumbs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.thumbs img {
  max-width: 160px;
  max-height: 160px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
}

.err {
  color: var(--danger);
  font-size: 13px;
  white-space: pre-wrap;
}

.typing {
  display: flex;
  gap: 4px;
}

.typing span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted);
  animation: blink 1.2s infinite ease-in-out;
}

.typing span:nth-child(2) {
  animation-delay: 0.15s;
}

.typing span:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes blink {
  0%, 80%, 100% { opacity: 0.25; }
  40% { opacity: 1; }
}

.composer {
  border-top: 1px solid var(--line);
  padding: 12px 18px calc(12px + var(--safe-bottom));
  background: var(--panel);
}

.pending {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  padding: 3px 8px;
  color: var(--muted);
}

.chip button {
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.composer-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.icon-btn {
  border: 1px solid var(--line);
  background: var(--fill);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  cursor: pointer;
}

.input {
  flex: 1;
  resize: none;
  min-height: 44px;
  max-height: 200px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 10px 12px;
  background: var(--fill);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.5;
}

.input:focus {
  outline: 2px solid color-mix(in srgb, var(--ink) 25%, transparent);
}

.send {
  border: 1px solid var(--line-strong);
  background: var(--ink);
  color: var(--bg);
  border-radius: var(--radius);
  padding: 11px 18px;
  font-size: 14px;
  cursor: pointer;
}

.send:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.send.stop {
  background: var(--stop);
  border-color: var(--stop);
}

@media (max-width: 860px) {
  .sidebar {
    display: none;
  }
}
</style>
