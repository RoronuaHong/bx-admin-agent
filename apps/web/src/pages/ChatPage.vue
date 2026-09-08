<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { useRouter } from "vue-router";
import { clearChatContext, downloadUrl, fetchMe, fetchModels, fetchTaskStatus, getApiErrorToken, logout, streamChat, uploadFiles, fetchConversations, createConversation, saveConversationMessages, deleteConversation as apiDeleteConversation, clearConversation as apiClearConversation, type ChatEvent, type Me, type ModelInfo, type UploadResult } from "../api";
import { createBackgroundTaskSync } from "../chat-background-sync";
import { resizeComposerBox, startComposerResizeDrag } from "../chat-composer";
import { renderChatMarkdown } from "../chat-richtext";
import { applyChatStreamEvent, toolStatusTextForLocale } from "../chat-stream-events";
import {
  TASK_RESULTS_ID,
  clearIdentityCache,
  dedupeConversationList,
  displayAssistantTextForLocale,
  displayConversationTitleForLocale,
  isDefaultConversationTitle,
  isLegacyTaskConversation,
  loadClosedIds,
  loadConversationsFromStorage,
  makeConversationTitle,
  migrateLegacyConversation,
  newConversationId,
  persistClosedIds as persistClosedIdsToStorage,
  readIdentityCache,
  readModelCache,
  sanitizeBubble,
  slimConversations,
  writeIdentityCache,
  writeModelCache,
  type Bubble,
  type Conversation,
  type Identity,
} from "../chat-storage";
import { createTabMenuPosition, type TabMenuState } from "../chat-tab-menu";
import { bindCustomScrollbar } from "../custom-scrollbar";
import { copyText } from "../clipboard";
import { localizeToken } from "../localize";
import ThemeToggle from "../components/ThemeToggle.vue";
import ResultTable from "../components/ResultTable.vue";
import ToolResultCard from "../components/ToolResultCard.vue";
import CapabilitiesHelp from "../components/CapabilitiesHelp.vue";
import UiLocaleSelect from "../components/UiLocaleSelect.vue";
import { getUiLocale } from "../ui-locale";

const ResultChart = defineAsyncComponent(() => import("../components/ResultChart.vue"));

const router = useRouter();
const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;
const renderMarkdown = renderChatMarkdown;
const me = shallowRef<Me | null>(null);
const input = ref("");
const sending = ref(false);
const scroller = ref<HTMLElement | null>(null);
const composerInput = ref<HTMLTextAreaElement | null>(null);
const scrollTop = ref(0);
// 聊天区自定义滚动条（div 模拟）
const threadTrackEl = ref<HTMLElement | null>(null);
const threadThumbEl = ref<HTMLElement | null>(null);
let threadScrollbarCleanup: (() => void) | null = null;
let seq = 0;

// ---- 多会话（多 Tab）数据层 ----
// 每个会话独立对话，在 localStorage 持久化历史，刷新后恢复。
const LEGACY_KEY = "bx-admin-agent-chat";
const STORAGE_KEY = "bx-admin-agent-chat-v2";
/** 已关闭会话 id（跨刷新），避免 DELETE 与 upsert 竞态后刷新又把 tab 拉回来。 */
const CLOSED_KEY = "bx-admin-agent-closed-v1";
// 身份缓存：持久化最近一次成功的登录身份，用于刷新时、fetchMe 未返回/失败时
// 也能拼出正确的 storageKey 来恢复本地会话，避免落到 ":x:anon" 导致记录"消失"。
const IDENTITY_CACHE_KEY = "bx-admin-agent-identity-v1";
const MODEL_CACHE_KEY = "bx-admin-agent-model-v1";

// 当前生效的登录身份：优先实时登录态，回退到身份缓存，避免回落到匿名校验不到数据。
function currentIdentity(): Identity {
  if (me.value?.user?.loginName && me.value?.country?.id) {
    return { countryId: me.value.country.id, loginName: me.value.user.loginName };
  }
  const cached = readIdentityCache(IDENTITY_CACHE_KEY);
  if (cached) return cached;
  return { countryId: "x", loginName: "anon" };
}

function storageKey() {
  const id = currentIdentity();
  return `${STORAGE_KEY}:${id.countryId}:${id.loginName}`;
}
function legacyStorageKey() {
  const id = currentIdentity();
  return `${LEGACY_KEY}:${id.countryId}:${id.loginName}`;
}
function closedStorageKey() {
  const id = currentIdentity();
  return `${CLOSED_KEY}:${id.countryId}:${id.loginName}`;
}

const conversations = ref<Conversation[]>([]);
const activeId = ref<string>("");
const activeMessages = computed(() => conversations.value.find((c) => c.id === activeId.value)?.messages ?? []);

// 工具步骤分组折叠状态（按消息 id 隔离，避免多会话/多消息索引冲突）：
// - groupOpenByMsg：外层「工具调用细节（N）」折叠区是否展开（2026-08-26 起默认展开，让用户直接看到工具链）
// - cardOpenByMsg：每组内各卡片是否展开（供「全部展开/全部折叠」批量控制）
const groupOpenByMsg = ref<Record<string, boolean>>({});
const cardOpenByMsg = ref<Record<string, boolean[]>>({});

function groupOpenOf(id: string | number): boolean {
  return groupOpenByMsg.value[String(id)] ?? true;
}
function setGroupOpen(id: string | number, v: boolean) {
  groupOpenByMsg.value[String(id)] = v;
}
function cardsOf(id: string | number, n: number): boolean[] {
  const k = String(id);
  let arr = cardOpenByMsg.value[k];
  if (!arr) {
    arr = [];
    cardOpenByMsg.value[k] = arr;
  }
  while (arr.length < n) arr.push(false);
  return arr;
}
function setAllCards(cards: boolean[], v: boolean) {
  cards.fill(v);
}

// 给每条消息挂上对应卡片展开数组（id 不变的复用旧数组，保持单卡展开状态）
const messagesWithCards = computed(() =>
  activeMessages.value.map((item) => ({ item, cards: cardsOf(item.id, item.toolResults?.length ?? 0) })),
);

function newId() {
  return newConversationId();
}

function defaultConversationTitle() {
  return tx("新对话", "New Chat", "Novo Chat", "नई चैट");
}

function displayConversationTitleOf(conv: { title?: string | null }) {
  return displayConversationTitleForLocale(conv.title, defaultConversationTitle(), uiLocale.value);
}

function displayAssistantText(item: Bubble) {
  return item.role === "assistant"
    ? displayAssistantTextForLocale(item.text, uiLocale.value)
    : item.text;
}

// 本地离线兜底（服务端不可达时仍保留一份），非主存储。
function cacheLocally() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify({ activeId: activeId.value, conversations: slimConversations(conversations.value) }));
  } catch {
    /* 忽略配额/隐私模式错误 */
  }
}

// 已关闭会话墓碑（内存 + localStorage）：阻止在途 upsert 复活，并在刷新后继续过滤/补删。
const deletedConversationIds = new Set<string>();
/** 批量关闭期间禁止 deep-watch 触发的自动保存。 */
let suppressConversationSave = false;

function hydrateClosedIds() {
  deletedConversationIds.clear();
  for (const id of loadClosedIds(closedStorageKey())) deletedConversationIds.add(id);
}

function markConversationsClosed(ids: string[]) {
  for (const id of ids) deletedConversationIds.add(id);
  persistClosedIdsToStorage(closedStorageKey(), deletedConversationIds);
}

function shouldHideConversation(id: string) {
  return deletedConversationIds.has(id) || isLegacyTaskConversation(id);
}

function persistConversation(id: string, messages: Conversation["messages"], title?: string) {
  if (shouldHideConversation(id)) return;
  saveConversationMessages(id, messages, title)
    .then(() => {
      // 关闭前已发出的 upsert 可能晚于 DELETE 到达并 upsert 复活 → 再删一次。
      if (deletedConversationIds.has(id)) {
        apiDeleteConversation(id).catch(() => {});
      }
    })
    .catch(() => {
      /* 网络/服务端失败：本地缓存兜底，下次变更会重试 */
    });
}

// 主存储：服务端 MongoDB（方案 C，按登录用户归属）。每会话独立 upsert。
function saveConversations() {
  if (suppressConversationSave) {
    cacheLocally();
    return;
  }
  const slim = slimConversations(conversations.value).filter((c) => !shouldHideConversation(c.id));
  cacheLocally();
  for (const c of slim) {
    persistConversation(c.id, c.messages, c.title);
  }
}

// 新建一个空会话并设为当前。
function newConversation() {
  const now = Date.now();
  const conv: Conversation = { id: newId(), title: defaultConversationTitle(), messages: [], createdAt: now, updatedAt: now };
  conversations.value.push(conv);
  activeId.value = conv.id;
  saveConversations();
  // 服务端建壳（失败静默，后续 upsert 消息时会自动补建）。
  createConversation({ id: conv.id, title: conv.title }).catch(() => {});
  nextTick(() => {
    resizeComposer();
    scrollBottom();
  });
}

/** 标签右键菜单：对齐浏览器/IDE 关标签行为。 */
const tabMenu = ref<TabMenuState | null>(null);

function hideTabMenu() {
  tabMenu.value = null;
}

function openTabMenu(ev: MouseEvent, convId: string, idx: number) {
  // 不切会话，仅弹出菜单；坐标稍后钳制到视口内。
  tabMenu.value = { convId, idx, ...createTabMenuPosition(ev) };
}

function ensureBlankConversation() {
  const now = Date.now();
  const conv: Conversation = { id: newId(), title: defaultConversationTitle(), messages: [], createdAt: now, updatedAt: now };
  conversations.value.push(conv);
  activeId.value = conv.id;
  createConversation({ id: conv.id, title: conv.title }).catch(() => {});
}

/** 批量关闭；keepId 为要保留并激活的会话（关闭其他时用）。 */
function closeConversations(ids: string[], keepId?: string) {
  if (!ids.length) {
    hideTabMenu();
    return;
  }
  const idSet = new Set(ids);
  // 先打墓碑并取消防抖保存，避免 deep watch / 在途 upsert 把刚删的会话写回 Mongo。
  markConversationsClosed(ids);
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  suppressConversationSave = true;
  const prevActive = activeId.value;
  const prevIdx = conversations.value.findIndex((c) => c.id === prevActive);
  conversations.value = conversations.value.filter((c) => !idSet.has(c.id));

  if (keepId && conversations.value.some((c) => c.id === keepId)) {
    activeId.value = keepId;
  } else if (!conversations.value.length) {
    ensureBlankConversation();
  } else if (idSet.has(prevActive)) {
    const next = conversations.value[Math.min(Math.max(prevIdx, 0), conversations.value.length - 1)];
    activeId.value = next.id;
  }

  // 本地先落盘（用户立刻看到关闭），服务端删除并行发出；失败也不撤墓碑，避免刷新又拉回。
  cacheLocally();
  void Promise.all(ids.map((id) => apiDeleteConversation(id).catch(() => {}))).finally(() => {
    suppressConversationSave = false;
    // 仅对仍打开的会话做 upsert，绝不写墓碑里的 id。
    saveConversations();
  });
  hideTabMenu();
  nextTick(scrollBottom);
}

