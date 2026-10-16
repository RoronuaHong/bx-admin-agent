// 模型额度预检（第 5 批 C4，对标 OpenRouter《Limits》「长任务开始前查剩余额度；非紧急请求排到下一个 UTC 日」）。
//
// 事故形态：候选链开场把 4 个当日免费额度已耗尽的模型各打一遍。冷却表解决「同一 UTC 日内不重打」，
// 但进程冷启动后的第一个请求仍要重撞——预检在排候选之前问一次密钥额度端点（GET /api/v1/key，
// 形状为 { data: { free_model_daily_requests: { used, limit, remaining } } }，2026-10-14 实测）。
//
// 本文件钉住：① 解析与耗尽判定是纯函数（limit 缺失不判——没有分母的百分比没有意义）；
// ② 无人值守 + 额度耗尽 → 候选整体跳过（排到下一个 UTC 日），一个模型调用都不发；
// ③ 交互式 + 额度耗尽 → fail-open（预检可能过期/误报，照旧尝试，只是排到队尾）；
// ④ 端点不可用 → fail-open，不影响对话。
import { test, expect, beforeEach, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  findExhaustedQuotaModels,
  parseKeyQuota,
  quotaExhausted,
  resetQuotaPreflightForTest,
} from "../src/model-quota.js";

// ── 纯函数 ────────────────────────────────────────────────────────────────
test("[A] 解析 /api/v1/key 实测形状；字段缺失返回 null（fail-open）", () => {
  // 2026-10-14 对真实端点探测到的形状（脱敏）。
  const real = {
    data: {
      is_free_tier: false,
      limit: null,
      limit_remaining: null,
      free_model_daily_requests: { used: 54, limit: 50, remaining: 0 },
    },
  };
  expect(parseKeyQuota(real)).toEqual({ used: 54, limit: 50, remaining: 0 });
  expect(parseKeyQuota({ data: {} })).toBeNull();
  expect(parseKeyQuota({ data: { free_model_daily_requests: { used: 1 } } })).toBeNull();
  expect(parseKeyQuota(null)).toBeNull();
  expect(parseKeyQuota("garbage")).toBeNull();
});

test("[B] 耗尽判定：remaining<=0 且 limit>0；limit 缺失绝不判（防字段变更误杀健康模型）", () => {
  expect(quotaExhausted({ used: 54, limit: 50, remaining: 0 })).toBe(true);
  expect(quotaExhausted({ used: 10, limit: 50, remaining: 40 })).toBe(false);
  expect(quotaExhausted({ used: 0, limit: 0, remaining: 0 }), "没有分母不判").toBe(false);
  expect(quotaExhausted(null)).toBe(false);
});

// ── 端到端：mock 同时充当「模型端点」与「额度端点」 ─────────────────────────
let handler: http.RequestListener = () => {};
const server = http.createServer((req, res) => handler(req, res));
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const PORT = (server.address() as AddressInfo).port;

process.env.MONGO_URI = "mongodb://127.0.0.1:1";
// 让 127.0.0.1 的 mock 端点也走预检（默认只认 openrouter.ai；生产不需要这个开关）。
process.env.MODEL_QUOTA_PREFLIGHT_HOSTS = "127.0.0.1";
process.env.MODEL_PROVIDERS = "mockq";
process.env.MODEL_MOCKQ_PROVIDER = "openai";
process.env.MODEL_MOCKQ_NAME = "mockq";
process.env.MODEL_MOCKQ_BASE_URL = `http://127.0.0.1:${PORT}/v1`;
process.env.MODEL_MOCKQ_API_KEY = "k-preflight";
process.env.MODEL_MOCKQ_CONTEXT_WINDOW = "128000";

/** 额度端点返回的剩余次数（按用例改写）；null = 端点不可用（404）。 */
let quotaRemaining: number | null = 0;
/** 模型端点被调用过的次数（端到端断言的核心；含事后核验等无工具辅助调用）。 */
let chatCalls = 0;
/** 其中带工具的代理轮次数（预检有没有把对话挡在门外的判据）。 */
let toolRoundCalls = 0;
/** 主代理轮次游标：第 0 轮读一次工作区文件（制造接地证据，避开零证据护栏），第 1 轮给结论。 */
let step = 0;

function toolCallChunk(id: string, name: string, args: unknown): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
  })}`;
}
function textChunk(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`;
}
function sse(lines: string[]): string {
  return lines.concat("data: [DONE]").join("\n\n") + "\n\n";
}

