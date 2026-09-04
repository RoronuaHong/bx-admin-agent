/**
 * bx-admin-agent 特化评测适配器（业务项目层）。
 *
 * 通用部分已抽到 eval-core.mjs（assertTraceGates / summarize，纯函数，不依赖
 * 登录/cookie/worker/业务词）。本文件只负责 bx-admin-agent 特有的两件事：
 *   1) 登录拿真实 session cookie（凭证全走环境变量，无默认值）
 *   2) 用 SSE 客户端打一次真实 /chat/stream 请求，拿到 runId
 * 然后把 spans 交给 eval-core 跑红线断言 + 落库基线。
 *
 * 其他 Agent 想复用：复制本文件、改 login()/runChat() 为自己的触发方式即可，
 * 红线断言零改动（直接 import eval-core）。
 *
 * 红线：本文件不含任何业务词常量（无默认 prompt / 无硬编码账号密码）——
 * 所有环境相关值一律由环境变量或 --prompt-file 提供，缺失即报错，不猜测、不兜底。
 *
 * 用法（tsx 解析 .ts 模块）：
 *   npx tsx scripts/eval-trace-gate.mjs --prompt-file <file> [--expect-tool call_api]
 *   EVAL_COUNTRY=xx EVAL_USER=xx EVAL_PASS=xx npx tsx scripts/eval-trace-gate.mjs --prompt "…"
 * 环境变量：AGENT_BASE_URL（默认 http://localhost:8787）、EVAL_COUNTRY、EVAL_USER、EVAL_PASS（后三者必填）、
 *   EVAL_MODEL（默认 auto）、EVAL_PSEUDO_TOOLS（G3 黑名单）、EVAL_EXPECT_TOOLS（G6 期望工具）、
 *   EVAL_MAX_ROUNDS / EVAL_MAX_TOKENS（G1/G4；TOKENS 显式传入则固定阈值，否则 G4 自适应 base+perRound×rounds）
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getRun, latestRunId, getRelease } from "../src/trace.ts";
import { assertTraceGates, summarize } from "./eval-core.mjs";

const BASE_URL = process.env.AGENT_BASE_URL || `http://localhost:${process.env.AGENT_PORT || "8787"}`;

// ---- bx-admin-agent 特化：参数解析（PowerShell 中文乱码 → 优先 --prompt-file）----
const args = process.argv.slice(2);
const promptIdx = args.indexOf("--prompt");
const pfIdx = args.indexOf("--prompt-file");
let userText = "";
try {
  if (pfIdx >= 0) userText = readFileSync(args[pfIdx + 1], "utf8").trim();
  else if (promptIdx >= 0) userText = args[promptIdx + 1];
} catch (e) {
  // 读取失败不静默：明确提示（避免空 prompt 走到下方校验时丢失根因）
  console.error(`[gate] --prompt-file 读取失败: ${e instanceof Error ? e.message : e}`);
}

// ---- bx-admin-agent 特化：登录拿 cookie（凭证必填，禁止默认值）----
async function login() {
  const country = process.env.EVAL_COUNTRY;
  const username = process.env.EVAL_USER;
  const password = process.env.EVAL_PASS;
  const missing = [
    !country && "EVAL_COUNTRY",
    !username && "EVAL_USER",
    !password && "EVAL_PASS",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`缺少登录凭证环境变量：${missing.join(", ")}（禁止默认值，请在环境中提供）`);
  }
  const resp = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ country, username, password }),
  });
  const setCookie = resp.headers.get("set-cookie");
  if (!setCookie) throw new Error(`login failed, status=${resp.status}`);
  return setCookie.split(";")[0];
}

// ---- bx-admin-agent 特化：发真实请求，返回本次 runId ----
async function runChat(text) {
  const cookie = await login();
  const before = latestRunId();
  const resp = await fetch(`${BASE_URL}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ text, model: process.env.EVAL_MODEL || "auto" }),
  });
  if (resp.status !== 200 || !resp.body) throw new Error(`chat status=${resp.status}`);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done = false;
  while (!done) {
    const { value, done: d } = await reader.read();
    if (d) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      try {
        const ev = JSON.parse(line.slice(5).trim());
        if (ev.type === "done") done = true;
      } catch {
        /* ignore */
      }
    }
  }
  const after = latestRunId();
  return after && after !== before ? after : before;
}

