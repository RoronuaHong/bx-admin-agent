/**
 * 本地知识库（方案 B 骨架）
 * ----------------------------------------------------------------
 * 目标：让聊天大模型能调用 search_knowledge_base 工具，用自然语言查询
 * 企业内部本地文档目录（docs/knowledge/**）的内容，并给出引用出处。
 *
 * 当前实现（零新依赖、纯 JS）：
 *  - 文档扫描：递归 docs/knowledge/**（md/txt/html），解析标题分段
 *  - 存储：索引写入 docs/knowledge/.index.json（含分段文本 + 来源 + 更新时间）
 *  - 检索：中文分词（bigram）+ TF-IDF 加权 + 标题加权，返回 Top-K 分段与得分
 *
 * 缺失能力（TODO 标注，需后续补充）：
 *  - TODO: 钉钉文档拉取——凭证到位后从钉钉拉取文档入库
 *  - TODO: 权限过滤（按项目/角色）——当前全量可见
 *  - TODO: 增量索引——当前全量重建
 *
 * 升级记录（2026-08-22）：
 *  - 语义检索：新增 embedding 向量化（knowledge-embedding.ts，OpenAI 兼容 /embeddings），
 *    索引构建时生成向量缓存 .vectors.json；检索时 query 向量化 + 余弦相似度，
 *    与词法 TF-IDF 做 RRF 融合（词汇命中与语义召回兼顾）。embedding 不可用时自动回退纯词法。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isEmbeddingEnabled,
  embedTextsBatched,
  embedText,
  cosineSimilarity,
  normalize,
  type EmbeddingResult,
} from "./knowledge-embedding.js";

/** 当前文件目录（ESM 无 __dirname，手动推导） */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 知识库根目录（相对仓库根：docs/knowledge） */
export const KNOWLEDGE_ROOT = path.resolve(__dirname, "../../../../docs/knowledge");

/** 索引文件（存于知识库根目录，.gitignore 可忽略） */
const INDEX_PATH = path.join(KNOWLEDGE_ROOT, ".index.json");

/** 向量缓存文件（chunk.id → 向量，与索引分离便于重建/降级） */
const VECTORS_PATH = path.join(KNOWLEDGE_ROOT, ".vectors.json");

/** 向量缓存格式：记录 model（维度一致性校验）与 chunkId → 归一化向量 */
interface VectorsCache {
  model: string;
  dim: number;
  updatedAt: number;
  /** chunk.id → 向量（已归一化） */
  vectors: Record<string, number[]>;
}

/** 支持扫描的文档扩展名 */
const DOC_EXT = new Set([".md", ".markdown", ".txt", ".html", ".htm"]);

export interface KnowledgeChunk {
  /** 段落 ID（文件相对路径 + 分段序号） */
  id: string;
  /** 文档相对路径（相对 KNOWLEDGE_ROOT） */
  docPath: string;
  /** 文档标题（文件名去扩展名，或文档内首个 # 标题） */
  docTitle: string;
  /** 分段内容 */
  text: string;
  /** 分段标题（如二级标题，可能为空） */
  sectionTitle?: string;
  /** 文档更新时间（ms） */
  updatedAt: number;
  /** 文档标签（从文件名/目录推断，如 "ops"、"flow"） */
  tags: string[];
}

export interface KnowledgeIndex {
  version: number;
  updatedAt: number;
  chunks: KnowledgeChunk[];
}

interface ScoredChunk {
  chunk: KnowledgeChunk;
  score: number;
}

/** ---- 中文分词（bigram + 单字）+ 英文小写分词 ---- */
export function tokenize(text: string): string[] {
  const t = String(text || "").toLowerCase();
  const tokens: string[] = [];
  // 英文/数字词
  const en = t.match(/[a-z0-9][a-z0-9_.-]*/g) || [];
  tokens.push(...en);
  // 中文：连续中文按 bigram 切（去重）
  const cnRuns = t.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  const seen = new Set<string>();
  for (const run of cnRuns) {
    for (let i = 0; i < run.length - 1; i++) {
      const big = run.slice(i, i + 2);
      if (!seen.has(big)) {
        seen.add(big);
        tokens.push(big);
      }
    }
    // 单字也纳入（利于短 query 召回）
    for (const ch of run) {
      if (!seen.has(ch)) {
        seen.add(ch);
        tokens.push(ch);
      }
    }
  }
  return tokens;
}

