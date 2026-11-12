// P1.1 惰性取值充实：候选判定、实测查询护栏、缓存/预算、M-Schema 渲染覆盖。
// 纯离线，不连 BI、不发网络请求（mb 为注入的假实现）。
import { test, expect } from "vitest";
import { isEnumCandidate, pickEnumFields, renderTableMSchema } from "../scripts/metabase-mschema.mjs";
import { createLiveValueCache, fetchLiveFieldValues, fillLiveValues } from "../scripts/bi-mschema-values.mjs";

const table = {
  name: "film_app_verify",
  schema: "film_report",
  description: "校验结果表",
  fields: [
    { name: "result_type", base_type: "type/Text", semantic_type: "type/Category", description: "结果来源：SUCCESS/OFFICIAL_VERIFICATION_FAILED/PROCESSING_FAILED" },
    { name: "client_type", base_type: "type/Integer", description: "映射关系：1:安卓，2:iOS，4:H5，6:安卓TV（手写枚举可能过期）" },
    { name: "_id", base_type: "type/BigInteger", semantic_type: "type/PK", description: "校验记录唯一标识" },
    { name: "change_amount", base_type: "type/Float", semantic_type: "type/Currency", description: "换算成印度卢比的订单金额；计算和统计应使用此字段" },
    { name: "status", base_type: "type/Integer", semantic_type: "type/Status" },
    { name: "fingerprinted", base_type: "type/Integer", semantic_type: "type/Category", fingerprint: { type: { values: [1, 2] } } },
  ],
};

test("isEnumCandidate：语义类型或描述里的枚举线索才入选，普通业务描述不误判", () => {
  expect(isEnumCandidate({ semantic_type: "type/Category" })).toBe(true);
  expect(isEnumCandidate({ semantic_type: "type/Enum" })).toBe(true);
  expect(isEnumCandidate({ semantic_type: "type/State" })).toBe(true);
  expect(isEnumCandidate({ semantic_type: "type/Status" })).toBe(true);
  expect(isEnumCandidate({ semantic_type: "type/Boolean" })).toBe(true);
  expect(isEnumCandidate({ description: "映射关系：1:安卓，2:iOS" })).toBe(true);
  expect(isEnumCandidate({ description: "结果来源：SUCCESS/FAILED" })).toBe(true);
  expect(isEnumCandidate({ description: "订单的唯一标识" })).toBe(false);
  expect(isEnumCandidate({ description: "换算成印度卢比的订单金额；计算和统计应使用此字段" })).toBe(false);
  expect(isEnumCandidate({})).toBe(false);
});

test("pickEnumFields：跳过指纹已有值的字段、语义类型优先、受 max 上限约束", () => {
  const picked = pickEnumFields(table.fields, 20).map((f) => f.name);
  expect(picked.slice(0, 3)).toEqual(["result_type", "status", "client_type"]);
  expect(picked).not.toContain("fingerprinted");
  expect(pickEnumFields(table.fields, 2)).toHaveLength(2);
  expect(pickEnumFields(table.fields, 0)).toEqual([]);
  expect(pickEnumFields(table.fields, 999)).toHaveLength(3); // 上限 20，实际候选只有 3 个（另 3 个字段无枚举线索或已有指纹值）
});

test("renderTableMSchema：实测取值标 (live) 并说明优先级高于可能过期的描述枚举", () => {
  const overrides = new Map([["client_type", [1, 4, 0, 5]]]);
  const text = renderTableMSchema("主库", 2, "clickhouse", table, new Map(), overrides);
  expect(text).toContain("values: [1, 4, 0, 5] (live)");
  expect(text).toContain("1 个字段来自实测去重值");
  expect(text).toContain("映射关系：1:安卓"); // 原描述仍保留，但已明确以实测为准
  expect(text).toContain("values: [1, 2]"); // fingerprint 路径照常
  expect(renderTableMSchema("主库", 2, "clickhouse", table, new Map())).not.toContain("(live)");
});

test("fetchLiveFieldValues：取样 DISTINCT、标识符加反引号、NULL 保留；非法标识符不发请求", async () => {
  const calls = [];
  const mb = async (path, opts) => {
    calls.push({ path, opts });
    return { ok: true, data: { data: { rows: [["SUCCESS"], [null], ["FAILED"]] } } };
  };
  const values = await fetchLiveFieldValues(mb, { databaseId: 2, table, field: { name: "result_type" }, scanRows: 1000 });
  expect(values).toEqual(["SUCCESS", null, "FAILED"]);
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe("/dataset");
  expect(calls[0].opts.body.native.query).toContain("FROM `film_report`.`film_app_verify` LIMIT 1000");
  expect(calls[0].opts.body.native.query).toContain("SELECT DISTINCT `result_type` AS value");
  const bad = async () => { throw new Error("不该发请求"); };
  expect(await fetchLiveFieldValues(bad, { databaseId: 2, table: { ...table, name: "t; DROP" }, field: { name: "x" } })).toBe(null);
  expect(await fetchLiveFieldValues(bad, { databaseId: 2, table, field: { name: "x); --" } })).toBe(null);
  const failing = async () => ({ ok: false, data: {} });
  expect(await fetchLiveFieldValues(failing, { databaseId: 2, table, field: { name: "status" } })).toBe(null);
});

test("fillLiveValues：缓存命中不重查、失败也缓存、maxFields 控制查询预算", async () => {
  let calls = 0;
  const mb = async () => {
    calls++;
    return { ok: true, data: { data: { rows: [[1], [4]] } } };
  };
  const cache = createLiveValueCache();
  const first = await fillLiveValues({ mb, databaseId: 2, table, maxFields: 2, cache });
  expect(first.stats.candidates).toBe(2);
  expect(first.stats.attempted).toBe(2);
  expect(first.stats.succeeded).toBe(2);
  expect(calls).toBe(2);
  const second = await fillLiveValues({ mb, databaseId: 2, table, maxFields: 2, cache });
  expect(second.stats.fromCache).toBe(2);
  expect(calls).toBe(2); // 命中缓存，零额外查询
  expect([...second.overrides.keys()]).toEqual([...first.overrides.keys()]);
});

test("fillLiveValues：单字段查询抛错只回落，不影响同批其它字段", async () => {
  const mb = async (_p, opts) => {
    if (opts.body.native.query.includes("`status`")) throw new Error("timeout");
    return { ok: true, data: { data: { rows: [["SUCCESS"]] } } };
  };
  const r = await fillLiveValues({ mb, databaseId: 2, table, maxFields: 3, cache: createLiveValueCache() });
  expect(r.stats.succeeded).toBeGreaterThan(0);
  expect(r.stats.noValues).toBe(1);
  expect(r.overrides.has("status")).toBe(false);
});
