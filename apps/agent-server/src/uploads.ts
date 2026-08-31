import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 上传文件/图片存储：落盘 .data/uploads/，按 TTL 过期清理，不落库。
// 会话聊天只引用 id，内容在请求时读盘使用。
// 图片 TTL 较长（7 天）：聊天记录里要长期展示；文本文件仅当次使用（10 分钟）。

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = resolve(__dirname, "..", ".data", "uploads");
const TTL_MS = 10 * 60 * 1000;
const IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_AT_ONCE = 4;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "application/yaml",
]);

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
const TEXT_EXT: Record<string, string> = {
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "application/xml": "xml",
  "application/yaml": "yaml",
};

// 扩展名 → 类型映射（重建内存索引用）。
const EXT_MEDIA: Record<string, { kind: "image" | "text"; mediaType: string }> = {
  png: { kind: "image", mediaType: "image/png" },
  jpg: { kind: "image", mediaType: "image/jpeg" },
  jpeg: { kind: "image", mediaType: "image/jpeg" },
  webp: { kind: "image", mediaType: "image/webp" },
  txt: { kind: "text", mediaType: "text/plain" },
  md: { kind: "text", mediaType: "text/markdown" },
  csv: { kind: "text", mediaType: "text/csv" },
  json: { kind: "text", mediaType: "application/json" },
  xml: { kind: "text", mediaType: "application/xml" },
  yaml: { kind: "text", mediaType: "application/yaml" },
};

interface StoredUpload {
  id: string;
  kind: "image" | "text";
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
      const ext = match[2].toLowerCase();
      const meta = EXT_MEDIA[ext];
      if (!meta || store.has(id)) continue;
      const path = resolve(UPLOAD_DIR, entry.name);
      const stat = statSync(path);
      if (stat.size > MAX_FILE_BYTES) continue;
      store.set(id, {
        id,
        kind: meta.kind,
        mediaType: meta.mediaType,
        size: stat.size,
        createdAt: stat.mtimeMs,
        path,
      });
    }
  } catch {
    /* 目录不可读时忽略，上传功能不受影响 */
  }
}
rebuildIndex();

function pruneExpired() {
  const now = Date.now();
  for (const [id, item] of store) {
    const ttl = item.kind === "image" ? IMAGE_TTL_MS : TTL_MS;
    if (now - item.createdAt > ttl) {
      store.delete(id);
      try {
        rmSync(item.path, { force: true });
      } catch {
        /* 忽略删除失败 */
      }
    }
  }
}

// 惰性清理：每次写入/读取时顺带清理过期项。
function lazyPrune() {
  if (store.size > 0 && store.size % 16 === 0) pruneExpired();
}

export async function saveUpload(file: {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}): Promise<{ id: string; name: string; size: number; kind: "image" | "text" }> {
  lazyPrune();
  const mediaType = file.type.split(";")[0].trim().toLowerCase();
  let kind: "image" | "text" | null = null;
  let ext = "";
  if (IMAGE_TYPES.has(mediaType)) {
    kind = "image";
    ext = IMAGE_EXT[mediaType];
  } else if (TEXT_TYPES.has(mediaType)) {
    kind = "text";
    ext = TEXT_EXT[mediaType];
  } else {
    const fallback = (file.name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
    if (fallback === "txt" || fallback === "md" || fallback === "csv") {
      kind = "text";
      ext = fallback;
    }
  }
  if (!kind) {
    throw new Error(`不支持的文件类型：${mediaType || file.name || "未知"}（支持 png/jpeg/webp、txt/md/json/csv）`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），单文件不超过 2MB`);
  }
  const id = randomUUID();
  const path = resolve(UPLOAD_DIR, `${id}.${ext}`);
  mkdirSync(UPLOAD_DIR, { recursive: true });
  writeFileSync(path, Buffer.from(await file.arrayBuffer()));
  store.set(id, { id, kind, mediaType, size: file.size, createdAt: Date.now(), path });
  return { id, name: file.name || `upload.${ext}`, size: file.size, kind };
}

export function getUpload(id: string): { kind: "image"; mediaType: string; base64: string } | { kind: "text"; text: string } | null {
  const item = store.get(id);
  if (!item) return null;
  const ttl = item.kind === "image" ? IMAGE_TTL_MS : TTL_MS;
  if (Date.now() - item.createdAt > ttl) {
    store.delete(id);
    try {
      rmSync(item.path, { force: true });
    } catch {
      /* 忽略 */
    }
    return null;
  }
  try {
    if (!existsSync(item.path)) return null;
    if (item.kind === "image") {
      return { kind: "image", mediaType: item.mediaType, base64: readFileSync(item.path).toString("base64") };
    }
    return { kind: "text", text: readFileSync(item.path, "utf-8") };
  } catch {
    return null;
  }
}

// 聊天记录图片读取：图片文件长期保留（7 天），直接返回字节供 GET 端点输出。
export function getUploadImage(id: string): { mediaType: string; data: Buffer } | null {
  const item = store.get(id);
  if (!item || item.kind !== "image") return null;
  if (Date.now() - item.createdAt > IMAGE_TTL_MS) {
    store.delete(id);
    try {
      rmSync(item.path, { force: true });
    } catch {
      /* 忽略 */
    }
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