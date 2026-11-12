// 跑分器评分口径（v3）：逐次执行记录、按最终 SQL 判 JoinCorrect、表名带不带 schema 都算同一张表、
// EX 行数取自 [feedback] 行（拿不到记未知，被服务端截断算非空）、卡片执行单列。纯函数，不连 BI。
// 回归背景：v1 精确比对误判 16 例；v1 rows 恒为 1；v2 把所有尝试的表取并集（77.2%，按最终 SQL 为 57.6%）；
// SSE 的 tool_call.args 是 JSON 字符串，旧 runner 只认数组/对象，失败执行的 SQL 全部丢失。
import { test, expect } from "vitest";
import { normalizeKnownTables } from "../scripts/metabase-card-graph.mjs";
import {
  bareToolName,
  isExecutionTool,
  parseToolArgs,
  sameTable,
  isAnswerSql,
  scoreCase,
  executionFromToolResult,
  filterLiterals,
  summarize,
  wilson,
} from "../scripts/bi-eval-score.mjs";

const known = normalizeKnownTables([
  "film_report.elt_film_order",
  "film_report.elt_app_params",
  "film_report.elt_fo_ap_src",
  "film_report.elt_user_full",
  "gather.gather",
]);
const fb = (rowCount: number, ok = true) => `-- [feedback] ${JSON.stringify({ ok, empty: rowCount === 0, rowCount })}`;
const okText = (sql: string, rowCount = 3) => `-- 实际执行的 SQL（仅供核对口径，不要重复执行）：\n${sql}\n\nc\n1\n\n${fb(rowCount)}`;
const sqlRun = (sql: string, ok = true, rows: number | null = 3) => ({ kind: "sql", sql, ok, rows, nonEmpty: ok && (rows ?? 0) > 0 });

test("工具名：去掉 mcp__<server>__ 前缀；query / execute_query 也算取数工具", () => {
  expect(bareToolName("mcp__bi__run_native_query")).toBe("run_native_query");
  expect(bareToolName("run_native_query")).toBe("run_native_query");
  expect(isExecutionTool("mcp__bi__query")).toBe(true);
  expect(isExecutionTool("mcp__bi__execute_query")).toBe(true);
  expect(isExecutionTool("mcp__bi__get_card")).toBe(false);
});

test("tool_call.args 是 JSON 字符串时也能解析出 SQL", () => {
  expect(parseToolArgs('{"database_id":2,"query":"SELECT 1"}')).toEqual({ database_id: 2, query: "SELECT 1" });
  expect(parseToolArgs({ sql: "SELECT 1" })).toEqual({ sql: "SELECT 1" });
  expect(parseToolArgs("not json")).toEqual({});
});

test("执行记录：失败结果没有 SQL 回显时取调用参数里的 SQL", () => {
  const e = executionFromToolResult(
    { name: "mcp__bi__run_native_query", ok: false, text: "[400] 查询被上游拒绝" },
    { args: '{"database_id":2,"query":"SELECT x FROM film_report.elt_film_order"}' },
  );
  expect(e).toMatchObject({ tool: "run_native_query", kind: "sql", ok: false, sql: "SELECT x FROM film_report.elt_film_order" });
});

test("执行记录：行数取自 [feedback]；拿不到记 null；服务端截断算非空", () => {
  expect(executionFromToolResult({ name: "run_native_query", text: okText("SELECT 1", 5) })).toMatchObject({ rows: 5, nonEmpty: true });
  expect(executionFromToolResult({ name: "run_native_query", text: okText("SELECT 1", 0) })).toMatchObject({ rows: 0, nonEmpty: false });
  expect(executionFromToolResult({ name: "run_native_query", text: "无反馈行" })).toMatchObject({ rows: null, nonEmpty: false });
  const cut = "c\n1\n2\n…（结果已截断，原始长度 30000 字符；计数/告警勿用截断片估算）";
  expect(executionFromToolResult({ name: "run_native_query", text: cut })).toMatchObject({ rows: null, nonEmpty: true });
});

test("执行记录：execute_query 与带 question_id 的 query 记为卡片执行，行数按文本数", () => {
  const text = "a\tb\n1\t2\n3\t4";
  expect(executionFromToolResult({ name: "mcp__bi__execute_query", text }, { args: '{"question_id":125}' })).toMatchObject({ kind: "card", cardId: 125, rows: 2, sql: null });
  expect(executionFromToolResult({ name: "mcp__bi__query", text: "a\tb" }, { args: '{"question_id":7}' })).toMatchObject({ kind: "card", rows: 0 });
  expect(executionFromToolResult({ name: "mcp__bi__query", text: okText("SELECT 1") }, { args: '{"database_id":2,"sql":"SELECT 1"}' })).toMatchObject({ kind: "sql" });
});

