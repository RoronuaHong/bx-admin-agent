import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentProjectKey } from "./project-context.js";


export interface ApiModuleEntry {
  id: string;
  file: string;
  aliases: string[];
  exports: string[];
  apis: Array<{ key: string; path: string }>;
  descriptions: string[];
}

interface ApiModuleIndex {
  meta: {
    generatedAt: string;
    source: string;
    repo: string;
    branches: { test: string; prod: string };
    moduleCount: number;
  };
  modules: ApiModuleEntry[];
  aliasIndex: Record<string, string[]>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 2026-08-24：api-module-index.json 与 api-module-index-bx-film-admin.json 已删除，
// 模块定位完全交模型实时 grep 源码。此处保留路径推导仅作可选兜底（文件存在才加载）。
const DEFAULT_INDEX = path.join(__dirname, "..", "data", "api-module-index.json");

// 按索引文件路径缓存（方案 A 多项目：每项目一份 api-module-index-<key>.json）
const indexCache = new Map<string, ApiModuleIndex>();

const EMPTY_INDEX: ApiModuleIndex = {
  meta: { generatedAt: "", source: "", repo: "", branches: { test: "", prod: "" }, moduleCount: 0 },
  modules: [],
  aliasIndex: {},
};

/** 模块定位完全交模型实时 grep 源码（2026-08-22 起完全抛弃 aliases）：
 *  不再有任何「中文词 → 模块 id」映射表叠加进索引。索引只保留生成脚本从源码自动发现的
 *  页面 title / descriptions / 文件名 / 模块 id，作为 search_api_module / read_api_module
 *  等「模型 grep 工具」的检索面，不参与服务端模块路由与候选注入。
 *  索引文件不存在时返回空索引（优雅降级，不抛错），模块定位仍由模型 grep 源码兜底。 */
export function loadApiModuleIndex(indexPath = resolveProjectIndexPath()): ApiModuleIndex {
  const cached = indexCache.get(indexPath);
  if (cached) return cached;
  if (!fs.existsSync(indexPath)) {
    indexCache.set(indexPath, EMPTY_INDEX);
    return EMPTY_INDEX;
  }
  const raw = fs.readFileSync(indexPath, "utf8");
  const idx = JSON.parse(raw) as ApiModuleIndex;
  indexCache.set(indexPath, idx);
  return idx;
}

/** 解析当前请求应加载的项目索引：activeProject 有独立索引文件（api-module-index-<key>.json）
 *  时优先，否则默认索引（兼容单项目/未生成独立索引）。 */
function resolveProjectIndexPath(): string {
  const key = getCurrentProjectKey();
  if (key) {
    const alt = path.join(__dirname, "..", "data", `api-module-index-${key}.json`);
    if (fs.existsSync(alt)) return alt;
  }
  return process.env.API_MODULE_INDEX || DEFAULT_INDEX;
}

/** 按模块名/别名/文件路径解析，返回匹配的模块条目 */
export function resolveApiModules(query: string, index = loadApiModuleIndex()): ApiModuleEntry[] {
  const q = query.trim();
  if (!q) return [];

  const byId = new Map(index.modules.map((m) => [m.id, m]));
  const byFile = new Map(index.modules.map((m) => [m.file, m]));

  // 1. 精确文件路径
  if (/\.(?:ts|js)$/.test(q)) {
    const hit = byFile.get(q.replace(/\\/g, "/"));
    return hit ? [hit] : [];
  }

  // 2. 精确 id
  const idHit = byId.get(q);
  if (idHit) return [idHit];

  // 3. aliasIndex 精确匹配（忽略大小写）
  const aliasIds = index.aliasIndex[q.toLowerCase()];
  if (aliasIds?.length) return aliasIds.map((id) => byId.get(id)!).filter(Boolean);

  // 4. 模糊：别名/id/file 包含关键词
  const lower = q.toLowerCase();
  const scored = index.modules
    .map((m) => {
      let score = 0;
      if (m.id.toLowerCase().includes(lower)) score += 3;
      if (m.file.toLowerCase().includes(lower)) score += 3;
      for (const a of m.aliases) {
        if (a.toLowerCase() === lower) score += 10;
        else if (a.toLowerCase().includes(lower)) score += 2;
      }
      for (const d of m.descriptions) {
        if (d.toLowerCase().includes(lower)) score += 1;
      }
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 5).map((x) => x.m);
}

/** 将模块条目格式化为 read_api_module 的前置摘要 */
export function formatModuleSummary(m: ApiModuleEntry): string {
  const lines = [
    `【模块索引】${m.id}`,
    `文件: src/api/${m.file}`,
    `别名: ${m.aliases.join("、")}`,
    `可用函数: ${m.exports.join(", ")}`,
  ];
  if (m.apis.length) {
    lines.push("接口路径:");
    for (const a of m.apis) lines.push(`  ${a.key} = ${a.path}`);
  }
  if (m.descriptions.length) lines.push(`说明: ${m.descriptions.join("；")}`);
  return lines.join("\n");
}
