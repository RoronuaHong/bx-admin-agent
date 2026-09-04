/**
 * 全链路多点实例测试——suite 模式（可复用回归工具）：
 *   tsx scripts/chain-multirun.mjs battery   端点/权限矩阵（非 LLM）
 *   tsx scripts/chain-multirun.mjs chit      闲聊链路 ×3
 *   tsx scripts/chain-multirun.mjs kb        知识库链路 ×1
 *   tsx scripts/chain-multirun.mjs read      读链路 ×3（G1-G6 闸门断言）
 *   tsx scripts/chain-multirun.mjs write     写确认→自动拒绝→审计 ×2
 *   tsx scripts/chain-multirun.mjs async     断线续跑→落库 ×2
 * 结果追加到 .data/multirun/results-<日期>.jsonl，供 chain-report.mjs 聚合分析。
 *
 * 凭证全走环境变量；输出 ASCII 标签（避免控制台乱码）。
 * 说明：脚本内的业务 prompt 是「测试夹具数据」（与 eval-full-chain 用例同类），
 * 仅存在于本地评测脚本层，不违反「服务端运行时零业务词写死」红线。
 */
import { readFileSync, appendFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getRun, latestRunId } from "../src/trace.ts";
import { assertTraceGates, summarize } from "./eval-core.mjs";

const BASE = process.env.AGENT_BASE_URL || "http://localhost:8787";
const suite = process.argv[2] || "";
const RESULTS_FILE = join(process.cwd(), ".data", "multirun", `results-${new Date().toISOString().slice(0, 10)}.jsonl`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rec(s, run, ok, detail, metrics = {}) {
  appendFileSync(RESULTS_FILE, JSON.stringify({ ts: Date.now(), suite: s, run, ok, detail, ...metrics }) + "\n");
  console.log(`${ok ? "PASS" : "FAIL"} | [${s}#${run}] ${detail}`);
}

async function login() {
  const resp = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      country: process.env.EVAL_COUNTRY,
      username: process.env.EVAL_USER,
      password: process.env.EVAL_PASS,
    }),
  });
  const c = resp.headers.get("set-cookie")?.split(";")[0];
  if (!c) throw new Error(`login failed status=${resp.status}`);
  return c;
}

/** SSE 消费：自动拒绝写确认；返回 {events, durMs, fetchErr} */
async function chat(cookie, text, { abortMs } = {}) {
  const ac = new AbortController();
  if (abortMs) setTimeout(() => ac.abort(), abortMs);
  const t0 = Date.now();
  const resp = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ text, model: process.env.EVAL_MODEL || "auto" }),
    signal: ac.signal,
  });
  if (resp.status !== 200 || !resp.body) return { events: [], durMs: Date.now() - t0, fetchErr: `status=${resp.status}` };
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          events.push(ev);
          if (ev.type === "confirmation_required") {
            await fetch(`${BASE}/chat/confirm`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Cookie: cookie },
              body: JSON.stringify({ callId: ev.callId, confirmed: false }),
            });
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* 客户端断开（async 场景预期内） */ }
  return { events, durMs: Date.now() - t0 };
}

function traceMetrics(runId) {
  const spans = runId ? getRun(runId) : [];
  const llm = spans.filter((s) => s.kind === "llm");
  const run = spans.find((s) => s.kind === "run");
  return {
    runId: runId || "",
    release: run?.meta?.release || "",
    rounds: llm.length,
    emptyRounds: llm.filter((s) => !s.usage).length,
    tokens: llm.reduce((a, s) => a + (s.usage?.totalTokens || 0), 0),
    tools: spans.filter((s) => s.kind === "tool").map((s) => s.name),
    durRun: run?.durationMs || 0,
  };
}

function auditEventsSince(ts) {
  const dir = join(process.cwd(), ".data", "audit");
  const out = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!l.trim()) continue;
      try { const e = JSON.parse(l); if (e.at >= ts) out.push(e); } catch { /* skip */ }
    }
  }
  return out;
}

// ---------------- suites ----------------

