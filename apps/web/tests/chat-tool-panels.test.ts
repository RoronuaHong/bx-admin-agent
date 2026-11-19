import { beforeEach, describe, expect, it, vi } from "vitest";

const apiSpies = vi.hoisted(() => ({
  fetchChatMcpServers: vi.fn(async (..._args: any[]): Promise<any> => ({ available: [], enabled: [] })),
  fetchChatSkills: vi.fn(async (..._args: any[]): Promise<any> => ({ available: [], enabled: [] })),
  fetchChatTaskStatus: vi.fn(async (..._args: any[]): Promise<any> => null),
  fetchConversation: vi.fn(async (..._args: any[]): Promise<any> => null),
  fetchConversations: vi.fn(async (..._args: any[]): Promise<any> => []),
  fetchSchedules: vi.fn(async (..._args: any[]): Promise<any> => []),
  saveChatPreferences: vi.fn(async (..._args: any[]): Promise<any> => undefined),
  createConversation: vi.fn(async (..._args: any[]): Promise<any> => ({ id: "new", title: "新对话", messages: [] })),
  patchConversation: vi.fn(async (..._args: any[]): Promise<any> => undefined),
  deleteConversation: vi.fn(async (..._args: any[]): Promise<any> => undefined),
  deleteCustomMcpServer: vi.fn(async (..._args: any[]): Promise<any> => undefined),
  reloadMcpServer: vi.fn(async (..._args: any[]): Promise<any> => ({})),
  setChatMcpServers: vi.fn(async (enabled: string[]): Promise<any> => ({ available: [], enabled })),
  setChatSkills: vi.fn(async (enabled: string[]): Promise<any> => ({ available: [], enabled })),
}));

const pinyinSpies = vi.hoisted(() => ({
  loadPinyin: vi.fn(() => undefined),
  matchesFuzzy: vi.fn((a: string, b: string) => String(a).includes(String(b))),
  matchesFuzzyScoped: vi.fn((short: string[], long: string[], q: string) =>
    [...short, ...long].some((value) => String(value).toLowerCase().includes(String(q).toLowerCase())),
  ),
  pinyinReady: { value: true },
}));

const routerSpies = vi.hoisted(() => ({
  push: vi.fn(),
  currentRoute: { value: { query: {} } },
}));

vi.mock("vue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue")>();
  return {
    ...actual,
    onMounted: () => undefined,
    onBeforeUnmount: () => undefined,
    provide: () => undefined,
    watch: () => () => undefined,
  };
});
vi.mock("vue-router", () => ({ useRouter: () => routerSpies }));
vi.mock("../src/chat-richtext", () => ({ renderChatMarkdown: () => "" }));
vi.mock("../src/theme", () => ({
  readStoredTheme: () => "dark",
  useTheme: () => ({ theme: { value: "dark" }, setTheme: () => undefined }),
}));
vi.mock("../src/pinyin", () => pinyinSpies);
vi.mock("../src/api", () => {
  const runtimeExports = `addMemoryItem ApiError cancelChatTask cancelSubagent clearConversation clearConversationContext confirmToolCall conversationExportUrl createChatSchedule createConversation createSkill deleteChatSchedule deleteConversation deleteCustomMcpServer deleteMcpServer deleteNotifyChannel deleteSkill dequeueConversationMessage duplicateConversation enqueueConversationMessage fetchChatMcpServers fetchChatPreferences fetchChatSkills fetchChatTaskStatus fetchConversation fetchConversations fetchMcpServers fetchMemory fetchModels fetchNotifyChannels fetchSchedules fetchSkillCatalog fetchSkillDocument fetchTraceRuns fetchWorkspaceFiles getApiErrorCode getApiErrorToken importSkillFile isChatTaskRunning patchChatSchedule patchConversation readWorkspaceFile reloadMcpServer removeMemoryItem reorderConversations restartChatSchedule resumeChatTaskEvents runChatSchedule saveChatPreferences saveConversationMessages saveCustomMcpServer saveMcpServer saveNotifyChannel setChatMcpServers setChatSkills setSkillEnabled streamChat testNotifyChannel updateSkill uploadFiles workspaceDownloadUrl`.split(" ");
  const mock: Record<string, unknown> = Object.fromEntries(runtimeExports.map((k) => [k, async () => undefined]));
  Object.assign(mock, {
    MODEL_AUTO_ID: "auto",
    NOT_MODEL_FAULT_CODES: [],
    fetchConversations: apiSpies.fetchConversations,
    fetchChatMcpServers: apiSpies.fetchChatMcpServers,
    fetchChatSkills: apiSpies.fetchChatSkills,
    fetchChatTaskStatus: apiSpies.fetchChatTaskStatus,
    fetchConversation: apiSpies.fetchConversation,
    fetchSchedules: apiSpies.fetchSchedules,
    saveChatPreferences: apiSpies.saveChatPreferences,
    createConversation: apiSpies.createConversation,
    patchConversation: apiSpies.patchConversation,
    deleteConversation: apiSpies.deleteConversation,
    deleteCustomMcpServer: apiSpies.deleteCustomMcpServer,
    reloadMcpServer: apiSpies.reloadMcpServer,
    setChatMcpServers: apiSpies.setChatMcpServers,
    setChatSkills: apiSpies.setChatSkills,
    getApiErrorToken: () => "",
  });
  return mock;
});

