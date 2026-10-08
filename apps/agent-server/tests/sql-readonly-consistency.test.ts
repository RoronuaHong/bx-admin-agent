// SQL 只读判定：单一可信来源的回归 + 漂移防护。
//
// 背景（对应审计第 4 项「sqlRejected 触发条件单一可信来源」）：
// 判定逻辑收口到 scripts/sql-readonly-common.mjs，服务端 src/sql-readonly.ts 与 MCP 适配器
// scripts/metabase-mcp.mjs 两侧都 import 它——物理上只有一份。本测试做两件事：
//   1) 对单一源跑覆盖「允许 / 拒绝 / 引号剥离 / 注释剥离 / 多语句 / 危险构造」的用例表，防逻辑回归；
//   2) 静态断言 mjs 适配器**没有**再内联一份 isReadOnlySql（否则就回到了两份会漂移的旧态）。
import { test, expect } from "vitest";
import { isReadOnlySql } from "../scripts/sql-readonly-common.mjs";
import { isReadOnlySql as fromTs } from "../src/sql-readonly.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CASES: { sql: string; want: boolean }[] = [
  // ---- 应放行（只读首词）----
  { sql: "SELECT * FROM t", want: true },
  { sql: "select 1", want: true },
  { sql: "WITH cte AS (SELECT 1) SELECT * FROM cte", want: true },
  { sql: "SHOW TABLES", want: true },
  { sql: "show databases", want: true },
  { sql: "DESCRIBE t", want: true },
  { sql: "desc t", want: true },
  { sql: "EXPLAIN SELECT * FROM t", want: true },
  { sql: "SELECT * FROM t LIMIT 10", want: true },
  // 引号/标识符里的保留字不算写操作（脱引号后判定）
  { sql: "SELECT 'update' FROM t", want: true },
  { sql: 'SELECT "delete" FROM t', want: true },
  { sql: "SELECT `drop` FROM t", want: true },
  // 注释里的保留字不算（脱注释后判定）
  { sql: "SELECT 1 -- drop table users", want: true },
  { sql: "SELECT a FROM t /* delete from x */", want: true },
  // 标识符含拒绝词（drop_table 中的 drop 不构成词边界）应放行
  { sql: "SELECT * FROM drop_table", want: true },

  // ---- 应拒绝（写操作 / 危险构造 / 多语句）----
  { sql: "INSERT INTO t VALUES (1)", want: false },
  { sql: "UPDATE t SET a=1", want: false },
  { sql: "DELETE FROM t", want: false },
  { sql: "DROP TABLE t", want: false },
  { sql: "ALTER TABLE t ADD c int", want: false },
  { sql: "CREATE TABLE t (a int)", want: false },
  { sql: "TRUNCATE TABLE t", want: false },
  { sql: "MERGE INTO t USING s ON 1=1 WHEN MATCHED THEN UPDATE SET a=1", want: false },
  { sql: "REPLACE INTO t (a) VALUES (1)", want: false },
  { sql: "UPSERT INTO t (a) VALUES (1)", want: false },
  { sql: "GRANT ALL ON t TO u", want: false },
  { sql: "REVOKE ALL ON t FROM u", want: false },
  { sql: "ATTACH DATABASE x AS y", want: false },
  { sql: "DETACH DATABASE x", want: false },
  { sql: "EXEC sp_who", want: false },
  { sql: "EXECUTE IMMEDIATE 'x'", want: false },
  { sql: "CALL proc()", want: false },
  { sql: "COPY t FROM 'f'", want: false },
  { sql: "LOAD DATA INFILE 'f'", want: false },
  { sql: "SET @x = 1", want: false },
  { sql: "RESET abc", want: false },
  // 危险构造：首词是 select 也要拒
  { sql: "SELECT * INTO OUTFILE '/tmp/x' FROM t", want: false },
  { sql: "SELECT LOAD_FILE('/etc/passwd')", want: false },
  { sql: "SELECT PG_READ_FILE('/x')", want: false },
  { sql: "SELECT * FROM t WHERE writable_schema", want: false },
  // 多语句一律拒
  { sql: "SELECT 1; DROP TABLE t", want: false },
  { sql: "SELECT 1 ; SELECT 2", want: false },
  // 空 / 纯注释 / 不明朗一律拒（fail-closed）
  { sql: "", want: false },
  { sql: "   ", want: false },
  { sql: "-- just a comment", want: false },
  { sql: "/* comment only */", want: false },
  // 首词非白名单
  { sql: "FOOBAR x", want: false },
];

test("单一源 isReadOnlySql 对用例表逐一正确", () => {
  for (const { sql, want } of CASES) {
    expect(isReadOnlySql(sql), `sql=${JSON.stringify(sql)}`).toBe(want);
  }
});

test("服务端再导出与单一源行为一致（防有人把副本写回 TS 侧）", () => {
  for (const { sql, want } of CASES) {
    expect(fromTs(sql), `sql=${JSON.stringify(sql)}`).toBe(want);
    expect(fromTs(sql)).toBe(isReadOnlySql(sql));
  }
});

test("MCP 适配器未再内联 isReadOnlySql（唯一来源必须是 common 模块）", () => {
  const mjsPath = fileURLToPath(new URL("../scripts/metabase-mcp.mjs", import.meta.url));
  const src = readFileSync(mjsPath, "utf8");
  // 若又出现内联实现，多半会带 function isReadOnlySql 或一份 RO_LEADING/RO_DENY 常量。
  expect(src).not.toMatch(/function\s+isReadOnlySql\s*\(/);
  expect(src).not.toMatch(/const\s+RO_LEADING\s*=/);
  expect(src).not.toMatch(/const\s+RO_DENY\s*=/);
  // 必须是从单一源 import。
  expect(src).toContain('import { isReadOnlySql } from "./sql-readonly-common.mjs"');
});
