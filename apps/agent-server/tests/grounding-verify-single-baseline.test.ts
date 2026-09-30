// 一步式核验的**对照基线**（2026-09-30，docs/grounding-verify-alignment.md）：
// 两阶段用例断言「判定环节不含草稿」——这条断言只有在**确实存在一种会把草稿送进判定的形态**时才有意义。
// 本文件把 `GROUNDING_VERIFY_STAGES=single`（旧形态）跑同一场景，坐实两件事：
//   ①旧形态的判定输入确实带着整篇草稿（对照点）；
//   ②两种形态都能拦住证据外的断言（去耦没有削弱拦截能力）。
// 场景与两阶段用例完全一致，只有开关不同——差异因此只能来自核验形态本身。
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";

// env 必须在 import 前设置（chat.ts 的常量在模块加载时读取）。
process.env.MONGO_URI = "mongodb://127.0.0.1:1"; // 端口拒绝 → 降级内存
process.env.MODEL_PROVIDERS = "mock";
process.env.MODEL_MOCK_PROVIDER = "openai";
process.env.MODEL_MOCK_NAME = "mock";
process.env.MODEL_MOCK_BASE_URL = "http://127.0.0.1:8904/v1";
process.env.MODEL_MOCK_API_KEY = "x";
process.env.MODEL_MOCK_CONTEXT_WINDOW = "128000";
process.env.GROUNDING_VERIFY_STAGES = "single";

// 端口避开 879x 段：其它用例的 mock 服务在那一段上动态起端口。
const PORT = 8904;
/** 只出现在草稿正文里的标记：用来判断「整篇草稿有没有被送进判定环节」。 */
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
/** 一步式核验收到的完整 prompt。 */
let verifyPrompt = "";

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let buf = "";
    for await (const c of req) buf += c;
    const body = JSON.parse(buf) as { tools?: unknown[]; messages?: Array<{ content?: string }> };
    res.writeHead(200, { "Content-Type": "text/event-stream" });

    if (!body.tools?.length) {
      const sys = String(body.messages?.[0]?.content || "");
      // 一步式核验器（VERIFY_SYSTEM 口径）：与两阶段的「断言核验器」是不同的 system。
      if (sys.includes("答案核验器")) {
        verifyPrompt = String(body.messages?.at(-1)?.content || "");
        res.end(sse([textChunk(JSON.stringify({ unsupported: [UNSUPPORTED], unknown_sources: [] }))]));
        return;
      }
      if (sys.includes("只输出 DATA 或 NO_DATA")) {
        res.end(sse([textChunk("DATA")]));
        return;
      }
      res.end(sse([textChunk("这次没有取到可核对的数据。")]));
      return;
    }

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

test("single 基线：判定输入带着整篇草稿，但同样拦得住证据外的断言", async () => {
  const convId = "verify-single-baseline";
  await createConversation({ id: convId, title: "verify", agentId: "support", mcpServers: ["mock"], model: "mock" });
  const texts: string[] = [];
  for await (const ev of chatStream(convId, "核对一下数量是多少", { sessionId: "verify-single" }, undefined)) {
    if (ev.type === "text") texts.push((ev as { text: string }).text);
  }
  fsRemoveConversation(convId);

  // 对照点：一步式的核验输入是「问题 + 证据 + 整篇回答」，草稿正文随判定一起进入上下文。
  expect(verifyPrompt).toContain(DRAFT_ONLY);
  expect(verifyPrompt).toContain(UNSUPPORTED);
  // 去耦不该削弱拦截能力：旧形态能拦的，两阶段也要能拦（由 two 阶段用例反向保证）。
  const final = texts.join("").trim();
  expect(final).toContain(SUPPORTED);
  expect(final).not.toContain(UNSUPPORTED);
}, 40000);
