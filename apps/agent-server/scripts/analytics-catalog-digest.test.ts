/**
 * Catalog digest from parsed metadata (no network).
 * Run: tsx scripts/analytics-catalog-digest.test.ts
 */
import assert from "node:assert/strict";
import {
  buildCatalogDigest,
  formatAnswerableCatalogHint,
  formatCatalogDigestMarkdown,
  formatDocumentedCatalogHint,
  tableBlurb,
} from "../src/analytics/catalog-digest.js";
import { applyCatalogToPack, parseMetabaseDatabaseMetadata } from "../src/analytics/catalog.js";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";

const catalog = parseMetabaseDatabaseMetadata(
  {
    tables: [
      {
        name: "elt_film_order",
        schema: "film_report",
        display_name: "Film orders",
        description: "订单事实表",
        fields: [
          { name: "payTime", active: true, base_type: "type/DateTime", display_name: "Pay Time" },
          { name: "guid", active: true, base_type: "type/Text", description: "设备的唯一标识" },
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

assert.equal(catalog.tables[0]?.description, "订单事实表");
assert.match(tableBlurb(catalog.tables[0]!), /订单事实表/);

const digest = buildCatalogDigest(catalog, 2);
assert.equal(digest.tableCount, 2);
assert.equal(digest.answerableCount, 1);
assert.equal(digest.hiddenCount, 1);
assert.equal(digest.tables.find((t) => t.name === "elt_film_order")?.timeField, "payTime");
assert.equal(digest.tables.find((t) => t.name === "elt_user_full_tmp")?.hidden, true);

const md = formatCatalogDigestMarkdown(digest);
assert.match(md, /elt_film_order/);
assert.match(md, /订单事实表/);
assert.match(md, /elt_user_full_tmp/);
assert.match(md, /不可查询/);
assert.match(md, /不要求用户先点名表/);
assert.doesNotMatch(md, /### `film_report.elt_user_full_tmp`/);

{
  const applied = applyCatalogToPack(loadAnalyticsPack("watch-detail"), catalog, "metabase");
  const hint = formatDocumentedCatalogHint(applied.pack);
  assert.match(hint, /elt_film_order/);
  assert.match(hint, /订单事实表/);
  assert.doesNotMatch(hint, /elt_user_full_tmp/);
  const compact = formatAnswerableCatalogHint(applied.pack);
  assert.match(compact, /Answerable tables/);
  assert.match(compact, /Index only/);
  assert.match(compact, /get_table_schema/);
  assert.match(compact, /elt_film_order/);
}

console.log("analytics-catalog-digest.test.ts OK");
