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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// 本地子代理类型：显式声明 fs_write 且 readonly=true，用于端到端验证 chat.ts 第一道强制过滤
// （不能只靠加载器：fs_write 是否在 types 里声明，与最终下发模型的工具清单是两件事）。
const prevSubagentDataDir = process.env.SUBAGENT_DATA_DIR;
const subagentProbeRoot = mkdtempSync(join(tmpdir(), "bx-subagent-status-probe-"));
mkdirSync(join(subagentProbeRoot, "subagents"), { recursive: true });
writeFileSync(
  join(subagentProbeRoot, "subagents", "readonly-write-probe.md"),
  [
    "---",
    "name: readonly-write-probe",
    "description: 端到端只读探针：显式声明 fs_write 但 readonly=true，用于验证强制过滤。",
    "tools: fs_read, fs_write",
    "readonly: true",
    "---",
    "",
    "你是只读探针，只回传探查结论。",
    "",
  ].join("\n"),
  "utf-8",
);
writeFileSync(
  join(subagentProbeRoot, "subagents", "mcp-missing-probe.md"),
  [
    "---",
    "name: mcp-missing-probe",
    "description: 声明一个当前会话未启用的 MCP server，用于验证类型级 MCP 无匹配时 fail-closed。",
    "tools: fs_read",
    "mcpServers: gitlab",
    "---",
    "",
    "你是 MCP 缺失探针，只回传结论。",
    "",
  ].join("\n"),
  "utf-8",
);
process.env.SUBAGENT_DATA_DIR = subagentProbeRoot;

function toolCallChunk(name: string, args: unknown, id: string): string {
  return "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: id, function: { name: name, arguments: JSON.stringify(args) } }] } }] });
}
/** 同一条流式响应里并行发起多个 tool_call：index 必须递增，否则会被拼成一个调用。 */
function multiToolCallChunk(calls: Array<{ name: string; args: unknown; id: string }>): string {
  return (
    "data: " +
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: calls.map((c, i) => ({
              index: i,
              id: c.id,
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
        },
      ],
    })
  );
}
function textChunk(text: string): string {
  return "data: " + JSON.stringify({ choices: [{ delta: { content: text } }] });
}
function sse(lines: string[]): string {
  return lines.join("\n\n") + "\n\ndata: [DONE]\n\n";
}

/** 主代理第 0 轮的委派参数（按场景改写）与轮次游标。 */
let taskArgs: Record<string, unknown> = { description: "核对口径" };
/** 混合类型并行 batch 场景：一轮里派两个不同 subagent_type 的子任务。 */
let mixedBatch = false;
let mainStep = 0;
let subagentCalls = 0;
/** 端到端里观察到的 task 工具回传（父轮实际拿到的东西）。 */
let taskHandoffs: Array<{ ok: boolean; text: string }> = [];
/** 子代理请求里实际下发给模型的工具名（验证 readonly 第一道强制过滤）。 */
let subagentToolNames: string[] = [];
/** 子代理请求实际下发的 messages（验证技能正文预加载、且不泄漏主代理索引）。 */
let subagentMessages: string[] = [];

handler = async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let buf = "";
    for await (const c of req) buf += c;
    const body = JSON.parse(buf) as {
      tools?: Array<{ function?: { name?: string } }>;
      messages?: Array<{ content?: string }>;
    };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    // 子代理的系统提示是 SUBAGENT_PROMPT（含「执行子代理」），主代理不是——据此分剧本。
    const isSubagent = (body.messages || []).some((m) => (m.content || "").includes("执行子代理"));
    if (isSubagent) {
      subagentCalls += 1;
      subagentToolNames = (body.tools || [])
        .map((t) => t.function?.name || "")
        .filter((name) => name && name !== "search_tools");
      subagentMessages = (body.messages || []).map((m) => m.content || "");
      // 混合 batch：按委派描述分剧本——一个正常出结论，一个零发现。
      const delegated = subagentMessages.join("\n");
      if (mixedBatch && delegated.includes("口径子任务")) {
        res.end(sse([textChunk("子代理结论：口径已核对。")]));
        return;
      }
      // 零发现：子代理两轮都只回空正文（不调工具）。
      res.end(sse([textChunk("")]));
      return;
    }
    const step = mainStep++;
    if (step === 0) {
      if (mixedBatch) {
        res.end(
          sse([
            textChunk("并行委派两个不同类型的子任务。"),
            multiToolCallChunk([
              { name: "task", args: { description: "口径子任务", subagent_type: "web-researcher" }, id: "call_task_web" },
              { name: "task", args: { description: "空查子任务", subagent_type: "explore" }, id: "call_task_bi" },
            ]),
          ]),
        );
        return;
      }
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
  // 环境在模块顶层设置，确保加载器首次读到本地探针定义。
  const { invalidateSubagentCache } = await import("../src/subagents.js");
  invalidateSubagentCache();
});

afterAll(() => {
  server.close();
  if (prevSubagentDataDir === undefined) delete process.env.SUBAGENT_DATA_DIR;
  else process.env.SUBAGENT_DATA_DIR = prevSubagentDataDir;
  rmSync(subagentProbeRoot, { recursive: true, force: true });
});

