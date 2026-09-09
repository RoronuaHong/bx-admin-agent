import assert from "node:assert/strict";
import { loadRuleset } from "../src/analytics/scan/ruleset.js";
import { resolveScanWindow } from "../src/analytics/scan/window.js";

{
  const w = resolveScanWindow({
    clock: new Date("2026-09-09T12:00:00+08:00"),
    tz: "Asia/Shanghai",
  });
  assert.equal(w.scanDate, "2026-09-08");
  assert.equal(w.dodDate, "2026-09-07");
  assert.equal(w.wowDate, "2026-09-01");
  assert.match(w.echo, /2026-09-08/);
}

{
  const w = resolveScanWindow({
    clock: new Date("2026-09-09T12:00:00+08:00"),
    tz: "Asia/Shanghai",
    scanDate: "2026-08-20",
  });
  assert.equal(w.scanDate, "2026-08-20");
  assert.equal(w.dodDate, "2026-08-19");
  assert.equal(w.wowDate, "2026-08-13");
}

{
  const rs = loadRuleset("watch-users");
  assert.equal(rs.id, "watch-users");
  assert.deepEqual(rs.metrics, ["channel_daily_users"]);
  assert.deepEqual(rs.baselines, ["dod", "wow"]);
  assert.equal(rs.baselineLogic, "any");
  assert.equal(rs.thresholdRatio, 0.9);
  assert.equal(rs.minAbsDelta, 0);
  assert.equal(rs.minSample, 100);
  assert.equal(rs.criticalEntityCount, 3);
  assert.equal(rs.dimensions.rollup, "channel");
  assert.equal(rs.maxChildAlerts, 5);
  assert.equal(rs.businessTimezone, "Asia/Shanghai");
  assert.equal(rs.jobTimeoutMs, 600000);
  assert.equal(rs.freshnessCheck.type, "max_business_date");
  assert.equal(rs.freshnessCheck.table, "elt_watch_detail");
  assert.equal(rs.freshnessCheck.column, "lastWatchTime");
  assert.equal(rs.packId, "watch-detail");
  assert.equal(rs.persistCard, false);
}

console.log("analytics-scan-window.test.ts OK");
