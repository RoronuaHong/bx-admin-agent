/**
 * 纯 i18n 页面模块反查（A+ 方案，2026-08-24）
 *
 * 解决「账号合并」类纯 i18n 页面中文定位断链：中文术语在业务源码（src/api、src/views）无直接命中，
 * 仅存在于翻译表（src/locales/lang/zh-CN/tran*.ts）时，通过四跳实时反查定位模块：
 *   术语 → 翻译表 key → 路由 meta.title 引用 → 组件文件 → @/api/xxx import → 模块 id
 *
 * 设计红线：
 * - 零映射表/零静态产物：全部逻辑实时读当前项目源码 + 正则，不生成任何 JSON 索引/目录；
 * - 零硬编码：不含任何项目名/模块名/中文词，新项目任意架构（i18n/纯英文/硬编码中文）零适配；
 * - per-root 文件内容缓存（mtime 校验）避免重复读盘，多项目按 codebaseRoot 天然隔离；
 * - 结果交调用方裁决（服务端兜底唯一直接用/多候选阈值防歧义；工具路径交模型 top-k 选择），不硬路由。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import nodePath from "node:path";
// 注意：本模块不静态依赖 project-context（避免验证/构建脚本连带加载项目注册表链）。
// codebase root 由调用方注入：workflow-orchestrate.ts / tools.ts 传 resolveCodebaseRoot()。

export interface TranslationModuleHit {
  /** 模块 id（如 <模块>/<接口模块>） */
  moduleId: string;
  /** 路由 path（如 /account/merge，尽量拼接全路径） */
  route: string;
  /** 页面组件路径（如 views/account/accountMerge/List.vue） */
  component: string;
  /** 菜单中文标题（路由 meta.title 解析结果） */
  title: string;
  /** 翻译表 key（如 mzlyqkkqswmwrytb） */
  key: string;
}

// —— per-root 文件内容缓存（mtime 校验，避免每次请求重复读盘） ——
const fileCache = new Map<string, { text: string; mtimeMs: number }>();

function cachedRead(absPath: string): string | null {
  try {
    const st = statSync(absPath);
    const hit = fileCache.get(absPath);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
    const text = readFileSync(absPath, "utf-8");
    fileCache.set(absPath, { text, mtimeMs: st.mtimeMs });
    return text;
  } catch {
    return null;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// —— 目录树 → 文件列表缓存（目录 mtime 失效，避免每次请求重复 readdirSync 递归列目录树） ——
// 文件内容变化由 cachedRead 的 mtime 校验兜底；目录 mtime 在直接子项增删时更新，二者配合安全。
const dirListCache = new Map<string, { mtimeMs: number; files: string[] }>();

/** 递归收集目录下所有文件（归一化正斜杠；扩展名在取用时过滤，缓存供多个调用方共用）。
 *  缓存 key 为起始目录绝对路径（天然含项目隔离），目录 mtime 未变则复用文件列表。 */
function walkFiles(dir: string, exts: RegExp): string[] {
  let st;
  try {
    st = statSync(dir);
  } catch {
    return [];
  }
  const hit = dirListCache.get(dir);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.files.filter((f) => exts.test(f));
  const out: string[] = [];
  const walk = (d: string) => {
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = nodePath.join(d, ent.name);
      if (ent.isDirectory()) {
        // 防御：跳过超大噪声目录（翻译表/路由下本不该有，避免误扫巨树拖慢反查）
        if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "dist" || ent.name === "build") continue;
        walk(p);
      } else {
        out.push(p.replace(/\\/g, "/"));
      }
    }
  };
  walk(dir);
  dirListCache.set(dir, { mtimeMs: st.mtimeMs, files: out.slice() });
  return out.filter((f) => exts.test(f));
}

/** 第一步：术语 → 翻译表 key。精确值匹配优先，无精确再包含匹配（避免泛词误伤）。
 *  兼容业务词含用户输入残渣（如 extractGrepPattern 粘连的数字「账号合并558523069977」）：
 *  先生成「剥离数字/英文/标点」的中文变体，逐变体匹配。 */
