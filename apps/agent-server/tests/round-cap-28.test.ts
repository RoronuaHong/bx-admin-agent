// 轮次预算对齐验证（2026-09-28）：交互式默认 MAX_TOOL_ROUNDS 已从 14 提到 28。
// 本测试用 mock LLM 驱动真实 runLoop，模拟「多步取数→出图→导出」类任务（每轮调一个写工具，
// 第 17 轮给最终结论），断言在 28 轮预算下任务能跑满 16 个工具轮并完成导出，不再被上限截断。
// 与 wrap-up-cap.test.ts 同手法（deep-agent-live mock SSE），不依赖真实模型/数据源。
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";

process.env.MONGO_URI = "mongodb://127.0.0.1:1"; // 端口拒绝 → 降级内存
process.env.MODEL_PROVIDERS = "mock";
process.env.MODEL_MOCK_PROVIDER = "openai";
process.env.MODEL_MOCK_NAME = "mock";
process.env.MODEL_MOCK_BASE_URL = "http://127.0.0.1:8797/v1";
process.env.MODEL_MOCK_API_KEY = "x";
process.env.MODEL_MOCK_CONTEXT_WINDOW = "128000";
process.env.MCP_MAX_TOOL_ROUNDS = "28"; // 对齐新默认

const PORT = 8797;
const TARGET_TOOL_ROUNDS = 16; // 任务需要的工具轮数（>14，正好踩在旧上限之上）
let stepN = 0;

function toolCallChunk(calls: { id: string; name: string; args: unknown }[]): string {
  const payload = JSON.stringify({
    choices: [{ delta: { tool_calls: calls.map((c, i) => ({ index: i, id: c.id, function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }],
  });
  return `data: ${payload}`;
}
function textChunk(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`;
}
function sse(lines: string[]): string {
  return lines.concat("data: [DONE]").join("\n\n") + "\n\n";
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let buf = "";
    for await (const c of req) buf += c;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (stepN < TARGET_TOOL_ROUNDS) {
      const step = stepN++;
      // 每轮调不同路径的写工具（避免 Doom Loop 熔断与同轮去重），并带过程叙述。
      res.end(sse([textChunk(`第 ${step} 步：写入本步产物。`), toolCallChunk([{ id: `call_${step}`, name: "fs_write", args: { path: `results/step-${step}.md`, content: `第 ${step} 步产出` } }])]));
    } else {
      res.end(sse([textChunk("EXPORT DONE：已生成汇总与导出文件。")]));
    }
    return;
  }
  res.writeHead(404);
  res.end();
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
afterAll(() => server.close());

test("默认 28 轮预算：16 步工具任务可完整跑完并导出（不再被上限截断）", async () => {
  const conv = await createConversation({ id: "verify-cap28", title: "verify" });
  (conv as { model: string }).model = "mock";
  let toolRounds = 0;
  let finalText = "";
  for await (const ev of chatStream("verify-cap28", "做一个需要多步写入并导出的任务", { sessionId: "cap28-session" }, undefined)) {
    if (ev.type === "tool_call" && (ev as { name: string }).name === "fs_write") toolRounds++;
    if (ev.type === "text") finalText += (ev as { text: string }).text;
  }
  fsRemoveConversation("verify-cap28");
  expect(toolRounds, "工具轮数应达到任务所需的 16（远超旧上限 14）").toBe(TARGET_TOOL_ROUNDS);
  expect(finalText, "最终应完成导出").toContain("EXPORT DONE");
}, 30000);
