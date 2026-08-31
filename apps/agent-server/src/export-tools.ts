/**
 * Excel / PDF 导出
 */
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { existsSync } from "node:fs";
import type { ChatFileRef, ChatTableView } from "@bx/shared";
import { saveDownload } from "./downloads.js";
import { execRenderTable } from "./output-tools.js";

const WIN_FONTS = [
  "C:\\Windows\\Fonts\\msyh.ttc",
  "C:\\Windows\\Fonts\\msyh.ttf",
  "C:\\Windows\\Fonts\\simhei.ttf",
  "C:\\Windows\\Fonts\\simsun.ttc",
];

function pickCjkFont(): string | null {
  for (const f of WIN_FONTS) {
    if (existsSync(f)) return f;
  }
  return null;
}

function normalizeRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
  }
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.list)) return normalizeRows(o.list);
    if (o.data) return normalizeRows(o.data);
  }
  return [];
}

function flattenTree(
  rows: Record<string, unknown>[],
  depth = 0,
  out: Array<Record<string, unknown> & { _depth: number }> = [],
): Array<Record<string, unknown> & { _depth: number }> {
  for (const row of rows) {
    const children = Array.isArray(row.children) ? (row.children as Record<string, unknown>[]) : null;
    const { children: _c, ...rest } = row;
    out.push({ ...rest, _depth: depth });
    if (children?.length) flattenTree(children, depth + 1, out);
  }
  return out;
}

function buildColumns(
  inputCols: unknown,
  sample: Record<string, unknown>,
): Array<{ title: string; key: string }> {
  if (Array.isArray(inputCols) && inputCols.length) {
    return (inputCols as Array<Record<string, unknown>>)
      .map((c) => ({
        title: String(c.title || c.label || c.key || c.dataIndex || ""),
        key: String(c.key || c.dataIndex || c.title || ""),
      }))
      .filter((c) => c.title && c.key);
  }
  return Object.keys(sample)
    .filter((k) => !k.startsWith("_") && k !== "children")
    .slice(0, 16)
    .map((k) => ({ title: k, key: k }));
}

function computeFooter(
  rows: Record<string, unknown>[],
  columns: Array<{ title: string; key: string }>,
  footerSpec: unknown,
): Record<string, string> | null {
  if (!footerSpec) return null;
  if (typeof footerSpec === "object" && !Array.isArray(footerSpec) && !(footerSpec as { sum?: unknown }).sum) {
    // 直接传入 footer 行
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(footerSpec as Record<string, unknown>)) {
      out[k] = String(v ?? "");
    }
    return out;
  }
  const spec = footerSpec as { sum?: string[]; avg?: string[]; count?: boolean; label?: string };
  const label = String(spec.label || "合计");
  const out: Record<string, string> = {};
  const firstKey = columns[0]?.key;
  if (firstKey) out[firstKey] = label;
  if (spec.count) {
    const key = columns[1]?.key || firstKey;
    if (key) out[key] = String(rows.length);
  }
  for (const key of spec.sum || []) {
    let s = 0;
    for (const r of rows) {
      const n = Number(r[key]);
      if (!Number.isNaN(n)) s += n;
    }
    out[key] = String(Number.isInteger(s) ? s : s.toFixed(2));
  }
  for (const key of spec.avg || []) {
    let s = 0;
    let c = 0;
    for (const r of rows) {
      const n = Number(r[key]);
      if (!Number.isNaN(n)) {
        s += n;
        c += 1;
      }
    }
    out[key] = c ? (s / c).toFixed(2) : "";
  }
  return out;
}

