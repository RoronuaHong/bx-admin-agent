// 查询校验闭环固化（§4.3-5 / §3-E）：assertSql 硬校验 + 结构化反馈信号的回归保护。
// 纯函数，不连 BI、不发网络请求；护栏逻辑从 metabase-mcp.mjs 内联抽出后由本文件钉住。
import { test, expect } from "vitest";
import {
  assertSql,
  checkCaliber,
  classifyQueryError,
  buildQueryFeedback,
  renderFeedbackLine,
} from "../scripts/bi-query-guard.mjs";

// ---- 执行前：只读 / 多语句 / 口径护栏 ----
test("合法只读 SELECT / WITH 通过，尾部分号被规范化", () => {
  expect(assertSql("SELECT 1 FROM film_report.elt_film_order LIMIT 1;").ok).toBe(true);
  expect(assertSql("WITH a AS (SELECT 1) SELECT * FROM a").ok).toBe(true);
  expect(assertSql("SHOW TABLES").ok).toBe(true);
});

test("DDL / DML 一律 fail-closed 拒绝", () => {
  for (const sql of ["DROP TABLE t", "DELETE FROM t", "INSERT INTO t VALUES (1)", "UPDATE t SET x=1"]) {
    expect(assertSql(sql).ok).toBe(false);
  }
});

test("多语句被拒，但引号 / 注释内的分号不误杀", () => {
  expect(assertSql("SELECT 1; DROP TABLE t").ok).toBe(false);
  expect(assertSql("SELECT ';' AS semi FROM t").ok).toBe(true);
  expect(assertSql("SELECT 1 /* ; */ FROM t").ok).toBe(true);
});

test("口径护栏：国家维度代理列 / 会员存量快照被硬拒，且给出正确口径", () => {
  const a = assertSql("SELECT ipCountryCode, count() FROM film_report.elt_app_params GROUP BY 1");
  expect(a.ok).toBe(false);
  expect(a.error).toMatch(/countryCode/);
  const b = assertSql("SELECT uid FROM elt_user_full_history WHERE vipExpireDay > 0");
  expect(b.ok).toBe(false);
  expect(b.error).toMatch(/elt_user_vip_info/);
  expect(checkCaliber("SELECT 1").ok).toBe(true);
});

test("口径护栏：Metabase 透传投影（`t`.`ipCountryCode` AS `ipCountryCode`）不算用了该列，外层再引用仍拒", () => {
  const inner = "SELECT `film_report`.`elt_app_params`.`ipCountryCode` AS `ipCountryCode`, `film_report`.`elt_app_params`.`guid` AS `guid` FROM `film_report`.`elt_app_params`";
  expect(assertSql(`SELECT count(DISTINCT guid) FROM (${inner}) t`).ok).toBe(true);
  expect(assertSql(`SELECT ipCountryCode, count() FROM (${inner}) t GROUP BY ipCountryCode`).ok).toBe(false);
});

test("口径护栏以词典为准：同 id 条目批准后内置规则让位，enforce 决定拒绝 / 提示 / 放行", () => {
  const sql = "SELECT a.ipCountryCode, count() FROM film_report.elt_app_params a GROUP BY 1";
  const country = (enforce?: string) => ({
    entries: [
      {
        id: "country_dimension",
        name: "账号国家",
        status: "approved",
        definition: "取 elt_user_full.countryCode",
        ...(enforce ? { enforce } : {}),
        check: { type: "dimension_source", allowed: ["elt_user_full.countryCode"], forbidden: ["elt_app_params.ipCountryCode"] },
      },
    ],
  });
  expect(assertSql(sql, { glossary: { entries: [{ ...country("reject").entries[0], status: "draft" }] } }).ok).toBe(false);
  const rejected = assertSql(sql, { glossary: country("reject") });
  expect(rejected.ok).toBe(false);
  expect(rejected.error).toMatch(/账号国家/);
  const warned = assertSql(sql, { glossary: country("warn") });
  expect(warned.ok).toBe(true);
  expect(warned.warnings[0]).toMatch(/口径提示（账号国家）/);
  expect(assertSql(sql, { glossary: country() })).toMatchObject({ ok: true, warnings: [] });

  const stock = {
    entries: [
      {
        id: "member_stock",
        name: "会员存量",
        status: "approved",
        enforce: "reject",
        definition: "elt_user_vip_info",
        check: { type: "forbidden_tokens", all: ["elt_user_full_history", "vipExpireDay"] },
      },
    ],
  };
  expect(assertSql("SELECT uid FROM elt_user_full_history WHERE vipExpireDay > 0", { glossary: stock }).error).toMatch(/会员存量/);
  expect(assertSql("SELECT uid FROM elt_user_full_history", { glossary: stock }).ok).toBe(true);
});

