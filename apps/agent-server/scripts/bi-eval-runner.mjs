// BI text2sql 跑分器（§4.4）：加载黄金集 → 逐例经真实 agent-server(/chat/stream + BI MCP) 生成并执行 SQL
// → 逐次记录取数工具调用（工具 / SQL / 卡片 / 成败 / 行数）→ 评分（口径见 bi-eval-score.mjs）：
//   ValidSQL(有取数成功) / EX(返回非空行) / JoinCorrect(最终 SQL 用到的表覆盖期望表) + 表召回/精确率、首次成功率、尝试次数。
// 防泄题：每例把「本例卡片 + 孪生卡片」写进留出文件；agent-server 须以同一路径的 BI_EVAL_HOLDOUT_FILE 启动，
//   BI MCP 才会在检索/取卡时隐藏它们并禁用 get_golden_set（见 bi-eval-holdout.mjs）。
// 参数：--limit N / --case ID / --dry / --gap 秒(每例间隔,规避上游限流) / --resume(跳过已成功案例,断点续跑) / --model / --out
//       / --rescore 报告路径（不调模型，用报告里存的执行记录按当前评分口径重评，写到 --out）
//       / --arm caliber-on|caliber-off（P3 A/B 实验组标签，只写进报告；实际开关是 agent-server 侧的 BI_EVAL_DISABLE_CALIBER）。
// 用法：node scripts/bi-eval-runner.mjs --resume --gap 12 --out .data/bi-eval-full.json
//       node scripts/bi-eval-runner.mjs --rescore .data/bi-eval-full.json --out .data/bi-eval-full.rescored.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeKnownTables } from "./metabase-card-graph.mjs";
import {
  SCORER_VERSION,
  bareToolName,
  isExecutionTool,
  parseToolArgs,
  executionFromToolResult,
  scoreCase,
  summarize,
} from "./bi-eval-score.mjs";
import { HOLDOUT_ENV, HOLDOUT_MARK, holdoutCardIds, writeHoldout, clearHoldout, cardIdArg } from "./bi-eval-holdout.mjs";
import { loadGlossary } from "./bi-semantic.mjs";

const repo = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(repo, "..");
const goldenPath = path.join(root, "tests", "bi-golden-set.json");
const knownPath = path.join(root, "tests", "bi-known-tables.json");
const holdoutPath = path.resolve(process.env[HOLDOUT_ENV] || path.join(root, ".data", "bi-eval-holdout.json"));
const base = process.env.AGENT_BASE_URL || "http://127.0.0.1:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const opt = { limit: null, caseId: null, dry: false, gap: 0, resume: false, rescore: null, model: process.env.BI_EVAL_MODEL || "ds4flash0731", out: path.join(root, ".data", "bi-eval-report.json"), skip: new Set(), arm: null };
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--limit") opt.limit = Number(args[++i]);
  else if (args[i] === "--arm") opt.arm = String(args[++i] || "").trim() || null;
  else if (args[i] === "--case") opt.caseId = Number(args[++i]);
  else if (args[i] === "--dry") opt.dry = true;
  else if (args[i] === "--gap") opt.gap = Number(args[++i]);
  else if (args[i] === "--resume") opt.resume = true;
  else if (args[i] === "--skip") String(args[++i]).split(",").forEach((x) => opt.skip.add(Number(x.trim())));
  else if (args[i] === "--model") opt.model = args[++i];
  else if (args[i] === "--out") opt.out = args[++i];
  else if (args[i] === "--rescore") opt.rescore = args[++i];
}

// 真实 schema 表名白名单（由 bi-golden-bootstrap.mjs 导出）。缺失时 filterKnownTables 会 fail-open 退回原行为。
let knownTables = new Set();
if (fs.existsSync(knownPath)) {
  try { knownTables = normalizeKnownTables(JSON.parse(fs.readFileSync(knownPath, "utf8"))); }
  catch (e) { console.warn("[warn] 白名单加载失败，抽表不做过滤:", e.message); }
}

// 会把留出卡片内容带给模型的调用：取黄金集，或按 id 取/执行留出卡片。评测模式开着时这些会被 MCP 拒绝，
// 记下来用于核查（evalModeSeen=false 且 leaks 非空 = 这一例确实泄题了）。
function leakOf(tool, a, heldOut) {
  if (tool === "get_golden_set") return { tool };
  const id = cardIdArg(tool, a);
  if (id != null && heldOut.has(Number(id))) return { tool, cardId: Number(id) };
  return null;
}

// ---------- 真实管道驱动（复用 /chat/stream） ----------
async function api(p, m, b) {
  const r = await fetch(`${base}${p}`, { method: m, headers: { "content-type": "application/json", ...(api.cookie ? { cookie: api.cookie } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}) });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) api.cookie = sc.map((c) => c.split(";")[0]).join("; ");
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, j, t };
}

