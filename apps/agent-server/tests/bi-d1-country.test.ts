import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadGlossary, metricDefinitions } from "../scripts/bi-semantic.mjs";
import { assertSql } from "../scripts/bi-query-guard.mjs";

const glossary = loadGlossary()!;
const byId = new Map(glossary.entries.map((e) => [e.id, e]));

// D1 验收前提：国家双维度必须已批准，否则本文件用例失去验收意义（改造回滚会显式 fail）。
describe("D1 国家维度拆分（验收：country_dimension + device_ip_country 须 approved）", () => {
  test("前提：两条目已批准，且 ipCountryCode 已从 country_dimension.forbidden 移出", () => {
    expect(byId.get("country_dimension")?.status).toBe("approved");
    expect(byId.get("device_ip_country")?.status).toBe("approved");
    const forbidden = (byId.get("country_dimension") as any).check?.forbidden || [];
    expect(forbidden).not.toContain("elt_app_params.ipCountryCode");
  });

  const gs: any = JSON.parse(
    readFileSync(fileURLToPath(new URL("../tests/bi-golden-set.json", import.meta.url)), "utf8"),
  );

  for (const id of [120, 121, 125, 126]) {
    test(`#${id} 设备国查询（含 ipCountryCode）经只读闸放行`, () => {
      const sql = gs.cases.find((c: any) => c.id === id).expected_sql;
      expect(assertSql(sql, { glossary }).ok).toBe(true);
    });
  }

  test("护栏：networkCountryIso 代理列仍被拒（不被 D1 解除）", () => {
    const sql = "SELECT count() FROM film_report.elt_app_params WHERE networkCountryIso = 'IN' GROUP BY networkCountryIso";
    expect(assertSql(sql, { glossary }).ok).toBe(false);
  });

  test("注册国 elt_user_full.countryCode 放行", () => {
    const sql = "SELECT count() FROM film_report.elt_user_full WHERE countryCode = 91 GROUP BY countryCode";
    expect(assertSql(sql, { glossary }).ok).toBe(true);
  });

  test("护栏：app_params.countryCode 代理列仍被拒", () => {
    const sql = "SELECT count() FROM film_report.elt_app_params WHERE countryCode = 'IN' GROUP BY countryCode";
    expect(assertSql(sql, { glossary }).ok).toBe(false);
  });

  test("歧义信号：问「国家」同时给两口径 + 候选项", () => {
    const r = metricDefinitions(glossary, "国家");
    const ids = (r.value as any).definitions.map((d: { id: string }) => d.id);
    expect(ids).toEqual(expect.arrayContaining(["country_dimension", "device_ip_country"]));
    expect(Array.isArray((r.value as any).ambiguities)).toBe(true);
    expect((r.value as any).ambiguities.length).toBeGreaterThanOrEqual(1);
  });

  test("回滚保护：若双国家维度回到 draft，ipCountryCode 应被内置硬拒且无歧义信号", () => {
    const clone = JSON.parse(JSON.stringify(glossary));
    for (const e of clone.entries) {
      if (e.id === "country_dimension" || e.id === "device_ip_country") e.status = "draft";
    }
    const sql = "SELECT count() FROM film_report.elt_app_params WHERE ipCountryCode = 'IN' GROUP BY ipCountryCode";
    expect(assertSql(sql, { glossary: clone }).ok).toBe(false);
    const r = metricDefinitions(clone, "国家");
    expect(r.isError).toBe(true); // 无已批准口径 → 不向模型宣告，也不输出歧义信号
  });
});
