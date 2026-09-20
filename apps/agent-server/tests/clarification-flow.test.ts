// 歧义澄清链路的端到端 + 纯逻辑验证（无需真实模型/真实 MCP）：
// ①澄清契约字段（missing_field / why_it_matters）经内置工具 → clarification_required 事件完整下发；
// ②「问题未答前冻结非只读调用」：本轮同时提交写操作 + 澄清时，写操作必须被暂缓（不落盘、不弹确认卡）；
// ③澄清回执按「点选 / 自由文本 / 跳过 / 超时」分口径构造——回执对模型必须有信息量
//   （曾出现：用户点了兜底选项「其他…」，模型只收到「用户已澄清：其他…」→ 零信息 → 空回复）。
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";

// 强制内存存储（MongoDB 连不上），并注册一个指向本地 mock 的模型。env 必须在 import 前设置。
process.env.MONGO_URI = "mongodb://127.0.0.1:1";
process.env.MODEL_PROVIDERS = "mock";
process.env.MODEL_MOCK_PROVIDER = "openai";
process.env.MODEL_MOCK_NAME = "mock";
process.env.MODEL_MOCK_BASE_URL = "http://127.0.0.1:8798/v1";
process.env.MODEL_MOCK_API_KEY = "x";
process.env.MODEL_MOCK_CONTEXT_WINDOW = "128000";

const PORT = 8798;
let mainN = 0;

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

/**
 * 主代理第一轮：**同时**提交「写工作区」与「请求澄清」，且把写操作排在澄清之前
 * （顺序刻意为难：冻结必须在澄清处理之前就已生效，否则写操作会先落盘）。
 */
function sseWritePlusClarify(): string {
  return sse([
    toolCallChunk([
      { id: "call_write_1", name: "fs_write", args: { path: "results/frozen.md", content: "用户回答之前不该落盘" } },
      {
        id: "call_clarify_1",
        name: "request_clarification",
        args: {
          question: "你说的那个词具体指哪一个？",
          missing_field: "指代对象",
          why_it_matters: "不同指代会得到完全不同的答案。",
          options: [
            { label: "解释 A", description: "指 A 场景" },
            { label: "解释 B" },
            { label: "其他（需要你补充说明）", description: "请在输入框里补充" },
          ],
        },
      },
    ]),
  ]);
}

function sseFinal(): string {
  return sse([textChunk("已按你的选择继续。")]);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let buf = "";
    for await (const c of req) buf += c;
    const body = JSON.parse(buf) as { tools?: Array<{ function?: { name?: string } }> };
    const tools = body.tools || [];
    // 事后核验调用不携带工具：识别为「无工具」直接回空断言，避免被当成普通轮次误答工具调用。
    if (tools.length === 0) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse([textChunk('{"unsupported":[]}')]));
      return;
    }
    const step = mainN++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(step === 0 ? sseWritePlusClarify() : sseFinal());
  } else {
    res.writeHead(404);
    res.end();
  }
});

let chatStream: (typeof import("../src/chat.js"))["chatStream"];
let buildClarifyAck: (typeof import("../src/chat.js"))["buildClarifyAck"];
let createConversation: (typeof import("../src/conversations.js"))["createConversation"];
let fsRead: (typeof import("../src/fs-store.js"))["fsRead"];
let fsRemoveConversation: (typeof import("../src/fs-store.js"))["fsRemoveConversation"];
let answerConfirmation: (typeof import("../src/confirm.js"))["answerConfirmation"];

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  ({ chatStream, buildClarifyAck } = await import("../src/chat.js"));
  ({ createConversation } = await import("../src/conversations.js"));
  ({ fsRead, fsRemoveConversation } = await import("../src/fs-store.js"));
  ({ answerConfirmation } = await import("../src/confirm.js"));
});

afterAll(() => {
  server.close();
});

