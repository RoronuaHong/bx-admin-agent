// 对照基线：同样的 16 步工具任务，在旧上限 14 下应当在第 14 轮被截断，导出永远到不了。
// 用以证明「把交互式默认从 14 提到 28」确实解开了这类多产物任务的收尾截断。
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";

process.env.MONGO_URI = "mongodb://127.0.0.1:1";
process.env.MODEL_PROVIDERS = "mock";
process.env.MODEL_MOCK_PROVIDER = "openai";
process.env.MODEL_MOCK_NAME = "mock";
process.env.MODEL_MOCK_BASE_URL = "http://127.0.0.1:8796/v1";
process.env.MODEL_MOCK_API_KEY = "x";
process.env.MODEL_MOCK_CONTEXT_WINDOW = "128000";
process.env.MCP_MAX_TOOL_ROUNDS = "14"; // 旧上限

const PORT = 8796;
const TARGET_TOOL_ROUNDS = 16;
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

test("旧上限 14：同样的 16 步任务在第 14 轮被截断，导出未完成", async () => {
  const conv = await createConversation({ id: "verify-cap14", title: "verify" });
  (conv as { model: string }).model = "mock";
  let toolRounds = 0;
  let finalText = "";
  for await (const ev of chatStream("verify-cap14", "做一个需要多步写入并导出的任务", { sessionId: "cap14-session" }, undefined)) {
    if (ev.type === "tool_call" && (ev as { name: string }).name === "fs_write") toolRounds++;
    if (ev.type === "text") finalText += (ev as { text: string }).text;
  }
  fsRemoveConversation("verify-cap14");
  expect(toolRounds, "工具轮数应被截断在 14（旧上限）").toBe(14);
  expect(finalText, "旧上限下导出永远到不了").not.toContain("EXPORT DONE");
}, 30000);
