// BI text2sql 三维跑分器（§4.4）：加载黄金集 → 逐例经真实 agent-server(/chat/stream + BI MCP) 生成 SQL
// → 抽取模型产生的 SQL → 三维评分：ValidSQL(能跑通) / EX(返回非空行) / JoinCorrect(用到的表覆盖期望表)。
// 复用 extractTables 做表名对齐，并用真实 schema 表名白名单剔除 CTE/别名噪声。
// 参数：--limit N / --case ID / --dry / --gap 秒(每例间隔,规避上游限流) / --resume(跳过已成功案例,断点续跑) / --model / --out。
// 用法：node scripts/bi-eval-runner.mjs --resume --gap 12 --out .data/bi-eval-full.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractTables, normalizeKnownTables, filterKnownTables } from "./metabase-card-graph.mjs";

const repo = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(repo, "..");
const goldenPath = path.join(root, "tests", "bi-golden-set.json");
const knownPath = path.join(root, "tests", "bi-known-tables.json");
const base = process.env.AGENT_BASE_URL || "http://127.0.0.1:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const opt = { limit: null, caseId: null, dry: false, gap: 0, resume: false, model: process.env.BI_EVAL_MODEL || "ds4flash0731", out: path.join(root, ".data", "bi-eval-report.json"), skip: new Set() };
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--limit") opt.limit = Number(args[++i]);
  else if (args[i] === "--case") opt.caseId = Number(args[++i]);
  else if (args[i] === "--dry") opt.dry = true;
  else if (args[i] === "--gap") opt.gap = Number(args[++i]);
  else if (args[i] === "--resume") opt.resume = true;
  else if (args[i] === "--skip") String(args[++i]).split(",").forEach((x) => opt.skip.add(Number(x.trim())));
  else if (args[i] === "--model") opt.model = args[++i];
  else if (args[i] === "--out") opt.out = args[++i];
}

// 真实 schema 表名白名单（由 bi-golden-bootstrap.mjs 导出）。缺失时 filterKnownTables 会 fail-open 退回原行为。
let knownTables = new Set();
if (fs.existsSync(knownPath)) {
  try { knownTables = normalizeKnownTables(JSON.parse(fs.readFileSync(knownPath, "utf8"))); }
  catch (e) { console.warn("[warn] 白名单加载失败，抽表不做过滤:", e.message); }
}

// ---------- 三维评分 ----------
// 从工具返回的 text 中抽取「实际执行的 SQL」：Metabase MCP 在 tool_result.text 里会附带
// 「-- 实际执行的 SQL（仅供核对，不要重复执行）：\n<SQL>」。这是 join 正确性评测的可靠来源（SSE 的 tool_call 不携带参数）。
function sqlFromResultText(t) {
  if (typeof t !== "string") return null;
  const m = t.match(/实际执行的 SQL[^\n]*\n([\s\S]*?)(?:\n\n|$)/);
  if (m && m[1].trim()) return m[1].trim();
  const line = t.split("\n").find((l) => /\bselect\b|\bwith\b/i.test(l));
  return line ? line.trim() : null;
}

function scoreCase(expectedTables, generatedSqls, executed, known = new Set()) {
  const valid = executed.some((e) => e.ok); // 有 BI 查询工具成功执行即算「能跑通」
  const ex = executed.some((e) => e.ok && e.rows > 0); // 返回了非空行
  const rawUsed = new Set();
  for (const s of generatedSqls) for (const t of extractTables(s)) rawUsed.add(t);
  // 与真实 schema 表名白名单求交：滤掉 CTE 名 / 表别名（`od`/`u`/`m5`…），避免 usedTables 失真与假阳性命中。
  const usedTables = new Set(filterKnownTables([...rawUsed], known));
  const exp = filterKnownTables(expectedTables || [], known);
  // 仅当我们成功抽出生成 SQL 时才评 join 正确性；抽不到（如 execute_query 走卡片 id）标 null 表示未知。
  let joinCorrect = null;
  if (generatedSqls.length > 0 && exp.length > 0) {
    const overlap = exp.filter((t) => usedTables.has(t)).length;
    joinCorrect = overlap === exp.length;
  }
  return { valid, ex, joinCorrect, usedTables: [...usedTables], rawUsedTables: [...rawUsed] };
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

async function runOneCase(question, model) {
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
  let generatedSqls = [], executed = [], runId = null, answer = "";
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
      if (ev.type === "run_start" && ev.runId) runId = ev.runId;
      if (ev.type === "text_delta") answer += ev.text || "";
      if (ev.type === "tool_call") {
        const nm = ev.name || "";
        if (/sql|native_query/i.test(nm)) {
          // SSE 里工具参数在 ev.args（数组）；SQL 是其中一段像 SELECT/FROM 的字符串。
          const a = ev.args;
          let sql = null;
          if (Array.isArray(a)) {
            for (const x of a) if (typeof x === "string" && /\bselect\b|\bwith\b/i.test(x)) { sql = x; break; }
          } else if (a && typeof a === "object") {
            sql = a.sql || a.query || null;
          }
          if (sql) generatedSqls.push(sql);
        }
      }
      if (ev.type === "tool_result") {
        const nm = ev.name || "";
        if (/sql|native_query/i.test(nm)) {
          // 实际执行的 SQL 在 tool_result.text 里（形如「-- 实际执行的 SQL（...）：\n<SQL>」）；这是 join 正确性评测的可靠来源。
          const sql = sqlFromResultText(ev.text);
          if (sql) generatedSqls.push(sql);
          executed.push({ ok: ev.ok !== false, rows: Array.isArray(ev.rows) ? ev.rows.length : ev.rowCount ?? (ev.text ? 1 : 0) });
        }
      }
    }
  }
  return { generatedSqls, executed, runId, answer };
}

