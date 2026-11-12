// 元数据缺口清单：只列卡片 SQL 用到、且没有描述的列，按卡片数排序；列名按整词匹配。
import { test, expect } from "vitest";
import { metadataGaps } from "../scripts/bi-metadata-gaps.mjs";

const tables = [
  {
    name: "elt_film_order",
    schema: "film_report",
    fields: [
      { name: "orderStatus", description: null, semantic_type: "type/Category" },
      { name: "changeAmount", description: "换算成印度卢比的订单金额" },
      { name: "amount", description: "" },
      { name: "orderType", description: null },
    ],
  },
];

test("只列用到且无描述的列；整词匹配（amount 不会命中 changeAmount）", () => {
  const cases = [
    { id: 1, tables: ["film_report.elt_film_order"], expected_sql: "SELECT sum(changeAmount) FROM film_report.elt_film_order WHERE orderStatus IN (3,6)" },
    { id: 2, tables: ["elt_film_order"], expected_sql: "SELECT sum(amount) FROM elt_film_order WHERE orderStatus = 6 AND orderType = 1" },
    { id: 3, tables: ["elt_film_order"], expected_sql: null },
  ];
  const gaps = metadataGaps(tables, cases);
  expect(gaps.map((g) => [g.column, g.cards])).toEqual([
    ["orderStatus", 2],
    ["orderType", 1],
    ["amount", 1],
  ]);
  expect(gaps[0]).toMatchObject({ table: "film_report.elt_film_order", cardIds: [1, 2], likelyEnum: true });
});