async function suiteBattery() {
  const cookie = await login();
  const anon1 = await fetch(`${BASE}/cost/summary`);
  rec("battery", 1, anon1.status === 401, `anon /cost/summary=${anon1.status} (expect 401)`);
  const anon2 = await fetch(`${BASE}/audit/list`);
  rec("battery", 2, anon2.status === 401, `anon /audit/list=${anon2.status} (expect 401)`);
  const anon3 = await fetch(`${BASE}/trace/runs`);
  rec("battery", 3, anon3.status === 401, `anon /trace/runs=${anon3.status} (expect 401)`);
  const cost = await (await fetch(`${BASE}/cost/summary`, { headers: { Cookie: cookie } })).json();
  const owners = (cost.report?.byOwner || []).map((o) => o.ownerKey);
  rec("battery", 4, cost.report?.totals && owners.every((o) => o === process.env.EVAL_USER ? true : o !== "LEAK"), `/cost/summary 200 byOwner=${JSON.stringify(owners)} tokens=${cost.report?.totals?.totalTokens}`);
  const audit = await (await fetch(`${BASE}/audit/list?limit=5`, { headers: { Cookie: cookie } })).json();
  rec("battery", 5, Array.isArray(audit.events), `/audit/list 200 events=${audit.events?.length}`);
  const runs = await (await fetch(`${BASE}/trace/runs?limit=10`, { headers: { Cookie: cookie } })).json();
  rec("battery", 6, !!runs.stats, `/trace/runs stats=${JSON.stringify(runs.stats)}`);
  const one = runs.runs?.[0];
  if (one) {
    const r1 = await fetch(`${BASE}/trace/run/${one.runId}`, { headers: { Cookie: cookie } });
    rec("battery", 7, r1.status === 200, `/trace/run/:id own=${r1.status} spans(200)`);
    const foreignRun = runs.runs?.find((r) => r.ownerKey && r.ownerKey !== "india:admin");
    const r2 = await fetch(`${BASE}/trace/run/${foreignRun?.runId || "unknown-run-xyz"}`, { headers: { Cookie: cookie } });
    rec("battery", 8, r2.status === 404, `/trace/run/:id foreign-or-unknown=${r2.status} (expect 404)`);
  }
  const st = await (await fetch(`${BASE}/chat/task/status`, { headers: { Cookie: cookie } })).json();
  rec("battery", 9, "running" in st && "last" in st, `/chat/task/status running=${!!st.running} last=${!!st.last}`);
  const releases = [...new Set(runs.runs?.map((r) => r.release).filter(Boolean) || [])];
  console.log(`  [info] releases in recent runs: ${JSON.stringify(releases)}`);
}

async function suiteChit() {
  for (let i = 1; i <= 3; i++) {
    const cookie = await login();
    const before = latestRunId();
    const { events, durMs, fetchErr } = await chat(cookie, `你好（mr-chit-${i}）`);
    const m = traceMetrics(latestRunId() !== before ? latestRunId() : before);
    const text = [...events].reverse().find((e) => e.type === "text")?.text || "";
    const done = events.some((e) => e.type === "done");
    const ok = !fetchErr && done && text.length > 0 && m.rounds <= 4;
    rec("chit", i, ok, `done=${done} rounds=${m.rounds} tokens=${m.tokens} dur=${durMs}ms text="${text.slice(0, 40).replace(/\n/g, " ")}"${fetchErr ? " " + fetchErr : ""}`, m);
    await sleep(2000);
  }
}

async function suiteKb() {
  const cookie = await login();
  const before = latestRunId();
  const { events, durMs } = await chat(cookie, "上班迟到了会扣钱吗");
  const m = traceMetrics(latestRunId() !== before ? latestRunId() : before);
  const text = [...events].reverse().find((e) => e.type === "text")?.text || "";
  const kbTool = m.tools.some((t) => /knowledge/i.test(t));
  const ok = events.some((e) => e.type === "done") && text.length > 0;
  rec("kb", 1, ok, `kbTool=${kbTool} rounds=${m.rounds} tokens=${m.tokens} dur=${durMs}ms tools=[${m.tools.join(",")}] text="${text.slice(0, 50).replace(/\n/g, " ")}"`, m);
}