test("空 SQL 被拒", () => {
  expect(assertSql("").ok).toBe(false);
  expect(assertSql(null).ok).toBe(false);
});

// ---- 执行后：结构化反馈信号 ----
test("classifyQueryError 把上游错误归类为机读类型，权限类不可重试", () => {
  expect(classifyQueryError("Code: 47. DB::Exception: Missing columns: 'countryCd'").errorKind).toBe("UNKNOWN_IDENTIFIER");
  expect(classifyQueryError("Code: 241. DB::Exception: Memory limit exceeded").errorKind).toBe("MEMORY_LIMIT");
  expect(classifyQueryError("Code: 60. DB::Exception: Table foo doesn't exist").errorKind).toBe("UNKNOWN_TABLE");
  expect(classifyQueryError("AMBIGUOUS_COLUMN: uid").errorKind).toBe("AMBIGUOUS_COLUMN");
  const perm = classifyQueryError("Permission denied for user metabase_user");
  expect(perm.errorKind).toBe("PERMISSION");
  expect(perm.retryable).toBe(false);
  expect(classifyQueryError("something weird").errorKind).toBe("UNKNOWN");
});

test("buildQueryFeedback 成功路径给出空结果 / 行列数 / 截断 / 无需重试", () => {
  const fb = buildQueryFeedback({ ok: true, cols: ["a", "b"], rows: [[1, 2]], truncated: true });
  expect(fb).toMatchObject({ ok: true, errorKind: null, empty: false, rowCount: 1, colCount: 2, truncated: true, retryable: false });
  const empty = buildQueryFeedback({ ok: true, cols: ["a"], rows: [] });
  expect(empty.empty).toBe(true);
  expect(empty.rowCount).toBe(0);
});

test("buildQueryFeedback 失败路径带错误类型、可重试性与可操作提示", () => {
  const fb = buildQueryFeedback({ ok: false, upstreamText: "Code: 47. Missing columns: 'foo'" });
  expect(fb.errorKind).toBe("UNKNOWN_IDENTIFIER");
  expect(fb.retryable).toBe(true);
  expect(fb.hint).toMatch(/get_database_schema/);
  expect(fb.rowCount).toBe(0);
});

test("校验拒绝可用显式 errorKind 覆盖", () => {
  const fb = buildQueryFeedback({ ok: false, errorKind: "VALIDATION_REJECTED", hint: "只接受只读查询" });
  expect(fb.errorKind).toBe("VALIDATION_REJECTED");
});

// ---- §3-E 执行反馈自校正闭环：信号可被消费方机读，支撑「首猜失败 → 修 → 重试」----
test("闭环信号链：错列名失败可重试 → 修后成功，同错两次可据此降级", () => {
  const first = buildQueryFeedback({ ok: false, upstreamText: "Code: 47. Missing columns: 'countryCd'" });
  expect(first.retryable).toBe(true);
  expect(first.errorKind).toBe("UNKNOWN_IDENTIFIER");
  const second = buildQueryFeedback({ ok: false, upstreamText: "Code: 47. Missing columns: 'countryCd'" });
  expect(second.errorKind).toBe(first.errorKind); // 同错两次：消费方据此降级
  const fixed = buildQueryFeedback({ ok: true, cols: ["countryCode", "dau"], rows: [[91, 123]] });
  expect(fixed.ok).toBe(true);
  expect(fixed.empty).toBe(false);
  expect(fixed.colCount).toBe(2);
});

test("renderFeedbackLine 是单行 SQL 注释且负载可 JSON.parse", () => {
  const fb = buildQueryFeedback({ ok: true, cols: ["a"], rows: [[1]] });
  const line = renderFeedbackLine(fb);
  expect(line.startsWith("-- [feedback] ")).toBe(true);
  expect(line).not.toContain("\n");
  expect(JSON.parse(line.slice("-- [feedback] ".length)).rowCount).toBe(1);
});