async function runOneCase(question, model, heldOut) {
  const c = await api("/chat/conversations", "POST", { title: "bi-eval" });
  const cid = c.j?.conversation?.id || c.j?.id;
  if (!cid) throw new Error("建对话失败: " + c.t.slice(0, 200));
  await api("/chat/mcp/servers", "PUT", { conversationId: cid, enabled: ["bi"] });
  const resp = await fetch(`${base}/chat/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(api.cookie ? { cookie: api.cookie } : {}) },
    body: JSON.stringify({ conversationId: cid, model, text: `请用 BI 工具写 ClickHouse SQL 回答这个问题，并最终执行它取数：${question}` }),
  });
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const calls = new Map();
  const executions = [], tools = [], leaks = [];
  let runId = null, answer = "", evalModeSeen = false, skippedCalls = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const p = line.trim();
      if (!p.startsWith("{")) continue;
      let ev;
      try { ev = JSON.parse(p); } catch { continue; }
      if (ev.runId) runId = runId || ev.runId;
      if (ev.type === "text_delta") answer += ev.text || "";
      if (ev.type === "tool_call") {
        const tool = bareToolName(ev.name);
        const a = parseToolArgs(ev.args);
        calls.set(ev.id, { name: ev.name, args: ev.args });
        tools.push(tool);
        const leak = leakOf(tool, a, heldOut);
        if (leak) leaks.push(leak);
      }
      if (ev.type === "tool_result") {
        if (typeof ev.text === "string" && ev.text.includes(HOLDOUT_MARK)) evalModeSeen = true;
        if (!isExecutionTool(ev.name)) continue;
        // executed=false：同轮重复被跳过 / 安全闸门拒绝 / 暂缓，服务端根本没执行，不算一次尝试。
        if (ev.executed === false) skippedCalls++;
        else executions.push(executionFromToolResult(ev, calls.get(ev.id) || {}));
      }
    }
  }
  return { executions, tools, leaks, evalModeSeen, skippedCalls, runId, answerChars: answer.length };
}

// ---------- 主流程 ----------
// 健壮性：把 results 提前声明，并注册全局异常处理器，保证任何崩溃都写出（含已跑完的）报告，不丢样本。
let results = [];
// 报告自带的实验组标签：--rescore 时沿用原报告的 meta，避免重评把 A/B 归属改掉。
// 口径检查用词典的全部可机检条目（含草稿）；报告里记下词典版本与状态，草稿口径的结论只作参考。
const glossary = loadGlossary();
const glossaryMeta = glossary ? { version: glossary.version, status: glossary.status } : null;
const score = (g, executions, extra = {}) =>
  scoreCase(g?.tables, executions, knownTables, { glossary, expectedSql: g?.expected_sql, ...extra });
let reportMeta = { arm: opt.arm, model: opt.model, scorerVersion: SCORER_VERSION, glossary: glossaryMeta, rescoredFrom: null };
function writeReport() {
  const summary = summarize(results);
  console.log("\n== 评分汇总 ==", JSON.stringify(summary, null, 2));
  try {
    fs.mkdirSync(path.dirname(opt.out), { recursive: true });
    fs.writeFileSync(opt.out, JSON.stringify({ meta: reportMeta, summary, results }, null, 2));
    console.log("报告已写:", opt.out);
  } catch (e) {
    console.error("写报告失败:", e);
  }
}
process.on("uncaughtException", (e) => { console.error("UNCAUGHT", e); clearHoldout(holdoutPath); writeReport(); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED", e); clearHoldout(holdoutPath); writeReport(); process.exit(1); });

const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
const goldenById = new Map(golden.cases.map((c) => [c.id, c]));

// 按当前评分口径重评已有报告条目。
// v3+ 报告有逐次执行记录 executions，直接重评；v1/v2 只有 executed（rows 不可信）+ 按顺序抽到的 generatedSqls，近似重评。
function rescoreResults(prev) {
  const version = prev.summary?.scorerVersion ?? 1;
  return (prev.results || []).map((r) => {
    if (r.error || r.selfCheck) return r;
    const g = goldenById.get(r.id);
    const expectedIncomplete = Boolean(g?.unverifiedTables?.length);
    if (Array.isArray(r.executions)) return { ...r, expectedIncomplete, ...score(g, r.executions) };
    const executions = (r.executed || []).map((e) => ({ kind: "sql", ok: e.ok, rows: version >= 2 ? e.rows ?? null : null }));
    return { ...r, expectedIncomplete, ...score(g, executions, { legacySqls: r.generatedSqls || [] }) };
  });
}

if (opt.rescore) {
  const prev = JSON.parse(fs.readFileSync(opt.rescore, "utf8"));
  results = rescoreResults(prev);
  reportMeta = { ...(prev.meta || {}), scorerVersion: SCORER_VERSION, glossary: glossaryMeta, rescoredFrom: opt.rescore };
  console.log(`[rescore] ${opt.rescore} → ${opt.out}，共 ${results.length} 例 / 白名单 ${knownTables.size} 项 / 评分口径 v${SCORER_VERSION}`);
  writeReport();
  process.exit(0);
}

// 1.3 准入检查：引用库里已不存在的表（unverifiedTableStatus 含 "missing"）的样例无法执行，退出评测基线，
// 以免污染 JoinCorrect/EX 统计（与 bi-golden-bootstrap.mjs 的准入检查一致）。
const hasMissingTable = (c) => Object.values(c.unverifiedTableStatus || {}).includes("missing");
let cases = golden.cases.filter((c) => c.expected_sql && !hasMissingTable(c));
if (opt.caseId != null) cases = cases.filter((c) => c.id === opt.caseId);
if (opt.skip.size) cases = cases.filter((c) => !opt.skip.has(c.id));

// --resume：复用已有报告里「成功」的条目，跳过已跑过的案例（失败条目不跳过，下一批会重试）。
// 放在 --limit 之前，使 `--resume --limit N` 成为「每批推进 N 例」的分批全量跑法。
if (opt.resume && !opt.dry && fs.existsSync(opt.out)) {
  try {
    const prev = JSON.parse(fs.readFileSync(opt.out, "utf8"));
    const done = rescoreResults(prev).filter((r) => !r.error && !r.selfCheck);
    results.push(...done);
    const doneIds = new Set(done.map((r) => r.id));
    cases = cases.filter((c) => !doneIds.has(c.id));
    console.log(`[resume] 复用 ${done.length} 例已完成结果，待跑 ${cases.length} 例`);
  } catch (e) {
    console.warn("[warn] 续跑报告加载失败，从零开始:", e.message);
    results = [];
  }
}
if (opt.limit != null) cases = cases.slice(0, opt.limit);
console.log(`黄金集: ${golden.cases.length} 例 / 带SQL ${golden.withSql} / 本次评测 ${cases.length} 例 / 累计结果 ${results.length} 例 / dry=${opt.dry} / gap=${opt.gap}s / 白名单 ${knownTables.size} 项 / model=${opt.model}`);

if (opt.dry) {
  // 不调模型：用「期望SQL 当生成SQL」做评分函数自检。
  for (const c of cases) {
    const sc = score(c, [{ kind: "sql", sql: c.expected_sql, ok: true, rows: 5 }]);
    results.push({ id: c.id, question: c.question, expectedIncomplete: Boolean(c.unverifiedTables?.length), ...sc, selfCheck: true });
  }
  console.log("DRY 评分自检样例:", JSON.stringify(results[0], null, 2));
} else {
  console.log(`[holdout] 留出文件 ${holdoutPath}。agent-server 须以 ${HOLDOUT_ENV}=${holdoutPath} 启动，否则不防泄题（报告里 evalModeSeen / leaks 可核查）。`);
  if (opt.arm) console.log(`[arm] ${opt.arm}：标签只写进报告，不控制 MCP；请核对 agent-server 的 BI_EVAL_DISABLE_CALIBER 与该组一致。`);
  else console.log("[warn] 未指定 --arm；A/B 对比请用 --arm caliber-on / caliber-off 标注两份报告。");
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const heldOut = new Set(holdoutCardIds(golden.cases, c.id));
    writeHoldout(holdoutPath, { caseId: c.id, cardIds: [...heldOut] });
    try {
      const run = await runOneCase(c.question, opt.model, heldOut);
      const sc = score(c, run.executions);
      results.push({ id: c.id, question: c.question, heldOut: [...heldOut], expectedIncomplete: Boolean(c.unverifiedTables?.length), ...run, ...sc });
      console.log(`#${c.id} valid=${sc.valid} ex=${sc.ex} join=${sc.joinCorrect} (any=${sc.joinCorrectAny}) attempts=${sc.attempts} caliber=${sc.caliberOk} value=${sc.valueMatch} skipped=${run.skippedCalls} card=${sc.cardShortcut ? sc.cardShortcut.cardId : "-"} leaks=${run.leaks.length}`);
    } catch (err) {
      results.push({ id: c.id, question: c.question, error: String(err.message || err) });
      console.log(`#${c.id} ERROR ${err.message || err}`);
    } finally {
      clearHoldout(holdoutPath);
    }
    writeReport(); // 每跑完一例就落盘，避免被外部 kill 丢失已完成样本
    if (opt.gap > 0 && i < cases.length - 1) await sleep(opt.gap * 1000); // 节流，规避上游限流
  }
}
writeReport();
