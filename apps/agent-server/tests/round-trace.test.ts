// 逐轮 trace 落盘验证（2026-09-24，docs/artifact-delivery-plan.md §12.6 疑问①）：
// 每个工具循环轮次应落一行 rounds-<runId>.jsonl，使「重复探查 / 预算耗尽 / 熔断」可被复盘。
// 复用 deep-agent-live 的 mock 手法：本地 mock OpenAI SSE 服务驱动真实 runLoop。
//
// 第 4 批扩为 L2 离线断言（事故文档 §6.2 L2）：
//   ① 轮级 mode 按本轮实际执行写 tool / synthesis——「综合轮出现 0 次」必须能直接数出来；
//   ② 父轮 task（子代理委派）调用有 span，带低基数结构化状态 attr（事故 §7 的埋点缺口）。
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.MONGO_URI = "mongodb://127.0.0.1:1";
process.env.MODEL_PROVIDERS = "mock";
process.env.MODEL_MOCK_PROVIDER = "openai";
process.env.MODEL_MOCK_NAME = "mock";
process.env.MODEL_MOCK_API_KEY = "x";
process.env.MODEL_MOCK_CONTEXT_WINDOW = "128000";
process.env.MCP_MAX_TOOL_ROUNDS = "3";

type Scenario = "write" | "delegate" | "delegate-failed" | "direct";
let scenario: Scenario = "write";
let stepN = 0;
/** 当前用例委派子代理时带的参数（按场景改写）。 */
let taskArgs: Record<string, unknown> = { description: "核对口径" };

function toolCallChunk(calls: Array<{ id: string; name: string; args?: unknown }>): string {
  return `data: ${JSON.stringify({
    choices: [
      { delta: { tool_calls: calls.map((c, i) => ({ index: i, id: c.id, function: { name: c.name, ...(c.args !== undefined ? { arguments: JSON.stringify(c.args) } : {}) } })) } },
    ],
  })}`;
}
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
      // 无工具 = 收尾调用（预算耗尽补位 / 最后一轮摘工具）与各类内部辅助调用（分诊 / 核验）。
      res.end(sse([textChunk("收尾结论。")]));
      return;
    }
    const isSubagent = (body.messages || []).some((m) => (m.content || "").includes("执行子代理"));
    if (isSubagent) {
      res.end(sse([textChunk("子代理摘要：口径已核对。")]));
      return;
    }
    const step = stepN++;
    if (scenario === "write") {
      res.end(sse([toolCallChunk([{ id: `call_${step}`, name: "fs_write", args: { path: `results/step-${step}.md`, content: "x" } }])]));
      return;
    }
    if (scenario === "delegate" || scenario === "delegate-failed") {
      if (step === 0) {
        res.end(sse([toolCallChunk([{ id: "call_task", name: "task", args: taskArgs }])]));
        return;
      }
      res.end(sse([textChunk("父轮结论：按子代理回传如实收束。")]));
      return;
    }
    // direct：带工具但直接用正文收束（综合轮）
    res.end(sse([textChunk("直接结论：无需取数。")]));
    return;
  }
  res.writeHead(404);
  res.end();
});

let chatStream: (typeof import("../src/chat.js"))["chatStream"];
let createConversation: (typeof import("../src/conversations.js"))["createConversation"];
let fsRemoveConversation: (typeof import("../src/fs-store.js"))["fsRemoveConversation"];
let setTraceDir: (dir?: string) => void = () => {};
// 落盘目录指向临时目录：测试产物不写进真实 .data/traces（真实目录会被测试文件堆满，
// 保留期清理还会把它们当孤儿删掉，真实排障数据与测试数据混在一起无法分辨）。
let traceDir = "";

beforeAll(async () => {
  traceDir = mkdtempSync(join(tmpdir(), "trace-rounds-"));
  ({ setTraceDirForTest: setTraceDir } = await import("../src/trace.js"));
  setTraceDir(traceDir);
  // 用动态端口（listen(0)）：固定 8795 会与 8791-8799 段的其它测试文件争用，被占用时 listen 回调
  // 永不触发、beforeAll 卡到 25s 超时（报超时而非 EADDRINUSE，难排查）。
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  process.env.MODEL_MOCK_BASE_URL = `http://127.0.0.1:${port}/v1`;
  ({ chatStream } = await import("../src/chat.js"));
  ({ createConversation } = await import("../src/conversations.js"));
  ({ fsRemoveConversation } = await import("../src/fs-store.js"));
});
afterAll(() => {
  server.close();
  setTraceDir(); // 还原默认目录，避免影响同进程内其它用例
  if (traceDir) rmSync(traceDir, { recursive: true, force: true });
});

