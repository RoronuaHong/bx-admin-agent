import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAnalyticsIntentFromStructure, extractChannelsFromNl } from "../src/analytics/intent.js";
import { compileAnalyticsIntent } from "../src/analytics/sql-compile.js";
import type { AnalyticsPack } from "../src/analytics/semantic-layer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../config/analytics");
const pack = JSON.parse(readFileSync(join(root, "watch-detail.pack.json"), "utf8")) as AnalyticsPack;

const ORIG =
  "统计 IndiaA 渠道 在 2026-08-19 至 2026-08-25 期间，按观看日期 + 渠道 维度，三种小语种用户观看视频最大进度的平均值，也就是完播率";

{
  assert.deepEqual(extractChannelsFromNl(ORIG, pack), ["IndiaA"]);
  assert.deepEqual(extractChannelsFromNl("印度A 按天人数", pack), ["IndiaA"]);
  assert.deepEqual(extractChannelsFromNl("印度A 按天人数"), []);
  assert.deepEqual(extractChannelsFromNl("巴西A 按天人数", pack), []);
  assert.deepEqual(extractChannelsFromNl("巴西环境的日活", pack), []);
  assert.deepEqual(extractChannelsFromNl("印度环境的日活", pack), []);
  assert.deepEqual(extractChannelsFromNl("FilmeTela 按天人数", pack), ["FilmeTela"]);
  assert.deepEqual(extractChannelsFromNl("FoxA 和 GoGo 观看人数", pack).slice().sort(), ["FoxA", "GoGo"]);
  assert.ok(!extractChannelsFromNl("同比 YoY 增长率 SQL", pack).includes("YoY"));
  // pack schema 驼峰词（字段/参数名）不得被当成渠道候选（2026-09-14 修复）
  assert.ok(!extractChannelsFromNl("按 appVersion 3.4.1 统计 watchSecond", pack).includes("appVersion"));
  assert.ok(!extractChannelsFromNl("watchSecond 合计按 contentLang", pack).includes("watchSecond"));
  assert.ok(!extractChannelsFromNl("watchSecond 合计按 contentLang", pack).includes("contentLang"));
  // 真实渠道码不受影响
  assert.deepEqual(extractChannelsFromNl("统计 IndiaA 渠道版本 3.4.1 的付费转化率", pack), ["IndiaA"]);
}

