import assert from "node:assert/strict";
import { verifyGrainDay, verifyNamedChannel, splitSqls } from "../src/analytics/verify.js";

// ---- verifyGrainDay ----
{
  const nl = "八月二十到二十一印度A按天观看人数";
  const okSql =
    "SELECT toDate(lastWatchTime) AS d, uniq(guid) AS users FROM elt_watch_detail WHERE channel='IndiaA' GROUP BY d";
  assert.deepEqual(verifyGrainDay(nl, okSql), []);

  const noToDate =
    "SELECT lastWatchTime AS d, uniq(guid) AS users FROM elt_watch_detail GROUP BY d";
  assert.ok(verifyGrainDay(nl, noToDate).includes("missing_day_grain_toDate"));

  const noGroupBy =
    "SELECT toDate(lastWatchTime) AS d, uniq(guid) AS users FROM elt_watch_detail";
  assert.ok(verifyGrainDay(nl, noGroupBy).includes("missing_day_grain_group_by"));

  const noDayNl = "八月二十到二十一印度A观看人数";
  assert.deepEqual(verifyGrainDay(noDayNl, noGroupBy), []);
}

// ---- verifyNamedChannel ----
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

  const gogoNl = "GoGo和印度A对照";
  assert.deepEqual(verifyNamedChannel(gogoNl, missingChannel), []);
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
  assert.match(parts[0], /IndiaA/i);
  assert.match(parts[1], /FoxA/i);
}

console.log("analytics-verify.test.ts OK");
