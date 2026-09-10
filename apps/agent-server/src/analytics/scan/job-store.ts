/**
 * In-memory scan job state machine (M3 Task 2).
 * Map hangs on globalThis so tsx double-load shares state (same pattern as alert-notify dedup).
 */

import { randomUUID } from "node:crypto";
import type { ScanJob, ScanJobStatus } from "./types.js";

export const SCAN_JOB_RUNNING = "scan_job_running";
export const SCAN_JOB_TIMEOUT = "scan_job_timeout";

export class ScanJobStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ScanJobStoreError";
    this.code = code;
  }
}

type JobMap = Map<string, ScanJob>;

const g = globalThis as unknown as { __bxAnalyticsScanJobs?: JobMap };

function jobMap(): JobMap {
  // 挂 globalThis：避免 tsx 双实例加载时 reset 与 store 各用一份 Map
  if (!g.__bxAnalyticsScanJobs) g.__bxAnalyticsScanJobs = new Map();
  return g.__bxAnalyticsScanJobs;
}

function jobKey(scanDate: string, ruleSetId: string): string {
  return `${scanDate}|${ruleSetId}`;
}

function isoNow(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

const TERMINAL: ReadonlySet<ScanJobStatus> = new Set([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "skipped",
]);

export interface CreateScanJobInput {
  ruleSetId: string;
  scanDate: string;
  dryRun?: boolean;
  forceRerun?: boolean;
  /** Injected clock for tests. */
  now?: Date;
}

export function createJob(input: CreateScanJobInput): ScanJob {
  const { ruleSetId, scanDate } = input;
  const dryRun = input.dryRun === true;
  const forceRerun = input.forceRerun === true;
  const map = jobMap();
  const key = jobKey(scanDate, ruleSetId);

  for (const job of map.values()) {
    if (
      job.scanDate === scanDate &&
      job.ruleSetId === ruleSetId &&
      (job.status === "running" || job.status === "queued")
    ) {
      if (!forceRerun) {
        throw new ScanJobStoreError(
          SCAN_JOB_RUNNING,
          `scan job already ${job.status} for ${key}`,
        );
      }
      break;
    }
  }

  let rerunSeq = 0;
  if (forceRerun) {
    let maxSeq = 0;
    let found = false;
    for (const job of map.values()) {
      if (job.scanDate === scanDate && job.ruleSetId === ruleSetId) {
        found = true;
        if (job.rerunSeq > maxSeq) maxSeq = job.rerunSeq;
      }
    }
    rerunSeq = found ? maxSeq + 1 : 1;
  }

  const ts = isoNow(input.now);
  const job: ScanJob = {
    jobId: randomUUID(),
    ruleSetId,
    scanDate,
    status: "queued",
    dryRun,
    forceRerun,
    rerunSeq,
    createdAt: ts,
    updatedAt: ts,
  };
  map.set(job.jobId, job);
  return { ...job };
}

export interface TransitionPatch {
  errorCode?: string;
  errorMessage?: string;
  resultSummary?: ScanJob["resultSummary"];
  alerts?: ScanJob["alerts"];
  startedAt?: string;
  finishedAt?: string;
  /** Injected clock for tests. */
  now?: Date;
}

export function transition(
  jobId: string,
  status: ScanJobStatus,
  patch?: TransitionPatch,
): ScanJob {
  const map = jobMap();
  const prev = map.get(jobId);
  if (!prev) {
    throw new ScanJobStoreError("scan_job_not_found", `scan job not found: ${jobId}`);
  }

  // Do not revive a terminal job (e.g. timeout failed → late succeeded).
  if (TERMINAL.has(prev.status) && prev.status !== status) {
    return { ...prev };
  }

  const ts = isoNow(patch?.now);
  const next: ScanJob = {
    ...prev,
    status,
    updatedAt: ts,
  };

  if (status === "running" && !next.startedAt) {
    next.startedAt = patch?.startedAt ?? ts;
  } else if (patch?.startedAt !== undefined) {
    next.startedAt = patch.startedAt;
  }

  if (TERMINAL.has(status)) {
    next.finishedAt = patch?.finishedAt ?? ts;
  } else if (patch?.finishedAt !== undefined) {
    next.finishedAt = patch.finishedAt;
  }

  if (patch?.errorCode !== undefined) next.errorCode = patch.errorCode;
  if (patch?.errorMessage !== undefined) next.errorMessage = patch.errorMessage;
  if (patch?.resultSummary !== undefined) next.resultSummary = patch.resultSummary;
  if (patch?.alerts !== undefined) next.alerts = patch.alerts;

  map.set(jobId, next);
  return { ...next };
}

export function getJob(jobId: string): ScanJob | undefined {
  const job = jobMap().get(jobId);
  return job ? { ...job } : undefined;
}

export interface ListJobsOpts {
  limit?: number;
}

export function listJobs(opts?: ListJobsOpts): ScanJob[] {
  const all = [...jobMap().values()].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );
  const limit = opts?.limit;
  const slice = typeof limit === "number" && limit >= 0 ? all.slice(0, limit) : all;
  return slice.map((j) => ({ ...j }));
}

export const DEFAULT_SCAN_RETENTION_DAYS = 30;

/**
 * Drop terminal jobs whose createdAt is older than retentionDays.
 * Returns number of jobs removed. Queued/running are kept.
 */
export function purgeJobsOlderThan(
  retentionDays: number = DEFAULT_SCAN_RETENTION_DAYS,
  now: Date | number = new Date(),
): number {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days < 0) return 0;
  const nowMs = typeof now === "number" ? now : now.getTime();
  const cutoff = nowMs - days * 86_400_000;
  const map = jobMap();
  let removed = 0;
  for (const [id, job] of map) {
    if (!TERMINAL.has(job.status)) continue;
    const created = Date.parse(job.createdAt);
    if (!Number.isFinite(created) || created >= cutoff) continue;
    map.delete(id);
    removed += 1;
  }
  return removed;
}

/**
 * If job is still running past jobTimeoutMs from startedAt, mark failed with scan_job_timeout.
 * Returns the (possibly updated) job, or undefined if missing.
 */
export function markTimeoutIfNeeded(
  jobId: string,
  jobTimeoutMs: number,
  now: Date | number = new Date(),
): ScanJob | undefined {
  const job = jobMap().get(jobId);
  if (!job) return undefined;
  if (job.status !== "running" || !job.startedAt) return { ...job };

  const nowMs = typeof now === "number" ? now : now.getTime();
  const startedMs = Date.parse(job.startedAt);
  if (!Number.isFinite(startedMs) || nowMs - startedMs < jobTimeoutMs) {
    return { ...job };
  }

  return transition(jobId, "failed", {
    errorCode: SCAN_JOB_TIMEOUT,
    errorMessage: "scan job timed out (巡检未跑成)",
    now: new Date(nowMs),
  });
}

export function resetJobStoreForTests(): void {
  jobMap().clear();
}
