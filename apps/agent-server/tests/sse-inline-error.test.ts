// 流内错误帧必须被识别（2026-10-14 事故复盘 §5 P1-5①）。
// 盲区形态：网关在流式响应已发出 200 之后才把限流/配额错误写进 SSE（错误对象 +
// finish_reason:"error"）。原实现只读 choices[0].delta，于是整轮读成「模型空回合」——
// 不记状态码、不进冷却表、不切候选。本次事故未暴露（429 都在流开始前），属靠运气没翻车。
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

let handler: http.RequestListener = () => {};
const server = http.createServer((req, res) => handler(req, res));
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const PORT = (server.address() as AddressInfo).port;

process.env.MONGO_URI = "mongodb://127.0.0.1:1";
process.env.MODEL_PROVIDERS = "mocka,mockb";
for (const id of ["mocka", "mockb"]) {
  const key = id.toUpperCase();
  process.env["MODEL_" + key + "_PROVIDER"] = "openai";
  process.env["MODEL_" + key + "_NAME"] = id;
  process.env["MODEL_" + key + "_BASE_URL"] = "http://127.0.0.1:" + PORT + "/v1";
  process.env["MODEL_" + key + "_API_KEY"] = "x";
  process.env["MODEL_" + key + "_CONTEXT_WINDOW"] = "128000";
}

function frame(obj: unknown): string {
  return "data: " + JSON.stringify(obj) + "\n\n";
}
function textChunk(text: string): string {
  return frame({ choices: [{ delta: { content: text } }] });
}
/** 流中错误帧：HTTP 已是 200，错误只在 SSE 里 —— 这正是原实现看不见的那一帧。 */
function inlineErrorFrame(message: string, code: number): string {
  return frame({ error: { code: code, message: message }, choices: [{ delta: { content: "" }, finish_reason: "error" }] });
}
function sse(lines: string[]): string {
  return lines.join("") + "data: [DONE]\n\n";
}

handler = async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let buf = "";
    for await (const c of req) buf += c;
    const model = String((JSON.parse(buf) as { model?: string }).model || "");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    // mocka：先吐一点正文（流真的开始了）再吐错误帧 —— 越像真实故障越能证明修复有效。
    res.end(
      model === "mocka"
        ? sse([textChunk("我先查一下数据"), inlineErrorFrame("Rate limit exceeded: free-models-per-day", 429)])
        : sse([textChunk("备用模型给出的结论。")]),
    );
    return;
  }
  res.writeHead(404);
  res.end();
};

interface RunResult {
  text: string;
  models: string[];
  modelFallbacks: number;
}

let chatStream: (typeof import("../src/chat.js"))["chatStream"];
let createConversation: (typeof import("../src/conversations.js"))["createConversation"];
let fsRemoveConversation: (typeof import("../src/fs-store.js"))["fsRemoveConversation"];
let normalizeInlineStreamError: (typeof import("../src/models.js"))["normalizeInlineStreamError"];
let isModelDownFailure: (typeof import("../src/chat.js"))["isModelDownFailure"];
let isDailyQuotaFailure: (typeof import("../src/chat.js"))["isDailyQuotaFailure"];

beforeAll(async () => {
  ({ chatStream } = await import("../src/chat.js"));
  ({ createConversation } = await import("../src/conversations.js"));
  ({ fsRemoveConversation } = await import("../src/fs-store.js"));
  ({ normalizeInlineStreamError } = await import("../src/models.js"));
  ({ isModelDownFailure, isDailyQuotaFailure } = await import("../src/chat.js"));
});

afterAll(() => server.close());

async function run(conversationId: string): Promise<RunResult> {
  await createConversation({ id: conversationId, title: "sse-inline-error", mcpServers: ["mock"] });
  const result: RunResult = { text: "", models: [], modelFallbacks: -1 };
  for await (const ev of chatStream(conversationId, "给我结论", { sessionId: "sse-" + conversationId }, undefined)) {
    if (ev.type === "text") result.text += ev.text;
    else if (ev.type === "model") result.models.push(ev.id);
    else if (ev.type === "usage") result.modelFallbacks = ev.modelFallbacks;
  }
  fsRemoveConversation(conversationId);
  return result;
}

test("归一化：错误对象 / finish_reason=error / 无显式码三类都要认，正常帧不误判", () => {
  const byObject = normalizeInlineStreamError({
    error: { code: 429, message: "Rate limit exceeded: free-models-per-day" },
  });
  expect(byObject).toContain("model http 429");
  expect(normalizeInlineStreamError({ choices: [{ delta: {}, finish_reason: "error" }] })).toContain("model http");
  // 无显式码：文案命中限流/配额必须归 429，否则配额型错误只会被当 502 冷却 10 分钟
  expect(normalizeInlineStreamError({ error: { message: "quota exceeded for free models" } })).toContain("429");
  expect(normalizeInlineStreamError({ error: { message: "upstream exploded" } })).toContain("502");
  expect(normalizeInlineStreamError({ choices: [{ delta: { content: "hi" } }] })).toBeNull();
  expect(normalizeInlineStreamError({ choices: [{ delta: {}, finish_reason: "stop" }] })).toBeNull();
});

test("归一化后的配额型流内错误：必须被判为模型级失败（进冷却 + 切候选，不当空回合重试）", () => {
  const normalized = normalizeInlineStreamError({
    error: { code: 429, message: "Rate limit exceeded: free-models-per-day" },
  });
  expect(normalized).not.toBeNull();
  expect(isModelDownFailure(normalized)).toBe(true);
  expect(isDailyQuotaFailure(normalized)).toBe(true);
});

test("端到端：流内 429 必须切到下一个候选并给出结论（修复前读成空回合、耗尽重试后失败）", async () => {
  const r = await run("sse-inline-error-chain");
  expect(r.models, "应先试 mocka 再切到 mockb，实际：" + r.models.join(",")).toEqual(["mocka", "mockb"]);
  expect(r.text).toContain("备用模型");
  expect(r.modelFallbacks).toBeGreaterThanOrEqual(1);
}, 30000);
