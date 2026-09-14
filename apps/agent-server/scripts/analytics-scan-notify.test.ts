/**
 * analytics scan notify unit tests (pure helpers + dryRun / injected notifyFn).
 * Run: tsx scripts/analytics-scan-notify.test.ts
 */
import assert from "node:assert/strict";
import type { AlertNotifyResult } from "../src/alert-notify.js";
import {
  buildDeepLink,
  buildFingerprint,
  buildRunbook,
  buildScanDigestMessage,
  notifyScanAlerts,
  notifyScanDigest,
} from "../src/analytics/scan/notify.js";
import type { ThresholdResult } from "../src/analytics/scan/threshold.js";

{
  const fp = buildFingerprint({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    metric: "channel_daily_users",
    entityKey: "ch-a",
    baseline: "dod",
    severity: "warn",
    rerunSeq: 0,
  });
  assert.equal(
    fp,
    "watch-users|2026-09-08|channel_daily_users|ch-a|dod|warn|0",
  );
}

{
  const fp1 = buildFingerprint({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    metric: "channel_daily_users",
    entityKey: "",
    baseline: "",
    severity: "critical",
    rerunSeq: 0,
  });
  const fp2 = buildFingerprint({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    metric: "channel_daily_users",
    entityKey: "",
    baseline: "",
    severity: "critical",
    rerunSeq: 1,
  });
  assert.notEqual(fp1, fp2);
}

{
  assert.equal(
    buildDeepLink({ from: "2026-09-08", to: "2026-09-08" }),
    "/analytics?from=2026-09-08&to=2026-09-08",
  );
  assert.equal(
    buildDeepLink({
      from: "2026-09-01",
      to: "2026-09-08",
      q: "按渠道观看人数",
    }),
    "/analytics?from=2026-09-01&to=2026-09-08&q=%E6%8C%89%E6%B8%A0%E9%81%93%E8%A7%82%E7%9C%8B%E4%BA%BA%E6%95%B0",
  );
}

{
  const runbook = buildRunbook();
  assert.match(runbook, /深链/);
  assert.match(runbook, /forceRerun/);
}

const warnThreshold: ThresholdResult = {
  severity: "warn",
  parentMessage: "watch-users 巡检：1 个实体相对基线下降超过阈值（warn）",
  children: [
    {
      entityKey: "ch-a",
      baseline: "dod",
      ratio: 0.85,
      delta: -150,
      message: "ch-a：日环比相对下降 15.0%（1000 → 850，ratio=0.850）",
    },
  ],
  quietReasons: [],
};

{
  const r = await notifyScanAlerts({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    metric: "channel_daily_users",
    rerunSeq: 0,
    dryRun: true,
    threshold: warnThreshold,
  });
  assert.equal(r.sent, 0);
  assert.equal(r.dryRun, true);
}

{
  let called = 0;
  let capturedMessages: string[] = [];
  const mockNotify = async (opts: {
    kind: string;
    messages: string[];
  }): Promise<AlertNotifyResult> => {
    called += 1;
    capturedMessages = opts.messages;
    return { attempted: true, sent: 1, skippedDedup: 0, skippedDisabled: false };
  };

  const r = await notifyScanAlerts({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    metric: "channel_daily_users",
    rerunSeq: 2,
    threshold: warnThreshold,
    notifyFn: mockNotify,
  });

  assert.equal(called, 1);
  assert.equal(r.sent, 1);
  assert.equal(capturedMessages.length, 1);
  const body = capturedMessages[0]!;
  assert.match(body, /\[fingerprint: watch-users\|2026-09-08\|channel_daily_users\|\|\|warn\|2\]/);
  assert.match(body, /watch-users 巡检：1 个实体/);
  assert.match(body, /ch-a：日环比相对下降/);
  assert.match(body, /深链：\/analytics\?/);
  assert.ok(body.includes(`处置：${buildRunbook()}`));
}

{
  let called = 0;
  const mockNotify = async (): Promise<AlertNotifyResult> => {
    called += 1;
    return { attempted: false, sent: 0, skippedDedup: 0, skippedDisabled: false };
  };

  const r = await notifyScanAlerts({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    metric: "channel_daily_users",
    rerunSeq: 0,
    threshold: {
      severity: "info",
      parentMessage: "quiet",
      children: [],
      quietReasons: ["empty"],
    },
    notifyFn: mockNotify,
  });

  assert.equal(called, 0);
  assert.equal(r.sent, 0);
  assert.equal(r.skipped, true);
}

{
  const digest = buildScanDigestMessage({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    dodDate: "2026-09-07",
    wowDate: "2026-09-01",
    metric: "channel_daily_users",
    rerunSeq: 0,
    rows: [
      { entityKey: "IndiaA", scanValue: 1100, dodValue: 1000, wowValue: 1000, sample: 1100 },
      { entityKey: "FoxA", scanValue: 80, dodValue: 100, wowValue: 200, sample: 80 },
    ],
    threshold: {
      severity: "warn",
      parentMessage: "watch-users 巡检：1 个实体相对基线下降超过阈值（warn）",
      children: [
        {
          entityKey: "FoxA",
          baseline: "dod",
          ratio: 0.8,
          delta: -20,
          message: "FoxA：日环比相对下降 20.0%",
        },
      ],
      quietReasons: [],
    },
  });
  assert.match(digest, /\[fingerprint: watch-users\|2026-09-08\|channel_daily_users\|\|\|info\|0\|digest\]/);
  assert.match(digest, /【问数巡检日报】channel_daily_users（非 ROI）/);
  assert.match(digest, /IndiaA  1100  DoD \+10\.0%  WoW \+10\.0%/);
  assert.match(digest, /异常：1 条（降幅>10%）/);
}

{
  let called = 0;
  let capturedTitle = "";
  const mockNotify = async (opts: {
    kind: string;
    title?: string;
    messages: string[];
  }): Promise<AlertNotifyResult> => {
    called += 1;
    capturedTitle = opts.title || "";
    return { attempted: true, sent: 1, skippedDedup: 0, skippedDisabled: false };
  };

  const r = await notifyScanDigest({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    metric: "channel_daily_users",
    rerunSeq: 0,
    rows: [{ entityKey: "IndiaA", scanValue: 10, dodValue: 10, wowValue: 10, sample: 10 }],
    threshold: {
      severity: "info",
      parentMessage: "quiet",
      children: [],
      quietReasons: [],
    },
    notifyFn: mockNotify,
  });
  assert.equal(called, 1);
  assert.equal(r.sent, 1);
  assert.equal(capturedTitle, "问数巡检日报");
  assert.match(r.fingerprint || "", /\|digest$/);
}

console.log("analytics-scan-notify.test.ts OK");
