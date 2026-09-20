import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callAgent, isReasoningReplayRejected, markReasoningReplayRequired, reasoningReplayRequired } from "../src/models.js";
import { streamCall } from "../src/chat.js";
import { config } from "../src/config.js";
import type { ModelEntry } from "../src/config.js";

function makeModel(provider: ModelEntry["provider"], name: string, id = "test"): ModelEntry {
  return {
    id,
    label: name,
    provider,
    name,
    baseUrl: provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com",
    apiKey: "k",
    apiKeys: ["k"],
    vision: "none",
    timeoutMs: 1000,
    contextWindow: 128000,
  };
}

function sse(lines: string[]): Response {
  return new Response(lines.join("\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const anthropicThinkingSse = [
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","id":"th_1"}}',
  "",
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me "}}',
  "",
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"think carefully."}}',
  "",
  'event: content_block_start',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}',
  "",
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Final answer."}}',
  "",
  'event: message_stop',
  'data: {"type":"message_stop"}',
  "",
].join("\n");

const openaiReasoningSse = [
  'data: {"choices":[{"delta":{"reasoning":"I "}}]}',
  'data: {"choices":[{"delta":{"reasoning":"am reasoning"}}]}',
  'data: {"choices":[{"delta":{"content":"Hello"}}]}',
  "data: [DONE]",
].join("\n");

const openaiPlainSse = [
  'data: {"choices":[{"delta":{"content":"Hi there"}}]}',
  "data: [DONE]",
].join("\n");

const anthropicPlainSse = [
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  "",
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Final answer."}}',
  "",
  'event: message_stop',
  'data: {"type":"message_stop"}',
  "",
].join("\n");

const anthropicNonStreamThinkingBody = {
  content: [
    { type: "thinking", thinking: "Offline thought." },
    { type: "text", text: "Offline answer." },
  ],
};

let capturedBody: unknown = null;

beforeEach(() => {
  config.maxOutputTokens = 8192;
  capturedBody = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("thinking 事件流（callAgent 透传 + 解析正确性）", () => {
  it("anthropic 思考模型：think 流转发、且不泄漏进正文、请求体带 thinking", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      capturedBody = init?.body ? JSON.parse(init.body) : null;
      return sse(anthropicThinkingSse.split("\n"));
    });
    vi.stubGlobal("fetch", fetchMock);

    const thinking: string[] = [];
    const deltas: string[] = [];
    const res = await callAgent(
      makeModel("anthropic", "claude-3-7-sonnet-20250219"),
      [{ role: "user", content: "hi" }],
      [],
      undefined,
      (c) => deltas.push(c),
      {},
      (t) => thinking.push(t),
    );

    expect(thinking.join("")).toBe("Let me think carefully.");
    expect(deltas.join("")).toBe("Final answer.");
    expect(res.text).toBe("Final answer.");
    // 思考内容绝不能混入最终正文
    expect(res.text).not.toContain("think carefully");
    // 思考模型应请求扩展思考
    expect((capturedBody as { thinking?: unknown })?.thinking).toEqual({
      type: "enabled",
      budget_tokens: 4096,
    });
  });

  it("anthropic 非思考模型：不请求 thinking、onThinking 不被调用", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      capturedBody = init?.body ? JSON.parse(init.body) : null;
      return sse(anthropicPlainSse.split("\n"));
    });
    vi.stubGlobal("fetch", fetchMock);

    const thinkingCalls = vi.fn();
    const res = await callAgent(
      makeModel("anthropic", "claude-3-5-haiku-latest"),
      [{ role: "user", content: "hi" }],
      [],
      undefined,
      undefined,
      {},
      thinkingCalls,
    );

    expect(thinkingCalls).not.toHaveBeenCalled();
    // 未开启思考、响应也无 thinking 块时：正文正确，且无思考事件
    expect(res.text).toBe("Final answer.");
    expect((capturedBody as { thinking?: unknown })?.thinking).toBeUndefined();
  });

  it("ANTHROPIC_THINKING=0 时强制关闭，即使模型名命中也禁用", async () => {
    process.env.ANTHROPIC_THINKING = "0";
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      capturedBody = init?.body ? JSON.parse(init.body) : null;
      return sse(anthropicThinkingSse.split("\n"));
    });
    vi.stubGlobal("fetch", fetchMock);

    await callAgent(
      makeModel("anthropic", "claude-3-7-sonnet-20250219"),
      [{ role: "user", content: "hi" }],
      [],
      undefined,
      undefined,
      {},
      () => {},
    );
    expect((capturedBody as { thinking?: unknown })?.thinking).toBeUndefined();
    delete process.env.ANTHROPIC_THINKING;
  });

  it("anthropic 非流式降级：thinking 块被提取并转发", async () => {
    const fetchMock = vi.fn(async () => json(anthropicNonStreamThinkingBody));
    vi.stubGlobal("fetch", fetchMock);

    const thinking: string[] = [];
    const res = await callAgent(
      makeModel("anthropic", "claude-3-7-sonnet-20250219"),
      [{ role: "user", content: "hi" }],
      [],
      undefined,
      undefined,
      {},
      (t) => thinking.push(t),
    );

    expect(thinking.join("")).toBe("Offline thought.");
    expect(res.text).toBe("Offline answer.");
  });

  it("openai o 系列：delta.reasoning 转发、不泄漏进正文", async () => {
    const fetchMock = vi.fn(async () => sse(openaiReasoningSse.split("\n")));
    vi.stubGlobal("fetch", fetchMock);

    const thinking: string[] = [];
    const deltas: string[] = [];
    const res = await callAgent(
      makeModel("openai", "o3-mini"),
      [{ role: "user", content: "hi" }],
      [],
      undefined,
      (c) => deltas.push(c),
      {},
      (t) => thinking.push(t),
    );

    expect(thinking.join("")).toBe("I am reasoning");
    expect(deltas.join("")).toBe("Hello");
    expect(res.text).toBe("Hello");
    expect(res.text).not.toContain("reasoning");
  });

  it("openai 非推理模型：无 delta.reasoning 时 onThinking 不被调用", async () => {
    const fetchMock = vi.fn(async () => sse(openaiPlainSse.split("\n")));
    vi.stubGlobal("fetch", fetchMock);

    const thinkingCalls = vi.fn();
    const res = await callAgent(
      makeModel("openai", "gpt-4o"),
      [{ role: "user", content: "hi" }],
      [],
      undefined,
      undefined,
      {},
      thinkingCalls,
    );

    expect(thinkingCalls).not.toHaveBeenCalled();
    expect(res.text).toBe("Hi there");
  });
});