// 关闭某个会话；当前会话被关则切到相邻会话；全部关完则新建一个空会话。
function closeConversation(id: string) {
  closeConversations([id]);
}

function closeOtherConversations(id: string) {
  closeConversations(
    conversations.value.filter((c) => c.id !== id).map((c) => c.id),
    id,
  );
}

function closeLeftConversations(id: string) {
  const idx = conversations.value.findIndex((c) => c.id === id);
  if (idx <= 0) {
    hideTabMenu();
    return;
  }
  closeConversations(
    conversations.value.slice(0, idx).map((c) => c.id),
    id,
  );
}

function closeRightConversations(id: string) {
  const idx = conversations.value.findIndex((c) => c.id === id);
  if (idx < 0 || idx >= conversations.value.length - 1) {
    hideTabMenu();
    return;
  }
  closeConversations(
    conversations.value.slice(idx + 1).map((c) => c.id),
    id,
  );
}

function closeAllConversations() {
  closeConversations(conversations.value.map((c) => c.id));
}

// 切换当前会话。
function switchConversation(id: string) {
  hideTabMenu();
  if (activeId.value !== id && conversations.value.some((c) => c.id === id)) {
    activeId.value = id;
    saveConversations();
    nextTick(scrollBottom);
  }
}

// 只在登录态就绪后才持久化，避免 fetchMe 返回前用错误的 storageKey 写入数据。
let saveTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  conversations,
  () => {
    if (!me.value || suppressConversationSave) return;
    // 防抖：流式/图表更新时 deep watch 会连打 localStorage，易卡主线程
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveConversations();
    }, 400);
  },
  { deep: true },
);

onMounted(async () => {
  // 用户主动取消流式响应（AbortController.abort）时，浏览器会在微任务中对 fetch 底层 body
  // 流触发一次内部 cancel，其 promise 无人 await，产生 "AbortError: signal is aborted without
  // reason" 的未捕获 Promise（异步栈被归属到 abort 调用处）。此处全局、永久地吞掉这类 AbortError，
  // 不影响其它真实异步错误。业务取消态由 send() 的 catch(AbortError) 正常标记。
  window.addEventListener("unhandledrejection", (e) => {
    if ((e.reason as Error | undefined)?.name === "AbortError") e.preventDefault();
  });

  // 第一步：先用身份缓存恢复本地会话，不依赖 fetchMe 是否成功，
  // 避免 fetchMe 瞬时失败/401 时直接丢弃用户已存的聊天记录。
  const cachedIdentity = readIdentityCache(IDENTITY_CACHE_KEY);
  if (cachedIdentity) {
    await restoreConversations();
  }

  // 第二步：拉取登录态，成功后更新身份缓存并（如身份变化）刷新恢复的数据。
  const fetched = await fetchMe();
  me.value = fetched;
  if (fetched) {
    caps.value = detectCapabilities();
    // 先同步恢复上次选中的模型（含缓存 label），避免刷新瞬间先显示 Auto 再跳变的闪动。
    const cached = readModelCache(MODEL_CACHE_KEY);
    if (cached) {
      selectedModel.value = cached.id;
      selectedModelLabel.value = cached.label;
    }
    availableModels.value = await fetchModels();
    // 校验：缓存的 id 已不在当前可用列表里则回退到 Auto（并清掉失效缓存）。
    if (selectedModel.value && !availableModels.value.some((m) => m.id === selectedModel.value)) {
      selectedModel.value = null;
      selectedModelLabel.value = "Auto";
      writeModelCache(MODEL_CACHE_KEY, null, "Auto");
    }
    writeIdentityCache(IDENTITY_CACHE_KEY, { countryId: fetched.country.id, loginName: fetched.user.loginName });
    // 服务端记录按登录用户归属：登录态就绪后始终从服务端拉权威数据（覆盖本地缓存）。
    // 身份切换（缓存身份 ≠ 真实身份）时也必须重新拉取，避免串用户数据。
    if (!cachedIdentity || cachedIdentity.countryId !== fetched.country.id || cachedIdentity.loginName !== fetched.user.loginName) {
      await restoreConversations();
    }
  } else {
    // 未登录 / 登录态失效：不丢弃本地记录（已在上方恢复），仅跳登录页。
    await router.replace("/agents/admin/login");
    return;
  }

  if (!activeId.value) {
    const now = Date.now();
    const conv: Conversation = { id: newId(), title: defaultConversationTitle(), messages: [], createdAt: now, updatedAt: now };
    conversations.value.push(conv);
    activeId.value = conv.id;
  }
  // me.value 已就绪，用正确的 storageKey 做一次全量持久化（覆盖 restoreConversations 期间可能写错 key 的数据）
  saveConversations();
  await syncBackgroundTaskStatus();
  // 初次进入时立即按 130px 下限计算输入框高度，避免默认高度偏离。
  resizeComposer();
  await scrollBottom();
  // 聊天区自定义滚动条：绑定一次，滚动/尺寸/内容变化全自动同步。
  threadScrollbarCleanup = bindCustomScrollbar(
    () => scroller.value,
    () => threadTrackEl.value,
    () => threadThumbEl.value,
  );

  const onEsc = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (tabMenu.value) {
      hideTabMenu();
      return;
    }
    // 能力说明弹窗自管 Esc（capture）；此处只关灯箱
    if (helpOpen.value) return;
    if (modelMenuOpen.value) {
      modelMenuOpen.value = false;
      return;
    }
    lightboxUrl.value = "";
  };
  const onClickAway = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null;
    if (!t || !t.closest(".model-switch")) modelMenuOpen.value = false;
  };
  window.addEventListener("keydown", onEsc);
  window.addEventListener("click", onClickAway);

  onUnmounted(() => {
    stopTaskStatusPolling();
    stopVoice();
    recognitionRef.value = null;
    modelScrollbarCleanup?.();
    modelScrollbarCleanup = null;
    threadScrollbarCleanup?.();
    threadScrollbarCleanup = null;
    window.removeEventListener("keydown", onEsc);
    window.removeEventListener("click", onClickAway);
  });
});

// 恢复多会话（方案 C：服务端 Mongo 为主，本地缓存兜底）。
// 1) 先读本地缓存立即渲染（无网络等待，避免白屏）；
// 2) 再拉服务端（按登录用户归属）覆盖为权威数据；
// 3) 服务端不可达/为空时保留本地缓存；本地也没有则尝试旧 v1 单会话迁移。
// 4) 墓碑 id / 旧版 task-<sessionId> 不展示，并补删服务端残留。
async function restoreConversations() {
  hydrateClosedIds();

  // 本地兜底（旧 localStorage / 离线），先渲染。
  const local = loadConversationsFromStorage(storageKey(), defaultConversationTitle(), () => ++seq);
  const localVisible = local.conversations.filter((c) => !shouldHideConversation(c.id));
  if (localVisible.length) {
    conversations.value = localVisible;
    activeId.value = localVisible.some((c) => c.id === local.activeId)
      ? local.activeId
      : localVisible[0]?.id || "";
  } else {
    const migrated = migrateLegacyConversation(legacyStorageKey(), defaultConversationTitle(), () => ++seq);
    if (migrated) {
      conversations.value = [migrated];
      activeId.value = migrated.id;
      localStorage.removeItem(legacyStorageKey());
    }
  }

  // 服务端权威数据（MongoDB，按当前登录用户归属）。
  try {
    const remote = await fetchConversations();
    if (!remote.length) return;

    const toPurge = remote
      .filter((c) => c?.id && shouldHideConversation(c.id))
      .map((c) => c.id);
    for (const id of toPurge) apiDeleteConversation(id).catch(() => {});

    // 墓碑里已不在远端的 id 可回收，避免 closed 列表无限涨。
    let closedChanged = false;
    for (const id of [...deletedConversationIds]) {
      if (!remote.some((c) => c.id === id)) {
        deletedConversationIds.delete(id);
        closedChanged = true;
      }
    }
    if (closedChanged) persistClosedIdsToStorage(closedStorageKey(), deletedConversationIds);

    const convs: Conversation[] = dedupeConversationList(remote
      .filter((c) => c && c.id && !shouldHideConversation(c.id))
      .slice(0, 20)
      .map((c) => ({
        id: c.id,
        title: displayConversationTitle(c.title, defaultConversationTitle()),
        messages: (c.messages as Bubble[])
          .filter((m) => m && (m.role === "user" || m.role === "assistant"))
          .slice(-80)
          .map((m) => sanitizeBubble({ ...m, id: m.id || ++seq })),
        createdAt: c.createdAt || 0,
        updatedAt: c.updatedAt || 0,
      })));

    if (convs.length) {
      conversations.value = convs;
      activeId.value = convs.some((c) => c.id === local.activeId) ? local.activeId : convs[0]?.id || "";
    } else if (toPurge.length) {
      // 远端只剩应隐藏会话：保持本地可见列表（可能为空，后续 onMounted 会建空白会话）。
      conversations.value = localVisible;
      activeId.value = localVisible[0]?.id || "";
    }
  } catch {
    /* 服务端不可达：保留本地缓存 */
  }
}

async function scrollBottom() {
  await nextTick();
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
}

function scrollToTop() {
  scroller.value?.scrollTo({ top: 0, behavior: "smooth" });
}

function onThreadScroll() {
  scrollTop.value = scroller.value?.scrollTop ?? 0;
}

// 手动拖拽设定的输入框高度（px）；null 表示自动高度。
const composerH = ref<number | null>(null);

function resizeComposer() {
  resizeComposerBox(composerInput, composerH);
}

// 按住输入框顶部的拖拽把手，上拉放大 / 下拉缩小输入框。
function startComposerDrag(e: PointerEvent | MouseEvent | TouchEvent) {
  startComposerResizeDrag({
    event: e,
    composerInput,
    composerHeight: composerH,
    resizeComposer,
  });
}

function toolStatusText(name: string): string {
  return toolStatusTextForLocale(uiLocale.value, name);
}

