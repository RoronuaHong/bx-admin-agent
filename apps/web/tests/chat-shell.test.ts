import { beforeEach, describe, expect, it, vi } from "vitest";

// useChatPageCore 在 node 环境实例化的依赖打桩：
// - 生命周期（onMounted/onBeforeUnmount/watch）置空，避免 bootstrap 网络与定时器副作用；
// - 浏览器 DOM 相关模块（DOMPurify/theme/pinyin）置空；
// - api 全量 noop，仅覆盖本测试关心的返回值。
vi.mock("vue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue")>();
  return {
    ...actual,
    onMounted: () => undefined,
    onBeforeUnmount: () => undefined,
    watch: () => () => undefined,
  };
});
vi.mock("vue-router", () => ({
  useRouter: () => ({ push: () => undefined, currentRoute: { value: { query: {} } } }),
}));
vi.mock("../src/chat-richtext", () => ({ renderChatMarkdown: () => "" }));
vi.mock("../src/theme", () => ({
  readStoredTheme: () => "dark",
  useTheme: () => ({ theme: { value: "dark" }, setTheme: () => undefined }),
}));
vi.mock("../src/pinyin", () => ({
  matchesFuzzyScoped: () => false,
  matchesFuzzy: () => false,
  loadPinyin: () => undefined,
  pinyinReady: { value: true },
}));
vi.mock("../src/api", () => {
  const runtimeExports = `addMemoryItem ApiError cancelChatTask cancelSubagent clearConversation clearConversationContext confirmToolCall conversationExportUrl createChatSchedule createConversation createSkill deleteChatSchedule deleteConversation deleteCustomMcpServer deleteMcpServer deleteNotifyChannel deleteSkill dequeueConversationMessage duplicateConversation enqueueConversationMessage fetchChatMcpServers fetchChatPreferences fetchChatSkills fetchChatTaskStatus fetchConversation fetchConversations fetchMcpServers fetchMemory fetchModels fetchNotifyChannels fetchSchedules fetchSkillCatalog fetchSkillDocument fetchTraceRuns fetchWorkspaceFiles getApiErrorCode getApiErrorToken importSkillFile isChatTaskRunning patchChatSchedule patchConversation readWorkspaceFile reloadMcpServer removeMemoryItem reorderConversations restartChatSchedule resumeChatTaskEvents runChatSchedule saveChatPreferences saveConversationMessages saveCustomMcpServer saveMcpServer saveNotifyChannel setChatMcpServers setChatSkills setSkillEnabled streamChat testNotifyChannel updateSkill uploadFiles workspaceDownloadUrl`.split(" ");
  // 默认返回 resolved Promise：大量调用点是 void fn().catch(...)，返回 undefined 会触发 unhandled rejection
  const mock: Record<string, unknown> = Object.fromEntries(runtimeExports.map((k) => [k, async () => undefined]));
  Object.assign(mock, {
    MODEL_AUTO_ID: "auto",
    NOT_MODEL_FAULT_CODES: [],
    fetchConversations: async () => [],
    fetchChatTaskStatus: async () => null,
    fetchConversation: async () => null,
    fetchModels: async () => [],
    saveConversationMessages: async () => undefined,
    reorderConversations: async () => undefined,
    saveChatPreferences: async () => undefined,
    patchConversation: async () => undefined,
    createConversation: async () => ({ id: "new", title: "新对话", messages: [] }),
    deleteConversation: async () => undefined,
    getApiErrorToken: () => "",
  });
  return mock;
});

import { useChatPageCore } from "../src/composables/chat/useChatPageCore";
import type { ConversationDto } from "../src/api";

type Core = ReturnType<typeof useChatPageCore>;

function conv(id: string, overrides: Partial<ConversationDto> = {}): ConversationDto {
  return {
    id,
    title: `对话 ${id}`,
    messages: [],
    model: "",
    mcpServers: [],
    skillsEnabled: [],
    pendingQueue: [],
    pinnedAt: 0,
    sortOrder: 0,
    archived: false,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  } as unknown as ConversationDto;
}

