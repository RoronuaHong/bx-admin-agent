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
import type { ChannelDailyUserRow } from "./metrics.js";
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
function pctChange(cur: number | null, base: number | null): string {
  if (cur == null || base == null || base === 0) return "—";
  const r = ((cur - base) / base) * 100;
  const sign = r > 0 ? "+" : "";
  return `${sign}${r.toFixed(1)}%`;
}

export function buildScanDigestMessage(input: {
  ruleSetId: string;
  scanDate: string;
  dodDate?: string;
  wowDate?: string;
  metric: string;
  rerunSeq: number;
  rows: ChannelDailyUserRow[];
  threshold: ThresholdResult;
  queryText?: string;
}): string {
  const fingerprint = buildFingerprint({
    ruleSetId: input.ruleSetId,
    scanDate: input.scanDate,
    metric: input.metric,
    entityKey: "",
    baseline: "",
    severity: "info",
    rerunSeq: input.rerunSeq,
  });
  const top = [...input.rows]
    .sort((a, b) => (b.scanValue || 0) - (a.scanValue || 0))
    .slice(0, 12);
  const lines: string[] = [
    `[fingerprint: ${fingerprint}|digest]`,
    `【问数巡检日报】${input.metric}（非 ROI）`,
    `巡检日 ${input.scanDate}` +
      (input.dodDate && input.wowDate ? `；对比昨日 ${input.dodDate} / 上周同期 ${input.wowDate}` : ""),
  ];
  if (!top.length) {
    lines.push("当日无渠道行。");
  } else {
    lines.push("渠道日活（scan / DoD / WoW）：");
    for (const row of top) {
      const scan = row.scanValue == null ? "—" : String(row.scanValue);
      lines.push(
        `• ${row.entityKey}  ${scan}  DoD ${pctChange(row.scanValue, row.dodValue)}  WoW ${pctChange(row.scanValue, row.wowValue)}`,
      );
    }
    if (input.rows.length > top.length) {
      lines.push(`… 另有 ${input.rows.length - top.length} 个渠道未列出`);
    }
  }
  const warnN = input.threshold.children.length;
  lines.push(
    input.threshold.severity === "warn" || input.threshold.severity === "critical"
      ? `异常：${warnN} 条（降幅>10%）`
      : "异常：无",
  );
  lines.push(
    `深链：${buildDeepLink({
      from: input.scanDate,
      to: input.scanDate,
      q: input.queryText ?? defaultQueryText(input.metric, input.scanDate),
    })}`,
  );
  return lines.join("\n");
}

export async function notifyScanDigest(
  opts: NotifyScanAlertsOpts & { rows: ChannelDailyUserRow[]; dodDate?: string; wowDate?: string },
): Promise<NotifyScanAlertsResult> {
  if (opts.dryRun) {
    return { sent: 0, dryRun: true };
  }
  const message = buildScanDigestMessage({
    ruleSetId: opts.ruleSetId,
    scanDate: opts.scanDate,
    dodDate: opts.dodDate,
    wowDate: opts.wowDate,
    metric: opts.metric,
    rerunSeq: opts.rerunSeq,
    rows: opts.rows,
    threshold: opts.threshold,
    queryText: opts.queryText,
  });
  const notify = opts.notifyFn ?? notifyAlerts;
  const notifyResult = await notify({
    kind: "analytics",
    title: opts.title || "问数巡检日报",
    messages: [message],
    webhook: opts.webhook,
    sender: opts.sender,
  });
  return {
    sent: notifyResult.sent,
    fingerprint: `${buildFingerprint({
      ruleSetId: opts.ruleSetId,
      scanDate: opts.scanDate,
      metric: opts.metric,
      entityKey: "",
      baseline: "",
      severity: "info",
      rerunSeq: opts.rerunSeq,
    })}|digest`,
    message,
    notifyResult,
  };
}

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
