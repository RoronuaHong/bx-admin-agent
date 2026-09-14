/**
 * Documented-table NL → slots → compile (no LLM, no network).
 * Run: tsx scripts/analytics-documented-ask.test.ts
 */
import assert from "node:assert/strict";
import { applyCatalogToPack, parseMetabaseDatabaseMetadata } from "../src/analytics/catalog.js";
import { buildDocumentedTableStructure, coerceMetricForWarehouseTable } from "../src/analytics/documented-ask.js";
import { buildAnalyticsIntentFromStructure } from "../src/analytics/intent.js";
import { inferMetricIdFromNl, missingRequiredMetricSlots } from "../src/analytics/metric-infer.js";
import { resolveAskTable } from "../src/analytics/table-resolve.js";
import { compileAnalyticsIntent } from "../src/analytics/sql-compile.js";
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
  const built = buildDocumentedTableStructure({
    nl: "2026-08-19 到 2026-08-25 的订单数",
    pack,
    table: "elt_film_order",
    time: { start: "2026-08-19", end: "2026-08-25" },
    reason: "unique_score:8",
  });
  assert.ok(built);
  assert.equal(built?.table, "elt_film_order");
  assert.equal(built?.metricId, "count:*");
  const intent = buildAnalyticsIntentFromStructure({
    structure: {
      time: built!.time!,
      filters: built!.filters,
      outputDims: built!.outputDims,
      metricId: built!.metricId!,
      table: built!.table,
    },
    pack,
    fallbackNl: "2026-08-19 到 2026-08-25 的订单数",
  });
  assert.equal(intent.ok, true);
  if (!intent.ok) throw new Error(intent.reason);
  const compiled = compileAnalyticsIntent(intent.intent, pack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  assert.match(compiled.sql, /FROM film_report\.elt_film_order/);
  assert.match(compiled.sql, /count\(\)/);
  assert.match(compiled.sql, /toDate\(payTime\)/);
  assert.doesNotMatch(compiled.sql, /lastWatchTime/);
}

{
  assert.equal(inferMetricIdFromNl("订单金额合计", pack, "elt_film_order"), "sum:amount");
  assert.equal(coerceMetricForWarehouseTable("uniq_users", "订单数", pack, "elt_film_order"), "count:*");
}

{
  const built = buildDocumentedTableStructure({
    nl: "2026-08-19 到 2026-08-25 账号资料有多少",
    pack,
    table: "elt_film_user",
    time: { start: "2026-08-19", end: "2026-08-25" },
    reason: "unique_score:6",
  });
  assert.ok(built);
  const intent = buildAnalyticsIntentFromStructure({
    structure: {
      time: built!.time!,
      filters: built!.filters,
      outputDims: built!.outputDims,
      metricId: built!.metricId!,
      table: built!.table,
    },
    pack,
    fallbackNl: "账号资料有多少",
  });
  assert.equal(intent.ok, true);
  if (!intent.ok) throw new Error(intent.reason);
  const compiled = compileAnalyticsIntent(intent.intent, pack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  assert.match(compiled.sql, /toDate\(createdTime\)/);
  assert.doesNotMatch(compiled.sql, /birthday/);
}

{
  const locked = resolveAskTable({ nl: "找下巴西环境的昨天到今天的日活", pack });
  assert.equal(locked.status, "ok");
  if (locked.status === "ok") assert.equal(locked.table, "elt_active_guid");
  assert.equal(inferMetricIdFromNl("找下巴西环境的昨天到今天的日活", pack), "dau");
  assert.deepEqual(missingRequiredMetricSlots("dau", "找下印度环境的昨天到今天的日活", pack), ["channel"]);
  assert.deepEqual(missingRequiredMetricSlots("dau", "找下巴西环境的昨天到今天的日活", pack), ["channel"]);
  const built = buildDocumentedTableStructure({
    nl: "IndiaA 昨天到今天的日活",
    pack,
    table: "elt_active_guid",
    time: { start: "2026-09-13", end: "2026-09-14" },
    reason: "metric_tables:dau",
  });
  assert.ok(built);
  assert.equal(built?.table, "elt_active_guid");
  assert.equal(built?.metricId, "dau");
  assert.deepEqual(built?.filters.channel, ["IndiaA"]);
  assert.ok(built?.outputDims.includes("watch_date"));
  const intent = buildAnalyticsIntentFromStructure({
    structure: {
      time: built!.time!,
      filters: built!.filters,
      outputDims: built!.outputDims,
      metricId: built!.metricId!,
      table: built!.table,
    },
    pack,
    fallbackNl: "IndiaA 昨天到今天的日活",
  });
  assert.equal(intent.ok, true);
  if (!intent.ok) throw new Error(intent.reason);
  const compiled = compileAnalyticsIntent(intent.intent, pack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  assert.match(compiled.sql, /elt_active_guid/);
  assert.match(compiled.sql, /uniq\(guid\)/);
  assert.match(compiled.sql, /toDate\(activeDate\)/);
  assert.match(compiled.sql, /IndiaA/);
}

{
  assert.equal(
    buildDocumentedTableStructure({
      nl: "观看人数",
      pack,
      table: "elt_watch_detail",
      time: { start: "2026-08-19", end: "2026-08-25" },
      reason: "overlay_grounded",
    }),
    null,
  );
}

console.log("analytics-documented-ask.test.ts OK");
