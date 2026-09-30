// 两阶段事后核验的端到端验证（2026-09-30，docs/grounding-verify-alignment.md）：
// 拿到部分证据、但回答里夹了证据之外的断言时，护栏要作废并回灌纠正；
// 且**判定环节不能看到原回答**（CoVe 的独立性）——这是两阶段相对一步式的核心收益。
// 复用 deep-agent-live 的 mock 手法：本地 mock OpenAI SSE 服务驱动真实 chatStream（无需真实模型）。
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";

// env 必须在 import 前设置（chat.ts 的常量在模块加载时读取）。
process.env.MONGO_URI = "mongodb://127.0.0.1:1"; // 端口拒绝 → 降级内存
process.env.MODEL_PROVIDERS = "mock";
process.env.MODEL_MOCK_PROVIDER = "openai";
process.env.MODEL_MOCK_NAME = "mock";
process.env.MODEL_MOCK_BASE_URL = "http://127.0.0.1:8903/v1";
process.env.MODEL_MOCK_API_KEY = "x";
process.env.MODEL_MOCK_CONTEXT_WINDOW = "128000";
process.env.GROUNDING_VERIFY_STAGES = "two";

// 端口避开 879x 段：其它用例的 mock 服务在那一段上动态起端口，固定撞车会 EADDRINUSE。
const PORT = 8903;
/** 只出现在草稿正文里、不该进入判定环节的标记（回归锚点）。 */
const DRAFT_ONLY = "MARKER-DRAFT-ONLY";
const SUPPORTED = "共 3 条";
const UNSUPPORTED = "共 30 条";

type ToolCallArg = { id: string; name: string; args?: unknown };

function textChunk(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`;
}

function toolCallChunk(calls: ToolCallArg[]): string {
  return `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: calls.map((c, i) => ({
            index: i,
            id: c.id,
            function: { name: c.name, ...(c.args !== undefined ? { arguments: JSON.stringify(c.args) } : {}) },
          })),
        },
      },
    ],
  })}`;
}

function sse(lines: string[]): string {
  return lines.concat("data: [DONE]").join("\n\n") + "\n\n";
}

let mainStep = 0;
/** 判定环节收到的完整 prompt（用来断言「草稿没回传」）。 */
let supportPrompt = "";

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let buf = "";
    for await (const c of req) buf += c;
    const body = JSON.parse(buf) as { tools?: unknown[]; messages?: Array<{ content?: string }> };
    res.writeHead(200, { "Content-Type": "text/event-stream" });

    if (!body.tools?.length) {
      const sys = String(body.messages?.[0]?.content || "");
      if (sys.includes("断言抽取器")) {
        // 阶段一：只抽断言（刻意不把草稿里的说明细节带进判定）。
        res.end(sse([textChunk(JSON.stringify({ claims: [UNSUPPORTED], sources: [] }))]));
        return;
      }
      if (sys.includes("断言核验器")) {
        supportPrompt = String(body.messages?.[1]?.content || body.messages?.at(-1)?.content || "");
        res.end(sse([textChunk(JSON.stringify({ unsupported: [UNSUPPORTED] }))]));
        return;
      }
      if (sys.includes("只输出 DATA 或 NO_DATA")) {
        res.end(sse([textChunk("DATA")]));
        return;
      }
      res.end(sse([textChunk("这次没有取到可核对的数据。")]));
      return;
    }

    // 主循环：①写源文件再读回（读回 = 本轮证据）→ ②综合轮夹带证据外的断言 → ③改写为有支持的结论。
    const step = mainStep++;
    if (step === 0) {
      res.end(
        sse([
          textChunk("先把源数据落到工作区，再读回来核对。"),
          toolCallChunk([
            { id: "c_w", name: "fs_write", args: { path: "notes/source.md", content: `源数据：${SUPPORTED}` } },
            { id: "c_r", name: "fs_read", args: { path: "notes/source.md" } },
          ]),
        ]),
      );
      return;
    }
    if (step === 1) {
      res.end(sse([textChunk(`数据核对完毕。${UNSUPPORTED}。以下为说明细节 ${DRAFT_ONLY}。`)]));
      return;
    }
    res.end(sse([textChunk(`已按取到的数据核对：${SUPPORTED}。`)]));
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

test("部分证据 + 夹带无支持断言 → 作废纠正；判定环节看不到草稿", async () => {
  const convId = "verify-two-stage";
  await createConversation({ id: convId, title: "verify", agentId: "support", mcpServers: ["mock"], model: "mock" });
  const texts: string[] = [];
  let verifications = 0;
  for await (const ev of chatStream(convId, "核对一下数量是多少", { sessionId: "verify-two-stage" }, undefined)) {
    if (ev.type === "text") texts.push((ev as { text: string }).text);
    else if (ev.type === "usage" && (ev as { groundingVerifications?: number }).groundingVerifications) {
      verifications = (ev as { groundingVerifications?: number }).groundingVerifications || 0;
    }
  }
  fsRemoveConversation(convId);

  expect(verifications, "本轮应真的跑过一次事后核验").toBeGreaterThan(0);
  // 判定环节拿到了待核的断言与证据。
  expect(supportPrompt).toContain(UNSUPPORTED);
  expect(supportPrompt).toMatch(/【来源/);
  // 回归锚点：原回答（草稿）正文不得进入判定环节——否则就是「看着自己的答案判对错的」一步式。
  expect(supportPrompt).not.toContain(DRAFT_ONLY);

  // 无支持断言被作废重答：最终上屏的是有支持的那版。
  const final = texts.join("").trim();
  expect(final).toContain(SUPPORTED);
  expect(final).not.toContain(UNSUPPORTED);
}, 40000);
