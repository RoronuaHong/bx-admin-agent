/**
 * 生成操作级索引：module.export -> base/path/别名，减少模型误选接口。
 * 用法：node scripts/generate-api-operation-index.mjs [apiDir] [outFile]
 */
import fs from "node:fs";
import path from "node:path";

const apiDir = process.argv[2] || process.env.API_MODULE_DIR || "D:\\Code\\bx-film-admin-in2\\src\\api";
const outFile =
  process.argv[3] ||
  path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "data", "api-operation-index.json");

const BASE_FN_TO_KEY = {
  getUrl: "backend",
  getUserUrl: "user",
  getFilmUrl: "film",
  getMovieMatchUrl: "gather",
};

// 2026-08-25 彻底去操作级别名（全交给大模型）：不再读取 docs/agent/project-aliases.json。
// 该文件（operationAliases/paramAliases）已删除。aliases 只保留源码自动生成的英文标识
// （module.func / module.ApiKey / func / ApiKey），中文动作识别 100% 交模型 grep 源码。

function walkTsFiles(dir, base = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "model" || e.name === "type") continue;
      files.push(...walkTsFiles(full, base));
    } else if (e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
      files.push(path.relative(base, full).replace(/\\/g, "/"));
    }
  }
  return files.sort();
}

function parseApiEnum(content) {
  const m = content.match(/enum\s+Api\s*\{([\s\S]*?)\}/);
  const map = {};
  if (!m) return map;
  for (const x of m[1].matchAll(/(\w+)\s*=\s*['"`]([^'"`]+)['"`]/g)) {
    map[x[1]] = x[2];
  }
  return map;
}

function extractOperations(moduleId, relFile, content) {
  const apiMap = parseApiEnum(content);
  const operations = [];
  const exportStarts = [...content.matchAll(/export\s+const\s+\w+\s*=/g)].map((m) => m.index || 0).sort((a, b) => a - b);

  // 匹配 export const fn = (...) => defHttp.get/post(... getX(Api.KEY) ...)
  const re = /export\s+const\s+(\w+)\s*=\s*\([^)]*\)\s*=>[\s\S]{0,320}?defHttp\.(get|post|put|delete|patch)[\s\S]{0,420}?(\w+)\s*\(\s*Api\.(\w+)\s*\)/g;
  for (const m of content.matchAll(re)) {
    const fnName = m[1];
    const method = m[2].toUpperCase();
    const baseFn = m[3];
    const apiKey = m[4];
    const p = apiMap[apiKey];
    if (!p) continue;
    const opId = `${moduleId}.${fnName}`;
    const start = m.index || 0;
    const next = exportStarts.find((x) => x > start);
    const end = next ?? Math.min(content.length, start + 4000);
    const fnChunk = content.slice(start, end);
    const logMatch = fnChunk.match(/getLogOptions\(\s*['"`]([^'"`]+)['"`]\s*,\s*['"`]([^'"`]+)['"`]/);
    const logModule = logMatch?.[1] || "";
    const logOperator = logMatch?.[2] || "";
    operations.push({
      id: opId,
      module: moduleId,
      file: relFile,
      func: fnName,
      method,
      base: BASE_FN_TO_KEY[baseFn] || "backend",
      path: p,
      aliases: [opId, `${moduleId}.${apiKey}`, fnName, apiKey],
      logEnabled: Boolean(logMatch),
      logModule,
      logOperator,
    });
  }
  return operations;
}

const files = walkTsFiles(apiDir);
const operations = [];
for (const f of files) {
  const content = fs.readFileSync(path.join(apiDir, f), "utf8");
  const baseName = path.basename(f, ".ts");
  const dirParts = path.dirname(f).split("/").filter((p) => p !== ".");
  const moduleId = dirParts.length ? `${dirParts.join("/")}/${baseName}` : baseName;
  operations.push(...extractOperations(moduleId, f, content));
}

const aliasIndex = {};
for (const op of operations) {
  for (const a of op.aliases) {
    const k = String(a).toLowerCase();
    if (!aliasIndex[k]) aliasIndex[k] = [];
    if (!aliasIndex[k].includes(op.id)) aliasIndex[k].push(op.id);
  }
}

const out = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: apiDir,
    operationCount: operations.length,
  },
  operations,
  aliasIndex,
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 2), "utf8");
console.log(`Generated ${operations.length} operations -> ${outFile}`);
