// RAG 存储：统一承载本地文档入库，提供混合检索（词法 TF-IDF + 向量余弦，RRF 融合）。
// 设计取舍（对齐 agent-infrastructure §7）：
//   - 小数据/实时数据不入库，由模型直接调工具取；大文档库才入库切片；
//   - 词法 + 向量双路召回，RRF 融合（1/(60+rank)）；embedding 不可用自动降级纯词法，不报错；
//   - 结果带 source/title/score，供模型给出可点击来源（答案可溯源）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isEmbeddingEnabled,
  embedText,
  embedTextsBatched,
  cosineSimilarity,
  type EmbeddingResult,
} from "./embedding.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAG_DIR = path.resolve(__dirname, "..", "..", ".data", "rag");
const INDEX_PATH = path.join(RAG_DIR, "index.json");
const VECTORS_PATH = path.join(RAG_DIR, "vectors.json");

const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 120;

/**
 * 文档级访问控制（权限过滤，§知识库 F15）。
 * 字段都可选、且**缺省 = 公开**：老索引没有 ACL 也能继续检索（不重建即丢数据）。
 * 两个维度是「与」关系：同时给了 owners 与 roles，两个都要命中才可见。
 */
export interface RagAcl {
  /** 允许查看的设备 owner 标注（与对话/记忆同口径的 ownerKey）。 */
  owners?: string[];
  /** 允许查看的角色（namespace / agentId）。 */
  roles?: string[];
}

/** 检索者的身份：两维都可缺省，缺省即「没有该维度的身份」。 */
export interface RagViewer {
  ownerKey?: string;
  role?: string;
}

export interface RagDoc {
  id: string;
  title: string;
  source: string;
  text: string;
  updatedAt: number;
  /** 内容指纹（md5）：增量入库用，未变则跳过重建。 */
  hash?: string;
  /** 命名空间（按角色隔离）：默认 "generic"。检索/列举按命名空间过滤，避免某角色语料对其它角色可见。 */
  namespace?: string;
  /** 文档级访问控制；缺省 = 公开可见。 */
  acl?: RagAcl;
}

/** 命名空间匹配：历史文档未打 namespace 一律归 generic（向后兼容旧索引，避免重建即丢检索）。 */
function matchesNamespace(doc: RagDoc, namespace: string): boolean {
  if (doc.namespace) return doc.namespace === namespace;
  return namespace === "generic";
}

/**
 * 文档对当前检索者是否可见（纯函数，便于单测）。
 * 取向是**缺省放行、显式收敛**：没写 ACL 的文档谁都能检索到；
 * 写了就必须命中，命中不了就看不见——而不是「猜一下给不给看」。
 */
export function visibleTo(doc: RagDoc, viewer?: RagViewer): boolean {
  const acl = doc.acl;
  if (!acl) return true;
  const owners = (acl.owners || []).filter(Boolean);
  const roles = (acl.roles || []).filter(Boolean);
  if (owners.length && !(viewer?.ownerKey && owners.includes(viewer.ownerKey))) return false;
  if (roles.length && !(viewer?.role && roles.includes(viewer.role))) return false;
  return true;
}

/**
 * 读路径（检索/列来源）的命名空间解析：角色**专属语料为空** → 回落公共语料（generic）。
 *
 * 为什么需要：隔离的初衷（领域适配指南 §13）是「领域语料不得泄漏给通用助手」——方向是
 * generic 检索不带其它角色语料；反过来，暂无专属语料的角色（如客服助手，制度/FAQ 语料
 * 都在公共库）检索自己的空命名空间等于功能缺失。回落是**整体**的（不做逐条合并）：
 * 角色一旦入库专属语料即停用回落，届时若需「专属+公共」混排再单独立项。
 * 写路径（sourceHashes）**不**走这里：入库脚本的增量指纹必须只看本命名空间，
 * 否则 --namespace X 首次入库会被 generic 的同源指纹跳过。
 */
