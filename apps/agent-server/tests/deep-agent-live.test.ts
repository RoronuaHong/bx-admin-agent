// Deep Agent 端到端实跑验证（无需真实模型/真实 MCP）：
// 起一个本地 mock 的 OpenAI 流式服务，通过导出的 chatStream 驱动真实 runLoop 整轮循环，
// 证明「主代理委派 task 子代理 → 子代理调内置工具 → 收敛」这条 Deep Agent 主链路真的能跑通。
// 子代理的 tools 不含 task（chat.ts 剥离），mock 服务据此区分主/子代理返回不同脚本。
//
// 同时钉住「子代理默认只读」这条安全闸门（chat.ts 的 allowWrite:false + 非 read 直接拒绝）：
// 子代理第一步就尝试 fs_write（BUILTIN_RISK 里是 write 级）→ 必被拒绝、不落盘；
// 工作区文件改由**主代理**自己写（内置工作区写免确认，见 risk.ts verdictNeedsConfirm）。
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";

// 强制内存存储（MongoDB 连不上），并注册一个指向本地 mock 的模型。env 必须在 import 前设置。
process.env.MONGO_URI = "mongodb://127.0.0.1:1"; // 端口拒绝 → 降级内存
process.env.MODEL_PROVIDERS = "mock";
process.env.MODEL_MOCK_PROVIDER = "openai";
process.env.MODEL_MOCK_NAME = "mock";
process.env.MODEL_MOCK_BASE_URL = "http://127.0.0.1:8799/v1";
process.env.MODEL_MOCK_API_KEY = "x";
process.env.MODEL_MOCK_CONTEXT_WINDOW = "128000";

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
  return sse([toolCallChunk([{ id: "call_task_1", name: "task", args: { description: "作为子代理：把『项目状态』小结写入工作区 results/summary.md" } }])]);
}
/** 主代理自己写工作区：内置工作区写免确认（无外部副作用），这才是能落盘的那一步。 */
function sseMainFs(): string {
  return sse([toolCallChunk([{ id: "call_fs_main", name: "fs_write", args: { path: "results/summary.md", content: "主代理产出：子代理汇报完毕，结论已落盘。" } }])]);
}
function sseMainFinal(): string {
  return sse([textChunk("主代理汇总：子代理已完成数据查询，结论见工作区 results/summary.md。")]);
}
/** 子代理第一步就写：应被只读闸门拒绝（不得落盘）。 */
function sseSubFs(): string {
  return sse([toolCallChunk([{ id: "call_fs_1", name: "fs_write", args: { path: "results/summary.md", content: "子代理产出：项目状态正常。" } }])]);
}
function sseSubFinal(): string {
  return sse([textChunk("子代理结论：写入被拒（子代理只读），已直接汇报。")]);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let buf = "";
    for await (const c of req) buf += c;
    const body = JSON.parse(buf) as { tools?: Array<{ function?: { name?: string } }> };
    const tools = body.tools || [];
    const isMain = tools.some((t) => t.function?.name === "task");
    // Chain-of-Verification 的事后核验调用不携带工具（只送回证据与答案让模型判定），
    // 若当成「子代理」会误返回 fs_write 工具调用、在无工具上下文里空转。识别为「无工具」即直接回空断言 JSON。
    const isVerify = tools.length === 0;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (isVerify) {
      res.end(sse([textChunk('{"unsupported":[]}')]));
      return;
    }
    // 主：① 委派子代理 → ② 自己写工作区 → ③ 收尾；子：① 尝试写（应被拒）→ ② 收尾。
    const step = isMain ? mainN++ : subN++;
    const payload = isMain
      ? step === 0
        ? sseMainTask()
        : step === 1
          ? sseMainFs()
          : sseMainFinal()
      : step === 0
        ? sseSubFs()
        : sseSubFinal();
    res.end(payload);
  } else {
    res.writeHead(404);
    res.end();
  }
});

