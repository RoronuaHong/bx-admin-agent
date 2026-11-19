import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive, ref } from "vue";

// ---- 浏览器 API 兜底（vitest 默认 node 环境）----
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
});

import { useChatPersistence } from "../src/composables/chat/useChatPersistence";
import { useChatModelSettings } from "../src/composables/chat/useChatModelSettings";
import { useChatThreadScroll } from "../src/composables/chat/useChatThreadScroll";
import { useChatReasoningUI } from "../src/composables/chat/useChatReasoningUI";
import type { Bubble, ConvState } from "../src/composables/chat/chat-page-types";

function makeState(overrides: Partial<ConvState> = {}): ConvState {
  return {
    bubbles: [],
    input: "",
    sending: false,
    controllers: [],
    queue: [],
    pendingImages: [],
    pendingDocs: [],
    settings: { modelId: "", locale: "", mcpEnabled: [], skillsEnabled: [] } as ConvState["settings"],
    error: "",
    ...overrides,
  } as ConvState;
}

const noopTx = (zh: string) => zh;

function makePersistence(overrides: {
  states?: Map<string, ConvState>;
  currentId?: ReturnType<typeof ref<string>>;
  conversations?: ReturnType<typeof ref<never[]>>;
  persistedCount?: Map<string, number>;
  atBottomNow?: () => boolean;
  queueScroll?: (force?: boolean) => void;
  messageTimes?: (m: Array<{ role: string; at?: number }>) => number[];
} = {}) {
  let n = 0;
  return useChatPersistence({
    states: overrides.states ?? new Map(),
    currentId: overrides.currentId ?? ref("c1"),
    conversations: (overrides.conversations ?? ref([])) as never,
    persistedCount: overrides.persistedCount ?? new Map(),
    nextSeq: () => ++n,
    atBottomNow: overrides.atBottomNow ?? (() => true),
    queueScroll: overrides.queueScroll ?? (() => undefined),
    ensureRunPrompt: () => undefined,
    attachRunningTask: async () => undefined,
    messageTimes: overrides.messageTimes ?? (() => []),
  });
}

