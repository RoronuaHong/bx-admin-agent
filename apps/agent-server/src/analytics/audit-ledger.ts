/**
 * Analytics M2 Task 5 — thin ask ledger + feedback candidate pool.
 * V1: JSONL under .data/analytics/ (no DB). Feedback never auto-promotes to gold.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AnalyticsAskResult } from "./types.js";

export type AnalyticsFailureClass =
  | "ok"
  | "clarify"
  | "refuse"
  | "refuse_dim"
  | "refuse_verify_fail"
  | "refuse_verify_unclear"
  | "error_guard"
  | "error_exec"
  | "aborted"
  | "error"
  | "unknown";

export type AnalyticsAskLedgerEntry = {
  askId: string;
  at: number;
  atIso: string;
  nl: string;
  status: AnalyticsAskResult["status"];
  timeEcho?: string;
  sqls?: string[];
  /** lint / grain / multi-query / named-filter issues before exec (empty = pass) */
  guardIssues: string[];
  verify?: AnalyticsAskResult["verify"];
  rewriteRounds: number;
  failureClass: AnalyticsFailureClass;
  packVersion?: string;
  modelId?: string;
  runId?: string;
  ms: number;
  message?: string;
  error?: string;
};

export type FeedbackVerdict = "useful" | "wrong";

export type AnalyticsFeedbackCandidate = {
  id: string;
  askId: string;
  at: number;
  atIso: string;
  verdict: FeedbackVerdict;
  /** optional wrong-reason tags from UI */
  reasonTags: string[];
  note?: string;
  /** snapshot for review — never auto-written to seed gold */
  nl: string;
  sqls?: string[];
  status: AnalyticsAskResult["status"];
  packVersion?: string;
  modelId?: string;
  /** pending | confirmed | rejected — confirmed still does NOT write seed; ops export only */
  reviewStatus: "pending" | "confirmed" | "rejected";
};

function analyticsDataDir(): string {
  return join(process.cwd(), ".data", "analytics");
}

export function getAnalyticsLedgerDir(): string {
  return join(analyticsDataDir(), "ledger");
}

export function getAnalyticsCandidatesPath(): string {
  return join(analyticsDataDir(), "feedback-candidates.jsonl");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function newAskId(): string {
  return randomUUID();
}

export function deriveFailureClass(
  result: Pick<AnalyticsAskResult, "status" | "error" | "message" | "verify">,
  guardIssues: string[] = [],
): AnalyticsFailureClass {
  if (result.status === "ok") return "ok";
  if (result.status === "clarify") return "clarify";
  if (result.error === "aborted" || result.message === "已取消") return "aborted";
  if (result.status === "refuse") {
    if (result.error?.includes("dim_mismatch")) return "refuse_dim";
    if (result.verify?.verdict === "fail") return "refuse_verify_fail";
    if (result.verify?.verdict === "unclear") return "refuse_verify_unclear";
    return "refuse";
  }
  if (result.status === "error") {
    if (guardIssues.length || /SQL 校验/.test(result.message || "")) return "error_guard";
    if (/执行失败/.test(result.message || "")) return "error_exec";
    return "error";
  }
  return "unknown";
}

/** Append one ask ledger row (sync, fail-soft). */
export function recordAskLedger(
  entry: Omit<AnalyticsAskLedgerEntry, "at" | "atIso"> & { at?: number; atIso?: string },
): void {
  try {
    const dir = getAnalyticsLedgerDir();
    ensureDir(dir);
    const d = new Date(entry.at ?? Date.now());
    const month = d.toISOString().slice(0, 7).replace("-", "");
    const row: AnalyticsAskLedgerEntry = {
      ...entry,
      at: d.getTime(),
      atIso: d.toISOString(),
      guardIssues: entry.guardIssues || [],
      rewriteRounds: entry.rewriteRounds ?? 0,
      failureClass: entry.failureClass || "unknown",
      ms: entry.ms ?? 0,
    };
    appendFileSync(join(dir, `ask-${month}.jsonl`), JSON.stringify(row) + "\n", "utf8");
  } catch (err) {
    console.error(
      "[analytics-ledger] write failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }
}

export function submitFeedback(input: {
  askId: string;
  verdict: FeedbackVerdict;
  reasonTags?: string[];
  note?: string;
  /** optional snapshot if client still has it */
  nl?: string;
  sqls?: string[];
  status?: AnalyticsAskResult["status"];
  packVersion?: string;
  modelId?: string;
}): AnalyticsFeedbackCandidate {
  const d = new Date();
  const candidate: AnalyticsFeedbackCandidate = {
    id: randomUUID(),
    askId: input.askId,
    at: d.getTime(),
    atIso: d.toISOString(),
    verdict: input.verdict,
    reasonTags: (input.reasonTags || []).map(String).filter(Boolean).slice(0, 8),
    note: input.note?.trim().slice(0, 500) || undefined,
    nl: (input.nl || "").slice(0, 4000),
    sqls: input.sqls?.slice(0, 8),
    status: input.status || "ok",
    packVersion: input.packVersion,
    modelId: input.modelId,
    reviewStatus: "pending",
  };
  try {
    const path = getAnalyticsCandidatesPath();
    ensureDir(analyticsDataDir());
    appendFileSync(path, JSON.stringify(candidate) + "\n", "utf8");
  } catch (err) {
    console.error(
      "[analytics-feedback] write failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }
  return candidate;
}

/** List feedback candidates (newest first). Never auto-exports to gold. */
export function listFeedbackCandidates(opts?: {
  limit?: number;
  reviewStatus?: AnalyticsFeedbackCandidate["reviewStatus"];
  verdict?: FeedbackVerdict;
}): AnalyticsFeedbackCandidate[] {
  const path = getAnalyticsCandidatesPath();
  if (!existsSync(path)) return [];
  const out: AnalyticsFeedbackCandidate[] = [];
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as AnalyticsFeedbackCandidate;
        if (opts?.reviewStatus && row.reviewStatus !== opts.reviewStatus) continue;
        if (opts?.verdict && row.verdict !== opts.verdict) continue;
        out.push(row);
      } catch {
        /* skip bad line */
      }
    }
  } catch {
    return [];
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, Math.max(1, opts?.limit ?? 100));
}

/**
 * Human review of a candidate. Confirmed ≠ gold: only flips reviewStatus.
 * Gold promotion remains a separate manual export into seed (ops).
 */
export function reviewFeedbackCandidate(
  id: string,
  reviewStatus: "confirmed" | "rejected",
): AnalyticsFeedbackCandidate | null {
  const path = getAnalyticsCandidatesPath();
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split("\n");
  let found: AnalyticsFeedbackCandidate | null = null;
  const next = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const row = JSON.parse(line) as AnalyticsFeedbackCandidate;
      if (row.id !== id) return line;
      found = { ...row, reviewStatus };
      return JSON.stringify(found);
    } catch {
      return line;
    }
  });
  if (!found) return null;
  try {
    const body = next.filter((l) => l.trim().length > 0).join("\n");
    writeFileSync(path, body ? body + "\n" : "", "utf8");
  } catch (err) {
    console.error(
      "[analytics-feedback] review write failed:",
      err instanceof Error ? err.message : err,
    );
  }
  return found;
}

