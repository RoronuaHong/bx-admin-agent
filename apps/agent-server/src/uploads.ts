import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 聊天上传落盘存储：图片（走 vision 通道）与文档附件（PDF/Word/Excel/md/txt/csv，解析后注入上下文）
// 同库同 TTL，落盘 .data/uploads/，7 天过期，不落库。会话只引用 id，内容在请求时读盘使用。

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = resolve(__dirname, "..", ".data", "uploads");
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

/** 由浏览器给的 type / 文件名推断落盘扩展名；type 不可靠时回退到文件名后缀。 */
function resolveExt(name: string, type: string): string | null {
  const t = (type || "").split(";")[0].trim().toLowerCase();
  if (ACCEPTED_EXT[t]) return ACCEPTED_EXT[t];
  const ext = (name.split(".").pop() || "").toLowerCase();
  return EXT_BY_NAME[ext] || null;
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
      `不支持的文件类型：${(file.type || "").split(";")[0] || file.name || "未知"}（支持 png/jpeg/webp/pdf/docx/xlsx/md/txt/csv）`,
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），单文件不超过 ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)}MB`);
  }
  const id = randomUUID();
  const path = resolve(UPLOAD_DIR, `${id}.${ext}`);
  mkdirSync(UPLOAD_DIR, { recursive: true });
  writeFileSync(path, Buffer.from(await file.arrayBuffer()));
  const mediaType = (file.type || "").split(";")[0].trim().toLowerCase() || MEDIA_BY_EXT[ext] || "application/octet-stream";
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