// ---------- 主流程 ----------
// 健壮性：把 results 提前声明，并注册全局异常处理器，保证任何崩溃都写出（含已跑完的）报告，不丢样本。
let results = [];
function writeReport() {
  const real = results.filter((r) => !r.selfCheck && !r.error);
  const withValid = results.filter((r) => r.valid).length;
  const withEx = results.filter((r) => r.ex).length;
  const joinKnown = results.filter((r) => r.joinCorrect !== null);
  const joinOk = joinKnown.filter((r) => r.joinCorrect).length;
  const summary = {
    total: results.length,
    realRuns: real.length,
    validRate: results.length ? withValid / results.length : 0,
    exRate: results.length ? withEx / results.length : 0,
    joinCorrectRate: joinKnown.length ? joinOk / joinKnown.length : null,
    errors: results.filter((r) => r.error).length,
  };
  console.log("\n== 三维评分汇总 ==", JSON.stringify(summary, null, 2));
  try {
    fs.mkdirSync(path.dirname(opt.out), { recursive: true });
    fs.writeFileSync(opt.out, JSON.stringify({ summary, results }, null, 2));
    console.log("报告已写:", opt.out);
  } catch (e) {
    console.error("写报告失败:", e);
  }
}
process.on("uncaughtException", (e) => { console.error("UNCAUGHT", e); writeReport(); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED", e); writeReport(); process.exit(1); });

const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
let cases = golden.cases.filter((c) => c.expected_sql);
if (opt.caseId != null) cases = cases.filter((c) => c.id === opt.caseId);
if (opt.skip.size) cases = cases.filter((c) => !opt.skip.has(c.id));

// --resume：复用已有报告里「成功」的条目，跳过已跑过的案例（失败条目不跳过，下一批会重试）。
// 放在 --limit 之前，使 `--resume --limit N` 成为「每批推进 N 例」的分批全量跑法。
if (opt.resume && !opt.dry && fs.existsSync(opt.out)) {
  try {
    const prev = JSON.parse(fs.readFileSync(opt.out, "utf8"));
    const done = (prev.results || []).filter((r) => !r.error && !r.selfCheck);
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
    const sc = scoreCase(c.tables, [c.expected_sql], [{ ok: true, rows: 5 }], knownTables);
    results.push({ id: c.id, question: c.question, ...sc, selfCheck: true });
  }
  console.log("DRY 评分自检样例:", JSON.stringify(results[0], null, 2));
} else {
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    try {
      const { generatedSqls, executed, runId } = await runOneCase(c.question, opt.model);
      const sc = scoreCase(c.tables, generatedSqls, executed, knownTables);
      results.push({ id: c.id, question: c.question, runId, generatedSqls, executed, ...sc });
      console.log(`#${c.id} valid=${sc.valid} ex=${sc.ex} join=${sc.joinCorrect} used=${sc.usedTables.length} (raw=${sc.rawUsedTables.length})`);
    } catch (err) {
      results.push({ id: c.id, question: c.question, error: String(err.message || err) });
      console.log(`#${c.id} ERROR ${err.message || err}`);
    }
    writeReport(); // 每跑完一例就落盘，避免被外部 kill 丢失已完成样本
    if (opt.gap > 0 && i < cases.length - 1) await sleep(opt.gap * 1000); // 节流，规避上游限流
  }
}
writeReport();
