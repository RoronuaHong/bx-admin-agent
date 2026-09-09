/**
 * Analytics scan DingTalk notify (M3 Task 5).
 *
 * alert-notify dedups on the full message string (`kind:${msg}`). We call notifyAlerts
 * once per job with a combined body and embed `rerunSeq` in the fingerprint line so
 * forceRerun increments rerunSeq and bypasses the dedup window for legitimate re-notify.
 */

import {
  notifyAlerts,
  type AlertNotifyResult,
  type AlertSender,
} from "../../alert-notify.js";
import type { ThresholdResult } from "./threshold.js";
import type { BaselineKind, ScanAlertSeverity } from "./types.js";

export interface BuildFingerprintInput {
  ruleSetId: string;
  scanDate: string;
  metric: string;
  entityKey: string;
  baseline: BaselineKind | "";
  severity: ScanAlertSeverity | null;
  rerunSeq: number;
}

export interface BuildDeepLinkInput {
  from: string;
  to: string;
  q?: string;
}

export interface NotifyScanAlertsOpts {
  ruleSetId: string;
  scanDate: string;
  metric: string;
  rerunSeq: number;
  dryRun?: boolean;
  threshold: ThresholdResult;
  /** Natural-language prefill for `/analytics?q=`. */
  queryText?: string;
  title?: string;
  /** Test hook — replaces notifyAlerts. */
  notifyFn?: typeof notifyAlerts;
  webhook?: string;
  sender?: AlertSender;
}

export interface NotifyScanAlertsResult {
  sent: number;
  dryRun?: boolean;
  skipped?: boolean;
  fingerprint?: string;
  message?: string;
  notifyResult?: AlertNotifyResult;
}

/** Dedup fingerprint: ruleSetId|scanDate|metric|entityKey|baseline|severity|rerunSeq (§9.7). */
export function buildFingerprint(input: BuildFingerprintInput): string {
  const {
    ruleSetId,
    scanDate,
    metric,
    entityKey,
    baseline,
    severity,
    rerunSeq,
  } = input;
  return [
    ruleSetId,
    scanDate,
    metric,
    entityKey,
    baseline,
    severity ?? "",
    String(rerunSeq),
  ].join("|");
}

/** Deep link path with query string: `/analytics?from=&to=&q=` (§9.7 / M3 plan). */
export function buildDeepLink(input: BuildDeepLinkInput): string {
  const params = new URLSearchParams();
  params.set("from", input.from);
  params.set("to", input.to);
  if (input.q?.trim()) {
    params.set("q", input.q.trim());
  }
  const qs = params.toString();
  return qs ? `/analytics?${qs}` : "/analytics";
}

/** One-line Chinese runbook (R22). */
export function buildRunbook(): string {
  return "打开深链核对来源条 → 按语言/包体下钻 → 确认后可 forceRerun";
}

function defaultQueryText(metric: string, scanDate: string): string {
  if (metric === "channel_daily_users") {
    return `${scanDate} 按渠道观看人数`;
  }
  return `${scanDate} ${metric}`;
}

function buildScanAlertMessage(opts: NotifyScanAlertsOpts): string | null {
  const { threshold, ruleSetId, scanDate, metric, rerunSeq } = opts;
  const severity = threshold.severity;
  if (!severity || severity === "info") {
    return null;
  }

  const fingerprint = buildFingerprint({
    ruleSetId,
    scanDate,
    metric,
    entityKey: "",
    baseline: "",
    severity,
    rerunSeq,
  });

  const lines: string[] = [
    `[fingerprint: ${fingerprint}]`,
    threshold.parentMessage,
  ];

  if (threshold.children.length > 0) {
    lines.push("细分：");
    for (const child of threshold.children) {
      lines.push(`• ${child.message}`);
    }
  }

  const deepLink = buildDeepLink({
    from: scanDate,
    to: scanDate,
    q: opts.queryText ?? defaultQueryText(metric, scanDate),
  });

  lines.push(`时间窗：${scanDate}`);
  lines.push(`深链：${deepLink}`);
  lines.push(`处置：${buildRunbook()}`);

  return lines.join("\n");
}

/**
 * Push scan threshold alerts via DingTalk analytics channel.
 * dryRun → no notifyAlerts; warn/critical only; one combined message per job.
 */
export async function notifyScanAlerts(
  opts: NotifyScanAlertsOpts,
): Promise<NotifyScanAlertsResult> {
  if (opts.dryRun) {
    return { sent: 0, dryRun: true };
  }

  const message = buildScanAlertMessage(opts);
  if (!message) {
    return { sent: 0, skipped: true };
  }

  const fingerprint = buildFingerprint({
    ruleSetId: opts.ruleSetId,
    scanDate: opts.scanDate,
    metric: opts.metric,
    entityKey: "",
    baseline: "",
    severity: opts.threshold.severity === "info" ? null : opts.threshold.severity,
    rerunSeq: opts.rerunSeq,
  });

  const notify = opts.notifyFn ?? notifyAlerts;
  const notifyResult = await notify({
    kind: "analytics",
    title: opts.title,
    messages: [message],
    webhook: opts.webhook,
    sender: opts.sender,
  });

  return {
    sent: notifyResult.sent,
    fingerprint,
    message,
    notifyResult,
  };
}
