// 跨轮重复调用「观察提示」端到端验证（2026-09-24，docs/artifact-delivery-plan.md §12.4）：
// 同参调用跨轮重复执行时（数据可能需要刷新，故不硬拦），回灌给模型的工具结果应附带
// 「第 N 轮已执行过同参调用」的观察提示——对齐 Anthropic「观察 → 再决策」：
// 让模型基于已有结果继续，而不是像实测会话那样重新探查（浪费 3-4 轮预算）。
// 复用 deep-agent-live 的 mock 手法：本地 mock OpenAI SSE 服务驱动真实 runLoop。
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";

// env 必须在 import 前设置（chat.ts 的常量在模块加载时读取）。
process.env.MONGO_URI = "mongodb://127.0.0.1:1";
process.env.MODEL_PROVIDERS = "mock";
process.env.MODEL_MOCK_PROVIDER = "openai";
process.env.MODEL_MOCK_NAME = "mock";
process.env.MODEL_MOCK_BASE_URL = "http://127.0.0.1:8793/v1";
process.env.MODEL_MOCK_API_KEY = "x";
process.env.MODEL_MOCK_CONTEXT_WINDOW = "128000";
process.env.MCP_MAX_TOOL_ROUNDS = "4";

const PORT = 8793;
let stepN = 0;
/** 模型上下文里出现过「第 N 轮已执行过同参调用」提示（检查 tool 消息内容）。 */
let sawRepeatHint = false;

function toolCallChunk(calls: Array<{ id: string; name: string; args?: unknown }>): string {
  const payload = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: calls.map((c, i) => ({
            index: i,
            id: c.id,
            function: {
              name: c.name,
              ...(c.args !== undefined ? { arguments: JSON.stringify(c.args) } : {}),
            },
          })),
        },
      },
    ],
  });
  return `data: ${payload}`;
}

function textChunk(text: string): string {
  const payload = JSON.stringify({ choices: [{ delta: { content: text } }] });
  return `data: ${payload}`;
}

function sse(lines: string[]): string {
  return lines.concat("data: [DONE]").join("\n\n") + "\n\n";
}

// 每轮返回**完全相同**的调用（同路径同内容 = 同签名）：第 1、2 轮的回灌应带跨轮重复提示。
function sseRepeatCall(step: number): string {
  return sse([
    textChunk(`第 ${step} 轮：继续写入同一份结果。`),
    toolCallChunk([{ id: `call_${step}`, name: "fs_write", args: { path: "results/same.md", content: "同一份内容" } }]),
  ]);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let buf = "";
    for await (const c of req) buf += c;
    const body = JSON.parse(buf) as {
      tools?: unknown[];
      messages?: Array<{ role?: string; content?: string }>;
    };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (!body.tools?.length) {
      // 无工具调用：补位收尾（轮次/熔断收束后触发），回最终结论。
      res.end(sse([textChunk("收尾结论：重复写入已按提示收敛，基于已有结果完成总结。")]));
      return;
    }
    for (const m of body.messages || []) {
      if (m.role === "tool" && String(m.content).includes("该调用与第")) sawRepeatHint = true;
    }
    res.end(sseRepeatCall(stepN++));
  } else {
    res.writeHead(404);
    res.end();
  }
});

let chatStream: (typeof import("../src/chat.js"))["chatStream"];
let createConversation: (typeof import("../src/conversations.js"))["createConversation"];
let fsRemoveConversation: (typeof import("../src/fs-store.js"))["fsRemoveConversation"];

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  ({ chatStream } = await import("../src/chat.js"));
  ({ createConversation } = await import("../src/conversations.js"));
  ({ fsRemoveConversation } = await import("../src/fs-store.js"));
});

afterAll(() => {
  server.close();
});

test("同参调用跨轮重复执行 → 模型上下文收到「第 N 轮已执行过」观察提示", async () => {
  const conv = await createConversation({ id: "verify-repeat", title: "verify" });
  (conv as { mcpServers: string[]; model: string }).mcpServers = ["mock"];
  (conv as { model: string }).model = "mock";

  const texts: string[] = [];
  for await (const ev of chatStream("verify-repeat", "反复写同一份结果", { sessionId: "repeat-session" }, undefined)) {
    if (ev.type === "text") texts.push((ev as { text: string }).text);
  }
  fsRemoveConversation("verify-repeat");

  expect(sawRepeatHint, "跨轮同参调用的回灌应带「第 N 轮已执行过」提示").toBe(true);
  expect(texts.join(""), "收束文本应是补位收尾的结论").toContain("收尾结论");
}, 25000);
