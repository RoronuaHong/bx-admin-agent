import { test, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import {
  ambiguityFor,
  approvedEntries,
  buildFkHealth,
  checkCaliber,
  fkHealthFor,
  filterValues,
  loadFkHealth,
  loadGlossary,
  metricDefinitions,
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

test("口径词典：approved 条目才提供给线上（D1 后含双国家维度）", () => {
  expect(approvedEntries(glossary).map((e) => e.id)).toEqual(["approved_one"]);
  const real = loadGlossary();
  expect(real?.entries.length).toBeGreaterThan(0);
  const approved = approvedEntries(real).map((e) => e.id);
  expect(approved).toEqual(expect.arrayContaining(["country_dimension", "device_ip_country"])); // D1 验收前提
  // 仍是草稿的条目不得进入线上口径，且应带待业务回答的问题
  for (const e of real!.entries) {
    if (e.status !== "approved") expect((e.openQuestions?.length ?? 0)).toBeGreaterThan(0);
  }
});

test("口径审计：真实卡片里能找出已支付订单 / 收入金额的冲突（D1 后国家维度放行 ipCountryCode，不再判冲突）", () => {
  const rules = auditCards(golden.cases, loadGlossary());
  const byId = Object.fromEntries(rules.map((r) => [r.id, r]));
  expect(byId.paid_order.conflict.map((c: { id: number }) => c.id).sort()).toEqual([46, 473]);
  expect(byId.revenue_amount.conflict.map((c: { id: number }) => c.id).sort()).toEqual([121, 125]);
  // D1 解锁：ipCountryCode 已移出 country_dimension.forbidden，含它的卡片不再判国家维度冲突；
  // 护栏（networkCountryIso 等代理列）仍在，但金样中无此类卡片，故此处无冲突。
  expect(byId.country_dimension.conflict).toEqual([]);
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

const ambiguityGlossary = {
  entries: [
    {
      id: "country_dimension",
      name: "账号国家",
      aliases: ["国家", "国籍"],
      status: "approved",
      definition: "账号注册国",
      sql: "GROUP BY u.countryCode",
      ambiguous: {
        question: "问的是账号注册国还是设备 IP 国？",
        candidates: [
          { id: "country_dimension", label: "账号注册国", hint: "u.countryCode" },
          { id: "device_ip_country", label: "设备 IP 国", hint: "a.ipCountryCode" },
        ],
      },
    },
    { id: "device_ip_country", name: "设备 IP 所在国", aliases: ["设备分布"], status: "approved", definition: "设备 IP 国" },
    { id: "revenue_amount", name: "收入金额", aliases: ["流水"], status: "approved", definition: "金额口径" },
    { id: "draft_one", name: "草稿口径", status: "draft", definition: "未拍板" },
  ],
};

test("歧义信号：结构完整才输出；悬空 id、缺问题、候选不足一律不算歧义", () => {
  const entry = ambiguityGlossary.entries[0];
  expect(ambiguityFor(entry, ambiguityGlossary)?.candidates.length).toBe(2);
  expect(ambiguityFor(ambiguityGlossary.entries[2], ambiguityGlossary)).toBeNull();
  expect(ambiguityFor({ ambiguous: { question: "", candidates: [{ label: "A" }, { label: "B" }] } }, ambiguityGlossary)).toBeNull();
  expect(
    ambiguityFor({ ambiguous: { question: "选哪个？", candidates: [{ id: "missing", label: "A" }, { label: "B" }] } }, ambiguityGlossary),
  ).toBeNull();
  // 线上口径：候选项指向的条目还没批准时，不能把草稿口径当成一个可选口径告诉模型
  const oneApproved = { entries: [entry, { id: "device_ip_country", status: "draft" }] };
  expect(ambiguityFor(entry, oneApproved, { approvedOnly: true })).toBeNull();
  expect(ambiguityFor(entry, oneApproved)).not.toBeNull();
});

test("口径定义投影：只给已批准条目；命中歧义时把另一口径的定义一并补齐", () => {
  const r = metricDefinitions(ambiguityGlossary, "国家");
  expect(r.isError).toBe(false);
  const value = r.value as any;
  expect(value.definitions.map((d: { id: string }) => d.id)).toEqual(["country_dimension", "device_ip_country"]);
  expect(value.ambiguities).toHaveLength(1);
  expect(value.ambiguities[0].candidates).toHaveLength(2);
  expect(value.definitions[0].ambiguous.question).toMatch(/设备/);
  // 只给信号：投影里不含任何「替调用方选定口径」的字段
  expect(value.ambiguities[0].choice).toBeUndefined();
});

test("口径定义投影：无批准 / 无命中 / 无歧义时不泄漏草稿与空字段", () => {
  const draftAll = JSON.parse(JSON.stringify(loadGlossary()));
  for (const e of draftAll.entries) e.status = "draft"; // 隔离 D1 批准态，单独验证「无批准」分支
  expect(metricDefinitions(draftAll, "").isError).toBe(true);
  expect(metricDefinitions(ambiguityGlossary, "不存在的词").isError).toBe(true);
  const plain = metricDefinitions(ambiguityGlossary, "流水");
  const value = plain.value as any;
  expect(value.definitions.map((d: { id: string }) => d.id)).toEqual(["revenue_amount"]);
  expect(value.ambiguities).toBeUndefined();
  expect(value.definitions[0].ambiguous).toBeUndefined();
});

test("口径定义投影：app_channel 的 valueAliases 一并输出（别名上线，模型写 SQL 前可解析口语↔字面）", () => {
  const real = loadGlossary()!;
  const r = metricDefinitions(real, "应用"); // 命中 app_channel（name/aliases 含「应用」「渠道码」）
  expect(r.isError).toBe(false);
  const value = r.value as any;
  const app = value.definitions.find((d: { id: string }) => d.id === "app_channel");
  expect(app).toBeDefined();
  expect(Array.isArray(app.valueAliases)).toBe(true);
  expect(app.valueAliases.length).toBeGreaterThan(0);
  // 已验证项必须出现：IN8→INGoogle8、FoxA→FoxA、品牌名即字面
  expect(app.valueAliases.some((a: { term: string; literal: string }) => a.term === "IN8" && a.literal === "INGoogle8")).toBe(true);
  expect(app.valueAliases.some((a: { term: string; literal: string }) => a.term === "FOXA" && a.literal === "FoxA")).toBe(true);
});

test("口径定义投影：编码型口径（paid_order/member_stock/new_member）的 valueAliases 一并输出", () => {
  const real = loadGlossary()!;
  const paid = metricDefinitions(real, "订单").value.definitions.find((d: { id: string }) => d.id === "paid_order");
  expect(paid).toBeDefined();
  expect(paid.valueAliases.some((a: { term: string; literal: string; column: string }) => a.term === "支付成功" && a.literal === "3" && a.column === "orderStatus")).toBe(true);
  expect(paid.valueAliases.some((a: { term: string; literal: string }) => a.term === "已结算" && a.literal === "6")).toBe(true);
  const mem = metricDefinitions(real, "会员").value.definitions.find((d: { id: string }) => d.id === "member_stock");
  expect(mem?.valueAliases?.some((a: { term: string; literal: string }) => a.term === "会员" && a.literal === "2")).toBe(true);
  const nm = metricDefinitions(real, "新增会员").value.definitions.find((d: { id: string }) => d.id === "new_member");
  expect(nm?.valueAliases?.some((a: { term: string; literal: string }) => a.term === "首充" && a.literal === "3")).toBe(true);
  const cd = metricDefinitions(real, "国家").value.definitions.find((d: { id: string }) => d.id === "country_dimension");
  expect(cd?.valueAliases?.some((a: { term: string; literal: string; column: string }) => a.term === "印度" && a.literal === "91" && a.column === "countryCode")).toBe(true);
  const dip = metricDefinitions(real, "投流").value.definitions.find((d: { id: string }) => d.id === "device_ip_country");
  expect(dip?.valueAliases?.some((a: { term: string; literal: string; column: string }) => a.term === "巴西" && a.literal === "55" && a.column === "ipCountryCode")).toBe(true);
});

test("真实词典：歧义候选项引用不悬空，当前全草稿时线上无信号", () => {
  const real = loadGlossary()!;
  const ids = new Set(real.entries.map((e: { id: string }) => e.id));
  const withAmbiguity = real.entries.filter((e: { ambiguous?: unknown }) => e.ambiguous);
  expect(withAmbiguity.length).toBeGreaterThanOrEqual(5);
  for (const e of withAmbiguity) {
    expect(e.ambiguous.question.length).toBeGreaterThan(0);
    expect(e.ambiguous.candidates.length).toBeGreaterThanOrEqual(2);
    for (const c of e.ambiguous.candidates) if (c.id) expect(ids.has(c.id)).toBe(true);
    expect(ambiguityFor(e, real)).not.toBeNull();
  }
});

test("真实词典批准态 dry-run：不改仓库文件，只输出获批口径 + 歧义信号 + 补齐另一口径，草稿零泄漏", () => {
  const real = loadGlossary()!;
  const clone = JSON.parse(JSON.stringify(real));
  for (const e of clone.entries) {
    if (e.id === "country_dimension" || e.id === "device_ip_country") {
      e.status = "approved";
      e.owner = "dry-run";
      e.approvedAt = "2026-11-12";
    }
  }
  // 「注册国」只命中 country_dimension；device_ip_country 应作为歧义候选项被补齐，而不是靠 query 命中。
  const r = metricDefinitions(clone, "注册国");
  expect(r.isError).toBe(false);
  const value = r.value as any;
  expect(value.definitions.map((d: { id: string }) => d.id)).toEqual(["country_dimension", "device_ip_country"]);
  expect(value.ambiguities.map((a: { id: string }) => a.id)).toEqual(["country_dimension"]);
  expect(value.ambiguities[0].candidates).toHaveLength(2);
  expect(value.definitions.some((d: { id: string }) => d.id === "paid_order")).toBe(false);
});

test("只批准歧义的一方时不输出信号（另一口径仍是草稿，不能当候选告诉模型）", () => {
  const clone = JSON.parse(JSON.stringify(loadGlossary()));
  // 复位真实批准态：D1 已让双国家维度 approved，这里强制回 draft 再只批准一方
  for (const e of clone.entries) {
    if (e.id === "country_dimension" || e.id === "device_ip_country") e.status = "draft";
  }
  const cd = clone.entries.find((e) => e.id === "country_dimension")!;
  cd.status = "approved";
  cd.owner = "dry-run";
  cd.approvedAt = "2026-11-12";
  const r = metricDefinitions(clone, "注册国");
  const value = r.value as any;
  expect(value.definitions.map((d: { id: string }) => d.id)).toEqual(["country_dimension"]);
  expect(value.ambiguities).toBeUndefined();
  expect(value.definitions[0].ambiguous).toBeUndefined();
});
