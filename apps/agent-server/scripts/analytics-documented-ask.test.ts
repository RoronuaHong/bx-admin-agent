/**
 * Documented-table NL → slots → compile (no LLM, no network).
 * Run: tsx scripts/analytics-documented-ask.test.ts
 */
import assert from "node:assert/strict";
import { applyCatalogToPack, parseMetabaseDatabaseMetadata } from "../src/analytics/catalog.js";
import { coerceMetricForWarehouseTable } from "../src/analytics/documented-ask.js";
import { inferMetricIdFromNl, missingRequiredMetricSlots } from "../src/analytics/metric-infer.js";
import { resolveAskTable } from "../src/analytics/table-resolve.js";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";

const catalog = parseMetabaseDatabaseMetadata(
  {
    tables: [
      {
        name: "elt_watch_detail",
        schema: "film_report",
        description: "本表为用户设备观影的每天汇总明细表",
        fields: [
          { name: "lastWatchTime", active: true, base_type: "type/DateTime" },
          { name: "guid", active: true, base_type: "type/Text" },
          { name: "channel", active: true, base_type: "type/Text" },
        ],
      },
      {
        name: "elt_film_order",
        schema: "film_report",
        display_name: "用户订单表",
        description: "本表为用户订单表，含明细信息。核心信息：订单金额、支付信息。",
        fields: [
          { name: "payTime", active: true, base_type: "type/DateTime" },
          { name: "createdTime", active: true, base_type: "type/DateTime" },
          { name: "amount", active: true, base_type: "type/Float", description: "实付金额" },
          { name: "guid", active: true, base_type: "type/Text" },
        ],
      },
      {
        name: "elt_user_full",
        schema: "film_report",
        description:
          "本表为用户画像数据的大宽表。\n核心信息：累计结算订单数量和金额、近N天创建的订单数量和金额。",
        fields: [{ name: "recordDate", active: true, base_type: "type/Date" }],
      },
      {
        name: "elt_active_guid",
        schema: "film_report",
        description: "本表为每天日活用户表。核心信息：设备、渠道、活跃日。",
        fields: [
          { name: "activeDate", active: true, base_type: "type/Date" },
          { name: "guid", active: true, base_type: "type/Text" },
          { name: "channel", active: true, base_type: "type/Text" },
        ],
      },
      {
        name: "elt_film_user",
        schema: "film_report",
        description: "账号详细资料表。核心信息：基础资料、登录资料。",
        fields: [
          { name: "birthday", active: true, base_type: "type/DateTime" },
          { name: "createdTime", active: true, base_type: "type/DateTime" },
          { name: "_id", active: true, base_type: "type/BigInteger" },
        ],
      },
    ],
  },
  2,
  1,
);

const pack = applyCatalogToPack(loadAnalyticsPack("watch-detail"), catalog, "metabase").pack;

{
  const r = resolveAskTable({ nl: "2026-08-19 到 2026-08-25 的订单数", pack });
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.table, "elt_film_order");
}

{
  assert.equal(inferMetricIdFromNl("订单金额合计", pack, "elt_film_order"), "sum:amount");
  assert.equal(coerceMetricForWarehouseTable("uniq_users", "订单数", pack, "elt_film_order"), "count:*");
}

{
  const locked = resolveAskTable({ nl: "找下巴西环境的昨天到今天的日活", pack });
  assert.equal(locked.status, "ok");
  if (locked.status === "ok") assert.equal(locked.table, "elt_active_guid");
  assert.equal(inferMetricIdFromNl("找下巴西环境的昨天到今天的日活", pack), "dau");
  assert.deepEqual(missingRequiredMetricSlots("dau", "找下印度环境的昨天到今天的日活", pack), ["channel"]);
  assert.deepEqual(missingRequiredMetricSlots("dau", "找下巴西环境的昨天到今天的日活", pack), ["channel"]);
}

console.log("analytics-documented-ask.test.ts OK");
