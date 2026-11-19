import { computed, nextTick, type Ref } from "vue";
import {
  createConversation,
  deleteConversation as apiDeleteConversation,
  fetchConversations,
  getApiErrorToken,
  patchConversation,
  reorderConversations,
  saveChatPreferences,
  type ConversationDto,
  type ConvSortMode,
  type StoredMessage,
} from "../../api";
import type { UiLocale } from "../../ui-locale";
import { localizeToken } from "../../localize";
import type { Bubble, ConvState } from "./chat-page-types";

type Tx = (zh: string, en: string, pt?: string, hi?: string) => string;

export interface ChatConversationShellOptions {
  // 每页实例状态（保持同一 ref / Map 实例，禁止解包）
  agentId: string;
  conversations: Ref<ConversationDto[]>;
  currentId: Ref<string>;
  states: Map<string, ConvState>;
  stateOf: (id: string) => ConvState;
  persistedCount: Map<string, number>;
  blank: ConvState;
  showArchived: Ref<boolean>;
  sortMode: Ref<ConvSortMode>;
  current: Readonly<Ref<ConvState>>;
  modelSwitchHint: Ref<string>;
  ctxMenu: Ref<{ open: boolean; x: number; y: number; targetId: string; taskId: string }>;
  ctxMenuEl: Ref<HTMLElement | null>;
  ctxConfirm: Ref<"" | "clear">;
  undoDelete: Ref<{ conv: ConversationDto; index: number; wasCurrent: boolean } | null>;

  // 文案 / 语言工具（根层/T1）
  uiLocale: Ref<UiLocale>;
  tx: Tx;

  // T0 返回值（快照组）
  messageTimes: (messages: Array<{ role: string; at?: number }>, createdAt?: number, updatedAt?: number) => number[];
  bubblesFromStored: (messages: StoredMessage[], times: number[]) => Bubble[];
  toStored: (list: Bubble[]) => StoredMessage[];
  upgradeConversationDetail: (convId: string) => Promise<void>;
  syncOpenConversation: (convId: string) => Promise<void>;
  syncConvLocal: (convId: string, patch: Partial<ConversationDto>) => void;

  // T1 返回值
  applyConversationLocale: (locale: string | undefined) => void;
  queueScroll: (force?: boolean) => void;
  showSettingsError: (message: string) => void;
  isLocale: (locale: unknown) => locale is UiLocale;

  // 跨组回调（定义在注入点之后，统一箭头/getter 注入，消解 TDZ）
  closeTaskForm: () => void;
  showTaskForm: Ref<boolean>;
  showTaskList: Ref<boolean>;
  sidebarOpen: Ref<boolean>;
  loadTasks: () => Promise<void>;
  watchBackgroundDone: (convId: string) => void;
  reportActiveConversation: (conv: ConversationDto) => void;
  clearTaskUnread: (convId: string) => void;
  loadMcp: (convId: string) => void;
  loadSkills: (convId: string) => void;
  boundMcpIds: () => string[];
  draftSendMode: () => "preempt" | "queue";
}

/**
 * 会话壳：列表排序 / 会话动作 / 右键菜单 / 删除撤销（SCC A 核心）。
 * 机械搬迁自 useChatPageCore；每页实例状态与跨组函数只通过 options 注入引用/回调，行为零变化。
 */
