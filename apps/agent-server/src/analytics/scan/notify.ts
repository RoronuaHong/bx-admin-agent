/**
 * Analytics scan DingTalk notify (M3 Task 5).
 *
 * alert-notify dedups on the full message string (`kind:${msg}`). We call notifyAlerts
 * once per job with a combined body and embed `rerunSeq` in the fingerprint line so
 * forceRerun increments rerunSeq and bypasses the dedup window for legitimate re-notify.
 */

import { config } from "../../config.js";
import {
  notifyAlerts,
  type AlertAction,
  type AlertNotifyResult,
  type AlertSender,
} from "../../alert-notify.js";
import type { ChannelDailyUserRow } from "./metrics.js";
import type { ThresholdResult } from "./threshold.js";
import type { BaselineKind, ScanAlertSeverity } from "./types.js";
import { saveScanReport, type ReportSeverity } from "./report-store.js";
import { isPubliclyReachableUrl, reportImageEnabled, reportImageForce } from "./report-image.js";
import { textBarChart } from "./report-markdown.js";

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
  /** 渠道日活明细（用于生成可点击的报告链接，含图表/趋势/预警）。 */
  rows?: ChannelDailyUserRow[];
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

/**
 * 深链：配了 config.scan.webBaseUrl 时拼成可点击绝对 URL；否则退化为相对路径
 * /analytics?...（钉钉里只是纯文本、无法点击 → 即"打开无效"的根因）。§9.7 / M3 plan。
 */
export function buildDeepLink(input: BuildDeepLinkInput): string {
  const params = new URLSearchParams();
  params.set("from", input.from);
  params.set("to", input.to);
  if (input.q?.trim()) {
    params.set("q", input.q.trim());
  }
  const qs = params.toString();
  const base = config.scan.webBaseUrl;
  if (base) return `${base}/analytics?${qs}`;
  return qs ? `/analytics?${qs}` : "/analytics";
}

/**
 * 处置 runbook（R22）。文案面向「看钉钉的人」，不写内部术语。
 * 注意：当前"下钻"是人工动作——打开链接后在问数里用自然语言追问细分维度，
 * 非系统自动下钻（自动下钻需要维度配置+取数，见 docs/analytics/roi-channel-monitor-status.md）。
 * 原文案末尾的「确认后可 forceRerun」已删除：问数页「巡检」面板只提供「运行巡检」，
 * UI 无法 forceRerun（那是内部接口参数），写出来会误导值班同学。
 */
export function buildRunbook(): string {
  return "先看报告确认异常范围；需要细分维度时到问数里继续追问";
}

function defaultQueryText(metric: string, scanDate: string): string {
  return `${scanDate} ${metric}`;
}

/**
 * 钉钉卡片配色板（6 位 hex，用于 <font color="#RRGGBB">）。
 * 刻意只有**一个红**：严重/预警徽标、异常细分、异常计数、下跌共用 `red`，
 * 群里同屏不会再出现两种红。橙（#fa8c16）已废弃移除 —— 预警与严重只靠**徽标文字**区分。
 */
const PALETTE = {
  /** 全站唯一红（异常/预警/严重/下跌）。 */
  red: "f5222d",
  ok: "52c41a",
  up: "52c41a",
  down: "f5222d",
  bar: "597ef7",
  info: "2f54eb",
  neutral: "8c8c8c",
};

/** 严重度展示词与配色：warn 与 critical 同红，严重程度由徽标文字（预警/严重）承担。 */
function severityMeta(severity: ReportSeverity): { label: string; color: string } {
  if (severity === "critical") return { label: "严重", color: PALETTE.red };
  if (severity === "warn") return { label: "预警", color: PALETTE.red };
  return { label: "正常", color: PALETTE.ok };
}

/**
 * 是否用 <font color> 上色。
 * 真机已验证钉钉自定义机器人 markdown 支持该标签（6 位 hex、须闭合），
 * 故默认开启；若客户端确实不渲染，可显式设 ALERT_FONT_COLOR=0 关闭。
 */