/** 跑一次对话并读回它的 rounds / spans 落盘（L2：离线断言，不依赖真实服务）。 */
async function runAndRead(runId: string, sc: Scenario, args?: Record<string, unknown>) {
  scenario = sc;
  stepN = 0;
  taskArgs = args ?? { description: "核对口径" };
  const convId = `verify-rounds-${runId}`;
  const conv = await createConversation({ id: convId, title: "verify" });
  (conv as { mcpServers: string[]; model: string }).mcpServers = ["mock"];
  (conv as { model: string }).model = "mock";
  const traceMeta: { servedModel?: string; runId?: string } = { runId };
  for await (const _ of chatStream(convId, "写几步", { sessionId: "r-session" }, undefined, traceMeta)) {
    /* drain */
  }
  fsRemoveConversation(convId);
  const roundsFile = resolve(traceDir, `rounds-${runId}.jsonl`);
  const spansFile = resolve(traceDir, `spans-${runId}.jsonl`);
  const rounds = existsSync(roundsFile)
    ? (readFileSync(roundsFile, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) as Array<Record<string, unknown>>)
    : [];
  const spans = existsSync(spansFile)
    ? (readFileSync(spansFile, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) as Array<Record<string, unknown>>)
    : [];
  return { rounds, spans };
}

test("每轮工具循环都落一条逐轮 trace（按 runId 分文件）", async () => {
  const { rounds } = await runAndRead("run_unit_rounds", "write");
  const file = resolve(traceDir, "rounds-run_unit_rounds.jsonl");
  expect(existsSync(file), "应落盘 rounds-<runId>.jsonl").toBe(true);
  expect(rounds.length, "至少每轮一行").toBeGreaterThanOrEqual(1);
  const first = rounds[0] as { round: number; mode: string; toolCallsThisRound: number };
  expect(first.mode).toBe("tool");
  expect(first.round).toBe(0);
  expect(first.toolCallsThisRound).toBeGreaterThanOrEqual(1);
}, 25000);

test("L2① 直接收束的运行：轮级落 mode=synthesis（「综合轮 0 次」必须能直接数出来）", async () => {
  const { rounds } = await runAndRead("run_unit_synthesis", "direct");
  expect(rounds.length).toBeGreaterThanOrEqual(1);
  const modes = rounds.map((r) => r.mode);
  expect(modes, "没有任何工具执行的一轮必须是 synthesis").toEqual(["synthesis"]);
  const first = rounds[0] as { toolCallsThisRound: number };
  expect(first.toolCallsThisRound).toBe(0);
}, 25000);

test("L2② 委派子代理：父轮 task 调用有 span，带低基数结构化状态（事故 §7 埋点缺口）", async () => {
  const { rounds, spans } = await runAndRead("run_unit_task_ok", "delegate");
  // 轮级：恰好一条 tool 行（父轮的委派轮）；子代理与父轮共用 runId，它的综合轮行也落在同一文件里，
  // 因此 synthesis 行 ≥2（子代理一轮 + 父轮收束一轮）——最后一条必须是父轮的收束轮。
  const modes = rounds.map((r) => r.mode);
  expect(modes.filter((m) => m === "tool")).toHaveLength(1);
  expect(modes.filter((m) => m === "synthesis").length).toBeGreaterThanOrEqual(2);
  expect(modes[modes.length - 1]).toBe("synthesis");
  const toolLine = rounds.find((r) => r.mode === "tool") as { toolCallsThisRound?: number };
  expect(toolLine.toolCallsThisRound).toBeGreaterThanOrEqual(1);
  const taskSpan = spans.find((s) => s.kind === "tool" && s.name === "task") as
    | { ok?: boolean; durationMs?: number; attrs?: Record<string, unknown> }
    | undefined;
  expect(taskSpan, "父轮 task 调用必须落 span（修复前整个分支没有 span）").toBeDefined();
  expect(taskSpan!.ok).toBe(true);
  expect(typeof taskSpan!.durationMs).toBe("number");
  expect(taskSpan!.attrs?.["gen_ai.tool.subagent.status"]).toBe("success");
  expect(taskSpan!.attrs?.["gen_ai.tool.subagent.calls"]).toBeGreaterThanOrEqual(0);
  // 成功的委派不写 error.*（OTel：已被正常处理的不记录）
  expect(taskSpan!.attrs?.["error.type"]).toBeUndefined();
}, 30000);

test("L2③ 委派失败：task span ok=false 且带 error.type/description（可复盘「哪一步失败」）", async () => {
  const { spans } = await runAndRead("run_unit_task_fail", "delegate-failed", {
    description: "核对口径",
    servers: ["nonexistent-server"],
  });
  const taskSpan = spans.find((s) => s.kind === "tool" && s.name === "task") as
    | { ok?: boolean; attrs?: Record<string, unknown> }
    | undefined;
  expect(taskSpan).toBeDefined();
  expect(taskSpan!.ok).toBe(false);
  expect(taskSpan!.attrs?.["gen_ai.tool.subagent.status"]).toBe("failed");
  expect(typeof taskSpan!.attrs?.["error.type"]).toBe("string");
  expect((taskSpan!.attrs?.["error.type"] as string).length).toBeGreaterThan(0);
  expect(typeof taskSpan!.attrs?.["error.description"]).toBe("string");
}, 30000);
