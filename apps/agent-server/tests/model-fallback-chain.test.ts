// 模型候选链完整性回归（2026-10-12 定时预警事故）：
// 事故链 = 首轮执行 write_todos → 次轮模型 429 → sideEffects 护栏把「有副作用不能换模型重跑」
// 误触发 → 付费兜底候选一个没试 → 失败收束且调度侧没拿到状态码 → 钉钉不推送。
// 本文件验证三件事：
// ① write_todos（纯对话内部状态）不算副作用——次轮模型失败后候选链继续，下一个候选正常接棒；
// ② 全部候选失败 → usage 事件带 modelStatus 状态码（调度侧据此记 failed 并推送企业 IM）；
// ③ 正文是人话说明（不带上游 JSON），与既有行为一致。
// 复用 deep-agent-live / schedule-unattended-conclusion 的 mock 手法：本地 mock OpenAI SSE 服务驱动真实 chatStream。
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// 临时端口（listen 0）：固定端口会与「被杀测试进程的孤儿监听」撞 EADDRINUSE，且 env 必须在
// import chat.js 前就绪，所以 mock server 在模块加载期就启动、端口随即写进模型配置。
let handler: http.RequestListener = () => {};
const server = http.createServer((req, res) => handler(req, res));
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const PORT = (server.address() as AddressInfo).port;

// env 必须在 import 前设置（chat.ts 的常量在模块加载时读取）。
process.env.MONGO_URI = "mongodb://127.0.0.1:1"; // 端口拒绝 → 降级内存
process.env.MODEL_PROVIDERS = "mocka,mockb";
for (const id of ["mocka", "mockb"]) {
  const key = id.toUpperCase();
  process.env[`MODEL_${key}_PROVIDER`] = "openai";
  process.env[`MODEL_${key}_NAME`] = id;
  process.env[`MODEL_${key}_BASE_URL`] = `http://127.0.0.1:${PORT}/v1`;
  process.env[`MODEL_${key}_API_KEY`] = "x";
  process.env[`MODEL_${key}_CONTEXT_WINDOW`] = "128000";
}

function textChunk(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`;
}

function sse(lines: string[]): string {
  return lines.concat("data: [DONE]").join("\n\n") + "\n\n";
}

function toolCallChunk(id: string, name: string, args: unknown): string {
  return `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  })}`;
}

function rateLimited(res: http.ServerResponse): void {
  // 纯 429、正文不带 quota / free-tier 等字样：命中「换下一个候选」路径，但不进冷却表（不污染后续用例）。
  res.writeHead(429, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "rate limited" } }));
}

// 按模型名计数：mocka 的第 1 次带工具请求返回 write_todos（复现事故首轮），之后一律 429；mockb 先成功后 429。
const calls: Record<string, number> = { mocka: 0, mockb: 0 };

handler = async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let buf = "";
    for await (const c of req) buf += c;
    const body = JSON.parse(buf) as { model?: string; tools?: unknown[] };
    const model = String(body.model || "");
    if (!body.tools?.length) {
      // 无工具 = 辅助调用（本场景不该出现，兜底给一句正文避免挂死）。
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const aux = textChunk("辅助调用");
      res.end(sse([aux]));
      return;
    }
    calls[model] = (calls[model] || 0) + 1;
    if (model === "mocka") {
      // 复现事故时序：第 1 轮写任务计划（纯对话内部状态），第 2 轮起一律 429。
      if (calls[model] === 1) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(sse([toolCallChunk("c1", "write_todos", { todos: [{ content: "取数并判定", status: "pending" }] })]));
      } else {
        rateLimited(res);
      }
      return;
    }
    // mockb：第 1 轮取一次接地证据（工作区读工具，工作区读取算证据），第 2 轮给结论，之后 429。
    if (calls[model] === 1) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse([toolCallChunk("c2", "fs_glob", { pattern: "*.md" })]));
    } else if (calls[model] === 2) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse([textChunk("候选链接棒成功：这是 mockb 的结论。")]));
    } else {
      rateLimited(res);
    }
  } else {
    res.writeHead(404);
    res.end();
  }
};

interface RunResult {
  text: string;
  modelFallbacks: number;
  modelStatus?: string;
  models: string[];
}

let chatStream: (typeof import("../src/chat.js"))["chatStream"];
let createConversation: (typeof import("../src/conversations.js"))["createConversation"];
let fsRemoveConversation: (typeof import("../src/fs-store.js"))["fsRemoveConversation"];

beforeAll(async () => {
  // chat.ts 的常量在模块加载时读取 env，此时 mock 端口已定，动态 import 即可。
  ({ chatStream } = await import("../src/chat.js"));
  ({ createConversation } = await import("../src/conversations.js"));
  ({ fsRemoveConversation } = await import("../src/fs-store.js"));
});

afterAll(() => {
  server.close();
});

async function run(conversationId: string): Promise<RunResult> {
  await createConversation({ id: conversationId, title: "fallback-chain", mcpServers: ["mock"] });
  const result: RunResult = { text: "", modelFallbacks: -1, models: [] };
  for await (const ev of chatStream(conversationId, "给我结论", { sessionId: `chain-${conversationId}` }, undefined)) {
    if (ev.type === "text") result.text += ev.text;
    else if (ev.type === "model") result.models.push(ev.id);
    else if (ev.type === "usage") {
      result.modelFallbacks = ev.modelFallbacks;
      result.modelStatus = ev.modelStatus;
    }
  }
  fsRemoveConversation(conversationId);
  return result;
}

test("首轮 write_todos 后次轮模型 429 → 候选链继续，下一个候选接棒出结论", async () => {
  const r = await run("chain-write-todos");
  // 修复前：write_todos 计入副作用 → 直接 break → 正文是 429 失败说明，mockb 根本没被调用。
  expect(r.models, `应切换到 mockb，实际事件流：${r.models.join(",")}`).toContain("mockb");
  expect(r.text).toContain("候选链接棒成功");
  expect(r.modelFallbacks).toBeGreaterThanOrEqual(1);
}, 30000);

test("全部候选失败 → usage 带模型状态码 + 正文是人话说明（调度侧据此推送）", async () => {
  const r = await run("chain-all-down");
  // 两个候选都 429：候选链打满而不是中途折断，调度侧靠 modelStatus 把本期记 failed 并推企业 IM。
  expect(r.modelStatus).toBe("429");
  expect(r.modelFallbacks).toBeGreaterThanOrEqual(2);
  expect(r.text).toContain("模型返回 429");
  expect(r.text).not.toContain("rate limited"); // 上游原文不进气泡
}, 30000);
