import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 聊天图片存储：落盘 .data/uploads/，7 天 TTL，不落库。
// 会话只引用 id，内容在请求时读盘使用。

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = resolve(__dirname, "..", ".data", "uploads");
const IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_AT_ONCE = 4;

// 允许的类型 → 落盘扩展名（校验与命名同源，避免两处维护）。
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

// 扩展名 → 类型映射（重建内存索引用）。
const EXT_MEDIA: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

interface StoredUpload {
  id: string;
  mediaType: string;
  size: number;
  createdAt: number;
  path: string;
}

const store = new Map<string, StoredUpload>();

// 进程重启后内存索引丢失：启动时扫描落盘目录重建，保证聊天记录里的图片仍可读取。
function rebuildIndex() {
  try {
    if (!existsSync(UPLOAD_DIR)) return;
    for (const entry of readdirSync(UPLOAD_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const match = entry.name.match(/^([0-9a-f-]{36})\.([a-z0-9]+)$/i);
      if (!match) continue;
      const id = match[1].toLowerCase();
      const mediaType = EXT_MEDIA[match[2].toLowerCase()];
      if (!mediaType || store.has(id)) continue;
      const path = resolve(UPLOAD_DIR, entry.name);
      const stat = statSync(path);
      if (stat.size > MAX_FILE_BYTES) continue;
      store.set(id, { id, mediaType, size: stat.size, createdAt: stat.mtimeMs, path });
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

// 惰性清理：每次写入/读取时顺带清理过期项。
function lazyPrune() {
  if (!store.size || store.size % 16 !== 0) return;
  const now = Date.now();
  for (const [id, item] of store) {
    if (now - item.createdAt > IMAGE_TTL_MS) drop(id, item.path);
  }
}

export async function saveUpload(file: {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}): Promise<{ id: string; name: string; size: number }> {
  lazyPrune();
  const mediaType = file.type.split(";")[0].trim().toLowerCase();
  const ext = IMAGE_EXT[mediaType];
  if (!ext) {
    throw new Error(`不支持的文件类型：${mediaType || file.name || "未知"}（支持 png/jpeg/webp）`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），单文件不超过 2MB`);
  }
  const id = randomUUID();
  const path = resolve(UPLOAD_DIR, `${id}.${ext}`);
  mkdirSync(UPLOAD_DIR, { recursive: true });
  writeFileSync(path, Buffer.from(await file.arrayBuffer()));
  store.set(id, { id, mediaType, size: file.size, createdAt: Date.now(), path });
  return { id, name: file.name || `upload.${ext}`, size: file.size };
}

/** 聊天记录图片读取：图片保留 7 天，直接返回字节供 GET 端点输出。 */
export function getUploadImage(id: string): { mediaType: string; data: Buffer } | null {
  const item = store.get(id);
  if (!item) return null;
  if (Date.now() - item.createdAt > IMAGE_TTL_MS) {
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

export { MAX_AT_ONCE };
