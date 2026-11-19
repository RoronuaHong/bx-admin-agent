import type { Ref } from "vue";
import type { ArtifactSpec, TodoItem } from "@bx/shared";
import { dedupeRepeats } from "../../chat-stream";
import type { ToolStep } from "../../chat-types";
import {
  fetchChatTaskStatus,
  fetchConversation,
  saveConversationMessages,
  type ChartSpec,
  type ConversationDto,
  type StoredMessage,
} from "../../api";
import type { Bubble, ConvState } from "./chat-page-types";

export interface ChatPersistenceOptions {
  states: Map<string, ConvState>;
  currentId: Ref<string>;
  conversations: Ref<ConversationDto[]>;
  persistedCount: Map<string, number>;
  nextSeq: () => number;
  atBottomNow: () => boolean;
  queueScroll: (force?: boolean) => void;
  ensureRunPrompt: (state: ConvState, userText: string, startedAt: number) => void;
  attachRunningTask: (convId: string) => Promise<void>;
  messageTimes: (
    messages: Array<{ role: string; at?: number }>,
    createdAt?: number,
    updatedAt?: number,
  ) => number[];
}

export function useChatPersistence(options: ChatPersistenceOptions) {
  const {
    states,
    currentId,
    conversations,
    persistedCount,
    nextSeq,
    atBottomNow,
    queueScroll,
    ensureRunPrompt,
    attachRunningTask,
    messageTimes,
  } = options;

  let conversationSyncing = false;
  let pendingSyncId = "";

  /** 读取快照里的图表 spec（兼容旧的单张 chart 字段：并入 charts）。 */
  function chartsOf(m: StoredMessage): ChartSpec[] {
    const list = Array.isArray(m.charts) ? m.charts : [];
    return m.chart ? [...list, m.chart] : list;
  }

  /**
   * 快照的状态归一：**快照里不存在「正在跑」**。
   * 落库与恢复都过这一遍——终态没收到的步骤（连接被切断 / 服务进程重启）若以 running 存进库，
   * 刷新后会被当成实时状态永久转圈（用户看到的「卡住」就是这个）。宁可如实记中断，也不冒充仍在执行。
   */
  function settleStep(step: ToolStep): ToolStep {
    return step.status === "running" ? { ...step, status: "interrupted" } : step;
  }

  /** 与服务端快照窗口一致：只有最近一段带回思考和工具原文。 */
  const SNAPSHOT_DETAIL_TAIL = 40;
  const SNAPSHOT_THINKING_CAP = 8_000;
  const SNAPSHOT_STEP_RESULT_CAP = 4_000;

  function capTail(text: string, max: number): string {
    if (text.length <= max) return text;
    return `…\n${text.slice(text.length - max)}`;
  }

  function toStored(list: Bubble[]): StoredMessage[] {
    const kept = list.filter(
      (b): b is Bubble & { role: "user" | "assistant" } =>
        b.role !== "notice" && !!(b.text || b.images?.length || b.charts?.length || b.artifacts?.length),
    );
    const detailFrom = Math.max(0, kept.length - SNAPSHOT_DETAIL_TAIL);
    return kept.map((b, index) => {
      const keepDetail = index >= detailFrom;
      const steps = b.steps?.map(settleStep);
      return {
        role: b.role,
        text: b.text,
        ...(b.at ? { at: b.at } : {}),
        images: b.images,
        ...(keepDetail && b.thinking ? { thinking: capTail(b.thinking, SNAPSHOT_THINKING_CAP) } : {}),
        ...(b.thinkMs ? { thinkMs: b.thinkMs } : {}),
        ...(steps?.length
          ? {
              steps: keepDetail
                ? steps.map((step) => ({
                    ...step,
                    ...(step.result ? { result: capTail(step.result, SNAPSHOT_STEP_RESULT_CAP) } : {}),
                    ...(step.args ? { args: capTail(step.args, 400) } : {}),
                  }))
                : steps.map((step) => ({ id: step.id, name: step.name, server: step.server, status: step.status })),
            }
          : {}),
        ...(b.todos?.length ? { todos: b.todos } : {}),
        ...(b.charts?.length ? { charts: b.charts } : {}),
        ...(b.artifacts?.length ? { artifacts: b.artifacts } : {}),
        ...(b.supportLabels ? { supportLabels: b.supportLabels } : {}),
      };
    });
  }

  function bubblesFromStored(messages: StoredMessage[], times: number[]): Bubble[] {
    return messages.map((m, i) => ({
      id: nextSeq(),
      role: m.role,
      at: times[i],
      text: m.role === "assistant" ? dedupeRepeats(m.text || "") : (m.text || ""),
      images: m.images,
      ...(m.thinking ? { thinking: m.thinking } : {}),
      ...(m.thinkMs ? { thinkMs: m.thinkMs } : {}),
      ...(Array.isArray(m.steps) && m.steps.length ? { steps: (m.steps as ToolStep[]).map(settleStep) } : {}),
      ...(Array.isArray(m.todos) && m.todos.length ? { todos: m.todos as TodoItem[] } : {}),
      ...(chartsOf(m).length ? { charts: chartsOf(m) } : {}),
      ...(Array.isArray(m.artifacts) && m.artifacts.length ? { artifacts: m.artifacts as ArtifactSpec[] } : {}),
      ...(m.supportLabels ? { supportLabels: m.supportLabels } : {}),
    }));
  }

  /** 列表快照没有推理细节。打开对话后补最近一段，生成中的气泡不被覆盖。 */
  async function upgradeConversationDetail(convId: string) {
    const full = await fetchConversation(convId).catch(() => null);
    if (!full) return;
    applyServerThread(convId, full, true);
  }

  /**
   * 把服务端快照铺进这个对话。正在发送或流式输出时不覆盖。
   * 本地更新、或条数更多时也不覆盖，避免刚生成的这一轮被旧快照抹掉。
   * force 只用于第一次打开：补上列表快照里没有的推理细节。
   */
  function applyServerThread(convId: string, full: ConversationDto, force: boolean) {
    const state = states.get(convId);
    if (!state || state.sending || state.bubbles.some((b) => b.streaming)) return;
    const serverMessages = full.messages || [];
    if (!force && !serverThreadAhead(state.bubbles, serverMessages)) return;
    // 先量「用户本来贴不贴底部」：内容一多 scrollHeight 就变高，此刻再量已被自己长出来的高度推翻。
    const wasAtBottom = convId === currentId.value && atBottomNow();
    const times = messageTimes(serverMessages, full.createdAt, full.updatedAt);
    const notices = state.bubbles.filter((bubble) => bubble.role === "notice");
    state.bubbles = [...bubblesFromStored(serverMessages, times), ...notices];
    persistedCount.set(convId, toStored(state.bubbles).length);
    // 强制回底：forced 跳过 queueScroll 里两道「还在底部吗」的复核。
    // 用户本来就在底部时，新回复必须自己滚进视野——否则「停在页面上看着」就永远看不到它。
    if (wasAtBottom) queueScroll(true);
  }

  function tailSig(
    item:
      | {
          text?: string;
          charts?: unknown[];
          artifacts?: unknown[];
          steps?: unknown[];
          todos?: unknown[];
        }
      | undefined,
  ): string {
    if (!item) return "";
    const steps = ((item.steps as Array<{ status?: string }>) || []).map((step) => step.status || "").join(",");
    const todos = ((item.todos as Array<{ status?: string }>) || []).map((todo) => todo.status || "").join(",");
    return `${item.text?.length || 0}|${item.charts?.length || 0}|${item.artifacts?.length || 0}|${steps}|${todos}`;
  }

  function serverThreadAhead(local: Bubble[], server: StoredMessage[]): boolean {
    const messages = local.filter((bubble) => bubble.role !== "notice");
    if (server.length > messages.length) return true;
    if (server.length < messages.length) return false;
    const lb = messages[messages.length - 1];
    const sb = server[server.length - 1];
    if ((lb?.text?.length || 0) > (sb?.text?.length || 0)) return false;
    return tailSig(lb) !== tailSig(sb);
  }

  /** 当前打开的对话：还在跑就接上事件流，已经写完就补上新消息。 */
  async function syncOpenConversation(convId: string) {
    if (!convId) return;
    if (conversationSyncing) {
      pendingSyncId = convId;
      return;
    }
    const state = states.get(convId);
    if (!state) return;
    conversationSyncing = true;
    try {
      const status = await fetchChatTaskStatus(convId).catch(() => null);
      // 正在跟流时不能整段覆盖，但本期提问必须在场：定时任务每期正文相同，不能拿上一期那条充数。
      if (state.sending || state.bubbles.some((b) => b.streaming)) {
        if (status?.running) ensureRunPrompt(state, status.task?.userText || "", status.task?.startedAt || 0);
        return;
      }
      if (status?.running) {
        await attachRunningTask(convId);
        return;
      }
      const full = await fetchConversation(convId).catch(() => null);
      if (full) applyServerThread(convId, full, false);
    } finally {
      conversationSyncing = false;
      const next = pendingSyncId;
      pendingSyncId = "";
      if (next && next !== convId) void syncOpenConversation(next);
    }
  }

  /**
   * 在途落库登记（清空对话竞态）：runTurn finally 先把 sending 归零、再 await persist，
   * 这段窗口里「清空」守卫看到 sending=false 就放行，但落库请求还在飞，后到会把已清的消息写回。
   * 清空动作先 await 这里的 Promise，确保落库全部结束后再发 /clear。
   */
  const pendingPersists = new Map<string, Promise<unknown>>();
  /** 每对话的落库串行链：多 run 收束时写请求 + persistedCount 水位必须按序，否则慢请求晚到覆盖新快照。 */
  const persistChains = new Map<string, Promise<unknown>>();
  async function waitPendingPersists(convId: string): Promise<void> {
    await pendingPersists.get(convId)?.catch(() => undefined);
  }

  function persist(convId: string, list: Bubble[], forceFull = false): Promise<void> {
    if (!convId) return Promise.resolve();
    // 串行化：本轮写排在上一个之后。快照 list 在调用时已取好，排队期间其它 run 的增量写不会互相覆盖。
    const prevChain = persistChains.get(convId) || Promise.resolve();
    const task = prevChain.catch(() => undefined).then(() => persistNow(convId, list, forceFull));
    persistChains.set(convId, task);
    void task.finally(() => {
      if (persistChains.get(convId) === task) persistChains.delete(convId);
    });
    pendingPersists.set(convId, task);
    void task.finally(() => {
      if (pendingPersists.get(convId) === task) pendingPersists.delete(convId);
    });
    return task;
  }

  async function persistNow(convId: string, list: Bubble[], forceFull = false) {
    const stored = toStored(list);
    const title = list.find((b) => b.role === "user" && b.text)?.text.slice(0, 24) || undefined;
    // 本会话首次落库该对话时，用服务端快照长度当基线（避免把整段历史重新全量上传）。
    const serverLen = conversations.value.find((c) => c.id === convId)?.messages?.length ?? 0;
    const prev = persistedCount.get(convId) ?? serverLen;
    try {
      if (forceFull) {
        // 并发多 run 抢占：增量水位假设「同一时刻只有一条 reply 在流式更新」，并发下被打破——
        // 先收束者把水位推到「含对方半截」，后收束者若只回写末条，中间项 reply 的终态就永远落不库。
        // 全量写以本地 bubbles（UI 真相源）覆盖服务端，顺带清掉增量竞态写出的半截/重复；并发归零后恢复增量。
        await saveConversationMessages(convId, stored, { title, full: true });
      } else if (stored.length < prev) {
        // 长度回退（如清空对话）：全量替换。
        await saveConversationMessages(convId, stored, { title, full: true });
      } else if (stored.length === prev) {
        if (prev > 0) {
          // 没有新增消息，只可能是「最后一条正在流式更新」→ 只回写最后一条（base=prev-1 触发服务端原地替换）。
          await saveConversationMessages(convId, [stored[prev - 1]!], { title, base: prev - 1 });
        } else if (title) {
          await saveConversationMessages(convId, [], { title, base: 0 });
        }
      } else {
        // 有新增消息：只回写尾部增量（base=prev）。
        await saveConversationMessages(convId, stored.slice(prev), { title, base: prev });
      }
      persistedCount.set(convId, stored.length);
      if (title) {
        conversations.value = conversations.value.map((c) => (c.id === convId ? { ...c, title } : c));
      }
    } catch {
      /* 保存失败不打断对话（下次变更会重试增量回写） */
    }
  }

  return {
    conversationSyncing,
    pendingSyncId,
    chartsOf,
    settleStep,
    SNAPSHOT_DETAIL_TAIL,
    SNAPSHOT_THINKING_CAP,
    SNAPSHOT_STEP_RESULT_CAP,
    capTail,
    toStored,
    bubblesFromStored,
    upgradeConversationDetail,
    applyServerThread,
    tailSig,
    serverThreadAhead,
    syncOpenConversation,
    pendingPersists,
    persistChains,
    waitPendingPersists,
    persist,
    persistNow,
  };
}