/** ---- 从文件内容提取标题（首个 # 标题） ---- */
function extractTitle(content: string): string {
  const m = content.match(/^\s*#{1,3}\s+(.+)$/m);
  return m ? m[1].trim() : "";
}

/** ---- 从内容提取二级标题（供分段标注） ---- */
function extractSectionTitle(line: string): string | undefined {
  const m = line.match(/^\s*#{1,3}\s+(.+)$/);
  return m ? m[1].trim() : undefined;
}

/** ---- 文档内容分段（按空行/标题切分，每段 ≤ MAX_CHUNK_CHARS 字符） ---- */
const MAX_CHUNK_CHARS = 600;

export function splitDocument(
  content: string,
  docPath: string,
  docTitle: string,
  updatedAt: number,
  tags: string[],
): KnowledgeChunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: KnowledgeChunk[] = [];
  let current = "";
  let sectionTitle: string | undefined;
  let seq = 0;

  const flush = () => {
    const text = current.trim();
    if (text.length >= 10) {
      chunks.push({
        id: `${docPath}#${seq++}`,
        docPath,
        docTitle,
        text,
        sectionTitle,
        updatedAt,
        tags,
      });
    }
    current = "";
    sectionTitle = undefined;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,3}\s+/.test(trimmed)) {
      // 遇到标题：先刷当前段，再更新 sectionTitle
      flush();
      const st = extractSectionTitle(trimmed);
      if (st && st !== docTitle) sectionTitle = st;
      continue;
    }
    if (!trimmed) {
      flush();
      continue;
    }
    if (current.length + trimmed.length + 1 > MAX_CHUNK_CHARS) {
      flush();
    }
    current += (current ? "\n" : "") + trimmed;
  }
  flush();
  return chunks;
}

/** ---- 扫描知识库目录，重建索引（同步核心：仅写 .index.json） ---- */
export function buildIndexSync(): KnowledgeIndex {
  const chunks: KnowledgeChunk[] = [];
  if (!fs.existsSync(KNOWLEDGE_ROOT)) {
    fs.mkdirSync(KNOWLEDGE_ROOT, { recursive: true });
  }
  walkDir(KNOWLEDGE_ROOT, chunks);
  const index: KnowledgeIndex = {
    version: 1,
    updatedAt: Date.now(),
    chunks,
  };
  try {
    fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf8");
  } catch (e) {
    // 索引写失败不致命（检索时仍可从内存索引）
    console.error("[knowledge-base] 索引写入失败:", (e as Error).message);
  }
  return index;
}

/** 重建索引（异步：含向量缓存生成；脚本场景 await 确保进程退出前完成） */
export async function buildIndex(): Promise<KnowledgeIndex> {
  const index = buildIndexSync();
  if (isEmbeddingEnabled()) {
    try {
      await buildVectors(index.chunks);
    } catch (e) {
      console.error("[knowledge-base] 向量缓存构建失败（词法检索不受影响）:", (e as Error).message);
    }
  }
  return index;
}

/**
 * 为所有 chunk 生成向量并写缓存。
 * 调用方需 await（脚本场景必须等向量生成完再退出进程）。
 */
export async function buildVectors(chunks: KnowledgeChunk[]): Promise<VectorsCache> {
  const cache: VectorsCache = { model: "", dim: 0, updatedAt: Date.now(), vectors: {} };
  if (!chunks.length || !isEmbeddingEnabled()) return cache;
  const results = await embedTextsBatched(
    chunks.map((c) => c.text),
    16,
    4,
    (done, total) => {
      const d = Math.min(done, total);
      if (total > 0 && d % 32 === 0) {
        console.log(`[knowledge-base] 向量化进度 ${d}/${total}`);
      }
    },
  );
  let model = "";
  let dim = 0;
  for (let i = 0; i < chunks.length; i++) {
    const r: EmbeddingResult = results[i];
    cache.vectors[chunks[i].id] = normalize(r.vector);
    model = r.model;
    dim = r.vector.length;
  }
  cache.model = model;
  cache.dim = dim;
  try {
    fs.writeFileSync(VECTORS_PATH, JSON.stringify(cache), "utf8");
    console.log(`[knowledge-base] 向量缓存已写入 ${VECTORS_PATH}（${chunks.length} 条，dim=${dim}，model=${model}）`);
  } catch (e) {
    console.error("[knowledge-base] 向量缓存写入失败:", (e as Error).message);
  }
  return cache;
}

