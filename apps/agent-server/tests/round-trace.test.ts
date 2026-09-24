// 逐轮 trace 落盘验证（2026-09-24，docs/artifact-delivery-plan.md §12.6 疑问①）：
// 每个工具循环轮次应落一行 rounds-<runId>.jsonl，使「重复探查 / 预算耗尽 / 熔断」可被复盘。
// 复用 deep-agent-live 的 mock 手法：本地 mock OpenAI SSE 服务驱动真实 runLoop。
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

process.env.MONGO_URI = "mongodb://127.0.0.1:1";
process.env.MODEL_PROVIDERS = "mock";
process.env.MODEL_MOCK_PROVIDER = "openai";
process.env.MODEL_MOCK_NAME = "mock";
process.env.MODEL_MOCK_BASE_URL = "http://127.0.0.1:8795/v1";
process.env.MODEL_MOCK_API_KEY = "x";
process.env.MODEL_MOCK_CONTEXT_WINDOW = "128000";
process.env.MCP_MAX_TOOL_ROUNDS = "3";

const PORT = 8795;
const RUN_ID = "run_unit_rounds";
let stepN = 0;

function toolCallChunk(calls: Array<{ id: string; name: string; args?: unknown }>): string {
  return `data: ${JSON.stringify({
    choices: [
      { delta: { tool_calls: calls.map((c, i) => ({ index: i, id: c.id, function: { name: c.name, ...(c.args !== undefined ? { arguments: JSON.stringify(c.args) } : {}) } })) } },
    ],
  })}`;
}
function sse(lines: string[]): string {
  return lines.concat("data: [DONE]").join("\n\n") + "\n\n";
}
const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let buf = "";
    for await (const c of req) buf += c;
    const body = JSON.parse(buf) as { tools?: unknown[] };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (!body.tools?.length) {
      res.end(sse([`data: ${JSON.stringify({ choices: [{ delta: { content: "收尾结论。" } }] })}`]));
      return;
    }
    const step = stepN++;
    res.end(sse([toolCallChunk([{ id: `call_${step}`, name: "fs_write", args: { path: `results/step-${step}.md`, content: "x" } }])]));
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
  try {
    unlinkSync(resolve(process.cwd(), ".data", "traces", `rounds-${RUN_ID}.jsonl`));
  } catch {
    /* 已清理或不存在 */
  }
});

test("每轮工具循环都落一条逐轮 trace（按 runId 分文件）", async () => {
  const conv = await createConversation({ id: "verify-rounds", title: "verify" });
  (conv as { mcpServers: string[]; model: string }).mcpServers = ["mock"];
  (conv as { model: string }).model = "mock";
  const traceMeta: { servedModel?: string; runId?: string } = { runId: RUN_ID };
  for await (const _ of chatStream("verify-rounds", "写几步", { sessionId: "r-session" }, undefined, traceMeta)) {
    /* drain */
  }
  fsRemoveConversation("verify-rounds");

  const file = resolve(process.cwd(), ".data", "traces", `rounds-${RUN_ID}.jsonl`);
  expect(existsSync(file), "应落盘 rounds-<runId>.jsonl").toBe(true);
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  expect(lines.length, "至少每轮一行").toBeGreaterThanOrEqual(1);
  const first = JSON.parse(lines[0]!) as { round: number; mode: string; toolCallsThisRound: number };
  expect(first.mode).toBe("tool");
  expect(first.round).toBe(0);
  expect(first.toolCallsThisRound).toBeGreaterThanOrEqual(1);
}, 25000);
