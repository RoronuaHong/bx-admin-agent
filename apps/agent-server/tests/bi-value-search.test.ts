// 按值搜索（2.5）纯函数回归。适配器 import 即连 stdio，测不了 run，这里锁住
// 「SQL 拼装 + 维度列提取」两处纯函数，以及两者产出/消费口径一致——
// 曾因 dimensionColumnsFromMeta 产出 `schema.table`、而 buildValueSearchSql 只认裸表名，
// 导致自动扫描路径对非 public schema 的列整批静默跳过。
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildValueSearchSql, dimensionColumnsFromMeta } from "../scripts/bi-value-search.mjs";
import { assertSql } from "../scripts/bi-query-guard.mjs";

const ADAPTER = readFileSync(fileURLToPath(new URL("../scripts/metabase-mcp.mjs", import.meta.url)), "utf8");

const META = {
  ok: true,
  data: {
    tables: [
      {
        schema: "film_report",
        name: "elt_app_params",
        fields: [
          { name: "apkChannel", semantic_type: "type/Category" },
          { name: "eventName", semantic_type: null },
          { name: "apkChannel", semantic_type: "type/Category" },
          { name: "bad`col", semantic_type: "type/Category" },
          { name: "userId", semantic_type: null },
          { semantic_type: "type/Category" },
        ],
      },
      { schema: "public", name: "gather", fields: [{ name: "materialId", semantic_type: "Category" }] },
      { name: null, fields: [] },
    ],
  },
};

test("裸表名：拼出单表去重 ILIKE 查询，默认 LIMIT 20", () => {
  const r = buildValueSearchSql("elt_app_params", "apkChannel", "IN8");
  expect(r.ok).toBe(true);
  expect(r.sql).toContain("FROM `elt_app_params`");
  expect(r.sql).toContain("`apkChannel` ILIKE '%IN8%'");
  expect(r.sql).toMatch(/LIMIT 20$/);
});

test("schema.table：两段分别加反引号；多段/注入一律拒绝", () => {
  const r = buildValueSearchSql("film_report.elt_app_params", "apkChannel", "FoxA");
  expect(r.ok).toBe(true);
  expect(r.sql).toContain("FROM `film_report`.`elt_app_params`");
  expect(r.table).toBe("film_report.elt_app_params");
  for (const bad of ["a.b.c", "elt_app_params`; DROP TABLE x", "elt app", "", "elt_app_params;SELECT"]) {
    expect(buildValueSearchSql(bad, "apkChannel", "IN8").ok, bad).toBe(false);
  }
  for (const bad of ["apk Channel", "apk`Channel", "", undefined]) {
    expect(buildValueSearchSql("elt_app_params", bad, "IN8").ok, String(bad)).toBe(false);
  }
});

test("pattern：空值拒绝、单引号/反斜杠转义、超长截断；limit 有上限", () => {
  expect(buildValueSearchSql("t", "f", "  ").ok).toBe(false);
  expect(buildValueSearchSql("t", "f", "O'Brien").sql).toContain("%O''Brien%");
  expect(buildValueSearchSql("t", "f", "a\\b").sql).toContain("%a\\\\b%");
  expect(buildValueSearchSql("t", "f", "x".repeat(200)).sql).toContain(`%${"x".repeat(100)}%`);
  expect(buildValueSearchSql("t", "f", "x", { limit: 999 }).sql).toMatch(/LIMIT 200$/);
  expect(buildValueSearchSql("t", "f", "x", { limit: 0 }).sql).toMatch(/LIMIT 20$/);
});

test("生成的 SQL 能过自己的只读闸门（否则工具会静默跳过所有列）", () => {
  const r = buildValueSearchSql("film_report.elt_app_params", "apkChannel", "IN8");
  const gated = assertSql(r.sql, { glossary: null });
  expect(gated.ok, gated.error).toBe(true);
});

test("维度列提取：type/Category 与裸值都入选、关键词兜底、public 不加前缀、去重、max 截断", () => {
  expect(dimensionColumnsFromMeta(META, { max: 20 })).toEqual([
    { table: "film_report.elt_app_params", field: "apkChannel" },
    { table: "film_report.elt_app_params", field: "eventName" },
    { table: "gather", field: "materialId" },
  ]);
  expect(dimensionColumnsFromMeta(META, { max: 2 })).toHaveLength(2);
  expect(dimensionColumnsFromMeta({ ok: false })).toEqual([]);
  expect(dimensionColumnsFromMeta(null)).toEqual([]);
});

test("回归锁：维度列产出必须能被 SQL 拼装与只读闸门消费（schema.table 曾整批被拒）", () => {
  const cols = dimensionColumnsFromMeta(META, { max: 20 });
  expect(cols.length).toBeGreaterThan(0);
  for (const c of cols) {
    const built = buildValueSearchSql(c.table, c.field, "IN8");
    expect(built.ok, `${c.table}.${c.field} 应可拼装`).toBe(true);
    expect(assertSql(built.sql, { glossary: null }).ok, `${c.table}.${c.field} 应过只读闸门`).toBe(true);
  }
});

test("静态接线：search_values 走纯函数 + 只读闸门（适配器 import 即连 stdio）", () => {
  expect(ADAPTER).toContain('from "./bi-value-search.mjs"');
  const at = ADAPTER.indexOf('name: "search_values"');
  expect(at).toBeGreaterThan(-1);
  const section = ADAPTER.slice(at, ADAPTER.indexOf('name: "get_field_values"', at));
  expect(section).toContain("dimensionColumnsFromMeta(");
  expect(section).toContain("buildValueSearchSql(");
  expect(section).toContain("assertSql(built.sql");
});
