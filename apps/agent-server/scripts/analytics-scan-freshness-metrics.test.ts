/**
 * Freshness + channel users SQL/pivot unit gates (zero Metabase network).
 * 运行：.\node_modules\.bin\tsx.cmd scripts/analytics-scan-freshness-metrics.test.ts
 */
import assert from "node:assert/strict";
import {
  buildFreshnessSql,
  checkFreshness,
  normalizeDateCell,
} from "../src/analytics/scan/freshness.js";
import {
  buildChannelUsersSql,
  fetchChannelDailyUsers,
  pivotChannelDailyUsers,
} from "../src/analytics/scan/metrics.js";
import { loadRuleset } from "../src/analytics/scan/ruleset.js";
import {
  loadAnalyticsPack,
  packDefaultEntityKey,
  packTimeField,
} from "../src/analytics/semantic-layer.js";
import { assertTablesWhitelisted, extractFromTables } from "../src/analytics/sql-guard.js";
import type { DatasetResult } from "../src/analytics/types.js";

const ruleSet = loadRuleset("watch-users");
const pack = loadAnalyticsPack(ruleSet.packId || "watch-detail");

// 标识符全部来自 config（rule set + pack），代码里不再有表名/列名默认值。
const metricSqlBase = {
  table: ruleSet.freshnessCheck.table,
  entityField: ruleSet.dimensions.rollup,
  distinctField: packDefaultEntityKey(pack),
  timeField: packTimeField(pack),
  filterField: pack.guards.defaultMovieTypesField,
  filterValues: pack.guards.defaultMovieTypes,
};

{
  const sql = buildFreshnessSql(ruleSet.freshnessCheck);
  assert.equal(sql, "SELECT max(toDate(lastWatchTime)) AS d FROM elt_watch_detail");
  assert.deepEqual(extractFromTables(sql), ["elt_watch_detail"]);
  assertTablesWhitelisted(sql, ["elt_watch_detail"]);
}

{
  assert.equal(normalizeDateCell("2026-09-08"), "2026-09-08");
  assert.equal(normalizeDateCell("2026-09-08T00:00:00Z"), "2026-09-08");
  assert.equal(normalizeDateCell(null), undefined);
}

{
  const ready = await checkFreshness(ruleSet, "2026-09-08", {
    runDataset: async () =>
      ({
        ok: true,
        cols: ["d"],
        rows: [["2026-09-08"]],
      }) satisfies DatasetResult,
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.maxDate, "2026-09-08");
}

{
  const stale = await checkFreshness(ruleSet, "2026-09-08", {
    runDataset: async () => ({
      ok: true,
      cols: ["d"],
      rows: [["2026-09-07"]],
    }),
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.maxDate, "2026-09-07");
  assert.equal(stale.reason, "data_not_ready");
}

{
  const empty = await checkFreshness(ruleSet, "2026-09-08", {
    runDataset: async () => ({
      ok: true,
      cols: ["d"],
      rows: [[null]],
    }),
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "data_not_ready");
}

{
  const failed = await checkFreshness(ruleSet, "2026-09-08", {
    runDataset: async () => ({
      ok: false,
      cols: [],
      rows: [],
      error: "boom",
    }),
  });
  assert.equal(failed.ok, false);
  assert.match(String(failed.reason), /freshness_query_failed/);
}

{
  const sql = buildChannelUsersSql({
    scanDate: "2026-09-08",
    dodDate: "2026-09-07",
    wowDate: "2026-09-01",
    ...metricSqlBase,
  });
  assert.match(sql, new RegExp(`uniq\\(${metricSqlBase.distinctField}\\)`));
  assert.match(sql, new RegExp(`GROUP BY ${metricSqlBase.entityField}, d`));
  assert.match(
    sql,
    new RegExp(`toDate\\(${metricSqlBase.timeField}\\) IN \\('2026-09-08', '2026-09-07', '2026-09-01'\\)`),
  );
  assert.match(sql, new RegExp(`${metricSqlBase.filterField} IN \\(1,2,3,4,10,11\\)`));
  assert.deepEqual(extractFromTables(sql), [metricSqlBase.table]);
  assertTablesWhitelisted(sql, [metricSqlBase.table]);
}

{
  assert.throws(
    () =>
      buildChannelUsersSql({
        ...metricSqlBase,
        scanDate: "not-a-date",
        dodDate: "2026-09-07",
        wowDate: "2026-09-01",
      }),
    /invalid scanDate/,
  );
}

{
  const pivoted = pivotChannelDailyUsers(
    [
      ["IndiaA", "2026-09-08", 1200],
      ["IndiaA", "2026-09-07", 1000],
      ["IndiaA", "2026-09-01", 1100],
      ["IndiaB", "2026-09-08", 50],
      ["IndiaB", "2026-09-07", 80],
    ],
    ["entity_key", "d", "users"],
    "2026-09-08",
    "2026-09-07",
    "2026-09-01",
  );
  assert.equal(pivoted.length, 2);
  assert.deepEqual(pivoted[0], {
    entityKey: "IndiaA",
    scanValue: 1200,
    dodValue: 1000,
    wowValue: 1100,
    sample: 1200,
  });
  assert.deepEqual(pivoted[1], {
    entityKey: "IndiaB",
    scanValue: 50,
    dodValue: 80,
    wowValue: null,
    sample: 50,
  });
}

{
  let capturedSql = "";
  const rows = await fetchChannelDailyUsers("2026-09-08", "2026-09-07", "2026-09-01", {
    table: metricSqlBase.table,
    entityField: metricSqlBase.entityField,
    runDataset: async (sql) => {
      capturedSql = sql;
      return {
        ok: true,
        cols: ["entity_key", "d", "users"],
        rows: [
          ["ChA", "2026-09-08", 200],
          ["ChA", "2026-09-07", 250],
          ["ChA", "2026-09-01", 300],
        ],
      };
    },
  });
  assert.match(capturedSql, /FROM elt_watch_detail/);
  assert.match(capturedSql, /movieType IN \(1,2,3,4,10,11\)/);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.entityKey, "ChA");
  assert.equal(rows[0]?.scanValue, 200);
  assert.equal(rows[0]?.dodValue, 250);
  assert.equal(rows[0]?.wowValue, 300);
  assert.equal(rows[0]?.sample, 200);
}

{
  await assert.rejects(
    () =>
      fetchChannelDailyUsers("2026-09-08", "2026-09-07", "2026-09-01", {
        table: metricSqlBase.table,
        entityField: metricSqlBase.entityField,
        runDataset: async () => ({
          ok: false,
          cols: [],
          rows: [],
          error: "down",
        }),
      }),
    /channel_users_query_failed/,
  );
}

console.log("analytics-scan-freshness-metrics.test.ts OK");
