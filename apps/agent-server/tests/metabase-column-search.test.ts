import { test, expect } from "vitest";
import { buildColumnSearchSql } from "../scripts/metabase-column-search.mjs";
import { isReadOnlySql } from "../scripts/sql-readonly-common.mjs";
import { lintSql } from "../scripts/sql-lint-common.mjs";

// 跨库列级检索：SQL 必须由纯模块拼装、过只读硬校验、过最佳实践 lint、且注入安全。

test("生成的 SQL 通过只读硬校验（fail-closed 口径单一来源）", () => {
  const { ok, sql } = buildColumnSearchSql("reason");
  expect(ok).toBe(true);
  expect(isReadOnlySql(sql)).toBe(true);
});

test("生成的 SQL 不触发任何最佳实践 lint（含前导通配免报：system.columns 是元数据小表）", () => {
  const { ok, sql } = buildColumnSearchSql("reason");
  expect(ok).toBe(true);
  const findings = lintSql(sql);
  expect(findings).toEqual([]);
  // 即便走全量 lint，LIKE 前导通配也应因 meta 免报，不得出现 noise。
  const codes = findings.map((f) => f.code);
  expect(codes).not.toContain("LIKE_LEADING_WILDCARD");
  expect(codes).not.toContain("SELECT_STAR_UNBOUNDED");
  expect(codes).not.toContain("NO_LIMIT_ROWS");
});

test("参数注入安全：单引号被翻倍转义，恶意文本整体落在 LIKE 字面量内", () => {
  const evil = "x'; DROP TABLE system.columns; --";
  const { ok, sql } = buildColumnSearchSql(evil);
  expect(ok).toBe(true);
  // 注入的引号被转义（ClickHouse 以 '' 表示一个引号），' 被翻倍 → 恶意文本成为字面量数据，
  // 不会逃出字符串边界去开启第二条语句。良性 pattern（无引号）可正常通过只读硬校验（见测试1）。
  expect(sql).toContain("x''; DROP TABLE system.columns; --");
  // 注：isReadOnlySql 的引号剥离是正则启发式，对 '' 转义偏保守（会误判为多条），
  // 但 ClickHouse 把 '' 解析为一个引号，原意仍是单条 SELECT；真实放行口径见测试1的良性 case。
  expect(sql).toMatch(/ILIKE '%x''; DROP TABLE system\.columns; --%'/);
});

test("空 pattern 被拒；limit 被夹到合法范围", () => {
  expect(buildColumnSearchSql("   ").ok).toBe(false);
  expect(buildColumnSearchSql(123).ok).toBe(false);
  const big = buildColumnSearchSql("a", { limit: 999999 });
  expect(big.ok).toBe(true);
  expect(big.sql).toContain("LIMIT 1000");
  const small = buildColumnSearchSql("a", { limit: 0 });
  expect(small.sql).toContain("LIMIT 200");
});

test("SQL 形态通用、跨库、列名子串匹配，不写死任何业务词", () => {
  const { sql } = buildColumnSearchSql("cancel_reason");
  expect(sql).toContain("FROM system.columns");
  expect(sql).toContain("name ILIKE '%cancel_reason%' OR comment ILIKE '%cancel_reason%'");
  expect(sql).toContain("ORDER BY database, table, name");
  // 断言没有任何业务表名/指标名被写死。
  expect(sql).not.toMatch(/unsubscribe|churn|retention|gmv|profit/i);
});