// structure → Intent → 宽表 avg_of_max
{
  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: {
        channel: ["IndiaA"],
        contentLang: ["te-IN", "ta-IN", "ml-IN"],
      },
      outputDims: ["watch_date", "channel"],
      layout: "wide",
      pivotDim: "contentLang",
      metricId: "avg_max_progress",
    },
    pack,
    fallbackNl: ORIG,
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  assert.equal(built.intent.metric.kind, "avg_of_max");
  assert.equal(built.intent.layout, "wide");
  assert.equal(built.intent.pivotDim, "contentLang");
  assert.deepEqual(built.intent.filters.channel, ["IndiaA"]);
  assert.deepEqual(built.intent.filters.contentLang?.slice().sort(), ["ml-IN", "ta-IN", "te-IN"]);
  assert.ok(built.intent.filters.movieType?.includes("1"));

  const compiled = compileAnalyticsIntent(built.intent, pack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  const sql = compiled.sql;
  assert.match(sql, /elt_watch_detail/);
  assert.match(sql, /max\(maxWatchProgress\)\s+AS\s+a/i);
  assert.match(sql, /sumIf\s*\(\s*a\s*,\s*contentLang\s*=\s*'te-IN'\s*\)/i);
  assert.match(sql, /countIf\s*\(\s*contentLang\s*=\s*'ta-IN'\s*\)/i);
  assert.match(sql, /AS\s+ml_IN/i);
  assert.match(sql, /channel\s*=\s*'IndiaA'/);
  assert.match(sql, /movieType\s+IN\s*\(\s*1\s*,/);
  assert.match(sql, /GROUP BY\s+watchDate\s*,\s*channel\s*$/m);
  assert.doesNotMatch(sql, /GROUP BY\s+watchDate\s*,\s*channel\s*,\s*contentLang/i);
  assert.doesNotMatch(sql, /uniq\s*\(\s*guid\s*\)/i);
}

// structure → Intent → 宽表 avg_per_user（人均按语言 per-value 条件聚合展开，2026-09-14 根治）
{
  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: {
        channel: ["IndiaA"],
        contentLang: ["(empty)", "te-IN", "ta-IN", "ml-IN"],
        movieType: ["1", "2", "3", "4", "10", "11"],
      },
      outputDims: ["watch_date", "channel"],
      layout: "wide",
      pivotDim: "contentLang",
      metricId: "avg_watch_second_per_user",
    },
    pack,
    fallbackNl: "按观看日期和渠道分组，统计 IndiaA 渠道四种内容语言的人均观看时长",
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  assert.equal(built.intent.metric.kind, "avg_per_user");
  assert.equal(built.intent.layout, "wide");
  assert.equal(built.intent.pivotDim, "contentLang");

  const compiled = compileAnalyticsIntent(built.intent, pack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  const sql = compiled.sql;
  // 每种语言独立一列：分子 sumIf / 分母 uniqIf（同语言内各自去重），禁止混算
  assert.match(sql, /sumIf\s*\(\s*watchSecond\s*,\s*contentLang\s*=\s*'te-IN'\s*\)/i);
  assert.match(sql, /uniqIf\s*\(\s*guid\s*,\s*contentLang\s*=\s*'te-IN'\s*\)/i);
  assert.match(sql, /contentLang\s*=\s*''/); // 英语 = 空字符串成员
  assert.match(sql, /AS\s+ml_IN/i);
  assert.match(sql, /channel\s*=\s*'IndiaA'/);
  assert.match(sql, /movieType\s+IN\s*\(\s*1\s*,/);
  // 分组仅 watchDate+channel；语言是列展开不是行维
  assert.match(sql, /GROUP BY\s+watchDate\s*,\s*channel\s*$/m);
  assert.doesNotMatch(sql, /sum\(watchSecond\)\s*\/\s*nullIf\(uniq\(guid\)\)/i);
}

// long 布局
{
  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"], contentLang: ["te-IN", "ta-IN"] },
      outputDims: ["watch_date", "channel"],
      layout: "long",
      pivotDim: "contentLang",
      metricId: "avg_max_progress",
    },
    pack,
    fallbackNl: ORIG,
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  const compiled = compileAnalyticsIntent(built.intent, pack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  assert.match(compiled.sql, /round\(\s*avg\(a\)\s*,\s*0\)\s+AS\s+avg_max_progress/i);
  assert.match(compiled.sql, /contentLang/);
  assert.doesNotMatch(compiled.sql, /sumIf/);
}

// uniq 人数
{
  const nl = "IndiaA 2026-08-20到21 按天观看人数";
  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-20", end: "2026-08-21" },
      filters: { channel: ["IndiaA"] },
      outputDims: ["watch_date"],
      metricId: "uniq_users",
    },
    pack,
    fallbackNl: nl,
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  assert.equal(built.intent.metric.kind, "uniq");
  const compiled = compileAnalyticsIntent(built.intent, pack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  assert.match(compiled.sql, /uniq\(guid\)\s+AS\s+users/i);
  assert.match(compiled.sql, /channel\s*=\s*'IndiaA'/);
}

// 完播宽表缺 layout → intent 失败
{
  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"], contentLang: ["te-IN", "ta-IN"] },
      outputDims: ["watch_date", "channel"],
      pivotDim: "contentLang",
      metricId: "avg_max_progress",
    },
    pack,
    fallbackNl: ORIG,
  });
  assert.equal(built.ok, false);
}

