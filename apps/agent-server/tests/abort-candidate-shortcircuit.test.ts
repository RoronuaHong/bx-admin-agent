// 中止必须短路候选链（第 5 批 C1，事故复盘 §4.3 第 4 行 / 时间线 L7）。
//
// 事故形态：run 被无进展看门狗 abort 之后，候选链把剩余 10 个模型各打 3 次瞬时重试，
// 全部 0-2ms 立即中断——白产 39 条无效 span 与成倍日志噪音，用户侧早就不看了。
// 对标 AWS「只在调用栈的一层重试；重试必须被预算约束，否则局部故障被放大成系统性过载」。
//
// 本文件钉住三件事：① abort 后不再尝试剩余候选；② 不再发起模型调用（轮首守卫）；
// ③ 已取到的结论仍由补位收尾交付（第 2 批 P1-4 的中止收尾不被本改动破坏）。
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
process.env.WRAP_UP_ON_ABORT_DEADLINE_MS = "20000";

function toolCallChunk(id: string, name: string, args: unknown): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
  })}`;
}
function textChunk(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`;
}
function sse(lines: string[]): string {
  return lines.concat("data: [DONE]").join("\n\n") + "\n\n";
}

/** 按模型计数：mockb 的任何一次请求都算短路失败。 */
const calls: Record<string, number> = { mocka: 0, mockb: 0 };

handler = async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let buf = "";
    for await (const c of req) buf += c;
    const body = JSON.parse(buf) as { model?: string; tools?: unknown[] };
    const model = String(body.model || "");
    calls[model] = (calls[model] || 0) + 1;
    if (!body.tools?.length) {
      // 无工具 = 中止后的补位收尾调用（第 2 批 P1-4，独立 deadline，不受已中止 signal 影响）。
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse([textChunk("中止收尾：已取到的部分如下；没跑完的部分如实标注为未完成。")]));
      return;
    }
    if (model === "mocka" && calls[model] === 1) {
      // 第 1 轮读一次工作区文件：制造接地证据，供随后的中止收尾使用。
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse([toolCallChunk("c1", "fs_read", { path: "evidence.txt" })]));
      return;
    }
    // 其余任何带工具的请求都不该发生（短路失效的显性标记）。
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`unexpected call to ${model} #${calls[model]}`);
    return;
  }
  res.writeHead(404);
  res.end();
};

let chatStream: (typeof import("../src/chat.js"))["chatStream"];
let createConversation: (typeof import("../src/conversations.js"))["createConversation"];
let fsRemoveConversation: (typeof import("../src/fs-store.js"))["fsRemoveConversation"];
let fsWrite: (typeof import("../src/fs-store.js"))["fsWrite"];
let setTraceDirForTest: (dir?: string) => void;
let traceDir = "";

beforeAll(async () => {
  traceDir = mkdtempSync(join(tmpdir(), "trace-abort-short-"));
  ({ setTraceDirForTest } = await import("../src/trace.js"));
  setTraceDirForTest(traceDir);
  ({ chatStream } = await import("../src/chat.js"));
  ({ createConversation } = await import("../src/conversations.js"));
  ({ fsRemoveConversation, fsWrite } = await import("../src/fs-store.js"));
});

afterAll(() => {
  server.close();
  setTraceDirForTest();
  if (traceDir) rmSync(traceDir, { recursive: true, force: true });
});

test("abort 后短路候选链：剩余候选不再尝试、不再发起模型调用、结论仍交付", async () => {
  const convId = "verify-abort-shortcircuit";
  const conv = await createConversation({ id: convId, title: "verify" });
  (conv as { mcpServers: string[]; model: string }).mcpServers = ["mock"];
  (conv as { model: string }).model = "mocka";
  fsWrite(convId, "evidence.txt", "已有资料：口径与分区规则。");

  const controller = new AbortController();
  const models: string[] = [];
  const texts: string[] = [];
  let aborted = false;
  for await (const ev of chatStream(
    convId,
    "按已有资料给我结论",
    { sessionId: "abort-short" },
    controller.signal,
    { runId: "run_abort_shortcircuit" },
  )) {
    if (ev.type === "model") models.push(ev.id);
    if (ev.type === "text") texts.push(ev.text);
    // 与真实事故同时序：拿到第一个工具结果就被看门狗/用户中止。
    if (!aborted && ev.type === "tool_result") {
      aborted = true;
      controller.abort();
    }
  }
  fsRemoveConversation(convId);

  expect(aborted, "测试前提：确实在拿到工具结果后中止了").toBe(true);
  expect(calls.mockb, "abort 后不得再尝试剩余候选（事故里剩余 10 个各打 3 次）").toBe(0);
  // mocka 只有两次请求：第 1 轮工具调用 + 中止后的补位收尾；轮首守卫挡掉了第 2 轮。
  expect(calls.mocka, "轮首守卫：abort 后不再发起模型调用").toBe(2);
  expect(models).toEqual(["mocka"]);
  const final = texts.join("");
  expect(final, "已产出的结论仍由补位收尾交付（P1-4 不被破坏）").toContain("中止收尾");
  expect(final).not.toContain("unexpected call");

  // llm span 只有 1 条（第 1 轮）：abort 之后没有成批的瞬时中断记录（fixture 的显式期望）。
  const spanFile = resolve(traceDir, "spans-run_abort_shortcircuit.jsonl");
  const llmSpans = existsSync(spanFile)
    ? readFileSync(spanFile, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((s) => s.kind === "llm")
    : [];
  expect(llmSpans.length, "abort 后不应再产生 llm span").toBe(1);
}, 30000);
