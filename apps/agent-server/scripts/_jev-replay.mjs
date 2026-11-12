// Jev（客服分类器）真实复跑脚本（对应 docs/agent-stall-incident-20261014.md §7「客服 Jev 路未复跑」）。
//
// 目的：验证第 7 批对 Jev 的统一治理（超时按实测派生 / 失败分类与冷却 / 额度预检 / 失败可观测 span /
// 在线评测 classifier_health）在真实客服请求下确实生效——此前这部分只有单测证据。
//
// 前置（环境自备）：
//   1) agent-server 已起在 AGENT_BASE_URL（默认 http://127.0.0.1:8787）。
//   2) .env 配了 JEV_API_KEY / JEV_BASE_URL / JEV_MODEL（Jev 的 TypeSafe / OpenRouter 密钥）。
//   3) 不要求 Zoho 连接器：Jev 的输入分类与草稿复核在 conversation.agentId==="support" 即触发，
//      与是否有 Zoho 工具无关；只是没有 Zoho 时坐席无法真正查会话/代发，Jev 仍会被调用。
//
// 用法：
//   node scripts/_jev-replay.mjs [--prompt <文本>] [--base <url>] [--trace-dir <dir>]
//   默认用内置的一条客服提问（含「查会话 + 起草含承诺的回复」以同时触发输入分类与 promise 复核）。
//
// 输出：
//   - 控制台打印 Jev 是否被调用（support_labels 事件数 + classify span 数）、分类结果、失败/超时情况、耗时。
//   - 本次 run 事件落 <trace-dir>/jev-replay-<runId>.events.json。

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

const DEFAULT_PROMPT =
  "帮我处理一个访客会话：访客问他的订单退款什么时候到账。" +
  "请起草一条回复告诉访客，退款我们已经帮他申请好了、预计 3 个工作日到账；" +
  "另外查一下这个访客最近的会话记录，看看他之前有没有类似问题。";

let prompt = DEFAULT_PROMPT;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--prompt") prompt = args[++i];
  else if (args[i] === "--base") base = args[i + 1];
  else if (args[i] === "--trace-dir") traceDir = args[++i];
}

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

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function main() {
  console.log("== Jev 复跑：/support 角色 + 客服提问 ==");
  console.log("prompt:", prompt.slice(0, 80) + (prompt.length > 80 ? "…" : ""));

  const streamRes = await fetch(`${base}/chat/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ text: prompt, agentId: "support" }),
  });
  if (!streamRes.ok) {
    console.error("[jev-replay] /chat/stream HTTP", streamRes.status, await streamRes.text());
    process.exit(1);
  }
  const sc = streamRes.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");

  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let answer = "";
  const events = [];
  const supportLabels = [];
  const toolCalls = [];
  const errors = [];
  let newRunId = null;
  let usageClassifierCalls = null;
  let usageClassifierFailures = null;
  const start = Date.now();

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
      if (ev.type === "tool_call") toolCalls.push(ev.name);
      if (ev.type === "support_labels") supportLabels.push(ev.labels);
      if (ev.type === "usage" || ev.classifierCalls != null) {
        if (typeof ev.classifierCalls === "number") usageClassifierCalls = ev.classifierCalls;
        if (typeof ev.classifierFailures === "number") usageClassifierFailures = ev.classifierFailures;
      }
      if (ev.type === "error") errors.push(ev.text || JSON.stringify(ev).slice(0, 200));
    }
  }
  const elapsedMs = Date.now() - start;

  // runId 流事件里不显式带；用 traces 目录里最新修改的 rounds/spans 文件反推。
  if (!newRunId && fs.existsSync(traceDir)) {
    const files = fs
      .readdirSync(traceDir)
      .filter((f) => f.startsWith("rounds-run_") && f.endsWith(".jsonl"))
      .map((f) => ({ f, m: fs.statSync(path.join(traceDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (files[0]) newRunId = files[0].f.replace(/^rounds-/, "").replace(/\.jsonl$/, "");
  }

  // ---- 读本次 run 的 span，统计 Jev classify 调用与失败（兜底，优先用 usage 事件计数） ----
  let classifySpans = 0;
  let classifyFailSpans = 0;
  if (newRunId) {
    const sf = path.join(traceDir, `spans-${newRunId}.jsonl`);
    if (fs.existsSync(sf)) {
      for (const line of fs.readFileSync(sf, "utf8").split("\n")) {
        const o = safeJson(line);
        if (!o) continue;
        const op = o["gen_ai.operation.name"] || o.operationName || "";
        if (/classif/i.test(op) || o.gen_ai?.operation?.name === "classify") {
          classifySpans += 1;
          if (o["error.type"]) classifyFailSpans += 1;
        }
      }
    }
  }
  const classifierCalls = usageClassifierCalls ?? (classifySpans || null);
  const classifierFailures = usageClassifierFailures ?? classifyFailSpans;

  console.log("\n== Jev 复跑结果 ==");
  console.log(`runId(新)        : ${newRunId || "?"}`);
  console.log(`总耗时           : ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`support_labels   : ${supportLabels.length} 个（Jev 分类输出，>0 即 Jev 被调用）`);
  for (const lbl of supportLabels.slice(0, 4)) {
    console.log("   labels:", JSON.stringify(lbl).slice(0, 300));
  }
  console.log(`classify span    : ${classifySpans} 个（span 级 Jev 调用）`);
  console.log(`classify 失败span: ${classifyFailSpans} 个（带 error.type）`);
  if (classifierCalls !== null) console.log(`classifierCalls  : ${classifierCalls}（usage→RunTrace）`);
  if (classifierFailures !== null) {
    console.log(`classifierFail  : ${classifierFailures}`);
    const rate = classifierCalls ? classifierFailures / classifierCalls : 0;
    console.log(`classifier_health: ${rate <= 0.2 ? "PASS(≤0.2)" : "FAIL(>0.2)"}（阈值 EVAL_MAX_CLASSIFIER_FAIL_RATE=0.2）`);
  }
  console.log(`工具调用         : ${toolCalls.length} 次（${toolCalls.slice(0, 6).join(", ")}${toolCalls.length > 6 ? "…" : ""}）`);
  console.log(`error 事件       : ${errors.length} 条`);
  console.log(`最终回答         : ${answer.trim().length} 字`);

  const evPath = path.join(traceDir, `jev-replay-${newRunId || "unknown"}.events.json`);
  fs.writeFileSync(evPath, JSON.stringify({ newRunId, prompt, elapsedMs, events }, null, 2));
  console.log(`\n事件已落盘: ${evPath}`);

  const jevCalled = supportLabels.length > 0 || classifySpans > 0;
  console.log(`\n结论: ${jevCalled ? "Jev 已真实调用 ✅" : "Jev 未被触发 ❌（检查 support 角色 / JEV_API_KEY）"}`);
  process.exit(jevCalled ? 0 : 3);
}

main().catch((e) => {
  console.error("[jev-replay] 异常:", e);
  process.exit(1);
});
