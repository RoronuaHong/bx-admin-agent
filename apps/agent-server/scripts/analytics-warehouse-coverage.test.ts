/**
 * Warehouse coverage GATE (independent of EX).
 * Run: tsx scripts/analytics-warehouse-coverage.test.ts
 */
import assert from "node:assert/strict";
import type { AnalyticsCatalog, CatalogTable } from "../src/analytics/catalog.js";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";
import {
  evaluateWarehouseCoverage,
  formatWarehouseCoverage,
  loadWarehouseCoverageSpec,
} from "../src/analytics/warehouse-coverage.js";

const spec = loadWarehouseCoverageSpec();
const pack = loadAnalyticsPack("watch-detail");

function table(name: string, fields: string[], hidden = false): CatalogTable {
  return {
    schema: hidden ? "metabase_upload" : "film_report",
    name,
    fields: fields.map((f) => ({ name: f })),
  };
}

function fakeCatalog(opts?: {
  overlayFieldN?: number;
  extraAnswerable?: string;
  dropHidden?: string;
  dropExpansion?: string;
}): AnalyticsCatalog {
  const overlayFields = Array.from(
    { length: opts?.overlayFieldN ?? spec.overlay.liveActiveFields },
    (_, i) => (i < spec.overlay.declaredFields.length ? spec.overlay.declaredFields[i]! : `live_${i}`),
  );
  const names = new Set<string>();
  const tables: CatalogTable[] = [];
  for (const row of spec.expansion) {
    if (opts?.dropExpansion === row.table) continue;
    names.add(row.table);
    tables.push(
      table(
        row.table,
        row.table === spec.overlay.table ? overlayFields : ["id", "createdTime"],
      ),
    );
  }
  for (const name of spec.catalog.hiddenNames) {
    if (opts?.dropHidden === name) continue;
    names.add(name);
    tables.push(table(name, ["id"], true));
  }
  let n = 0;
  while (tables.filter((t) => t.schema !== "metabase_upload" && !/_tmp$|_dict$/.test(t.name)).length < spec.catalog.answerable) {
    const name = `pad_table_${n++}`;
    if (names.has(name)) continue;
    names.add(name);
    tables.push(table(name, ["id"]));
  }
  if (opts?.extraAnswerable) tables.push(table(opts.extraAnswerable, ["id"]));
  return { databaseId: spec.databaseId, fetchedAt: 1, tables };
}

{
  const r = evaluateWarehouseCoverage({ catalog: null });
  assert.equal(r.source, "pack_only");
  assert.equal(r.pass, true, r.failures.join("; "));
  assert.equal(r.overlayDeclared, 8);
  assert.equal(r.overlayLiveExpected, 23);
  assert.ok(r.notes.some((n) => n.startsWith("overlay_field_gap: declared 8 / live expected 23")));
  assert.ok(formatWarehouseCoverage(r).includes("PASS"));
}

{
  const r = evaluateWarehouseCoverage({ catalog: fakeCatalog() });
  assert.equal(r.source, "catalog");
  assert.equal(r.pass, true, r.failures.join("; "));
  assert.deepEqual(r.catalog, {
    total: spec.catalog.total,
    answerable: spec.catalog.answerable,
    hidden: spec.catalog.hidden,
  });
}

{
  const badPack = {
    ...pack,
    tables: [{ ...pack.tables[0]!, fields: spec.overlay.declaredFields.slice(0, 7) }],
  };
  const r = evaluateWarehouseCoverage({ pack: badPack, catalog: null });
  assert.equal(r.pass, false);
  assert.ok(r.failures.some((f) => f.includes("overlay declared fields drifted")));
}

{
  const r = evaluateWarehouseCoverage({ catalog: fakeCatalog({ overlayFieldN: 22 }) });
  assert.equal(r.pass, false);
  assert.ok(r.failures.some((f) => f.includes("overlay live fields 22")));
}

{
  const r = evaluateWarehouseCoverage({ catalog: fakeCatalog({ extraAnswerable: "pad_overflow" }) });
  assert.equal(r.pass, false);
  assert.ok(r.failures.some((f) => f.includes("catalog total")));
}

{
  const r = evaluateWarehouseCoverage({
    catalog: fakeCatalog({ dropHidden: spec.catalog.hiddenNames[0] }),
  });
  assert.equal(r.pass, false);
  assert.ok(r.failures.some((f) => f.includes(spec.catalog.hiddenNames[0]!)));
}

{
  const r = evaluateWarehouseCoverage({ catalog: fakeCatalog({ dropExpansion: "gather_stat" }) });
  assert.equal(r.pass, false);
  assert.ok(r.failures.some((f) => f.includes("gather_stat")));
}

{
  const live = evaluateWarehouseCoverage();
  if (live.source === "catalog") {
    assert.equal(live.pass, true, live.failures.join("; "));
    assert.deepEqual(live.catalog, {
      total: spec.catalog.total,
      answerable: spec.catalog.answerable,
      hidden: spec.catalog.hidden,
    });
  } else {
    assert.equal(live.pass, true, live.failures.join("; "));
  }
}

assert.equal(spec.expansion.filter((r) => r.status === "overlay_compile").length, 1);
assert.equal(spec.expansion.filter((r) => r.status === "verified_query").length, 6);
assert.ok(spec.expansion.some((r) => r.table === "gather_stat" && r.status === "verified_query"));

console.log("analytics-warehouse-coverage.test.ts OK");