async function bufferFromPdf(
  title: string,
  columns: Array<{ title: string; key: string }>,
  rows: Array<Record<string, unknown>>,
  footer: Record<string, string> | null,
): Promise<Buffer> {
  const font = pickCjkFont();
  return new Promise((resolvePromise, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolvePromise(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (font) {
      try {
        doc.font(font);
      } catch {
        /* fallback */
      }
    }
    doc.fontSize(14).text(title || "导出数据", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(9);

    const max = Math.min(rows.length, 200);
    for (let i = 0; i < max; i++) {
      const r = rows[i];
      const depth = Number(r._depth || 0);
      const line = columns
        .map((c) => `${c.title}:${(r as Record<string, unknown>)[c.key] ?? ""}`)
        .join(" | ");
      doc.text(`${"  ".repeat(depth)}${line}`, { width: 520 });
    }
    if (rows.length > max) doc.text(`… 另有 ${rows.length - max} 行未写入 PDF 预览，请用 Excel 下载完整数据`);
    if (footer) {
      doc.moveDown(0.5);
      doc.text(`表尾：${columns.map((c) => `${c.title}=${footer[c.key] ?? ""}`).join(" | ")}`);
    }
    doc.end();
  });
}

export async function execExportDataset(input: Record<string, unknown>): Promise<string> {
  const format = String(input.format || "xlsx").toLowerCase();
  const title = String(input.title || "导出数据").trim() || "导出数据";
  const fileBase = String(input.filename || title).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60);

  let rawRows = normalizeRows(input.data ?? input.rows);
  if (!rawRows.length) return "错误：无数据；请传入 data（数组或 {list:[]}）";

  const isTree = Boolean(input.tree) || rawRows.some((r) => Array.isArray(r.children));
  const flat = isTree ? flattenTree(rawRows) : rawRows.map((r) => ({ ...r, _depth: 0 }));
  const columns = buildColumns(input.columns, flat[0] || {});
  const footer = computeFooter(flat, columns, input.footer);

  // 同步给前端一张表预览
  const table: ChatTableView = {
    title,
    total: flat.length,
    tree: isTree,
    columns: columns.map((c) => ({ key: c.key, title: c.title })),
    rows: flat.slice(0, 200).map((r) => {
      const row: Record<string, string | number | undefined> = { _depth: Number(r._depth || 0) };
      for (const c of columns) {
        const v = (r as Record<string, unknown>)[c.key];
        row[c.key] = v == null ? "" : String(v);
      }
      return row;
    }),
    footer: footer || undefined,
  };

  let file: ChatFileRef;
  if (format === "pdf") {
    const bytes = await bufferFromPdf(title, columns, flat, footer);
    file = saveDownload({
      name: `${fileBase}.pdf`,
      mimeType: "application/pdf",
      kind: "pdf",
      bytes,
    });
  } else {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(title.slice(0, 28) || "Sheet1");
    ws.columns = columns.map((c) => ({ header: c.title, key: c.key, width: 18 }));
    for (const r of flat) {
      const depth = Number(r._depth || 0);
      const rowData: Record<string, unknown> = {};
      columns.forEach((c, i) => {
        let v = (r as Record<string, unknown>)[c.key];
        if (i === 0 && depth > 0) v = `${"  ".repeat(depth)}└ ${v ?? ""}`;
        rowData[c.key] = v ?? "";
      });
      ws.addRow(rowData);
    }
    if (footer) {
      const fr: Record<string, unknown> = {};
      for (const c of columns) fr[c.key] = footer[c.key] ?? "";
      const excelRow = ws.addRow(fr);
      excelRow.font = { bold: true };
    }
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    file = saveDownload({
      name: `${fileBase}.xlsx`,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      kind: "xlsx",
      bytes: buf,
    });
  }

  // 附带 markdown 摘要，方便模型叙述
  const md = execRenderTable({
    title,
    columns,
    data: flat.slice(0, 20),
    tree: isTree,
    footer: footer || undefined,
    maxRows: 20,
  });

  return [
    "UI_TABLE",
    JSON.stringify(table),
    "UI_FILE",
    JSON.stringify(file),
    "",
    `已生成 ${file.kind.toUpperCase()}：${file.name}（${file.size} bytes）。`,
    "聊天界面可预览表格" + (file.kind === "pdf" ? "/PDF" : "") + "，并可下载。",
    "",
    md,
  ].join("\n");
}
