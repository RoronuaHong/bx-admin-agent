/**
 * 菜单/翻译标题「近邻召回」（纯算法，零业务同义词表）。
 *
 * 背景：口语与源码标题仅差 1～2 字时（如用户说「影视列表」、菜单是「影片列表」），
 * 整词 grep / 翻译表精确反查都会 miss；若直接走词尾收缩，会把 query 砍成更短泛词
 * （「影视」），召回被「影视速递」等含该子串的模块截胡，正确答案不进候选集。
 *
 * 解法：整词 miss 后、收缩前，用编辑距离在现有翻译表中文标题语料上找近邻标题，
 * 再按近邻标题做轻量 grep / 翻译表反查。无任何「词 A = 词 B」映射——近邻来自项目
 * 源码里真实存在的标题字符串。
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import nodePath from "node:path";
import { runContractSearch, contractCandidates } from "./query-contraction.js";
import { lookupTermModules, type TranslationModuleHit, formatTranslationHits } from "./translation-lookup.js";

export interface NearTitleMatch {
  /** 语料中的真实标题 */
  title: string;
  /** 与 query 的 Levenshtein 距离（>0） */
  distance: number;
}

export interface NearTitleRecallHit {
  title: string;
  distance: number;
  /** api/views 下命中文件 */
  files: string[];
  /** 翻译表反查候选（可空） */
  modules: TranslationModuleHit[];
  /** 从命中页面提取的 api import（权威模块线索） */
  pageImports: string[];
}

const titleCorpusCache = new Map<string, { mtimeMs: number; titles: string[] }>();

/** Levenshtein（码点级，适合中文单字替换/增删）。 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const aa = Array.from(a);
  const bb = Array.from(b);
  const n = aa.length;
  const m = bb.length;
  if (!n) return m;
  if (!m) return n;
  const prev = new Array<number>(m + 1);
  const cur = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= m; j++) prev[j] = cur[j];
  }
  return prev[m];
}

/**
 * 允许的最大编辑距离：短标题（≤6 字）只允许 1，避免「列表→速递」这类 2 字替换误召回；
 * 更长标题放宽到 2。纯长度启发式，无业务词表。
 */
export function maxNearDistance(queryLen: number): number {
  return queryLen <= 6 ? 1 : 2;
}

function walkLocaleFiles(dir: string, acc: string[]): void {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    if (ent.name.startsWith(".")) continue;
    const full = nodePath.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === "dist") continue;
      walkLocaleFiles(full, acc);
    } else if (ent.isFile() && /\.(ts|js|json)$/i.test(ent.name)) {
      acc.push(full);
    }
  }
}

