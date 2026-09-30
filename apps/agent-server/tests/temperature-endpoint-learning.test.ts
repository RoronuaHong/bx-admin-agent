import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callAgent, disableThinkingSupported, temperatureSupported } from "../src/models.js";
import { config } from "../src/config.js";
import type { ModelEntry } from "../src/config.js";

// 端点「整字段拒收」的学习与回滚：实测 TokenHub kimi 系不接受 temperature（任何值都 400，缺省反而正常）。
// 本组用例锁住两件事：①记住之后**后续调用**天然不再带该字段（不能只在自愈重发那一次省略）；
// ②自愈无效时回滚记忆，不把「按报错措辞做的推测」固化成永久行为。

function makeModel(id: string): ModelEntry {
  return {
    id,
    label: id,
    provider: "openai",
    name: id,
    baseUrl: "https://api.example.com/v1",
    apiKey: "k",
    apiKeys: ["k"],
    vision: "none",
    timeoutMs: 1000,
    contextWindow: 128000,
  };
}

/** 网关抱怨原文（实测形态）：MaaS 内部组件拒收请求体，不点名具体字段。 */
const MAAS_REJECTED = JSON.stringify({
  error: {
    type: "invalid_request_error",
    message: "The request is invalid: the request was rejected by an internal MaaS component.",
  },
});

const okSse = ['data: {"choices":[{"delta":{"content":"CHAT"}}]}', "data: [DONE]"].join("\n");

function sse(): Response {
  return new Response(okSse, { status: 200, headers: { "content-type": "text/event-stream" } });
}

beforeEach(() => {
  config.maxOutputTokens = 8192;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("temperature 端点学习：拒收 → 记住 → 后续调用天然省略", () => {
  it("首跳被拒 → 同轮省略重发；记住后第二次调用一次即过（不再白打 400）", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    // 行为化 mock（按网关语义）：带 temperature 就 400，不带就放行——断言的是「客户端是否满足网关要求」。
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        const body = init?.body ? JSON.parse(init.body) : null;
        bodies.push(body);
        return body && "temperature" in body ? new Response(MAAS_REJECTED, { status: 400 }) : sse();
      }),
    );

    const model = makeModel("probe-temp-learn");
    // 判定型内部调用：温度归零（接地护栏的分诊 / 兜底走的就是这条路径）
    const res = await callAgent(model, [{ role: "user", content: "hi" }], [], undefined, undefined, { temperature: 0 });

    expect(bodies).toHaveLength(2); // 首跳被拒 + 省略字段重发一次
    expect(bodies[0]!.temperature).toBe(0);
    expect(bodies[1]!.temperature).toBeUndefined();
    expect(res.text).toBe("CHAT"); // 重发结果正常返回，不把 400 抛给上层
    expect(temperatureSupported(model)).toBe(false);

    // 核心回归点：记住之后的新调用必须一开始就省略该字段。
    // 修复前 postOnce 默认仍带 temperature，而自愈分支又因「已记住」被跳过 → 每次都 400 并抛错，
    // 表现为接地护栏的分诊/兜底调用永久失败、闲聊被误判成数据问题回确定性兜底文案。
    bodies.length = 0;
    const second = await callAgent(model, [{ role: "user", content: "hi" }], [], undefined, undefined, { temperature: 0 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.temperature).toBeUndefined();
    expect(second.text).toBe("CHAT");
  });

  it("自愈无效（省略后仍失败）→ 回滚记忆并如实抛错，不把推测固化", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    // 网关无论如何都 400：说明根因不是 temperature，省略它救不了。
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        calls += 1;
        bodies.push(init?.body ? JSON.parse(init.body) : null);
        return new Response(MAAS_REJECTED, { status: 400 });
      }),
    );

    const model = makeModel("probe-temp-rollback");
    await expect(
      callAgent(model, [{ role: "user", content: "hi" }], [], undefined, undefined, { temperature: 0 }),
    ).rejects.toThrow(/400/);
    expect(calls).toBe(2); // 只试一次自愈，不无限重试
    // 记忆必须回滚：否则下一次调用会永久丢掉一个本可携带的参数，真实原因也被掩盖。
    expect(temperatureSupported(model)).toBe(true);

    // 回滚后的新调用照常带上 temperature（未被误判污染）
    bodies.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        bodies.push(init?.body ? JSON.parse(init.body) : null);
        return sse();
      }),
    );
    await callAgent(model, [{ role: "user", content: "hi" }], [], undefined, undefined, { temperature: 0 });
    expect(bodies[0]!.temperature).toBe(0);
  });

  it("未学过该端点的模型照常带 temperature（学习是 per-endpoint，不株连其它模型）", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        bodies.push(init?.body ? JSON.parse(init.body) : null);
        return sse();
      }),
    );
    await callAgent(makeModel("probe-temp-plain"), [{ role: "user", content: "hi" }], [], undefined, undefined, { temperature: 0 });
    expect(bodies[0]!.temperature).toBe(0);
    // 主对话不设温度 → 永远不带该字段（判定型参数只属于辅助调用）
    await callAgent(makeModel("probe-temp-main"), [{ role: "user", content: "hi" }], [], undefined, undefined, {});
    expect(bodies[1]!.temperature).toBeUndefined();
  });

  it("报错不点名字段、且同时带了关思考：去掉 temperature 仍失败后，再去掉两个字段重发", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    // 实测 kimi 辅助调用：temperature 与 thinking:{type:disabled} 任一在场都是同一句 MaaS 400，不点名字段。
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
        bodies.push(body || {});
        const thinking = body?.thinking as { type?: string } | undefined;
        const rejected = body && ("temperature" in body || thinking?.type === "disabled");
        return rejected ? new Response(MAAS_REJECTED, { status: 400 }) : sse();
      }),
    );

    const model = makeModel("probe-temp-and-thinking");
    const res = await callAgent(model, [{ role: "user", content: "hi" }], [], undefined, undefined, {
      temperature: 0,
      disableThinking: true,
    });

    expect(res.text).toBe("CHAT");
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    expect(bodies[0]!.temperature).toBe(0);
    expect((bodies[0]!.thinking as { type?: string }).type).toBe("disabled");
    const passed = bodies[bodies.length - 1]!;
    expect(passed.temperature).toBeUndefined();
    expect(passed.thinking).toBeUndefined();
    expect(temperatureSupported(model)).toBe(false);
    expect(disableThinkingSupported(model)).toBe(false);

    bodies.length = 0;
    const second = await callAgent(model, [{ role: "user", content: "hi" }], [], undefined, undefined, {
      temperature: 0,
      disableThinking: true,
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.temperature).toBeUndefined();
    expect(bodies[0]!.thinking).toBeUndefined();
    expect(second.text).toBe("CHAT");
  });

  it("两个字段都去掉仍失败 → 两份记忆都回滚", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return new Response(MAAS_REJECTED, { status: 400 });
      }),
    );
    const model = makeModel("probe-temp-and-thinking-rollback");
    await expect(
      callAgent(model, [{ role: "user", content: "hi" }], [], undefined, undefined, {
        temperature: 0,
        disableThinking: true,
      }),
    ).rejects.toThrow(/400/);
    expect(calls).toBe(3);
    expect(temperatureSupported(model)).toBe(true);
    expect(disableThinkingSupported(model)).toBe(true);
  });
});
