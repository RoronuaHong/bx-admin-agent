import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatFileRef } from "@bx/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOWNLOAD_DIR = resolve(__dirname, "..", ".data", "downloads");
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 20 * 1024 * 1024;

interface StoredDownload {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: ChatFileRef["kind"];
  createdAt: number;
  path: string;
}

const store = new Map<string, StoredDownload>();

function ensureDir() {
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

function extOf(kind: ChatFileRef["kind"], name: string): string {
  if (kind === "xlsx") return "xlsx";
  if (kind === "pdf") return "pdf";
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "bin";
}

function rebuildIndex() {
  try {
    if (!existsSync(DOWNLOAD_DIR)) return;
    for (const entry of readdirSync(DOWNLOAD_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const match = entry.name.match(/^([0-9a-f-]{36})\.(xlsx|pdf|bin)$/i);
      if (!match) continue;
      const id = match[1].toLowerCase();
      const ext = match[2].toLowerCase();
      const path = resolve(DOWNLOAD_DIR, entry.name);
      const stat = statSync(path);
      if (Date.now() - stat.mtimeMs > TTL_MS) {
        try {
          rmSync(path);
        } catch {
          /* ignore */
        }
        continue;
      }
      const kind: ChatFileRef["kind"] = ext === "xlsx" ? "xlsx" : ext === "pdf" ? "pdf" : "other";
      const mimeType =
        kind === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : kind === "pdf"
            ? "application/pdf"
            : "application/octet-stream";
      store.set(id, {
        id,
        name: `export.${ext}`,
        mimeType,
        size: stat.size,
        kind,
        createdAt: stat.mtimeMs,
        path,
      });
    }
  } catch {
    /* ignore */
  }
}

rebuildIndex();

export function saveDownload(input: {
  name: string;
  mimeType: string;
  kind: ChatFileRef["kind"];
  bytes: Buffer;
}): ChatFileRef {
  if (input.bytes.length > MAX_BYTES) {
    throw new Error(`文件过大（>${MAX_BYTES} bytes）`);
  }
  ensureDir();
  const id = randomUUID();
  const ext = extOf(input.kind, input.name);
  const path = resolve(DOWNLOAD_DIR, `${id}.${ext}`);
  writeFileSync(path, input.bytes);
  const rec: StoredDownload = {
    id,
    name: input.name,
    mimeType: input.mimeType,
    size: input.bytes.length,
    kind: input.kind,
    createdAt: Date.now(),
    path,
  };
  store.set(id, rec);
  return toFileRef(rec);
}

export function getDownload(id: string): StoredDownload | null {
  const rec = store.get(id);
  if (!rec) {
    rebuildIndex();
    return store.get(id) || null;
  }
  if (Date.now() - rec.createdAt > TTL_MS) {
    try {
      rmSync(rec.path);
    } catch {
      /* ignore */
    }
    store.delete(id);
    return null;
  }
  return rec;
}

export function readDownloadBytes(id: string): { rec: StoredDownload; bytes: Buffer } | null {
  const rec = getDownload(id);
  if (!rec || !existsSync(rec.path)) return null;
  return { rec, bytes: readFileSync(rec.path) };
}

export function toFileRef(rec: StoredDownload): ChatFileRef {
  const url = `/chat/download/${rec.id}`;
  return {
    id: rec.id,
    name: rec.name,
    mimeType: rec.mimeType,
    size: rec.size,
    kind: rec.kind,
    url,
    previewUrl: rec.kind === "pdf" ? url : undefined,
  };
}