import { useChatPageCore } from "../src/composables/chat/useChatPageCore";

type Core = ReturnType<typeof useChatPageCore>;

function mcp(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label: id === "zoho-salesiq" ? "SalesIQ" : id,
    transport: "stdio",
    enabled: true,
    connected: true,
    ...overrides,
  } as any;
}

function skill(dir: string, name: string) {
  return { dir, name, description: `${name} description` } as any;
}

function conv(id: string) {
  return {
    id,
    title: id,
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
  } as any;
}

function makeCore(agentId = "generic"): Core {
  return useChatPageCore({
    agentProps: { agentId },
    router: routerSpies as never,
  });
}

async function openSavedConversation(core: Core, id = "c1") {
  const item = conv(id);
  core.conversations.value = [item];
  core.selectConversation(item);
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined }));
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  apiSpies.fetchChatMcpServers.mockImplementation(async (..._args: any[]) => ({ available: [], enabled: [] }));
  apiSpies.fetchChatSkills.mockImplementation(async (..._args: any[]) => ({ available: [], enabled: [] }));
  apiSpies.reloadMcpServer.mockImplementation(async (id: string) => mcp(id));
  apiSpies.setChatMcpServers.mockImplementation(async (enabled: string[]) => ({ available: [], enabled }));
  apiSpies.setChatSkills.mockImplementation(async (enabled: string[]) => ({ available: [], enabled }));
  pinyinSpies.loadPinyin.mockImplementation(() => undefined);
  pinyinSpies.matchesFuzzyScoped.mockImplementation((short: string[], long: string[], q: string) =>
    [...short, ...long].some((value) => String(value).toLowerCase().includes(String(q).toLowerCase())),
  );
});