async function send() {
  const text = input.value.trim();
  if ((!text && !pastingImages.value.length && !pastingFiles.value.length) || sending.value) return;
  const imageIds = pastingImages.value.map((item) => item.id);
  const files = pastingFiles.value.map((item) => item.id);
  const attachCount = imageIds.length + files.length;
  const titleText = text || `[${
    imageIds.length
      ? tx(`图片 ${imageIds.length} 张`, `${imageIds.length} image(s)`, `${imageIds.length} imagem(ns)`, `${imageIds.length} छवि`)
      : tx(`附件 ${attachCount} 个`, `${attachCount} attachment(s)`, `${attachCount} anexo(s)`, `${attachCount} संलग्नक`)
  }]`;
  stopVoice();
  input.value = "";
  const bubbleImages = pastingImages.value.map((item) => ({ id: item.id, name: item.name }));
  for (const item of pastingImages.value) URL.revokeObjectURL(item.previewUrl);
  pastingImages.value = [];
  pastingFiles.value = [];
  composerH.value = null;
  document.documentElement.style.setProperty("--composer-max", "");
  await nextTick();
  resizeComposer();
  const active = conversations.value.find((c) => c.id === activeId.value);
  if (!active) newConversation();
  const target = conversations.value.find((c) => c.id === activeId.value)!;
  target.messages.push({ id: ++seq, role: "user", text: titleText, images: bubbleImages });
  target.title = makeConversationTitle(target.messages, defaultConversationTitle());
  // 注意：push 进 reactive/ref 数组后，数组里存的是「响应式代理」，
  // 局部原始对象 assistant 与代理不是同一个引用——直接改原始对象不会触发视图更新。
  // 必须取回代理（target.messages 末尾项）再 mutate，状态栏进度才能实时上屏。
  target.messages.push({ id: ++seq, role: "assistant", text: "", status: undefined, toolActive: false, currentTool: undefined, toolStep: 0, finished: false });
  const assistant = target.messages[target.messages.length - 1];
  let suppressDelta = false; // 命中工具计划 JSON 后连续跳过后续分块，直到 text 事件权威覆盖
  target.updatedAt = Date.now();
  sending.value = true;
  modelNotice.value = "";
  await scrollBottom();
  let gotDone = false;
  let toolCount = 0; // 累计工具调用次数，实时展示进度（第 N 步）
  const controller = new AbortController();
  activeController.value = controller;
  try {
    await streamChat(
      text,
      { model: selectedModel.value ?? undefined, images: imageIds, files, uiLocale: uiLocale.value },
      (event: ChatEvent) => {
        const state = applyChatStreamEvent({
          event,
          assistant,
          state: {
            suppressDelta,
            gotDone,
            toolCount,
            modelNotice: modelNotice.value,
          },
          locale: uiLocale.value,
          tx,
        });
        suppressDelta = state.suppressDelta;
        gotDone = state.gotDone;
        toolCount = state.toolCount;
        modelNotice.value = state.modelNotice;
      },
      controller.signal,
    );
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      // 用户主动取消：保留已收到的文本，标记为已取消。
      assistant.cancelled = true;
    } else {
      const status = (err as Error & { status?: number }).status;
      assistant.error = localizeToken(uiLocale.value, getApiErrorToken(err), "CHAT_STREAM_FAILED");
      if (status === 401) await router.replace("/agents/admin/login");
    }
  } finally {
    sending.value = false;
    activeController.value = null;
    // 取消时不再给兜底提示；正常结束（done）但无任何有效产出时提示。
    if (!assistant.cancelled && gotDone && !assistant.text && !assistant.error && !assistant.tables?.length && !assistant.charts?.length && !assistant.files?.length && !assistant.toolResults?.length) {
      assistant.error = tx("本次未返回有效结果，请换个说法再试。", "No valid result was returned. Please try rephrasing.", "Nenhum resultado valido foi retornado. Tente reformular.", "कोई वैध परिणाम वापस नहीं आया। कृपया अलग तरह से पूछें।");
    }
    await scrollBottom();
  }
}

function cancelSend() {
  const controller = activeController.value;
  if (!controller || controller.signal.aborted) return;
  try {
    controller.abort();
  } catch {
    /* 已取消，忽略 */
  }
}

function onComposerKeydown(e: KeyboardEvent) {
  if (e.key !== "Enter") return;
  if (e.shiftKey) return;
  if (e.isComposing) return;
  e.preventDefault();
  send();
}

async function onLogout() {
  await logout();
  clearIdentityCache(IDENTITY_CACHE_KEY);
  me.value = null;
  await router.replace("/agents/admin/login");
}

// 助手消息 hover 工具：复制
const copiedId = ref<number | null>(null);

// 登录者显示名：优先中文名，回退登录账号；未登录时显示「你」。
const meName = computed(() => me.value?.user?.name || me.value?.user?.loginName || tx("你", "You", "Voce", "आप"));

// 输入框能力探测：环境/权限不满足的功能，对应按钮直接隐藏。
interface Capabilities {
  voice: boolean; // 语音输入（需 Web Speech API 支持）
}
const caps = ref<Capabilities>({ voice: false });

// 模型切换：availableModels 来自 /agent/models，selectedModel 为 null 表示用服务端默认模型（Auto）。
const availableModels = ref<ModelInfo[]>([]);
const selectedModel = ref<string | null>(null);
// 按钮上展示的当前模型名（同步维护，刷新瞬间即可渲染，避免先 Auto 再跳变的闪动）。
const selectedModelLabel = ref<string>("Auto");
const modelMenuOpen = ref(false);
// 按能力用途分组：纯文本对话模型 vs 视觉/多模态模型（vision 非 none）。
const textModels = computed(() => availableModels.value.filter((m) => m.vision === "none"));
const visionModels = computed(() => availableModels.value.filter((m) => m.vision !== "none"));

function detectCapabilities(): Capabilities {
  const SR = (window as unknown as Record<string, unknown>).SpeechRecognition ||
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  return { voice: !!SR };
}

const recording = ref(false);
const recognitionRef = shallowRef<SpeechRecognition | null>(null);

// 自动路由提示：当前模型不支持图片时，服务端自动改用视觉模型，这里展示提示。
const modelNotice = ref("");
const helpOpen = ref(false);

