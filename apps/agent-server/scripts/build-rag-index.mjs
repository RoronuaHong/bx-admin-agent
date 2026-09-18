// 知识库入库（RAG）：扫描目录 → 按扩展名解析 → 切片 → 词法索引 + 可选向量缓存。
// 增量：未变更文件（md5 相同）跳过；变更文件先清旧切片再重建；磁盘上已删除的来源一并清理。
// 运行：node --import tsx scripts/build-rag-index.mjs [目录] [--full]
//   目录默认仓库根 docs/knowledge；--full = 忽略指纹全量重建。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

await import("../src/load-env.js");
const { ingest, removeSource, sourceHashes, stats, listSources } = await import("../src/rag/store.js");
const parsers = await import("../src/rag/parsers.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");

const argv = process.argv.slice(2);
const full = argv.includes("--full");
// 命名空间（按角色隔离）：默认 generic；观影等角色的语料用 --namespace movie 入库，检索互不串台。
const nsArgIdx = argv.indexOf("--namespace");
const namespace = (nsArgIdx >= 0 && argv[nsArgIdx + 1]) || "generic";
// 位置参数（非 -- 开头、且不是 --namespace 的取值）作为要扫描的目录。
const posArgs = argv.filter((a, i) => !a.startsWith("--") && a !== argv[nsArgIdx + 1]);
const dirArg = posArgs[0] || "docs/knowledge";
const root = path.isAbsolute(dirArg) ? dirArg : path.resolve(repoRoot, dirArg);

if (!fs.existsSync(root)) {
  console.error(`[rag] 目录不存在：${root}`);
  process.exit(1);
}

/** 递归收集文件（跳过隐藏目录/文件与 node_modules）。 */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

const files = walk(root).filter((f) => parsers.isSupportedExt(path.extname(f)));
const skipped = walk(root).length - files.length;
const hashes = full ? new Map() : sourceHashes();

let added = 0;
let unchanged = 0;
let failed = 0;
const failures = [];

for (const abs of files) {
  const rel = path.relative(root, abs).split(path.sep).join("/");
  const md5 = crypto.createHash("md5").update(fs.readFileSync(abs)).digest("hex");
  if (hashes.get(rel) === md5) {
    unchanged += 1;
    continue;
  }
  const parsed = await parsers.parseFile(abs);
  if ("error" in parsed) {
    failed += 1;
    failures.push(`${rel}：${parsed.error}`);
    continue;
  }
  // 变更文件：先清掉旧切片（切片数可能变少，残留会污染检索）。
  removeSource(rel);
  const n = await ingest([{ id: rel, title: parsed.title, source: rel, text: parsed.text, hash: md5, namespace }]);
  added += 1;
  console.log(`[rag] 入库 ${rel}（${n} 切片，${parsed.title}）`);
}

// 磁盘上已删除的来源：清理索引残留。
const onDisk = new Set(files.map((abs) => path.relative(root, abs).split(path.sep).join("/")));
let removed = 0;
for (const src of listSources()) {
  if (!onDisk.has(src.source)) {
    removed += removeSource(src.source);
    console.log(`[rag] 清理已删除来源 ${src.source}`);
  }
}

const s = stats();
console.log(
  `[rag] 完成：新增/更新 ${added}，未变更 ${unchanged}，失败 ${failed}，清理 ${removed} 条；` +
    `索引共 ${s.docs} 切片 / ${s.sources} 来源 / ${s.vectors} 向量（embedding=${s.embedding ? "on" : "off"}）` +
    (skipped ? `；跳过不支持扩展名 ${skipped} 个文件` : ""),
);
for (const f of failures) console.warn(`[rag] 跳过 ${f}`);
