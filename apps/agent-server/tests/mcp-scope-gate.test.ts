// MCP 作用域闸：hub 按工具名在所有已连接服务器里查找。本次运行没有启用的服务器上的工具，
// 无论模型直接点名、还是借 count_list_by_time 代调，都不能抵达 callMcpTool。
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../src/mcp/hub.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mcp/hub.js")>();
  return { ...actual, callMcpTool: vi.fn(async () => ({ isError: false, text: "SHOULD-NOT-RUN" })) };
});

process.env.MONGO_URI = "mongodb://127.0.0.1:1";
process.env.MODEL_PROVIDERS = "mock";
process.env.MODEL_MOCK_PROVIDER = "openai";
process.env.MODEL_MOCK_NAME = "mock";
process.env.MODEL_MOCK_API_KEY = "x";
process.env.MODEL_MOCK_CONTEXT_WINDOW = "128000";
process.env.AUTONOMY_MIN_RUNS = "99999";

let step = 0;
function sse(lines: string[]): string {
  return lines.concat("data: [DONE]").join("\n\n") + "\n\n";
}
function toolCall(id: string, name: string, args: unknown): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] })}`;
}
function text(t: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}`;
}

const server = http.createServer(async (req, res) => {
  for await (const _ of req) void _;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const n = step++;
  if (n === 0) res.end(sse([toolCall("c0", "mcp__ghost__drop_everything", { confirm: true })]));
  else if (n === 1)
    res.end(sse([toolCall("c1", "count_list_by_time", { tool: "mcp__ghost__list", payload: { from_time: 1, to_time: 2 } })]));
  else res.end(sse([text("结束。")]));
});

let chatStream: (typeof import("../src/chat.js"))["chatStream"];
let createConversation: (typeof import("../src/conversations.js"))["createConversation"];
let callMcpTool: (typeof import("../src/mcp/hub.js"))["callMcpTool"];

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.MODEL_MOCK_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  ({ chatStream } = await import("../src/chat.js"));
  ({ createConversation } = await import("../src/conversations.js"));
  ({ callMcpTool } = await import("../src/mcp/hub.js"));
});
afterAll(() => server.close());

test("未启用服务器上的工具：直接点名与 count_list_by_time 代调都被拒，callMcpTool 零调用", async () => {
  const conv = await createConversation({ id: "verify-mcp-scope", title: "scope", mcpServers: [] });
  (conv as { model: string }).model = "mock";
  const results: string[] = [];
  for await (const ev of chatStream("verify-mcp-scope", "清理一下", { sessionId: "scope-session" }, undefined)) {
    if (ev.type === "tool_result") results.push(String((ev as { text?: string }).text ?? ""));
  }
  expect(vi.mocked(callMcpTool)).not.toHaveBeenCalled();
  expect(results.join("\n")).toMatch(/不在本次运行启用的连接器里/);
});
