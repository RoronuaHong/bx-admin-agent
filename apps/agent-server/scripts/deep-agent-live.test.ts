// Deep Agent 端到端实跑验证（无需真实模型/真实 MCP）：
// 起一个本地 mock 的 OpenAI 流式服务，通过导出的 chatStream 驱动真实 runLoop 整轮循环，
// 证明「主代理委派 task 子代理 → 子代理调内置工具 → 收敛」这条 Deep Agent 主链路真的能跑通。
// 子代理的 tools 不含 task（chat.ts 剥离），mock 服务据此区分主/子代理返回不同脚本。
// 跑法：cmd /c "cd /d <repo>\apps\agent-server && node --import tsx scripts/deep-agent-live.test.ts"

// 强制内存存储（MongoDB 连不上），并注册一个指向本地 mock 的模型。env 必须在 import 前设置。
process.env.MONGO_URI = "mongodb://127.0.0.1:1"; // 端口拒绝 → 降级内存
process.env.MODEL_PROVIDERS = "mock";
process.env.MODEL_MOCK_PROVIDER = "openai";
process.env.MODEL_MOCK_NAME = "mock";
process.env.MODEL_MOCK_BASE_URL = "http://127.0.0.1:8799/v1";
process.env.MODEL_MOCK_API_KEY = "x";
process.env.MODEL_MOCK_CONTEXT_WINDOW = "128000";

import http from "node:http";

const PORT = 8799;
let mainN = 0;
let subN = 0;

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

function sseMainTask(): string {
  mainN++;
  return sse([toolCallChunk([{ id: "call_task_1", name: "task", args: { description: "作为子代理：把『项目状态』小结写入工作区 results/summary.md" } }])]);
}
function sseMainFinal(): string {
  return sse([textChunk("主代理汇总：子代理已完成数据查询，结论见工作区 results/summary.md。")]);
}
function sseSubFs(): string {
  subN++;
  return sse([toolCallChunk([{ id: "call_fs_1", name: "fs_write", args: { path: "results/summary.md", content: "子代理产出：项目状态正常。" } }])]);
}
function sseSubFinal(): string {
  return sse([textChunk("子代理结论：已写入 results/summary.md。")]);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let buf = "";
    for await (const c of req) buf += c;
    const body = JSON.parse(buf) as { tools?: Array<{ function?: { name?: string } }> };
    const isMain = (body.tools || []).some((t) => t.function?.name === "task");
    console.error(`[mock] isMain=${isMain} mainN=${mainN} subN=${subN} turns=${body.tools ? "?" : "n/a"}`);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const payload = isMain ? (mainN === 0 ? sseMainTask() : sseMainFinal()) : subN === 0 ? sseSubFs() : sseSubFinal();
    res.end(payload);
  } else {
    res.writeHead(404);
    res.end();
  }
});

await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));

const { chatStream } = await import("../src/chat.js");
const { createConversation } = await import("../src/conversations.js");
const { fsRead, fsRemoveConversation } = await import("../src/fs-store.js");

// 内存模式下 createConversation 返回会话文档引用，可直接改设置进入工具模式。
const conv = await createConversation({ id: "verify-deep", title: "verify" });
(conv as { mcpServers: string[]; model: string }).mcpServers = ["mock"];
(conv as { model: string }).model = "mock";

const seen = { model: false, task: false, subagentRan: false, workspaceWritten: false, finalText: false, done: false };
let round = 0;
const watchdog = setTimeout(() => {
  console.error("\n[WATCHDOG] 25s 超时，强制退出（循环未在正常时间内收束）");
  server.close();
  process.exit(2);
}, 25_000);
console.log("=== 驱动 chatStream（Deep Agent 整轮循环）===");
try {
  for await (const ev of chatStream("verify-deep", "请完成一个多步任务", {}, undefined)) {
    const t = ev.type;
    if (t === "model") {
      seen.model = true;
      console.log(`  [event] model: ${(ev as { id: string }).id}`);
    } else if (t === "tool_call") {
      const e = ev as { name: string };
      if (e.name === "task") {
        seen.task = true;
        round++;
        console.log(`  [event] tool_call #${round}: task（主代理委派子代理）`);
      } else {
        console.log(`  [event] tool_call: ${e.name}`);
      }
    } else if (t === "tool_result") {
      const e = ev as { name: string; ok: boolean };
      if (e.name === "task" && e.ok) seen.subagentRan = true;
      console.log(`  [event] tool_result: ${e.name} ok=${e.ok}`);
    } else if (t === "text_delta") {
      const c = (ev as { text: string }).text;
      console.log(`  [event] text_delta: ${c.length > 60 ? c.slice(0, 60) + "…(" + c.length + "字)" : c}`);
    } else if (t === "text") {
      seen.finalText = true;
      console.log(`  [event] text（末态，${String((ev as { text: string }).text).length} 字）: ${(ev as { text: string }).text}`);
    } else if (t === "done") {
      seen.done = true;
      console.log(`  [event] done`);
    } else if (t === "usage") {
      /* 透明信息，略 */
    } else {
      console.log(`  [event] ${t}`);
    }
  }
} catch (e) {
  console.error("chatStream 抛出：", e);
  server.close();
  process.exit(1);
}

server.close();
clearTimeout(watchdog);
// 子代理内部调 fs_write 会写入工作区；读回该文件即可证明「子代理 → 内置工具」链路真实执行。
const file = fsRead("verify-deep", "results/summary.md");
if ("content" in file && file.content.includes("子代理产出")) seen.workspaceWritten = true;
fsRemoveConversation("verify-deep");
const pass = seen.model && seen.task && seen.subagentRan && seen.workspaceWritten && seen.finalText && seen.done;
console.log("\n=== 结果 ===");
console.log(`  进入工具模式并委派 task 子代理: ${seen.task ? "PASS" : "FAIL"}`);
console.log(`  子代理独立执行并返回（tool_result task ok）: ${seen.subagentRan ? "PASS" : "FAIL"}`);
console.log(`  子代理内部调用内置工具 fs_write（工作区文件落地）: ${seen.workspaceWritten ? "PASS" : "FAIL"}`);
console.log(`  主代理收到子代理结果并收敛出最终文本: ${seen.finalText ? "PASS" : "FAIL"}`);
console.log(`  事件流正常收束 done: ${seen.done ? "PASS" : "FAIL"}`);
console.log(pass ? "\nDeep Agent 端到端循环：PASS" : "\nDeep Agent 端到端循环：FAIL");
process.exit(pass ? 0 : 1);
