// 原生 SQL 只读硬拒口径（纯函数、零外部依赖）。
// 补的是 2026-09 清理掉 `_risk-gate-check.mjs` 后**唯一没有自动化回归**的一环：
// 「写 SQL / 危险构造 / 多语句一律拒」这条防线（原来由那个脚本的 deny 分支覆盖）。
// 口径权威在 `src/sql-readonly.ts`；MCP 适配器 `scripts/metabase-mcp.mjs` 另有一份同口径实现（刻意纵深防御）。
import { test, expect } from "vitest";
import { isReadOnlySql } from "../src/sql-readonly.js";
import { isNativeSqlRejected } from "../src/risk.js";

test("[A] 白名单首词放行（select/with/show/describe/desc/explain）", () => {
  for (const sql of [
    "SELECT 1",
    "  select * from t limit 1  ",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "SHOW TABLES",
    "EXPLAIN SELECT 1",
    "describe film_report.elt_new_guid",
    "desc t",
  ]) {
    expect(isReadOnlySql(sql), sql).toBe(true);
  }
});

test("[B] 写操作与危险构造一律拒（fail-closed）", () => {
  for (const sql of [
    "INSERT INTO t VALUES (1)",
    "update t set a = 1",
    "DELETE FROM t",
    "DROP TABLE t",
    "ALTER TABLE t ADD COLUMN c Int",
    "CREATE TABLE t (a Int)",
    "TRUNCATE TABLE t",
    "MERGE INTO t USING s ON t.id = s.id",
    "GRANT SELECT ON t TO u",
    "SET max_threads = 1",
    "SELECT * FROM t INTO OUTFILE '/tmp/x'",
    "SELECT load_file('/etc/passwd')",
    "SELECT * FROM t WHERE writable_schema = 1",
    // 多语句 / 空 / 非字符串（不能因为「看着像查询」就放行）
    "SELECT 1; SELECT 2",
    "",
    "   ",
    undefined,
    null,
    123,
    {},
    [],
  ]) {
    expect(isReadOnlySql(sql as unknown), String(sql)).toBe(false);
  }
});

test("[C] 引号与注释里出现关键字不算写操作（防误杀真实列名/字面量）", () => {
  for (const sql of [
    `SELECT 'grant admin' AS note`,
    `SELECT "update" FROM t`,
    "SELECT `delete` FROM t",
    "SELECT updated_at FROM t", // 词边界：update 不匹配 updated_at
    "SELECT 'a;b' FROM t", // 引号里的分号不算多语句
    "SELECT 1 -- delete from t",
    "/* drop table t */ SELECT 1",
    "SELECT 1;", // 尾部单分号仍是一条语句
  ]) {
    expect(isReadOnlySql(sql), sql).toBe(true);
  }
});

test("[D] isNativeSqlRejected：只对声明过的原生 SQL 工具生效，缺参也硬拒", () => {
  const tools = ["run_native_query"];
  // 未声明为「原生 SQL 工具」的服务器/工具：不受本判定影响
  expect(isNativeSqlRejected(undefined, "run_native_query", { query: "DELETE FROM t" })).toBe(false);
  expect(isNativeSqlRejected(tools, "list_databases", { query: "DELETE FROM t" })).toBe(false);
  // 声明过的工具：只读放行、写操作硬拒（两种参数键都认）
  expect(isNativeSqlRejected(tools, "run_native_query", { query: "SELECT 1" })).toBe(false);
  expect(isNativeSqlRejected(tools, "run_native_query", { sql: "SELECT 1" })).toBe(false);
  expect(isNativeSqlRejected(tools, "run_native_query", { query: "DELETE FROM t" })).toBe(true);
  expect(isNativeSqlRejected(tools, "run_native_query", { sql: "DROP TABLE t" })).toBe(true);
  expect(isNativeSqlRejected(tools, "run_native_query", { query: "SELECT 1; DROP TABLE t" })).toBe(true);
  // fail-closed：连 SQL 都没传（或传了非字符串）→ 拒绝，而不是默认放行
  expect(isNativeSqlRejected(tools, "run_native_query", {})).toBe(true);
  expect(isNativeSqlRejected(tools, "run_native_query", { query: 42 })).toBe(true);
});