function useHelpExample(text: string) {
  input.value = text;
  composerH.value = null;
  document.documentElement.style.setProperty("--composer-max", "");
  nextTick(() => {
    resizeComposer();
    composerInput.value?.focus();
    composerInput.value?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}
const lightboxUrl = ref("");
const activeController = ref<AbortController | null>(null);
const { stopTaskStatusPolling, syncBackgroundTaskStatus } = createBackgroundTaskSync({
  me,
  conversations,
  activeId,
  sending,
  activeController,
  fetchTaskStatus,
  restoreConversations,
  scrollBottom,
  nextBubbleId: () => ++seq,
  backgroundStatusText: () => localizeToken(uiLocale.value, { code: "CHAT_TASK_RUNNING" }),
});

function openLightbox(id: string) {
  lightboxUrl.value = `/agent/chat/upload/${id}`;
}

// ---- 粘贴图片 ----
// 预览条：粘贴后立即上传后端拿 id，本地 objectURL 做缩略图预览；发送时随消息引用。
interface PastedImage {
  id: string;
  previewUrl: string;
  name: string;
}
const pastingImages = ref<PastedImage[]>([]);

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

function removePastedImage(index: number) {
  const [item] = pastingImages.value.splice(index, 1);
  if (item) URL.revokeObjectURL(item.previewUrl);
}

async function onComposerPaste(e: ClipboardEvent) {
  if (sending.value) return;
  const items = Array.from(e.clipboardData?.items || []);
  const files: File[] = [];
  for (const item of items) {
    if (!item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (!file) continue;
    if (!IMAGE_TYPES.includes(file.type)) {
      alert(tx(`不支持的图片格式：${file.type}，仅支持 png/jpeg/webp`, `Unsupported image format: ${file.type}. Only png/jpeg/webp are supported.`, `Formato de imagem nao suportado: ${file.type}. Apenas png/jpeg/webp sao aceitos.`, `असमर्थित छवि प्रारूप: ${file.type}। केवल png/jpeg/webp समर्थित हैं।`));
      continue;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert(tx("图片过大，单张不超过 5MB", "The image is too large. Each image must be 5 MB or smaller.", "A imagem e grande demais. Cada imagem deve ter no maximo 5 MB.", "छवि बहुत बड़ी है। प्रत्येक छवि 5 MB या उससे कम होनी चाहिए।"));
      continue;
    }
    files.push(file);
  }
  if (!files.length) return;
  e.preventDefault();
  try {
    const saved = await uploadFiles(files.slice(0, 4));
    const itemsToAdd: PastedImage[] = files.slice(0, saved.length).map((file, i) => ({
      id: saved[i].id,
      previewUrl: URL.createObjectURL(file),
      name: file.name,
    }));
    pastingImages.value.push(...itemsToAdd);
    nextTick(scrollBottom);
  } catch (err) {
    alert(localizeToken(uiLocale.value, getApiErrorToken(err), "UPLOAD_FAILED"));
  }
}

// ---- 文件上传 ----
const pastingFiles = ref<UploadResult[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const attachmentSummary = computed(() => {
  const imageCount = pastingImages.value.length;
  const fileCount = pastingFiles.value.length;
  const total = imageCount + fileCount;
  if (!total) {
    return tx("未附加文件", "No attachments", "Nenhum anexo", "कोई अटैचमेंट नहीं");
  }
  if (imageCount && fileCount) {
    return tx(
      `已附加 ${imageCount} 张图片和 ${fileCount} 个文件`,
      `${imageCount} image(s) and ${fileCount} file(s) attached`,
      `${imageCount} imagem(ns) e ${fileCount} arquivo(s) anexados`,
      `${imageCount} छवि और ${fileCount} फ़ाइल अटैच की गई`,
    );
  }
  if (imageCount) {
    return tx(
      `已附加 ${imageCount} 张图片`,
      `${imageCount} image(s) attached`,
      `${imageCount} imagem(ns) anexadas`,
      `${imageCount} छवि अटैच की गई`,
    );
  }
  return tx(
    `已附加 ${fileCount} 个文件`,
    `${fileCount} file(s) attached`,
    `${fileCount} arquivo(s) anexados`,
    `${fileCount} फ़ाइल अटैच की गई`,
  );
});

function removePastedFile(index: number) {
  pastingFiles.value.splice(index, 1);
}

async function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = "";
  if (!files.length) return;
  try {
    const saved = await uploadFiles(files.slice(0, 4));
    pastingFiles.value.push(...saved);
    nextTick(scrollBottom);
  } catch (err) {
    alert(localizeToken(uiLocale.value, getApiErrorToken(err), "UPLOAD_FAILED"));
  }
}

function initVoice(): SpeechRecognition | null {
  const SR = (window as unknown as Record<string, unknown>).SpeechRecognition ||
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  if (!SR) return null;
  const r = new (SR as new () => SpeechRecognition)();
  r.lang = "zh-CN";
  r.continuous = false;
  r.interimResults = true;
  r.onresult = (e: SpeechRecognitionEvent) => {
    let transcript = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      transcript += e.results[i][0].transcript;
    }
    if (transcript) {
      input.value = input.value ? `${input.value}${transcript}` : transcript;
      nextTick(resizeComposer);
    }
  };
  r.onerror = () => { recording.value = false; };
  r.onend = () => { recording.value = false; };
  return r;
}

function stopVoice() {
  if (recording.value && recognitionRef.value) {
    recognitionRef.value.stop();
  }
  recording.value = false;
}

function toggleVoice() {
  if (!recognitionRef.value) {
    recognitionRef.value = initVoice();
  }
  if (!recognitionRef.value) {
    alert(tx("当前浏览器不支持语音输入", "Voice input is not supported in this browser", "Entrada por voz nao e suportada neste navegador", "इस ब्राउज़र में वॉइस इनपुट समर्थित नहीं है"));
    return;
  }
  if (recording.value) {
    stopVoice();
  } else {
    recognitionRef.value.start();
    recording.value = true;
  }
}

function selectModel(id: string | null) {
  selectedModel.value = id;
  const label = id ? availableModels.value.find((m) => m.id === id)?.label ?? id : "Auto";
  selectedModelLabel.value = label;
  writeModelCache(MODEL_CACHE_KEY, id, label);
  modelMenuOpen.value = false;
}

function closeModelMenu() {
  modelMenuOpen.value = false;
}

// —— 模型菜单自定义滚动条（div 模拟，替代系统滚动条） ——
const modelMenuEl = ref<HTMLElement | null>(null);
const scrollbarTrackEl = ref<HTMLElement | null>(null);
const scrollbarThumbEl = ref<HTMLElement | null>(null);
let modelScrollbarCleanup: (() => void) | null = null;

watch(modelMenuOpen, async (open) => {
  if (!open) {
    modelScrollbarCleanup?.();
    modelScrollbarCleanup = null;
    return;
  }
  await nextTick();
  modelScrollbarCleanup?.();
  modelScrollbarCleanup = bindCustomScrollbar(
    () => modelMenuEl.value,
    () => scrollbarTrackEl.value,
    () => scrollbarThumbEl.value,
  );
});

async function copyBody(item: Bubble) {
  if (!item.text) return;
  const ok = await copyText(item.text);
  if (ok) {
    copiedId.value = item.id;
    setTimeout(() => {
      if (copiedId.value === item.id) copiedId.value = null;
    }, 1200);
  } else {
    alert(tx("复制失败：当前浏览器环境不允许访问剪贴板，请手动选中文本复制。", "Copy failed: clipboard access is not available in this browser.", "Falha ao copiar: o acesso a area de transferencia nao esta disponivel neste navegador.", "कॉपी विफल: इस ब्राउज़र में क्लिपबोर्ड की अनुमति उपलब्ध नहीं है।"));
  }
}

// 编辑：把该条消息内容填回输入框并聚焦，恢复自动高度便于修改。
function editInComposer(item: Bubble) {
  input.value = item.text;
  composerH.value = null;
  document.documentElement.style.setProperty("--composer-max", "");
  nextTick(() => {
    resizeComposer();
    composerInput.value?.focus();
    composerInput.value?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

async function switchCountry() {
  await logout();
  clearIdentityCache(IDENTITY_CACHE_KEY);
  me.value = null;
  await router.replace("/agents/admin/login");
}

async function onClearContext() {
  if (sending.value) return;
  try {
    const ok = await clearChatContext();
    if (!ok) return;
    const active = conversations.value.find((c) => c.id === activeId.value);
    if (active) {
      active.messages = [];
      active.title = defaultConversationTitle();
      active.updatedAt = Date.now();
      saveConversations();
      // 服务端同步清空当前会话消息（保留会话壳）。
      apiClearConversation(active.id).catch(() => {});
    }
    input.value = "";
    composerH.value = null;
    document.documentElement.style.setProperty("--composer-max", "");
    await nextTick();
    resizeComposer();
    await scrollBottom();
  } catch (err) {
    const status = (err as Error & { status?: number }).status;
    if (status === 401) {
      await router.replace("/agents/admin/login");
      return;
    }
    alert(localizeToken(uiLocale.value, getApiErrorToken(err), "CHAT_CONTEXT_CLEAR_FAILED"));
  }
}
</script>

<template>
  <div class="booth">
    <header class="top">
      <div class="identity">
        <RouterLink class="brand-mark" to="/">{{ tx("后台管理 Agent", "Admin Agent", "Agent de Backoffice", "एडमिन एजेंट") }}</RouterLink>
      </div>
      <div class="actions">
        <div class="meta">
          <button class="link" type="button" @click="switchCountry">
            {{ me?.country.label }}
          </button>
          <span>·</span>
          <span>{{ me?.user.name || me?.user.loginName }}</span>
        </div>
        <UiLocaleSelect />
        <ThemeToggle />
        <RouterLink v-if="me?.permissions?.entries?.trace" class="ghost" to="/trace">{{ tx("调用观察", "Trace", "Rastreamento", "ट्रेस") }}</RouterLink>
        <button class="ghost" type="button" @click="helpOpen = true">{{ tx("操作说明", "Help", "Ajuda", "सहायता") }}</button>
        <button class="ghost" type="button" :disabled="sending" @click="onClearContext">{{ tx("重置对话", "Reset Chat", "Redefinir Chat", "चैट रीसेट करें") }}</button>
        <button class="ghost" type="button" @click="onLogout">{{ tx("退出", "Logout", "Sair", "लॉगआउट") }}</button>
      </div>
    </header>

    <CapabilitiesHelp v-model:open="helpOpen" @use-example="useHelpExample" />

    <nav class="tabs" :aria-label="tx('会话切换', 'Conversation Tabs', 'Abas de Conversa', 'वार्तालाप टैब')">
      <div
        v-for="(conv, idx) in conversations"
        :key="conv.id"
        class="tab"
        :class="{ active: conv.id === activeId }"
        @contextmenu.prevent="openTabMenu($event, conv.id, idx)"
      >
        <button
          class="tab-main"
          :class="{ active: conv.id === activeId }"
          type="button"
          @click="switchConversation(conv.id)"
        >
          <span class="tab-index">{{ idx + 1 }}</span>
          <span class="tab-title">{{ displayConversationTitleOf(conv) }}</span>
        </button>
        <button
          class="tab-close"
          type="button"
          :aria-label="tx('关闭会话', 'Close conversation', 'Fechar conversa', 'वार्तालाप बंद करें')"
          :title="tx('关闭会话', 'Close conversation', 'Fechar conversa', 'वार्तालाप बंद करें')"
          @click.stop="closeConversation(conv.id)"
        >
          ×
        </button>
      </div>
      <button class="tab-new" type="button" :title="tx('新建会话', 'New conversation', 'Nova conversa', 'नई वार्तालाप')" @click="newConversation">＋</button>
    </nav>

    <Teleport to="body">
      <template v-if="tabMenu">
        <div class="tab-ctx-backdrop" @click="hideTabMenu" @contextmenu.prevent="hideTabMenu" />
        <ul
          class="tab-ctx-menu"
          role="menu"
          :style="{ left: `${tabMenu.x}px`, top: `${tabMenu.y}px` }"
          @click.stop
        >
          <li role="none">
            <button type="button" role="menuitem" @click="closeConversation(tabMenu.convId)">{{ tx("关闭", "Close", "Fechar", "बंद करें") }}</button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              :disabled="conversations.length <= 1"
              @click="closeOtherConversations(tabMenu.convId)"
            >
              {{ tx("关闭其他", "Close Others", "Fechar Outros", "अन्य बंद करें") }}
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              :disabled="tabMenu.idx <= 0"
              @click="closeLeftConversations(tabMenu.convId)"
            >
              {{ tx("关闭左侧", "Close Left", "Fechar a Esquerda", "बाईं ओर बंद करें") }}
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              :disabled="tabMenu.idx >= conversations.length - 1"
              @click="closeRightConversations(tabMenu.convId)"
            >
              {{ tx("关闭右侧", "Close Right", "Fechar a Direita", "दाईं ओर बंद करें") }}
            </button>
          </li>
          <li class="tab-ctx-sep" role="separator" />
          <li role="none">
            <button type="button" role="menuitem" @click="closeAllConversations">{{ tx("全部关闭", "Close All", "Fechar Tudo", "सभी बंद करें") }}</button>
          </li>
        </ul>
      </template>
    </Teleport>

    <div class="thread-frame">
      <main ref="scroller" class="thread" @scroll.passive="onThreadScroll">
        <div v-if="modelNotice" class="auto-model-notice">{{ modelNotice }}</div>
        <article v-for="{ item, cards } in messagesWithCards" :key="item.id" :class="['msg', item.role]">
        <div class="who" :class="{ me: item.role === 'user' }">
          <span class="dot" />
          {{ item.role === "user" ? meName : tx("助手", "Assistant", "Assistente", "सहायक") }}
        </div>
        <div v-if="item.text || item.images?.length || item.tables?.length || item.charts?.length || item.files?.length || item.toolResults?.length" class="body-wrap">
          <div v-if="item.images?.length" class="msg-images" :class="item.images.length > 1 ? 'grid' : 'single'">
            <img
              v-for="img in item.images"
              :key="img.id"
              class="msg-img"
              :src="`/agent/chat/upload/${img.id}`"
              :alt="img.name"
              loading="lazy"
              @click="openLightbox(img.id)"
              @error="(e) => ((e.target as HTMLImageElement).style.display = 'none')"
            />
          </div>
          <div v-if="item.charts?.length" class="msg-charts">
            <ResultChart
              v-for="(ch, ci) in item.charts"
              :key="`${item.id}-c${ci}-${ch.title}-${ch.categories?.length || 0}`"
              :chart="ch"
            />
          </div>
          <div v-if="item.reasoning" class="msg-reasoning">
            <button
              type="button"
              class="reasoning-head"
              :aria-expanded="item.reasoningExpanded"
              @click="item.reasoningExpanded = !item.reasoningExpanded"
            >
              <span class="reasoning-tag" aria-hidden="true">{{ tx("推理", "Reasoning", "Raciocinio", "तर्क") }}</span>
              <span class="reasoning-title">{{ tx("模型推理过程", "Model reasoning", "Raciocinio do modelo", "मॉडल तर्क") }}</span>
              <span class="reasoning-toggle" aria-hidden="true">{{ item.reasoningExpanded ? tx("收起", "Collapse", "Recolher", "समेटें") : tx("展开", "Expand", "Expandir", "विस्तार करें") }}</span>
            </button>
            <div v-if="item.reasoningExpanded" class="reasoning-body">
              <p v-for="(line, ri) in item.reasoning.trim().split('\n')" :key="ri" class="reasoning-line">{{ line }}</p>
            </div>
          </div>
              <div v-if="item.toolResults?.length" class="msg-tool-results">
            <div class="tool-group">
              <button
                type="button"
                class="tool-group__head"
                :aria-expanded="groupOpenOf(item.id)"
                @click="setGroupOpen(item.id, !groupOpenOf(item.id))"
              >
                <span class="tool-group__icon" aria-hidden="true">⚙</span>
                <span class="tool-group__title">
                  {{ item.currentTool ? `${tx("正在调用：", "Calling: ", "Chamando: ", "कॉल किया जा रहा है: ")}${toolStatusText(item.currentTool).replace(/…$/, "")}` : tx(`工具调用细节（${cards.length}）`, `Tool details (${cards.length})`, `Detalhes das ferramentas (${cards.length})`, `टूल विवरण (${cards.length})`) }}
                </span>
                <span class="tool-group__toggle" aria-hidden="true">{{ groupOpenOf(item.id) ? "▾" : "▸" }}</span>
              </button>
              <div v-if="groupOpenOf(item.id)" class="tool-group__body">
                <div class="tool-group__actions">
                  <button
                    type="button"
                    class="tool-group__act"
                    :disabled="cards.every(Boolean)"
                    @click="setAllCards(cards, true)"
                  >
                    {{ tx("全部展开", "Expand All", "Expandir Tudo", "सभी विस्तार करें") }}
                  </button>
                  <button
                    type="button"
                    class="tool-group__act"
                    :disabled="cards.every((v) => !v)"
                    @click="setAllCards(cards, false)"
                  >
                    {{ tx("全部折叠", "Collapse All", "Recolher Tudo", "सभी समेटें") }}
                  </button>
                </div>
                <ToolResultCard
                  v-for="(tr, ti) in item.toolResults ?? []"
                  :key="ti"
                  :name="tr.name"
                  :result="tr.result"
                  :expanded="cards[ti]"
                  @update:expanded="(v: boolean) => { cards[ti] = v }"
                />
              </div>
            </div>
          </div>
          <div v-if="item.tables?.length" class="msg-tables">
            <ResultTable v-for="(tb, ti) in item.tables" :key="ti" :table="tb" />
          </div>
          <div v-if="item.text" class="body" v-html="renderMarkdown(displayAssistantText(item))" />
          <span v-if="item.role === 'assistant' && item.text && !item.finished && !item.cancelled && !item.error" class="stream-caret" aria-hidden="true" />
          <div v-if="item.files?.length" class="msg-files">
            <div v-for="f in item.files" :key="f.id" class="file-card">
              <div class="file-meta">
                <strong>{{ f.name }}</strong>
                <span>{{ f.kind.toUpperCase() }} · {{ Math.max(1, Math.round(f.size / 1024)) }} KB</span>
              </div>
              <div class="file-actions">
                <a class="file-btn" :href="downloadUrl(f.id, false)" download>{{ f.kind === 'pdf' ? tx('下载 PDF', 'Download PDF', 'Baixar PDF', 'PDF डाउनलोड करें') : tx('下载 Excel', 'Download Excel', 'Baixar Excel', 'Excel डाउनलोड करें') }}</a>
              </div>
              <iframe
                v-if="f.kind === 'pdf'"
                class="pdf-preview"
                :src="downloadUrl(f.id, true)"
                :title="tx('PDF 预览', 'PDF preview', 'Pre-visualizacao do PDF', 'PDF पूर्वावलोकन')"
              />
            </div>
          </div>
          <div class="body-actions">
            <button
              type="button"
              class="act"
              :title="tx('编辑', 'Edit', 'Editar', 'संपादित करें')"
              @click="editInComposer(item)"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"
                />
              </svg>
            </button>
            <button
              type="button"
              class="act"
              :title="copiedId === item.id ? tx('已复制', 'Copied', 'Copiado', 'कॉपी हो गया') : tx('复制', 'Copy', 'Copiar', 'कॉपी करें')"
              @click="copyBody(item)"
            >
              <svg v-if="copiedId !== item.id" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2" />
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M5 15V5a2 2 0 0 1 2-2h10"
                />
              </svg>
              <svg v-else viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </button>
          </div>
        </div>
        <!-- 助手工作状态条：工具链阶段显示“正在做什么”；走工具链（toolStep>0）后即使开始吐字也常驻显示生成态，避免一闪而过黑盒感；流结束且有文本后隐藏 -->
        <div
          v-if="item.role === 'assistant' && !item.error && !item.cancelled && !item.finished && (!item.text || item.toolActive || (item.toolStep && item.toolStep > 0))"
          class="loading status-line"
          role="status"
          :aria-label="tx('正在回复', 'Replying', 'Respondendo', 'उत्तर दिया जा रहा है')"
        >
          <span class="loading-dot" />
          <span class="loading-text">{{ item.status || tx('正在思考…', 'Thinking…', 'Pensando…', 'सोच रहा है…') }}</span>
        </div>
        <p v-if="item.error" class="error">{{ item.error }}</p>
        <div v-else-if="item.cancelled" class="cancelled-note">{{ tx("已取消", "Cancelled", "Cancelado", "रद्द") }}</div>
        </article>
      </main>
      <div class="thread-scrollbar" ref="threadTrackEl">
        <div class="thread-scrollbar-thumb" ref="threadThumbEl"></div>
      </div>
    </div>

    <Transition name="back-top">
      <button
        v-if="scrollTop > 300"
        class="back-top-btn"
        type="button"
        :title="tx('返回顶部', 'Back to top', 'Voltar ao topo', 'शीर्ष पर वापस जाएं')"
        @click="scrollToTop"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M18 15l-6-6-6 6"/>
        </svg>
      </button>
    </Transition>

    <div
      v-if="lightboxUrl"
      class="lightbox"
      role="dialog"
      :aria-label="tx('图片预览', 'Image preview', 'Pre-visualizacao da imagem', 'छवि पूर्वावलोकन')"
      @click.self="lightboxUrl = ''"
    >
      <img :src="lightboxUrl" :alt="tx('图片大图', 'Large preview image', 'Imagem ampliada', 'बड़ी पूर्वावलोकन छवि')" />
    </div>

    <form class="composer" @submit.prevent="send()">
      <div class="composer-card">
        <div
          class="composer-grip"
          :title="tx('上下拖动调整输入框高度', 'Drag up or down to resize the composer', 'Arraste para cima ou para baixo para redimensionar a caixa de entrada', 'कंपोज़र का आकार बदलने के लिए ऊपर या नीचे खींचें')"
          @pointerdown="startComposerDrag"
          @mousedown="startComposerDrag"
          @touchstart="startComposerDrag"
        ></div>

        <div v-if="pastingImages.length || pastingFiles.length" class="image-preview">
          <div v-for="(item, index) in pastingImages" :key="item.id" class="image-chip">
            <img :src="item.previewUrl" :alt="tx('粘贴的图片', 'Pasted image', 'Imagem colada', 'चिपकाई गई छवि')" />
            <button
              type="button"
              class="image-remove"
              :title="tx('移除图片', 'Remove image', 'Remover imagem', 'छवि हटाएं')"
              :disabled="sending"
              @click="removePastedImage(index)"
            >
              ×
            </button>
          </div>
          <div v-for="(item, index) in pastingFiles" :key="item.id" class="file-chip">
            <span class="file-chip-name" :title="item.name">{{ item.name }}</span>
            <button
              type="button"
              class="image-remove"
              :title="tx('移除文件', 'Remove file', 'Remover arquivo', 'फ़ाइल हटाएं')"
              :disabled="sending"
              @click="removePastedFile(index)"
            >
              ×
            </button>
          </div>
        </div>

        <textarea
          ref="composerInput"
          v-model="input"
          class="composer-input"
          :style="composerH != null ? { height: composerH + 'px' } : undefined"
          :disabled="sending"
          rows="1"
          enterkeyhint="send"
          :placeholder="recording ? tx('正在聆听…', 'Listening…', 'Ouvindo…', 'सुन रहा है…') : tx('输入内容，回车发送；支持直接粘贴图片', 'Type your message and press Enter to send; pasting images is supported', 'Digite sua mensagem e pressione Enter para enviar; colar imagens e suportado', 'अपना संदेश टाइप करें और भेजने के लिए Enter दबाएं; चित्र पेस्ट करना समर्थित है')"
          @keydown="onComposerKeydown"
          @input="resizeComposer"
          @paste="onComposerPaste"
        />

        <div class="composer-toolbar">
          <div class="model-switch">
            <button
              type="button"
              class="model-btn"
              :class="{ active: modelMenuOpen }"
              :title="tx('切换模型', 'Switch model', 'Trocar modelo', 'मॉडल बदलें')"
              :disabled="sending"
              @click="modelMenuOpen = !modelMenuOpen"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 3v3m0 12v3m9-9h-3M6 12H3m13.5-6.5l-2 2m-7 7l-2 2m11 0l-2-2m-7-7l-2-2"
                />
                <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2" />
              </svg>
              <span class="model-btn-label">{{ selectedModelLabel }}</span>
              <svg class="model-btn-caret" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                <path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
              </svg>
            </button>
            <Transition name="model-menu-fade">
              <div
                v-if="modelMenuOpen && availableModels.length"
                class="model-menu"
                ref="modelMenuEl"
                @click.stop
              >
                <div class="model-menu-header">
                  <div class="model-menu-title">{{ tx("选择模型", "Choose Model", "Escolher modelo", "मॉडल चुनें") }}</div>
                  <span class="model-menu-count">
                    {{
                      tx(
                        `${availableModels.length} 个可用`,
                        `${availableModels.length} available`,
                        `${availableModels.length} disponiveis`,
                        `${availableModels.length} उपलब्ध`,
                      )
                    }}
                  </span>
                </div>
                <button
                  type="button"
                  class="model-item model-item-auto"
                  :class="{ selected: selectedModel === null }"
                  :title="tx('Auto（服务端自动）· 智能路由', 'Auto (server managed) · Smart routing', 'Auto (gerenciado pelo servidor) · Roteamento inteligente', 'Auto (सर्वर प्रबंधित) · स्मार्ट रूटिंग')"
                  @click="selectModel(null)"
                >
                  <span class="model-auto-dot"></span>
                  <span class="model-label">{{ tx("Auto（服务端自动）", "Auto (server managed)", "Auto (gerenciado pelo servidor)", "Auto (सर्वर प्रबंधित)") }}</span>
                  <span class="model-provider">{{ tx("智能路由", "Smart routing", "Roteamento inteligente", "स्मार्ट रूटिंग") }}</span>
                </button>
                <template v-if="textModels.length">
                  <div class="model-group">
                    <div class="model-group-title">{{ tx("文本对话", "Text Chat", "Chat de texto", "टेक्स्ट चैट") }}</div>
                    <div class="model-list">
                      <button
                        v-for="m in textModels"
                        :key="m.id"
                        type="button"
                        class="model-item"
                        :class="{ selected: selectedModel === m.id }"
                        :title="`${m.label} · ${m.source || m.provider} · ${m.id}`"
                        @click="selectModel(m.id)"
                      >
                        <span class="model-label">{{ m.label }}</span>
                        <span class="model-provider">{{ m.source || m.provider }}</span>
                      </button>
                    </div>
                  </div>
                </template>
                <template v-if="visionModels.length">
                  <div class="model-group">
                    <div class="model-group-title">{{ tx("视觉 / 多模态", "Vision / Multimodal", "Visao / Multimodal", "विज़न / मल्टीमॉडल") }}</div>
                    <div class="model-list">
                      <button
                        v-for="m in visionModels"
                        :key="m.id"
                        type="button"
                        class="model-item"
                        :class="{ selected: selectedModel === m.id }"
                        :title="`${m.label} · ${m.source || m.provider} · ${m.id}`"
                        @click="selectModel(m.id)"
                      >
                        <span class="model-label">{{ m.label }}</span>
                        <span class="model-badge">{{ tx("视觉", "Vision", "Visao", "विज़न") }}</span>
                        <span class="model-provider">{{ m.source || m.provider }}</span>
                      </button>
                    </div>
                  </div>
                </template>
                <div class="model-scrollbar" ref="scrollbarTrackEl">
                  <div class="model-scrollbar-thumb" ref="scrollbarThumbEl"></div>
                </div>
              </div>
            </Transition>
          </div>
          <div class="toolbar-right">
            <button
              type="button"
              class="tool-btn"
              :title="tx('上传文件（txt/md/json/csv，或图片）', 'Upload files (txt/md/json/csv or images)', 'Enviar arquivos (txt/md/json/csv ou imagens)', 'फ़ाइलें अपलोड करें (txt/md/json/csv या चित्र)')"
              :aria-label="tx('上传文件', 'Upload files', 'Enviar arquivos', 'फ़ाइलें अपलोड करें')"
              :disabled="sending"
              @click="fileInput?.click()"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
                />
              </svg>
            </button>
            <input
              ref="fileInput"
              type="file"
              multiple
              class="hidden-file-input"
              tabindex="-1"
              aria-hidden="true"
              @change="onFileChange"
            />
            <span class="attachment-status" :title="attachmentSummary">{{ attachmentSummary }}</span>
            <button
              v-if="caps.voice"
              type="button"
              class="tool-btn"
              :class="{ active: recording }"
              :title="tx('语音输入', 'Voice input', 'Entrada por voz', 'वॉइस इनपुट')"
              @click="toggleVoice"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"
                />
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M19 10v2a7 7 0 0 1-14 0v-2m7 9v3"
                />
              </svg>
            </button>
            <button
              type="submit"
              class="send-btn"
              :class="{ stopping: sending }"
              :title="sending ? tx('停止生成', 'Stop generating', 'Parar geracao', 'जनरेशन रोकें') : tx('发送', 'Send', 'Enviar', 'भेजें')"
              @click.prevent="sending ? cancelSend() : send()"
            >
              <svg v-if="sending" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <rect x="7" y="7" width="10" height="10" rx="3" fill="currentColor" />
              </svg>
              <svg v-else viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 19V5m-7 7l7-7 7 7"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </form>
  </div>
</template>

<style scoped>
.booth {
  height: 100dvh;
  width: 100%;
  max-width: 100vw;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto auto 1fr auto;
  background: var(--bg);
  overflow-x: hidden;
}

.top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: calc(14px + var(--safe-top)) var(--pad) 14px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  backdrop-filter: blur(20px) saturate(1.2);
  -webkit-backdrop-filter: blur(20px) saturate(1.2);
  box-shadow: 0 1px 0 color-mix(in srgb, var(--ink) 5%, transparent);
  position: relative;
  z-index: 20;
}

.identity {
  display: flex;
  align-items: center;
  min-width: 0;
}

.brand-mark {
  font-size: 20px;
  line-height: 1;
  letter-spacing: 0.06em;
  font-weight: 700;
}

.meta {
  color: var(--muted);
  font-size: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-shrink: 0;
}

.link {
  background: none;
  border: none;
  padding: 0;
  height: auto;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  letter-spacing: 0;
  text-transform: none;
  border-radius: 0;
  transition: color 0.15s ease;
}

.link:hover {
  color: var(--ink);
}

.ghost {
  background: transparent;
  color: var(--muted);
  border: 1px solid var(--line);
  cursor: pointer;
  height: 32px;
  padding: 0 14px;
  font-size: 12.5px;
  border-radius: var(--radius-sm);
  transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  text-decoration: none;
}

.ghost:hover:not(:disabled) {
  color: var(--ink);
  background: var(--fill-soft);
  border-color: color-mix(in srgb, var(--ink) 20%, var(--line));
}

.ghost:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.tabs {
  display: flex;
  align-items: flex-end;
  gap: 1px;
  overflow-x: auto;
  padding: 0 var(--pad);
  position: relative;
  scrollbar-width: none;
  background: var(--panel);
}

.tabs::-webkit-scrollbar {
  display: none;
}

.tabs::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  background: var(--line);
  pointer-events: none;
}

.tab {
  position: relative;
  display: flex;
  align-items: center;
  max-width: 200px;
  flex-shrink: 0;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  background: transparent;
  color: var(--muted);
  font-size: 12.5px;
  letter-spacing: 0.01em;
  transition: background 0.16s ease, color 0.16s ease, border-color 0.16s ease;
}

.tab.active {
  color: var(--ink);
  font-weight: 600;
  background: var(--panel);
  border-color: var(--line);
  margin-bottom: -1px;
  padding-bottom: 9px;
  z-index: 1;
}

.tab.active::before {
  content: "";
  position: absolute;
  bottom: 0;
  left: 12px;
  right: 12px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--ink);
}

.tab:not(.active):hover {
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  color: var(--ink);
}

.tab-main {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 8px 8px 14px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.tab-main:focus-visible,
.tab-close:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 24%, transparent);
  outline-offset: -1px;
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 0 1 auto;
}

.tab-index {
  flex-shrink: 0;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: var(--muted);
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}

.tab.active .tab-index {
  color: #fff;
  background: var(--accent);
}

.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 18px;
  height: 18px;
  margin-right: 10px;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 5px;
  font-size: 13px;
  line-height: 1;
  color: var(--muted);
  opacity: 0.45;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}