export function findTranslationKeys(term: string, root: string): string[] {
  const base = nodePath.join(root, "src", "locales", "lang", "zh-CN");
  const files = walkFiles(base, /\.(ts|json)$/);
  const variants = [
    term,
    term.replace(/[0-9a-zA-Z，。,.、\s\-—–/\\()（）:：;；'"“”]+/g, "").trim(),
  ].filter((v, i, arr) => v && arr.indexOf(v) === i);
  const keys: string[] = [];
  for (const v of variants) {
    const exactRe = new RegExp(`([A-Za-z0-9_]+)\\s*:\\s*(?:['"\`])${escapeRegExp(v)}(?:['"\`])`);
    const containRe = new RegExp(`([A-Za-z0-9_]+)\\s*:\\s*(?:['"\`])[^'"\`]*${escapeRegExp(v)}[^'"\`]*(?:['"\`])`);
    for (const file of files) {
      const text = cachedRead(file);
      if (!text) continue;
      let m = text.match(exactRe);
      if (m) {
        keys.push(m[1]);
        continue;
      }
      m = text.match(containRe);
      if (m) keys.push(m[1]);
    }
    if (keys.length) break; // 高置信变体（精确/包含）已命中则不再用低置信变体
  }
  return [...new Set(keys)];
}

/**
 * 从文本中提取包含 index 且满足全部字段（minFields 正则）的最小对象块。
 * 从 title 位置向上逐层扩括号（meta 块 → 路由块），避免只截到 meta: {...} 拿不到 component。
 */
function extractEnclosingBlock(text: string, index: number, minFields: RegExp[]): string {
  let start = index;
  for (let hop = 0; hop < 4; hop++) {
    const s = text.lastIndexOf("{", start);
    if (s < 0) break;
    let depth = 0;
    let end = -1;
    for (let i = s; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) break;
    const block = text.slice(s, end + 1);
    if (minFields.every((re) => re.test(block))) return block;
    start = s - 1; // 当前块字段不全 → 继续向外扩一层
  }
  return "";
}

/** 第二步：翻译表 key → 路由对象块（path/component/title）。只认 src/router/** 下 ts/js */
function findRouteRefs(key: string, root: string): Array<{ route: string; component: string; title: string }> {
  const routerDir = nodePath.join(root, "src", "router");
  const files = walkFiles(routerDir, /\.(ts|js)$/);
  const hits: Array<{ route: string; component: string; title: string }> = [];
  const keyRe = new RegExp(`title\\s*:\\s*(?:t\\s*\\(\\s*['"][^'"]*\\.)?${escapeRegExp(key)}`, "g");
  const needFields = [
    /component\s*:\s*\(\)\s*=>\s*import\s*\(\s*['"]/,
    /path\s*:\s*['"]/,
  ];
  for (const file of files) {
    const text = cachedRead(file);
    if (!text) continue;
    let m: RegExpExecArray | null;
    while ((m = keyRe.exec(text))) {
      const block = extractEnclosingBlock(text, m.index, needFields);
      if (!block) continue;
      const comp = block.match(/component\s*:\s*\(\)\s*=>\s*import\s*\(\s*['"](?:\/@\/)?views\/([^'"]+)['"]\s*\)/i);
      if (!comp) continue; // 无 views 组件的块（父布局/懒加载变量）跳过
      const routePath = block.match(/path\s*:\s*['"]([^'"]+)['"]/)?.[1] || "";
      const title = resolveRouteTitle(block, root) || "";
      hits.push({ route: routePath, component: comp[1], title });
    }
  }
  return hits;
}

/** 从路由块提取中文标题：i18n key（查翻译表）/ getTran 第二参数 / 直接中文，三形态兼容 */
function resolveRouteTitle(block: string, root: string): string {
  // 1) t('tran40.menus.xxx') → 查翻译表
  const tKey = block.match(/title\s*:\s*t\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  if (tKey?.[1]) return resolveI18nValue(tKey[1], root);
  // 2) getTran('KEY','[中文]', ...) → 第二参数。
  //    兼容多参数形态 t(getTran('FECB...', '[编辑用户]', false, true))（编辑页 hideMenu title，
  //    2026-08-24 审查发现原 `\s*,?\s*\)` 不匹配第二参数后还有实参的调用）：
  //    `[^)]*\)` 允许第二参数后跟任意非 `)` 内容直到最近右括号（getTran 参数不含 `)`）。
  const gtr = block.match(/getTran\(\s*['"`][^'"`]+['"`]\s*,\s*['"`]([^'"`]*)['"`][^)]*\)/);
  if (gtr?.[1]) return gtr[1].trim().replace(/^\[|\]$/g, "");
  // 3) 直接中文
  const lit = block.match(/title\s*:\s*['"]([^'"]+)['"]/);
  if (lit?.[1]) return lit[1].trim();
  return "";
}

/** 翻译表 key（如 tran40.menus.mzlyqkkqswmwrytb / routes.basic.errorLogList）→ 中文值。
 *  兼容 ts/json 根目录文件 + zh-CN/routes/ 子目录（routes.<页面文件名>.<leaf>，2026-08-24 审查补缺） */
function resolveI18nValue(key: string, root: string): string {
  const parts = key.split(".");
  if (parts.length < 2) return "";
  const fileKey = parts[0];
  const leaf = parts[parts.length - 1];
  const base = nodePath.join(root, "src", "locales", "lang", "zh-CN");
  // 根目录文件（tran40.ts 等）+ routes/ 子目录按中间段定位文件（routes.basic.errorLogList → routes/basic.ts）
  const candidates = [
    nodePath.join(base, `${fileKey}.ts`),
    nodePath.join(base, `${fileKey}.json`),
    ...(parts.length >= 3 ? [nodePath.join(base, "routes", `${parts[1]}.ts`), nodePath.join(base, "routes", `${parts[1]}.json`)] : []),
  ];
  for (const file of candidates) {
    const text = cachedRead(file);
    if (!text) continue;
    const re = new RegExp(`${escapeRegExp(leaf)}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`);
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }
  return "";
}

/** 第三步：组件文件 → @/api/xxx import → 模块 id */
function moduleFromComponent(component: string, root: string): string | null {
  const abs = nodePath.join(root, "src", "views", component);
  const text = cachedRead(abs);
  if (!text) return null;
  const imp = text.match(/(?:from\s+['"]|import\s*\(\s*['"])(?:\/@\/|@\/)api\/([A-Za-z0-9_./-]+)['"]/);
  return imp ? imp[1].replace(/\/$/, "") : null;
}

/**
 * 完整四跳反查：中文术语 → 候选模块列表（按 moduleId 去重）。
 * 返回空数组表示翻译表/路由/组件任一环节未命中或页面无 api import（C3 纯英文由模型 grep 处理）。
 */
export function lookupTermModules(term: string, root: string): TranslationModuleHit[] {
  const keys = findTranslationKeys(term, root);
  const hits: TranslationModuleHit[] = [];
  for (const key of keys) {
    for (const route of findRouteRefs(key, root)) {
      const moduleId = moduleFromComponent(route.component, root);
      if (!moduleId) continue;
      hits.push({
        moduleId,
        route: route.route,
        component: route.component,
        title: route.title || term,
        key,
      });
    }
  }
  const seen = new Set<string>();
  const out: TranslationModuleHit[] = [];
  for (const h of hits) {
    if (seen.has(h.moduleId)) continue;
    seen.add(h.moduleId);
    out.push(h);
  }
  return out;
}

/** 格式化候选清单（供 search_api_module / orchestrate 兜底提示展示） */
export function formatTranslationHits(term: string, hits: TranslationModuleHit[]): string {
  if (!hits.length) return "";
  const lines = hits.map(
    (h) => `- ${h.moduleId}（菜单「${h.title}」，路由 ${h.route || "(未解析)"}，页面 ${h.component}）`,
  );
  return `[翻译表反查]「${term}」命中翻译表，实时反查路由与页面源码得到候选模块：\n${lines.join("\n")}`;
}
