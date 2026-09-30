// 定时任务无人值守结论协议的端到端验证（2026-09-30，docs/scheduled-spike-detection-plan.md）：
// 本轮取证失败（接地护栏纠正用尽）时，预警任务的正文必须带 [NO_DATA] 首行标记，
// 报告任务的正文保持模型写的诚实兜底原文 —— 判据是**状态**，不是正文措辞。
// 复用 deep-agent-live 的 mock 手法：本地 mock OpenAI SSE 服务驱动真实 chatStream（无需真实模型）。
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";

// env 必须在 import 前设置（chat.ts 的常量在模块加载时读取）。
process.env.MONGO_URI = "mongodb://127.0.0.1:1"; // 端口拒绝 → 降级内存
process.env.MODEL_PROVIDERS = "mock";
process.env.MODEL_MOCK_PROVIDER = "openai";
process.env.MODEL_MOCK_NAME = "mock";
process.env.MODEL_MOCK_BASE_URL = "http://127.0.0.1:8792/v1";
process.env.MODEL_MOCK_API_KEY = "x";
process.env.MODEL_MOCK_CONTEXT_WINDOW = "128000";

const PORT = 8792;
/** 模型自由发挥的诚实兜底措辞（修复前它不会被换成协议句 → 预警正文没有首行标记）。 */
const HONEST_TEXT = "这次没有实际取数，没法下结论。";

function textChunk(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`;
}

function sse(lines: string[]): string {
  return lines.concat("data: [DONE]").join("\n\n") + "\n\n";
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let buf = "";
    for await (const c of req) buf += c;
    const body = JSON.parse(buf) as { tools?: unknown[]; messages?: Array<{ content?: string }> };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (!body.tools?.length) {
      // 无工具调用 = 护栏的辅助调用：分诊（DATA/NO_DATA 二选一）与诚实兜底要分开回。
      const sys = String(body.messages?.[0]?.content || "");
      if (sys.includes("只输出 DATA 或 NO_DATA")) {
        res.end(sse([textChunk("DATA")])); // 保守方向：认定这段回答需要外部数据 → 走纠正/兜底
        return;
      }
      res.end(sse([textChunk(HONEST_TEXT)]));
      return;
    }
    // 主循环：只输出正文、不调任何工具 —— 零证据收束，触发接地护栏。
    res.end(sse([textChunk("本轮没有取到可核对的数据。")]));
  } else {
    res.writeHead(404);
    res.end();
  }
});

let chatStream: (typeof import("../src/chat.js"))["chatStream"];
let createConversation: (typeof import("../src/conversations.js"))["createConversation"];
let fsRemoveConversation: (typeof import("../src/fs-store.js"))["fsRemoveConversation"];
let parseAlertMarker: (typeof import("../src/schedule-alert.js"))["parseAlertMarker"];

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  ({ chatStream } = await import("../src/chat.js"));
  ({ createConversation } = await import("../src/conversations.js"));
  ({ fsRemoveConversation } = await import("../src/fs-store.js"));
  ({ parseAlertMarker } = await import("../src/schedule-alert.js"));
});

afterAll(() => {
  server.close();
});

/** 跑一轮无人值守对话，返回最终上屏正文与 usage 里的未取证标记。 */
async function runUnattended(conversationId: string, conclusion: "alert" | "report") {
  await createConversation({ id: conversationId, title: "verify", agentId: "support", mcpServers: ["mock"], model: "mock" });
  const texts: string[] = [];
  let ungrounded = false;
  for await (const ev of chatStream(
    conversationId,
    "检查一次当前情况并给出结论",
    { sessionId: `sched-${conversationId}`, unattendedConclusion: conclusion },
    undefined,
  )) {
    if (ev.type === "text") texts.push((ev as { text: string }).text);
    else if (ev.type === "usage" && (ev as { ungrounded?: boolean }).ungrounded) ungrounded = true;
  }
  fsRemoveConversation(conversationId);
  return { text: texts.join("").trim(), ungrounded };
}

test("预警任务取证失败 → 正文首行是 [NO_DATA]（不认模型自由措辞）", async () => {
  const { text, ungrounded } = await runUnattended("verify-sched-alert", "alert");
  expect(ungrounded, "这一轮应被判为「未取得工具数据」").toBe(true);
  expect(parseAlertMarker(text), `预警正文首行必须是协议标记，实际：${text}`).toBe("NO_DATA");
  // 协议句取代模型的自由措辞：后者是交互语境的话术，在这里只是噪音。
  expect(text).not.toContain(HONEST_TEXT);
}, 30000);

test("报告任务取证失败 → 保留诚实兜底原文，且未取证状态照常上报", async () => {
  const { text, ungrounded } = await runUnattended("verify-sched-report", "report");
  expect(ungrounded).toBe(true);
  // 报告没有首行标记协议：正文原样保留，由调度器按 ungrounded 记「未产出结论」。
  expect(text).toContain(HONEST_TEXT);
  expect(parseAlertMarker(text)).toBe(null);
}, 30000);