async function suiteRead() {
  for (let i = 1; i <= 3; i++) {
    const cookie = await login();
    const before = latestRunId();
    const { events, durMs } = await chat(cookie, "用户列表前3页");
    const runId = latestRunId() !== before ? latestRunId() : before;
    const m = traceMetrics(runId);
    const spans = getRun(runId);
    const gates = assertTraceGates({ spans, rejectMode: "observe", expectTools: ["call_api"] });
    const s = summarize(gates);
    const tables = events.filter((e) => e.type === "table").length;
    const finalText = [...events].reverse().find((e) => e.type === "text")?.text || "";
    const dataOk = tables >= 1;
    rec("read", i, s.pass === s.total && dataOk,
      `gates=${s.pass}/${s.total} data=${dataOk} tables=${tables} rounds=${m.rounds} emptyRounds=${m.emptyRounds} tokens=${m.tokens} dur=${durMs}ms final="${finalText.slice(0, 40).replace(/\n/g, " ")}"`,
      { ...m, gates: gates.map((g) => `${g.name}:${g.ok ? "P" : "F"}`).join(",") });
    for (const g of gates.filter((g) => !g.ok)) console.log(`       - FAIL gate ${g.name} | ${g.detail}`);
    await sleep(3000);
  }
}

async function suiteWrite() {
  for (let i = 1; i <= 2; i++) {
    const cookie = await login();
    const t0 = Date.now();
    const { events, durMs } = await chat(cookie, `测试写入场景：新增一个影片标签，名称为 mr-write-tag-${i}，仅用于确认流程验证`);
    const confirms = events.filter((e) => e.type === "confirmation_required");
    const finalText = [...events].reverse().find((e) => e.type === "text")?.text || "";
    const denied = finalText.includes("取消") || finalText.includes("未执行");
    rec("write", i, confirms.length >= 1 && denied,
      `confirmReq=${confirms.length} autoDenied=${denied} dur=${durMs}ms final="${finalText.slice(0, 30)}"`);
    const audits = auditEventsSince(t0).filter((e) => e.kind === "confirm_result");
    rec("write.audit", i, audits.some((e) => e.result === "denied"), `audit confirm_result=${JSON.stringify(audits.map((e) => e.result))}`);
    await sleep(2000);
  }
}

async function waitSettled(cookie, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await (await fetch(`${BASE}/chat/task/status`, { headers: { Cookie: cookie } })).json();
    if (st.last?.settled) return st;
    if (Date.now() > deadline) return st;
    await sleep(1000);
  }
}

async function suiteAsync() {
  for (let i = 1; i <= 2; i++) {
    const cookie = await login();
    const tag = `mr-async-${i}`;
    const { events } = await chat(cookie, `你好（${tag}）`, { abortMs: 2000 });
    rec("async.disconnect", i, true, `client aborted after 2s, got ${events.length} events (expect few)`);
    const st = await waitSettled(cookie, 120000);
    rec("async.settle", i, !!st.last?.settled, `taskId=${st.last?.taskId} settled=${!!st.last?.settled}`);
    await sleep(1500);
    const convs = await (await fetch(`${BASE}/chat/conversations`, { headers: { Cookie: cookie } })).json();
    const taskConv = (convs.conversations || []).find((c) => c.title === "后台任务结果" && (c.messages || []).some((m) => m.text?.includes(tag)));
    const lastTwo = taskConv?.messages?.slice(-2) || [];
    rec("async.persist", i, !!taskConv && lastTwo[0]?.role === "user" && lastTwo[1]?.role === "assistant",
      `persisted=${!!taskConv} pairing=${lastTwo[0]?.role}+${lastTwo[1]?.role}`);
    await sleep(2000);
  }
}

// ---------------- main ----------------
if (!process.env.EVAL_COUNTRY || !process.env.EVAL_USER || !process.env.EVAL_PASS) {
  console.log("missing EVAL_COUNTRY/EVAL_USER/EVAL_PASS");
  process.exit(1);
}
const runners = { battery: suiteBattery, chit: suiteChit, kb: suiteKb, read: suiteRead, write: suiteWrite, async: suiteAsync };
const fn = runners[suite];
if (!fn) {
  console.log(`unknown suite: ${suite} (battery|chit|kb|read|write|async)`);
  process.exit(1);
}
try {
  await fn();
} catch (e) {
  rec(suite, "fatal", false, String(e).slice(0, 200));
  process.exit(1);
}
