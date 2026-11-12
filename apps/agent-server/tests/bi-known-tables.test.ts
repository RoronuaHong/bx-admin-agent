// 白名单求交：验证抽表结果里的 CTE 名 / 表别名噪声被剔除，真实 schema 表被保留。
// 回归背景：跑分器 #486 的 usedTables 曾混入 20+ 个假表名（new_dev / first_pay / m5 / u / od…）。
// 纯函数，不连 BI、不发网络请求。
import { test, expect } from "vitest";
import fs from "node:fs";
import {
  extractTables,
  normalizeKnownTables,
  filterKnownTables,
  normalizeGoldenCase,
  unusedRemapTables,
  applyGoldenQuestions,
  cardTablesFromSql,
  buildGoldenSet,
} from "../scripts/metabase-card-graph.mjs";

const readJson = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), "utf8"));
const goldenData = readJson("./bi-golden-set.json");
const questionData = readJson("./bi-golden-questions.json");
const knownData = readJson("./bi-known-tables.json");

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

test("ClickHouse ARRAY JOIN 展开的是数组列，不当成表", () => {
  const sql = "SELECT t FROM film_report.elt_new_guid w ARRAY JOIN w.movieTags AS t LEFT ARRAY JOIN arr JOIN film_report.elt_film_order o ON 1";
  expect(extractTables(sql)).toEqual(["film_report.elt_new_guid", "film_report.elt_film_order"]);
});

test("normalizeGoldenCase：裸名补 schema、剔 CTE、白名单外的真表记进 unverifiedTables", () => {
  const c = normalizeGoldenCase(
    {
      id: 1,
      expected_sql: `WITH newuser AS (SELECT guid FROM elt_new_guid)
        SELECT * FROM newuser n JOIN elt_film_order o ON o.guid = n.guid JOIN user_preference_actions_report p ON 1`,
      tables: [],
    },
    schemaTables,
  );
  expect(c.tables.sort()).toEqual(["film_report.elt_film_order", "film_report.elt_new_guid", "user_preference_actions_report"]);
  expect(c.unverifiedTables).toEqual(["user_preference_actions_report"]);
  expect(normalizeGoldenCase({ id: 2, expected_sql: "SELECT 1 FROM film_report.elt_film_order", tables: [] }, schemaTables).unverifiedTables).toBeUndefined();
});

// Metabase 外键显示映射编译出的结构（会员订单表模型把 activityId 显示为活动名）
const remapSql = (outerUsesName: boolean) => `SELECT \`film_report\`.\`elt_app_params\`.\`ipRegionName\` AS \`r\`, COUNT(*) AS \`count\`${
  outerUsesName ? ", `o`.`elt_ul_activity__via__activityId__name` AS `act`" : ""
} FROM \`film_report\`.\`elt_app_params\` INNER JOIN ( SELECT \`film_report\`.\`elt_film_order\`.\`guid\` AS \`guid\`, \`elt_ul_activity__via__activityId\`.\`name\` AS \`elt_ul_activity__via__activityId__name\` FROM \`film_report\`.\`elt_film_order\` LEFT JOIN ( SELECT \`film_report\`.\`elt_ul_activity\`.\`_id\` AS \`_id\`, \`film_report\`.\`elt_ul_activity\`.\`name\` AS \`name\` FROM \`film_report\`.\`elt_ul_activity\` ) AS \`elt_ul_activity__via__activityId\` ON \`film_report\`.\`elt_film_order\`.\`activityId\` = \`elt_ul_activity__via__activityId\`.\`_id\` ) AS \`o\` ON \`film_report\`.\`elt_app_params\`.\`guid\` = \`o\`.\`guid\` GROUP BY \`r\``;

test("unusedRemapTables：外键显示映射的列外层没用到 → 该表对结果无贡献；用到了则保留", () => {
  expect(unusedRemapTables(remapSql(false))).toEqual(["film_report.elt_ul_activity"]);
  expect(unusedRemapTables(remapSql(true))).toEqual([]);
  expect(unusedRemapTables("SELECT 1 FROM film_report.elt_film_order")).toEqual([]);
  // 同一张表另有直接 JOIN 时不剔除
  const direct = remapSql(false).replace("GROUP BY", "INNER JOIN `film_report`.`elt_ul_activity` ON 1=1 GROUP BY");
  expect(unusedRemapTables(direct)).toEqual([]);
});

