// BI 跑分器的纯评分函数（不连 BI、不发请求），供 bi-eval-runner.mjs 与单测共用。
import { extractTables, filterKnownTables } from "./metabase-card-graph.mjs";
import { checkCaliber } from "./bi-semantic.mjs";
import { assertSql } from "./bi-query-guard.mjs";

/**
 * 评分口径版本，写进报告 summary；--rescore 据此判断旧报告里哪些字段可信。
 * v1：rows 拿不到时记 1（EX 恒等于 ValidSQL）；表名精确比对。
 * v2：rows 取自 [feedback] 行；表名按裸名比对；JoinCorrect 仍取所有尝试的并集。
 * v3：逐次记录执行（工具 / SQL / 卡片 / 成败 / 行数）；JoinCorrect 按最终 SQL 判定。
 * v4：按口径词典检查最终 SQL 的关键口径（caliberOk / caliberViolations）。
 * v5：金样 SQL 里的字符串过滤值是否原样出现在最终 SQL（valueMatch / missingValues）。
 */
export const SCORER_VERSION = 5;

/** BI MCP 的取数工具（去掉 `mcp__<server>__` 前缀后的名字）。`query` 视参数走 SQL 或卡片。 */
const SQL_TOOLS = new Set(["run_native_query", "execute_sql"]);
const CARD_TOOLS = new Set(["execute_query"]);
const MIXED_TOOLS = new Set(["query"]);

export function bareToolName(name) {
  const s = String(name || "");
  const m = s.match(/^mcp__[^_]+(?:_[^_]+)*?__(.+)$/);
  return m ? m[1] : s;
}

export function isExecutionTool(name) {
  const t = bareToolName(name);
  return SQL_TOOLS.has(t) || CARD_TOOLS.has(t) || MIXED_TOOLS.has(t);
}