describe("useChatPersistence（T0 安全网）", () => {
  it("toStored 过滤 notice 气泡", () => {
    const api = makePersistence();
    const list = [
      { id: 1, role: "user", text: "hi", at: 1 },
      { id: 2, role: "notice", text: "模型已切换", at: 2 },
      { id: 3, role: "assistant", text: "hello", at: 3 },
    ] as Bubble[];
    const stored = api.toStored(list);
    expect(stored).toHaveLength(2);
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("settleStep 把 running 归一为 interrupted", () => {
    const api = makePersistence();
    expect(api.settleStep({ id: "s1", name: "tool", status: "running" } as never).status).toBe("interrupted");
    expect(api.settleStep({ id: "s2", name: "tool", status: "success" } as never).status).toBe("success");
  });

  it("toStored 落库时把未收束的 running 步骤写成 interrupted（刷新不永久转圈）", () => {
    const api = makePersistence();
    const list = [
      {
        id: 1,
        role: "assistant",
        text: "done",
        at: 1,
        steps: [{ id: "s1", name: "tool", status: "running" }],
      },
    ] as Bubble[];
    const stored = api.toStored(list);
    expect((stored[0]!.steps as Array<{ status: string }>)[0]!.status).toBe("interrupted");
  });

  it("serverThreadAhead：服务端更新才覆盖本地", () => {
    const api = makePersistence();
    const local = [{ id: 1, role: "user", text: "hi" }, { id: 2, role: "assistant", text: "hello" }] as Bubble[];
    // 服务端条数更多 → ahead
    expect(api.serverThreadAhead(local, [
      { role: "user", text: "hi" }, { role: "assistant", text: "hello" }, { role: "user", text: "more" },
    ])).toBe(true);
    // 条数更少 → 不 ahead
    expect(api.serverThreadAhead(local, [{ role: "user", text: "hi" }])).toBe(false);
    // 条数相同、正文没变 → 不 ahead（避免无谓覆盖）
    expect(api.serverThreadAhead(local, [
      { role: "user", text: "hi" }, { role: "assistant", text: "hello" },
    ])).toBe(false);
  });

  it("applyServerThread：本地正在流式时不覆盖", () => {
    const state = makeState({
      bubbles: [
        { id: 1, role: "user", text: "hi", at: 1 },
        { id: 2, role: "assistant", text: "partial", at: 2, streaming: true },
      ] as Bubble[],
    });
    const states = new Map([["c1", state]]);
    const api = makePersistence({ states });
    api.applyServerThread("c1", { id: "c1", messages: [
      { role: "user", text: "hi" }, { role: "assistant", text: "complete server answer" },
    ] } as never, true);
    expect(state.bubbles.find((b) => b.role === "assistant")?.text).toBe("partial");
  });

  it("applyServerThread：force 覆盖并保留本地 notice 气泡", () => {
    const state = makeState({
      bubbles: [
        { id: 90, role: "notice", text: "模型已切换", at: 1 },
        { id: 1, role: "user", text: "old", at: 2 },
      ] as Bubble[],
    });
    const states = new Map([["c1", state]]);
    const api = makePersistence({ states, messageTimes: (m) => m.map((_, i) => (i + 1) * 100) });
    api.applyServerThread("c1", { id: "c1", messages: [
      { role: "user", text: "new question" }, { role: "assistant", text: "new answer" },
    ] } as never, true);
    expect(state.bubbles.some((b) => b.role === "notice")).toBe(true);
    expect(state.bubbles.find((b) => b.role === "user")?.text).toBe("new question");
    expect(state.bubbles.find((b) => b.role === "assistant")?.text).toBe("new answer");
  });
});

function makeModelSettings(state: ConvState = makeState()) {
  return useChatModelSettings({
    current: ref(state) as never,
    currentId: ref("c1"),
    settingsError: ref(""),
    conversations: ref([]),
    deviceLocale: ref("zh"),
    uiLocale: ref("zh"),
    tx: noopTx,
    nextSeq: (() => { let n = 0; return () => ++n; })(),
    queueScroll: () => undefined,
  });
}

describe("useChatModelSettings（T1 安全网）", () => {
  it("resolveModel：auto 落到首个可用模型，跳过失败过的", () => {
    const api = makeModelSettings();
    api.models.value = [
      { id: "m1", label: "M1", vision: "direct" },
      { id: "m2", label: "M2", vision: "none" },
      { id: "m3", label: "M3", vision: "none" },
    ] as never;
    api.modelsLoaded.value = true;
    api.failedModelIds.value.add("m1");
    expect(api.resolveModel("auto")).toBe("m2");
    api.failedModelIds.value.add("m2");
    expect(api.resolveModel("auto")).toBe("m3");
  });

  it("resolveModel：全部失败后清空黑名单重新探测", () => {
    const api = makeModelSettings();
    api.models.value = [
      { id: "m1", label: "M1", vision: "none" },
      { id: "m2", label: "M2", vision: "none" },
    ] as never;
    api.modelsLoaded.value = true;
    api.failedModelIds.value.add("m1");
    api.failedModelIds.value.add("m2");
    expect(api.resolveModel("auto")).toBe("m1");
    expect(api.failedModelIds.value.size).toBe(0);
  });

  it("modelId getter：对话存的模型已失效时回落自动", () => {
    const state = makeState();
    state.settings.modelId = "gone-model";
    const api = makeModelSettings(state);
    api.models.value = [{ id: "m1", label: "M1", vision: "none" }] as never;
    api.modelsLoaded.value = false;
    expect(api.modelId.value).toBe("gone-model"); // 未加载完不误判
    api.modelsLoaded.value = true;
    expect(api.modelId.value).toBe("auto"); // 加载后失效回落自动
  });
});

describe("useChatThreadScroll（T1 安全网）", () => {
  it("atBottomNow：followBottom 关闭时不跟底", () => {
    const api = useChatThreadScroll({
      currentId: ref("c1"),
      threadEl: ref(null),
      pinnedOutlineId: ref(null),
      isOutlineJumpActive: () => false,
      getOutlineIgnoreScrollUntil: () => 0,
      releaseOutlinePin: () => undefined,
    });
    expect(api.atBottomNow()).toBe(true);
    api.setFollowBottom(false);
    expect(api.atBottomNow()).toBe(false);
    api.setFollowBottom(true);
    expect(api.atBottomNow()).toBe(true);
  });
});

describe("useChatReasoningUI（T1 安全网）", () => {
  it("toggleReasoning 尊重用户收起：流式请求不再自动展开", () => {
    const api = useChatReasoningUI({
      threadEl: ref(null),
      uiLocale: ref("zh"),
      tx: noopTx,
    });
    api.toggleReasoning(7);
    expect(api.openReasoning.has(7)).toBe(true);
    api.toggleReasoning(7); // 用户收起
    expect(api.openReasoning.has(7)).toBe(false);
    api.openReasoningPanel(7); // 流式请求展开，应被忽略
    expect(api.openReasoning.has(7)).toBe(false);
  });

  it("thinkPhaseStart/End 累加耗时", () => {
    const api = useChatReasoningUI({
      threadEl: ref(null),
      uiLocale: ref("zh"),
      tx: noopTx,
    });
    api.thinkPhaseStart(1);
    const b = { id: 1, role: "assistant", text: "" } as Bubble;
    api.thinkPhaseEnd(b);
    expect((b.thinkMs ?? 0) >= 0).toBe(true);
  });

  it("intentOf 只认显式意图前缀，不对半截首句做兜底", () => {
    const api = useChatReasoningUI({ threadEl: ref(null), uiLocale: ref("zh"), tx: noopTx });
    expect(api.intentOf({ thinking: "意图：查询本月销量\n用户想看数据" } as Bubble)).toBe("查询本月销量");
    expect(api.intentOf({ thinking: "Intent: book a flight" } as Bubble)).toBe("book a flight");
    expect(api.intentOf({ thinking: "用户只输入了 123，没有明确的请求。" } as Bubble)).toBeUndefined();
  });

  it("stepSummary 去 markdown 标题并截断", () => {
    const api = useChatReasoningUI({ threadEl: ref(null), uiLocale: ref("zh"), tx: noopTx });
    expect(api.stepSummary({ result: "## 查询完成\n明细…" } as never)).toBe("查询完成");
    expect(api.stepSummary({ result: "   \nplain line" } as never)).toBe("plain line");
  });

  it("hasThinking 忽略纯空白思考", () => {
    const api = useChatReasoningUI({ threadEl: ref(null), uiLocale: ref("zh"), tx: noopTx });
    expect(api.hasThinking({ thinking: "  \n  " } as Bubble)).toBe(false);
    expect(api.hasThinking({ thinking: "真正的内容" } as Bubble)).toBe(true);
  });

  it("reasoningTitle：流式推理中给出正确阶段文案", () => {
    const api = useChatReasoningUI({ threadEl: ref(null), uiLocale: ref("zh"), tx: noopTx });
    expect(api.reasoningTitle({ streaming: true, thinking: "意图：查数据\n..." } as Bubble)).toContain("理解意图");
    expect(api.reasoningTitle({ streaming: true, text: "答案正文" } as Bubble)).toContain("回答中");
    expect(api.reasoningTitle({ streaming: true } as Bubble)).toContain("正在规划");
  });
});