test("normalizeGoldenCase：只经未使用的外键显示映射引入的表移到 remapOnlyTables", () => {
  const c = normalizeGoldenCase({ id: 3, expected_sql: remapSql(false), tables: [] }, [...schemaTables, "film_report.elt_ul_activity"]);
  expect(c.tables).not.toContain("film_report.elt_ul_activity");
  expect(c.tables).toEqual(expect.arrayContaining(["film_report.elt_app_params", "film_report.elt_film_order"]));
  expect(c.remapOnlyTables).toEqual(["film_report.elt_ul_activity"]);
});

test("cardTablesFromSql：线上卡片→表索引剔除未使用的 FK 显示映射表，外层用到时保留", () => {
  const t = cardTablesFromSql(remapSql(false));
  expect(t).not.toContain("film_report.elt_ul_activity");
  expect(t).toContain("film_report.elt_app_params");
  expect(t).toContain("film_report.elt_film_order");
  expect(cardTablesFromSql(remapSql(true))).toContain("film_report.elt_ul_activity");
  expect(cardTablesFromSql("SELECT 1 FROM film_report.elt_film_order")).toEqual(["film_report.elt_film_order"]);
  expect(cardTablesFromSql("")).toEqual([]);
});

test("buildGoldenSet：线上口径图/join 样例与金样用同一抽表口径，剔除假 remap 共现", async () => {
  const mb = async (p) => {
    if (p === "/card") return { ok: true, data: [{ id: 1, name: "会员订单", database_id: 2 }] };
    if (p.startsWith("/card/")) return { ok: true, data: { dataset_query: { native: { query: remapSql(false) } } } };
    return { ok: false, status: 404, data: null };
  };
  const out = await buildGoldenSet(mb, { force: true });
  expect(out.cases).toHaveLength(1);
  expect(out.cases[0].tables).not.toContain("film_report.elt_ul_activity");
  expect(out.cases[0].tables).toContain("film_report.elt_app_params");
  expect(out.cases[0].tables).toContain("film_report.elt_film_order");
});

test("自然语言改写稿覆盖全部 97 例，黄金集已生效且保留原卡片名 cardTitle", () => {
  const qs = questionData.questions;
  expect(Object.keys(qs).length).toBe(goldenData.cases.length);
  for (const c of goldenData.cases) {
    expect(qs[String(c.id)]).toBeTruthy();
    expect(c.question).toBe(qs[String(c.id)].trim());
    expect(c.cardTitle).toBeTruthy();
    expect(c.cardTitle).not.toBe(c.question);
  }
});

test("applyGoldenQuestions 幂等；映射缺失时只补 cardTitle、不改题目", () => {
  const once = applyGoldenQuestions(goldenData.cases, questionData.questions);
  expect(applyGoldenQuestions(once, questionData.questions)).toEqual(once);
  expect(applyGoldenQuestions([{ id: 1, question: "卡片标题" }], {})[0]).toEqual({ id: 1, question: "卡片标题", cardTitle: "卡片标题" });
});

test("白名单外表查证：5 张库里存在但 Metabase 隐藏、2 张库里不存在，10 例带状态", () => {
  expect(knownData.tables.length).toBe(58);
  expect(knownData.tableAudit.existHidden.length).toBe(5);
  expect(knownData.tableAudit.missing.length).toBe(2);
  for (const t of knownData.tableAudit.existHidden) expect(knownData.tables).not.toContain(t);
  const flagged = goldenData.cases.filter((c) => c.unverifiedTableStatus);
  expect(flagged.length).toBe(10);
  expect(flagged.every((c) => Object.values(c.unverifiedTableStatus).every((s) => s !== "unknown"))).toBe(true);
  const c = normalizeGoldenCase(
    { id: 999, expected_sql: "SELECT 1 FROM user_preference_actions_report JOIN elt_ul_user_full ON 1", tables: [] },
    knownData,
  );
  expect(c.unverifiedTableStatus).toEqual({ user_preference_actions_report: "existHidden", elt_ul_user_full: "missing" });
});
