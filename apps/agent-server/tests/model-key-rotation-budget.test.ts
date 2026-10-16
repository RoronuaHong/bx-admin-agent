// 多 key 轮换纳入运行级重试预算（第 8 批，对齐 AWS《Timeouts, Retries, and Backoff with Jitter》
// 「只在一层重试」与「重试预算」）。
//
// 为什么单独钉：轮换在 models.ts 里是**独立的一层**——它不知道 chat.ts 那一份 run 级预算的存在，
// 于是「key 数 × 每层重试数」会乘起来（事故复盘里 abort 后的 39 条无效调用就是多层叠加）。
// 现在换下一个 key 之前先过同一个 `canRetry()`，取不到预算就停止横向铺开，
// 把失败响应原样交回上层（走冷却分类 / 切候选）。
//
// 注入方式：mock 恒定 429（可重试状态码）→ 轮换本会一路试完整个 key 池。
// 预算=1 时只允许换一次 key（2 次请求），预算充足时才允许试满池子（3 次请求）。
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
// mocka 走「多 key 池」分支（config.ts 只对 NVIDIA 端点启用共享池，这里借路径命中该判定，
// 请求仍打到本地 mock）；mockb 是普通单 key，用来验证预算**跨候选共享**。
process.env.NVIDIA_API_KEYS = "k1,k2,k3";
for (const id of ["mocka", "mockb"]) {
  const key = id.toUpperCase();
  process.env[`MODEL_${key}_PROVIDER`] = "openai";
  process.env[`MODEL_${key}_NAME`] = id;
  process.env[`MODEL_${key}_BASE_URL`] =
    id === "mocka" ? `http://127.0.0.1:${PORT}/integrate.api.nvidia.com` : `http://127.0.0.1:${PORT}/v1`;
  process.env[`MODEL_${key}_API_KEY`] = "x";
  process.env[`MODEL_${key}_CONTEXT_WINDOW`] = "128000";
}

const calls: Record<string, number> = { mocka: 0, mockb: 0 };

handler = (req, res) => {
  if (req.method === "POST" && (req.url || "").endsWith("/chat/completions")) {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      try {
        const model = String(JSON.parse(buf).model || "");
        calls[model] = (calls[model] || 0) + 1;
      } catch {
        /* body 不完整：不计 */
      }
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limit exceeded" } }));
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

async function run(conversationId: string): Promise<void> {
  await createConversation({ id: conversationId, title: "key-rotation", mcpServers: ["mock"] });
  for await (const _ev of chatStream(conversationId, "给我结论", { sessionId: `kr-${conversationId}` })) {
    /* 只跑流程，不关心事件内容 */
  }
  fsRemoveConversation(conversationId);
}

test("预算=1：轮换只能换一次 key（3 个 key 的池子只发 2 次请求），且预算跨候选共享", async () => {
  calls.mocka = 0;
  calls.mockb = 0;
  const saved = process.env.MODEL_RUN_RETRY_BUDGET;
  process.env.MODEL_RUN_RETRY_BUDGET = "1";
  try {
    await run("kr-budget-1");
  } finally {
    if (saved === undefined) delete process.env.MODEL_RUN_RETRY_BUDGET;
    else process.env.MODEL_RUN_RETRY_BUDGET = saved;
  }
  // key1 失败 → 取预算（1→0）换 key2 → 再失败 → 预算耗尽，停止轮换。
  expect(calls.mocka, "轮换受预算管制：不再一路试完整个池子").toBe(2);
  // 换候选后预算不重置：mockb 单 key，一次都不重试。
  expect(calls.mockb, "跨候选共享同一份预算").toBe(1);
}, 60000);

test("预算充足：轮换照旧试满整个池子（预算不收紧正常路径）", async () => {
  calls.mocka = 0;
  calls.mockb = 0;
  const saved = process.env.MODEL_RUN_RETRY_BUDGET;
  process.env.MODEL_RUN_RETRY_BUDGET = "8";
  try {
    await run("kr-budget-8");
  } finally {
    if (saved === undefined) delete process.env.MODEL_RUN_RETRY_BUDGET;
    else process.env.MODEL_RUN_RETRY_BUDGET = saved;
  }
  expect(calls.mocka, "3 个 key 全试完（旧行为不变）").toBe(3);
  expect(calls.mockb).toBeGreaterThanOrEqual(1);
}, 60000);
