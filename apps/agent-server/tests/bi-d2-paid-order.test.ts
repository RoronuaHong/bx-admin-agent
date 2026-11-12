import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { assertSql } from "../scripts/bi-query-guard.mjs";
import { metricDefinitions } from "../scripts/bi-semantic.mjs";

const glossary = JSON.parse(
  readFileSync(new URL("../bi-semantic/caliber-glossary.json", import.meta.url), "utf8"),
);

describe("D2 已支付订单口径（验收：paid_order 须 approved、软上线不拦）", () => {
  test("前提：paid_order 已 approved，且无 enforce（软上线：不硬拒、不给警告）", () => {
    const e = glossary.entries.find((x) => x.id === "paid_order");
    expect(e.status).toBe("approved");
    expect(e.enforce).toBeUndefined();
  });

  test("约定口径 orderStatus IN (3,6) 经只读闸放行", () => {
    const sql = "SELECT count() FROM film_report.elt_film_order WHERE orderStatus IN (3, 6)";
    expect(assertSql(sql, { glossary }).ok).toBe(true);
  });

  test("软上线：只用 6 的历史卡片写法（#46/#473 风格）不被闸拒、也不告警", () => {
    const sql = "SELECT count() FROM film_report.elt_film_order WHERE orderStatus = 6";
    const r = assertSql(sql, { glossary });
    expect(r.ok).toBe(true); // 无 enforce → 不硬拒
    expect(r.warnings ?? []).toEqual([]); // 无 enforce → 也不给警告（偏离只在离线审计标红）
  });

  test("get_metric_definitions 宣告已支付订单口径", () => {
    for (const q of ["已支付订单", "付费订单", "订单"]) {
      const r = metricDefinitions(glossary, q);
      expect(r.isError).toBe(false);
      const ids = (r.value as any).definitions.map((d: { id: string }) => d.id);
      expect(ids).toContain("paid_order");
    }
  });

  test("回滚保护：若 paid_order 回到 draft，get_metric_definitions 不再宣告", () => {
    const clone = JSON.parse(JSON.stringify(glossary));
    clone.entries.find((x: any) => x.id === "paid_order").status = "draft";
    const r = metricDefinitions(clone, "已支付订单");
    const ids = r.isError ? [] : (r.value as any).definitions.map((d: { id: string }) => d.id);
    expect(ids).not.toContain("paid_order");
  });
});
