/**
 * Scan job orchestration (M3 Task 6): enqueue → freshness → metrics → threshold → notify.
 */

import {
  SCAN_JOB_RUNNING,
  SCAN_JOB_TIMEOUT,
  ScanJobStoreError,
  createJob,
  getJob,
  listJobs,
  markTimeoutIfNeeded,
  transition,
  type ListJobsOpts,
} from "./job-store.js";
import { notifyAlerts } from "../../alert-notify.js";
import { checkFreshness } from "./freshness.js";
import { fetchChannelDailyUsers } from "./metrics.js";
import { notifyScanAlerts } from "./notify.js";
import { loadRuleset } from "./ruleset.js";
import { evaluateThreshold } from "./threshold.js";
import { resolveScanWindow } from "./window.js";
import type { RuleSet, ScanAlert, ScanJob } from "./types.js";

export type ScanDeps = {
  checkFreshness?: typeof checkFreshness;
  fetchChannelDailyUsers?: typeof fetchChannelDailyUsers;
  notifyScanAlerts?: typeof notifyScanAlerts;
};

export type EnqueueScanInput = {
  ruleSetId: string;
  scanDate?: string;
  forceRerun?: boolean;
  dryRun?: boolean;
  /** Injected clock for window resolution / tests. */
  clock?: Date;
  deps?: EnqueueDeps;
};

export type EnqueueDeps = ScanDeps & {
  /**
   * Background runner hook. Default: fire-and-forget `processJob`.
   * Tests may inject a no-op or an awaitable wrapper.
   */
  runInBackground?: (jobId: string, deps?: ScanDeps) => void;
};

function buildAlerts(
  ruleSet: RuleSet,
  metric: string,
  threshold: ReturnType<typeof evaluateThreshold>,
): ScanAlert[] | undefined {
  if (!threshold.severity) return undefined;
  const alerts: ScanAlert[] = [
    {
      severity: threshold.severity,
      metric,
      message: threshold.parentMessage,
      parent: true,
    },
  ];
  for (const child of threshold.children) {
    alerts.push({
      severity: threshold.severity === "critical" ? "warn" : threshold.severity,
      metric,
      entityKey: child.entityKey,
      baseline: child.baseline,
      message: child.message,
    });
  }
  return alerts;
}

/**
 * Process a queued job asynchronously. Safe to call without awaiting from enqueue.
 */
export async function processJob(jobId: string, deps?: ScanDeps): Promise<void> {
  const job = getJob(jobId);
  if (!job) return;

  const checkFr = deps?.checkFreshness ?? checkFreshness;
  const fetchUsers = deps?.fetchChannelDailyUsers ?? fetchChannelDailyUsers;
  const notify = deps?.notifyScanAlerts ?? notifyScanAlerts;

  let ruleSet: RuleSet | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  try {
    transition(jobId, "running");
    ruleSet = loadRuleset(job.ruleSetId);
    const window = resolveScanWindow({
      clock: new Date(),
      tz: ruleSet.businessTimezone,
      scanDate: job.scanDate,
    });

    watchdog = setTimeout(() => {
      const cur = getJob(jobId);
      if (!cur || cur.status !== "running") return;
      transition(jobId, "failed", {
        errorCode: SCAN_JOB_TIMEOUT,
        errorMessage: "巡检未跑成：超过 jobTimeout",
      });
      if (job.dryRun) return;
      void notifyAlerts({
        kind: "analytics",
        title: "[bx-agent] 数据分析巡检",
        messages: [
          `运维：巡检未跑成 scan_job_timeout ruleSet=${job.ruleSetId} scanDate=${job.scanDate} jobId=${jobId}`,
        ],
      });
    }, Math.max(1, ruleSet.jobTimeoutMs));

    markTimeoutIfNeeded(jobId, ruleSet.jobTimeoutMs);
    if (getJob(jobId)?.status === "failed") return;

    const freshness = await checkFr(ruleSet, window.scanDate);
    if (getJob(jobId)?.status === "failed") return;
    if (!freshness.ok) {
      transition(jobId, "skipped", {
        errorCode: "data_not_ready",
        errorMessage: freshness.reason || "data_not_ready",
        resultSummary: {
          skippedReason: freshness.reason || "data_not_ready",
          maxDate: freshness.maxDate,
        },
      });
      return;
    }

    markTimeoutIfNeeded(jobId, ruleSet.jobTimeoutMs);
    if (getJob(jobId)?.status === "failed") return;

    const metric = ruleSet.metrics[0] || "channel_daily_users";
    const rows = await fetchUsers(window.scanDate, window.dodDate, window.wowDate, {
      packId: ruleSet.packId,
    });
    if (getJob(jobId)?.status === "failed") return;

    const threshold = evaluateThreshold(ruleSet, rows);
    const alerts = buildAlerts(ruleSet, metric, threshold);
    const warnCount =
      threshold.severity === "warn" || threshold.severity === "critical"
        ? threshold.children.length
        : 0;
    const criticalCount = threshold.severity === "critical" ? 1 : 0;

    transition(jobId, "succeeded", {
      alerts,
      resultSummary: {
        entityCount: rows.length,
        warnCount,
        criticalCount,
        quietReasonCount: threshold.quietReasons.length,
        severity: threshold.severity,
        parentMessage: threshold.parentMessage,
      },
    });

    if (!job.dryRun && getJob(jobId)?.status === "succeeded") {
      await notify({
        ruleSetId: ruleSet.id,
        scanDate: window.scanDate,
        metric,
        rerunSeq: job.rerunSeq,
        dryRun: false,
        threshold,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      transition(jobId, "failed", {
        errorCode: "scan_failed",
        errorMessage: message,
      });
    } catch {
      /* job may already be terminal */
    }
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
}

/**
 * Create a scan job and kick off background processing. Does not await processJob.
 */
export async function enqueueScan(
  input: EnqueueScanInput,
): Promise<{ jobId: string } | { error: string }> {
  try {
    const ruleSet = loadRuleset(input.ruleSetId);
    const window = resolveScanWindow({
      clock: input.clock ?? new Date(),
      tz: ruleSet.businessTimezone,
      scanDate: input.scanDate,
    });

    const job = createJob({
      ruleSetId: ruleSet.id,
      scanDate: window.scanDate,
      dryRun: input.dryRun === true,
      forceRerun: input.forceRerun === true,
      now: input.clock,
    });

    const deps = input.deps;
    const runBg =
      deps?.runInBackground ??
      ((id: string, d?: ScanDeps) => {
        void processJob(id, d);
      });
    runBg(job.jobId, deps);

    return { jobId: job.jobId };
  } catch (err) {
    if (err instanceof ScanJobStoreError && err.code === SCAN_JOB_RUNNING) {
      return { error: SCAN_JOB_RUNNING };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}

export function getScanJob(jobId: string): ScanJob | undefined {
  return getJob(jobId);
}

export function listScanJobs(opts?: ListJobsOpts): ScanJob[] {
  return listJobs(opts);
}