describe("T3 SCC B 工具面板特征测试（拆分前锁定当前真实行为）", () => {
  it("三个飞出面板互斥：首次打开清 query、设 autofocus、拉拼音与列表", () => {
    const core = makeCore();
    core.mcpQuery.value = "old-mcp";
    core.skillQuery.value = "old-skill";
    core.expertQuery.value = "old-expert";

    core.openMcpPanel(false);
    expect(core.mcpOpen.value).toBe(true);
    expect(core.skillOpen.value).toBe(false);
    expect(core.expertOpen.value).toBe(false);
    expect(core.mcpQuery.value).toBe("");
    expect(core.searchAutofocus.value).toBe(false);
    expect(pinyinSpies.loadPinyin).toHaveBeenCalled();
    expect(apiSpies.fetchChatMcpServers).toHaveBeenCalled();

    core.openSkillPanel(true);
    expect(core.skillOpen.value).toBe(true);
    expect(core.mcpOpen.value).toBe(false);
    expect(core.expertOpen.value).toBe(false);
    expect(core.skillQuery.value).toBe("");
    expect(core.searchAutofocus.value).toBe(true);
    expect(apiSpies.fetchChatSkills).toHaveBeenCalled();

    core.openExpertPanel(false);
    expect(core.expertOpen.value).toBe(true);
    expect(core.skillOpen.value).toBe(false);
    expect(core.mcpOpen.value).toBe(false);
    expect(core.expertQuery.value).toBe("");
    expect(core.searchAutofocus.value).toBe(false);

    core.closeToolsPanels();
    expect(core.toolsMenuOpen.value).toBe(false);
    expect(core.mcpOpen.value).toBe(false);
    expect(core.skillOpen.value).toBe(false);
    expect(core.expertOpen.value).toBe(false);
  });

  it("已展开的面板保持用户输入：hover 重入不重置 query/焦点/列表", () => {
    const core = makeCore();
    core.openMcpPanel();
    core.mcpQuery.value = "keep-me";
    pinyinSpies.loadPinyin.mockClear();
    apiSpies.fetchChatMcpServers.mockClear();

    core.openMcpPanel(false);

    expect(core.mcpQuery.value).toBe("keep-me");
    expect(core.searchAutofocus.value).toBe(true);
    expect(pinyinSpies.loadPinyin).not.toHaveBeenCalled();
    expect(apiSpies.fetchChatMcpServers).not.toHaveBeenCalled();
  });

  it("工具菜单打开即预取；关闭清掉全部飞出；hover 不抢焦点", () => {
    const core = makeCore();
    core.toggleToolsMenu();
    expect(core.toolsMenuOpen.value).toBe(true);
    expect(apiSpies.fetchChatSkills).toHaveBeenCalled();
    expect(apiSpies.fetchChatMcpServers).toHaveBeenCalled();
    expect(pinyinSpies.loadPinyin).toHaveBeenCalled();

    core.hoverFlyout("mcp");
    expect(core.mcpOpen.value).toBe(true);
    expect(core.searchAutofocus.value).toBe(false);

    core.toggleToolsMenu();
    expect(core.toolsMenuOpen.value).toBe(false);
    expect(core.mcpOpen.value).toBe(false);
    core.hoverFlyout("skills");
    expect(core.skillOpen.value).toBe(false);
  });

  it("toggleMcp：成功落库并延迟刷新；失败回滚启用集与 mcpBusy", async () => {
    vi.useFakeTimers();
    try {
      const core = makeCore();
      await openSavedConversation(core);
      core.mcpAvailable.value = [mcp("mcp-a"), mcp("mcp-b")];
      core.current.value.settings.mcpEnabled = ["mcp-a"];
      apiSpies.fetchChatMcpServers.mockResolvedValue({ available: core.mcpAvailable.value, enabled: ["mcp-a", "mcp-b"] });
      apiSpies.setChatMcpServers.mockResolvedValueOnce({ available: core.mcpAvailable.value, enabled: ["mcp-a", "mcp-b"] });

      await core.toggleMcp("mcp-b", true);
      expect(apiSpies.setChatMcpServers).toHaveBeenCalledWith(["mcp-a", "mcp-b"], "c1");
      expect(core.current.value.settings.mcpEnabled).toEqual(["mcp-a", "mcp-b"]);
      expect(core.mcpBusy.value).toBe(false);
      const beforeRefresh = apiSpies.fetchChatMcpServers.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1500);
      expect(apiSpies.fetchChatMcpServers.mock.calls.length).toBeGreaterThan(beforeRefresh);

      apiSpies.setChatMcpServers.mockRejectedValueOnce(new Error("boom"));
      await core.toggleMcp("mcp-c", true);
      expect(core.current.value.settings.mcpEnabled).toEqual(["mcp-a", "mcp-b"]);
      expect(core.mcpError.value).not.toBe("");
      expect(core.mcpBusy.value).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnectMcp：逐行 busy 状态，成功/失败都清理 mcpReconnecting", async () => {
    const core = makeCore();
    await openSavedConversation(core);
    core.mcpAvailable.value = [mcp("mcp-a", { connected: false })];
    apiSpies.fetchChatMcpServers.mockResolvedValue({ available: [mcp("mcp-a")], enabled: [] });

    let resolveReload: (value: any) => void = () => undefined;
    apiSpies.reloadMcpServer.mockImplementationOnce(
      () => new Promise((resolve) => { resolveReload = resolve; }),
    );
    const pending = core.reconnectMcp("mcp-a");
    expect(core.mcpReconnecting.has("mcp-a")).toBe(true);
    expect(core.mcpAvailable.value[0].connecting).toBe(true);
    resolveReload(mcp("mcp-a"));
    await pending;
    expect(core.mcpReconnecting.has("mcp-a")).toBe(false);
    expect(core.mcpAvailable.value[0].connecting).toBeFalsy();

    apiSpies.reloadMcpServer.mockRejectedValueOnce(new Error("offline"));
    await core.reconnectMcp("mcp-a");
    expect(core.mcpReconnecting.has("mcp-a")).toBe(false);
    expect(core.mcpAvailable.value[0].error).toBeTruthy();
    expect(core.mcpError.value).not.toBe("");
  });

  it("技能/MCP 搜索走同一套 fuzzy 过滤；任务侧复用同一批 available ref", () => {
    const core = makeCore();
    core.skillAvailable.value = [skill("weekly-report", "Weekly Report"), skill("attendance", "Attendance")];
    core.mcpAvailable.value = [mcp("sales-iq", { label: "SalesIQ" }), mcp("weekly-db", { label: "Weekly DB" })];

    core.skillQuery.value = "weekly";
    expect(core.skillFiltered.value.map((s) => s.dir)).toEqual(["weekly-report"]);
    core.mcpQuery.value = "sales";
    expect(core.mcpFiltered.value.map((s) => s.id)).toEqual(["sales-iq"]);

    core.taskSkillQuery.value = "weekly";
    core.taskMcpQuery.value = "weekly";
    expect(core.taskSkillFiltered.value.map((s) => s.dir)).toEqual(["weekly-report"]);
    expect(core.taskMcpFiltered.value.map((row) => row.server.id)).toEqual(["weekly-db"]);
  });

  it("任务草稿作用域独立：taskMcpFiltered 看 taskDraft，聊天面板看当前对话启用集", () => {
    const core = makeCore();
    core.mcpAvailable.value = [mcp("mcp-a")];
    core.taskDraft.mcpServers = ["mcp-a"];
    core.current.value.settings.mcpEnabled = [];

    expect(core.taskMcpFiltered.value[0].state.cls).toBe("ok");
    const chatRow = core.mcpPanelRows.value.find((row) => row.kind === "server" && row.server.id === "mcp-a") as any;
    expect(chatRow.state.cls).toBe("idle");
    expect(core.taskMcpCount.value).toBe(1);

    core.skillAvailable.value = [skill("sk-a", "Skill A")];
    expect(core.taskSkillFiltered.value.map((s) => s.dir)).toEqual(["sk-a"]);
    expect(core.skillFiltered.value.map((s) => s.dir)).toEqual(["sk-a"]);
  });

  it("专家 chip/starter/占位文案与导航保持一致", () => {
    const core = makeCore("support");
    expect(core.currentExpert.value?.id).toBe("support");
    expect(core.expertStarters.value).toHaveLength(3);
    expect(core.composerPlaceholder.value).toContain("会话量");

    const expert = core.expertAgents.find((a) => a.id === "support")!;
    core.openExpertPanel();
    core.onPickExpert(expert);
    expect(core.expertOpen.value).toBe(false);
    expect(routerSpies.push).toHaveBeenCalledWith("/support");

    core.onClearExpert();
    expect(routerSpies.push).toHaveBeenCalledWith("/chat");
  });

  it("bound MCP：不可关闭/清空保留；创建草稿时与勾选集合并落库", async () => {
    const core = makeCore("support");
    core.mcpAvailable.value = [mcp("zoho-salesiq"), mcp("mcp-optional")];
    core.current.value.settings.mcpEnabled = ["zoho-salesiq", "mcp-optional"];

    expect(core.mcpBoundRows.value.map((s) => s.id)).toEqual(["zoho-salesiq"]);
    expect(core.mcpOptionalRows.value.map((s) => s.id)).toEqual(["mcp-optional"]);
    expect(core.canClearOptionalMcp.value).toBe(true);

    await core.toggleMcp("zoho-salesiq", false);
    expect(core.current.value.settings.mcpEnabled).toEqual(["zoho-salesiq", "mcp-optional"]);
    expect(apiSpies.setChatMcpServers).not.toHaveBeenCalled();

    await core.clearMcpSelection();
    expect(core.current.value.settings.mcpEnabled).toEqual(["zoho-salesiq"]);

    core.current.value.settings.mcpEnabled = ["mcp-optional"];
    await core.createConvFromDraft("hi");
    expect(apiSpies.patchConversation).toHaveBeenCalledWith(
      "new",
      expect.objectContaining({ mcpServers: expect.arrayContaining(["zoho-salesiq", "mcp-optional"]) }),
    );
  });
});