{
  const alt = {
    ...pack,
    time: { ...pack.time, field: "eventAt" },
    tables: [{ name: "ads_other", fields: ["eventAt", "channel", "guid"] }],
    guards: { ...pack.guards, defaultMovieTypes: [] },
  };
  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-20", end: "2026-08-21" },
      filters: { channel: ["IndiaA"] },
      outputDims: ["watch_date"],
      metricId: "uniq_users",
    },
    pack: alt,
    fallbackNl: "IndiaA 按天观看人数",
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  const compiled = compileAnalyticsIntent(built.intent, alt);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  assert.match(compiled.sql, /toDate\(eventAt\)/);
  assert.doesNotMatch(compiled.sql, /lastWatchTime/);
  assert.doesNotMatch(compiled.sql, /movieType/);

  const ghost = compileAnalyticsIntent(
    { ...built.intent, filters: { ...built.intent.filters, notAField: ["x"] } },
    alt,
  );
  assert.equal(ghost.ok, false);
  if (!ghost.ok) assert.match(ghost.reason, /filter_field_not_in_catalog:notAField/);
}

{
  const orderPack = {
    ...pack,
    warehouse: {
      tables: [
        {
          schema: "film_report",
          name: "elt_film_order",
          fields: ["createdTime", "amount", "guid"],
          fieldTypes: { createdTime: "type/DateTime", amount: "type/Float", guid: "type/Text" },
        },
      ],
    },
  };
  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: {},
      outputDims: [],
      metricId: "count:*",
      table: "elt_film_order",
    },
    pack: orderPack,
    fallbackNl: "查 elt_film_order 在 2026-08-19 到 2026-08-25 的订单数",
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  assert.equal(built.intent.table, "elt_film_order");
  assert.equal(built.intent.metric.kind, "count");
  assert.ok(!built.intent.filters.movieType);
  const compiled = compileAnalyticsIntent(built.intent, orderPack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  assert.match(compiled.sql, /FROM film_report\.elt_film_order/);
  assert.match(compiled.sql, /toDate\(createdTime\)/);
  assert.match(compiled.sql, /count\(\)/);
  assert.doesNotMatch(compiled.sql, /GROUP BY/);
  assert.doesNotMatch(compiled.sql, /movieType/);

  const leaked = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"] },
      outputDims: ["channel"],
      metricId: "count:*",
      table: "elt_film_order",
    },
    pack: orderPack,
    fallbackNl: "IndiaA 查 elt_film_order 在 2026-08-19 到 2026-08-25 的订单数",
  });
  assert.equal(leaked.ok, true);
  if (!leaked.ok) throw new Error(leaked.reason);
  assert.ok(!leaked.intent.filters.channel);
  assert.deepEqual(leaked.intent.outputDims, []);
  const leakedSql = compileAnalyticsIntent(leaked.intent, orderPack);
  assert.equal(leakedSql.ok, true);
  if (!leakedSql.ok) throw new Error(leakedSql.reason);
  assert.doesNotMatch(leakedSql.sql, /channel/);
}

{
  const rechargePack = {
    ...pack,
    warehouse: {
      tables: [
        {
          schema: "film_report",
          name: "elt_user_vip_recharge_log",
          fields: ["createdTime", "price", "channel"],
          fieldTypes: {
            createdTime: "type/DateTime",
            price: "type/Integer",
            channel: "type/Integer",
          },
        },
      ],
    },
  };
  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"] },
      outputDims: [],
      metricId: "count:*",
      table: "elt_user_vip_recharge_log",
    },
    pack: rechargePack,
    fallbackNl: "IndiaA 查 elt_user_vip_recharge_log 在 2026-08-19 到 2026-08-25 的充值笔数",
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  assert.ok(!built.intent.filters.channel);
  const compiled = compileAnalyticsIntent(built.intent, rechargePack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  assert.match(compiled.sql, /FROM film_report\.elt_user_vip_recharge_log/);
  assert.doesNotMatch(compiled.sql, /channel/);
}