let chatStream: (typeof import("../src/chat.js"))["chatStream"];
let createConversation: (typeof import("../src/conversations.js"))["createConversation"];
let fsRead: (typeof import("../src/fs-store.js"))["fsRead"];
let fsRemoveConversation: (typeof import("../src/fs-store.js"))["fsRemoveConversation"];
// 端到端里没有真人点确认卡：自动放行主代理的写操作确认，否则确认 waiter 永不 resolve → 挂到超时。
let answerConfirmation: (typeof import("../src/confirm.js"))["answerConfirmation"];

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  ({ chatStream } = await import("../src/chat.js"));
  ({ createConversation } = await import("../src/conversations.js"));
  ({ fsRead, fsRemoveConversation } = await import("../src/fs-store.js"));
  ({ answerConfirmation } = await import("../src/confirm.js"));
});

afterAll(() => {
  server.close();
});

test("Deep Agent 端到端循环：主代理委派 → 子代理执行内置工具 → 收敛", async () => {
  // 内存模式下 createConversation 返回会话文档引用，可直接改设置进入工具模式。
  const conv = await createConversation({ id: "verify-deep", title: "verify" });
  (conv as { mcpServers: string[]; model: string }).mcpServers = ["mock"];
  (conv as { model: string }).model = "mock";

  const SESSION = "verify-session";
  const seen = {
    model: false,
    task: false,
    subagentRan: false,
    mainWrote: false,
    finalText: false,
    done: false,
    /** 端到端出现的确认卡类型（工作区写免确认 → 这条必须为空，见下方断言）。 */
    confirmed: [] as string[],
  };
  for await (const ev of chatStream("verify-deep", "请完成一个多步任务", { sessionId: SESSION }, undefined)) {
    // 端到端没有真人点确认卡：万一有卡就自动放行（避免 waiter 挂到 120s 超时，让失败快速暴露）。
    // 正常情况下不该走到这里——工作区写免确认，子代理的非只读在闸门处直接拒绝。
    if (ev.type === "confirmation_required") {
      seen.confirmed.push((ev as { name?: string }).name || "?");
      answerConfirmation((ev as { ticket: string }).ticket, SESSION, true);
      continue;
    }
    const t = ev.type;
    if (t === "model") seen.model = true;
    else if (t === "tool_call") {
      const e = ev as { name: string };
      if (e.name === "task") seen.task = true;
    } else if (t === "tool_result") {
      const e = ev as { name: string; ok: boolean };
      if (e.name === "task" && e.ok) seen.subagentRan = true;
      // 主代理的 fs_write 是**顶层**工具结果（子代理内部的工具事件不转发到主流，只转发 text/subagent_*）。
      if (e.name === "fs_write" && e.ok) seen.mainWrote = true;
    } else if (t === "text") seen.finalText = true;
    else if (t === "done") seen.done = true;
  }

  // 工作区内容分两种来源：主代理写的（能落盘）vs 子代理写的（被只读闸门拒绝）。
  // 用内容区分，一次同时钉住「内置工具真的执行了」与「子代理写不进去」。
  const file = fsRead("verify-deep", "results/summary.md");
  const content = "content" in file ? file.content : "";
  fsRemoveConversation("verify-deep");

  expect(seen.model, "应进入模型调用").toBe(true);
  expect(seen.task, "主代理应委派 task 子代理").toBe(true);
  expect(seen.subagentRan, "子代理应独立执行并返回").toBe(true);
  expect(seen.mainWrote, "主代理的内置工具 fs_write 应真实执行并落盘").toBe(true);
  // 免确认是「闸门→可见性」的取舍：写必须真的执行，且**不经过任何确认卡**（弹卡就会打断用户且带回确认疲劳）。
  expect(seen.confirmed, "工作区写免确认：端到端不应出现任何确认卡").toEqual([]);
  expect(content.includes("子代理产出"), "子代理的写操作应被只读闸门拒绝（P0-5），不得落盘").toBe(false);
  expect(seen.finalText, "主代理应收敛出最终文本").toBe(true);
  expect(seen.done, "事件流应正常收束 done").toBe(true);
}, 25000);