handler = async (req, res) => {
  if (req.method === "GET" && req.url === "/api/v1/key") {
    if (quotaRemaining === null) {
      res.writeHead(404);
      res.end("no such endpoint");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data: { free_model_daily_requests: { used: 50 - quotaRemaining, limit: 50, remaining: quotaRemaining } },
      }),
    );
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let buf = "";
    for await (const c of req) buf += c;
    const body = JSON.parse(buf) as { tools?: unknown[] };
    chatCalls += 1;
    if (body.tools?.length) toolRoundCalls += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (step === 0) {
      step += 1;
      res.end(sse([toolCallChunk("c1", "fs_read", { path: "evidence.txt" })]));
      return;
    }
    res.end(sse([textChunk("预检放行后的正常结论。")]));
    return;
  }
  res.writeHead(404);
  res.end();
};

let chatStream: (typeof import("../src/chat.js"))["chatStream"];
let createConversation: (typeof import("../src/conversations.js"))["createConversation"];
let fsRemoveConversation: (typeof import("../src/fs-store.js"))["fsRemoveConversation"];
let fsWrite: (typeof import("../src/fs-store.js"))["fsWrite"];

beforeEach(async () => {
  resetQuotaPreflightForTest();
  ({ chatStream } = await import("../src/chat.js"));
  ({ createConversation } = await import("../src/conversations.js"));
  ({ fsRemoveConversation, fsWrite } = await import("../src/fs-store.js"));
});

afterAll(() => {
  server.close();
});

async function run(conversationId: string, opts: { forceWrapUp?: boolean } = {}) {
  step = 0;
  chatCalls = 0;
  toolRoundCalls = 0;
  await createConversation({ id: conversationId, title: "quota-preflight", mcpServers: ["mock"] });
  // 供第 0 轮 fs_read 取证据（有证据的结论轮才不会被零证据护栏作废，与既有 fallback 测试同手法）。
  fsWrite(conversationId, "evidence.txt", "已有资料：口径与分区规则。");
  const out: { text: string; modelStatus?: string } = { text: "" };
  for await (const ev of chatStream(conversationId, "给我结论", { sessionId: `qp-${conversationId}`, ...opts })) {
    if (ev.type === "text") out.text += ev.text;
    else if (ev.type === "usage") out.modelStatus = ev.modelStatus;
  }
  fsRemoveConversation(conversationId);
  return out;
}

test("[C] 无人值守 + 额度耗尽 → 候选整体跳过（排到下一个 UTC 日），一个模型调用都不发", async () => {
  quotaRemaining = 0;
  const r = await run("qp-unattended", { forceWrapUp: true });
  expect(chatCalls, "额度已耗尽时不应再打模型端点").toBe(0);
  expect(r.modelStatus, "调度侧据此把本期记 failed 并推送").toBe("429");
  expect(r.text).toContain("429");
}, 30000);

test("[D] 交互式 + 额度耗尽 → fail-open：照旧尝试（预检可能过期/误报，不能替用户做决定）", async () => {
  quotaRemaining = 0;
  const r = await run("qp-interactive");
  // 两个代理轮 = 第 0 轮取证据 + 第 1 轮结论；没有被预检挡在门外
  // （事后核验等无工具辅助调用不计——它们不是代理轮）。
  expect(toolRoundCalls, "交互式只把耗尽模型排到队尾，不断对话").toBe(2);
  expect(r.text).toContain("预检放行后的正常结论");
}, 30000);

test("[E] 额度端点不可用（404）→ fail-open：不影响候选链与对话", async () => {
  quotaRemaining = null;
  const r = await run("qp-endpoint-down");
  expect(toolRoundCalls).toBe(2);
  expect(r.text).toContain("预检放行后的正常结论");
}, 30000);

test("[F] 按密钥聚合：不同密钥各查一次，同密钥一次查询回答所有候选", async () => {
  quotaRemaining = 0;
  const mk = (id: string) => ({
    id,
    label: id,
    provider: "openai" as const,
    name: id,
    baseUrl: `http://127.0.0.1:${PORT}/v1`,
    apiKey: `key-${id}`,
    apiKeys: [`key-${id}`],
    vision: "none" as const,
    timeoutMs: 1000,
    contextWindow: 128000,
  });
  const exhausted = await findExhaustedQuotaModels([mk("m1"), mk("m2"), mk("m3")]);
  // 三个模型各自一把密钥 → 三个都该被查出耗尽（同密钥会合并，这里刻意不同）。
  expect([...exhausted].sort()).toEqual(["m1", "m2", "m3"]);
}, 30000);
