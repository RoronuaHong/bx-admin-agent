// 白名单求交：验证抽表结果里的 CTE 名 / 表别名噪声被剔除，真实 schema 表被保留。
// 回归背景：跑分器 #486 的 usedTables 曾混入 20+ 个假表名（new_dev / first_pay / m5 / u / od…）。
// 纯函数，不连 BI、不发网络请求。
import { test, expect } from "vitest";
import {
  extractTables,
  normalizeKnownTables,
  filterKnownTables,
} from "../scripts/metabase-card-graph.mjs";

const schemaTables = [
  "film_report.elt_film_order",
  "film_report.elt_app_params",
  "film_report.elt_fo_ap_src",
  "film_report.elt_new_guid",
  "gather.event_config",
];

test("normalizeKnownTables 同时收 qualified 与 bare 名，且剥掉反引号、转小写", () => {
  const known = normalizeKnownTables(schemaTables);
  expect(known.has("film_report.elt_film_order")).toBe(true);
  expect(known.has("elt_film_order")).toBe(true);
  expect(known.has("gather.event_config")).toBe(true);
  expect(normalizeKnownTables(["`Film_Report`.`ELT_FILM_ORDER`"]).has("film_report.elt_film_order")).toBe(true);
});

test("filterKnownTables 剔除 CTE 名 / 别名噪声，保留真实表", () => {
  const known = normalizeKnownTables(schemaTables);
  const raw = [
    "film_report.elt_film_order",
    "film_report.elt_app_params",
    "new_dev",
    "first_pay",
    "m5",
    "u",
    "od",
    "acc_join",
    "seen_may",
  ];
  expect(filterKnownTables(raw, known).sort()).toEqual(
    ["film_report.elt_app_params", "film_report.elt_film_order"].sort(),
  );
});

test("filterKnownTables 支持 bare 表名写法（SQL 不带 schema）", () => {
  const known = normalizeKnownTables(schemaTables);
  expect(filterKnownTables(["elt_film_order", "u", "m5"], known)).toEqual(["elt_film_order"]);
});

test("白名单为空时 fail-open：不误杀任何抽表结果", () => {
  const raw = ["film_report.elt_film_order", "alias_x"];
  expect(filterKnownTables(raw, new Set())).toEqual(raw);
  expect(filterKnownTables(raw, null)).toEqual(raw);
});

test("端到端：含 CTE 的真实 SQL 抽表后经白名单只剩真实表", () => {
  const sql = `
    WITH new_dev AS (SELECT uid FROM film_report.elt_film_order),
         first_pay AS (SELECT uid FROM new_dev)
    SELECT od.uid, ap.v
    FROM film_report.elt_film_order AS od
    JOIN film_report.elt_app_params AS ap ON ap.uid = od.uid
    LEFT JOIN first_pay AS m5 ON m5.uid = od.uid`;
  const raw = extractTables(sql);
  // 正则只取 FROM/JOIN 后的首个标识符：CTE 名在后续被 FROM/JOIN 引用时会被当成表（噪声来源）；
  // `AS m5` 这类别名本身不会被捕获，故这里断言 CTE 名而非别名。
  expect(raw).toContain("new_dev");
  expect(raw).toContain("first_pay");
  expect(raw).not.toContain("m5");
  // 白名单求交后只留真实 schema 表
  expect(filterKnownTables(raw, normalizeKnownTables(schemaTables)).sort()).toEqual(
    ["film_report.elt_app_params", "film_report.elt_film_order"].sort(),
  );
});
