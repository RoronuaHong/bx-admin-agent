/**
 * Catalog retrieval cards: identity / synonyms, 对照 stripped.
 * Run: tsx scripts/analytics-catalog-card.test.ts
 */
import assert from "node:assert/strict";
import { applyCatalogToPack, parseMetabaseDatabaseMetadata } from "../src/analytics/catalog.js";
import { stripCrossRefs, tableIdentity, tableSynonyms } from "../src/analytics/catalog-card.js";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";
import { resolveAskTable } from "../src/analytics/table-resolve.js";

assert.doesNotMatch(
  stripCrossRefs("本表为邀请提现申请单，对照 elt_film_order（订单支付状态机）。"),
  /订单/,
);
assert.match(stripCrossRefs("本表为用户订单表，含明细信息"), /用户订单表/);

const catalog = parseMetabaseDatabaseMetadata(
  {
    tables: [
      {
        name: "elt_film_order",
        schema: "film_report",
        display_name: "会员订单表",
        description: "本表为用户订单表，含明细信息。核心信息：订单金额、支付信息。",
        fields: [{ name: "payTime", active: true, base_type: "type/DateTime" }],
      },
      {
        name: "elt_invite_withdraw",
        schema: "film_report",
        fields: [
          { name: "payTime", active: true, base_type: "type/DateTime" },
          { name: "amount", active: true },
        ],
      },
    ],
  },
  2,
  1,
);
const pack = applyCatalogToPack(loadAnalyticsPack("watch-detail"), catalog, "metabase").pack;
const order = pack.warehouse?.tables.find((t) => t.name === "elt_film_order");
const withdraw = pack.warehouse?.tables.find((t) => t.name === "elt_invite_withdraw");
assert.ok(order && withdraw);
assert.ok(tableSynonyms(order).includes("订单"));
assert.ok(tableSynonyms(order).includes("订单数"));
assert.ok(!tableIdentity(withdraw).includes("订单"));
assert.ok(tableSynonyms(withdraw).includes("邀请提现"));

{
  const r = resolveAskTable({ nl: "2026-08-19 到 2026-08-25 的订单数", pack });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.table, "elt_film_order");
    assert.equal(r.confidence, "unique");
  }
}

console.log("analytics-catalog-card.test.ts OK");
