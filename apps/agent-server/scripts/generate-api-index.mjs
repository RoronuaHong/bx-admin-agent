/**
 * 扫描 bx-film-admin-in2/src/api，生成模块名 -> 接口文件映射 JSON。
 * 用法：node scripts/generate-api-index.mjs [apiDir] [outFile]
 */
import fs from "node:fs";
import path from "node:path";

const apiDir = process.argv[2] || process.env.API_MODULE_DIR || "D:\\Code\\bx-film-admin-in2\\src\\api";
// 2026-08-24：api-module-index.json 已删除，不再默认生成该文件。
// 仅当显式传入 outFile 参数时才写盘；缺省不写盘（模块定位完全交模型实时 grep 源码）。
const outFile = process.argv[3] || null;

/**
 * 自动发现（根治）：扫描 src/views/<模块>/List.vue 的页面 title（getTran('KEY','[中文]') 第二参数），
 * 得到 目录名 -> 页面中文名 映射，并入 api-module-index 的 aliases。
 * 这样"三级分类→tag"这类页面级中文由源码自动生成，无需手工维护关键词表。
 */
function collectViewTitles(viewsDir) {
  const map = new Map(); // dirName -> Set(pageTitles)
  if (!viewsDir || !fs.existsSync(viewsDir)) return map;
  for (const entry of fs.readdirSync(viewsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const listVue = path.join(viewsDir, entry.name, "List.vue");
    if (!fs.existsSync(listVue)) continue;
    let src;
    try {
      src = fs.readFileSync(listVue, "utf8");
    } catch {
      continue;
    }
    const titles = new Set();
    for (const m of src.matchAll(/title\s*:\s*getTran\(\s*['"`][^'"`]+['"`]\s*,\s*['"`]([^'"`]*)['"`]\s*\)/g)) {
      const t = m[1].trim().replace(/^\[|\]$/g, "");
      if (t && t.length >= 2 && t.length <= 30) titles.add(t);
    }
    if (titles.size) map.set(entry.name, titles);
  }
  return map;
}

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

function parseFile(relPath, content, viewTitles) {
  const baseName = path.basename(relPath, ".ts");
  const dirParts = path.dirname(relPath).split("/").filter((p) => p !== ".");
  const moduleId = dirParts.length ? `${dirParts.join("/")}/${baseName}` : baseName;

  const exports = [];
  for (const m of content.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(\w+)/g)) {
    exports.push(m[1]);
  }

  const apis = [];
  const enumBlock = content.match(/enum\s+Api\s*\{([\s\S]*?)\}/);
  if (enumBlock) {
    for (const m of enumBlock[1].matchAll(/(\w+)\s*=\s*['"`]([^'"`]+)['"`]/g)) {
      apis.push({ key: m[1], path: m[2] });
    }
  }

  const descriptions = [];
  for (const m of content.matchAll(/@description:\s*([^\n*]+)/g)) {
    const d = m[1].trim();
    if (d && !descriptions.includes(d)) descriptions.push(d);
  }

  const aliases = new Set();
  aliases.add(baseName);
  aliases.add(moduleId);
  for (const p of dirParts) aliases.add(p);

  // 完全抛弃 aliases（2026-08-22）：不再合并任何手动别名表（project-aliases.json moduleAliases）。
  // 索引只保留源码事实：模块 id / 文件名 / 目录名 / @description / views 页面 title，
  // 作为 search_api_module / read_api_module 等「模型 grep 工具」的检索面。
  for (const d of descriptions) {
    const short = d.replace(/^管理后台[-—]/, "").replace(/API.*$/, "").trim();
    if (short.length >= 2 && short.length <= 30) aliases.add(short);
  }
  // 自动发现：views 目录同名模块的 List.vue 页面 title 并入别名（如 views/tag/List.vue → "三级分类"）
  for (const key of [baseName, dirParts[dirParts.length - 1]]) {
    const titles = viewTitles?.get(key);
    if (titles) titles.forEach((t) => aliases.add(t));
  }

  return {
    id: moduleId,
    file: relPath,
    aliases: [...aliases],
    exports: exports.slice(0, 30),
    apis: apis.slice(0, 20),
    descriptions: descriptions.slice(0, 5),
  };
}

// 视图目录（页面 title 自动发现的来源）：可用 VIEWS_DIR 指定任意项目，默认 src/api 的同级 views
const viewsDir = process.env.VIEWS_DIR || path.join(path.dirname(apiDir), "views");
const viewTitles = collectViewTitles(viewsDir);

const files = walkTsFiles(apiDir);
const modules = files.map((f) => {
  const content = fs.readFileSync(path.join(apiDir, f), "utf8");
  return parseFile(f, content, viewTitles);
});

const aliasIndex = {};
for (const mod of modules) {
  for (const alias of mod.aliases) {
    const key = alias.toLowerCase();
    if (!aliasIndex[key]) aliasIndex[key] = [];
    if (!aliasIndex[key].includes(mod.id)) aliasIndex[key].push(mod.id);
  }
}

const output = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: apiDir,
    viewsDir,
    repo: "web/bx-film-admin-in2",
    branches: { test: "dev", prod: "master" },
    moduleCount: modules.length,
  },
  modules,
  aliasIndex,
};

if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2), "utf8");
  console.log(`Generated ${modules.length} modules -> ${outFile}`);
} else {
  console.log(`Scanned ${modules.length} modules (dry-run, no outFile given — not written to disk).`);
}