function effectiveNamespace(namespace: string): string {
  if (!namespace || namespace === "generic") return "generic";
  const hasOwn = loadIndex().docs.some((d) => matchesNamespace(d, namespace));
  return hasOwn ? namespace : "generic";
}

interface RagIndex {
  updatedAt: number;
  docs: RagDoc[];
}

let indexCache: RagIndex | null = null;
let vectorCache: { model: string; dim: number; vectors: Record<string, number[]> } | null = null;

/** 测试/重建用：清掉进程内缓存（下次访问重新读盘）。 */
export function resetCache(): void {
  indexCache = null;
  vectorCache = null;
}

/** 覆盖数据目录（仅测试用）。 */
export function setRagDirForTest(dir: string): void {
  (globalThis as Record<string, unknown>).__RAG_DIR__ = dir;
}

function ragDir(): string {
  return String((globalThis as Record<string, unknown>).__RAG_DIR__ || RAG_DIR);
}
function indexPath(): string {
  return path.join(ragDir(), "index.json");
}
function vectorsPath(): string {
  return path.join(ragDir(), "vectors.json");
}

// 进程内缓存按**文件 mtime + size** 失效（§14.2 同一口径）：入库脚本是独立进程，改完索引后正在运行的服务
// 无需重启即可看到新文档（否则「入库成功但检索不到」）。只看 mtime 有同毫秒竞态——
// 同一毫秒内改写且长度变化时感知不到；size 参与失效后即可命中，代价仅一次 statSync（本来就在做）。
let indexStamp = "";
let vectorStamp = "";

function fileStamp(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-1:-1";
  }
}

function loadIndex(): RagIndex {
  const stamp = fileStamp(indexPath());
  if (indexCache && stamp === indexStamp) return indexCache;
  try {
    if (fs.existsSync(indexPath())) {
      indexCache = JSON.parse(fs.readFileSync(indexPath(), "utf8")) as RagIndex;
      indexStamp = stamp;
      return indexCache;
    }
  } catch (err) {
    console.warn(`[rag] 索引读取失败：${String((err as Error)?.message || err)}`);
  }
  indexCache = { updatedAt: 0, docs: [] };
  indexStamp = stamp;
  return indexCache;
}

function saveIndex(idx: RagIndex): void {
  indexCache = idx;
  try {
    fs.mkdirSync(ragDir(), { recursive: true });
    const file = indexPath();
    fs.writeFileSync(file, JSON.stringify(idx), "utf8");
    indexStamp = fileStamp(file);
  } catch (err) {
    console.warn(`[rag] 索引写入失败：${String((err as Error)?.message || err)}`);
  }
}

function loadVectors() {
  const stamp = fileStamp(vectorsPath());
  if (vectorCache && stamp === vectorStamp) return vectorCache;
  try {
    if (fs.existsSync(vectorsPath())) {
      vectorCache = JSON.parse(fs.readFileSync(vectorsPath(), "utf8")) as typeof vectorCache;
      vectorStamp = stamp;
      return vectorCache;
    }
  } catch {
    /* 缓存损坏：按空处理，下次入库重建 */
  }
  vectorCache = { model: "", dim: 0, vectors: {} };
  vectorStamp = stamp;
  return vectorCache;
}

function saveVectors(): void {
  if (!vectorCache) return;
  try {
    fs.mkdirSync(ragDir(), { recursive: true });
    const file = vectorsPath();
    fs.writeFileSync(file, JSON.stringify(vectorCache), "utf8");
    vectorStamp = fileStamp(file);
  } catch {
    /* 写失败不影响检索（降级词法） */
  }
}

/** 按段落/长度切片：优先按空行与换行切，保证语义完整。 */
export function chunkText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const parts = clean.split(/(?<=\n)\s*\n|\n/).filter((s) => s.trim());
  const chunks: string[] = [];
  let buf = "";
  for (const p of parts) {
    if ((buf + p).length > size && buf) {
      chunks.push(buf.trim());
      buf = buf.slice(Math.max(0, buf.length - overlap));
    }
    buf += (buf ? "\n" : "") + p;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.filter(Boolean);
}

