/**
 * 本地知识库索引构建脚本
 * ----------------------------------------------------------------
 * 用法：node scripts/build-knowledge-index.mjs
 * 作用：扫描 docs/knowledge/**（md/txt/html），分段并写入 docs/knowledge/.index.json
 * 运行时（search_knowledge_base）若索引缺失会自动重建，本脚本用于主动重建/更新。
 */
import "../src/load-env.js";
import { buildIndex } from "../src/tools/knowledge-base.js";

try {
  const index = await buildIndex();
  console.log(`[knowledge] 索引构建完成：${index.chunks.length} 个段落，文档更新于 ${new Date(index.updatedAt).toLocaleString()}`);
  // 按文档统计
  const byDoc = new Map();
  for (const c of index.chunks) {
    byDoc.set(c.docPath, (byDoc.get(c.docPath) || 0) + 1);
  }
  for (const [doc, n] of [...byDoc.entries()].sort()) {
    console.log(`  ${doc} → ${n} 段`);
  }
  if (!index.chunks.length) {
    console.warn("[knowledge] 未找到任何文档。请将企业文档放入 docs/knowledge/ 目录（支持 .md/.txt/.html）。");
  }
} catch (e) {
  console.error("[knowledge] 索引构建失败:", e.message);
  process.exit(1);
}
