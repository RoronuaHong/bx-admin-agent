/**
 * 巡检报告分享存储（M3 扩展：钉钉 text 消息无法内嵌图表，改为可点击链接）。
 *
 * - 告警触发时把本次巡检结果（渠道明细 + 阈值预警 + 时间窗）落盘为一份只读报告，
 *   返回一个 32 位 hex token；钉钉文案里的链接指向 /analytics/report/:token。
 * - 报告页匿名只读，token 即访问凭证（不可猜）；不写业务词。
 * - 零新依赖；路径沿用项目 .data 约定（cwd 下 .data/analytics-reports）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ChannelDailyUserRow } from "./metrics.js";

export type ReportSeverity = "warn" | "critical" | "info" | null;

export interface ScanReportRow {
  entityKey: string;
  scanValue: number | null;
  dodValue: number | null;
  wowValue: number | null;
}

export interface ScanReport {
  kind: "scan";
  scanDate: string;
  metric: string;
  from: string;
  to: string;
  queryText: string;
  severity: ReportSeverity;
  parentMessage: string;
  children: string[];
  rows: ScanReportRow[];
  createdAt: number;
}

export interface SaveScanReportInput {
  scanDate: string;
  metric: string;
  from: string;
  to: string;
  queryText: string;
  severity: ReportSeverity;
  parentMessage: string;
  children: string[];
  rows: ChannelDailyUserRow[];
}

const REPORT_DIR = join(process.cwd(), ".data", "analytics-reports");
const DEFAULT_RETENTION_DAYS = 30;

function ensureDir(): void {
  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
}

/** 报告保留期（天）；未配默认 30，设为 0/负数 = 永久保留。 */
export function getReportRetentionDays(): number {
  const raw = Number(process.env.ANALYTICS_REPORT_RETENTION_DAYS);
  return Number.isFinite(raw) ? raw : DEFAULT_RETENTION_DAYS;
}

/**
 * 清理超过保留期的报告（`.json` 快照及其配图 `.png`），避免无限堆积。
 * 落盘时顺带跑一次；任何失败静默（清理不该影响告警主流程）。返回删除数。
 */
export function purgeOldScanReports(now = Date.now()): number {
  const days = getReportRetentionDays();
  if (!(days > 0)) return 0;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    if (!existsSync(REPORT_DIR)) return 0;
    for (const name of readdirSync(REPORT_DIR)) {
      if (!/^[a-f0-9]{32}\.(json|png|pdf)$/.test(name)) continue;
      const file = join(REPORT_DIR, name);
      try {
        if (statSync(file).mtimeMs < cutoff) {
          unlinkSync(file);
          removed += 1;
        }
      } catch {
        /* 单文件失败不影响其它文件 */
      }
    }
  } catch {
    /* 目录不可读等：静默 */
  }
  return removed;
}

/** 生成不可猜 token 并落盘，返回 token（即分享链接标识）。 */
export function saveScanReport(input: SaveScanReportInput): string {
  ensureDir();
  const token = randomBytes(16).toString("hex");
  const report: ScanReport = {
    kind: "scan",
    createdAt: Date.now(),
    scanDate: input.scanDate,
    metric: input.metric,
    from: input.from,
    to: input.to,
    queryText: input.queryText,
    severity: input.severity,
    parentMessage: input.parentMessage,
    children: input.children,
    rows: (input.rows || []).map((r) => ({
      entityKey: r.entityKey,
      scanValue: r.scanValue ?? null,
      dodValue: r.dodValue ?? null,
      wowValue: r.wowValue ?? null,
    })),
  };
  writeFileSync(join(REPORT_DIR, `${token}.json`), JSON.stringify(report, null, 2), "utf8");
  purgeOldScanReports();
  return token;
}

/** 按 token 读报告；token 非法（非 32 hex）或文件缺失返回 null。 */
export function loadScanReport(token: string): ScanReport | null {
  if (!/^[a-f0-9]{32}$/.test(token)) return null;
  const file = join(REPORT_DIR, `${token}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ScanReport;
  } catch {
    return null;
  }
}
