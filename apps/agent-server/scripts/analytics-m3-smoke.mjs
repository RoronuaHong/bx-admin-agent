/**
 * Analytics M3 live smoke: enqueue scan (dryRun) → poll job until terminal.
 *
 * Requires apps/agent-server/.env with:
 *   ANALYTICS_SCAN_WORKER=1
 *   METABASE_USERNAME / METABASE_PASSWORD (or METABASE_USER_EMAIL)
 *
 * Optional: M3_SMOKE_NOTIFY=1 → also enqueue dryRun=false (may notify DingTalk).
 *
 * Run from apps/agent-server:
 *   .\node_modules\.bin\tsx.cmd scripts\analytics-m3-smoke.mjs
 *
 * Exit: 0 = dryRun job succeeded|skipped|partial
 *       1 = dryRun job failed (or enqueue/runtime error)
 *       2 = missing config
 */
import "dotenv/config";
import { resetJobStoreForTests } from "../src/analytics/scan/job-store.js";
import { enqueueScan, getScanJob } from "../src/analytics/scan/runner.js";

const TIMEOUT_MS = 120_000;
const POLL_MS = 500;
const TERMINAL = new Set(["succeeded", "skipped", "partial", "failed", "cancelled"]);
const OK_STATUSES = new Set(["succeeded", "skipped", "partial"]);

function hasMetabaseCreds() {
  const user = (process.env.METABASE_USERNAME || process.env.METABASE_USER_EMAIL || "").trim();
  const pass = process.env.METABASE_PASSWORD || "";
  return Boolean(user && pass);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollJob(jobId, label) {
  const started = Date.now();
  for (;;) {
    const job = getScanJob(jobId);
    if (!job) {
      return { ok: false, detail: "job missing from store", ms: Date.now() - started };
    }
    if (TERMINAL.has(job.status)) {
      const summary = job.resultSummary
        ? ` summary=${JSON.stringify(job.resultSummary)}`
        : "";
      const err =
        job.errorCode || job.errorMessage
          ? ` errorCode=${job.errorCode || ""} errorMessage=${job.errorMessage || ""}`
          : "";
      return {
        ok: OK_STATUSES.has(job.status),
        status: job.status,
        detail: `status=${job.status}${err}${summary}`,
        ms: Date.now() - started,
        job,
      };
    }
    if (Date.now() - started > TIMEOUT_MS) {
      return {
        ok: false,
        status: job.status,
        detail: `timeout after ${TIMEOUT_MS}ms still status=${job.status}`,
        ms: Date.now() - started,
        job,
      };
    }
    await sleep(POLL_MS);
  }
}

async function runEnqueue(label, opts) {
  process.stdout.write(`[analytics-m3-smoke] RUN ${label} … `);
  const started = Date.now();
  const result = await enqueueScan(opts);
  if ("error" in result) {
    console.log(`FAIL (${Date.now() - started}ms) enqueue error=${result.error}`);
    return { ok: false };
  }
  const polled = await pollJob(result.jobId, label);
  if (polled.ok) {
    console.log(`PASS (${polled.ms}ms) jobId=${result.jobId} ${polled.detail}`);
  } else {
    console.log(`FAIL (${polled.ms}ms) jobId=${result.jobId} ${polled.detail}`);
  }
  return polled;
}

async function main() {
  console.log("[analytics-m3-smoke] starting");

  if (process.env.ANALYTICS_SCAN_WORKER !== "1") {
    console.error(
      "[analytics-m3-smoke] FAIL: set ANALYTICS_SCAN_WORKER=1 in apps/agent-server/.env",
    );
    process.exit(2);
  }
  if (!hasMetabaseCreds()) {
    console.error(
      "[analytics-m3-smoke] FAIL: set METABASE_USERNAME and METABASE_PASSWORD in apps/agent-server/.env",
    );
    process.exit(2);
  }

  resetJobStoreForTests();

  // Case A: dryRun (no DingTalk)
  const dry = await runEnqueue("dryRun", {
    ruleSetId: "watch-users",
    dryRun: true,
    forceRerun: true,
  });
  if (!dry.ok) {
    process.exit(dry.status === "failed" || dry.status === "cancelled" ? 1 : 1);
  }

  // Case B: optional live notify
  if (process.env.M3_SMOKE_NOTIFY === "1") {
    resetJobStoreForTests();
    const live = await runEnqueue("notify", {
      ruleSetId: "watch-users",
      dryRun: false,
      forceRerun: true,
    });
    if (!live.ok) {
      console.error("[analytics-m3-smoke] notify case failed (dryRun already passed)");
      process.exit(1);
    }
  } else {
    console.log("[analytics-m3-smoke] SKIP notify (set M3_SMOKE_NOTIFY=1 to enqueue dryRun=false)");
  }

  console.log("[analytics-m3-smoke] DONE");
  process.exit(0);
}

main().catch((e) => {
  console.error("[analytics-m3-smoke] FAIL:", e);
  process.exit(1);
});
