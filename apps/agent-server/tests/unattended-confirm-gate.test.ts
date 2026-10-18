// 无人值守与「完全访问」的边界：
// - 定时运行没人能应答确认卡：需确认的调用一律拒绝，不因 fullAccess=true 直接执行；
// - 创建 / 恢复定时任务属于扩权：即使交互对话开着完全访问也必须确认。
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { confirmIgnoresFullAccess } from "../src/risk.js";

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

test("confirmIgnoresFullAccess：只覆盖 manage_schedule 的 create / resume，参数坏了按需确认", () => {
  expect(confirmIgnoresFullAccess("manage_schedule", JSON.stringify({ action: "create", prompt: "x" }))).toBe(true);
  expect(confirmIgnoresFullAccess("manage_schedule", JSON.stringify({ action: "resume", id: "s1" }))).toBe(true);
  expect(confirmIgnoresFullAccess("manage_schedule", JSON.stringify({ action: "pause", id: "s1" }))).toBe(false);
  expect(confirmIgnoresFullAccess("manage_schedule", JSON.stringify({ action: "delete", id: "s1" }))).toBe(false);
  expect(confirmIgnoresFullAccess("manage_schedule", "{not json")).toBe(true);
  expect(confirmIgnoresFullAccess("fs_write", JSON.stringify({ action: "create" }))).toBe(false);
});

let step = 0;
const server = http.createServer(async (req, res) => {
  for await (const _ of req) void _;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const n = step++;
  const payload =
    n === 0
      ? { choices: [{ delta: { tool_calls: [{ index: 0, id: "c0", function: { name: "mcp__ghost__wipe", arguments: "{}" } }] } }] }
      : { choices: [{ delta: { content: "[NO_DATA] 本期没有取到数据。" } }] };
  res.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
});

let chatStream: (typeof import("../src/chat.js"))["chatStream"];
let createConversation: (typeof import("../src/conversations.js"))["createConversation"];

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.MODEL_MOCK_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  ({ chatStream } = await import("../src/chat.js"));
  ({ createConversation } = await import("../src/conversations.js"));
});
afterAll(() => server.close());

test("定时运行（fullAccess 默认 true）：需确认的调用被拒，不弹确认卡、不执行", async () => {
  const conv = await createConversation({ id: "verify-unattended-gate", title: "gate" });
  (conv as { model: string }).model = "mock";
  const events: { type: string; text?: string }[] = [];
  for await (const ev of chatStream(
    "verify-unattended-gate",
    "检查一下",
    { sessionId: "unattended-session", forceWrapUp: true, unattendedConclusion: "alert" },
    undefined,
  )) {
    events.push(ev as { type: string; text?: string });
  }
  expect(events.some((ev) => ev.type === "confirmation_required")).toBe(false);
  const refused = events.find((ev) => ev.type === "tool_result");
  expect(refused?.text).toMatch(/无人值守运行不执行需要人工确认的操作/);
});
