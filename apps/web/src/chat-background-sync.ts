import type { Ref } from "vue";
import type { Bubble, Conversation } from "./chat-storage";

export function createBackgroundTaskSync(args: {
  me: Ref<unknown>;
  conversations: Ref<Conversation[]>;
  activeId: Ref<string>;
  sending: Ref<boolean>;
  activeController: Ref<AbortController | null>;
  fetchTaskStatus: () => Promise<{ running?: { userText: string } | null; last?: { settled?: boolean } | null }>;
  restoreConversations: () => Promise<void>;
  scrollBottom: () => Promise<void>;
  nextBubbleId: () => number;
  backgroundStatusText: () => string;
}) {
  let taskStatusTimer: ReturnType<typeof setTimeout> | null = null;

  function stopTaskStatusPolling() {
    if (!taskStatusTimer) return;
    clearTimeout(taskStatusTimer);
    taskStatusTimer = null;
  }

  function scheduleTaskStatusPoll(delayMs = 1200) {
    stopTaskStatusPolling();
    taskStatusTimer = setTimeout(() => {
      void syncBackgroundTaskStatus();
    }, delayMs);
  }

  function findLastUserMessage(conv: Conversation): Bubble | undefined {
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i]?.role === "user") return conv.messages[i];
    }
    return undefined;
  }

  function ensureBackgroundAssistant(conv: Conversation, userText: string) {
    const last = conv.messages[conv.messages.length - 1];
    if (last?.role === "assistant" && !last.finished && !last.cancelled && !last.error) {
      last.status = args.backgroundStatusText();
      last.toolActive = true;
      last.currentTool = undefined;
      last.finished = false;
      return;
    }
    const lastUser = findLastUserMessage(conv);
    if (!lastUser || lastUser.text !== userText) return;
    conv.messages.push({
      id: args.nextBubbleId(),
      role: "assistant",
      text: "",
      status: args.backgroundStatusText(),
      toolActive: true,
      currentTool: undefined,
      toolStep: 0,
      finished: false,
    });
  }

  async function syncBackgroundTaskStatus() {
    stopTaskStatusPolling();
    if (!args.me.value) return;
    try {
      const status = await args.fetchTaskStatus();
      const active = args.conversations.value.find((c) => c.id === args.activeId.value);
      if (status.running) {
        if (active) {
          ensureBackgroundAssistant(active, status.running.userText);
          active.updatedAt = Date.now();
        }
        if (!args.activeController.value) args.sending.value = true;
        scheduleTaskStatusPoll();
        return;
      }
      if (!args.activeController.value) args.sending.value = false;
      if (status.last?.settled) {
        await args.restoreConversations();
        await args.scrollBottom();
      }
    } catch {
      /* ignore task status failures */
    }
  }

  return {
    stopTaskStatusPolling,
    scheduleTaskStatusPoll,
    syncBackgroundTaskStatus,
  };
}