/** Recent ledger rows (for ops / tests). */
export function listAskLedger(opts?: { limit?: number }): AnalyticsAskLedgerEntry[] {
  try {
    purgeAskLedgerOlderThan();
  } catch {
    /* retention best-effort */
  }
  const dir = getAnalyticsLedgerDir();
  if (!existsSync(dir)) return [];
  const out: AnalyticsAskLedgerEntry[] = [];
  for (const f of readdirSync(dir).sort().reverse()) {
    if (!f.startsWith("ask-") || !f.endsWith(".jsonl")) continue;
    try {
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as AnalyticsAskLedgerEntry);
        } catch {
          /* skip */
        }
      }
    } catch {
      /* skip file */
    }
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, Math.max(1, opts?.limit ?? 100));
}

export const DEFAULT_LEDGER_RETENTION_DAYS = 30;

function ledgerRetentionDays(): number {
  const raw = Number(process.env.ANALYTICS_LEDGER_RETENTION_DAYS ?? DEFAULT_LEDGER_RETENTION_DAYS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_LEDGER_RETENTION_DAYS;
}

/**
 * Drop ask-* JSONL rows (and empty files) older than retentionDays.
 * Returns { filesRemoved, rowsDropped }.
 */
export function purgeAskLedgerOlderThan(
  retentionDays: number = ledgerRetentionDays(),
  now: Date | number = new Date(),
): { filesRemoved: number; rowsDropped: number } {
  const dir = getAnalyticsLedgerDir();
  if (!existsSync(dir)) return { filesRemoved: 0, rowsDropped: 0 };
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days < 0) return { filesRemoved: 0, rowsDropped: 0 };
  const nowMs = typeof now === "number" ? now : now.getTime();
  const cutoff = nowMs - days * 86_400_000;
  let filesRemoved = 0;
  let rowsDropped = 0;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith("ask-") || !f.endsWith(".jsonl")) continue;
    const path = join(dir, f);
    try {
      const lines = readFileSync(path, "utf8").split("\n");
      const kept: string[] = [];
      let dropped = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as AnalyticsAskLedgerEntry;
          const at = typeof row.at === "number" ? row.at : Date.parse(row.atIso || "");
          if (Number.isFinite(at) && at < cutoff) {
            dropped += 1;
            continue;
          }
          kept.push(JSON.stringify(row));
        } catch {
          kept.push(line);
        }
      }
      if (kept.length === 0 && dropped > 0) {
        unlinkSync(path);
        filesRemoved += 1;
        rowsDropped += dropped;
      } else if (dropped > 0) {
        writeFileSync(path, kept.join("\n") + "\n", "utf8");
        rowsDropped += dropped;
      }
    } catch {
      /* skip file */
    }
  }
  return { filesRemoved, rowsDropped };
}