.tab:hover .tab-close,
.tab.active .tab-close {
  opacity: 1;
}

.tab-close:hover {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.tab-new {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  align-self: center;
  margin: 0 0 1px 4px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease;
}

.tab-new:hover {
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  color: var(--ink);
}

.tab-ctx-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
}

.tab-ctx-menu {
  position: fixed;
  z-index: 81;
  min-width: 168px;
  margin: 0;
  padding: 6px;
  list-style: none;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--panel);
  box-shadow: 0 10px 28px color-mix(in srgb, var(--ink) 16%, transparent);
}

.tab-ctx-menu button {
  display: block;
  width: 100%;
  padding: 8px 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ink);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease;
}

.tab-ctx-menu button:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ink) 7%, transparent);
}

.tab-ctx-menu button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.tab-ctx-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--line);
}

.thread-frame {
  position: relative;
  min-height: 0;
}

.thread {
  position: relative;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 28px var(--pad) 24px;
  display: flex;
  flex-direction: column;
  gap: 26px;
  width: 100%;
  min-width: 0;
  justify-self: stretch;
  -webkit-overflow-scrolling: touch;
  scroll-behavior: smooth;
  /* 隐藏原生滚动条，改用自定义 .thread-scrollbar（div 模拟） */
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.thread::-webkit-scrollbar {
  display: none;
}

/* 聊天区自定义滚动条：默认轻微可见（滚动进度感知），hover/拖拽时高亮 */
.thread-scrollbar {
  position: absolute;
  top: 12px;
  right: 4px;
  bottom: 12px;
  width: 8px;
  z-index: 3;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  opacity: 0.35;
  transition: opacity 0.18s ease;
}

.thread:hover .thread-scrollbar,
.thread-scrollbar.is-dragging {
  opacity: 1;
}

.thread-scrollbar.is-off {
  display: none;
}

.thread-scrollbar-thumb {
  position: absolute;
  left: 1px;
  width: 6px;
  border-radius: 999px;
  cursor: pointer;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--ink) 42%, transparent),
    color-mix(in srgb, var(--ink) 26%, transparent)
  );
  transition: background 0.14s ease;
}

