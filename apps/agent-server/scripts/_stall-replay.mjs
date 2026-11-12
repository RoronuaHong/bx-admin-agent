// 取数卡死事故「真实复跑」脚本（对应 docs/agent-stall-incident-20261014.md §9 复跑方法）。
//
// 用途：用事故 run 的原始 userText（从 .data/traces/runs-*.jsonl 现取，不落盘、不进仓库，
// 符合零业务词红线）驱动一次真实对话，复算 §5 验收口径与 §7 遗留项（L4 toolRepeatMax、
// [chat:compact] 是否产出），验证前 11 批修复的闭环效果。
//
// 前置（本脚本不负责任，需环境自备）：
//   1) agent-server 已起在 AGENT_BASE_URL（默认 http://127.0.0.1:8787）。
//   2) BI(Metabase) 内置 MCP 连接器已配且真实后端可达（MCP_BUILTIN_SERVERS 里的那个）。
//   3) 模型额度已恢复（否则第 9 批 P0-1/C4 会直接把免费档冷却到 UTC 日切，复跑无结论——
//      那本身也是修复的预期行为，不是脚本 bug）。
//
// 用法：
//   node scripts/_stall-replay.mjs [runId] [model] [--mcp <id>] [--trace-dir <dir>] [--base <url>]
//   runId 缺省取事故 run：run_c284e83d-e327-458c-ae6c-52de5a0d8bb1
//   --mcp 缺省时，自动从 GET /chat/mcp/servers 里挑第一个 builtin 且名字像 bi/metabase 的启用。
//
// 输出：
//   - 控制台打印 §9 风格验收表（开场429 / 工具错误 / 综合轮 / 总耗时 / toolRepeatMax）。
//   - 本次 run 的完整事件落 <trace-dir>/replay-<runId>.events.json（便于事后核对）。
//   - 末尾提示去 server 控制台看 [chat:compact] / watchdog 行（[chat:compact] 走服务端日志，
//     不进 HTTP 流；若想自动抓，把 server 日志路径传给 --server-log）。

import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.dirname(fileURLToPath(import.meta.url));
const traceDir =
  process.env.AGENT_DATA_DIR != null
    ? path.join(process.env.AGENT_DATA_DIR, "traces")
    : path.join(repo, "..", ".data", "traces");
const base = process.env.AGENT_BASE_URL || "http://127.0.0.1:8787";

const ACCIDENT_RUN = "run_c284e83d-e327-458c-ae6c-52de5a0d8bb1";
const args = process.argv.slice(2);
const positional = [];
let mcpId;
let serverLog;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--mcp") mcpId = args[++i];
  else if (a === "--trace-dir") traceDir = args[++i];
  else if (a === "--base") base = args[++i];
  else if (a === "--server-log") serverLog = args[++i];
  else if (a.startsWith("--")) {
    /* ignore unknown flags */
  } else positional.push(a);
}
const runId = positional[0] || ACCIDENT_RUN;
const model = positional[1];

// ---- 1) 取事故原始提问（不落盘，只用于本次回放） ----
function findUserText(targetRunId) {
  if (!fs.existsSync(traceDir)) return null;
  for (const f of fs.readdirSync(traceDir)) {
    if (!f.startsWith("runs-") || !f.endsWith(".jsonl")) continue;
    const lines = fs.readFileSync(path.join(traceDir, f), "utf8").split("\n");
    for (const line of lines) {
      const o = safeJson(line);
      if (o && o.runId === targetRunId && typeof o.userText === "string") return o.userText;
    }
  }
  return null;
}
function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ---- HTTP helpers（会话 cookie 透传，对齐 _demo-fullchain-e2e.mjs） ----
let cookie = "";
async function api(p, method, body) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

function is429Notice(t) {
  if (typeof t !== "string") return false;
  return /429|每日配额|cooldown|配额|额度/.test(t);
}