function makeCore(): Core {
  return useChatPageCore({
    agentProps: { agentId: "generic" },
    router: { push: () => undefined, currentRoute: { value: { query: {} } } } as never,
  });
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined }));
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
});

describe("T2 会话壳特征测试（拆分前锁定当前真实行为）", () => {
  it("selectConversation：首次打开用服务端快照建气泡并灌入设置", () => {
    const core = makeCore();
    const target = conv("c1", {
      messages: [
        { role: "user", text: "你好", at: 1000 },
        { role: "assistant", text: "你好！", at: 1100 },
      ],
      model: "m1",
      mcpServers: ["srv-a"],
    });
    core.conversations.value = [target];
    core.selectConversation(target);
    expect(core.currentId.value).toBe("c1");
    const state = core.states.get("c1");
    expect(state).toBeDefined();
    expect(state!.bubbles.length).toBe(2);
    expect(state!.bubbles[0]!.text).toBe("你好");
    expect(state!.settings.modelId).toBe("m1");
    expect(state!.settings.mcpEnabled).toEqual(["srv-a"]);
  });

  it("selectConversation：已有气泡不被服务端快照覆盖（正在流式时保护本地）", () => {
    const core = makeCore();
    const target = conv("c1", { messages: [{ role: "user", text: "服务端版本" }] });
    core.conversations.value = [target];
    core.selectConversation(target);
    const state = core.states.get("c1")!;
    state.bubbles[0]!.text = "本地正在流式的内容";
    // 再次切换过来：已有气泡，不应重建
    core.selectConversation(target);
    expect(state.bubbles[0]!.text).toBe("本地正在流式的内容");
  });

  it("newConversation：清空当前指针并清 blank 残留设置", () => {
    const core = makeCore();
    const c1 = conv("c1");
    core.conversations.value = [c1];
    core.selectConversation(c1);
    // 在草稿态塞点残留
    core.blank.settings.modelId = "old-model";
    core.blank.settings.mcpEnabled = ["old-srv"];
    core.newConversation();
    expect(core.currentId.value).toBe("");
    expect(core.blank.settings.modelId).toBe("");
    expect(core.blank.settings.mcpEnabled).toEqual([]);
  });

  it("removeConversation：移出列表 + 登记 undoDelete + 删当前对话切到下一个", () => {
    const core = makeCore();
    const c1 = conv("c1");
    const c2 = conv("c2");
    core.conversations.value = [c1, c2];
    core.selectConversation(c1);
    core.removeConversation("c1");
    expect(core.conversations.value.map((c) => c.id)).toEqual(["c2"]);
    expect(core.undoDelete.value?.conv.id).toBe("c1");
    expect(core.currentId.value).toBe("c2");
  });

  it("undoRemoveConversation：把删掉的对话恢复到原位置并切回", () => {
    const core = makeCore();
    const c1 = conv("c1");
    const c2 = conv("c2");
    const c3 = conv("c3");
    core.conversations.value = [c1, c2, c3];
    core.selectConversation(c2);
    core.removeConversation("c2"); // 删中间的
    expect(core.conversations.value.map((c) => c.id)).toEqual(["c1", "c3"]);
    core.undoRemoveConversation();
    expect(core.conversations.value.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(core.currentId.value).toBe("c2");
    expect(core.undoDelete.value).toBeNull();
  });

  it("applyConversationOrder：把 from 移到 target 前并重排", async () => {
    const core = makeCore();
    const list = [conv("c1", { sortOrder: 0 }), conv("c2", { sortOrder: 1000 }), conv("c3", { sortOrder: 2000 })];
    core.conversations.value = list;
    await core.applyConversationOrder("c3", "c1", false);
    expect(core.conversations.value.map((c) => c.id)).toEqual(["c3", "c1", "c2"]);
    expect(core.sortMode.value).toBe("manual");
  });
});