export interface IngestInput {
  id: string;
  title: string;
  source: string;
  text: string;
  hash?: string;
  /** 命名空间（按角色隔离），默认 "generic"。 */
  namespace?: string;
  /** 文档级访问控制；缺省 = 公开可见。 */
  acl?: RagAcl;
}

/** 入库：同 id 覆盖、其余保留；返回新增/更新的切片数。 */
export async function ingest(inputs: IngestInput[]): Promise<number> {
  const idx = loadIndex();
  const now = Date.now();
  const added: RagDoc[] = [];
  for (const input of inputs) {
    const ns = input.namespace || "generic";
    const chunks = chunkText(input.text);
    chunks.forEach((text, i) => {
      added.push({
        id: `${input.id}#${i}`,
        title: input.title,
        source: input.source,
        text,
        updatedAt: now,
        namespace: ns,
        ...(input.hash ? { hash: input.hash } : {}),
        ...(input.acl ? { acl: input.acl } : {}),
      });
    });
  }
  const byId = new Map(idx.docs.map((d) => [d.id, d]));
  for (const d of added) byId.set(d.id, d);
  const next = { updatedAt: now, docs: [...byId.values()] };
  saveIndex(next);
  const addedIds = new Set(added.map((d) => d.id));
  await buildVectors(next.docs.filter((d) => addedIds.has(d.id)));
  return added.length;
}

/** 增量依据：source → 内容指纹。构建脚本据此跳过未变更文件。可限定命名空间。 */
export function sourceHashes(namespace?: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const d of loadIndex().docs) {
    if (namespace && !matchesNamespace(d, namespace)) continue;
    if (d.hash && !map.has(d.source)) map.set(d.source, d.hash);
  }
  return map;
}

async function buildVectors(docs: RagDoc[]): Promise<void> {
  if (!docs.length || !isEmbeddingEnabled()) return;
  const cache = loadVectors()!;
  try {
    const res: EmbeddingResult[] = await embedTextsBatched(docs.map((d) => `${d.title}\n${d.text}`));
    for (let i = 0; i < docs.length; i++) {
      const vec = res[i]?.vector;
      if (vec?.length) {
        cache.model = res[i]?.model || cache.model;
        cache.dim = vec.length;
        cache.vectors[docs[i]!.id] = vec;
      }
    }
    saveVectors();
  } catch (err) {
    console.warn(`[rag] 向量化失败，降级纯词法：${String((err as Error)?.message || err)}`);
  }
}

/** 删除某个来源（含其全部切片），返回删除条数。 */
export function removeSource(source: string): number {
  const idx = loadIndex();
  const before = idx.docs.length;
  const docs = idx.docs.filter((d) => d.source !== source);
  saveIndex({ updatedAt: Date.now(), docs });
  const cache = loadVectors();
  if (cache) {
    const prefix = `${source}#`;
    for (const k of Object.keys(cache.vectors)) if (k.startsWith(prefix)) delete cache.vectors[k];
    saveVectors();
  }
  return before - docs.length;
}

/** 清空全部（重建前用）。 */
export function clearAll(): number {
  const idx = loadIndex();
  const n = idx.docs.length;
  saveIndex({ updatedAt: Date.now(), docs: [] });
  vectorCache = { model: "", dim: 0, vectors: {} };
  saveVectors();
  return n;
}

export function listSources(
  namespace?: string,
  viewer?: RagViewer,
): Array<{ source: string; title: string; chunks: number }> {
  const map = new Map<string, { source: string; title: string; chunks: number }>();
  const ns = namespace ? effectiveNamespace(namespace) : "";
  for (const d of loadIndex().docs) {
    if (ns && !matchesNamespace(d, ns)) continue;
    if (!visibleTo(d, viewer)) continue;
    const cur = map.get(d.source);
    if (cur) cur.chunks += 1;
    else map.set(d.source, { source: d.source, title: d.title, chunks: 1 });
  }
  return [...map.values()];
}