function fontColorEnabled(): boolean {
  const raw = (process.env.ALERT_FONT_COLOR ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

function colorize(text: string, color: string, enabled: boolean): string {
  return enabled ? `<font color="#${color}">${text}</font>` : text;
}

/** 给涨跌百分比上色：+ 绿 / - 红 / 中性灰。 */
function colorizePct(value: string, enabled: boolean): string {
  if (!enabled) return value;
  if (value.startsWith("+")) return colorize(value, PALETTE.up, true);
  if (value.startsWith("-")) return colorize(value, PALETTE.down, true);
  return colorize(value, PALETTE.neutral, true);
}

/** 消息形态：markdown（默认，正文链接）/ action_card（卡片正文 + 真实可点按钮）。 */
function alertMsgType(): "markdown" | "action_card" {
  const raw = (process.env.ALERT_MSGTYPE || "markdown").trim().toLowerCase();
  return raw === "action_card" || raw === "card" ? "action_card" : "markdown";
}

/** 通知预览标题：会话列表/通知首屏透出的就是它，必须携带信号而非泛化词（且含机器人关键词）。 */
function alertTitle(base: string, scanDate: string, detail: string): string {
  return `${base} ${scanDate}：${detail}`;
}

/** 把报告 token 拼成可点击绝对 URL；未配 webBaseUrl 则退化为站内相对路径。 */
function reportAbsUrl(token: string): string {
  const base = config.scan.webBaseUrl;
  const path = `/analytics/report/${token}`;
  return base ? `${base}${path}` : path;
}

/**
 * 报告 PNG 的公网 URL（钉钉 markdown `![](url)` 用）。
 * 仅当 ALERT_REPORT_IMAGE 开启且配了 webBaseUrl 时返回；图片由本服务
 * GET /analytics/report/:token/image.png 渲染并托管（经 web 的 /agent 代理）。
 *
 * 实测补充：钉钉取图**不是**客户端行为（内网 192.168.x.x 的图在群里不显示），
 * 故这里做公网可达性预检——私网/回环地址直接跳过内嵌，避免群里出现裂图占位；
 * 若确实是私网自建钉钉且能取到图，可用 ALERT_REPORT_IMAGE_FORCE=1 强制。
 */
let imageHostWarned = false;
function reportImageUrl(token: string): string | null {
  if (!reportImageEnabled()) return null;
  const base = config.scan.webBaseUrl;
  if (!base) return null;
  if (!reportImageForce() && !isPubliclyReachableUrl(base)) {
    if (!imageHostWarned) {
      imageHostWarned = true;
      console.warn(
        `[scan-notify] ALERT_REPORT_IMAGE 已开，但 ANALYTICS_WEB_BASE_URL 非公网可达（钉钉取不到图），已跳过内嵌图：${base}；如需强制设 ALERT_REPORT_IMAGE_FORCE=1`,
      );
    }
    return null;
  }
  return `${base}/agent/analytics/report/${token}/image.png`;
}

/** Excel 下载 URL（卡片按钮用）：由**绝对**报告链接推导；相对链接在钉钉里打不开 → 不配按钮。 */
function reportExcelUrl(reportLink: string | undefined): string | undefined {
  if (!reportLink) return undefined;
  const m = /^(https?:\/\/[^/]+)\/analytics\/report\/([a-f0-9]{32})$/.exec(reportLink);
  return m ? `${m[1]}/agent/analytics/report/${m[2]}/export.xlsx` : undefined;
}

/** PDF 下载 URL（卡片按钮用）：由**绝对**报告链接推导。 */
function reportPdfUrl(reportLink: string | undefined): string | undefined {
  if (!reportLink) return undefined;
  const m = /^(https?:\/\/[^/]+)\/analytics\/report\/([a-f0-9]{32})$/.exec(reportLink);
  return m ? `${m[1]}/agent/analytics/report/${m[2]}/report.pdf` : undefined;
}

/** 数值千分位（与报告页展示一致；null 显示 —）。 */
function fmtCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US");
}

/**
 * 渠道日活文本柱状图（markdown 列表行）；内嵌图不可用时也能"看见"趋势。
 *
 * 关键约束：**被点名的异常渠道必须进图**。图只按体量取 topN 时，异常渠道常常
 * 因为体量小排不进去（告警说"A 掉了"、图里却没有 A），所以这里取
 * 「topN 较大渠道 ∪ 异常渠道」，再做一次统一排序，异常项打 `← 异常` 标记。
 */
function buildChannelChartLines(
  rows: ChannelDailyUserRow[],
  opts?: { topN?: number; highlight?: string[]; mark?: string; fontColor?: boolean },
): string[] {
  const topN = opts?.topN ?? 12;
  const highlight = new Set((opts?.highlight ?? []).filter(Boolean));
  const mark = opts?.mark ?? " ← 异常";
  const fontColor = opts?.fontColor ?? false;
  const sorted = [...rows].sort((a, b) => (b.scanValue || 0) - (a.scanValue || 0));
  if (!sorted.length) return [];

  const selected: ChannelDailyUserRow[] = [];
  const seen = new Set<string>();
  for (const row of sorted.slice(0, topN)) {
    if (seen.has(row.entityKey)) continue;
    seen.add(row.entityKey);
    selected.push(row);
  }
  for (const row of sorted) {
    if (!highlight.has(row.entityKey) || seen.has(row.entityKey)) continue;
    seen.add(row.entityKey);
    selected.push(row);
  }
  selected.sort((a, b) => (b.scanValue || 0) - (a.scanValue || 0));

  const lines = textBarChart(
    selected.map((row) => ({
      label: row.entityKey,
      value: row.scanValue ?? null,
      // 紧凑写法：DoD/WoW 的含义由上方小标题统一交代，逐行不再重复标签（手机上好读很多）
      suffix:
        `${fmtCount(row.scanValue)} · ${colorizePct(pctChange(row.scanValue, row.dodValue), fontColor)}` +
        ` / ${colorizePct(pctChange(row.scanValue, row.wowValue), fontColor)}` +
        (highlight.has(row.entityKey) ? mark : ""),
    })),
    { barColor: fontColor ? `#${PALETTE.bar}` : undefined },
  );
  if (sorted.length > selected.length) {
    lines.push(`- … 另有 ${sorted.length - selected.length} 个渠道未列出`);
  }
  return lines;
}

/**
 * 落盘一份只读巡检报告，返回 token（用于分享链接）。任何异常静默降级为 null，
 * 不影响主流程告警推送。
 */
function saveScanReportToken(input: {
  scanDate: string;
  metric: string;
  queryText?: string;
  severity: ReportSeverity;
  parentMessage: string;
  children: string[];
  rows: ChannelDailyUserRow[];
}): string | null {
  try {
    return saveScanReport({
      scanDate: input.scanDate,
      metric: input.metric,
      from: input.scanDate,
      to: input.scanDate,
      queryText: input.queryText ?? `${input.scanDate} ${input.metric}`,
      severity: input.severity,
      parentMessage: input.parentMessage,
      children: input.children,
      rows: input.rows,
    });
  } catch {
    return null;
  }
}

interface MessageLayout {
  reportLink?: string;
  imageUrl?: string | null;
  deepLink: string;
  /** action_card 卡片模式：正文压缩（图取 top8）、无「下一步」节 —— 动作由实体按钮承担。 */
  cardMode: boolean;
  fontColor: boolean;
  severityLabel: string;
  severityColor: string;
}

function buildScanAlertMessage(
  opts: NotifyScanAlertsOpts,
  layout: MessageLayout,
): string | null {
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

  // 排版约定（只用钉钉 markdown 实测支持的语法：加粗 / 列表 / 链接 / 图片 / <font> 颜色）：
  // 严重度徽标 + **小标题** + 空行分段 —— 有层级、可扫读，符合"5 秒看懂"的告警规范。
  const lines: string[] = [
    `${colorize(`【${layout.severityLabel}】`, layout.severityColor, layout.fontColor)} ` +
      `**${threshold.parentMessage}**`,
    `时间窗：${scanDate}`,
  ];

  if (threshold.children.length > 0) {
    lines.push("", "**异常细分**");
    for (const child of threshold.children) {
      // 异常一律红，不跟随严重度徽标色（即便徽标是预警级，异常也必须是红的）。
      lines.push(`- ${colorize(child.message, PALETTE.down, layout.fontColor)}`);
    }
  }

  // 内嵌图（钉钉 markdown 语法；url 须公网可达，未开开关/内网时自动省略）
  if (layout.imageUrl) lines.push("", `![巡检趋势图](${layout.imageUrl})`);

  const chart = buildChannelChartLines(opts.rows ?? [], {
    topN: layout.cardMode ? 6 : 12,
    highlight: threshold.children.map((c) => c.entityKey),
    mark: layout.fontColor ? ` ← ${colorize("异常", PALETTE.down, true)}` : undefined,
    fontColor: layout.fontColor,
  });
  if (chart.length) {
    lines.push("", "**渠道日活（当日 · DoD · WoW）**");
    lines.push(...chart);
  }

  // 卡片模式：正文链接与底部实体按钮**并存**——按钮直达，链接可单独复制/在浏览器打开。
  const actions: string[] = [];
  if (layout.reportLink) actions.push(`[查看完整报告（图表 / 趋势 / 明细表）](${layout.reportLink})`);
  actions.push(`[去问数继续追问细分维度](${layout.deepLink})`);
  lines.push("", "**下一步**");
  actions.forEach((action, i) => lines.push(`${i + 1}. ${action}`));

  lines.push("", `处置：${buildRunbook()}`);
  // 去重指纹放最后：它只是给排查对账用的内部标识，不该占住人第一眼的位置
  // （notifyAlerts 按整条消息去重，位置无所谓；它同时承载 rerunSeq 以保证重跑能再次推送）。
  lines.push(`[fingerprint: ${fingerprint}]`);

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
  reportLink?: string;
  imageUrl?: string | null;
  deepLink?: string;
  cardMode?: boolean;
  fontColor?: boolean;
  severityLabel?: string;
  /** 只用于**消息徽标**配色；异常摘要色由 threshold.severity 决定（见下方 summaryColor）。 */
  severityColor?: string;
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
  const cardMode = input.cardMode === true;
  const fontColor = input.fontColor === true;
  const chart = buildChannelChartLines(input.rows, {
    topN: cardMode ? 6 : 12,
    highlight: input.threshold.children.map((c) => c.entityKey),
    mark: fontColor ? ` ← ${colorize("异常", PALETTE.down, true)}` : undefined,
    fontColor,
  });
  const lines: string[] = [
    `${colorize(`【${input.severityLabel ?? "正常"}】`, input.severityColor ?? PALETTE.ok, fontColor)} ` +
      `**【问数巡检日报】${input.metric}（非 ROI）**`,
    `巡检日 ${input.scanDate}` +
      (input.dodDate && input.wowDate ? `；对比昨日 ${input.dodDate} / 上周同期 ${input.wowDate}` : ""),
  ];
  if (input.imageUrl) lines.push("", `![巡检趋势图](${input.imageUrl})`);
  if (!chart.length) {
    lines.push("", "当日无渠道行。");
  } else {
    lines.push("", "**渠道日活（当日 · DoD · WoW）**");
    lines.push(...chart);
  }
  const warnN = input.threshold.children.length;
  // 不写死阈值百分比：真实阈值来自 ruleset 的 ratio，改动后这里的文案会变成假话。
  // 具体降幅已在上方细分与柱状图里逐条给出。
  //
  // 摘要色：**只要有异常就是红的**（critical/warn 同色），无异常才绿；与徽标色解耦
  // ——徽标回答"这是什么消息"（日报恒为蓝），摘要回答"有没有事"。
  // （原实现取 input.severityColor，而日报恒传 info 蓝，导致「异常：N 条」被涂成蓝色、
  //  丢了警示含义。）
  const summaryColor =
    input.threshold.severity === "critical" || input.threshold.severity === "warn"
      ? PALETTE.down
      : PALETTE.ok;
  lines.push(
    "",
    input.threshold.severity === "warn" || input.threshold.severity === "critical"
      ? `**${colorize(`异常：${warnN} 条`, summaryColor, fontColor)}**`
      : colorize("异常：无", summaryColor, fontColor),
  );

  // 卡片模式：正文链接与底部实体按钮**并存**——按钮直达，链接可单独复制/在浏览器打开。
  const actions: string[] = [];
  if (input.reportLink) actions.push(`[查看完整报告（图表 / 趋势 / 明细表）](${input.reportLink})`);
  actions.push(
    `[去问数继续追问细分维度](${input.deepLink ??
      buildDeepLink({
        from: input.scanDate,
        to: input.scanDate,
        q: input.queryText ?? defaultQueryText(input.metric, input.scanDate),
      })})`,
  );
  lines.push("", "**下一步**");
  actions.forEach((action, i) => lines.push(`${i + 1}. ${action}`));

  // 同告警：去重指纹放最后（位置无所谓，它只承载 rerunSeq/排查对账）。
  lines.push(`[fingerprint: ${fingerprint}|digest]`);
  return lines.join("\n");
}

export async function notifyScanDigest(
  opts: NotifyScanAlertsOpts & { rows: ChannelDailyUserRow[]; dodDate?: string; wowDate?: string },
): Promise<NotifyScanAlertsResult> {
  if (opts.dryRun) {
    return { sent: 0, dryRun: true };
  }
  const token = saveScanReportToken({
    scanDate: opts.scanDate,
    metric: opts.metric,
    queryText: opts.queryText,
    severity: (opts.threshold.severity ?? "info") as ReportSeverity,
    parentMessage: `问数巡检日报 ${opts.metric}（非 ROI）巡检日 ${opts.scanDate}`,
    children: opts.threshold.children.map((c) => c.message),
    rows: opts.rows,
  });
  const reportLink = token ? reportAbsUrl(token) : undefined;
  const imageUrl = token ? reportImageUrl(token) : null;
  const deepLink = buildDeepLink({
    from: opts.scanDate,
    to: opts.scanDate,
    q: opts.queryText ?? defaultQueryText(opts.metric, opts.scanDate),
  });
  const msgType = alertMsgType();
  const meta = severityMeta((opts.threshold.severity ?? "info") as ReportSeverity);
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
    reportLink,
    imageUrl,
    deepLink,
    cardMode: msgType === "action_card",
    fontColor: fontColorEnabled(),
    severityLabel: "日报",
    severityColor: PALETTE.info,
  });
  const actions: AlertAction[] = [];
  if (reportLink) actions.push({ title: "查看完整报告", action_url: reportLink });
  const excelUrl = reportExcelUrl(reportLink);
  if (excelUrl) actions.push({ title: "下载 Excel", action_url: excelUrl });
  const pdfUrl = reportPdfUrl(reportLink);
  if (pdfUrl) actions.push({ title: "下载 PDF", action_url: pdfUrl });
  actions.push({ title: "去问数追问细分", action_url: deepLink });
  const notify = opts.notifyFn ?? notifyAlerts;
  const notifyResult = await notify({
    kind: "analytics",
    // 标题必须带机器人安全设置里的关键词（与告警标题一致，默认 "[bx-agent] ..."），
    // 否则关键词校验会让日报被静默拒收（errcode 310000）——原实现只写 "问数巡检日报"。
    // 会话列表首屏透出的就是它，因此带日期，让值班人在列表里就能分辨是哪天的日报。
    title: opts.title || alertTitle("📊 [bx-agent] 巡检日报", opts.scanDate, "渠道日活 + 异常汇总"),
    messages: [message],
    webhook: opts.webhook,
    sender: opts.sender,
    format: msgType,
    actions,
    btnOrientation: "0",
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

  const severity = opts.threshold.severity === "info" ? null : opts.threshold.severity;
  const token = saveScanReportToken({
    scanDate: opts.scanDate,
    metric: opts.metric,
    queryText: opts.queryText,
    severity,
    parentMessage: opts.threshold.parentMessage,
    children: opts.threshold.children.map((c) => c.message),
    rows: opts.rows ?? [],
  });
  const reportLink = token ? reportAbsUrl(token) : undefined;
  const imageUrl = token ? reportImageUrl(token) : null;
  const deepLink = buildDeepLink({
    from: opts.scanDate,
    to: opts.scanDate,
    q: opts.queryText ?? defaultQueryText(opts.metric, opts.scanDate),
  });
  const msgType = alertMsgType();
  const meta = severityMeta(severity);
  const message = buildScanAlertMessage(opts, {
    reportLink,
    imageUrl,
    deepLink,
    cardMode: msgType === "action_card",
    fontColor: fontColorEnabled(),
    severityLabel: meta.label,
    severityColor: meta.color,
  });
  if (!message) {
    return { sent: 0, skipped: true };
  }

  const fingerprint = buildFingerprint({
    ruleSetId: opts.ruleSetId,
    scanDate: opts.scanDate,
    metric: opts.metric,
    entityKey: "",
    baseline: "",
    severity,
    rerunSeq: opts.rerunSeq,
  });

  const actions: AlertAction[] = [];
  if (reportLink) actions.push({ title: "查看完整报告", action_url: reportLink });
  const excelUrl = reportExcelUrl(reportLink);
  if (excelUrl) actions.push({ title: "下载 Excel", action_url: excelUrl });
  const pdfUrl = reportPdfUrl(reportLink);
  if (pdfUrl) actions.push({ title: "下载 PDF", action_url: pdfUrl });
  actions.push({ title: "去问数追问细分", action_url: deepLink });
  const notify = opts.notifyFn ?? notifyAlerts;
  const notifyResult = await notify({
    kind: "analytics",
    // 会话列表/通知首屏透出的就是 title —— 必须带信号（哪天、几条异常）而非泛化词，
    // 且含机器人安全关键词 [bx-agent]，否则会被关键词校验静默拒收。
    title:
      opts.title ??
      alertTitle(
        `🚨 [bx-agent] 巡检${meta.label}`,
        opts.scanDate,
        `${opts.threshold.children.length} 个渠道异常`,
      ),
    messages: [message],
    webhook: opts.webhook,
    sender: opts.sender,
    format: msgType,
    actions,
    btnOrientation: "0",
  });

  return {
    sent: notifyResult.sent,
    fingerprint,
    message,
    notifyResult,
  };
}