.thread-scrollbar-thumb:hover,
.thread-scrollbar.is-dragging .thread-scrollbar-thumb {
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--accent, #2f6df6) 62%, var(--ink)),
    color-mix(in srgb, var(--accent, #2f6df6) 40%, var(--ink))
  );
}

.msg {
  max-width: min(860px, 100%);
  min-width: 0;
  align-self: flex-start;
  width: fit-content;
  margin-right: auto;
  animation: rise 0.35s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.msg.user {
  max-width: min(520px, 100%);
  align-self: flex-end;
  margin-right: 0;
  margin-left: auto;
}

.who {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 8px;
  font-weight: 500;
}

.who.me {
  justify-content: flex-end;
}

.who .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted);
  flex-shrink: 0;
}

.who.me .dot {
  background: var(--ink);
  order: 2;
}

.body {
  margin: 0;
  word-break: break-word;
  overflow-wrap: anywhere;
  /* 不加 overflow-x: hidden，让内层 .table-wrapper / pre 各自处理横向滚动 */
  font-family: var(--font-body);
  font-size: 14.5px;
  line-height: 1.75;
  background: var(--fill);
  border: 1px solid var(--line);
  padding: 16px 18px;
  border-radius: var(--radius);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--ink) 3%, transparent);
}

/* 助手气泡：对齐 DeepSeek——融于背景，无边框无底色，仅用户消息反白（见 .msg.user .body） */
.msg:not(.user) .body {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
  padding-left: 4px;
  padding-right: 4px;
}

.msg:not(.user) .body:hover {
  background: color-mix(in srgb, var(--ink) 3%, transparent);
}

/* Markdown 渲染内容的排版 */
.body :deep(p) {
  margin: 0 0 10px;
  white-space: pre-wrap;
}
.body :deep(p:last-child) {
  margin-bottom: 0;
}
.body :deep(h1),
.body :deep(h2),
.body :deep(h3),
.body :deep(h4) {
  margin: 16px 0 8px;
  line-height: 1.4;
  font-weight: 700;
}
.body :deep(h1:first-child),
.body :deep(h2:first-child),
.body :deep(h3:first-child),
.body :deep(h4:first-child) {
  margin-top: 0;
}
.body :deep(h1) {
  font-size: 20px;
}
.body :deep(h2) {
  font-size: 18px;
}
.body :deep(h3) {
  font-size: 16px;
}
.body :deep(h4) {
  font-size: 14.5px;
}
.body :deep(strong) {
  font-weight: 700;
}
.body :deep(em) {
  font-style: italic;
}
.body :deep(ul),
.body :deep(ol) {
  margin: 0 0 10px;
  padding-left: 22px;
}
.body :deep(ul:last-child),
.body :deep(ol:last-child) {
  margin-bottom: 0;
}
.body :deep(li) {
  margin: 3px 0;
}
.body :deep(li > p) {
  margin: 0;
  white-space: normal;
}
.body :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.9em;
  background: color-mix(in srgb, var(--ink) 9%, transparent);
  border-radius: 4px;
  padding: 1px 5px;
}
.body :deep(pre) {
  margin: 10px 0;
  padding: 12px 14px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  border: 1px solid var(--line);
  overflow-x: auto;
  line-height: 1.6;
}
.body :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: 13px;
}
.body :deep(a) {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.body :deep(a:hover) {
  opacity: 0.8;
}
.body :deep(blockquote) {
  margin: 10px 0;
  padding: 2px 14px;
  border-left: 3px solid color-mix(in srgb, var(--ink) 25%, transparent);
  color: color-mix(in srgb, var(--ink) 75%, transparent);
}
.body :deep(hr) {
  border: none;
  border-top: 1px solid var(--line);
  margin: 14px 0;
}
.body :deep(img) {
  max-width: 100%;
  height: auto;
  display: block;
  border-radius: 6px;
}
.body :deep(.table-wrapper) {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  margin: 10px 0;
  border-radius: 6px;
  border: 1px solid var(--line);
}
.body :deep(table) {
  border-collapse: collapse;
  margin: 0;
  width: max-content;
  min-width: 100%;
  font-size: 13.5px;
}
.body :deep(.table-wrapper th),
.body :deep(.table-wrapper td) {
  border: none;
  border-bottom: 1px solid var(--line);
  border-right: 1px solid var(--line);
}
.body :deep(.table-wrapper tr:last-child th),
.body :deep(.table-wrapper tr:last-child td) {
  border-bottom: none;
}
.body :deep(.table-wrapper th:last-child),
.body :deep(.table-wrapper td:last-child) {
  border-right: none;
}
.body :deep(th),
.body :deep(td) {
  border: 1px solid var(--line);
  padding: 6px 12px;
  text-align: left;
  white-space: nowrap;
}
.body :deep(th) {
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  font-weight: 600;
  position: sticky;
  top: 0;
}

.msg:not(.user) .body:hover {
  border-color: color-mix(in srgb, var(--ink) 12%, var(--line));
}

.msg.user .body {
  background: var(--ink);
  color: var(--bg);
  border-color: var(--ink);
  border-top-right-radius: 4px;
  box-shadow: 0 2px 8px color-mix(in srgb, var(--ink) 12%, transparent);
}

/* 用户气泡为深色反白底，覆盖部分元素使其可读 */
.msg.user .body :deep(code) {
  background: color-mix(in srgb, var(--bg) 18%, transparent);
}
.msg.user .body :deep(pre) {
  background: color-mix(in srgb, var(--bg) 12%, transparent);
  border-color: color-mix(in srgb, var(--bg) 20%, transparent);
}
.msg.user .body :deep(blockquote) {
  border-left-color: color-mix(in srgb, var(--bg) 40%, transparent);
  color: color-mix(in srgb, var(--bg) 80%, transparent);
}
.msg.user .body :deep(th),
.msg.user .body :deep(td) {
  border-color: color-mix(in srgb, var(--bg) 25%, transparent);
}
.msg.user .body :deep(th) {
  background: color-mix(in srgb, var(--bg) 12%, transparent);
}
.msg.user .body :deep(.table-wrapper) {
  border-color: color-mix(in srgb, var(--bg) 25%, transparent);
}

.body-wrap {
  position: relative;
  width: fit-content;
  max-width: 100%;
  min-width: 0;
}

/* 等待助手返回时的 loading 气泡 */
/* 状态条：与正文块统一顶部 10px 间距节奏 */
.loading {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 14px 18px;
  margin-top: 10px;
  background: var(--fill);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--ink) 3%, transparent);
}