test("isAnswerSql：DESCRIBE / SHOW 不算回答问题的 SQL", () => {
  expect(isAnswerSql("SELECT 1")).toBe(true);
  expect(isAnswerSql("-- 注释\nWITH a AS (SELECT 1) SELECT * FROM a")).toBe(true);
  expect(isAnswerSql("DESCRIBE film_report.elt_film_order")).toBe(false);
});

test("sameTable：任一方裸名时比裸名，双方都带 schema 时比全名", () => {
  expect(sameTable("elt_film_order", "film_report.elt_film_order")).toBe(true);
  expect(sameTable("film_report.gather", "gather.gather")).toBe(false);
});

test("JoinCorrect 按最终成功的 SQL 判，试探查询里碰到的表不算；并集口径另记为 joinCorrectAny", () => {
  const exp = ["film_report.elt_film_order", "film_report.elt_app_params"];
  const sc = scoreCase(
    exp,
    [
      sqlRun("SELECT * FROM film_report.elt_app_params LIMIT 5"),
      sqlRun("SELECT count() FROM film_report.elt_film_order o JOIN film_report.elt_user_full u ON u.uid = o.uid"),
    ],
    known,
  );
  expect(sc.joinCorrect).toBe(false);
  expect(sc.joinCorrectAny).toBe(true);
  expect(sc.missingTables).toEqual(["film_report.elt_app_params"]);
  expect(sc.tableRecall).toBe(0.5);
  expect(sc.tablePrecision).toBe(0.5);
});

test("最终 SQL 取最后一条成功的；之后失败的重试不覆盖它", () => {
  const sc = scoreCase(
    ["elt_film_order"],
    [sqlRun("SELECT count() FROM film_report.elt_film_order"), sqlRun("SELECT oops FROM film_report.elt_user_full", false, null)],
    known,
  );
  expect(sc.finalSql).toBe("SELECT count() FROM film_report.elt_film_order");
  expect(sc.joinCorrect).toBe(true);
});

test("最后一次成功取数走卡片：标 cardShortcut，join 不评", () => {
  const sc = scoreCase(["elt_film_order"], [sqlRun("SELECT 1 FROM film_report.elt_film_order", false, null), { kind: "card", cardId: 125, ok: true, rows: 3, nonEmpty: true }], known);
  expect(sc.cardShortcut).toEqual({ cardId: 125 });
  expect(sc.joinCorrect).toBe(null);
  expect(sc.valid).toBe(true);
});

test("EX：有非空为 true；跑通但全空为 false；行数全未知为 null；没调用过取数工具为 false", () => {
  const q = "SELECT 1 FROM film_report.elt_film_order";
  expect(scoreCase([], [sqlRun(q, true, 0), sqlRun(q, true, 2)], known).ex).toBe(true);
  expect(scoreCase([], [sqlRun(q, true, 0)], known).ex).toBe(false);
  expect(scoreCase([], [sqlRun(q, true, null)], known).ex).toBe(null);
  expect(scoreCase([], [], known).ex).toBe(false);
});

test("首次成功率与尝试次数", () => {
  const sc = scoreCase([], [sqlRun("SELECT 1", false, null), sqlRun("SELECT 1")], known);
  expect(sc.firstAttemptOk).toBe(false);
  expect(sc.attempts).toBe(2);
});

test("旧报告（v1/v2）用 legacySqls 近似：按其中最后一条取数 SQL 判", () => {
  const sc = scoreCase(["elt_film_order"], [{ kind: "sql", ok: true, rows: null }], known, {
    legacySqls: ["DESCRIBE film_report.elt_film_order", "SELECT 1 FROM film_report.elt_film_order", "DESCRIBE film_report.elt_user_full"],
  });
  expect(sc.finalSql).toBe("SELECT 1 FROM film_report.elt_film_order");
  expect(sc.joinCorrect).toBe(true);
});

test("Wilson 区间：与手算一致，0/n 与 n/n 也有非零宽度", () => {
  const [lo, hi] = wilson(71, 92)!;
  expect(lo).toBeCloseTo(0.676, 3);
  expect(hi).toBeCloseTo(0.846, 3);
  expect(wilson(20, 20)![0]).toBeCloseTo(0.839, 3);
  expect(wilson(0, 0)).toBe(null);
});

