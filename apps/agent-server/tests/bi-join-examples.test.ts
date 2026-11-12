// few-shot join 样例库纯函数回归：抽 JOIN 路径、按表建索引、白名单剔除 CTE 噪声。
// 全程本地字符串，不连 BI、不调模型。
import { test, expect } from "vitest";
import { extractJoins, buildJoinExamples, joinExamplesForTable } from "../scripts/bi-join-examples.mjs";
import { normalizeKnownTables } from "../scripts/metabase-card-graph.mjs";

const known = normalizeKnownTables([
  "film_report.elt_film_order",
  "film_report.elt_user_full",
  "film_report.elt_app_params",
  "gather.event_config",
]);

const cardSql = `
SELECT o._id, u.countryCode, c.name
FROM film_report.elt_film_order AS o
LEFT JOIN film_report.elt_user_full AS u ON u.uid = o.uid
INNER JOIN gather.event_config AS c ON c.id = o.eventId
WHERE o.createdTime >= '2026-11-01'
GROUP BY 1 LIMIT 10`;

test("extractJoins 识别 LEFT / INNER JOIN 及目标表，ON 片段可读", () => {
  const joins = extractJoins(cardSql);
  expect(joins.map((j) => [j.type, j.table])).toEqual([
    ["LEFT", "film_report.elt_user_full"],
    ["INNER", "gather.event_config"],
  ]);
  expect(joins[0].snippet).toMatch(/ON\s+u\.uid\s*=\s*o\.uid/i);
  // ON 片段不应吞进后续 WHERE / GROUP BY
  expect(joins[1].snippet).not.toMatch(/WHERE|GROUP BY|LIMIT/);
});

test("extractJoins 对无 JOIN 的单表 SQL 返回空", () => {
  expect(extractJoins("SELECT 1 FROM film_report.elt_film_order LIMIT 1")).toEqual([]);
  expect(extractJoins("")).toEqual([]);
});

test("buildJoinExamples 按表建索引，question 取自卡片名", () => {
  const idx = buildJoinExamples([{ id: 42, name: "拉新用户国家分布", sql: cardSql }], known);
  expect(idx.total).toBe(1);
  expect(idx.examples[0].question).toBe("拉新用户国家分布");
  expect(idx.examples[0].tables).toContain("film_report.elt_film_order");
  expect(idx.byTable.get("film_report.elt_film_order")).toHaveLength(1);
});

test("白名单剔除 CTE 名噪声：FROM 子查询里的假表不成 join 路径", () => {
  const noisy = `
WITH tmp AS (SELECT uid FROM film_report.elt_film_order)
SELECT t.uid FROM tmp AS t
JOIN film_report.elt_user_full AS u ON u.uid = t.uid
JOIN tmp AS t2 ON t2.uid = t.uid`;
  const idx = buildJoinExamples([{ id: 7, name: "CTE 复用", sql: noisy }], known);
  // `tmp` 不是真实表，被过滤；只剩 elt_user_full 一条有效 join，但涉及表 >=2 才成样例
  const ex = idx.examples[0];
  expect(ex).toBeTruthy();
  expect(ex.joins.every((j) => j.table !== "tmp")).toBe(true);
  expect(ex.tables.every((t) => t.startsWith("film_report.") || t.startsWith("gather."))).toBe(true);
});

test("joinExamplesForTable 支持 qualified / bare 写法并去重、按 join 数排序", () => {
  const idx = buildJoinExamples(
    [
      { id: 1, name: "单 join", sql: "SELECT 1 FROM film_report.elt_film_order o JOIN film_report.elt_app_params p ON p.uid=o.uid" },
      { id: 2, name: "双 join", sql: cardSql },
    ],
    known,
  );
  const hits = joinExamplesForTable(idx, "elt_film_order", 5);
  expect(hits.find((h) => h.cardId === 2)).toBeTruthy();
  expect(hits.find((h) => h.cardId === 1)).toBeTruthy();
  expect(hits[0].cardId).toBe(2); // join 数更多的排前
  expect(hits).toHaveLength(2); // 同一卡片不因多表命中而重复
});

test("UNION 多段里重复的 join 只留一条，且 on 条件单独可用", () => {
  const sql = `
SELECT o._id FROM film_report.elt_film_order o JOIN film_report.elt_user_full u ON u.uid=o.uid WHERE o.x=1
UNION ALL
SELECT o._id FROM film_report.elt_film_order o JOIN film_report.elt_user_full u ON u.uid=o.uid WHERE o.x=2`;
  const idx = buildJoinExamples([{ id: 3, name: "UNION 复用", sql }], known);
  expect(idx.examples[0].joins).toHaveLength(1);
  expect(idx.examples[0].joins[0].on).toMatch(/u\.uid\s*=\s*o\.uid/);
  expect(idx.examples[0].joins[0].on).not.toMatch(/WHERE|UNION/);
});

test("白名单为空时 fail-open：行为退化为不过滤", () => {
  const idx = buildJoinExamples([{ id: 9, name: "x", sql: cardSql }], new Set());
  expect(idx.total).toBe(1);
  expect(idx.examples[0].joins).toHaveLength(2);
});
