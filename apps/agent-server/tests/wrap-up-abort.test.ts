// 「运行被外部中止」时的受控收尾（第 2 批 P1-4）。
//
// 事故形态（2026-10-14）：第 23 轮委派子代理后被无进展看门狗 abort，当时已取到 39 条证据，
// 但收束路径的条件是 `!synthesisText && !failure` —— abort 让 failure 非空，于是补位收尾
// 被跳过，39 条证据全废，只落一句「工具已经返回结果，但没有写出结论。」
//
// 对标 Anthropic《Building Effective Agents》：达到迭代/时间/预算上限属于**受控停止**，
// 要求「返回当前最佳结果并说明未完成」，而不是丢弃。本测试钉住这条。
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
process.env.MODEL_PROVIDERS = "mock";
process.env.MODEL_MOCK_PROVIDER = "openai";
process.env.MODEL_MOCK_NAME = "mock";
process.env.MODEL_MOCK_BASE_URL = "http://127.0.0.1:" + PORT + "/v1";
process.env.MODEL_MOCK_API_KEY = "x";
process.env.MODEL_MOCK_CONTEXT_WINDOW = "128000";
// 中止后补位的独立 deadline：给足余量，测试要断言的是「补位真的发出了」而不是「超时」。
process.env.WRAP_UP_ON_ABORT_DEADLINE_MS = "20000";

let sawWrapUpCall = false;
let toolRounds = 0;

function toolCallChunk(name: string, args: unknown, id: string): string {
  return "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: id, function: { name: name, arguments: JSON.stringify(args) } }] } }] });
}
function textChunk(text: string): string {
  return "data: " + JSON.stringify({ choices: [{ delta: { content: text } }] });
}
function sse(lines: string[]): string {
  return lines.join("\n\n") + "\n\ndata: [DONE]\n\n";
}

const WRAP_UP_REPLY = "中止收尾：已经查到的部分如下；没查完的那一项因为运行被中断没有取到。";

handler = async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let buf = "";
    for await (const c of req) buf += c;
    const body = JSON.parse(buf) as { tools?: unknown[]; messages?: Array<{ content?: string }> };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (!body.tools?.length) {
      // 无工具 = 收尾调用（中止后那次也在此列：它用的是独立 deadline，不受已中止 signal 影响）。
      sawWrapUpCall = true;
      res.end(sse([textChunk(WRAP_UP_REPLY)]));
      return;
    }
    // 工具轮：先读一个已存在的工作区文件（读类工具算接地证据），
    // 再写一个文件——刻意跨两轮，给测试留出 abort 的时机。
    const step = toolRounds++;
    if (step === 0) {
      res.end(sse([textChunk("先读一下已有资料。"), toolCallChunk("fs_read", { path: "evidence.txt" }, "call_read")]));
      return;
    }
    res.end(sse([textChunk("继续第 2 步。"), toolCallChunk("fs_write", { path: "results/s2.md", content: "第 2 步" }, "call_w")]));
    return;
  }
  res.writeHead(404);
  res.end();
};

let chatStream: (typeof import("../src/chat.js"))["chatStream"];
let createConversation: (typeof import("../src/conversations.js"))["createConversation"];
let fsRemoveConversation: (typeof import("../src/fs-store.js"))["fsRemoveConversation"];
let fsWrite: (typeof import("../src/fs-store.js"))["fsWrite"];

beforeAll(async () => {
  ({ chatStream } = await import("../src/chat.js"));
  ({ createConversation } = await import("../src/conversations.js"));
  ({ fsRemoveConversation, fsWrite } = await import("../src/fs-store.js"));
});

afterAll(() => server.close());

test("取到证据后被外部中止 → 仍执行一次收尾并给出结论（修复前落通用兜底句、证据全废）", async () => {
  const convId = "verify-wrapup-abort";
  const conv = await createConversation({ id: convId, title: "verify" });
  (conv as { mcpServers: string[]; model: string }).mcpServers = ["mock"];
  (conv as { model: string }).model = "mock";
  // 造一个可读的工作区文件：第一轮 fs_read 成功即产生接地证据。
  fsWrite(convId, "evidence.txt", "已有资料：指标口径与分区规则。");

  const controller = new AbortController();
  const texts: string[] = [];
  let aborted = false;
  for await (const ev of chatStream(convId, "按已有资料给我一份结论", { sessionId: "wua-session" }, controller.signal)) {
    if (ev.type === "text") texts.push((ev as { text: string }).text);
    // 第一次拿到工具结果就模拟看门狗/用户取消：与真实事故的时序一致（证据已在手，循环被中止）。
    if (!aborted && ev.type === "tool_result") {
      aborted = true;
      controller.abort();
    }
  }
  fsRemoveConversation(convId);

  expect(aborted, "测试前提：确实在拿到工具结果后中止了").toBe(true);
  expect(sawWrapUpCall, "中止后仍应发出一次无工具的收尾调用（用独立 deadline，不被已中止 signal 挡住）").toBe(true);
  const final = texts.join("");
  expect(final, "最终答案应是中止收尾的结论").toContain("中止收尾");
  expect(final, "不该落通用兜底句——那正是事故里用户看到的").not.toContain("工具已经返回结果，但没有写出结论");
}, 30000);