// ---- 思考回灌（通用修复：思考类模型的工具循环要求 assistant 工具调用消息带 reasoning_content）----

/** 网关的抱怨原文（实测形态）：只看协议字段名 + 缺失类措辞，不绑定厂商。 */
const REASONING_REPLAY_COMPLAINT = JSON.stringify({
  error: {
    type: "invalid_request_error",
    code: 400,
    message: "thinking is enabled but reasoning_content is missing in assistant tool call message",
  },
});

/** 一个「上一轮发起过工具调用」的最小会话（第二轮回灌时的形态）。 */
const toolCallTurns = (): Parameters<typeof callAgent>[1] => [
  { role: "user", content: "hi" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "probe_echo", argsJson: "{}" }] },
  { role: "tool", toolCallId: "c1", name: "probe_echo", content: "ok" },
];

const assistantMessageOf = (body: unknown): Record<string, unknown> => {
  const messages = (body as { messages?: Array<Record<string, unknown>> })?.messages || [];
  return messages.find((m) => m.role === "assistant") || {};
};

describe("思考回灌（reasoning_content）：能力学习 + 自愈重发", () => {
  it("recognizer 只认协议字段 + 缺失类措辞（不误伤普通报错）", () => {
    expect(isReasoningReplayRejected(REASONING_REPLAY_COMPLAINT)).toBe(true);
    expect(isReasoningReplayRejected('thinking is enabled but reasoning_content is required')).toBe(true);
    expect(isReasoningReplayRejected("model http 400: invalid api key")).toBe(false);
    expect(isReasoningReplayRejected("reasoning_content too long")).toBe(false);
    expect(isReasoningReplayRejected("")).toBe(false);
  });

  it("chat 协议返回的思考原文会被带出（不再只作展示而丢弃）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse(openaiReasoningSse.split("\n"))));
    const res = await callAgent(makeModel("openai", "o3-mini"), [{ role: "user", content: "hi" }], [], undefined, undefined, {}, () => {});
    expect(res.reasoning).toBe("I am reasoning");
    expect(res.text).toBe("Hello");
  });

  it("未学到的端点：不塞未知字段；学到后：带 reasoning_content（有原文用原文，没有给空串）", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        bodies.push(init?.body ? JSON.parse(init.body) : null);
        return sse(openaiPlainSse.split("\n"));
      }),
    );

    const plain = makeModel("openai", "probe-plain", "probe-plain");
    await callAgent(plain, toolCallTurns(), [], undefined, undefined, {});
    expect(assistantMessageOf(bodies[0]).reasoning_content).toBeUndefined();

    // 学到能力（模拟首跳被拒后的记录）→ 有思考原文时回灌原文
    const withReasoning = makeModel("openai", "probe-with-reasoning", "probe-with-reasoning");
    markReasoningReplayRequired(withReasoning);
    const turns = toolCallTurns();
    (turns[1] as { reasoning?: string }).reasoning = "I thought about it";
    await callAgent(withReasoning, turns, [], undefined, undefined, {});
    expect(assistantMessageOf(bodies[1]).reasoning_content).toBe("I thought about it");

    // 学到能力但没有思考原文（该轮模型没产出思考）→ 给空串满足校验（网关只看字段在不在）
    const noReasoning = makeModel("openai", "probe-no-reasoning", "probe-no-reasoning");
    markReasoningReplayRequired(noReasoning);
    await callAgent(noReasoning, toolCallTurns(), [], undefined, undefined, {});
    expect(assistantMessageOf(bodies[2]).reasoning_content).toBe("");
  });

  it("首跳被拒 → 同一轮内补字段重发一次，之后该端点不再白打 400", async () => {
    const bodies: unknown[] = [];
    // 行为化 mock（按网关语义）：assistant 工具调用消息没带 reasoning_content 就拒绝，带了才放行。
    // 这样断言的是「客户端是否满足网关要求」，而不是脆弱的调用次数。
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        const body = init?.body ? JSON.parse(init.body) : null;
        bodies.push(body);
        const assistant = assistantMessageOf(body);
        return assistant.tool_calls && assistant.reasoning_content === undefined
          ? new Response(REASONING_REPLAY_COMPLAINT, { status: 400 })
          : sse(openaiPlainSse.split("\n"));
      }),
    );

    const model = makeModel("openai", "probe-learn", "probe-learn");
    const res = await callAgent(model, toolCallTurns(), [], undefined, undefined, {});

    expect(bodies).toHaveLength(2); // 自愈只重发一次（首跳被拒 + 补字段重发）
    expect(res.text).toBe("Hi there"); // 重发结果正常返回，不把 400 抛给上层
    expect(assistantMessageOf(bodies[1]).reasoning_content).toBe("");
    expect(reasoningReplayRequired(model)).toBe(true); // 能力已记住

    // 第二次调用：能力已记住 → 直接按新口径组装，一次请求即通过（不再白打 400）
    bodies.length = 0;
    await callAgent(model, toolCallTurns(), [], undefined, undefined, {});
    expect(bodies).toHaveLength(1);
    expect(assistantMessageOf(bodies[0]).reasoning_content).toBe("");
  });
});

