// 轮次预算耗尽的「补位收尾」端到端验证（2026-09-24，docs/artifact-delivery-plan.md §12）：
// 模型一路调工具打满轮次上限、从未出现「综合轮」时，交互式运行也必须以**结论**收束，
// 而不是把各轮过程叙述的拼接（实测会停在「我现在去做 X：」的悬空半句）直接当答案返回。
// 复用 deep-agent-live 的 mock 手法：本地 mock OpenAI SSE 服务驱动真实 runLoop（无需真实模型）。
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";

// env 必须在 import 前设置（chat.ts 的常量在模块加载时读取）。
process.env.MONGO_URI = "mongodb://127.0.0.1:1"; // 端口拒绝 → 降级内存
process.env.MODEL_PROVIDERS = "mock";
process.env.MODEL_MOCK_PROVIDER = "openai";
process.env.MODEL_MOCK_NAME = "mock";
process.env.MODEL_MOCK_BASE_URL = "http://127.0.0.1:8791/v1";
process.env.MODEL_MOCK_API_KEY = "x";
process.env.MODEL_MOCK_CONTEXT_WINDOW = "128000";
// 轮次上限压到 3：mock 模型每轮都调工具 → 第 3 轮打满 → 必须触发补位收尾（生产默认 14）。
process.env.MCP_MAX_TOOL_ROUNDS = "3";

const PORT = 8791;
let stepN = 0;
/** 无工具请求的标记：补位收尾的用户内容含「过程记录」（区别于其他无工具调用）。 */
let sawWrapUpCall = false;

type ToolCallArg = { id: string; name: string; args?: unknown };

function toolCallChunk(calls: ToolCallArg[]): string {
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

const WRAP_UP_REPLY = "收尾结论：前两步写入已完成，最后声明的追加写入没来得及执行，已在结果文件中如实交代。";

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let buf = "";
    for await (const c of req) buf += c;
    const body = JSON.parse(buf) as { tools?: unknown[]; messages?: Array<{ content?: string }> };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    // 无工具调用：补位收尾（内容含「过程记录」标记）或护栏判定调用（不影响判定，回什么都行）。
    if (!body.tools?.length) {
      const last = body.messages?.at(-1)?.content || "";
      if (String(last).includes("过程记录")) sawWrapUpCall = true;
      res.end(sse([textChunk(WRAP_UP_REPLY)]));
      return;
    }
    // 每轮都调工具（路径各异，避免 Doom Loop 熔断与同轮去重干扰），从不给出综合轮。
    // 与真实模型一致：工具轮也带一段过程叙述（否则 text 累计为空，补位收尾无从谈起）。
    const step = stepN++;
    res.end(
      sse([
        textChunk(`第 ${step} 步：把本步产出写入结果文件。`),
        toolCallChunk([
          {
            id: `call_${step}`,
            name: "fs_write",
            args: { path: `results/step-${step}.md`, content: `第 ${step} 步产出` },
          },
        ]),
      ]),
    );
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

test("轮次耗尽无综合轮 → 补位收尾把过程叙述换成结论（而不是悬空半句）", async () => {
  const conv = await createConversation({ id: "verify-wrapup", title: "verify" });
  (conv as { mcpServers: string[]; model: string }).mcpServers = ["mock"];
  (conv as { model: string }).model = "mock";

  const texts: string[] = [];
  for await (const ev of chatStream("verify-wrapup", "做一个需要多步写入的任务", { sessionId: "wrapup-session" }, undefined)) {
    if (ev.type === "text") texts.push((ev as { text: string }).text);
  }
  fsRemoveConversation("verify-wrapup");

  expect(sawWrapUpCall, "轮次打满后应发生一次无工具的补位收尾调用").toBe(true);
  const final = texts.join("");
  expect(final, "最终答案应是补位收尾的结论").toContain("收尾结论");
  // 悬空半句不该出现在最终答案里：mock 的工具轮叙述没有产生任何收尾前的正式文本，
  // 若回归到「累计叙述拼接」，最终答案就不会包含补位收尾的话。
}, 25000);