test("口径检查：按最终 SQL 判；无适用规则为 null；走卡片捷径不评", () => {
  const glossary = {
    entries: [{ id: "paid_order", status: "draft", check: { type: "filter_set", table: "elt_film_order", column: "orderStatus", values: [3, 6] } }],
  };
  const wrong = scoreCase(["film_report.elt_film_order"], [sqlRun("SELECT count() FROM film_report.elt_film_order WHERE orderStatus = 6")], known, { glossary });
  expect(wrong.caliberOk).toBe(false);
  expect(wrong.caliberViolations[0].id).toBe("paid_order");
  const fixed = scoreCase(
    ["film_report.elt_film_order"],
    [sqlRun("SELECT count() FROM film_report.elt_film_order WHERE orderStatus = 6"), sqlRun("SELECT count() FROM film_report.elt_film_order WHERE orderStatus IN (3,6)")],
    known,
    { glossary },
  );
  expect(fixed.caliberOk).toBe(true);
  expect(scoreCase(["film_report.elt_film_order"], [sqlRun("SELECT count() FROM film_report.elt_film_order")], known, { glossary }).caliberOk).toBeNull();
  expect(scoreCase(["film_report.elt_film_order"], [sqlRun("SELECT 1 FROM film_report.elt_film_order WHERE orderStatus = 6")], known).caliberOk).toBeNull();
  const s = summarize([{ id: 1, ...wrong }, { id: 2, ...fixed }]);
  expect(s.caliberOk.count).toBe("1/2");
  expect(s.caliberByRule).toEqual({ paid_order: { checked: 2, violated: 1 } });
});

test("过滤值：抽比较 / IN / LIKE 右侧的业务值，排除日期、时区、格式串、数字", () => {
  const gold =
    "SELECT formatDateTime(createdTime, '%Y-%m-%d') d, count() FROM film_report.elt_app_params " +
    "WHERE appName = 'FoxA' AND eventName IN ('VIP_intro_pageview', 'VIP_intro_native_pageview') AND url LIKE '%flixfox%' " +
    "AND createdTime >= toDateTime('2026-01-01 00:00:00', 'Asia/Shanghai') AND status = '3' GROUP BY d";
  expect(filterLiterals(gold).sort()).toEqual(["FoxA", "VIP_intro_native_pageview", "VIP_intro_pageview", "flixfox"]);

  const exp = ["film_report.elt_app_params"];
  const right = scoreCase(exp, [sqlRun("SELECT count() FROM film_report.elt_app_params WHERE appName = 'FoxA' AND eventName IN ('VIP_intro_pageview','VIP_intro_native_pageview') AND url LIKE '%flixfox.com%'")], known, { expectedSql: gold });
  expect(right.valueMatch).toBe(true);
  const wrong = scoreCase(exp, [sqlRun("SELECT count() FROM film_report.elt_app_params WHERE appName = 'foxa'")], known, { expectedSql: gold });
  expect(wrong.valueMatch).toBe(false);
  expect(wrong.missingValues).toContain("FoxA");
  expect(scoreCase(exp, [sqlRun("SELECT count() FROM film_report.elt_app_params")], known, { expectedSql: "SELECT count() FROM t WHERE d >= '2026-01-01'" }).valueMatch).toBeNull();
  expect(summarize([{ id: 1, ...right }, { id: 2, ...wrong }]).valueMatch.count).toBe("1/2");
});

test("summarize：只在已知样本上算分母，附 Wilson 区间；期望表不全的用例单列", () => {
  const s = summarize([
    { id: 1, valid: true, ex: true, joinCorrect: true, firstAttemptOk: true, attempts: 1, skippedCalls: 2 },
    { id: 2, valid: true, ex: null, joinCorrect: false, firstAttemptOk: false, attempts: 3, expectedIncomplete: true, skippedCalls: 1 },
    { id: 3, valid: false, ex: false, joinCorrect: null, firstAttemptOk: false, attempts: 0, leaks: [{ tool: "get_golden_set" }], evalModeSeen: true },
  ]);
  expect(s.valid.count).toBe("2/3");
  expect(s.ex.count).toBe("1/2");
  expect(s.joinCorrect.count).toBe("1/2");
  expect(s.joinCorrectComplete.count).toBe("1/1");
  expect(s.expectedIncomplete).toBe(1);
  expect(s.attemptsMean).toBeCloseTo(1.333, 3);
  expect(s.skippedCallsTotal).toBe(3);
  expect(s.leakAttempts).toBe(1);
  expect(s.leaked).toBe(0);
  expect(s.joinCorrect.ci95).toHaveLength(2);
});