{
  const dimPack = {
    ...pack,
    warehouse: {
      tables: [
        {
          schema: "film_report",
          name: "dim_country",
          fields: ["id", "name"],
          fieldTypes: { id: "type/Integer", name: "type/Text" },
        },
      ],
    },
  };
  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: {},
      outputDims: [],
      metricId: "count:*",
      table: "dim_country",
    },
    pack: dimPack,
    fallbackNl: "查 dim_country 行数",
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  const compiled = compileAnalyticsIntent(built.intent, dimPack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  assert.match(compiled.sql, /FROM film_report\.dim_country/);
  assert.match(compiled.sql, /count\(\)/);
  assert.doesNotMatch(compiled.sql, /lastWatchTime/);
  assert.doesNotMatch(compiled.sql, /toDate\(/);
}

// conditional_wide: 人均 / 起播 未点语种 → pack defaultWideLangs
{
  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"], contentLang: ["", "te-IN", "ta-IN", "ml-IN"] },
      outputDims: ["watch_date", "channel"],
      layout: "wide",
      pivotDim: "contentLang",
      metricId: "avg_watch_second_per_user",
    },
    pack,
    fallbackNl: "IndiaA 人均时长宽表 2026-08-19 至 2026-08-25",
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  const compiled = compileAnalyticsIntent(built.intent, pack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  assert.match(compiled.sql, /sumIf\(watchSecond,\s*contentLang = ''\)/);
  assert.match(compiled.sql, /uniqIf\(guid,\s*contentLang = 'te-IN'\)/);
  assert.match(compiled.sql, /AS te_IN/);
}

{
  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"] },
      outputDims: ["watch_date", "channel"],
      layout: "wide",
      pivotDim: "contentLang",
      metricId: "uniq_users",
    },
    pack,
    fallbackNl: "IndiaA 起播人数宽表 2026-08-19 至 2026-08-25",
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  const compiled = compileAnalyticsIntent(built.intent, pack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  assert.match(compiled.sql, /uniqIf\(guid,\s*contentLang = ''\)/);
  assert.match(compiled.sql, /uniqIf\(guid,\s*contentLang = 'ml-IN'\)/);
}

{
  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"], appVersion: ["2.4.1"] },
      outputDims: [],
      metricId: "pay_rate_lang_wide",
      table: "elt_film_user",
    },
    pack,
    fallbackNl: "IndiaA 版本 2.4.1 付费率 2026-08-19 至 2026-08-25",
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  assert.equal(built.intent.metric.kind, "ratio");
  const compiled = compileAnalyticsIntent(built.intent, pack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  assert.match(compiled.sql, /elt_film_user/);
  assert.match(compiled.sql, /elt_film_order/);
  assert.match(compiled.sql, /aa\._id = bb\.uid/);
  assert.match(compiled.sql, /orderStatus = 6/);
  assert.match(compiled.sql, /uniqIf\(uid,\s*contentLang = ''\)/);
  assert.match(compiled.sql, /AS a2/);
}

{
  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"], appVersion: ["2.4.1"] },
      outputDims: [],
      metricId: "retention_d1_total",
      table: "elt_new_guid",
    },
    pack,
    fallbackNl: "IndiaA 版本 2.4.1 次日留存 2026-08-19",
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  assert.equal(built.intent.metric.kind, "retention_dn");
  const compiled = compileAnalyticsIntent(built.intent, pack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  assert.match(compiled.sql, /gather\.gather/);
  assert.match(compiled.sql, /elt_new_guid/);
  assert.match(compiled.sql, /elt_active_guid/);
  assert.match(compiled.sql, /addDays\(targetDate, 1\)/);
  assert.match(compiled.sql, /content_language_save_success/);
  assert.match(compiled.sql, /uniq\(guid\) AS a/);
}

{
  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"], appVersion: ["2.4.1"] },
      outputDims: [],
      metricId: "retention_d1_lang",
      table: "elt_new_guid",
    },
    pack,
    fallbackNl: "IndiaA 版本 2.4.1 留存1 2026-08-19",
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  const compiled = compileAnalyticsIntent(built.intent, pack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  assert.match(compiled.sql, /countIf\(contentLang = ''\) AS a/);
  assert.match(compiled.sql, /countIf\(contentLang = ''\) AS aa/);
}

console.log("analytics-intent-compile.test.ts OK");
