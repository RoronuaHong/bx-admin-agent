/**
 * named-entities + verify + dim-reconcile unit tests (generic, no channel allow-list).
 */
import assert from "node:assert/strict";
import {
  extractNamedEntities,
  entityReferencedInSql,
  wantsMultiQuerySplit,
} from "../src/analytics/named-entities.js";
import {
  verifyGrainDay,
  verifyNamedChannel,
  verifyMultiQueryIntent,
  splitSqls,
} from "../src/analytics/verify.js";
import { reconcileNamedDimensions } from "../src/analytics/dim-reconcile.js";

{
  const named = extractNamedEntities("八月二十到二十一印度A按天观看人数，同时FoxA按语言");
  assert.ok(named.includes("印度A"), `got ${named.join(",")}`);
  assert.ok(named.includes("FoxA"), `got ${named.join(",")}`);
  assert.ok(!named.includes("同时FoxA"), `got ${named.join(",")}`);
  assert.ok(!named.some((x) => x.includes("十一")), `got ${named.join(",")}`);
}

{
  assert.equal(wantsMultiQuerySplit("各自按天"), true);
  assert.equal(wantsMultiQuerySplit("同时查"), true);
  assert.equal(wantsMultiQuerySplit("印度A按天"), false);
}

{
  assert.equal(
    entityReferencedInSql("FoxA", "SELECT 1 WHERE channel='FoxA'"),
    true,
  );
  assert.equal(
    entityReferencedInSql("印度A", "SELECT 1 WHERE channel='IndiaA'"),
    true,
  ); // CJK → requires dim filter
  assert.equal(entityReferencedInSql("印度A", "SELECT uniq(guid) FROM t"), false);
}

// ---- verifyGrainDay ----
{
  const nl = "八月二十到二十一印度A按天观看人数";
  const okSql =
    "SELECT toDate(lastWatchTime) AS d, uniq(guid) AS users FROM elt_watch_detail WHERE channel='IndiaA' GROUP BY d";
  assert.deepEqual(verifyGrainDay(nl, okSql), []);
  assert.ok(
    verifyGrainDay(nl, "SELECT lastWatchTime AS d, uniq(guid) FROM t GROUP BY d").includes(
      "missing_day_grain_toDate",
    ),
  );
  assert.deepEqual(
    verifyGrainDay(nl, "SELECT toDate(eventAt) AS d, uniq(guid) FROM t GROUP BY d", "eventAt"),
    [],
  );
}

// ---- verifyNamedChannel (generic single entity) ----
{
  const singleNl = "八月二十到二十一印度A按天观看人数";
  const withChannel = [
    "SELECT uniq(guid) FROM elt_watch_detail WHERE channel='IndiaA' AND toDate(lastWatchTime) BETWEEN '2026-08-20' AND '2026-08-21'",
  ];
  assert.deepEqual(verifyNamedChannel(singleNl, withChannel), []);

  const missingChannel = [
    "SELECT uniq(guid) FROM elt_watch_detail WHERE toDate(lastWatchTime) BETWEEN '2026-08-20' AND '2026-08-21'",
  ];
  assert.deepEqual(verifyNamedChannel(singleNl, missingChannel), ["missing_named_channel"]);

  const multiNl = "印度A和FoxA按天观看人数";
  assert.deepEqual(verifyNamedChannel(multiNl, missingChannel), []);

  const latinOnly = "FoxA按天观看人数";
  assert.deepEqual(
    verifyNamedChannel(latinOnly, ["SELECT 1 WHERE channel='FoxA'"]),
    [],
  );
  assert.deepEqual(verifyNamedChannel(latinOnly, ["SELECT 1 FROM t"]), ["missing_named_channel"]);
}

// ---- verifyMultiQueryIntent (entity count, not allow-list) ----
{
  const nl = "八月二十到二十一印度A和FoxA各自按天观看人数";
  assert.deepEqual(verifyMultiQueryIntent(nl, ["SELECT 1"]), ["need_multi_query"]);
  assert.deepEqual(
    verifyMultiQueryIntent(nl, ["SELECT 1 WHERE channel='IndiaA'", "SELECT 2 WHERE channel='FoxA'"]),
    [],
  );
  assert.deepEqual(verifyMultiQueryIntent("印度A按天", ["SELECT 1"]), []);
  // Arbitrary codes — still generic
  const other = "AlphaX和BetaY同时按语言";
  assert.deepEqual(verifyMultiQueryIntent(other, ["SELECT 1"]), ["need_multi_query"]);
}

// ---- splitSqls ----
{
  const block = [
    "SELECT toDate(lastWatchTime) AS d, uniq(guid) FROM elt_watch_detail WHERE channel='IndiaA' GROUP BY d",
    "---",
    "SELECT contentLang, uniq(guid) FROM elt_watch_detail WHERE channel='FoxA' GROUP BY contentLang",
  ].join("\n");
  const parts = splitSqls(block);
  assert.equal(parts.length, 2);
}

// ---- dim reconcile ----
{
  const r = reconcileNamedDimensions({
    nl: "IndiaA 和 FoxA 对照",
    tables: [{ cols: ["channel", "users"], rows: [["IndiaA", 1]] }],
    sqls: ["SELECT ... WHERE channel='IndiaA'"],
  });
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes("FoxA"));
}

{
  const r = reconcileNamedDimensions({
    nl: "印度A按天",
    tables: [{ cols: ["d", "users"], rows: [["2026-08-20", 10]] }],
    sqls: ["SELECT toDate(lastWatchTime) d FROM t WHERE channel='IndiaA' GROUP BY d"],
  });
  assert.equal(r.ok, true);
}

console.log("analytics-named-entities+verify+dim OK");
