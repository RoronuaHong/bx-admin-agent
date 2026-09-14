/**
 * Path C get_table_schema (no network).
 * Run: tsx scripts/analytics-catalog-schema.test.ts
 */
import assert from "node:assert/strict";
import { applyCatalogToPack, parseMetabaseDatabaseMetadata } from "../src/analytics/catalog.js";
import { getTableSchema, getTableSchemas } from "../src/analytics/catalog-schema.js";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";

const catalog = parseMetabaseDatabaseMetadata(
  {
    tables: [
      {
        name: "elt_film_order",
        schema: "film_report",
        display_name: "会员订单表",
        description: "本表为用户订单表",
        fields: [
          { name: "payTime", active: true, base_type: "type/DateTime", display_name: "支付时间" },
          { name: "amount", active: true, base_type: "type/Float" },
        ],
      },
      {
        name: "elt_user_full_tmp",
        schema: "film_report",
        fields: [{ name: "guid", active: true }],
      },
    ],
  },
  2,
  1,
);
const pack = applyCatalogToPack(loadAnalyticsPack("watch-detail"), catalog, "metabase").pack;

const order = getTableSchema(pack, "elt_film_order");
assert.equal(order.status, "ok");
if (order.status === "ok") {
  assert.match(order.text, /payTime/);
  assert.match(order.text, /time: payTime/);
  assert.doesNotMatch(order.text, /对照/);
}

const hidden = getTableSchema(pack, "elt_user_full_tmp");
assert.equal(hidden.status, "refused");

const batch = getTableSchemas(pack, ["elt_film_order", "elt_user_full_tmp", "no_such"]);
assert.deepEqual(batch.ok, ["elt_film_order"]);
assert.ok(batch.refused.some((r) => r.reason === "hidden"));
assert.ok(batch.refused.some((r) => r.reason === "not_answerable"));

console.log("analytics-catalog-schema.test.ts OK");
