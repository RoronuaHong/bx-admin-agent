import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ApiOperation {
  id: string;
  module: string;
  file: string;
  func: string;
  method: string;
  base: "backend" | "user" | "film";
  path: string;
  aliases: string[];
  logEnabled?: boolean;
  logModule?: string;
  logOperator?: string;
}

interface ApiOperationIndex {
  meta: { generatedAt: string; source: string; operationCount: number };
  operations: ApiOperation[];
  aliasIndex: Record<string, string[]>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX = path.join(__dirname, "..", "data", "api-operation-index.json");
let cached: ApiOperationIndex | null = null;

export function loadApiOperationIndex(indexPath = process.env.API_OPERATION_INDEX || DEFAULT_INDEX): ApiOperationIndex {
  if (cached) return cached;
  const raw = fs.readFileSync(indexPath, "utf8");
  cached = JSON.parse(raw) as ApiOperationIndex;
  return cached;
}

/** camelCase / snake_case 模块名 → kebab-case（如 movieFragment → movie-fragment） */
function moduleNameToKebab(name: string): string {
  return name
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

/** 生成 operation 查询的多种写法，兼容模型输出的 camelCase 模块名 */
function operationQueryVariants(query: string): string[] {
  const q = query.trim();
  if (!q) return [];
  const variants = new Set<string>([q, q.toLowerCase()]);
  const dot = q.indexOf(".");
  if (dot > 0) {
    const mod = q.slice(0, dot);
    const action = q.slice(dot + 1);
    const kebabMod = moduleNameToKebab(mod);
    variants.add(`${kebabMod}.${action}`);
    variants.add(`${kebabMod}.${action}`.toLowerCase());
    // 无连字符写法：moviefragment.getlist
    variants.add(`${mod.replace(/[-_]/g, "").toLowerCase()}.${action.toLowerCase()}`);
  } else {
    variants.add(moduleNameToKebab(q));
  }
  return [...variants];
}

function resolveByExactOrAlias(query: string, byId: Map<string, ApiOperation>, aliasIndex: Record<string, string[]>): ApiOperation | null {
  if (byId.has(query)) return byId.get(query) || null;
  const ids = aliasIndex[query.toLowerCase()];
  if (ids?.length === 1) return byId.get(ids[0]) || null;
  return null;
}

export function resolveApiOperation(query: string): ApiOperation | null {
  const q = query.trim();
  if (!q) return null;
  const index = loadApiOperationIndex();
  const byId = new Map(index.operations.map((o) => [o.id, o]));

  for (const variant of operationQueryVariants(q)) {
    const variantLower = variant.toLowerCase();
    const ambiguous = index.aliasIndex[variantLower];
    if (ambiguous && ambiguous.length > 1) return null;
    const hit = resolveByExactOrAlias(variant, byId, index.aliasIndex);
    if (hit) return hit;
  }

  // 裸 action（如 getById）或无法唯一定位的 query，禁止模糊自动命中
  if (!q.includes(".")) return null;

  const lower = q.toLowerCase();
  const scored = index.operations
    .map((o) => {
      let score = 0;
      if (o.id.toLowerCase() === lower) score += 10;
      if (o.id.toLowerCase().includes(lower)) score += 5;
      if (o.path.toLowerCase().includes(lower)) score += 3;
      for (const a of o.aliases) {
        const al = a.toLowerCase();
        if (al === lower) score += 8;
        else if (al.includes(lower)) score += 2;
      }
      return { o, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.length ? scored[0].o : null;
}

export function findApiOperationCandidates(query: string, limit = 5): ApiOperation[] {
  const q = query.trim();
  if (!q) return [];
  const index = loadApiOperationIndex();
  const byId = new Map(index.operations.map((o) => [o.id, o]));

  for (const variant of operationQueryVariants(q)) {
    const aliasIds = index.aliasIndex[variant.toLowerCase()] || [];
    const aliasHits = aliasIds.map((id) => byId.get(id)).filter((x): x is ApiOperation => Boolean(x));
    if (aliasHits.length) return aliasHits.slice(0, limit);
    if (byId.has(variant)) return [byId.get(variant)!];
  }

  const lower = q.toLowerCase();
  return index.operations
    .map((o) => {
      let score = 0;
      if (o.id.toLowerCase().includes(lower)) score += 5;
      if (o.path.toLowerCase().includes(lower)) score += 3;
      for (const a of o.aliases) {
        const al = a.toLowerCase();
        if (al === lower) score += 8;
        else if (al.includes(lower)) score += 2;
      }
      return { o, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.o);
}

/** 归一化接口 path：去除前导斜杠（模型常从 getUserUrl(Api.X) 抄出带 / 的完整路径，
 *  而索引登记的是无前导斜杠形式，精确匹配会误报「未在接口索引中登记」——2026-08-24 事故）。 */
function normalizeApiPath(p: string): string {
  return p.trim().replace(/^\/+/, "");
}

export function hasOperationPath(pathname: string): boolean {
  const p = normalizeApiPath(pathname);
  if (!p) return false;
  const idx = loadApiOperationIndex();
  return idx.operations.some((o) => normalizeApiPath(o.path) === p);
}

export function resolveApiOperationByPath(pathname: string): ApiOperation | null {
  const p = normalizeApiPath(pathname);
  if (!p) return null;
  const idx = loadApiOperationIndex();
  const hit = idx.operations.find((o) => normalizeApiPath(o.path) === p);
  return hit || null;
}

/** path 后缀唯一匹配（2026-08-24：模型常从 getUserUrl(Api.X) 抄出残缺 path，
 *  如 /v1.9.0/beac/list 丢前缀；精确未命中时按「唯一后缀」兜底，多命中不猜返回 null）。 */
export function resolveApiOperationByPathSuffix(pathname: string): ApiOperation | null {
  const p = normalizeApiPath(pathname);
  if (!p) return null;
  const idx = loadApiOperationIndex();
  const hits = idx.operations.filter((o) => normalizeApiPath(o.path).endsWith(p));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * 从模型臆造/抄错的 path 反推 operation id（弱模型常把 user.getList 写成 /v0.1/user/getList，
 * 而索引真实 path 是 /v0.1/useraccount/get）。仅做结构变换，命中索引才有效。
 * 例：/v0.1/user/getList → 剥版本 → user/getList → user.getList
 */
export function guessOperationIdFromPath(pathname: string): string | null {
  let p = normalizeApiPath(pathname);
  if (!p) return null;
  p = p.replace(/^v[\d.]+\/?/i, "");
  const parts = p.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const func = parts[parts.length - 1];
  const mod = parts[parts.length - 2];
  if (!/^[A-Za-z_][\w]*$/.test(func) || !/^[A-Za-z_][\w-]*$/.test(mod)) return null;
  return `${mod}.${func}`;
}