/** 从 zh-CN 翻译表抽取中文标题语料（2～24 字、以汉字为主）。 */
export function collectLocaleTitles(root: string): string[] {
  const base = nodePath.join(root, "src", "locales", "lang", "zh-CN");
  let st;
  try {
    st = statSync(base);
  } catch {
    return [];
  }
  const cached = titleCorpusCache.get(base);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.titles;

  const files: string[] = [];
  walkLocaleFiles(base, files);
  const titles = new Set<string>();
  const litRe = /['"`]([^'"`\n]{2,24})['"`]/g;
  for (const file of files) {
    let text: string;
    try {
      const fst = statSync(file);
      if (fst.size > 2 * 1024 * 1024) continue;
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let m: RegExpExecArray | null;
    while ((m = litRe.exec(text))) {
      const v = m[1].trim().replace(/^\[|\]$/g, "");
      if (v.length < 2 || v.length > 24) continue;
      const han = (v.match(/[\u4e00-\u9fa5]/g) || []).length;
      if (han < Math.ceil(v.length / 2)) continue;
      if (/[{}<>$=]/.test(v)) continue;
      titles.add(v);
    }
  }
  const list = [...titles];
  titleCorpusCache.set(base, { mtimeMs: st.mtimeMs, titles: list });
  return list;
}

/** 在语料中找与 query 编辑距离落在阈值内的近邻标题（不含自身精确命中）。 */
export function findNearTitles(query: string, root: string, limit = 8): NearTitleMatch[] {
  const q = query.trim();
  if (q.length < 2 || !/[\u4e00-\u9fa5]/.test(q)) return [];
  const maxDist = maxNearDistance(Array.from(q).length);
  const qLen = Array.from(q).length;
  const out: NearTitleMatch[] = [];
  for (const title of collectLocaleTitles(root)) {
    if (title === q) continue;
    const tLen = Array.from(title).length;
    if (Math.abs(tLen - qLen) > maxDist) continue;
    const d = editDistance(q, title);
    if (d > 0 && d <= maxDist) out.push({ title, distance: d });
  }
  out.sort((a, b) => a.distance - b.distance || a.title.length - b.title.length || a.title.localeCompare(b.title));
  if (!out.length) return [];
  const best = out[0].distance;
  return out.filter((x) => x.distance === best).slice(0, limit);
}

function isRgMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EACCES";
}

/** 越小越优先：页面 index/List 优先。 */
function scoreFile(file: string): number {
  let s = 100;
  if (/[\\/]views[\\/].*[\\/](index|List)\.(vue|tsx?)$/i.test(file)) s -= 40;
  if (/[\\/]api[\\/]/i.test(file)) s -= 10;
  s += Math.min(file.length / 20, 20);
  return s;
}

/** 轻量 rg -l；rg 缺失时原生 includes 回退。 */
function listFilesContaining(pattern: string, dirs: string[], maxFiles: number): string[] {
  const found: string[] = [];
  const dirsOk = dirs.filter(Boolean);
  if (!dirsOk.length || !pattern) return found;
  try {
    const cmd = `rg --no-heading -l -i -- "${pattern.replace(/"/g, '\\"')}" ${dirsOk.map((d) => `"${d}"`).join(" ")}`;
    const raw = execSync(cmd, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 8000 }).toString();
    for (const line of raw.split("\n")) {
      const f = line.trim();
      if (f) found.push(f);
    }
  } catch (e: unknown) {
    if (isRgMissing(e)) {
      const lower = pattern.toLowerCase();
      const walk = (dir: string) => {
        let ents;
        try {
          ents = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of ents) {
          if (ent.name.startsWith(".")) continue;
          const full = nodePath.join(dir, ent.name);
          if (ent.isDirectory()) {
            if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "dist") continue;
            walk(full);
          } else if (ent.isFile() && /\.(ts|tsx|vue|js|jsx|json)$/i.test(ent.name)) {
            if (/tran\.json$/i.test(ent.name)) continue;
            try {
              const st = statSync(full);
              if (st.size > 2 * 1024 * 1024) continue;
              if (readFileSync(full, "utf8").toLowerCase().includes(lower)) found.push(full);
            } catch {
              /* skip */
            }
          }
        }
      };
      for (const d of dirsOk) walk(d);
    }
  }
  return found
    .sort((a, b) => scoreFile(a) - scoreFile(b) || a.localeCompare(b))
    .slice(0, maxFiles);
}

function extractPageImports(files: string[]): string[] {
  const pageApiFns = new Set<string>();
  for (const vf of files.filter((f) => /[\\/]views[\\/]/i.test(f)).slice(0, 8)) {
    try {
      const vc = readFileSync(vf, "utf8").slice(0, 256 * 1024);
      for (const m of vc.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:\/@\/|@\/)api\/([A-Za-z0-9_./-]+)['"]/g)) {
        const names = m[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean);
        const mod = m[2].replace(/\/+$/, "");
        for (const n of names) pageApiFns.add(`${n}（模块 ${mod}）`);
      }
    } catch {
      /* skip */
    }
  }
  return [...pageApiFns].slice(0, 24);
}

/**
 * 近邻召回主入口：找最优编辑距离档标题，并对每个标题做 api/views grep + 翻译表反查。
 * 全部近邻都无文件/模块命中时返回空数组。
 */
export function recallByNearTitles(query: string, root: string, maxFilesPerTitle = 12): NearTitleRecallHit[] {
  const near = findNearTitles(query, root);
  if (!near.length) return [];
  const apiDir = nodePath.join(root, "src", "api");
  const viewsDir = nodePath.join(root, "src", "views");
  const hits: NearTitleRecallHit[] = [];
  for (const n of near) {
    const files = listFilesContaining(n.title, [apiDir, viewsDir], maxFilesPerTitle).filter(
      (f) => !/[\\/]local[\\/]/i.test(f) && !/tran\.json$/i.test(f),
    );
    let modules: TranslationModuleHit[] = [];
    try {
      modules = lookupTermModules(n.title, root);
    } catch {
      modules = [];
    }
    if (!files.length && !modules.length) continue;
    hits.push({
      title: n.title,
      distance: n.distance,
      files,
      modules,
      pageImports: extractPageImports(files),
    });
  }
  return hits;
}

