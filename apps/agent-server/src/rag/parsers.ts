// 文档解析（RAG 接入层）：按扩展名分发的解析器注册表。
// 设计要点（对齐 agent-infrastructure §7）：
//   - 纯文本类（md/txt/csv/log/json/yaml）与 html 零依赖内置解析；
//   - pdf / docx / xlsx 走**可选依赖**：装了就用（动态 import），没装如实回报「未安装解析器」，
//     不静默跳过也不假装解析成功 —— 这样加格式只需装依赖，不改代码；
//   - 二进制文件（图片/视频/压缩包等）禁止直接按 utf8 读：先嗅探，命中即拒绝。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export interface ParsedDoc {
  title: string;
  text: string;
}

const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".csv", ".log", ".json", ".yaml", ".yml", ".ini", ".conf"]);
const HTML_EXT = new Set([".html", ".htm", ".xhtml"]);
const PDF_EXT = new Set([".pdf"]);
const DOCX_EXT = new Set([".docx"]);
const XLSX_EXT = new Set([".xlsx", ".xlsm"]);

/** 可选解析依赖：包装包名 → 该格式的可读名称（用于降级提示）。 */
const OPTIONAL_DEPS: Record<string, string> = {
  unpdf: "pdf",
  mammoth: "docx",
  exceljs: "xlsx",
};

/** 该扩展名是否被支持（不支持 ≠ 能解析：pdf/docx/xlsx 还要看依赖是否装了）。 */
export function isSupportedExt(ext: string): boolean {
  const e = ext.toLowerCase();
  return TEXT_EXT.has(e) || HTML_EXT.has(e) || PDF_EXT.has(e) || DOCX_EXT.has(e) || XLSX_EXT.has(e);
}

/** 可选依赖是否可用（同步探测：只看包能否被解析到，不实际加载）。 */
export function optionalDepInstalled(pkg: string): boolean {
  try {
    createRequire(import.meta.url).resolve(pkg);
    return true;
  } catch {
    return false;
  }
}

/** 动态加载可选依赖（失败返回 null，由调用方降级）。 */
async function loadOptional(pkg: string): Promise<any | null> {
  try {
    // 用变量 specifier 避免 TS 对未安装模块做静态解析（未装也能编译通过）。
    const specifier = pkg;
    return await import(specifier);
  } catch {
    return null;
  }
}

/** 二进制嗅探：前 4KB 里出现 NUL 字节或大量非文本字节即判定二进制。 */
export function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(4096, buf.length));
  if (!sample.length) return false;
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length > 0.3;
}

/** 去掉 HTML 标签/脚本/样式，保留可读文本。 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 取标题：优先首个 Markdown/HTML 标题，回退文件名（去扩展名）。 */
export function titleOf(text: string, fallback: string): string {
  const md = text.match(/^\s*#{1,6}\s+(.+)$/m);
  if (md?.[1]?.trim()) return md[1].trim();
  const line = text.split(/\r?\n/).find((l) => l.trim());
  if (line && line.trim().length <= 60) return line.trim();
  return fallback;
}

async function parsePdf(buf: Buffer): Promise<{ text: string } | { error: string }> {
  const mod = await loadOptional("unpdf");
  if (!mod) return { error: "未安装 pdf 解析器（pnpm add unpdf 后即可入库）" };
  const data = await (mod.extractText ? mod.extractText(new Uint8Array(buf)) : null);
  const text = typeof data?.text === "string"
    ? data.text
    : Array.isArray(data?.text)
      ? data.text.join("\n")
      : Array.isArray(data)
        ? data.join("\n")
        : "";
  if (!text.trim()) return { error: "pdf 未提取到文本（可能是扫描件/图片型 PDF）" };
  return { text };
}

async function parseDocx(buf: Buffer): Promise<{ text: string } | { error: string }> {
  const mod = await loadOptional("mammoth");
  if (!mod) return { error: "未安装 docx 解析器（pnpm add mammoth 后即可入库）" };
  const res = await mod.extractRawText({ buffer: buf });
  const text = String(res?.value || "").trim();
  if (!text) return { error: "docx 未提取到文本" };
  return { text };
}

async function parseXlsx(absPath: string): Promise<{ text: string } | { error: string }> {
  const mod = await loadOptional("exceljs");
  if (!mod) return { error: "未安装 xlsx 解析器（pnpm add exceljs 后即可入库）" };
  const workbook = new mod.Workbook();
  await workbook.xlsx.readFile(absPath);
  const lines: string[] = [];
  workbook.eachSheet((sheet: any) => {
    lines.push(`# ${sheet.name}`);
    sheet.eachRow((row: any) => {
      const cells = (row.values || []).slice(1).map((v: any) => {
        if (v && typeof v === "object" && "text" in v) return String(v.text ?? "");
        if (v && typeof v === "object" && "result" in v) return String(v.result ?? "");
        return v == null ? "" : String(v);
      });
      const line = cells.join(" | ").replace(/\s*\|\s*(\|\s*)*$/, "").trim();
      if (line) lines.push(line);
    });
  });
  const text = lines.join("\n").trim();
  if (!text) return { error: "xlsx 未提取到内容" };
  return { text };
}

/** 解析单个文件：返回文本与标题，或一条可展示的失败原因（不抛异常）。 */
export async function parseFile(absPath: string): Promise<ParsedDoc | { error: string }> {
  const ext = path.extname(absPath).toLowerCase();
  if (!isSupportedExt(ext)) return { error: `不支持的格式：${ext || "（无扩展名）"}` };
  let buf: Buffer;
  try {
    buf = fs.readFileSync(absPath);
  } catch (err) {
    return { error: `读取失败：${String((err as Error)?.message || err)}` };
  }
  // 二进制禁止直接当文本读（pdf/docx/xlsx 本身是压缩包形态，走各自解析器，不在这里嗅探）。
  if (!PDF_EXT.has(ext) && !DOCX_EXT.has(ext) && !XLSX_EXT.has(ext) && looksBinary(buf)) {
    return { error: "疑似二进制文件，已跳过（禁止按文本直读）" };
  }
  const fallbackTitle = path.basename(absPath, ext);
  let text = "";
  try {
    if (PDF_EXT.has(ext)) {
      const res = await parsePdf(buf);
      if ("error" in res) return res;
      text = res.text;
    } else if (DOCX_EXT.has(ext)) {
      const res = await parseDocx(buf);
      if ("error" in res) return res;
      text = res.text;
    } else if (XLSX_EXT.has(ext)) {
      const res = await parseXlsx(absPath);
      if ("error" in res) return res;
      text = res.text;
    } else if (HTML_EXT.has(ext)) {
      text = stripHtml(buf.toString("utf8"));
    } else {
      text = buf.toString("utf8");
    }
  } catch (err) {
    // 解析器自身抛出的异常（坏文件结构、加密文档、依赖内部错误等）不能穿透出去：
    // 入库脚本是**扫目录批处理**的，一个文件抛异常会中断整次入库；而本函数的契约是
    // 「返回文本，或一条可展示的失败原因（不抛异常）」。实测踩到：一个结构损坏的 pdf 让入库直接崩。
    return { error: `${ext.slice(1) || "文件"} 解析失败：${String((err as Error)?.message || err)}` };
  }
  if (!text.trim()) return { error: "文件内容为空" };
  return { title: titleOf(text, fallbackTitle), text };
}
