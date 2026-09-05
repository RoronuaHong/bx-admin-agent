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

  // 完整 id 精确命中（大小写不敏感）
  if (byId.has(q)) return byId.get(q) || null;
  const qLower = q.toLowerCase();
  for (const [id, op] of byId) {
    if (id.toLowerCase() === qLower) return op;
  }

  // 裸 action（无 module.func）：禁止别名/结构/模糊（避免 "get" 误命中某个 getById）
  if (!q.includes(".")) return null;

  for (const variant of operationQueryVariants(q)) {
    const variantLower = variant.toLowerCase();
    const ambiguous = index.aliasIndex[variantLower];
    if (ambiguous && ambiguous.length > 1) return null;
    const hit = resolveByExactOrAlias(variant, byId, index.aliasIndex);
    if (hit) return hit;
  }

  const structural = resolveByStructuralHint(q, index);
  if (structural) return structural;

  // 模糊分：仅当最高分唯一才采纳（并列第一 = 歧义，不猜）
  return pickUniqueTopScore(index.operations, q);
}

/** 按 includes/别名打分，仅返回唯一最高分命中；并列或零分 → null */
function pickUniqueTopScore(operations: ApiOperation[], query: string): ApiOperation | null {
  const lower = query.trim().toLowerCase();
  if (!lower) return null;
  const scored = operations
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
  if (!scored.length) return null;
  const top = scored[0].score;
  const tops = scored.filter((x) => x.score === top);
  return tops.length === 1 ? tops[0].o : null;
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

  const structural = resolveByStructuralHint(q, index);
  if (structural) return [structural];

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

/** 压平标识符：userAccount / user-account / user_account → useraccount */
function flattenIdent(s: string): string {
  return s.replace(/[-_/]/g, "").toLowerCase();
}

/** 驼峰/数字边界切词：getUserList → ["get","User","List"] */
function splitCamelTokens(ident: string): string[] {
  return ident
    .replace(/([a-z0-9])([A-Z])/g, "$1|$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1|$2")
    .split(/[|_\-/]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 函数名宽松相关：精确 / 互为前后缀（getList↔get、getUserList↔getList）。
 * 只做字符串形态，不认业务语义。
 */
function funcsLooselyRelated(guess: string, actual: string): boolean {
  const g = flattenIdent(guess);
  const a = flattenIdent(actual);
  if (!g || !a) return false;
  if (g === a) return true;
  if (g.length >= 3 && a.length >= 3 && (g.includes(a) || a.includes(g))) return true;
  return false;
}

/**
 * 结构回落总入口（语言无关、零业务词表）：
 * 1) path 段 / 模块 id 压平 ≈ 臆造模块 token + func 宽松匹配（唯一）
 * 2) 从驼峰 func 抽出中间名词，试 {noun}.{func变体}（唯一）
 */
function resolveByStructuralHint(operation: string, index: ApiOperationIndex): ApiOperation | null {
  const parts = operation
    .trim()
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const func = parts[parts.length - 1];
  const modParts = parts.slice(0, -1);

  const byPathOrMod = resolveByModuleTokenHint(modParts, func, index);
  if (byPathOrMod) return byPathOrMod;

  const byNoun = resolveByEmbeddedNounHint(func, index);
  if (byNoun) return byNoun;

  return null;
}

/**
 * 模块 token 回落：臆造模块名压平后
 * - 等于 path 某一段，或
 * - 等于 operation 模块 id / 文件模块末段
 * 且 func 宽松匹配。
 * 按 token 长度优先逐个试；某一 token 唯一命中即返回（避免 userAccount 拆成 user+account 并集歧义）。
 */
function resolveByModuleTokenHint(
  modParts: string[],
  func: string,
  index: ApiOperationIndex,
): ApiOperation | null {
  const candidates = new Set<string>();
  const add = (raw: string) => {
    const flat = flattenIdent(raw);
    if (flat.length >= 2) candidates.add(flat);
  };
  add(modParts.join(""));
  add(modParts.join("/"));
  add(modParts[modParts.length - 1] || "");
  for (const p of modParts) {
    add(p);
    for (const t of splitCamelTokens(p)) add(t);
  }

  const ordered = [...candidates].sort((a, b) => b.length - a.length || a.localeCompare(b));

  for (const token of ordered) {
    const idHits: ApiOperation[] = [];
    const pathHits: ApiOperation[] = [];
    const seenId = new Set<string>();
    const seenPath = new Set<string>();
    for (const o of index.operations) {
      const idFunc = o.func || o.id.split(".").pop() || "";
      if (!funcsLooselyRelated(func, idFunc)) continue;
      const pathSegs = normalizeApiPath(o.path)
        .toLowerCase()
        .split("/")
        .filter(Boolean)
        .map((s) => s.replace(/[-_]/g, ""));
      const modIdFlat = flattenIdent(o.id.split(".")[0] || "");
      const modTailFlat = flattenIdent((o.module || "").split("/").pop() || "");
      const fileFlat = flattenIdent((o.file || "").replace(/\.ts$/i, "").split("/").pop() || "");
      const idMatch = modIdFlat === token || modTailFlat === token || fileFlat === token;
      const pathMatch = pathSegs.includes(token);
      if (idMatch) {
        if (!seenId.has(o.id)) {
          seenId.add(o.id);
          idHits.push(o);
        }
      } else if (pathMatch) {
        if (!seenPath.has(o.id)) {
          seenPath.add(o.id);
          pathHits.push(o);
        }
      }
    }
    // 优先模块 id/文件名精确命中（避免 sysUser→user 时 path 里多个 /user/ 并集歧义）
    if (idHits.length === 1) return idHits[0];
    if (idHits.length === 0 && pathHits.length === 1) return pathHits[0];
  }
  return null;
}

/** 通用 API 英文形态（非业务词）：CRUD 动词 / 资源尾缀 */
const API_VERB = /^(get|query|fetch|load|find|search|list|create|add|update|edit|delete|remove|set|save|put|post)$/i;
const API_TAIL = /^(list|detail|page|info|data|all|one|byid|byname|rows|items)$/i;

/** 从驼峰 func 推导候选函数名：原样 + Verb+Tail 折叠（getUserList→getList） */
function guessFuncVariants(func: string): string[] {
  const out = new Set<string>([func]);
  const tokens = splitCamelTokens(func);
  if (tokens.length >= 3 && API_VERB.test(tokens[0]) && API_TAIL.test(tokens[tokens.length - 1])) {
    const verb = tokens[0];
    const tail = tokens[tokens.length - 1];
    out.add(`${verb}${tail.charAt(0).toUpperCase()}${tail.slice(1)}`);
  }
  return [...out];
}

/**
 * 驼峰嵌名词回落：demo.getUserList → 抽出 User → 试 user.getList 等。
 */
function resolveByEmbeddedNounHint(func: string, index: ApiOperationIndex): ApiOperation | null {
  const tokens = splitCamelTokens(func);
  if (tokens.length < 2) return null;

  const nouns = tokens.filter((t, i) => {
    if (i === 0 && API_VERB.test(t)) return false;
    if (i === tokens.length - 1 && API_TAIL.test(t)) return false;
    return !API_VERB.test(t) && !API_TAIL.test(t);
  });
  if (!nouns.length) return null;

  const byId = new Map(index.operations.map((o) => [o.id.toLowerCase(), o]));
  const hits: ApiOperation[] = [];
  const seen = new Set<string>();

  for (const noun of nouns) {
    const mod = noun.charAt(0).toLowerCase() + noun.slice(1);
    const modFlat = flattenIdent(mod);
    for (const gf of guessFuncVariants(func)) {
      const id = `${mod}.${gf}`;
      const hit = byId.get(id.toLowerCase());
      if (hit && !seen.has(hit.id)) {
        seen.add(hit.id);
        hits.push(hit);
      }
    }
    for (const o of index.operations) {
      const modTail = flattenIdent((o.module || o.id.split(".")[0] || "").split("/").pop() || "");
      const fileFlat = flattenIdent((o.file || "").replace(/\.ts$/i, "").split("/").pop() || "");
      if (modTail !== modFlat && fileFlat !== modFlat) continue;
      if (!funcsLooselyRelated(func, o.func || o.id.split(".").pop() || "")) continue;
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      hits.push(o);
    }
  }
  return hits.length === 1 ? hits[0] : null;
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