/**
 * 查询词「包含现有菜单/翻译标题」召回（纯算法，无同义词表）。
 * 例：「影片新上线列表」整词 miss，但语料里有「新上线」是其子串 → 按该标题 grep / 翻译反查，
 * 避免词尾收缩到「影片」误召回无关列表。
 */
export function findContainedLocaleTitles(query: string, root: string, limit = 6): string[] {
  const q = query.trim();
  if (Array.from(q).length < 3) return [];
  const scored: Array<{ title: string; len: number }> = [];
  for (const title of collectLocaleTitles(root)) {
    const tLen = Array.from(title).length;
    // 至少 3 字：避免「影片」「列表」等过短子串淹没专项标题（「新上线」）
    if (tLen < 3 || tLen >= Array.from(q).length) continue;
    if (!q.includes(title)) continue;
    scored.push({ title, len: tLen });
  }
  scored.sort((a, b) => b.len - a.len || a.title.localeCompare(b.title));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of scored) {
    if (seen.has(s.title)) continue;
    // 被更长标题完全覆盖的短标题跳过（「列表」被「二级分类列表」覆盖）
    if (out.some((longer) => longer.includes(s.title))) continue;
    seen.add(s.title);
    out.push(s.title);
    if (out.length >= limit) break;
  }
  return out;
}

export function recallByContainedLocaleTitles(
  query: string,
  root: string,
  maxFilesPerTitle = 12,
): NearTitleRecallHit[] {
  const titles = findContainedLocaleTitles(query, root);
  if (!titles.length) return [];
  const apiDir = nodePath.join(root, "src", "api");
  const viewsDir = nodePath.join(root, "src", "views");
  const hits: NearTitleRecallHit[] = [];
  for (const title of titles) {
    const files = listFilesContaining(title, [apiDir, viewsDir], maxFilesPerTitle).filter(
      (f) => !/[\\/]local[\\/]/i.test(f) && !/tran\.json$/i.test(f),
    );
    let modules: TranslationModuleHit[] = [];
    try {
      modules = lookupTermModules(title, root);
    } catch {
      modules = [];
    }
    if (!files.length && !modules.length) continue;
    hits.push({
      title,
      distance: 0,
      files,
      modules,
      pageImports: extractPageImports(files),
    });
  }
  return hits;
}

/** 格式化：查询词包含语料标题的子串召回。 */
export function formatContainedTitleHits(query: string, hits: NearTitleRecallHit[]): string {
  if (!hits.length) return "";
  const lines: string[] = [
    `[标题子串召回]「${query}」整词未直接命中；命中其包含的现有菜单/翻译标题（纯算法、无同义词表）：`,
  ];
  for (const h of hits) {
    lines.push(`- 包含标题「${h.title}」`);
    if (h.files.length) {
      lines.push(`  源码命中：`);
      for (const f of h.files.slice(0, 6)) lines.push(`  - ${f}`);
    }
    if (h.pageImports.length) {
      lines.push(`  页面 import / 配置引用的接口函数（权威，优先使用）：`);
      for (const p of h.pageImports.slice(0, 10)) lines.push(`  - ${p}`);
    }
    if (h.modules.length) {
      for (const m of h.modules.slice(0, 4)) {
        lines.push(`  模块候选：${m.moduleId}（菜单「${m.title}」，路由 ${m.route || "(未解析)"}）`);
      }
    }
  }
  lines.push(
    `\n建议：优先按包含标题对应页面/接口（尤其是专项列表函数名）read_api_module → call_api；` +
      `不要再把查询词收缩成更短泛词（易误召回其它模块）。`,
  );
  return lines.join("\n");
}