describe("streamCall 端到端（事件顺序 + 非流式 fallback 不丢正文）", () => {
  it("流式思考模型：先 thinking_delta 再 text_delta，正文不丢", async () => {
    const fetchMock = vi.fn(async () => sse(anthropicThinkingSse.split("\n")));
    vi.stubGlobal("fetch", fetchMock);

    const events: Array<{ type: string; text?: string }> = [];
    for await (const ev of streamCall(makeModel("anthropic", "claude-3-7-sonnet-20250219"), [{ role: "user", content: "hi" }], [], [])) {
      events.push(ev as { type: string; text?: string });
    }

    const thinkingEvents = events.filter((e) => e.type === "thinking_delta");
    const textEvents = events.filter((e) => e.type === "text_delta" || e.type === "text");
    expect(thinkingEvents.map((e) => e.text).join("")).toBe("Let me think carefully.");
    expect(textEvents.map((e) => e.text).join("")).toBe("Final answer.");
    // 顺序：思考应全部出现在正文之前
    const firstTextIdx = events.findIndex((e) => e.type === "text_delta" || e.type === "text");
    const lastThinkingIdx = events.map((e) => e.type).lastIndexOf("thinking_delta");
    expect(lastThinkingIdx).toBeLessThan(firstTextIdx);
  });

  it("非流式思考模型：thinking_delta 与正文都送达（不丢正文）", async () => {
    const fetchMock = vi.fn(async () => json(anthropicNonStreamThinkingBody));
    vi.stubGlobal("fetch", fetchMock);

    const events: Array<{ type: string; text?: string }> = [];
    for await (const ev of streamCall(makeModel("anthropic", "claude-3-7-sonnet-20250219"), [{ role: "user", content: "hi" }], [], [])) {
      events.push(ev as { type: string; text?: string });
    }

    const thinkingEvents = events.filter((e) => e.type === "thinking_delta");
    const textEvents = events.filter((e) => e.type === "text_delta" || e.type === "text");
    expect(thinkingEvents.map((e) => e.text).join("")).toBe("Offline thought.");
    // 关键回归点：非流式兜底必须把最终正文也下发，不能因为思考存在而丢弃
    expect(textEvents.map((e) => e.text).join("")).toBe("Offline answer.");
  });
});