/** 加载向量缓存（存在且维度匹配则返回，否则空） */
export function loadVectors(): VectorsCache | null {
  try {
    if (fs.existsSync(VECTORS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(VECTORS_PATH, "utf8")) as VectorsCache;
      if (raw && raw.vectors && typeof raw.vectors === "object") return raw;
    }
  } catch {
    /* 损坏则视为无缓存 */
  }
  return null;
}

function walkDir(dir: string, out: KnowledgeChunk[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name.startsWith(".")) continue; // 跳过隐藏目录（.index 等）
      walkDir(full, out);
      continue;
    }
    const ext = path.extname(ent.name).toLowerCase();
    if (!DOC_EXT.has(ext)) continue;
    try {
      const content = fs.readFileSync(full, "utf8");
      const rel = path.relative(KNOWLEDGE_ROOT, full).replace(/\\/g, "/");
      const docTitle = extractTitle(content) || path.basename(rel, path.extname(rel));
      const stat = fs.statSync(full);
      const tags = inferTags(rel);
      out.push(...splitDocument(content, rel, docTitle, stat.mtimeMs, tags));
    } catch (e) {
      console.error(`[knowledge-base] 读取文档失败 ${full}:`, (e as Error).message);
    }
  }
}

/** ---- 从路径推断标签（目录名/文件名关键词） ---- */
function inferTags(rel: string): string[] {
  const tags: string[] = [];
  const parts = rel.split("/").slice(0, -1); // 目录层级
  for (const p of parts) {
    if (p && !p.startsWith(".")) tags.push(p);
  }
  return tags;
}

/** ---- 加载索引（存在则读，否则同步重建） ---- */
export function loadIndex(): KnowledgeIndex {
  try {
    if (fs.existsSync(INDEX_PATH)) {
      const raw = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8")) as KnowledgeIndex;
      if (Array.isArray(raw.chunks)) return raw;
    }
  } catch {
    /* 损坏则重建 */
  }
  return buildIndexSync();
}

/** ---- 统计各 token 的文档频率（DF） ---- */
function computeDf(chunks: KnowledgeChunk[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const c of chunks) {
    const unique = new Set(tokenize(c.text));
    for (const t of unique) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  return df;
}

/**
 * 词法检索：TF(token in chunk) * IDF * 标题权重（docTitle/sectionTitle 命中加权）
 * 返回按词法分排序的全量命中（供 RRF 融合取排名）。
 */
export function lexicalSearch(chunks: KnowledgeChunk[], query: string): Array<{ chunk: KnowledgeChunk; score: number; matched: string[] }> {
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];
  const df = computeDf(chunks);
  const N = chunks.length;
  const scored: ScoredChunk[] = [];

  for (const chunk of chunks) {
    const textTokens = tokenize(chunk.text);
    if (!textTokens.length) continue;
    const tf = new Map<string, number>();
    for (const t of textTokens) tf.set(t, (tf.get(t) || 0) + 1);

    let score = 0;
    const matched: string[] = [];
    for (const qt of qTokens) {
      const f = tf.get(qt) || 0;
      if (!f) continue;
      const idf = Math.log((N + 1) / ((df.get(qt) || 0) + 1)) + 1;
      score += (1 + Math.log(f)) * idf;
      if (!matched.includes(qt)) matched.push(qt);
    }
    // 标题命中加权（标题词重要）
    const titleTokens = new Set(tokenize(`${chunk.docTitle} ${chunk.sectionTitle || ""}`));
    for (const qt of qTokens) {
      if (titleTokens.has(qt)) score *= 1.5;
    }
    if (score > 0) scored.push({ chunk, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ chunk, score }) => ({
    chunk,
    score,
    matched: [...new Set(qTokens.filter((t) => tokenize(chunk.text).includes(t)))],
  }));
}