/** 格式化给模型：强调这是编辑距离近邻，不是同义词表；多候选时提示反问。 */
export function formatNearTitleHits(query: string, hits: NearTitleRecallHit[]): string {
  if (!hits.length) return "";
  const multi = hits.length > 1;
  const lines: string[] = [
    `[近邻标题召回]「${query}」在源码中未直接命中；与现有菜单/翻译标题按编辑距离召回` +
      `（距离 ${hits[0].distance}，纯算法、无同义词表）${multi ? "，存在多个等距近邻" : ""}：`,
  ];
  for (const h of hits) {
    lines.push(`- 近邻标题「${h.title}」（距离 ${h.distance}）`);
    if (h.files.length) {
      lines.push(`  源码命中：`);
      for (const f of h.files.slice(0, 6)) lines.push(`  - ${f}`);
    }
    if (h.pageImports.length) {
      lines.push(`  页面 import 的接口函数（权威，优先使用）：`);
      for (const p of h.pageImports.slice(0, 10)) lines.push(`  - ${p}`);
    }
    if (h.modules.length) {
      for (const m of h.modules.slice(0, 4)) {
        lines.push(`  模块候选：${m.moduleId}（菜单「${m.title}」，路由 ${m.route || "(未解析)"}）`);
      }
    }
  }
  if (multi) {
    lines.push(
      `\n建议：多个等距近邻时用 request_clarification 让用户确认对应菜单后再 read_api_module；` +
        `不要根据收缩短词硬猜。`,
    );
  } else {
    lines.push(
      `\n建议：优先按近邻标题「${hits[0].title}」对应页面/模块 read_api_module → call_api；` +
        `不要再用更短的收缩词（易误召回其它模块）。`,
    );
  }
  return lines.join("\n");
}

/**
 * 从用户原话扩展短 query 再做近邻召回。
 *
 * 弱模型常把「影视列表第一页」拆成 search query=「影视」；短词在源码里能直接命中
 * 「影视速递」等子串，从而绕过「整词 miss → 近邻」路径。此处用用户原话中的更长
 * 中文片段（含该短词）做编辑距离近邻——仍无同义词表。
 */
export function longestHanSpanContaining(query: string, userText: string): string | null {
  const q = query.trim();
  if (!q || !userText) return null;
  const runs = userText.match(/[\u4e00-\u9fa5]{2,24}/g) || [];
  let best: string | null = null;
  for (const run of runs) {
    if (!run.includes(q)) continue;
    if (!best || Array.from(run).length > Array.from(best).length) best = run;
  }
  return best && best !== q ? best : null;
}

/**
 * 若 userText 含比 query 更长的中文片段，对其及词尾收缩候选做召回：
 * 先精确翻译表反查，再编辑距离近邻。有命中则返回格式化文本，否则 null。
 */
export function recallNearFromUserUtterance(
  query: string,
  userText: string,
  root: string,
  maxFilesPerTitle = 12,
): string | null {
  const q = query.trim();
  const qLen = Array.from(q).length;
  // 仅对很短的 query（≤3 字，如「影视」）做原话扩展；「影片列表」「账号合并」等完整词走主路径
  if (qLen > 3) return null;
  const span = longestHanSpanContaining(q, userText);
  if (!span) return null;
  const cands = contractCandidates(span).filter((c) => Array.from(c).length >= Math.max(3, qLen));

  // Pass 1：全部候选先做翻译表精确反查（避免「账号合并列」近邻抢在「账号合并」精确之前返回）
  for (const cand of cands) {
    try {
      const exact = lookupTermModules(cand, root);
      if (exact.length) {
        const head =
          cand === q
            ? ""
            : `[用户原话扩展] search query「${q}」过短/易误召回；已用原话片段收缩为「${cand}」做翻译表反查（纯算法）。\n`;
        return (
          head +
          formatTranslationHits(cand, exact) +
          `\n\n建议：用 read_api_module 读取候选模块的接口源码（返回完整函数名与参数），确认后直接 call_api；不要 grep / list_dir 反复绕路。`
        );
      }
    } catch {
      /* 反查失败继续 */
    }
  }

  // Pass 2：近邻只跑原话整段 + 短 query 本身，不跑中间残缺收缩词（「影片列表管」「账号合并列」）
  const nearCands = [span, q].filter((c, i, arr) => c && arr.indexOf(c) === i);
  for (const cand of nearCands) {
    const hits = recallByNearTitles(cand, root, maxFilesPerTitle);
    if (!hits.length) continue;
    const body = formatNearTitleHits(cand, hits);
    if (cand === q) return body;
    return (
      `[用户原话扩展] search query「${q}」过短/易误召回；已用原话片段「${span}」做近邻召回（纯算法）。\n` + body
    );
  }
  return null;
}
