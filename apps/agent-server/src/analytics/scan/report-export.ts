/**
 * 巡检报告 Excel 导出（报告页「下载 Excel」与钉钉卡片按钮的数据源）。
 * 复用项目已有 exceljs 依赖，零新增。
 *
 * 结构：概览（指标/巡检日/严重度/结论/异常明细）+ 明细（对象数值与 DoD/WoW）。
 * 列头用通用对照词（当日/昨日/上周同期/DoD/WoW/状态），不写业务词。
 */

import ExcelJS from "exceljs";
import type { ReportSeverity, ScanReport, ScanReportRow } from "./report-store.js";

function toNumber(v: number | null): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pctText(cur: number | null, base: number | null): string {
  const c = toNumber(cur);
  const b = toNumber(base);
  if (c == null || b == null || b === 0) return "—";
  const r = ((c - b) / b) * 100;
  return `${r > 0 ? "+" : ""}${r.toFixed(1)}%`;
}

function severityText(severity: ReportSeverity): string {
  if (severity === "critical") return "严重";
  if (severity === "warn") return "预警";
  return "正常";
}

/** 行是否被告警点名（细分文案里提到该对象，与报告页口径一致，不写死阈值）。 */
function isFlagged(report: ScanReport, row: ScanReportRow): boolean {
  return report.children.some((m) => m.includes(row.entityKey));
}

export async function buildScanReportXlsx(report: ScanReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  const overview = wb.addWorksheet("概览");
  overview.columns = [
    { header: "项", key: "k", width: 16 },
    { header: "内容", key: "v", width: 80 },
  ];
  const overviewRows: Array<Record<string, string>> = [
    { k: "指标", v: report.metric },
    { k: "巡检日", v: report.scanDate },
    { k: "严重度", v: severityText(report.severity) },
    { k: "结论", v: report.parentMessage },
  ];
  for (const row of overviewRows) overview.addRow(row);
  if (report.children.length) {
    overview.addRow({ k: "异常明细", v: "" });
    for (const child of report.children) {
      overview.addRow({ k: "", v: child });
    }
  }
  overview.addRow({ k: "生成时间", v: new Date(report.createdAt).toLocaleString() });

  const detail = wb.addWorksheet(`明细 ${report.scanDate}`.slice(0, 28));
  detail.columns = [
    { header: "对象", key: "entityKey", width: 22 },
    { header: "当日", key: "scanValue", width: 14 },
    { header: "昨日", key: "dodValue", width: 14 },
    { header: "上周同期", key: "wowValue", width: 14 },
    { header: "DoD", key: "dod", width: 10 },
    { header: "WoW", key: "wow", width: 10 },
    { header: "状态", key: "status", width: 10 },
  ];
  const sorted = [...report.rows].sort((a, b) => (toNumber(b.scanValue) ?? 0) - (toNumber(a.scanValue) ?? 0));
  for (const row of sorted) {
    const flagged = isFlagged(report, row);
    const excelRow = detail.addRow({
      entityKey: row.entityKey,
      scanValue: toNumber(row.scanValue) ?? "",
      dodValue: toNumber(row.dodValue) ?? "",
      wowValue: toNumber(row.wowValue) ?? "",
      dod: pctText(row.scanValue, row.dodValue),
      wow: pctText(row.scanValue, row.wowValue),
      status: flagged ? "异常" : "正常",
    });
    if (flagged) excelRow.font = { bold: true, color: { argb: "FFD4380D" } };
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
