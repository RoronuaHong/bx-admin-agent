/**
 * analytics scan runner unit tests (injectable deps; no Metabase).
 * Run: tsx scripts/analytics-scan-runner-unit.test.ts
 */
import assert from "node:assert/strict";
import {
  createJob,
  getJob,
  resetJobStoreForTests,
  transition,
} from "../src/analytics/scan/job-store.js";
import {
  enqueueScan,
  getScanJob,
  listScanJobs,
  processJob,
  type ScanDeps,
} from "../src/analytics/scan/runner.js";
import type { FreshnessResult } from "../src/analytics/scan/freshness.js";
import type { ChannelDailyUserRow } from "../src/analytics/scan/metrics.js";
import type { NotifyScanAlertsResult } from "../src/analytics/scan/notify.js";
import type { RuleSet } from "../src/analytics/scan/types.js";

resetJobStoreForTests();

{
  // enqueue creates queued job and does not await processJob
  const seen: string[] = [];
  const result = await enqueueScan({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    dryRun: true,
    clock: new Date("2026-09-09T12:00:00+08:00"),
    deps: {
      runInBackground: (jobId) => {
        seen.push(jobId);
      },
    },
  });
  assert.ok("jobId" in result, `expected jobId, got ${JSON.stringify(result)}`);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], result.jobId);
  const job = getScanJob(result.jobId);
  assert.ok(job);
  assert.equal(job!.status, "queued");
  assert.equal(job!.dryRun, true);
  assert.equal(job!.scanDate, "2026-09-08");
  assert.equal(job!.ruleSetId, "watch-users");
}

{
  // scan_job_running when same date+ruleset already running (no forceRerun)
  resetJobStoreForTests();
  const first = createJob({ ruleSetId: "watch-users", scanDate: "2026-09-08" });
  transition(first.jobId, "running");
  const result = await enqueueScan({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    deps: { runInBackground: () => {} },
  });
  assert.deepEqual(result, { error: "scan_job_running" });
}

{
  // skipped path: freshness not ok → no metrics / threshold / notify
  resetJobStoreForTests();
  const job = createJob({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    dryRun: true,
  });

  let fetchCalled = false;
  let notifyCalled = false;
  const deps: ScanDeps = {
    checkFreshness: async (_ruleSet: RuleSet, _scanDate: string): Promise<FreshnessResult> => ({
      ok: false,
      maxDate: "2026-09-07",
      reason: "data_not_ready",
    }),
    fetchChannelDailyUsers: async () => {
      fetchCalled = true;
      return [] as ChannelDailyUserRow[];
    },
    notifyScanAlerts: async () => {
      notifyCalled = true;
      return { sent: 0 } as NotifyScanAlertsResult;
    },
  };

  await processJob(job.jobId, deps);
  const done = getJob(job.jobId);
  assert.ok(done);
  assert.equal(done!.status, "skipped");
  assert.equal(done!.errorCode, "data_not_ready");
  assert.equal(done!.resultSummary?.skippedReason, "data_not_ready");
  assert.equal(fetchCalled, false);
  assert.equal(notifyCalled, false);
}

{
  // dryRun + freshness ok: evaluates threshold, skips notify
  resetJobStoreForTests();
  const job = createJob({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    dryRun: true,
  });

  let notifyCalled = false;
  const rows: ChannelDailyUserRow[] = [
    {
      entityKey: "ch-a",
      scanValue: 200,
      dodValue: 250,
      wowValue: 260,
      sample: 200,
    },
  ];
  await processJob(job.jobId, {
    checkFreshness: async () => ({ ok: true, maxDate: "2026-09-08" }),
    fetchChannelDailyUsers: async () => rows,
    notifyScanAlerts: async () => {
      notifyCalled = true;
      return { sent: 1 };
    },
  });
  const done = getJob(job.jobId);
  assert.ok(done);
  assert.equal(done!.status, "succeeded");
  assert.equal(notifyCalled, false, "dryRun must not call notifyScanAlerts");
  assert.ok((done!.resultSummary?.entityCount as number) >= 1);
}

{
  // non-dryRun notifies with rerunSeq from job
  resetJobStoreForTests();
  const job = createJob({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    forceRerun: true,
  });
  // forceRerun with no prior jobs → rerunSeq 1
  assert.equal(job.rerunSeq, 1);

  let seenRerun: number | undefined;
  await processJob(job.jobId, {
    checkFreshness: async () => ({ ok: true, maxDate: "2026-09-08" }),
    fetchChannelDailyUsers: async () => [
      {
        entityKey: "ch-a",
        scanValue: 50,
        dodValue: 200,
        wowValue: 200,
        sample: 50,
      },
    ],
    notifyScanAlerts: async (opts) => {
      seenRerun = opts.rerunSeq;
      return { sent: 0, skipped: true };
    },
  });
  const done = getJob(job.jobId);
  assert.equal(done!.status, "succeeded");
  // sample 50 < minSample 100 → quiet/info → notify may still be called; rerunSeq must match
  assert.equal(seenRerun, 1);
}

{
  // list/get wrappers
  resetJobStoreForTests();
  const a = createJob({ ruleSetId: "watch-users", scanDate: "2026-09-08" });
  assert.equal(getScanJob(a.jobId)?.jobId, a.jobId);
  assert.equal(listScanJobs({ limit: 10 }).length, 1);
}

console.log("analytics-scan-runner-unit: ok");
