import { beforeEach, describe, expect, it, vi } from "vitest";

// 可断言的 api spy（vi.hoisted 提升到 vi.mock 之前，供 mock 工厂与测试共用）
const apiSpies = vi.hoisted(() => ({
  fetchChatMcpServers: vi.fn(async () => null),
  fetchChatSkills: vi.fn(async () => null),
  fetchChatTaskStatus: vi.fn(async () => null),
  fetchConversation: vi.fn(async () => null),
  saveChatPreferences: vi.fn(async () => undefined),
  createConversation: vi.fn(async () => ({ id: "new", title: "新对话", messages: [] })),
  deleteConversation: vi.fn(async () => undefined),
  patchConversation: vi.fn(async () => undefined),
}));

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
    fetchChatTaskStatus: apiSpies.fetchChatTaskStatus,
    fetchConversation: apiSpies.fetchConversation,
    fetchModels: async () => [],
    saveConversationMessages: async () => undefined,
    reorderConversations: async () => undefined,
    fetchChatMcpServers: apiSpies.fetchChatMcpServers,
    fetchChatSkills: apiSpies.fetchChatSkills,
    saveChatPreferences: apiSpies.saveChatPreferences,
    patchConversation: apiSpies.patchConversation,
    createConversation: apiSpies.createConversation,
    deleteConversation: apiSpies.deleteConversation,
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
  vi.clearAllMocks();
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

  // 依赖注入探针：selectConversation 的 14 个跨组依赖中，凡最终落到 api 的回调，
  // 拆分后若漏注入就会断链 → 这里断言调用链完整，是防"漏注入"的核心安全网。
  it("selectConversation 触发完整下游调用链（防 T2 拆分漏注入）", async () => {
    const core = makeCore();
    const target = conv("c1", { messages: [{ role: "user", text: "hi" }] });
    core.conversations.value = [target];
    core.selectConversation(target);
    await vi.waitFor(() => {
      expect(apiSpies.fetchChatMcpServers).toHaveBeenCalled(); // loadMcp
      expect(apiSpies.fetchChatSkills).toHaveBeenCalled(); // loadSkills
      expect(apiSpies.fetchChatTaskStatus).toHaveBeenCalledWith("c1"); // syncOpenConversation
      expect(apiSpies.fetchConversation).toHaveBeenCalled(); // upgradeConversationDetail
      expect(apiSpies.saveChatPreferences).toHaveBeenCalledWith(
        expect.objectContaining({ activeConversationId: "c1" }),
      ); // reportActiveConversation
    });
  });

  // R2：删除撤销的 5s 窗口 + flush —— 用 fake timers 锁定定时器行为
  it("removeConversation：撤销窗口内 undoDelete 保留，5s 后清空并服务端落库", async () => {
    vi.useFakeTimers();
    try {
      const core = makeCore();
      const c1 = conv("c1");
      const c2 = conv("c2");
      core.conversations.value = [c1, c2];
      core.selectConversation(c1);
      const beforeDeleteCalls = apiSpies.deleteConversation.mock.calls.length;
      core.removeConversation("c1");
      expect(core.undoDelete.value?.conv.id).toBe("c1");
      expect(apiSpies.deleteConversation.mock.calls.length).toBe(beforeDeleteCalls); // 窗口内还没真删
      await vi.advanceTimersByTimeAsync(5000);
      expect(core.undoDelete.value).toBeNull();
      expect(apiSpies.deleteConversation).toHaveBeenCalledWith("c1"); // 窗口结束真删
    } finally {
      vi.useRealTimers();
    }
  });

  it("undoRemoveConversation：撤销后取消定时器，服务端不会落库删除", async () => {
    vi.useFakeTimers();
    try {
      const core = makeCore();
      const c1 = conv("c1");
      const c2 = conv("c2");
      core.conversations.value = [c1, c2];
      core.selectConversation(c1);
      const before = apiSpies.deleteConversation.mock.calls.length;
      core.removeConversation("c1");
      core.undoRemoveConversation();
      await vi.advanceTimersByTimeAsync(6000);
      expect(apiSpies.deleteConversation.mock.calls.length).toBe(before); // 撤销后不应真删
      expect(core.conversations.value.map((c) => c.id)).toEqual(["c1", "c2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  // R3：右键菜单状态机
  it("openCtxMenu/closeCtxMenu：菜单开合与 targetId", () => {
    const core = makeCore();
    const c1 = conv("c1");
    const e = { preventDefault: () => undefined, stopPropagation: () => undefined, clientX: 10, clientY: 20, currentTarget: null } as unknown as MouseEvent;
    core.openCtxMenu(e, c1);
    expect(core.ctxMenu.value.open).toBe(true);
    expect(core.ctxMenu.value.targetId).toBe("c1");
    core.closeCtxMenu();
    expect(core.ctxMenu.value.open).toBe(false);
  });

  it("armCtxConfirm：进入待确认态", async () => {
    const core = makeCore();
    const c1 = conv("c1");
    const e = { preventDefault: () => undefined, stopPropagation: () => undefined, clientX: 10, clientY: 20, currentTarget: null } as unknown as MouseEvent;
    core.openCtxMenu(e, c1);
    await core.armCtxConfirm("clear");
    expect(core.ctxConfirm.value).toBe("clear");
    core.closeCtxMenu();
    expect(core.ctxConfirm.value).toBe("");
  });

  // createConvFromDraft：草稿创建继承草稿的 MCP/技能集并落库（A↔B 桥接的 createConvFromDraft 边界）
  it("createConvFromDraft：草稿的 MCP / 技能 / 模型设置带入新对话", async () => {
    const core = makeCore();
    core.blank.settings.mcpEnabled = ["draft-srv"];
    core.blank.settings.skillsEnabled = ["skill-a"];
    core.blank.settings.modelId = "m-x";
    const id = await core.createConvFromDraft("帮我查数据");
    expect(id).toBe("new");
    expect(core.currentId.value).toBe("new");
    const st = core.states.get("new");
    expect(st!.settings.mcpEnabled).toEqual(["draft-srv"]);
    expect(st!.settings.skillsEnabled).toEqual(["skill-a"]);
    expect(st!.settings.modelId).toBe("m-x");
    // 设置随首条消息落库（patchConversation 被调用）
    expect(apiSpies.patchConversation).toHaveBeenCalledWith(
      "new",
      expect.objectContaining({ mcpServers: ["draft-srv"], skillsEnabled: ["skill-a"], model: "m-x" }),
    );
  });
});
