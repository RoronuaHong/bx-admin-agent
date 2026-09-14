/**
 * analytics scan cron scheduler unit tests (pure gate + injected enqueue).
 * Run: tsx scripts/analytics-scan-scheduler.test.ts
 */
import assert from "node:assert/strict";
import {
  parseScanCronHhmm,
  resetScanSchedulerForTests,
  shouldFireDailyScan,
  tickScanCron,
} from "../src/analytics/scan/scheduler.js";

resetScanSchedulerForTests();

{
  assert.deepEqual(parseScanCronHhmm("10:00"), { hour: 10, minute: 0 });
  assert.deepEqual(parseScanCronHhmm("9:05"), { hour: 9, minute: 5 });
  assert.deepEqual(parseScanCronHhmm("bad"), { hour: 10, minute: 0 });
  assert.deepEqual(parseScanCronHhmm("25:00"), { hour: 10, minute: 0 });
}

{
  const tz = "Asia/Shanghai";
  const before = shouldFireDailyScan({
    clock: new Date("2026-09-14T09:59:00+08:00"),
    tz,
    hhmm: "10:00",
    lastFiredYmd: "",
  });
  assert.equal(before.fire, false);
  assert.equal(before.fireKey, "2026-09-14");

  const onTime = shouldFireDailyScan({
    clock: new Date("2026-09-14T10:00:00+08:00"),
    tz,
    hhmm: "10:00",
    lastFiredYmd: "",
  });
  assert.equal(onTime.fire, true);

  const already = shouldFireDailyScan({
    clock: new Date("2026-09-14T10:01:00+08:00"),
    tz,
    hhmm: "10:00",
    lastFiredYmd: "2026-09-14",
  });
  assert.equal(already.fire, false);

  const nextDay = shouldFireDailyScan({
    clock: new Date("2026-09-15T10:00:00+08:00"),
    tz,
    hhmm: "10:00",
    lastFiredYmd: "2026-09-14",
  });
  assert.equal(nextDay.fire, true);
  assert.equal(nextDay.fireKey, "2026-09-15");
}

{
  resetScanSchedulerForTests();
  const seen: Array<{ digest?: boolean; ruleSetId: string }> = [];
  const first = await tickScanCron({
    clock: new Date("2026-09-14T10:05:00+08:00"),
    tz: "Asia/Shanghai",
    hhmm: "10:00",
    lastFiredYmd: "",
    persist: false,
    enqueue: async (input) => {
      seen.push({ digest: input.digest, ruleSetId: input.ruleSetId });
      return { jobId: "job-1" };
    },
  });
  assert.equal(first.fired, true);
  assert.equal(first.jobId, "job-1");
  assert.deepEqual(seen, [{ digest: true, ruleSetId: "watch-users" }]);

  const second = await tickScanCron({
    clock: new Date("2026-09-14T11:00:00+08:00"),
    tz: "Asia/Shanghai",
    hhmm: "10:00",
    persist: false,
    enqueue: async () => ({ jobId: "job-2" }),
  });
  assert.equal(second.fired, false);
}

resetScanSchedulerForTests();
console.log("analytics-scan-scheduler.test.ts OK");
