import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "./store-util.js";

// 聊天上传落盘存储：图片（走 vision 通道）与文档附件（PDF/Word/Excel/md/txt/csv，解析后注入上下文）
// 同库同 TTL，落盘 .data/uploads/，7 天过期，不落库。会话只引用 id，内容在请求时读盘使用。

const UPLOAD_DIR = resolve(DATA_DIR, "uploads");
const FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_AT_ONCE = 4;

// 允许的类型 → 落盘扩展名（校验与命名同源，避免两处维护）。
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
// 文档类附件：聊天里随手贴的 PDF / Word / Excel / Markdown / 纯文本 / CSV，
// 解析后作为本轮临时上下文注入（对齐 CodeBuddy「贴文档即读」）。
const DOC_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/markdown": "md",
  "text/plain": "txt",
  "text/csv": "csv",
};
const ACCEPTED_EXT: Record<string, string> = { ...IMAGE_EXT, ...DOC_EXT };
/** 扩展名 → media type（重启重建内存索引时用；图片与文档都要覆盖，否则重启后文档附件会丢失）。 */
const MEDIA_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  md: "text/markdown", txt: "text/plain", csv: "text/csv",
};
/** 文件名后缀 → 落盘扩展名（jpeg 归一成 jpg）。键集与 MEDIA_BY_EXT 一致，不再手抄一份。 */
const EXT_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.keys(MEDIA_BY_EXT).map((ext) => [ext, ext]),
);

/**
 * 推断落盘扩展名。浏览器上报的 type 可伪造（evil.html + image/png），文件名带后缀时以后缀为准，
 * 后缀不在白名单就拒收；只有没有后缀（如剪贴板粘贴）时才看 type。
 */
function resolveExt(name: string, type: string): string | null {
  const base = String(name || "").split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot > 0) return EXT_BY_NAME[base.slice(dot + 1).toLowerCase()] || null;
  const t = (type || "").split(";")[0].trim().toLowerCase();
  return ACCEPTED_EXT[t] || null;
}

/** 图片按文件头核对：扩展名对了但内容不是图片的，不当图片存。 */
function imageSignatureOk(ext: string, data: Buffer): boolean {
  if (ext === "png") return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === "jpg" || ext === "jpeg") return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (ext === "webp") return data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP";
  return true;
}

interface StoredUpload {
  id: string;
  mediaType: string;
  size: number;
  createdAt: number;
  path: string;
  name: string;
}

const store = new Map<string, StoredUpload>();

// 进程重启后内存索引丢失：启动时扫描落盘目录重建，保证聊天记录里的图片/文档附件仍可读取。
function rebuildIndex() {
  try {
    if (!existsSync(UPLOAD_DIR)) return;
    for (const entry of readdirSync(UPLOAD_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const match = entry.name.match(/^([0-9a-f-]{36})\.([a-z0-9]+)$/i);
      if (!match) continue;
      const id = match[1].toLowerCase();
      const ext = match[2].toLowerCase();
      const mediaType = MEDIA_BY_EXT[ext];
      if (!mediaType || store.has(id)) continue;
      const path = resolve(UPLOAD_DIR, entry.name);
      const stat = statSync(path);
      if (stat.size > MAX_FILE_BYTES) continue;
      store.set(id, { id, mediaType, size: stat.size, createdAt: stat.mtimeMs, path, name: `upload.${ext}` });
    }
  } catch {
    /* 目录不可读时忽略，上传功能不受影响 */
  }
}
rebuildIndex();

function drop(id: string, path: string) {
  store.delete(id);
  try {
    rmSync(path, { force: true });
  } catch {
    /* 忽略删除失败 */
  }
}

// 惰性清理：按时间间隔节流（不是按条目数取模 —— 删除会改变条目数，取模几乎永远不命中）。
const PRUNE_INTERVAL_MS = 10 * 60_000;
let lastPruneAt = 0;
function lazyPrune() {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  for (const [id, item] of store) {
    if (now - item.createdAt > FILE_TTL_MS) drop(id, item.path);
  }
}

export async function saveUpload(file: {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}): Promise<{ id: string; name: string; size: number }> {
  lazyPrune();
  const ext = resolveExt(file.name, file.type);
  if (!ext) {
    throw new Error(
      `不支持的文件类型：${file.name || (file.type || "").split(";")[0] || "未知"}（支持 png/jpeg/webp/pdf/docx/xlsx/md/txt/csv）`,
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），单文件不超过 ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)}MB`);
  }
  const data = Buffer.from(await file.arrayBuffer());
  if (!imageSignatureOk(ext, data)) throw new Error(`文件内容不是 ${ext} 图片`);
  const id = randomUUID();
  const path = resolve(UPLOAD_DIR, `${id}.${ext}`);
  try {
    mkdirSync(UPLOAD_DIR, { recursive: true });
    writeFileSync(path, data);
  } catch (error) {
    console.error("[upload] 落盘失败:", error);
    throw new Error("文件保存失败");
  }
  // 只认白名单扩展名对应的类型：浏览器上报的 type 可伪造（x.txt + text/html），读回时会按它当 Content-Type 同源返回。
  const mediaType = MEDIA_BY_EXT[ext] || "application/octet-stream";
  store.set(id, { id, mediaType, size: file.size, createdAt: Date.now(), path, name: file.name || `upload.${ext}` });
  return { id, name: file.name || `upload.${ext}`, size: file.size };
}

/** 聊天记录文件读取（图片与文档附件同库）：保留 7 天，直接返回字节供 GET 端点输出。 */
export function getUploadImage(id: string): { mediaType: string; data: Buffer } | null {
  const item = store.get(id);
  if (!item) return null;
  if (Date.now() - item.createdAt > FILE_TTL_MS) {
    drop(id, item.path);
    return null;
  }
  try {
    if (!existsSync(item.path)) return null;
    return { mediaType: item.mediaType, data: readFileSync(item.path) };
  } catch {
    return null;
  }
}

/**
 * 读取一个已上传的文档附件原文（聊天里随手贴的 PDF / Word / Excel 等）。
 * 仅供本轮解析为文本注入上下文用；图片走 getUploadImage。
 */
export function getUploadFile(id: string): { id: string; name: string; mediaType: string; path: string } | null {
  const item = store.get(id);
  if (!item) return null;
  if (Date.now() - item.createdAt > FILE_TTL_MS) {
    drop(id, item.path);
    return null;
  }
  try {
    if (!existsSync(item.path)) return null;
  } catch {
    return null;
  }
  return { id, name: item.name, mediaType: item.mediaType, path: item.path };
}

export { MAX_AT_ONCE };