.loading-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
  opacity: 0.4;
  animation: load-bounce 1.2s ease-in-out infinite;
}

.loading-text {
  font-size: 13px;
  color: var(--muted);
  white-space: nowrap;
}

.loading-dot:nth-child(2) {
  animation-delay: 0.15s;
}

.loading-dot:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes load-bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

.body-actions {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 8px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
}

.body-wrap:hover .body-actions,
.body-actions:focus-within {
  opacity: 1;
  pointer-events: auto;
}

/* 思考过程折叠块：与「工具调用细节」统一设计语言，但通过左侧强调色区分 */
/* 间距节奏：与其他辅助块（工具调用/表格/状态条）统一顶部 10px，去掉交错的 8/4px */
.msg-reasoning {
  margin: 10px 0 0;
  border-radius: var(--radius, 10px);
  background: var(--fill);
  border: 1px solid var(--line);
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--text-secondary, #4b5563) 42%, transparent);
  overflow: hidden;
}

.reasoning-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: transparent;
  border: none;
  cursor: pointer;
  font: inherit;
  color: var(--text-secondary, #4b5563);
  text-align: left;
  transition: background 0.15s ease;
}

.reasoning-head:hover {
  background: rgba(0, 0, 0, 0.03);
}

.reasoning-tag {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 5px;
  color: color-mix(in srgb, var(--text-secondary, #4b5563) 90%, transparent);
  background: color-mix(in srgb, var(--text-secondary, #4b5563) 10%, transparent);
  letter-spacing: 0.02em;
}

.reasoning-title {
  flex: 1;
  min-width: 0;
  font-weight: 500;
  font-size: 12px;
  color: var(--text-secondary, #4b5563);
}

.reasoning-toggle {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-tertiary, #9ca3af);
  user-select: none;
}

.reasoning-body {
  border-top: 1px solid var(--line);
  /* 四周统一 12px，比原 10px 12px 更透气 */
  padding: 12px;
  animation: rise 0.2s ease both;
}

.reasoning-line {
  margin: 0;
  padding: 2px 0 2px 10px;
  position: relative;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-tertiary, #6b7280);
  white-space: pre-wrap;
  word-break: break-word;
}

.reasoning-line::before {
  content: "";
  position: absolute;
  left: 2px;
  top: 9px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--line);
}

.reasoning-line:not(:last-child)::after {
  content: "";
  position: absolute;
  left: 3px;
  top: 15px;
  bottom: -2px;
  width: 1px;
  background: var(--line);
  opacity: 0.5;
}

/* markdown 行内表格美化（GFM 风格，与 ResultTable 统一观感） */
.body :deep(.table-wrapper) {
  margin: 10px 0;
  border-radius: 10px;
  border: 1px solid var(--line);
  overflow-x: auto;
}

.body :deep(table) {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  line-height: 1.6;
}

.body :deep(thead th) {
  position: sticky;
  top: 0;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  font-weight: 600;
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}

.body :deep(tbody td) {
  padding: 7px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
}

.body :deep(tbody tr:nth-child(even)) {
  background: color-mix(in srgb, var(--ink) 2.5%, transparent);
}

.body :deep(tbody tr:hover) {
  background: color-mix(in srgb, var(--accent, #4f7cff) 8%, transparent);
}

/* 流式输出打字光标 */
.stream-caret {
  display: inline-block;
  width: 8px;
  height: 15px;
  margin-left: 2px;
  vertical-align: text-bottom;
  border-radius: 1px;
  background: var(--accent, #4f7cff);
  animation: caret-blink 1s steps(2, start) infinite;
}

@keyframes caret-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}

.act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--muted);
  cursor: pointer;
  border-radius: 6px;
  transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
}

.act:hover {
  color: var(--ink);
  background: var(--fill-soft);
  border-color: color-mix(in srgb, var(--ink) 15%, var(--line));
  transform: scale(1.05);
}

.act:active {
  transform: scale(0.95);
}

.error {
  color: var(--danger);
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.5;
}

/* 用户取消后的提示（飞书式：回到气泡样式） */
.cancelled-note {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0 0;
  padding: 8px 14px;
  background: var(--fill);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1;
}

.composer {
  padding: 14px var(--pad) calc(16px + var(--safe-bottom));
  border-top: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel) 90%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}

.composer-card {
  display: flex;
  flex-direction: column;
  gap: 0;
  width: 100%;
  border: 1px solid var(--line);
  background: var(--fill);
  border-radius: 22px;
  padding: 4px 8px 4px 14px;
  box-shadow: 0 2px 8px color-mix(in srgb, var(--ink) 4%, transparent);
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

.composer-card:focus-within {
  border-color: color-mix(in srgb, var(--ink) 25%, var(--line));
  box-shadow: 0 2px 12px color-mix(in srgb, var(--ink) 6%, transparent),
              0 0 0 3px color-mix(in srgb, var(--ink) 4%, transparent);
}

.composer-grip {
  flex-shrink: 0;
  height: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: row-resize;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

.composer-grip::after {
  content: "";
  width: 44px;
  height: 3px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 16%, transparent);
  transition: background 0.15s ease, transform 0.15s ease;
}

.composer-grip:hover::after,
.composer-grip:active::after {
  background: color-mix(in srgb, var(--ink) 35%, transparent);
  transform: scaleX(1.12);
}

.composer-input {
  /* 不能用 flex: 1：纵向 flex 中 flex-basis 0% 会接管主轴尺寸，导致 height 内联样式被忽略 */
  flex: 0 0 auto;
  min-width: 0;
  width: 100%;
  max-height: var(--composer-max, 70vh);
  min-height: 130px;
  resize: none;
  border: 0;
  background: transparent;
  padding: 8px 2px 4px;
  font-size: 15px;
  line-height: 1.5;
  font-family: inherit;
  color: var(--ink);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.composer-input::placeholder {
  color: color-mix(in srgb, var(--muted) 70%, transparent);
}

.composer-input:focus,
.composer-input:focus-visible {
  outline: none;
  box-shadow: none;
}

.composer-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding-top: 2px;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tool-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
}

.tool-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  color: var(--ink);
}

.tool-btn:active:not(:disabled) {
  transform: scale(0.92);
}

.tool-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.tool-btn:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--ink) 30%, var(--line));
}

.tool-btn.active {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: var(--danger);
}

.tool-btn.active svg {
  animation: mic-pulse 1.4s ease-in-out infinite;
}

@keyframes mic-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

.send-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: linear-gradient(150deg, var(--accent, #4f7cff) 0%, color-mix(in srgb, var(--accent, #4f7cff) 70%, #2f5fe0) 100%);
  color: #fff;
  cursor: pointer;
  transition: background 0.15s ease, opacity 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease;
}

.send-btn:not(:disabled) {
  box-shadow: 0 2px 8px color-mix(in srgb, var(--accent, #4f7cff) 30%, transparent);
}

/* 停止生成态：琥珀渐变 + 顶部高光 + 舒缓呼吸光晕，替代刺眼平涂与警示灯式脉冲 */
.send-btn.stopping {
  background: linear-gradient(
    150deg,
    color-mix(in srgb, var(--stop) 80%, #fff) 0%,
    var(--stop) 48%,
    color-mix(in srgb, var(--stop) 70%, #000) 100%
  );
  color: #fff;
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #fff 30%, transparent),
    inset 0 -1px 0 color-mix(in srgb, #000 12%, transparent),
    0 2px 10px color-mix(in srgb, var(--stop) 30%, transparent);
  animation: stop-breathe 2.4s ease-in-out infinite;
}

.send-btn.stopping svg rect {
  transform-box: fill-box;
  transform-origin: center;
  animation: stop-icon-breathe 2.4s ease-in-out infinite;
}

@keyframes stop-breathe {
  0%,
  100% {
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 30%, transparent),
      inset 0 -1px 0 color-mix(in srgb, #000 12%, transparent),
      0 2px 8px color-mix(in srgb, var(--stop) 24%, transparent),
      0 0 0 0 color-mix(in srgb, var(--stop) 0%, transparent);
  }
  50% {
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 34%, transparent),
      inset 0 -1px 0 color-mix(in srgb, #000 12%, transparent),
      0 2px 10px color-mix(in srgb, var(--stop) 32%, transparent),
      0 0 0 7px color-mix(in srgb, var(--stop) 12%, transparent);
  }
}

@keyframes stop-icon-breathe {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(0.9);
    opacity: 0.66;
  }
}

.send-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ink) 82%, var(--line-strong));
}

.send-btn.stopping:hover:not(:disabled) {
  background: linear-gradient(
    150deg,
    color-mix(in srgb, var(--stop) 84%, #fff) 0%,
    color-mix(in srgb, var(--stop) 92%, #000) 100%
  );
  animation: none;
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #fff 32%, transparent),
    0 0 0 4px color-mix(in srgb, var(--stop) 16%, transparent);
  transform: scale(1.05);
}

.send-btn.stopping:hover svg rect {
  animation: none;
  transform: scale(1);
  opacity: 1;
}

.send-btn:active:not(:disabled) {
  transform: scale(0.92);
}

.send-btn:disabled {
  opacity: 0.28;
  cursor: not-allowed;
}

.send-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 35%, transparent);
}

/* 模型切换：按钮 + 下拉菜单 */
.model-switch {
  position: relative;
}

.model-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: transparent;
  color: var(--ink);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
}

.model-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  color: var(--ink);
}

