/**
 * Qdrant 向量数据库练手脚本
 * ----------------------------------------------------------------
 * 用法：node scripts/qdrant-practice.mjs [query]
 * 前置：
 *   1) Docker 已启动 Qdrant（见下方 DOCKER_RUN 命令）
 *   2) apps/agent-server/.env 已配置 KB_EMBEDDING=on（query 向量化依赖）
 *
 * 练手内容（依次演示）：
 *   ① health check + 建 collection（1024 维 / Cosine / HNSW）
 *   ② 把 docs/knowledge 的 18 个 chunk + 向量灌入 Qdrant（upsert）
 *   ③ 语义检索（真实 query 向量化 → search）
 *   ④ payload filter（按部门 tags 过滤后检索）
 *   ⑤ 与现方案（RRF 融合）结果对比
 *   ⑥ collection 状态与 HNSW 索引信息
 */
import "../src/load-env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { embedText, isEmbeddingEnabled } from "../src/tools/knowledge-embedding.js";
import { searchKnowledgeBase, KNOWLEDGE_ROOT } from "../src/tools/knowledge-base.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCKER_RUN =
  "docker run -d --name qdrant-practice -p 6333:6333 -p 6334:6334 -v qdrant_practice_data:/qdrant/storage qdrant/qdrant:latest";
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION = "kb-practice";
const INDEX_PATH = path.join(KNOWLEDGE_ROOT, ".index.json");
const VECTORS_PATH = path.join(KNOWLEDGE_ROOT, ".vectors.json");

/** 通用 REST 封装：返回解析后的 JSON（Qdrant 全部走 JSON API） */
async function api(method, suffix, body) {
  const res = await fetch(`${QDRANT_URL}${suffix}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${suffix}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

const line = (s = "") => console.log(s);

async function stepHealth() {
  line("① 健康检查 GET /");
  const r = await api("GET", "/");
  line(`   title=${r.title} version=${r.version}`);
  const cols = await api("GET", "/collections");
  line(`   现有 collections: ${(cols.result?.collections || []).map((c) => c.name).join(", ") || "(无)"}`);
}

async function stepCreateCollection() {
  line("\n② 创建 collection（若不存在）");
  const cols = await api("GET", "/collections");
  const exists = (cols.result?.collections || []).some((c) => c.name === COLLECTION);
  if (exists) {
    line(`   ${COLLECTION} 已存在，跳过创建（如需重建：DELETE /collections/${COLLECTION}）`);
    return;
  }
  await api("PUT", `/collections/${COLLECTION}`, {
    vectors: { size: 1024, distance: "Cosine" }, // 与现方案余弦相似度对齐
    hnsw_config: { m: 16, ef_construct: 100 }, // HNSW 图参数：m=每层最大连接数，ef_construct=建图搜索宽度
    optimizers_config: { default_segment_number: 2 },
  });
  line(`   已创建 ${COLLECTION}（size=1024, distance=Cosine, m=16, ef_construct=100）`);
}

async function stepUpsert() {
  line("\n③ 灌入 docs/knowledge 的 18 个 chunk + 向量");
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  const vectors = JSON.parse(fs.readFileSync(VECTORS_PATH, "utf8"));
  if (!index.chunks?.length || !vectors.vectors || !Object.keys(vectors.vectors).length) {
    throw new Error("索引或向量缓存为空，请先运行 build-knowledge-index");
  }
  const points = index.chunks.map((c, i) => ({
    id: i, // 用数组下标作 point id（练手足够；生产应用 hash 或 UUID）
    vector: vectors.vectors[c.id],
    payload: {
      docPath: c.docPath,
      docTitle: c.docTitle,
      sectionTitle: c.sectionTitle || "",
      text: c.text,
      tags: c.tags || [],
      updatedAt: c.updatedAt,
    },
  }));
  const r = await api("PUT", `/collections/${COLLECTION}/points?wait=true`, { points });
  line(`   upsert ${points.length} points, status=${r.result?.status}`);
}

async function stepSearch(query) {
  line(`\n④ 语义检索：「${query}」`);
  const q = await embedText(query);
  const r = await api("POST", `/collections/${COLLECTION}/points/search`, {
    vector: q.vector,
    limit: 3,
    with_payload: true,
  });
  for (const hit of r.result || []) {
    const p = hit.payload;
    const title = p.sectionTitle ? `${p.docTitle} / ${p.sectionTitle}` : p.docTitle;
    line(`   [${hit.score.toFixed(4)}] ${title}`);
    line(`       ${String(p.text).slice(0, 80)}`);
    line(`       来源：docs/knowledge/${p.docPath}`);
  }
}

async function stepFilter(query, tag) {
  line(`\n⑤ payload filter：仅检索 tags 含「${tag}」的文档（query:「${query}」）`);
  const q = await embedText(query);
  const r = await api("POST", `/collections/${COLLECTION}/points/search`, {
    vector: q.vector,
    limit: 3,
    with_payload: true,
    filter: { must: [{ key: "tags", match: { value: tag } }] },
  });
  if (!(r.result || []).length) {
    line(`   （${tag} 部门无匹配）`);
    return;
  }
  for (const hit of r.result) {
    const p = hit.payload;
    line(`   [${hit.score.toFixed(4)}] ${p.docTitle} → ${String(p.text).slice(0, 60)}`);
  }
}

async function stepCompare(query) {
  line(`\n⑥ 与现方案（RRF 融合）对比：「${query}」`);
  const results = await searchKnowledgeBase(query, 3);
  for (const r of results) {
    const title = r.chunk.sectionTitle ? `${r.chunk.docTitle} / ${r.chunk.sectionTitle}` : r.chunk.docTitle;
    line(`   [score ${r.score}] ${title} → ${r.chunk.text.slice(0, 60)}`);
  }
  line("   （若与 ④ 命中相同 chunk，说明「换库不换结果」——数据量小时两者等价）");
}

async function stepInfo() {
  line("\n⑦ collection 状态 / HNSW 索引信息");
  const r = await api("GET", `/collections/${COLLECTION}`);
  const st = r.result || {};
  const cfg = st.config?.hnsw_config || {};
  line(`   points_count: ${st.points_count}, vectors_count: ${st.vectors_count}`);
  line(`   status: ${st.status}（green=ready）`);
  line(`   hnsw: m=${cfg.m}, ef_construct=${cfg.ef_construct}`);
  line(`   向量维度/距离: ${st.config?.params?.vectors?.size || "?"} / ${st.config?.params?.vectors?.distance || "?"}`);
}

async function main() {
  const query = process.argv[2] || "上班迟到了会扣钱吗";
  if (!isEmbeddingEnabled()) {
    console.error("[qdrant-practice] KB_EMBEDDING 未开启，请在 apps/agent-server/.env 配置 KB_EMBEDDING=on 后重试");
    process.exit(1);
  }
  try {
    line(`Qdrant: ${QDRANT_URL}  collection: ${COLLECTION}\n`);
    await stepHealth();
    await stepCreateCollection();
    await stepUpsert();
    await stepSearch(query);
    await stepFilter(query, "人事");
    await stepCompare(query);
    await stepInfo();
    line("\n练手完成。清理：docker rm -f qdrant-practice；重建：DELETE /collections/kb-practice 后重跑本脚本");
  } catch (e) {
    console.error("\n[qdrant-practice] 失败:", e.message);
    console.error(`   Qdrant 未启动？运行：${DOCKER_RUN}`);
    process.exit(1);
  }
}

main();
