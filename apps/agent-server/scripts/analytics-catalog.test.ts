/**
 * Live catalog parse / merge / NL table gate (no network).
 * Run: tsx scripts/analytics-catalog.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCatalogToPack,
  catalogRefreshEnabled,
  diffTableFields,
  formatCatalogFacts,
  parseMetabaseDatabaseMetadata,
  unmodeledTablesNamedInNl,
  _setCatalogDirForTest,
} from "../src/analytics/catalog.js";
import { loadAnalyticsPack, packTimeField } from "../src/analytics/semantic-layer.js";

_setCatalogDirForTest(mkdtempSync(join(tmpdir(), "analytics-catalog-")));

assert.equal(catalogRefreshEnabled({ ANALYTICS_CATALOG_REFRESH: "0" }), false);
assert.equal(catalogRefreshEnabled({ ANALYTICS_CATALOG_REFRESH: "1" }), true);

const parsed = parseMetabaseDatabaseMetadata(
  {
    tables: [
      {
        name: "elt_watch_detail",
        schema: "film_report",
        fields: [
          { name: "lastWatchTime", active: true, visibility_type: "normal", base_type: "type/DateTime" },
          { name: "channel", active: true, visibility_type: "normal", base_type: "type/Text" },
          { name: "guid", active: true, visibility_type: "normal" },
          { name: "watchSecond", active: true, visibility_type: "normal" },
          { name: "ghostHidden", active: true, visibility_type: "hidden" },
          { name: "retiredCol", active: false, visibility_type: "normal" },
          { name: "newCol", display_name: "New", active: true, visibility_type: "normal" },
        ],
      },
      {
        name: "ads_other",
        schema: "gather",
        fields: [{ name: "id", active: true }, { name: "eventAt", active: true, base_type: "type/DateTime" }],
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
assert.equal(parsed.tables.length, 3);
const watch = parsed.tables.find((t) => t.name === "elt_watch_detail")!;
assert.deepEqual(
  watch.fields.map((f) => f.name).sort(),
  ["channel", "guid", "lastWatchTime", "newCol", "watchSecond"],
);
assert.equal(watch.fields.some((f) => f.name === "ghostHidden"), false);

const pack = loadAnalyticsPack("watch-detail");
assert.equal(packTimeField(pack), "lastWatchTime");
const applied = applyCatalogToPack(pack, parsed, "metabase");
assert.equal(applied.pack.tables[0]!.fieldTypes?.lastWatchTime, "type/DateTime");
assert.ok(applied.pack.tables[0]!.fields.includes("newCol"));
assert.ok(applied.pack.tables[0]!.fields.includes("lastWatchTime"));
assert.ok(applied.notes.some((n) => n.startsWith("catalog_field_diff:elt_watch_detail")));
assert.equal(applied.pack.catalog?.tableCount, 3);
assert.deepEqual(applied.pack.catalog?.schemas, ["film_report", "gather"]);
assert.equal(applied.pack.catalog?.answerableCount, 2);
assert.ok(applied.pack.warehouse?.tables.some((t) => t.name === "ads_other"));
assert.ok(!applied.pack.warehouse?.tables.some((t) => t.name === "elt_user_full_tmp"));

const facts = formatCatalogFacts(applied.pack, applied.notes);
assert.match(String(facts), /3 tables/);
assert.match(String(facts), /2 answerable/);
assert.match(String(facts), /live metadata/);

assert.deepEqual(diffTableFields(["a", "b"], ["b", "c"]), { added: ["c"], removed: ["a"] });

assert.deepEqual(
  unmodeledTablesNamedInNl("看一下 ads_other 昨天", parsed, applied.pack),
  [],
);
assert.deepEqual(
  unmodeledTablesNamedInNl("elt_user_full_tmp 有多少用户", parsed, applied.pack),
  ["elt_user_full_tmp"],
);
assert.deepEqual(unmodeledTablesNamedInNl("IndiaA 观看人数", parsed, applied.pack), []);
assert.deepEqual(unmodeledTablesNamedInNl("看 upload_foo 昨天", parsed, applied.pack), ["upload_foo"]);

const missingTime = parseMetabaseDatabaseMetadata(
  {
    tables: [
      {
        name: "elt_watch_detail",
        schema: "film_report",
        fields: [{ name: "channel", active: true }],
      },
    ],
  },
  2,
);
const broken = applyCatalogToPack(pack, missingTime, "metabase");
assert.ok(broken.notes.some((n) => n.includes("catalog_missing_compile_fields")));

console.log("analytics-catalog.test.ts OK");