/** SSE 里 tool_call.args 是 JSON 字符串（chat.ts 直接透传 argsJson）；也兼容对象。解析失败返回 {}。 */
export function parseToolArgs(args) {
  if (args && typeof args === "object" && !Array.isArray(args)) return args;
  if (typeof args !== "string" || !args.trim()) return {};
  try {
    const v = JSON.parse(args);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// Metabase MCP 在成功结果里附带「-- 实际执行的 SQL（仅供核对，不要重复执行）：\n<SQL>」（只读闸门处理后的真实执行语句）。
export function sqlFromResultText(t) {
  if (typeof t !== "string") return null;
  const m = t.match(/实际执行的 SQL[^\n]*\n([\s\S]*?)(?:\n\n|$)/);
  if (m && m[1].trim()) return m[1].trim();
  return null;
}

// 结果文本末尾的机读反馈行：「-- [feedback] {"ok":true,...,"rowCount":N,...}」（bi-query-guard.renderFeedbackLine）。
export function feedbackFromResultText(t) {
  if (typeof t !== "string") return null;
  const m = t.match(/-- \[feedback\] (\{.*\})\s*$/m);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** chat.ts truncateResult 的截断标记：结果超过 MCP_MAX_TOOL_RESULT_CHARS 被截尾，末尾的 [feedback] 行随之丢失。 */
const SERVER_TRUNCATED = /…（结果已截断，原始长度 \d+ 字符/;

/** 卡片执行结果没有 [feedback] 行：文本是「表头 \n 数据行… [\n …(已截断…)]」，数据行数 = 非空行 − 表头。 */
function rowsFromCardText(t) {
  const lines = t.split("\n").filter((l) => l.trim() && !l.startsWith("…("));
  return Math.max(0, lines.length - 1);
}

/**
 * 一次取数工具调用 → 执行记录。
 * rows：拿不到时为 null（未知），不臆造；nonEmpty：结果被服务端按长度截断时，必然有数据（空结果不可能超长）。
 */
export function executionFromToolResult(ev, call = {}) {
  const tool = bareToolName(ev?.name || call.name);
  const args = parseToolArgs(call.args);
  const text = typeof ev?.text === "string" ? ev.text : "";
  const fb = feedbackFromResultText(text);
  const cardId = args.question_id ?? args.card_id ?? null;
  const kind = CARD_TOOLS.has(tool) || (MIXED_TOOLS.has(tool) && cardId != null) ? "card" : "sql";
  const ok = ev?.ok !== false && fb?.ok !== false;
  const truncated = SERVER_TRUNCATED.test(text);
  let rows = null;
  if (Array.isArray(ev?.rows)) rows = ev.rows.length;
  else if (typeof ev?.rowCount === "number") rows = ev.rowCount;
  else if (typeof fb?.rowCount === "number") rows = fb.rowCount;
  else if (ok && kind === "card" && text && !truncated) rows = rowsFromCardText(text);
  const sql = kind === "sql" ? sqlFromResultText(text) || args.query || args.sql || null : null;
  return { tool, kind, sql, cardId: cardId == null ? null : Number(cardId), ok, rows, nonEmpty: ok && (rows > 0 || truncated) };
}

/** 取数语句（DESCRIBE / SHOW / EXPLAIN 等元数据语句不算回答问题的 SQL）。 */
export function isAnswerSql(sql) {
  if (typeof sql !== "string") return false;
  const body = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return /^\s*(\(\s*)*(select|with)\b/i.test(body);
}

/**
 * 表名等价：双方都带 schema 时比全名；任一方是裸表名时比裸名。
 * 黄金集里的期望表有的带 schema、有的不带，而模型 SQL 抽出来的几乎都带，精确比对会把同一张表判成不同表。
 */
export function sameTable(a, b) {
  if (a === b) return true;
  if (a.includes(".") && b.includes(".")) return false;
  return a.split(".").pop() === b.split(".").pop();
}

function tablesOf(sqls, known) {
  const raw = new Set();
  for (const s of sqls) for (const t of extractTables(s)) raw.add(t);
  return { raw: [...raw], used: filterKnownTables([...raw], known) };
}

function coverage(exp, used) {
  const hit = exp.filter((t) => used.some((u) => sameTable(t, u)));
  const usedHit = used.filter((u) => exp.some((t) => sameTable(t, u)));
  return {
    missing: exp.filter((t) => !hit.includes(t)),
    recall: exp.length ? hit.length / exp.length : null,
    precision: used.length ? usedHit.length / used.length : null,
  };
}

// 比较 / IN 列表 / LIKE 右侧的字符串字面量。逗号前缀会顺带抓到函数参数，日期、时区、格式串、纯数字在下面排除。
const FILTER_LITERAL = /(=|!=|<>|\bIN\s*\(|\bLIKE|,)\s*'((?:[^'\\]|\\.){1,120})'/gi;
const NOT_A_VALUE = /^(?:\d{4}-\d{2}|Asia\/|UTC$|Europe\/|America\/|-?\d+(?:\.\d+)?$)/;

/** SQL 里的业务过滤值（渠道、事件名、素材 id 等）；LIKE 的 % 去掉，只留实义部分；非 LIKE 处带 % 的是格式串，跳过。 */
export function filterLiterals(sql) {
  if (typeof sql !== "string") return [];
  const body = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const out = new Set();
  for (const m of body.matchAll(FILTER_LITERAL)) {
    const like = /like/i.test(m[1]);
    if (!like && m[2].includes("%")) continue;
    const v = (like ? m[2].replace(/^%+|%+$/g, "") : m[2]).trim();
    if (v.replace(/[\\']/g, "").length >= 2 && !NOT_A_VALUE.test(v)) out.add(v);
  }
  return [...out];
}

/**
 * 单例评分。
 * - finalSql：最后一条**成功**的取数 SQL；没有成功的就取最后一条取数 SQL。JoinCorrect / 表召回 / 表精确率都按它算——
 *   评的是「答案所依据的那条 SQL」，而不是一路试探用过的所有表（试得越多越容易蒙中）。
 * - joinCorrectAny：所有尝试取并集的旧口径，仅作参考上界。
 * - cardShortcut：最后一次成功取数走的是执行已保存卡片，而不是自己写 SQL；此时 join 维度不评（null）。
 * - opts.legacySqls：旧报告（v1/v2）没有逐次记录，只有按顺序抽到的 SQL 列表，用它近似。
 * - opts.glossary：口径词典；按其中可机检的规则查最终 SQL。caliberOk = null 表示没有适用的规则。
 *   只查「表对了、口径错了」这一类（状态集合、金额字段、时区、维度来源），不等于结果集比对。
 * - opts.expectedSql：金样 SQL；valueMatch = 其中的字符串过滤值是否全部原样（区分大小写，ClickHouse 比较区分大小写）
 *   出现在最终 SQL 里。金样没有过滤值、没有最终 SQL 或走卡片捷径时为 null。只查值写没写对，不查写在哪一列。
 * - goldBlocked：金样 SQL 本身会被线上查询闸门拒绝（口径护栏），模型不可能照它的口径取数；汇总另报剔除这类题的 JoinCorrect。
 */
export function scoreCase(expectedTables, executions, known = new Set(), opts = {}) {
  const runs = executions || [];
  const valid = runs.some((e) => e.ok);
  let ex = false;
  if (runs.some((e) => e.nonEmpty ?? (e.ok && e.rows > 0))) ex = true;
  else if (runs.length > 0 && runs.every((e) => e.rows == null && !e.nonEmpty)) ex = null;

  const sqlRuns = opts.legacySqls
    ? opts.legacySqls.map((sql) => ({ kind: "sql", sql, ok: true }))
    : runs.filter((e) => e.kind !== "card" && e.sql);
  const answerRuns = sqlRuns.filter((e) => isAnswerSql(e.sql));
  const finalRun = [...answerRuns].reverse().find((e) => e.ok) || answerRuns[answerRuns.length - 1] || null;
  const lastOk = [...runs].reverse().find((e) => e.ok);
  const cardShortcut = !opts.legacySqls && lastOk?.kind === "card" ? { cardId: lastOk.cardId } : null;

  const all = tablesOf(sqlRuns.map((e) => e.sql), known);
  const fin = tablesOf(finalRun ? [finalRun.sql] : [], known);
  const exp = filterKnownTables(expectedTables || [], known);

  let joinCorrect = null, joinCorrectAny = null, missingTables = [], tableRecall = null, tablePrecision = null;
  if (exp.length > 0 && answerRuns.length > 0 && !cardShortcut) {
    const c = coverage(exp, fin.used);
    missingTables = c.missing;
    joinCorrect = c.missing.length === 0;
    tableRecall = c.recall;
    tablePrecision = c.precision;
    joinCorrectAny = coverage(exp, all.used).missing.length === 0;
  }
  const cal = opts.glossary && finalRun?.sql && !cardShortcut ? checkCaliber(finalRun.sql, opts.glossary) : null;
  const goldValues = filterLiterals(opts.expectedSql);
  const missingValues = goldValues.length && finalRun?.sql && !cardShortcut ? goldValues.filter((v) => !finalRun.sql.includes(v)) : null;
  return {
    valid,
    ex,
    joinCorrect,
    joinCorrectAny,
    missingTables,
    tableRecall,
    tablePrecision,
    cardShortcut,
    caliberOk: cal && cal.checked ? cal.violations.length === 0 : null,
    caliberViolations: cal ? cal.violations : [],
    caliberPassed: cal ? cal.passed : [],
    valueMatch: missingValues ? missingValues.length === 0 : null,
    missingValues: missingValues || [],
    goldBlocked: opts.expectedSql ? !assertSql(opts.expectedSql, { glossary: opts.glossary }).ok : null,
    firstAttemptOk: runs.length ? runs[0].ok : false,
    attempts: runs.length,
    finalSql: finalRun?.sql ?? null,
    usedTables: fin.used,
    allUsedTables: all.used,
    rawUsedTables: all.raw,
  };
}

/** 二项比例的 Wilson 95% 区间（小样本、接近 0/1 时比正态近似可靠）。 */
export function wilson(ok, n, z = 1.96) {
  if (!n) return null;
  const p = ok / n;
  const d = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / d;
  const half = (z / d) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

const round = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

export function summarize(results) {
  const real = results.filter((r) => !r.selfCheck && !r.error);
  const scored = results.filter((r) => !r.error); // --dry 自检条目也参与打分，便于核对评分函数
  const rate = (key, pool = scored) => {
    const known = pool.filter((r) => r[key] !== null && r[key] !== undefined);
    const ok = known.filter((r) => r[key]).length;
    const ci = wilson(ok, known.length);
    return {
      rate: known.length ? round(ok / known.length) : null,
      count: `${ok}/${known.length}`,
      ci95: ci ? ci.map(round) : null,
      unknown: pool.length - known.length,
    };
  };
  const complete = scored.filter((r) => !r.expectedIncomplete);
  const mean = (key) => {
    const xs = scored.map((r) => r[key]).filter((x) => typeof x === "number");
    return xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  };
  return {
    scorerVersion: SCORER_VERSION,
    total: results.length,
    realRuns: real.length,
    errors: results.filter((r) => r.error).length,
    valid: rate("valid"),
    firstAttemptOk: rate("firstAttemptOk"),
    ex: rate("ex"),
    joinCorrect: rate("joinCorrect"),
    // 去掉期望表里含白名单外表的用例（期望表可能不全，判分偏宽）后的 JoinCorrect
    joinCorrectComplete: rate("joinCorrect", complete),
    expectedIncomplete: scored.length - complete.length,
    // 金样口径会被线上闸门拒绝的题（模型照着做也跑不通）单列，另报剔除后的 JoinCorrect
    goldBlocked: scored.filter((r) => r.goldBlocked).length,
    joinCorrectReachable: rate("joinCorrect", scored.filter((r) => !r.goldBlocked)),
    joinCorrectAny: rate("joinCorrectAny"),
    caliberOk: rate("caliberOk"),
    valueMatch: rate("valueMatch"),
    // 按规则分列：单条规则（如时区）冲突多时不至于淹没其它口径
    caliberByRule: scored.reduce((acc, r) => {
      const bump = (id, key) => {
        acc[id] ||= { checked: 0, violated: 0 };
        acc[id].checked++;
        if (key) acc[id].violated++;
      };
      for (const v of r.caliberViolations || []) bump(v.id, true);
      for (const id of r.caliberPassed || []) bump(id, false);
      return acc;
    }, {}),
    tableRecallMean: mean("tableRecall"),
    tablePrecisionMean: mean("tablePrecision"),
    attemptsMean: mean("attempts"),
    // executed=false 的执行类调用（同轮重复 / 闸门拒绝 / 暂缓）不计入 attempts，单独计数
    skippedCallsTotal: real.reduce((s, r) => s + (r.skippedCalls || 0), 0),
    cardShortcuts: real.filter((r) => r.cardShortcut).length,
    // 尝试取留出卡片 / 黄金集的用例数；其中 MCP 没拦（未见 [eval-holdout] 拒绝）的才是真泄题
    leakAttempts: real.filter((r) => r.leaks?.length).length,
    leaked: real.filter((r) => r.leaks?.length && !r.evalModeSeen).length,
  };
}