export function useChatConversationShell(options: ChatConversationShellOptions) {
  const {
    agentId,
    conversations,
    currentId,
    states,
    stateOf,
    persistedCount,
    blank,
    showArchived,
    sortMode,
    current,
    modelSwitchHint,
    ctxMenu,
    ctxMenuEl,
    ctxConfirm,
    undoDelete,
    uiLocale,
    tx,
    messageTimes,
    bubblesFromStored,
    toStored,
    upgradeConversationDetail,
    syncOpenConversation,
    syncConvLocal,
    applyConversationLocale,
    queueScroll,
    showSettingsError,
    isLocale,
    closeTaskForm,
    showTaskForm,
    showTaskList,
    sidebarOpen,
    loadTasks,
    watchBackgroundDone,
    reportActiveConversation,
    clearTaskUnread,
    loadMcp,
    loadSkills,
    boundMcpIds,
    draftSendMode,
  } = options;

  // ---- 列表排序 ----
  /** 手动顺序步长（须与服务端 `ORDER_STEP` 一致）：相邻项间隔，便于中间插入。 */
  const CONV_ORDER_STEP = 1000;

  /** 排序规则：归档组末、置顶组上、manual 先按手动序，其余按最近活动。 */
  function convRank(a: ConversationDto, b: ConversationDto): number {
    const aa = a.archived ? 1 : 0;
    const ba = b.archived ? 1 : 0;
    if (aa !== ba) return aa - ba;
    const ap = a.pinnedAt ? 1 : 0;
    const bp = b.pinnedAt ? 1 : 0;
    if (ap !== bp) return bp - ap;
    if (sortMode.value === "manual") {
      const ao = a.sortOrder ?? Number.POSITIVE_INFINITY;
      const bo = b.sortOrder ?? Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao - bo;
    }
    if (ap && bp) return (b.pinnedAt || 0) - (a.pinnedAt || 0);
    return b.updatedAt - a.updatedAt;
  }

  /** 本地按同一套规则重排：乐观更新后立刻反映到侧栏，不等服务端回包。 */
  function resortConversations() {
    conversations.value = [...conversations.value].sort(convRank);
  }

  /** 不改归档开关、不打断当前对话的侧栏刷新（只同步 running / 标题等）。 */
  async function refreshConversationsQuiet() {
    const list = await fetchConversations(showArchived.value, agentId).catch(() => null);
    if (!list) return;
    const pendingDeleted = undoDelete.value?.conv.id;
    const next = pendingDeleted ? list.filter((c) => c.id !== pendingDeleted) : list;
    const alive = new Set(next.map((c) => c.id));
    const beforeIds = conversations.value.map((c) => c.id).join("\0");
    // 别处删掉的对话从侧栏去掉。当前这条若刚创建、列表还没带回，先留着。
    conversations.value = conversations.value.filter((c) => alive.has(c.id) || c.id === currentId.value);
    const byId = new Map(next.map((c) => [c.id, c]));
    conversations.value = conversations.value.map((c) => {
      const fresh = byId.get(c.id);
      return fresh ? { ...c, ...fresh } : c;
    });
    for (const c of next) {
      if (!conversations.value.some((x) => x.id === c.id)) conversations.value.push(c);
    }
    const afterIds = conversations.value.map((c) => c.id).join("\0");
    if (afterIds !== beforeIds) resortConversations();
  }

  /** 重新拉取侧栏列表（切换「显示归档」时调用）。 */
  async function reloadConversations() {
    void saveChatPreferences({ showArchived: showArchived.value }).catch(() => undefined);
    const list = await fetchConversations(showArchived.value, agentId).catch(() => null);
    if (!list) return;
    const pendingDeleted = undoDelete.value?.conv.id;
    conversations.value = pendingDeleted ? list.filter((c) => c.id !== pendingDeleted) : list;
    resortConversations();
  }

  /** 把 `fromId` 移动到 `targetId` 前 / 后，并按新顺序整体固化（拖拽与 `Alt+↑/↓` 共用）。 */
  async function applyConversationOrder(
    fromId: string,
    targetId: string,
    after: boolean,
    pinOverride?: number | null,
  ) {
    if (fromId === targetId) return;
    const prevOrder = conversations.value;
    const prevMode = sortMode.value;
    const moved = prevOrder.find((c) => c.id === fromId);
    if (!moved) return;
    const nextList = prevOrder.filter((c) => c.id !== fromId);
    const anchor = nextList.findIndex((c) => c.id === targetId);
    if (anchor < 0) return;
    const movedNext: ConversationDto = pinOverride === undefined ? moved : { ...moved, pinnedAt: pinOverride };
    nextList.splice(after ? anchor + 1 : anchor, 0, movedNext);
    sortMode.value = "manual";
    conversations.value = nextList.map((c, i) => ({ ...c, sortOrder: i * CONV_ORDER_STEP }));
    resortConversations();
    try {
      if (pinOverride !== undefined) await patchConversation(fromId, { pinnedAt: pinOverride });
      await reorderConversations(conversations.value.map((c) => c.id));
      if (prevMode !== "manual") void saveChatPreferences({ convSortMode: "manual" }).catch(() => undefined);
    } catch (err) {
      sortMode.value = prevMode;
      conversations.value = await fetchConversations(false, agentId).catch(() => prevOrder);
      resortConversations();
      showSettingsError(
        localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("排序失败", "Reorder failed", "Falha ao reordenar", "क्रम बदलने में विफल")),
      );
    }
  }

  /** 退出手动排序：普通区恢复「最近活动」自动上浮。 */
  function restoreRecentSort() {
    closeCtxMenu();
    sortMode.value = "recent";
    resortConversations();
    void saveChatPreferences({ convSortMode: "recent" }).catch(() => undefined);
  }

  // ---- 会话动作 ----
  /** 切换对话：只改指针，不 abort、不覆盖任何已存在的运行时状态（后台流继续跑）。 */
  function selectConversation(conv: ConversationDto) {
    if (showTaskForm.value) closeTaskForm();
    showTaskList.value = false;
    const state = stateOf(conv.id);
    const leaving = currentId.value;
    if (leaving && leaving !== conv.id) {
      modelSwitchHint.value = "";
      const leavingState = states.get(leaving);
      if (leavingState?.sending || (leavingState?.controllers?.length ?? 0) > 0) watchBackgroundDone(leaving);
    }
    currentId.value = conv.id;
    sidebarOpen.value = false;
    reportActiveConversation(conv);
    clearTaskUnread(conv.id);
    // 仅首次载入时用服务端快照建气泡；已有气泡说明本地状态更新（可能正在流式），不能覆盖。
    if (!state.bubbles.length || state.bubbles.some((bubble) => !bubble.at)) {
      const times = messageTimes(conv.messages || [], conv.createdAt, conv.updatedAt);
      if (!state.bubbles.length) {
        state.bubbles = bubblesFromStored(conv.messages || [], times);
        if (!persistedCount.has(conv.id)) persistedCount.set(conv.id, toStored(state.bubbles).length);
        void upgradeConversationDetail(conv.id);
      } else if (state.bubbles.length === times.length) {
        state.bubbles.forEach((bubble, index) => {
          if (!bubble.at) bubble.at = times[index];
        });
      }
    }
    state.settings.modelId = conv.model || "";
    state.settings.mcpEnabled = conv.mcpServers || [];
    state.settings.skillsEnabled = conv.skillsEnabled || [];
    state.settings.locale = isLocale(conv.locale) ? conv.locale : "";
    state.queue = conv.pendingQueue || [];
    applyConversationLocale(state.settings.locale);
    void loadMcp(conv.id);
    void loadSkills(conv.id);
    queueScroll(true);
    void syncOpenConversation(conv.id);
  }

  /** 新建对话 = 进入草稿态。 */
  function newConversation() {
    if (showTaskForm.value) closeTaskForm();
    showTaskList.value = false;
    const leaving = currentId.value;
    if (leaving) {
      const leavingState = states.get(leaving);
      if (leavingState?.sending || (leavingState?.controllers?.length ?? 0) > 0) watchBackgroundDone(leaving);
    }
    currentId.value = "";
    blank.settings.mcpEnabled = [];
    blank.settings.skillsEnabled = [];
    blank.settings.modelId = "";
    blank.pendingImages = [];
    blank.pendingDocs = [];
    sidebarOpen.value = false;
    queueScroll(true);
  }

  /** 草稿态首条消息 → 此刻才真正创建会话。 */
  async function createConvFromDraft(firstText: string): Promise<string> {
    const draft = current.value;
    const collapsed = firstText.replace(/\s+/g, " ").trim();
    const fallback = tx("新对话", "New chat", "Nova conversa", "नई चैट");
    const title = collapsed ? (collapsed.length > 30 ? `${collapsed.slice(0, 30)}…` : collapsed) : fallback;
    let conv: ConversationDto;
    try {
      conv = await createConversation({ title, agentId: agentId });
    } catch (err) {
      draft.error = localizeToken(
        uiLocale.value,
        getApiErrorToken(err),
        (err as Error)?.message || tx("对话创建失败", "Failed to create conversation", "Falha ao criar conversa", "बातचीत बनाने में विफल"),
      );
      return "";
    }
    conversations.value = [conv, ...conversations.value.filter((c) => c.id !== conv.id)];
    resortConversations();
    if (sortMode.value === "manual") {
      const firstRegular = conversations.value.find((c) => !c.pinnedAt && c.id !== conv.id);
      if (firstRegular) void applyConversationOrder(conv.id, firstRegular.id, false);
    }
    const st = stateOf(conv.id);
    st.settings = { ...draft.settings, locale: uiLocale.value };
    currentId.value = conv.id;
    reportActiveConversation(conv);
    const patch: { locale?: string; model?: string; mcpServers?: string[]; skillsEnabled?: string[]; sendMode?: "preempt" | "queue" } = {
      locale: st.settings.locale,
    };
    if (draftSendMode() === "queue") patch.sendMode = "queue";
    if (st.settings.modelId) patch.model = st.settings.modelId;
    const mcpEnabled = [...new Set([...boundMcpIds(), ...st.settings.mcpEnabled])];
    st.settings.mcpEnabled = mcpEnabled;
    if (mcpEnabled.length) patch.mcpServers = mcpEnabled;
    if (st.settings.skillsEnabled.length) patch.skillsEnabled = [...st.settings.skillsEnabled];
    try {
      await patchConversation(conv.id, patch);
      syncConvLocal(conv.id, patch);
    } catch {
      /* 落库失败不阻断发送 */
    }
    void loadMcp(conv.id);
    void loadSkills(conv.id);
    return conv.id;
  }

  // ---- 右键菜单 ----
  let ctxTriggerEl: HTMLElement | null = null;
  const ctxTarget = computed(() => conversations.value.find((c) => c.id === ctxMenu.value.targetId) || null);

  function ctxAnchorPos(e: MouseEvent): { x: number; y: number } {
    const itemRect = ctxTriggerEl?.getBoundingClientRect();
    const keyboardTriggered = !e.clientX && !e.clientY && !!itemRect;
    return {
      x: keyboardTriggered && itemRect ? itemRect.left + 12 : e.clientX,
      y: keyboardTriggered && itemRect ? itemRect.bottom : e.clientY,
    };
  }

  async function placeCtxMenu(anchor: { x: number; y: number }) {
    await nextTick();
    const el = ctxMenuEl.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let { x, y } = ctxMenu.value;
    if (x + rect.width + pad > window.innerWidth) x = Math.max(pad, anchor.x - rect.width);
    if (y + rect.height + pad > window.innerHeight) y = Math.max(pad, anchor.y - rect.height);
    ctxMenu.value = { ...ctxMenu.value, x, y };
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }

  async function openCtxMenu(e: MouseEvent, conv: ConversationDto) {
    e.preventDefault();
    e.stopPropagation();
    ctxTriggerEl = (e.currentTarget as HTMLElement | null) || null;
    const anchor = ctxAnchorPos(e);
    ctxMenu.value = { open: true, x: anchor.x, y: anchor.y, targetId: conv.id, taskId: "" };
    await placeCtxMenu(anchor);
  }

  async function openTaskCtxMenu(e: MouseEvent, task: { id: string }) {
    e.preventDefault();
    e.stopPropagation();
    ctxTriggerEl = (e.currentTarget as HTMLElement | null) || null;
    const anchor = ctxAnchorPos(e);
    ctxMenu.value = { open: true, x: anchor.x, y: anchor.y, targetId: "", taskId: task.id };
    await placeCtxMenu(anchor);
  }

  function closeCtxMenu(restoreFocus = false) {
    if (!ctxMenu.value.open) return;
    ctxMenu.value = { ...ctxMenu.value, open: false };
    ctxConfirm.value = "";
    if (restoreFocus) ctxTriggerEl?.focus();
    ctxTriggerEl = null;
  }

  async function armCtxConfirm(kind: "clear") {
    ctxConfirm.value = kind;
    await nextTick();
    ctxMenuEl.value?.querySelector<HTMLElement>("[data-ctx-confirm]")?.focus();
  }

  // ---- 删除撤销 ----
  const UNDO_DELETE_MS = 5000;
  let undoDeleteTimer: ReturnType<typeof setTimeout> | null = null;

  /** 服务端落库删除并立即刷新任务列表。 */
  async function deleteConversationOnServer(id: string) {
    try {
      await apiDeleteConversation(id);
      persistedCount.delete(id);
      await loadTasks();
    } catch {
      /* 删除失败不打断交互 */
    }
  }

  /** 把上一笔待删会话真正落库（新删除到来 / 撤销窗口结束 / 离开页面时调用）。 */
  function flushPendingDelete() {
    if (undoDeleteTimer) {
      clearTimeout(undoDeleteTimer);
      undoDeleteTimer = null;
    }
    const pending = undoDelete.value;
    undoDelete.value = null;
    if (pending) void deleteConversationOnServer(pending.conv.id);
  }

  /** 登记一笔待删会话并启动撤销倒计时。 */
  function scheduleUndoDelete(conv: ConversationDto, index: number, wasCurrent: boolean) {
    flushPendingDelete();
    undoDelete.value = { conv, index, wasCurrent };
    undoDeleteTimer = setTimeout(() => {
      undoDeleteTimer = null;
      const pending = undoDelete.value;
      undoDelete.value = null;
      if (pending) void deleteConversationOnServer(pending.conv.id);
    }, UNDO_DELETE_MS);
  }

  async function removeConversation(id: string) {
    closeCtxMenu();
    const index = conversations.value.findIndex((c) => c.id === id);
    const conv = conversations.value[index];
    if (!conv) return;
    const wasCurrent = currentId.value === id;
    states.get(id)?.controllers?.forEach((c) => c.abort());
    states.delete(id);
    conversations.value = conversations.value.filter((c) => c.id !== id);
    scheduleUndoDelete(conv, index, wasCurrent);
    if (wasCurrent) {
      const next = conversations.value[0];
      if (next) selectConversation(next);
      else await newConversation();
    }
  }

  /** 撤销最近一次删除：放回原位置（服务端尚未删除，无需重建）。 */
  function undoRemoveConversation() {
    if (undoDeleteTimer) {
      clearTimeout(undoDeleteTimer);
      undoDeleteTimer = null;
    }
    const pending = undoDelete.value;
    undoDelete.value = null;
    if (!pending) return;
    const next = [...conversations.value];
    next.splice(Math.max(0, Math.min(pending.index, next.length)), 0, pending.conv);
    conversations.value = next;
    resortConversations();
    if (pending.wasCurrent) selectConversation(pending.conv);
  }

  return {
    CONV_ORDER_STEP,
    convRank,
    resortConversations,
    refreshConversationsQuiet,
    reloadConversations,
    applyConversationOrder,
    restoreRecentSort,
    selectConversation,
    newConversation,
    createConvFromDraft,
    ctxTarget,
    ctxAnchorPos,
    placeCtxMenu,
    openCtxMenu,
    openTaskCtxMenu,
    closeCtxMenu,
    armCtxConfirm,
    deleteConversationOnServer,
    flushPendingDelete,
    scheduleUndoDelete,
    removeConversation,
    undoRemoveConversation,
  };
}
