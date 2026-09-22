// 伪出图护栏的端到端验证（无需真实模型/MCP）：
// 起一个本地 mock 的 OpenAI 流式服务，用导出的 chatStream 驱动真实 runLoop，
// 复现线上形态——模型没调 render_chart，只在正文里写 `![标题](chart)` 占位符：
//   ① 第一轮：正文里带图片占位符、零工具调用 → 护栏应作废该文本并回灌纠正；
//   ② 第二轮：模型改走 render_chart（带真实数据）→ chart 事件下发；
//   ③ 第三轮：收束文本。
// 断言三件事：占位符**没有上屏**、chart 事件真的产出了、usage 如实记了一次护栏纠正。
// 设计口径见 src/chat.ts 的 FAKE_CHART_HINT / unresolvableImageTargets。
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// 强制内存存储（MongoDB 连不上），并注册一个指向本地 mock 的模型。env 必须在 import 前设置。
process.env.MONGO_URI = "mongodb://127.0.0.1:1"; // 端口拒绝 → 降级内存
process.env.MODEL_PROVIDERS = "mock";
process.env.MODEL_MOCK_PROVIDER = "openai";
process.env.MODEL_MOCK_NAME = "mock";
process.env.MODEL_MOCK_API_KEY = "x";
process.env.MODEL_MOCK_CONTEXT_WINDOW = "128000";
// MODEL_MOCK_BASE_URL 在 beforeAll 里按实际监听端口设置（见下）——固定端口会与其他测试/残留进程抢，
// 端口号是测试实现的细节，不该成为 flaky 来源。

let mainStep = 0;

/** 线上实测形态：正文用图片语法占位图表，目标 `chart` 会被浏览器当相对路径请求 → 破图。 */
const PLACEHOLDER_TEXT = "## 一、结论\n\n![近 7 天 vs 前 7 天 各来源日均环比（%）](chart)\n\n以上为本周结构变化。";

function toolCallChunk(id: string, name: string, args: unknown): string {
  const payload = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }],
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

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let buf = "";
    for await (const c of req) buf += c;
    const body = JSON.parse(buf) as { tools?: Array<{ function?: { name?: string } }> };
    const tools = body.tools || [];
    // 事后核验调用不带工具（只送回证据与答案）：识别为「无工具」直接回空断言 JSON。
    const isVerify = tools.length === 0;
    // 主循环一定带内置工具（render_chart 恒注入），据此与核验调用区分。
    const hasRenderChart = tools.some((t) => t.function?.name === "render_chart");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (isVerify || !hasRenderChart) {
      res.end(sse([textChunk('{"unsupported":[]}')]));
      return;
    }
    const step = mainStep++;
    const payload =
      step === 0
        ? sse([textChunk(PLACEHOLDER_TEXT)]) // 伪出图：占位符 + 零工具调用
        : step === 1
          ? sse([
              toolCallChunk("call_chart_1", "render_chart", {
                chartType: "column",
                title: "各来源环比",
                data: [
                  { src: "a", chg: 12 },
                  { src: "b", chg: -8 },
                ],
                encode: { x: "src", y: "chg" },
              }),
            ])
          : sse([textChunk("已按本轮取到的真实数据出图。")]);
    res.end(payload);
  } else {
    res.writeHead(404);
    res.end();
  }
});

let chatStream: (typeof import("../src/chat.js"))["chatStream"];
let createConversation: (typeof import("../src/conversations.js"))["createConversation"];

beforeAll(async () => {
  // 端口交给系统分配：固定端口会与其他测试文件/残留进程抢（实测 EADDRINUSE 会让整份套件变 flaky）。
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  process.env.MODEL_MOCK_BASE_URL = `http://127.0.0.1:${port}/v1`;
  // env 就绪后才 import：config.js 在模块加载时读环境变量。
  ({ chatStream } = await import("../src/chat.js"));
  ({ createConversation } = await import("../src/conversations.js"));
});

afterAll(() => {
  server.close();
});

test("图片占位符被拦截：正文不上屏、改由 render_chart 真正出图", async () => {
  await createConversation({ id: "verify-pseudo-chart", title: "verify" });
  const SESSION = "verify-pseudo-chart-session";
  const seen = {
    /** 所有上屏正文拼接（占位符一旦出现在这里就是破图）。 */
    texts: "",
    chartType: "",
    chartRows: 0,
    pseudoCallRetries: -1,
  };
  for await (const ev of chatStream("verify-pseudo-chart", "监测各来源新增用户的结构变化", { sessionId: SESSION }, undefined)) {
    if (ev.type === "text") seen.texts += (ev as { text: string }).text;
    else if (ev.type === "text_delta") seen.texts += (ev as { text: string }).text;
    else if (ev.type === "chart") {
      seen.chartType = (ev as { chartType: string }).chartType;
      seen.chartRows = Array.isArray((ev as { data: unknown }).data) ? ((ev as { data: unknown[] }).data as unknown[]).length : 0;
    } else if (ev.type === "usage") {
      seen.pseudoCallRetries = (ev as { pseudoCallRetries?: number }).pseudoCallRetries ?? 0;
    }
  }

  expect(seen.texts.includes("](chart)"), "图片占位符不得上屏").toBe(false);
  expect(seen.texts.includes("!["), "图片语法整体不得上屏").toBe(false);
  expect(seen.texts).toContain("已按本轮取到的真实数据出图");
  expect(seen.chartType, "纠正后应改走 render_chart 出图").toBe("column");
  expect(seen.chartRows, "图里的数据应是工具透传的真实数据").toBe(2);
  expect(seen.pseudoCallRetries, "usage 应如实记一次协议护栏纠正").toBe(1);
}, 25000);
