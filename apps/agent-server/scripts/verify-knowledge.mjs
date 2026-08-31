/**
 * 本地 RAG 验证脚本（含 embedding 语义检索）
 * 用法：pnpm --filter @bx/agent-server tsx scripts/verify-knowledge.mjs
 * 作用：
 *  1) 混合检索（词法 TF-IDF + embedding 语义 RRF 融合）对真实查询的命中效果；
 *  2) 语义型查询（口语化/同义词，词法难以命中）能否靠向量召回正确文档。
 */
import "../src/load-env.js";
import { searchKnowledgeBase, lexicalSearch, loadIndex, loadVectors } from "../src/tools/knowledge-base.js";
import { isEmbeddingEnabled } from "../src/tools/knowledge-embedding.js";

const index = loadIndex();
const vectors = loadVectors();
console.log(`[verify] 索引段落总数：${index.chunks.length}`);
console.log(`[verify] embedding 开关：${isEmbeddingEnabled() ? "on" : "off"}；向量缓存：${vectors ? `${Object.keys(vectors.vectors).length} 条 (dim=${vectors.dim}, ${vectors.model})` : "无"}`);
console.log("=".repeat(72));

const queries = [
  // 词法可命中（回归）
  "差旅住宿标准是多少",
  "忘记打卡怎么办",
  "日志里能不能记录用户的Token",
  // 语义型：词法难命中，靠向量召回（验证核心价值）
  "出差在外地怎么住酒店报销",
  "上班迟到了会扣钱吗",
  "咱们公司服务器用什么进程管理的",
  "什么信息不能写进日志",
];

for (const q of queries) {
  console.log(`\n【查询】${q}`);
  const results = await searchKnowledgeBase(q, 3);
  if (!results.length) {
    console.log("  (无命中)");
    continue;
  }
  for (const r of results) {
    const t = r.chunk.sectionTitle ? `${r.chunk.docTitle}/${r.chunk.sectionTitle}` : r.chunk.docTitle;
    console.log(`  [${r.score}] ${t}  <- ${r.chunk.docPath}`);
    console.log(`      ${r.chunk.text.slice(0, 70).replace(/\n/g, " ")}`);
  }
  // 对照：纯词法命中数（看语义增强的价值）
  const lex = lexicalSearch(index.chunks, q);
  console.log(`  (纯词法命中 ${lex.length} 条，混合检索 Top1=${results[0]?.chunk.docPath || "-"})`);
}

// 降级验证：embedding 关闭时是否仍能纯词法工作（不动 .env，这里仅打印说明）
console.log("\n" + "=".repeat(72));
console.log("\n【降级说明】若 KB_EMBEDDING=off 或 embedding API 不可用，searchKnowledgeBase 自动回退纯词法（不报错）。");
