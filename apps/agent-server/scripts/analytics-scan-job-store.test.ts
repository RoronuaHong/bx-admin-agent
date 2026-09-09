/**
 * analytics scan job-store 单元闸门（零外部依赖）。
 * 运行：tsx scripts/analytics-scan-job-store.test.ts
 */
import assert from "node:assert/strict";
import {
  SCAN_JOB_RUNNING,
  SCAN_JOB_TIMEOUT,
  ScanJobStoreError,
  createJob,
  getJob,
  markTimeoutIfNeeded,
  resetJobStoreForTests,
  transition,
} from "../src/analytics/scan/job-store.js";

resetJobStoreForTests();

{
  const job = createJob({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    dryRun: true,
  });
  assert.equal(job.status, "queued");
  assert.equal(job.dryRun, true);
  assert.equal(job.forceRerun, false);
  assert.equal(job.rerunSeq, 0);
  const got = getJob(job.jobId);
  assert.ok(got);
  assert.equal(got!.jobId, job.jobId);
  assert.equal(got!.ruleSetId, "watch-users");
  assert.equal(got!.scanDate, "2026-09-08");
}

{
  resetJobStoreForTests();
  const first = createJob({ ruleSetId: "watch-users", scanDate: "2026-09-08" });
  transition(first.jobId, "running");
  let threw: unknown;
  try {
    createJob({ ruleSetId: "watch-users", scanDate: "2026-09-08" });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw instanceof ScanJobStoreError);
  assert.equal((threw as ScanJobStoreError).code, SCAN_JOB_RUNNING);
}

{
  resetJobStoreForTests();
  createJob({ ruleSetId: "watch-users", scanDate: "2026-09-08" }); // stays queued
  let threwQueued: unknown;
  try {
    createJob({ ruleSetId: "watch-users", scanDate: "2026-09-08" });
  } catch (e) {
    threwQueued = e;
  }
  assert.ok(threwQueued instanceof ScanJobStoreError);
  assert.equal((threwQueued as ScanJobStoreError).code, SCAN_JOB_RUNNING);
}

{
  resetJobStoreForTests();
  const first = createJob({ ruleSetId: "watch-users", scanDate: "2026-09-08" });
  assert.equal(first.rerunSeq, 0);
  transition(first.jobId, "running");
  const second = createJob({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    forceRerun: true,
  });
  assert.equal(second.forceRerun, true);
  assert.equal(second.rerunSeq, 1);
  const third = createJob({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    forceRerun: true,
  });
  assert.equal(third.rerunSeq, 2);
}

{
  resetJobStoreForTests();
  const t0 = new Date("2026-09-09T10:00:00.000Z");
  const job = createJob({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    now: t0,
  });
  transition(job.jobId, "running", { now: t0 });
  const still = markTimeoutIfNeeded(job.jobId, 10 * 60 * 1000, t0.getTime() + 60_000);
  assert.equal(still?.status, "running");
  const timed = markTimeoutIfNeeded(
    job.jobId,
    10 * 60 * 1000,
    t0.getTime() + 10 * 60 * 1000,
  );
  assert.equal(timed?.status, "failed");
  assert.equal(timed?.errorCode, SCAN_JOB_TIMEOUT);
  assert.match(timed?.errorMessage ?? "", /巡检未跑成/);
}

{
  resetJobStoreForTests();
  const job = createJob({ ruleSetId: "watch-users", scanDate: "2026-09-08" });
  transition(job.jobId, "failed", { errorCode: "scan_job_timeout", errorMessage: "timeout" });
  const revived = transition(job.jobId, "succeeded", {
    resultSummary: { entityCount: 1 },
  });
  assert.equal(revived.status, "failed");
  assert.equal(revived.errorCode, "scan_job_timeout");
}

console.log("analytics-scan-job-store.test.ts OK");
