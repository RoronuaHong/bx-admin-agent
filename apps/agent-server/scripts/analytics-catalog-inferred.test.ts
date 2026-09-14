/**
 * Inferred docs fill warehouse description when Metabase table desc is empty.
 * Run: tsx scripts/analytics-catalog-inferred.test.ts
 */
import assert from "node:assert/strict";
import { applyCatalogToPack, parseMetabaseDatabaseMetadata } from "../src/analytics/catalog.js";
import {
  formatInferredCatalogMarkdown,
  inferredDescriptionFor,
  loadInferredTableDocs,
} from "../src/analytics/catalog-inferred.js";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";
import { resolveAskTable } from "../src/analytics/table-resolve.js";

const docs = loadInferredTableDocs();
assert.equal(Object.keys(docs).length, 32);
assert.match(String(inferredDescriptionFor("watch_log")), /观影事件流水/);
assert.match(String(inferredDescriptionFor("elt_film_app_channel")), /渠道配置/);
assert.match(String(inferredDescriptionFor("gather_stat")), /按日\+事件汇总/);
assert.match(formatInferredCatalogMarkdown(), /elt_film_app_channel/);

const catalog = parseMetabaseDatabaseMetadata(
  {
    tables: [
      {
        name: "elt_watch_detail",
        schema: "film_report",
        description: "本表为用户设备观影的每天汇总明细表",
        fields: [{ name: "lastWatchTime", active: true, base_type: "type/DateTime" }],
      },
      {
        name: "watch_log",
        schema: "film_report",
        fields: [
          { name: "watchTime", active: true, base_type: "type/DateTime" },
          { name: "guid", active: true },
        ],
      },
      {
        name: "elt_film_app_channel",
        schema: "film_report",
        display_name: "渠道配置表",
        fields: [{ name: "createTime", active: true, base_type: "type/DateTime" }],
      },
      {
        name: "elt_invite_withdraw",
        schema: "film_report",
        fields: [
          { name: "payTime", active: true, base_type: "type/DateTime" },
          { name: "amount", active: true, base_type: "type/Float" },
        ],
      },
    ],
  },
  2,
  1,
);

const pack = applyCatalogToPack(loadAnalyticsPack("watch-detail"), catalog, "metabase").pack;
const watchLog = pack.warehouse?.tables.find((t) => t.name === "watch_log");
assert.match(String(watchLog?.description), /观影事件流水/);
assert.equal(watchLog?.docSource, "inferred");
assert.equal(pack.warehouse?.tables.find((t) => t.name === "elt_watch_detail")?.docSource, "metabase");
const channel = pack.warehouse?.tables.find((t) => t.name === "elt_film_app_channel");
assert.match(String(channel?.description), /渠道配置/);

{
  const r = resolveAskTable({ nl: "2026-08-19 到 2026-08-25 渠道配置有多少条", pack });
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.table, "elt_film_app_channel");
}

{
  const r = resolveAskTable({ nl: "2026-08-19 到 2026-08-25 邀请提现有多少笔", pack });
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.table, "elt_invite_withdraw");
}

{
  const withOrder = applyCatalogToPack(
    loadAnalyticsPack("watch-detail"),
    parseMetabaseDatabaseMetadata(
      {
        tables: [
          {
            name: "elt_film_order",
            schema: "film_report",
            display_name: "会员订单表",
            description: "本表为用户订单表，含明细信息",
            fields: [{ name: "payTime", active: true, base_type: "type/DateTime" }],
          },
          {
            name: "elt_invite_withdraw",
            schema: "film_report",
            fields: [{ name: "payTime", active: true, base_type: "type/DateTime" }],
          },
        ],
      },
      2,
      1,
    ),
    "metabase",
  ).pack;
  const r = resolveAskTable({ nl: "2026-08-19 到 2026-08-25 的订单数", pack: withOrder });
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.table, "elt_film_order");
}

{
  const r = resolveAskTable({
    nl: "IndiaA 在 2026-08-19 至 2026-08-25 按天观看人数",
    pack,
  });
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.table, "elt_watch_detail");
}

console.log("analytics-catalog-inferred.test.ts OK");