// ---- 通用：跑断言 + 落库 ----
async function main() {
  // 无默认 prompt（避免业务词写死）：必须由 --prompt / --prompt-file 提供
  if (!userText) {
    console.log("FAIL | [gate] chat_request | 未提供 prompt：请用 --prompt \"…\" 或 --prompt-file <file>（无默认业务词）");
    finish([{ name: "chat_request", ok: false, detail: "missing prompt" }]);
    return;
  }
  let runId;
  try {
    runId = await runChat(userText);
  } catch (e) {
    console.log(`FAIL | [gate] chat_request | ${e}`);
    finish([{ name: "chat_request", ok: false, detail: String(e) }]);
    return;
  }
  if (!runId) {
    console.log("FAIL | [gate] chat_request | no trace run produced");
    finish([{ name: "chat_request", ok: false, detail: "no trace run" }]);
    return;
  }
  console.log(`PASS | [gate] chat_request | runId=${runId}`);

  const spans = getRun(runId);
  // 红线断言全部来自 eval-core（通用）；rejectMode=observe 适配本 Agent 的越权防护。
  // 伪调用黑名单（EVAL_PSEUDO_TOOLS）、期望工具（--expect-tool / EVAL_EXPECT_TOOLS）、
  // 阈值（EVAL_MAX_ROUNDS / EVAL_MAX_TOKENS）全部由环境/参数注入，本文件不写死任何工具名。
  const csv = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
  const pseudoToolNames = csv(process.env.EVAL_PSEUDO_TOOLS);
  const expectToolIdx = args.indexOf("--expect-tool");
  const expectTools = expectToolIdx >= 0 ? csv(args[expectToolIdx + 1]) : csv(process.env.EVAL_EXPECT_TOOLS);
  const maxLlmRounds = Number(process.env.EVAL_MAX_ROUNDS) || undefined;
  const maxTotalTokens = Number(process.env.EVAL_MAX_TOKENS) || undefined;
  const results = assertTraceGates({
    spans,
    rejectMode: "observe",
    pseudoToolNames,
    expectTools,
    ...(maxLlmRounds ? { maxLlmRounds } : {}),
    ...(maxTotalTokens ? { maxTotalTokens } : {}),
  });
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} | [gate] ${r.name}${r.detail ? ` | ${r.detail}` : ""}`);
  }
  finish(results, runId);
}

function finish(results, runId) {
  const sum = summarize(results);
  // 版本标识（P3）：回归基线按版本可对比（RELEASE env / git 短 sha）
  const spans = runId ? getRun(runId) : [];
  const release = spans.find((s) => s.kind === "run")?.meta?.release || getRelease();
  const summary = {
    at: new Date().toISOString(),
    prompt: userText,
    runId: runId || null,
    release,
    pass: sum.pass,
    total: sum.total,
    rate: sum.rate,
    results,
  };
  try {
    const dir = join(process.cwd(), ".data", "eval-baseline");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().slice(0, 10)}.json`);
    const prev = existsSync(file) ? JSON.parse(readFileSafe(file)) : [];
    writeFileSync(file, JSON.stringify([...prev, summary], null, 2), "utf8");
  } catch {
    /* 基线落库失败不影响闸门 */
  }
  console.log(`\n========== Trace Gate ==========`);
  console.log(`TOTAL: ${sum.pass}/${sum.total} (${sum.rate}%) | prompt="${userText}"`);
  if (sum.failed.length) process.exit(1);
}

function readFileSafe(p) {
  try {
    return require("node:fs").readFileSync(p, "utf8");
  } catch {
    return "[]";
  }
}

main();
