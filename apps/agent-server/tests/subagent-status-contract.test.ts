// 子代理结构化回传契约（第 3 批 P1-3）。
//
// 事故形态（2026-10-14）：子代理回传只有 `ok + 摘要文本`，第 23 轮那个被看门狗取消的
// 子代理空转 7.5 分钟，父轮把「被取消」当普通失败静默吞掉——既没续跑也没给用户一句交代。
//
// 对标 Anthropic 子代理隔离的结构化返回契约（status/coverage/errors）：
//   ① 四种状态：success / partial / no_findings / failed——「没找到」与「没跑完」必须分得清；
//   ② 零发现/失败**不计入父轮接地证据**（不得当结论）；
//   ③ fail-closed：状态缺失/越界按失败处理。
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { subagentHandoffText, SUBAGENT_STATUS_LABEL } from "../src/chat.js";

// ── 纯函数：交接文本的四种状态与 fail-closed ──────────────────────────────
test("[A] 交接文本：四种状态各有各的人话标签，coverage/errors 结构化呈现", () => {
  const success = subagentHandoffText({
    status: "success",
    ok: true,
    text: "结论：已按口径汇总。",
    toolCalls: 3,
    coverage: "模型轮次 2",
  });
  expect(success).toContain("已完成");
  expect(success).toContain("覆盖面：模型轮次 2");
  expect(success).toContain("结论：已按口径汇总。");

  const noFindings = subagentHandoffText({
    status: "no_findings",
    ok: true,
    text: "（子代理未返回内容）",
    toolCalls: 0,
  });
  expect(noFindings).toContain("已跑完但未发现目标内容");
  expect(noFindings).not.toContain("未完成");

  const failed = subagentHandoffText({
    status: "failed",
    ok: false,
    text: "子代理已被取消。",
    toolCalls: 2,
    errors: ["运行被中止，子代理未跑完"],
  });
  expect(failed).toContain("未完成（失败或被中止）");
  expect(failed).toContain("运行被中止，子代理未跑完");

  const partial = subagentHandoffText({
    status: "partial",
    ok: true,
    text: "部分结论",
    toolCalls: 5,
    coverage: "模型轮次 3",
    errors: ["预算耗尽"],
  });
  expect(partial).toContain("部分完成");
  expect(partial).toContain("预算耗尽");
});

test("[B] fail-closed：状态缺失/越界按「未完成」呈现，绝不冒充已完成", () => {
  const weird = subagentHandoffText({
    status: "something_else" as never,
    ok: true,
    text: "x",
    toolCalls: 1,
  });
  expect(weird).toContain(SUBAGENT_STATUS_LABEL.failed);
  expect(weird).not.toContain("已完成");
});

// ── 端到端：mock SSE 驱动真实主循环，父轮按结构化状态分流 ──────────────────
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
// 子代理空转场景：两轮就够（空正文 → 提示一次 → 再空 → 收束），别把测试拖慢。
process.env.SUBAGENT_MAX_ROUNDS = "2";

function toolCallChunk(name: string, args: unknown, id: string): string {
  return "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: id, function: { name: name, arguments: JSON.stringify(args) } }] } }] });
}
function textChunk(text: string): string {
  return "data: " + JSON.stringify({ choices: [{ delta: { content: text } }] });
}
function sse(lines: string[]): string {
  return lines.join("\n\n") + "\n\ndata: [DONE]\n\n";
}

/** 主代理第 0 轮的委派参数（按场景改写）与轮次游标。 */
let taskArgs: Record<string, unknown> = { description: "核对口径" };
let mainStep = 0;
let subagentCalls = 0;
/** 端到端里观察到的 task 工具回传（父轮实际拿到的东西）。 */
let taskHandoffs: Array<{ ok: boolean; text: string }> = [];

handler = async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let buf = "";
    for await (const c of req) buf += c;
    const body = JSON.parse(buf) as { tools?: unknown[]; messages?: Array<{ content?: string }> };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    // 子代理的系统提示是 SUBAGENT_PROMPT（含「执行子代理」），主代理不是——据此分剧本。
    const isSubagent = (body.messages || []).some((m) => (m.content || "").includes("执行子代理"));
    if (isSubagent) {
      subagentCalls += 1;
      // 零发现：子代理两轮都只回空正文（不调工具）。
      res.end(sse([textChunk("")]));
      return;
    }
    const step = mainStep++;
    if (step === 0) {
      res.end(sse([textChunk("先委派一个子任务。"), toolCallChunk("task", taskArgs, "call_task")]));
      return;
    }
    res.end(sse([textChunk("父轮结论：按结构化状态如实收束。")]));
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

afterAll(() => server.close());

async function runOnce(convId: string, args: Record<string, unknown>): Promise<string> {
  mainStep = 0;
  subagentCalls = 0;
  taskHandoffs = [];
  taskArgs = args;
  const conv = await createConversation({ id: convId, title: "verify" });
  (conv as { mcpServers: string[]; model: string }).mcpServers = ["mock"];
  (conv as { model: string }).model = "mock";

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...parts: unknown[]) => {
    logs.push(parts.map((p) => String(p)).join(" "));
  };
  let finalText = "";
  try {
    for await (const ev of chatStream(convId, "核对一下口径", { sessionId: "subagent-contract" })) {
      if (ev.type === "tool_result" && ev.name === "task") {
        taskHandoffs.push({ ok: ev.ok, text: ev.text });
      }
      if (ev.type === "text") finalText = ev.text;
    }
  } finally {
    console.log = origLog;
    fsRemoveConversation(convId);
  }
  // 「不计入证据」的可观测面：没有任何接地证据时不会打整合提示。
  expect(logs.some((line) => line.includes("[chat:integrate]")), "零发现/失败不得计入父轮证据").toBe(false);
  return finalText;
}

test("[C] 子代理启动期失败（servers 无可用工具）→ 父轮拿到结构化 failed，不当成普通结果", async () => {
  await runOnce("verify-subagent-failed", { description: "核对口径", servers: ["nonexistent-server"] });
  expect(subagentCalls, "servers 不可用时子代理根本不会启动").toBe(0);
  expect(taskHandoffs).toHaveLength(1);
  expect(taskHandoffs[0]!.ok).toBe(false);
  expect(taskHandoffs[0]!.text).toContain("未完成（失败或被中止）");
  expect(taskHandoffs[0]!.text).toContain("没有可用工具");
}, 30000);

test("[D] 子代理零发现 → 父轮拿到 no_findings：ok=true 但不得当结论", async () => {
  const finalText = await runOnce("verify-subagent-nofindings", { description: "核对口径" });
  expect(subagentCalls, "零发现场景子代理确实跑了两轮").toBeGreaterThan(0);
  expect(taskHandoffs).toHaveLength(1);
  expect(taskHandoffs[0]!.ok).toBe(true);
  expect(taskHandoffs[0]!.text).toContain("已跑完但未发现目标内容");
  // 父轮照常收束（结构化状态给了它「如实标注未取到」的依据），且没有伪造证据。
  expect(finalText).toContain("父轮结论");
}, 30000);