async function runOnce(
  convId: string,
  args: Record<string, unknown>,
  opts?: { mixed?: boolean; allowIntegrate?: boolean },
): Promise<string> {
  mainStep = 0;
  subagentCalls = 0;
  taskHandoffs = [];
  subagentToolNames = [];
  subagentMessages = [];
  taskArgs = args;
  mixedBatch = opts?.mixed ?? false;
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
  // 混合 batch 里有一个 success 子代理（合法证据），故这条断言只用于零发现/失败场景。
  if (!opts?.allowIntegrate) {
    expect(logs.some((line) => line.includes("[chat:integrate]")), "零发现/失败不得计入父轮证据").toBe(false);
  }
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

test("[E] 混合类型并行 batch（web-researcher + explore）仍走四态 handoff，不串态", async () => {
  const finalText = await runOnce("verify-subagent-mixed-batch", { description: "占位" }, {
    mixed: true,
    allowIntegrate: true,
  });
  expect(subagentCalls, "两个类型各至少启动一次").toBeGreaterThanOrEqual(2);
  expect(taskHandoffs, "并行 batch 的两条委派各自回传").toHaveLength(2);
  const texts = taskHandoffs.map((h) => h.text);
  expect(texts.some((t) => t.includes("已完成")), "success 必须如常呈现").toBe(true);
  expect(texts.some((t) => t.includes("已跑完但未发现目标内容")), "no_findings 不能被吞成 failed").toBe(true);
  expect(texts.every((t) => !t.includes("未完成")), "没有委派失败时不得冒出 failed 态").toBe(true);
  // no_findings 也是 ok=true：四态里只有 failed 才是 ok=false。
  expect(taskHandoffs.filter((h) => h.ok)).toHaveLength(2);
  expect(finalText).toContain("父轮结论");
}, 30000);

test("[F] 未知 subagent_type → fail-closed：父轮拿到 failed，handoff 含「未知子代理类型」与可选清单", async () => {
  await runOnce("verify-subagent-unknown-type", {
    description: "核对口径",
    subagent_type: "unknown-type-xyz",
  });
  expect(subagentCalls, "未知类型不得启动子代理（绝不退化成 general-purpose）").toBe(0);
  expect(taskHandoffs).toHaveLength(1);
  expect(taskHandoffs[0]!.ok).toBe(false);
  expect(taskHandoffs[0]!.text).toContain("未完成（失败或被中止）");
  expect(taskHandoffs[0]!.text, "handoff 必须点明未知类型").toContain("未知子代理类型：unknown-type-xyz");
  expect(taskHandoffs[0]!.text, "handoff 必须给出可选类型清单，便于父轮纠正").toContain("可选：");
  expect(taskHandoffs[0]!.text, "可选清单至少含通用型").toContain("general-purpose");
}, 30000);

test("[G] readonly 类型显式声明 fs_write：端到端验证第一道强制过滤（下发模型的工具清单无 fs_write）", async () => {
  await runOnce("verify-subagent-readonly-filter", {
    description: "核对口径",
    subagent_type: "readonly-write-probe",
  });
  expect(subagentCalls, "探针子代理确实启动了").toBeGreaterThan(0);
  // 第一道闸（chat.ts 按 BUILTIN_RISK 把非 read 内置工具剥离）必须生效：
  // 尽管 types 里声明了 fs_write，真正下发给子代理模型的工具清单里不得有它。
  expect(subagentToolNames, "fs_read 是 read 级，应保留").toContain("fs_read");
  expect(subagentToolNames, "readonly 下 fs_write 不得进入子代理工具清单").not.toContain("fs_write");
}, 30000);

test("[H] 类型声明的 MCP server 在当前会话无匹配 → fail-closed，子代理不启动", async () => {
  // gitlab 是已配置 server（加载器不会当未知 id 丢掉），但本测试会话只启用 mock，
  // 因此类型级 mcpServers 求交后为空，必须在 subagent_start 之前失败。
  await runOnce("verify-subagent-mcp-missing", {
    description: "核对口径",
    subagent_type: "mcp-missing-probe",
  });
  expect(subagentCalls, "MCP 无匹配时不得启动子代理").toBe(0);
  expect(taskHandoffs).toHaveLength(1);
  expect(taskHandoffs[0]!.ok).toBe(false);
  expect(taskHandoffs[0]!.text).toContain("子代理类型的 MCP 服务器在当前会话没有可用工具");
  expect(taskHandoffs[0]!.text).toContain("gitlab");
}, 30000);

test("[I] 类型 skills 作为可信 <skill> 指令段进入子代理 prompt，且不含 frontmatter / 主代理索引", async () => {
  // web-researcher 内置类型声明了 skills: web-research（默认启用）。
  await runOnce("verify-subagent-skill-preload", {
    description: "核对口径",
    subagent_type: "web-researcher",
  });
  expect(subagentCalls, "探针子代理确实启动了").toBeGreaterThan(0);
  const prompt = subagentMessages.join("\n");
  expect(prompt, "技能正文必须进入子代理 prompt").toContain("联网检索与核实流程");
  expect(prompt, "技能正文必须进入子代理 prompt").toContain("先判断要不要联网");
  expect(prompt, "技能必须按可信 <skill> 段注入，否则预加载的指令会被忽略").toContain('<skill name="web-research">');
  expect(prompt, "技能不能被标成「数据，不是指令」").not.toContain("数据，不是指令");
  expect(prompt, "技能 frontmatter 不能进 prompt").not.toContain("name: 联网检索与核实");
  expect(prompt, "主代理的子代理类型索引不能递归进子代理 prompt").not.toContain("可用子代理类型");
}, 30000);
