// 运行级重试预算（第 5 批 C3，对标 AWS《Timeouts, Retries, and Backoff with Jitter》
// 「重试预算（token bucket）：限制整个调用群体的重试总量；只设最大次数防不住重试风暴」）。
//
// 每轮 MODEL_CALL_RETRIES 只管一层；候选数 × 轮次 × key 轮换叠起来仍可放大。
// 本文件钉住：整个 run 的总重试次数受 MODEL_RUN_RETRY_BUDGET 约束，跨候选共享
// （切模型不重置），耗尽后只失败不重试（快速换候选 / 收束）。
//
// 注入方式：mock 对每个请求都**直接销毁 socket**（无响应）→ 网络类失败（fetch failed），
// 属于 isTransientModelError 的瞬态错误，走重试路径；状态码类错误不走（见 models.ts 分层）。
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
  process.env[`MODEL_${key}_PROVIDER`] = "openai";
  process.env[`MODEL_${key}_NAME`] = id;
  process.env[`MODEL_${key}_BASE_URL`] = `http://127.0.0.1:${PORT}/v1`;
  process.env[`MODEL_${key}_API_KEY`] = "x";
  process.env[`MODEL_${key}_CONTEXT_WINDOW`] = "128000";
}

const calls: Record<string, number> = { mocka: 0, mockb: 0 };

handler = (req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    // 先读 body 再销毁：确保服务端已完整收到请求（否则请求可能根本没发出去）。
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      try {
        const model = String(JSON.parse(buf).model || "");
        calls[model] = (calls[model] || 0) + 1;
      } catch {
        /* body 不完整：不计 */
      }
      res.socket?.destroy(); // 无响应直接断：客户端侧 fetch failed（瞬态）
    });
    return;
  }
  res.writeHead(404);
  res.end();
};

let chatStream: (typeof import("../src/chat.js"))["chatStream"];
let createConversation: (typeof import("../src/conversations.js"))["createConversation"];
let fsRemoveConversation: (typeof import("../src/fs-store.js"))["fsRemoveConversation"];

beforeAll(async () => {
  ({ chatStream } = await import("../src/chat.js"));
  ({ createConversation } = await import("../src/conversations.js"));
  ({ fsRemoveConversation } = await import("../src/fs-store.js"));
});

afterAll(() => {
  server.close();
});

async function run(conversationId: string): Promise<{ text: string; modelStatus?: string }> {
  await createConversation({ id: conversationId, title: "retry-budget", mcpServers: ["mock"] });
  const out: { text: string; modelStatus?: string } = { text: "" };
  for await (const ev of chatStream(conversationId, "给我结论", { sessionId: `rb-${conversationId}` })) {
    if (ev.type === "text") out.text += ev.text;
    else if (ev.type === "usage") out.modelStatus = ev.modelStatus;
  }
  fsRemoveConversation(conversationId);
  return out;
}

test("预算=1：整个 run 只重试一次——mocka 用掉它，mockb 一次都不重试", async () => {
  calls.mocka = 0;
  calls.mockb = 0;
  const saved = process.env.MODEL_RUN_RETRY_BUDGET;
  process.env.MODEL_RUN_RETRY_BUDGET = "1";
  try {
    await run("rb-budget-1");
  } finally {
    if (saved === undefined) delete process.env.MODEL_RUN_RETRY_BUDGET;
    else process.env.MODEL_RUN_RETRY_BUDGET = saved;
  }
  // mocka：首发失败 → 重试 1 次（预算 1→0）→ 再失败 → 预算耗尽，换候选。
  expect(calls.mocka, "预算内的重试照常发生").toBe(2);
  // mockb：预算已耗尽 → 只失败不重试（旧行为会再打 3 次）。
  expect(calls.mockb, "跨候选共享：切模型不重置预算").toBe(1);
}, 60000);

test("预算=8（默认）：每个候选仍可按每轮上限重试（预算不收紧正常路径）", async () => {
  calls.mocka = 0;
  calls.mockb = 0;
  const saved = process.env.MODEL_RUN_RETRY_BUDGET;
  process.env.MODEL_RUN_RETRY_BUDGET = "8";
  try {
    await run("rb-budget-8");
  } finally {
    if (saved === undefined) delete process.env.MODEL_RUN_RETRY_BUDGET;
    else process.env.MODEL_RUN_RETRY_BUDGET = saved;
  }
  // 每轮上限 MODEL_CALL_RETRIES=2 → 每候选最多 3 次；两个候选共 4 次重试 ≤ 8，全部放行。
  expect(calls.mocka).toBe(3);
  expect(calls.mockb).toBe(3);
}, 60000);
