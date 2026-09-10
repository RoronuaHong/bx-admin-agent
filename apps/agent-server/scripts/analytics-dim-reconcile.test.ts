/**
 * dim-reconcile unit tests (re-exports shared extractNamedEntities).
 * Run: tsx scripts/analytics-dim-reconcile.test.ts
 */
import assert from "node:assert/strict";
import { extractNamedEntities, reconcileNamedDimensions } from "../src/analytics/dim-reconcile.js";

{
  const named = extractNamedEntities("八月二十到二十一印度A按天观看人数，同时FoxA按语言");
  assert.ok(named.includes("印度A"));
  assert.ok(named.includes("FoxA"));
}

{
  const r = reconcileNamedDimensions({
    nl: "IndiaA 和 FoxA 对照",
    tables: [{ cols: ["channel", "users"], rows: [["IndiaA", 1]] }],
    sqls: ["SELECT ... WHERE channel='IndiaA'"],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["FoxA"]);
}

{
  const r = reconcileNamedDimensions({
    nl: "印度A按天",
    tables: [{ cols: ["d", "users"], rows: [["2026-08-20", 10]] }],
    sqls: ["SELECT toDate(lastWatchTime) d, uniq(guid) FROM t WHERE channel='IndiaA' GROUP BY d"],
  });
  assert.equal(r.ok, true);
}

{
  const r = reconcileNamedDimensions({
    nl: "IndiaA 和 FoxA",
    tables: [
      { cols: ["d"], rows: [["2026-08-20"]] },
      { cols: ["lang"], rows: [["te"]] },
    ],
    sqls: [
      "SELECT ... WHERE channel='IndiaA'",
      "SELECT ... WHERE channel='FoxA'",
    ],
  });
  assert.equal(r.ok, true);
}

console.log("analytics-dim-reconcile.test.ts OK");