export function stats(): { docs: number; sources: number; vectors: number; embedding: boolean } {
  const idx = loadIndex();
  const cache = loadVectors();
  return {
    docs: idx.docs.length,
    sources: listSources().length,
    vectors: Object.keys(cache?.vectors || {}).length,
    embedding: isEmbeddingEnabled(),
  };
}

// ---- 检索 ----

function tokenize(text: string): string[] {
  const out: string[] = [];
  const en = text.toLowerCase().match(/[a-z0-9_]+/g) || [];
  out.push(...en);
  const cjk = text.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const seg of cjk) {
    for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
    if (seg.length === 1) out.push(seg);
  }
  return out;
}

function idfOf(docs: RagDoc[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const d of docs) {
    for (const t of new Set(tokenize(`${d.title} ${d.text}`))) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [t, n] of df) idf.set(t, Math.log(1 + docs.length / (1 + n)));
  return idf;
}

export interface RagHit {
  id: string;
  title: string;
  source: string;
  text: string;
  score: number;
}

/** 混合检索：词法 TF-IDF 与向量余弦各自排序，RRF 融合（1/(60+rank)）。可按命名空间隔离；角色专属语料为空时回落公共语料。 */
export async function search(
  query: string,
  topK = 5,
  namespace?: string,
  viewer?: RagViewer,
): Promise<RagHit[]> {
  let docs = loadIndex().docs;
  if (namespace) docs = docs.filter((d) => matchesNamespace(d, effectiveNamespace(namespace)));
  // 权限过滤：与命名空间过滤同一层做掉，不可见的文档根本不进召回（不是「召回后隐藏」——
  // 那样排序与 RRF 融合仍会被不可见内容影响，等于按别人的语料排自己的结果）。
  docs = docs.filter((d) => visibleTo(d, viewer));
  if (!docs.length) return [];
  const q = query.trim();
  if (!q) return [];

  const idf = idfOf(docs);
  const qTokens = tokenize(q);
  const lexical = docs
    .map((d, i) => {
      const tokens = tokenize(`${d.title} ${d.text}`);
      let score = 0;
      for (const t of qTokens) {
        const tf = tokens.filter((x) => x === t).length;
        if (tf) score += (1 + Math.log(tf)) * (idf.get(t) || 0);
      }
      if (d.title.toLowerCase().includes(q.toLowerCase())) score *= 1.5;
      return { i, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(topK * 4, 20));

  const rankOf = new Map<number, number>();
  lexical.forEach((x, r) => rankOf.set(x.i, r));

  if (isEmbeddingEnabled()) {
    try {
      const qv = await embedText(q);
      if (qv?.vector?.length) {
        const cache = loadVectors();
        const scored = docs
          .map((d, i) => {
            const v = cache?.vectors[d.id];
            return v && v.length === qv.vector.length ? { i, s: cosineSimilarity(qv.vector, v) } : { i, s: -1 };
          })
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, Math.max(topK * 4, 20));
        scored.forEach((x, r) => {
          const cur = rankOf.get(x.i);
          rankOf.set(x.i, cur === undefined ? r : cur + r);
        });
        if (scored.length && !Object.keys(cache?.vectors || {}).length) {
          // 索引有文档但无向量（入库时 embedding 关闭）：补齐后下次生效，本轮纯词法。
          void buildVectors(docs);
        }
      }
    } catch {
      /* embedding 异常降级词法 */
    }
  }

  const merged = [...rankOf.entries()]
    .map(([i, rank]) => ({ doc: docs[i]!, rrf: 1 / (60 + rank) }))
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, topK);

  const top = merged[0]?.rrf || 1;
  return merged.map((m) => ({
    id: m.doc.id,
    title: m.doc.title,
    source: m.doc.source,
    text: m.doc.text.slice(0, 1200),
    score: Math.round((m.rrf / top) * 100) / 100,
  }));
}
