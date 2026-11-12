import { test, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import {
  approvedEntries,
  buildFkHealth,
  checkCaliber,
  fkHealthFor,
  filterValues,
  loadFkHealth,
  loadGlossary,
  parseFkEdge,
} from "../scripts/bi-semantic.mjs";
import { renderTableMSchema } from "../scripts/metabase-mschema.mjs";
import { auditCards } from "../scripts/bi-caliber-audit.mjs";

const golden = JSON.parse(readFileSync(fileURLToPath(new URL("./bi-golden-set.json", import.meta.url)), "utf8"));

test("parseFkEdge：子表.列 → 父表.列，带 schema 与括号备注也能解析", () => {
  expect(parseFkEdge("elt_film_order.srcOrderId → elt_film_order._id（自引用）")).toEqual({
    child: "elt_film_order",
    column: "srcorderid",
    parent: "elt_film_order",
  });
  expect(parseFkEdge("film_report.elt_film_order.activityId → film_report.elt_ul_activity._id")?.child).toBe("elt_film_order");
  expect(parseFkEdge("不是边")).toBeNull();
});

test("外键健康：只收核对未通过的边；人工结论优先于技术结论", () => {
  const h = buildFkHealth({
    edges: [
      { edge: "a.x → b._id", status: "VERIFIED", rootCause: null },
      { edge: "a.y → c._id", status: "NEEDS_DECISION", rootCause: "EMPTY_PARENT_TABLE", signoff: { decision: null } },
      { edge: "a.z → d._id", status: "NEEDS_DECISION", rootCause: "DEAD_FK_COLUMN", signoff: { decision: "删除该外键" } },
    ],
  });
  expect(h.size).toBe(2);
  expect(fkHealthFor(h, "film_report.a", "x")).toBeNull();
  expect(fkHealthFor(h, "film_report.a", "Y")?.note).toMatch(/父表当前为 0 行.*待人工签字/);
  expect(fkHealthFor(h, "a", "z")?.note).toMatch(/人工结论：删除该外键/);
});

test("真实核对清单：6 条待决 + 1 条越权都会被标注，11 条可信的不标", () => {
  const h = loadFkHealth();
  expect(h.size).toBe(7);
  expect(fkHealthFor(h, "film_report.elt_film_order", "activityId")?.rootCause).toBe("EMPTY_PARENT_TABLE");
  expect(fkHealthFor(h, "elt_film_order", "movieId")).toBeNull();
});

test("M-Schema：核对未通过的外键在 FK 后标注，其它字段不变", () => {
  const fieldIndex = new Map([[1, "elt_ul_activity._id"], [2, "elt_film_movie._id"]]);
  const table = {
    name: "elt_film_order",
    schema: "film_report",
    fields: [
      { name: "activityId", base_type: "type/Text", fk_target_field_id: 1 },
      { name: "movieId", base_type: "type/BigInteger", fk_target_field_id: 2 },
    ],
  };
  const out = renderTableMSchema("主库", 2, "clickhouse", table, fieldIndex, null, new Map([["activityId", "父表为空"]]));
  expect(out).toMatch(/- activityId Text FK → elt_ul_activity\._id \[FK 核对未通过：父表为空\]/);
  expect(out).toMatch(/- movieId BigInteger FK → elt_film_movie\._id$/m);
});

test("filterValues：= / IN / OR 组合都能取到取值集合；不过滤返回 null；不误匹配同名后缀列", () => {
  expect(filterValues("WHERE (`orderStatus` = 3) OR (`orderStatus` = 6)", "orderStatus")).toEqual([3, 6]);
  expect(filterValues("where o.orderStatus in (6)", "orderStatus")).toEqual([6]);
  expect(filterValues("GROUP BY orderStatus", "orderStatus")).toBeNull();
  expect(filterValues("WHERE preorderStatus = 1", "orderStatus")).toBeNull();
});

const glossary = {
  entries: [
    { id: "paid_order", status: "draft", check: { type: "filter_set", table: "elt_film_order", column: "orderStatus", values: [3, 6] } },
    { id: "revenue_amount", status: "draft", check: { type: "sum_column", table: "elt_film_order", column: "changeAmount", forbidden: ["amount"] } },
    { id: "report_timezone", status: "draft", check: { type: "timezone", timezone: "Asia/Shanghai", others: ["Asia/Kolkata"] } },
    {
      id: "country_dimension",
      status: "draft",
      check: { type: "dimension_source", allowed: ["elt_user_full.countryCode"], forbidden: ["elt_app_params.ipCountryCode"] },
    },
    { id: "approved_one", status: "approved", check: null },
  ],
};

test("checkCaliber：状态集合、金额字段、时区、维度来源各自判冲突", () => {
  const bad = checkCaliber(
    "SELECT a.ipCountryCode, sum(o.amount) FROM film_report.elt_film_order o JOIN film_report.elt_app_params a ON a.guid = o.guid WHERE o.orderStatus = 6 AND o.createdTime >= '2026-01-01' GROUP BY a.ipCountryCode",
    glossary,
  );
  expect(bad.violations.map((v) => v.id).sort()).toEqual(["country_dimension", "paid_order", "report_timezone", "revenue_amount"]);

  const good = checkCaliber(
    "SELECT u.countryCode, sum(o.changeAmount) FROM film_report.elt_film_order o JOIN film_report.elt_user_full u ON u.uid = o.uid WHERE o.orderStatus IN (3, 6) AND o.createdTime >= parseDateTimeBestEffort('2026-01-01', 'Asia/Shanghai') GROUP BY u.countryCode",
    glossary,
  );
  expect(good.violations).toEqual([]);
  expect(good.checked).toBe(4);
});

test("checkCaliber：不适用的规则不计入（按状态分组算结算率、无时间条件、Metabase 透传投影）", () => {
  const r = checkCaliber(
    "SELECT orderStatus, count() FROM film_report.elt_film_order GROUP BY orderStatus",
    glossary,
  );
  expect(r.checked).toBe(0);
  const passthrough = checkCaliber(
    "SELECT count(*) FROM (SELECT `film_report`.`elt_app_params`.`ipCountryCode` AS `ipCountryCode` FROM `film_report`.`elt_app_params`) t",
    glossary,
  );
  expect(passthrough.violations.find((v) => v.id === "country_dimension")).toBeUndefined();
});

test("口径词典：只把 approved 条目提供给线上；当前草稿全部未批", () => {
  expect(approvedEntries(glossary).map((e) => e.id)).toEqual(["approved_one"]);
  const real = loadGlossary();
  expect(real?.entries.length).toBeGreaterThan(0);
  expect(approvedEntries(real)).toEqual([]);
  for (const e of real!.entries) expect(e.openQuestions?.length).toBeGreaterThan(0);
});

test("口径审计：真实卡片里能找出已支付订单 / 收入金额 / 国家维度的冲突", () => {
  const rules = auditCards(golden.cases, loadGlossary());
  const byId = Object.fromEntries(rules.map((r) => [r.id, r]));
  expect(byId.paid_order.conflict.map((c: { id: number }) => c.id).sort()).toEqual([46, 473]);
  expect(byId.revenue_amount.conflict.map((c: { id: number }) => c.id).sort()).toEqual([121, 125]);
  expect(byId.country_dimension.conflict.length).toBeGreaterThan(0);
  expect(byId.country_dimension.agree).toEqual([]);
  expect(byId.report_timezone.conflict).toEqual([]);
});

test("时区：服务器默认时区与约定一致时，不写时区不算冲突；显式写别的时区仍算", () => {
  const tz = { entries: [{ id: "tz", status: "draft", check: { type: "timezone", timezone: "Asia/Shanghai", others: ["Asia/Kolkata"], serverTimezone: "Asia/Shanghai" } }] };
  const implicit = checkCaliber("SELECT count() FROM t WHERE toDate(createdTime) = '2026-01-01'", tz);
  expect(implicit.violations).toEqual([]);
  expect(implicit.passed).toEqual(["tz"]);
  const kolkata = checkCaliber("SELECT count() FROM t WHERE toDate(createdTime, 'Asia/Kolkata') = '2026-01-01'", tz);
  expect(kolkata.violations.map((v) => v.id)).toEqual(["tz"]);
});
