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

// 单测默认关闭颜色，保证纯文本断言稳定；颜色分支在下方独立用例验证。
process.env.ALERT_FONT_COLOR = "0";

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
  // 面向「看钉钉的人」：说清"先看报告确认范围 / 再追问细分"，不写内部术语。
  assert.match(runbook, /确认异常范围/);
  assert.match(runbook, /继续追问/);
  // 回归护栏：forceRerun 是内部接口参数，问数页 UI 无此入口，不得再出现在值班文案里。
  assert.doesNotMatch(runbook, /forceRerun/);
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
  // 追问入口以 markdown 链接形式给出（未配 webBaseUrl 时为站内相对路径），且带序号。
  assert.match(body, /\n\d+\. \[去问数继续追问细分维度\]\(\/analytics\?/);
  assert.ok(body.includes(`处置：${buildRunbook()}`));
  // 排版：小标题加粗 + 空行分段（手机端不糊成一整块）。
  assert.match(body, /\n\n\*\*异常细分\*\*\n/);
  assert.match(body, /\n\n\*\*下一步\*\*\n/);
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
    fontColor: false,
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
  // 明细行是文本柱状图：`- <bar> label · 千分位数值 · DoD% / WoW%`
  // （DoD/WoW 的含义由上方小标题统一交代，逐行不再重复标签），异常项带 ← 异常。
  assert.match(digest, /IndiaA · 1,100 · \+10\.0% \/ \+10\.0%/);
  assert.match(digest, /FoxA · 80 · -20\.0% \/ -60\.0% ← 异常/);
  assert.match(digest, /\*\*渠道日活（当日 · DoD · WoW）\*\*/);
  assert.match(digest, /\n\n\*\*下一步\*\*\n/);
  // 不再写死阈值百分比（真实阈值来自 ruleset，写死会随 ruleset 改动变成假话）。
  assert.match(digest, /异常：1 条/);
  assert.doesNotMatch(digest, /降幅>10%/);
  // 去重指纹挪到末尾（让人先看结论），但仍须留在正文里以支撑去重 / 重跑。
  assert.ok(digest.trimEnd().endsWith("|digest]"));
}

{
  // 回归：异常渠道体量极小、排不进 topN 时也**必须**进图，
  // 否则会出现"告警点名 A 掉了、图里却找不到 A"。
  const bulk = Array.from({ length: 15 }, (_, i) => ({
    entityKey: `big-${String(i).padStart(2, "0")}`,
    scanValue: 10000 - i * 100,
    dodValue: 9000,
    wowValue: 8000,
    sample: 10000 - i * 100,
  }));
  const rows = [
    ...bulk,
    { entityKey: "tiny-ch", scanValue: 3, dodValue: 100, wowValue: 100, sample: 3 },
  ];
  const digest = buildScanDigestMessage({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    metric: "channel_daily_users",
    rerunSeq: 0,
    fontColor: false,
    rows,
    threshold: {
      severity: "warn",
      parentMessage: "watch-users 巡检：1 个实体相对基线下降超过阈值（warn）",
      children: [
        {
          entityKey: "tiny-ch",
          baseline: "dod",
          ratio: 0.03,
          delta: -97,
          message: "tiny-ch：日环比相对下降 97.0%",
        },
      ],
      quietReasons: [],
    },
  });
  assert.match(digest, /tiny-ch · 3 · -97\.0% \/ -97\.0% ← 异常/);
  assert.match(digest, /另有 \d+ 个渠道未列出/);
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
  // 标题须带机器人安全设置关键词（与告警标题同一词），否则日报会被关键词校验静默拒收；
  // 且应携带信号（日期 + 内容概要），因为会话列表首屏透出的就是它。
  assert.equal(capturedTitle, "📊 [bx-agent] 巡检日报 2026-09-08：渠道日活 + 异常汇总");
  assert.match(r.fingerprint || "", /\|digest$/);
}

{
  // 颜色分支：真机已验证钉钉 markdown 支持 <font color>。
  const digest = buildScanDigestMessage({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    metric: "channel_daily_users",
    rerunSeq: 0,
    fontColor: true,
    severityLabel: "预警",
    // 徽标色由调用方给（真实日报恒传 info 蓝）；异常相关元素一律红。
    severityColor: "2f54eb",
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
  assert.match(digest, /<font color="#2f54eb">【预警】<\/font>/);
  assert.match(digest, /<font color="#52c41a">\+10\.0%<\/font>/);
  assert.match(digest, /<font color="#f5222d">-20\.0%<\/font>/);
  assert.match(digest, /<font color="#f5222d">异常<\/font>/);
  assert.match(digest, /<font color="#597ef7">[█▉▊▋▌▍▎▏]+<\/font> IndiaA/);
  assert.match(digest, /<font color="#f5222d">异常：1 条<\/font>/);
}

{
  // 摘要色：有异常就红、无异常才绿；与徽标色解耦（日报徽标恒蓝）。
  const digestBase = {
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    metric: "channel_daily_users",
    rerunSeq: 0,
    fontColor: true,
    severityLabel: "日报",
    severityColor: "2f54eb",
    rows: [{ entityKey: "FoxA", scanValue: 80, dodValue: 100, wowValue: 200, sample: 80 }],
  };
  const child = {
    entityKey: "FoxA",
    baseline: "dod" as const,
    ratio: 0.8,
    delta: -20,
    message: "FoxA：日环比相对下降 20.0%",
  };

  const critical = buildScanDigestMessage({
    ...digestBase,
    threshold: { severity: "critical", parentMessage: "p", children: [child], quietReasons: [] },
  });
  assert.match(critical, /<font color="#2f54eb">【日报】<\/font>/);
  assert.match(critical, /<font color="#f5222d">异常：1 条<\/font>/);

  const quiet = buildScanDigestMessage({
    ...digestBase,
    threshold: { severity: "info", parentMessage: "p", children: [], quietReasons: [] },
  });
  assert.match(quiet, /<font color="#52c41a">异常：无<\/font>/);
}

{
  // 告警消息颜色分支：徽标（预警/严重）与异常细分**统一红**，严重程度只由徽标文字承担。
  process.env.ALERT_FONT_COLOR = "1";
  let capturedMessages: string[] = [];
  const mockNotify = async (opts: { kind: string; messages: string[] }) => {
    capturedMessages = opts.messages;
    return { attempted: true, sent: 1, skippedDedup: 0, skippedDisabled: false };
  };
  await notifyScanAlerts({
    ruleSetId: "watch-users",
    scanDate: "2026-09-08",
    metric: "channel_daily_users",
    rerunSeq: 0,
    threshold: warnThreshold,
    notifyFn: mockNotify,
  });
  assert.equal(capturedMessages.length, 1);
  const body = capturedMessages[0]!;
  assert.match(body, /<font color="#f5222d">【预警】<\/font>/);
  assert.match(body, /<font color="#f5222d">ch-a：日环比相对下降/);
}

console.log("analytics-scan-notify.test.ts OK");