async function main() {
  const userText = findUserText(runId);
  if (!userText) {
    console.error(`[replay] 在 ${traceDir} 找不到 runId=${runId} 的 userText（确认 trace 已落盘 / runId 正确）`);
    process.exit(2);
  }
  console.log(`== 复跑目标 runId=${runId} ==`);
  console.log(`== userText 预览（${userText.length} 字，仅本机回放，不落盘）：==`);
  console.log("    " + userText.replace(/\n/g, " ").slice(0, 120) + (userText.length > 120 ? "…" : ""));

  // ---- 2) 建对话 ----
  const conv = await api("/chat/conversations", "POST", { title: `stall-replay ${runId}` });
  const convId = conv.json?.conversation?.id || conv.json?.id;
  if (!convId) {
    console.error("[replay] 建对话失败:", conv.status, conv.text.slice(0, 300));
    console.error("        确认 agent-server 已在", base, "运行且可连。");
    process.exit(1);
  }
  console.log("convId=", convId);

  // ---- 3) 选并启用 BI 连接器 ----
  if (!mcpId) {
    const list = await api("/chat/mcp/servers", "GET");
    const servers = list.json?.available || list.json?.servers || [];
    const bi = servers.find(
      (s) => s.slot === "builtin" && /bi|metabase|business|数仓|分析/.test(String(s.id + " " + (s.label || ""))),
    );
    mcpId = bi?.id || (Array.isArray(servers) && servers[0]?.id);
  }
  if (mcpId) {
    const en = await api("/chat/mcp/servers", "PUT", { conversationId: convId, enabled: [mcpId] });
    console.log("启用连接器:", mcpId, en.json?.enabled ?? en.status);
  } else {
    console.log("未指定也未自动发现 BI 连接器；按当前对话默认连接器跑。");
  }

  // ---- 4) 流式回放，收集事件 ----
  const streamRes = await fetch(`${base}/chat/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ text: userText, ...(model ? { model } : {}), conversationId: convId }),
  });
  if (!streamRes.ok) {
    console.error("[replay] /chat/stream HTTP", streamRes.status, await streamRes.text());
    process.exit(1);
  }
  const sc = streamRes.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");

  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let answer = "";
  const events = [];
  const toolCalls = [];
  const toolResults = [];
  const errors = [];
  const models = [];
  const notice429 = [];
  const start = Date.now();
  let newRunId = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const payload = line.trim();
      if (!payload.startsWith("{")) continue;
      let ev;
      try {
        ev = JSON.parse(payload);
      } catch {
        continue;
      }
      events.push(ev);
      if (ev.type === "run_start" || ev.runId) newRunId = newRunId || ev.runId;
      if (ev.type === "text_delta") answer += ev.text;
      if (ev.type === "model" && ev.id) models.push(ev.id);
      if (ev.type === "tool_call") toolCalls.push(ev.name);
      if (ev.type === "tool_result")
        toolResults.push({ name: ev.name, ok: ev.ok, text: (ev.text || "").slice(0, 160) });
      if (ev.type === "error") {
        errors.push(ev.text || JSON.stringify(ev).slice(0, 200));
        if (is429Notice(ev.text)) notice429.push(ev.text);
      }
      if ((ev.type === "notice" || ev.type === "model_notice") && is429Notice(ev.text)) notice429.push(ev.text);
    }
  }
  const elapsedMs = Date.now() - start;

  // ---- 5) 读本次 run 的 trace 文件，补算 §9 / §7 指标 ----
  let synthesisRounds = 0;
  let toolRepeatMax = 0;
  const toolCount = {};
  if (!newRunId) {
    // 回退：取 traces 目录下最新修改的 rounds 文件
    const files = fs
      .readdirSync(traceDir)
      .filter((f) => f.startsWith("rounds-run_") && f.endsWith(".jsonl"))
      .map((f) => ({ f, m: fs.statSync(path.join(traceDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (files[0]) newRunId = files[0].f.replace(/^rounds-/, "").replace(/\.jsonl$/, "");
  }
  if (newRunId) {
    const rf = path.join(traceDir, `rounds-${newRunId}.jsonl`);
    if (fs.existsSync(rf)) {
      for (const line of fs.readFileSync(rf, "utf8").split("\n")) {
        const o = safeJson(line);
        if (!o) continue;
        if (o.mode === "synthesis") synthesisRounds += 1;
      }
    }
  }
  for (const name of toolCalls) {
    toolCount[name] = (toolCount[name] || 0) + 1;
    if (toolCount[name] > toolRepeatMax) toolRepeatMax = toolCount[name];
  }

  const toolErrors = toolResults.filter((r) => r.ok === false).length;
  const finalAnswerLen = answer.trim().length;

  // ---- 6) 打印 §9 风格验收表 ----
  const open429 = notice429.length; // 近似：流内 429/配额/cooldown 提示数
  console.log("\n== 复跑验收（§5 口径 + §7 遗留） ==");
  console.log(`runId(新)        : ${newRunId || "?"}`);
  console.log(`总耗时           : ${(elapsedMs / 1000).toFixed(1)}s   （§5 目标 <300s）`);
  console.log(`开场 429/配额提示: ${open429} 次   （§9 复跑=0；近似：流内提示数）`);
  console.log(`工具错误         : ${toolErrors} 次（tool_result ok=false） + ${errors.length} 条 error 事件`);
  console.log(`综合轮(synthesis): ${synthesisRounds} 次   （§5 目标 ≥1）`);
  console.log(`toolRepeatMax    : ${toolRepeatMax} 次（§7 L4 基线 32；越低越好）`);
  console.log(`总工具调用       : ${toolCalls.length} 次`);
  console.log(`最终回答         : ${finalAnswerLen} 字 ${finalAnswerLen > 0 ? "✅" : "❌ 空屏"}`);
  console.log(`模型出场         : ${[...new Set(models)].join(", ") || "?"}`);

  // ---- 7) [chat:compact] 观察提示 / 自动抓 ----
  if (serverLog && fs.existsSync(serverLog)) {
    const log = fs.readFileSync(serverLog, "utf8");
    const compactLines = log.split("\n").filter((l) => l.includes("[chat:compact]"));
    const watchdogLines = log.split("\n").filter((l) => l.includes("[chat:watchdog]"));
    console.log(`\n[chat:compact] 行数: ${compactLines.length}（server 日志：${serverLog}）`);
    console.log(`[chat:watchdog] 行数: ${watchdogLines.length}（看门狗是否触发收口）`);
    if (compactLines.length) console.log("   示例:", compactLines.slice(-1)[0].slice(0, 200));
  } else {
    console.log("\n[chat:compact] / [chat:watchdog] 走 server 控制台日志，不进 HTTP 流。");
    console.log("  若要自动抓取，把 server 日志路径传给 --server-log <path>。");
  }

  // ---- 8) 落盘事件，便于事后核对 ----
  const evPath = path.join(traceDir, `replay-${newRunId || runId}.events.json`);
  fs.writeFileSync(evPath, JSON.stringify({ runId, newRunId, convId, model, elapsedMs, events }, null, 2));
  console.log(`\n事件已落盘: ${evPath}`);

  const pass = finalAnswerLen > 0 && synthesisRounds >= 1 && elapsedMs < 300_000;
  console.log(`\n结论: ${pass ? "PASS（有结论 + 综合轮 + 未超时）" : "需人工核对（见上表）"}`);
  process.exit(pass ? 0 : 3);
}

main().catch((e) => {
  console.error("[replay] 异常:", e);
  process.exit(1);
});