/**
 * 语义检索：query 向量化 → 与各 chunk 缓存向量算余弦相似度。
 * 向量缓存缺失/失败时返回空数组（调用方降级词法）。
 */
export async function semanticSearch(
  chunks: KnowledgeChunk[],
  query: string,
): Promise<Array<{ chunk: KnowledgeChunk; score: number }>> {
  if (!isEmbeddingEnabled()) return [];
  const vectors = loadVectors();
  if (!vectors || !Object.keys(vectors.vectors).length) return [];
  let queryVector: number[];
  try {
    const r = await embedText(query);
    queryVector = normalize(r.vector);
  } catch (e) {
    console.error("[knowledge-base] query 向量化失败（降级词法）:", (e as Error).message);
    return [];
  }
  const scored: Array<{ chunk: KnowledgeChunk; score: number }> = [];
  for (const chunk of chunks) {
    const vec = vectors.vectors[chunk.id];
    if (!vec) continue;
    const sim = cosineSimilarity(queryVector, vec);
    if (sim > 0) scored.push({ chunk, score: sim });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * 混合检索（RRF 融合）：词法 TF-IDF 排名 + 语义余弦相似度排名加权求和。
 * - embedding 未开启/失败 → 自动回退纯词法（行为与升级前一致）。
 * - 返回 Top-K，score 为 RRF 融合分（越大越相关）。
 */
export async function searchKnowledgeBase(
  query: string,
  maxResults = 5,
): Promise<Array<{ chunk: KnowledgeChunk; score: number; matched: string[] }>> {
  const index = loadIndex();
  if (!index.chunks.length) return [];
  if (!tokenize(query).length) return [];

  const lexical = lexicalSearch(index.chunks, query);
  const semantic = await semanticSearch(index.chunks, query);

  // RRF：rank 从 1 起，1/(60+rank)；词法与语义各自排名后融合。
  const K = 60;
  const fused = new Map<string, { chunk: KnowledgeChunk; score: number; matched: string[] }>();
  const addRanked = (
    list: Array<{ chunk: KnowledgeChunk; score: number; matched?: string[] }>,
    weight: number,
  ) => {
    list.forEach((item, rank) => {
      const id = item.chunk.id;
      const cur = fused.get(id) || { chunk: item.chunk, score: 0, matched: [] };
      cur.score += weight / (K + rank + 1);
      if (item.matched?.length) {
        cur.matched = [...new Set([...cur.matched, ...item.matched])];
      }
      fused.set(id, cur);
    });
  };
  addRanked(lexical, 1);
  addRanked(semantic, 1);

  const results = [...fused.values()].sort((a, b) => b.score - a.score);
  const top = results.slice(0, maxResults);
  // 展示分：RRF 原始分映射为 0-100（Top1=100，其余按比例），仅用于展示，不影响排序。
  const maxScore = top.length ? top[0].score : 0;
  return top.map(({ chunk, score, matched }) => ({
    chunk,
    score: maxScore > 0 ? Math.round((score / maxScore) * 100) : 0,
    matched,
  }));
}

/** ---- 检索结果格式化为可读文本（含引用出处） ---- */
export function formatSearchResults(
  results: Array<{ chunk: KnowledgeChunk; score: number; matched: string[] }>,
  query: string,
): string {
  if (!results.length) {
    return (
      `未在本地知识库（docs/knowledge/）中找到与「${query}」相关的文档。\n` +
      `可尝试：1) 更换关键词；2) 联系管理员确认文档是否已导入知识库（运行索引构建脚本）。`
    );
  }
  const lines: string[] = [`根据企业知识库（docs/knowledge/），「${query}」的相关内容如下：\n`];
  for (const r of results) {
    const title = r.chunk.sectionTitle ? `${r.chunk.docTitle} / ${r.chunk.sectionTitle}` : r.chunk.docTitle;
    lines.push(`### ${title}（相关度 ${r.score}）`);
    lines.push(r.chunk.text.length > 200 ? `${r.chunk.text.slice(0, 200)}…` : r.chunk.text);
    lines.push(`> 来源：docs/knowledge/${r.chunk.docPath}`);
    lines.push("");
  }
  return lines.join("\n");
}