.model-btn:active:not(:disabled) {
  transform: scale(0.97);
}

.model-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.model-btn.active {
  background: color-mix(in srgb, var(--ink) 10%, transparent);
  color: var(--ink);
  border-color: color-mix(in srgb, var(--ink) 30%, var(--line));
}

.model-btn-label {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.model-btn-caret {
  opacity: 0.6;
}

.model-menu {
  position: absolute;
  bottom: calc(100% + 12px);
  left: 0;
  z-index: 30;
  width: min(600px, 88vw);
  box-sizing: border-box;
  max-height: 64vh;
  overflow-y: auto;
  padding: 12px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--bg), #ffffff 0%);
  border: 1px solid var(--line);
  box-shadow: 0 16px 48px color-mix(in srgb, var(--ink) 24%, transparent);
  backdrop-filter: blur(8px);
}

.model-menu-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 2px 10px 10px;
  position: sticky;
  top: -12px;
  background: var(--bg);
  z-index: 2;
}

.model-menu-title {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.01em;
  color: var(--ink);
}

.model-menu-count {
  font-size: 10.5px;
  color: var(--muted);
}

.model-group-title {
  position: sticky;
  top: 16px;
  margin: 8px 4px 6px;
  padding: 6px 10px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(4px);
  border-radius: 8px;
}

.model-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.model-item {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 36px;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--ink) 3%, transparent);
  color: var(--ink);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease, transform 0.08s ease;
}

.model-item:hover {
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  border-color: color-mix(in srgb, var(--accent, #2f6df6) 35%, var(--line));
  transform: translateY(-1px);
}

.model-item:active {
  transform: translateY(0);
}

.model-item.selected {
  background: color-mix(in srgb, var(--accent, #2f6df6) 12%, transparent);
  border-color: color-mix(in srgb, var(--accent, #2f6df6) 50%, transparent);
  color: color-mix(in srgb, var(--accent, #2f6df6) 78%, var(--ink));
  font-weight: 600;
}

.model-item-auto {
  border-style: dashed;
  border-color: color-mix(in srgb, var(--accent, #2f6df6) 30%, var(--line));
}

.model-auto-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent, #2f6df6);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #2f6df6) 20%, transparent);
  flex: none;
}

.model-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
}

.model-badge {
  flex: none;
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #fff;
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent, #2f6df6) 90%, #000), color-mix(in srgb, var(--accent, #2f6df6) 70%, #5b8bff));
}

.model-provider {
  flex: none;
  margin-left: auto;
  font-size: 10.5px;
  color: var(--muted);
  text-transform: capitalize;
  white-space: nowrap;
}

/* 隐藏原生滚动条，改用自定义 .model-scrollbar（div 模拟，跨浏览器一致） */
.model-menu {
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.model-menu::-webkit-scrollbar {
  display: none;
}

.model-scrollbar {
  position: absolute;
  top: 12px;
  right: 4px;
  bottom: 12px;
  width: 8px;
  z-index: 3;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  opacity: 0;
  transition: opacity 0.18s ease;
}

/* 菜单 hover 或正在拖拽时显示滚动条 */
.model-menu:hover .model-scrollbar,
.model-scrollbar.is-dragging {
  opacity: 1;
}

/* 内容不足一屏时隐藏 */
.model-scrollbar.is-off {
  display: none;
}

.model-scrollbar-thumb {
  position: absolute;
  left: 1px;
  width: 6px;
  border-radius: 999px;
  cursor: pointer;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--ink) 42%, transparent),
    color-mix(in srgb, var(--ink) 26%, transparent)
  );
  transition: background 0.14s ease;
}

.model-scrollbar-thumb:hover,
.model-scrollbar.is-dragging .model-scrollbar-thumb {
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--accent, #2f6df6) 62%, var(--ink)),
    color-mix(in srgb, var(--accent, #2f6df6) 40%, var(--ink))
  );
}

.model-menu-fade-enter-active,
.model-menu-fade-leave-active {
  transition: opacity 0.14s ease, transform 0.14s ease;
}

.model-menu-fade-enter-from,
.model-menu-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

.hidden-file-input {
  display: none;
}

.attachment-status {
  min-width: 0;
  max-width: 180px;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 用户消息里的图片（飞书式：靠边贴齐气泡、无边框、小圆角） */
.msg-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 0 6px;
  justify-content: flex-end;
}

.msg-images.single .msg-img {
  width: auto;
  height: auto;
  max-width: min(480px, 100%);
  max-height: 380px;
}

.msg-images.grid .msg-img {
  width: 152px;
  height: 152px;
  object-fit: cover;
}

.msg-img {
  border-radius: 6px;
  background: var(--panel);
  display: block;
  cursor: zoom-in;
  transition: filter 0.15s ease, transform 0.15s ease;
}

.msg-img:hover {
  filter: brightness(0.97);
}

/* 表格块：与推理/工具块统一顶部 10px 间距节奏 */
.msg-tables {
  margin-top: 10px;
  max-width: min(920px, 100%);
}

/* 工具调用块：与推理/表格块统一顶部 10px 间距节奏 */
.msg-tool-results {
  margin-top: 10px;
  max-width: min(920px, 100%);
}

.tool-group {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--fill);
}

.tool-group__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: transparent;
  border: none;
  cursor: pointer;
  font: inherit;
  color: inherit;
  text-align: left;
}

.tool-group__head:hover {
  background: rgba(0, 0, 0, 0.04);
}

.tool-group__icon {
  flex-shrink: 0;
  font-size: 13px;
  opacity: 0.7;
}

.tool-group__title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: 12px;
  color: var(--text-secondary, #4b5563);
}

.tool-group__toggle {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-tertiary, #9ca3af);
}

.tool-group__body {
  border-top: 1px solid var(--line);
  padding: 10px;
}

.tool-group__actions {
  display: flex;
  gap: 8px;
  padding: 0 4px 8px;
}

.tool-group__act {
  padding: 3px 10px;
  font-size: 11px;
  line-height: 1.4;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary, #4b5563);
  cursor: pointer;
}

.tool-group__act:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.05);
}

.tool-group__act:disabled {
  opacity: 0.45;
  cursor: default;
}

.msg-charts {
  margin-bottom: 8px;
  max-width: min(920px, 100%);
}

.msg-files {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 8px;
}

.file-card {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 10px 12px;
  background: var(--fill);
  max-width: min(720px, 100%);
}

.file-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--muted);
}

.file-meta strong {
  color: var(--ink);
  font-size: 13px;
}

.file-actions {
  margin-top: 8px;
}

.file-btn {
  display: inline-flex;
  align-items: center;
  padding: 6px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink) 88%, transparent);
  color: var(--panel, #fff);
  text-decoration: none;
  font-size: 12px;
}

.file-btn:hover {
  filter: brightness(1.05);
}

.pdf-preview {
  margin-top: 10px;
  width: 100%;
  height: 420px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
}

/* 点击图片放大查看 */
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.74);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  animation: fade-in 0.2s ease both;
}

.lightbox img {
  max-width: 92vw;
  max-height: 86vh;
  object-fit: contain;
  border-radius: 14px;
  background: var(--panel);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55);
  animation: zoom-in 0.24s cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes zoom-in {
  from {
    opacity: 0;
    transform: scale(0.94);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

/* 粘贴图片/文件预览条 */
.image-preview {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 4px 2px;
}

.image-chip {
  position: relative;
  width: 64px;
  height: 64px;
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
  background: var(--panel);
}

.image-chip img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.file-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 180px;
  height: 34px;
  padding: 0 24px 0 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  font-size: 12px;
}

.file-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: color-mix(in srgb, var(--bg) 85%, transparent);
  color: var(--ink);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s ease;
}

.file-chip .image-remove {
  top: 50%;
  right: 4px;
  transform: translateY(-50%);
}

.image-remove:hover:not(:disabled) {
  background: var(--danger);
  color: #fff;
}

.image-remove:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 自动模型路由提示 */
.auto-model-notice {
  margin: 0 auto 10px;
  max-width: 620px;
  padding: 6px 12px;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, var(--line));
  border-radius: 999px;
  background: var(--panel);
  color: color-mix(in srgb, var(--ink) 45%, transparent);
  font-size: 12px;
  text-align: center;
  line-height: 1.5;
}

textarea {
  font-family: inherit;
  color: inherit;
}

@media (min-width: 900px) {
  .thread,
  .composer,
  .top {
    padding-left: 8vw;
    padding-right: 8vw;
  }

  .brand-mark {
    font-size: 24px;
  }
}

@media (max-width: 720px) {
  .top {
    gap: 8px;
    padding-top: calc(10px + var(--safe-top));
    padding-bottom: 10px;
  }

  .actions {
    gap: 6px;
  }

  .meta {
    display: none;
  }

  .brand-mark {
    font-size: 17px;
  }

  .thread {
    padding: 18px var(--pad) 16px;
    gap: 20px;
  }

  .msg {
    animation-duration: 0.25s;
  }

  .body {
    padding: 12px 14px;
  }

  .body-actions {
    opacity: 1;
    pointer-events: auto;
  }

  .composer {
    padding-top: 10px;
  }

  .composer-card {
    border-radius: 18px;
    padding: 4px 6px 4px 12px;
  }

  .composer-input {
    padding: 8px 2px 4px;
    font-size: 16px;
  }

  .composer-toolbar {
    flex-wrap: wrap;
  }

  .toolbar-right {
    order: 2;
  }

  .tool-btn {
    padding: 0;
    gap: 4px;
    width: 30px;
    height: 30px;
    border-radius: 9px;
  }

  .send-btn {
    width: 30px;
    height: 30px;
    border-radius: 10px;
  }

  /* 移动端：返回顶部按钮抬到输入框(composer)上方，避开底部安全区与键盘顶起时的遮挡 */
  .back-top-btn {
    bottom: calc(160px + var(--safe-bottom));
    right: 20px;
    width: 40px;
    height: 40px;
    z-index: 20;
    box-shadow: 0 3px 12px rgba(0, 0, 0, 0.14);
  }
}

/* 返回顶部按钮 */
.back-top-btn {
  position: fixed;
  bottom: 60px;
  right: 20px;
  z-index: 99;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--ink-2);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,.10);
  transition: background 0.15s, color 0.15s, transform 0.15s, box-shadow 0.15s;
}
.back-top-btn:hover {
  background: var(--ink);
  color: var(--surface);
  box-shadow: 0 4px 14px rgba(0,0,0,.18);
  transform: translateY(-2px);
}
.back-top-btn:active {
  transform: translateY(0) scale(0.92);
}

.back-top-enter-active,
.back-top-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}
.back-top-enter-from,
.back-top-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