test("[A] 澄清挂起期间冻结非只读调用；契约字段与选项完整下发；点选后正常收束", async () => {
  mainN = 0;
  const conv = await createConversation({ id: "verify-clarify", title: "verify" });
  (conv as { mcpServers: string[]; model: string }).mcpServers = ["mock"];
  (conv as { model: string }).model = "mock";

  const SESSION = "verify-clarify-session";
  const seen = {
    clarify: null as
      | { question: string; options: unknown[]; missingField?: string; whyItMatters?: string }
      | null,
    writeFrozen: false,
    writeRan: false,
    done: false,
    finalText: "",
  };

  for await (const ev of chatStream("verify-clarify", "一个有歧义的请求", { sessionId: SESSION }, undefined)) {
    if (ev.type === "clarification_required") {
      const e = ev as {
        ticket: string;
        question: string;
        options: unknown[];
        missingField?: string;
        whyItMatters?: string;
      };
      seen.clarify = {
        question: e.question,
        options: e.options,
        ...(e.missingField ? { missingField: e.missingField } : {}),
        ...(e.whyItMatters ? { whyItMatters: e.whyItMatters } : {}),
      };
      // 端到端没有真人点选项：模拟用户点选第一个选项（回传选项标题）。
      answerConfirmation(e.ticket, SESSION, true, "解释 A");
      continue;
    }
    if (ev.type === "tool_result") {
      const e = ev as { name: string; ok: boolean; text: string };
      if (e.name === "fs_write") {
        if (!e.ok && e.text.includes("暂缓")) seen.writeFrozen = true;
        if (e.ok) seen.writeRan = true;
      }
    } else if (ev.type === "text") {
      const e = ev as { text: string };
      seen.finalText += e.text;
    } else if (ev.type === "done") {
      seen.done = true;
    }
  }

  const file = fsRead("verify-clarify", "results/frozen.md");
  const content = "content" in file ? file.content : "";
  fsRemoveConversation("verify-clarify");

  // 契约字段：模型声明了「缺哪个决策点 / 为什么影响答案」→ 必须原样下发（界面据此展示待定项）。
  expect(seen.clarify, "应下发结构化澄清").not.toBeNull();
  expect(seen.clarify?.options.length, "三个互斥选项应完整下发").toBe(3);
  expect(seen.clarify?.missingField).toBe("指代对象");
  expect(seen.clarify?.whyItMatters).toContain("完全不同的答案");

  // 冻结：同一轮里排在澄清之前的写操作也必须被暂缓，且不能落盘。
  expect(seen.writeFrozen, "等待回答期间的写操作应被暂缓（ok=false + 暂缓文案）").toBe(true);
  expect(seen.writeRan, "被冻结的写操作不得真正执行").toBe(false);
  expect(content, "被冻结的写操作不得落盘").toBe("");

  expect(seen.finalText).toContain("已按你的选择继续");
  expect(seen.done).toBe(true);
}, 25000);

test("[B] 澄清回执按「点选 / 自由文本 / 跳过 / 超时」分口径构造", () => {
  const options = [
    { label: "解释 A", description: "指 A 场景" },
    { label: "解释 B" },
  ];

  // 点选：回执要说明「选的是哪个选项」并带上该选项的说明，且允许模型在信息仍不足时再追问。
  const picked = buildClarifyAck({ confirmed: true, timedOut: false, value: "解释 A" }, options);
  expect(picked).toContain("用户选择了选项「解释 A」");
  expect(picked).toContain("指 A 场景");
  expect(picked).toContain("再具体追问一次");

  // 自由文本：不是任何选项标题 → 按「补充说明」口径回执（不得伪装成选项）。
  const free = buildClarifyAck({ confirmed: true, timedOut: false, value: "其实是第三种意思" }, options);
  expect(free).toContain("用户补充说明：其实是第三种意思");
  expect(free).not.toContain("用户选择了选项");

  // 跳过 / 超时：按最合理的理解继续，并要求显式声明假设。
  const skipped = buildClarifyAck({ confirmed: false, timedOut: false }, options);
  expect(skipped).toContain("跳过了澄清");
  expect(skipped).toContain("假设");
  const timedOut = buildClarifyAck({ confirmed: false, timedOut: true }, options);
  expect(timedOut).toContain("超时");
  expect(timedOut).toContain("假设");

  // 语义死角：拒绝（confirmed=false）即使带了值也必须按跳过处理，不得伪装成用户的选择。
  const deniedWithValue = buildClarifyAck({ confirmed: false, timedOut: false, value: "解释 A" }, options);
  expect(deniedWithValue).toContain("跳过了澄清");
  expect(deniedWithValue).not.toContain("用户选择了选项");
});
