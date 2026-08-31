/**
 * PC 输出形态相关工具实现（列表列、页面类型、Markdown 表、图表摘要、字段映射）。
 * 由 tools.ts 的 runAgentTool 调度，禁止在别处复制一份。
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import nodePath from "node:path";
import { resolveLocalDoc } from "./sources.js";
import { defaultFieldMappingPath } from "./agent-docs.js";
import { resolveCodebaseRoot } from "./project-context.js";

function codebaseRoot(): string {
  return resolveCodebaseRoot();
}

function fieldMappingPath(): string {
  return defaultFieldMappingPath();
}

function safeRg(pattern: string, dir: string, glob?: string): string {
  const globArg = glob ? `--glob "${glob}"` : "";
  const cmd = `rg --no-heading --line-number --color never -i -m 20 ${globArg} -- "${pattern.replace(/"/g, '\\"')}" "${dir}"`;
  try {
    return execSync(cmd, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 12000 }).toString();
  } catch (e: unknown) {
    return (e as { stdout?: string }).stdout ?? "";
  }
}

function extractColumnsFromSource(src: string): Array<{ title: string; dataIndex: string; width?: number }> {
  const cols: Array<{ title: string; dataIndex: string; width?: number }> = [];
  // 按源码顺序收集所有列块起点与文本，再统一提取 dataIndex/title。
  // 兼容 PC 端 configs.data.tsx 的两种列写法：
  //  a) 单行：{ title: '观影总次数', dataIndex: 'totalWatchCount' }（历史上被漏掉 → 需手工补 field-mapping）
  //  b) 多行：{ \n title: ... \n dataIndex: ... \n }（含 customRender 等复杂列，用花括号平衡截取）
  const blocks: Array<{ start: number; text: string }> = [];

  // a) 单行列：{ ... } 同行闭合（`{` 到同行第一个 `}`，中间无换行）
  const singleRe = /\n\s*\{[^}\n]*\}/g;
  let sm: RegExpExecArray | null;
  while ((sm = singleRe.exec(src))) {
    blocks.push({ start: sm.index, text: src.slice(sm.index + 1, sm.index + sm[0].length) });
  }

  // b) 多行列：{ 后换行 → 括号平衡截取完整块
  const multiRe = /\n\s*\{\s*\n/g;
  let mm: RegExpExecArray | null;
  while ((mm = multiRe.exec(src))) {
    const start = mm.index + mm[0].lastIndexOf("{");
    let depth = 0;
    let end = -1;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
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
    blocks.push({ start, text: src.slice(start, end + 1) });
    multiRe.lastIndex = end + 1;
  }

  // 按源码顺序排序；已被更大块覆盖（start 落在前一块范围内）的跳过，避免重复/错位
  blocks.sort((a, b) => a.start - b.start);
  let lastEnd = -1;
  for (const block of blocks) {
    if (block.start < lastEnd) continue;
    lastEnd = block.start + block.text.length;
    const di = block.text.match(/dataIndex\s*:\s*['"`]([^'"`]+)['"`]/);
    const dataIndex = di?.[1]?.trim();
    if (!dataIndex) continue;
    if (cols.some((c) => c.dataIndex === dataIndex)) continue;

    let title = extractTitleFromBlock(block.text) || "";
    // title 为空或是变量引用（ratingTypeLabel 等）→ 用 dataIndex 兜底
    if (!title || /^[A-Za-z_$][\w$]*$/.test(title)) title = dataIndex;
    // width（PC 端列定义标准字段，2026-08-26 引入）：长文本列/数字列等 PC 端显式声明宽度，
    // 透传给前端 ResultTable 做列宽控制（避免 10+ 列均分导致拥挤）。
    const w = block.text.match(/\bwidth\s*:\s*(\d+)/);
    cols.push({ title, dataIndex, width: w?.[1] ? Number(w[1]) : undefined });
  }
  return cols;
}

/** 从列块 customRender 提取枚举映射（源码驱动，2026-08-24，替代配置表）。
 *  支持：const MAP = {...} 引用（含 import 跨文件跟随）、单三目（record.f === 1 ? 'a' : 'b'）、
 *  render: (t) => t ? '是' : '否'。返回 { [dataIndex]: { [value]: label } }。 */
function extractColumnEnumsFromSource(src: string, root: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  // 1) 收集常量表与 import
  const constMaps = new Map<string, Record<string, string>>();
  const cmRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{([\s\S]*?)\n?\}/g;
  let cm: RegExpExecArray | null;
  while ((cm = cmRe.exec(src))) {
    const vals = new Map<string, string>();
    const itemRe = /['"]?([\w-]+)['"]?\s*:\s*['"]([^'"]*)['"]/g;
    let im: RegExpExecArray | null;
    while ((im = itemRe.exec(cm[2]))) vals.set(im[1], im[2]);
    if (vals.size) constMaps.set(cm[1], Object.fromEntries(vals));
  }
  const imports = new Map<string, string>();
  const impRe = /import\s*\{[^}]*?([A-Za-z_$][\w$]*)[^}]*?\}\s*from\s*['"]([^'"]+)['"]/g;
  let im2: RegExpExecArray | null;
  while ((im2 = impRe.exec(src))) imports.set(im2[1], im2[2]);
  const readImported = (name: string, from: string): Record<string, string> => {
    let p = from.replace(/^\/?@\//, ""); // /@/ 或 @/ → src/
    if (!/\.(ts|tsx|js)$/.test(p)) p = `${p}.ts`;
    const full = nodePath.join(root, "src", p);
    if (!existsSync(full)) return {};
    try {
      const t = readFileSync(full, "utf8");
      const m = t.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\{([\\s\\S]*?)\\n?\\}`));
      const d = t.match(/export\s+default\s*\{([\s\S]*?)\n?\}/);
      const body = m?.[1] || d?.[1];
      if (!body) return {};
      const vals = new Map<string, string>();
      const itemRe = /['"]?([\w-]+)['"]?\s*:\s*['"]([^'"]*)['"]/g;
      let k: RegExpExecArray | null;
      while ((k = itemRe.exec(body))) vals.set(k[1], k[2]);
      return Object.fromEntries(vals);
    } catch {
      return {};
    }
  };

  // 2) 按列块提取（复用块切分：单行 + 多行括号平衡）
  const blocks: Array<{ start: number; text: string }> = [];
  const singleRe = /\n\s*\{[^}\n]*\}/g;
  let sm: RegExpExecArray | null;
  while ((sm = singleRe.exec(src))) blocks.push({ start: sm.index, text: src.slice(sm.index + 1, sm.index + sm[0].length) });
  const multiRe = /\n\s*\{\s*\n/g;
  let mm: RegExpExecArray | null;
  while ((mm = multiRe.exec(src))) {
    const start = mm.index + mm[0].lastIndexOf("{");
    let depth = 0;
    let end = -1;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) break;
    blocks.push({ start, text: src.slice(start, end + 1) });
    multiRe.lastIndex = end + 1;
  }
  blocks.sort((a, b) => a.start - b.start);
  const seen = new Set<string>();
  for (const block of blocks) {
    const di = block.text.match(/dataIndex\s*:\s*['"`]([^'"`]+)['"`]/);
    const field = di?.[1]?.trim();
    if (!field || seen.has(field)) continue;
    seen.add(field);
    // customRender 兼容两种形态：a) 箭头直接 `=> MAP[record.x]`；b) 块体 `=> { ... return MAP[record.x] ... }`
    const mapRef = block.text.match(
      /customRender\s*:\s*\([^)]*\)\s*=>\s*\{?[\s\S]*?(?:return\s+)?([A-Za-z_$][\w$]*)\s*\[\s*(?:record\.)?([A-Za-z_$][\w$]*)\s*\]/,
    );
    if (mapRef) {
      const name = mapRef[1];
      let mp = constMaps.get(name);
      if (!mp && imports.has(name)) mp = readImported(name, imports.get(name)!);
      if (mp && Object.keys(mp).length) {
        out[field] = mp;
        continue;
      }
    }
    const tri = block.text.match(/customRender\s*:\s*\([^)]*\)\s*=>\s*(?:return\s+)?record\.(\w+)\s*===\s*(['"]?\w+['"]?)\s*\?\s*['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/);
    if (tri) {
      out[field] = { [tri[2].replace(/['"]/g, "")]: tri[3], false: tri[4] };
      continue;
    }
    const oldRender = block.text.match(/render\s*:\s*\(t\)\s*=>\s*t\s*\?\s*['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/);
    if (oldRender) out[field] = { true: oldRender[1], false: oldRender[2] };
  }
  return out;
}

/** useFormSchema.ts 的字段 options 枚举（{ label, value } → { [value]: label }） */
function extractFormOptionsEnums(src: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  const fieldRe = /field\s*:\s*['"`]([A-Za-z_$][\w$]*)['"`]/g;
  let fm: RegExpExecArray | null;
  while ((fm = fieldRe.exec(src))) {
    const field = fm[1];
    if (out[field]) continue;
    const tail = src.slice(fm.index + fm[0].length);
    const optsIdx = tail.indexOf("options:");
    if (optsIdx < 0) continue;
    const nextField = tail.search(/\bfield\s*:/);
    const endBound = nextField > 0 ? nextField : tail.length;
    if (optsIdx > endBound) continue;
    const arrStart = tail.indexOf("[", optsIdx);
    if (arrStart >= 0 && arrStart <= endBound) {
      let depth = 0;
      let arrEnd = -1;
      for (let i = arrStart; i < Math.min(tail.length, endBound + 400); i++) {
        if (tail[i] === "[") depth++;
        else if (tail[i] === "]") {
          depth--;
          if (depth === 0) {
            arrEnd = i;
            break;
          }
        }
      }
      if (arrEnd < 0) continue;
      const vals: Record<string, string> = {};
      const itemRe = /\{\s*(?:label\s*:\s*['"]([^'"]*)['"]\s*,\s*value\s*:\s*([^,}\s]+)|value\s*:\s*([^,}\s]+)\s*,\s*label\s*:\s*['"]([^'"]*)['"])\s*\}/g;
      let im: RegExpExecArray | null;
      while ((im = itemRe.exec(tail.slice(arrStart + 1, arrEnd)))) {
        const label = im[1] || im[4];
        const value = im[2] || im[3];
        if (label && value !== undefined) vals[String(value).replace(/['"]/g, "")] = label;
      }
      if (Object.keys(vals).length) out[field] = vals;
      continue;
    }
    // options: getOptionsForObj(X) 或 options: X（常量对象引用）→ 在同文件找 const X = {...}
    const fnRef = tail.slice(optsIdx).match(/options\s*:\s*(?:getOptionsForObj\(\s*)?([A-Za-z_$][\w$]*)\s*\)?/);
    if (fnRef?.[1]) {
      const cname = fnRef[1];
      const cm = src.match(new RegExp(`(?:const|export const)\\s+${cname}\\s*=\\s*\\{([\\s\\S]*?)\\n?\\}`));
      if (cm?.[1]) {
        const vals: Record<string, string> = {};
        const itemRe = /['"]?([\w-]+)['"]?\s*:\s*['"]([^'"]*)['"]/g;
        let k: RegExpExecArray | null;
        while ((k = itemRe.exec(cm[1]))) vals[k[1]] = k[2];
        if (Object.keys(vals).length) out[field] = vals;
      }
    }
  }
  return out;
}

/** 源码驱动字段映射：configs.data.tsx 列 customRender + 同目录 useFormSchema.ts options 的枚举提取。
 *  替代 field-mapping.json 的 enumMap（2026-08-24 起字段/枚举映射不再配置维护）。 */
export function execGetFieldMapping(input: Record<string, unknown>): string {
  const moduleHint = String(input.module || input.query || "").trim();
  if (!moduleHint) return "错误：参数缺失；module 为必填（英文模块 id 或接口文件相对路径）";
  const root = codebaseRoot();
  const files = findConfigFiles(moduleHint);
  const enumMap: Record<string, Record<string, string>> = {};
  const sourceFiles: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const src = readFileSync(file, "utf8");
      Object.assign(enumMap, extractColumnEnumsFromSource(src, root));
      sourceFiles.push(file.replace(root + nodePath.sep, "").replace(/\\/g, "/"));
      const formFile = nodePath.join(nodePath.dirname(file), "useFormSchema.ts");
      if (existsSync(formFile)) {
        try {
          const opts = extractFormOptionsEnums(readFileSync(formFile, "utf8"));
          for (const [k, v] of Object.entries(opts)) if (!enumMap[k]) enumMap[k] = v;
          sourceFiles.push(formFile.replace(root + nodePath.sep, "").replace(/\\/g, "/"));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
  return JSON.stringify(
    {
      _tool: "get_field_mapping",
      module: moduleHint,
      found: Object.keys(enumMap).length > 0,
      sourceFiles,
      enumMap,
      hint: "枚举映射从当前项目源码提取（configs.data.tsx customRender / useFormSchema options），非配置表维护；提取不到的值可调 render_table 前由 pc-column-mapping 技能读源码翻译。",
    },
    null,
    2,
  );
}

/** 从 PC 仓库 zh-CN locale 解析 t('a.b.c') → 中文 */
function resolveI18nTitle(key: string): string {
  const root = codebaseRoot();
  const parts = key.split(".");
  if (parts.length < 2) return "";
  const fileKey = parts[0]; // tran10 / common / routes...
  const leaf = parts[parts.length - 1];
  const candidates = [
    nodePath.join(root, "src", "locales", "lang", "zh-CN", `${fileKey}.ts`),
    nodePath.join(root, "src", "locales", "lang", "zh-CN", `${fileKey}.json`),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, "utf-8");
      const re = new RegExp(`${leaf}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`);
      const m = text.match(re);
      if (m?.[1]) return m[1];
    } catch {
      /* ignore */
    }
  }
  return "";
}

/** 从列定义块提取中文 title。兼容 PC 端 configs.data.tsx 的常见写法：
 *  1) 反引号模板字符串：`${getTran('KEY','[中文]')}ID` → 提取 getTran 中文参数 + 拼接静态后缀
 *     （注意：模板内可含单双引号，不能用排除引号的正则整体截取，否则在首个单引号处截断成 "${getTran("）；
 *  2) 普通字符串：title: 'x' / "x"；
 *  3) getTran 函数调用：title: getTran('KEY','[中文]')；
 *  4) i18n：title: t('tran10.user.xxx') → resolveI18nTitle 查 zh-CN locale。
 *  均无法静态求值时返回空串，由调用方 dataIndex 兜底。 */
function extractTitleFromBlock(block: string): string {
  // 1) 反引号模板字符串（模板内可含单/双引号）
  const tmpl = block.match(/title\s*:\s*`([^`]*)`/);
  if (tmpl?.[1]) {
    const inner = tmpl[1];
    let out = "";
    let last = 0;
    // 允许参数尾部逗号（PC 多行调用风格：getTran('KEY','[中文]',)）
    const re = /\$\{getTran\(\s*['"`][^'"`]+['"`]\s*,\s*['"`]([^'"`]*)['"`]\s*,?\s*\)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(inner))) {
      out += inner.slice(last, m.index).replace(/\$\{[^}]*\}/g, "") + m[1].trim().replace(/^\[|\]$/g, "");
      last = m.index + m[0].length;
    }
    out += inner.slice(last).replace(/\$\{[^}]*\}/g, "");
    return out.trim() || "";
  }
  // 2) 普通字符串 title
  const lit = block.match(/title\s*:\s*['"]([^'"]*)['"]/);
  if (lit?.[1]) return lit[1].trim();
  // 3) getTran 函数调用（兼容多行 + 尾部逗号：getTran(\n 'K',\n '[中文]',\n)）
  const gtr = block.match(/getTran\(\s*['"`][^'"`]+['"`]\s*,\s*['"`]([^'"`]*)['"`]\s*,?\s*\)/);
  if (gtr?.[1]) return gtr[1].trim().replace(/^\[|\]$/g, "");
  // 4) i18n t('a.b.c')
  const i18n = block.match(/\bt\(\s*['"`]([^'"`]+)['"`]\s*\)/);
  if (i18n?.[1]) return resolveI18nTitle(i18n[1]) || i18n[1].split(".").pop() || "";
  return "";
}

/** api import 反向定位（2026-08-22）：api 模块 key 与 views 目录名不一致时（如
 *  <模块>/<接口模块> → views/<业务目录>/<页面目录>/），按目录名 walk 匹配不到 configs.data.tsx。
 *  兜底：递归扫 views 下页面文件（List.vue / configs.data.tsx / useFormSchema.ts），
 *  命中 import 该 api 模块（'/@/api/<模块>/<接口模块>' 或 '@/api/...' 或 api/xxx/<最后段>）的
 *  页面目录，取其 configs.data.tsx。Node 原生扫描（rg 在本机常不在 PATH）。 */
export function findViewsByApiImport(views: string, hint: string): string[] {
  const segments = hint.replace(/\\/g, "/").split("/").filter(Boolean);
  const fullPath = segments.join("/");
  const lastSeg = segments[segments.length - 1] || hint;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // 2026-08-26 修复（字段一致性问题根因）：精确全路径匹配优先，lastSeg 宽匹配仅兜底。
  // 背景：api 模块路径与 views 目录名常不一致（api user/account_group ↔ views userlayer/accountGroup），
  // 需靠「页面 import 该 api 模块」反查 configs.data.tsx。原实现把「api/任意目录/<最后段>」宽匹配
  // 与精确全路径并进一个正则，导致弹窗/下拉页（import 同一 api 模块取选项）也命中且 walk 顺序靠前，
  // get_list_columns 等工具返回错误页面的列（如 account_group 命中 coo/appModal 19 列而非主列表 10 列）。
  // 现改为：第一轮只收「精确全路径 import」（api/<模块全路径>），这是主列表页的特征；仅当精确匹配
  // 无结果时才用 lastSeg 宽匹配兜底（兼容 import 写法省略中间目录的页面）。
  const exactRe = new RegExp(`['"]\\/?@?\\/?api\\/${esc(fullPath)}['"]`, "i");
  const lastSegRe = new RegExp(`['"]\\/?@?\\/?api\\/[\\w/.-]*${esc(lastSeg)}['"]`, "i");

  const collect = (re: RegExp): string[] => {
    const dirMap = new Map<string, { cfg: string; hasList: boolean }>();
    // 2026-08-26 修复（两处）：
    //  1) 按目录去重收集：原实现以「命中文件数 >= 4」提前退出，同一目录下 List.vue/configs.data.tsx/
    //     useFormSchema.ts 各命中一次，appModal 等引用同一 api 模块的弹窗页 3 个文件即可占满配额，
    //     真正的主列表页（userlayer/accountGroup）还没被扫到就退出。
    //  2) 主列表页优先：引用同一 api 模块的页面有主列表页（List.vue + configs.data.tsx）与
    //     弹窗/下拉页（useFormSchema.ts / 仅 getGroupOption 等）。主列表页必有 List.vue 且用该
    //     configs 的 columns 渲染——返回时「含 List.vue 的目录」排前面，避免 get_list_columns 取到
    //     弹窗页的列（如 account_group 误取 appModal 19 列而非主列表 10 列）。这是通用信号
    //     （主列表页必有 List.vue），非业务词写死。
    const walk = (dir: string, depth: number) => {
      if (depth > 5 || dirMap.size >= 20) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const full = nodePath.join(dir, name);
        let stat;
        try {
          stat = statSync(full);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          walk(full, depth + 1);
          continue;
        }
        if (!/(List\.vue|configs\.data\.tsx?|useFormSchema\.ts)$/.test(name)) continue;
        try {
          const src = readFileSync(full, "utf8");
          if (re.test(src)) {
            const dirPath = nodePath.dirname(full);
            const existing = dirMap.get(dirPath);
            if (existing) {
              if (name.endsWith("List.vue")) existing.hasList = true;
              continue;
            }
            const dirCfg = nodePath.join(dirPath, "configs.data.tsx");
            const dirCfgTs = nodePath.join(dirPath, "configs.data.ts");
            let cfg = "";
            if (existsSync(dirCfg)) cfg = dirCfg;
            else if (existsSync(dirCfgTs)) cfg = dirCfgTs;
            if (cfg) dirMap.set(dirPath, { cfg, hasList: name.endsWith("List.vue") });
          }
        } catch {
          /* 不可读文件跳过 */
        }
      }
    };
    if (existsSync(views)) walk(views, 0);
    // 主列表页（有 List.vue）优先，其次弹窗/下拉页；各取 configs 路径
    const withList: string[] = [];
    const others: string[] = [];
    for (const { cfg, hasList } of dirMap.values()) {
      (hasList ? withList : others).push(cfg);
    }
    return [...withList, ...others].slice(0, 8);
  };

  const exact = collect(exactRe);
  if (exact.length) return exact;
  return collect(lastSegRe);
}

// findConfigFiles 结果缓存：避免每次 get_list_columns / get_page_schema / 报表渲染都全扫 views
// 目录树（views 数百文件，正则扫描有成本）。TTL 30s，git checkout/改代码后 30s 内生效新列。
// ⚠️ key 必须含 codebaseRoot：多项目（方案 A）切换时不同项目的 views 列定义不同，避免命中旧项目缓存。
const configFilesCache = new Map<string, { files: string[]; at: number }>();
const CONFIG_FILES_TTL = 30_000;

export function findConfigFiles(moduleHint: string): string[] {
  const root = codebaseRoot();
  const cacheKey = `${root}::${moduleHint}`;
  const cached = configFilesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CONFIG_FILES_TTL) return cached.files;
  const views = nodePath.join(root, "src", "views");
  const hint = moduleHint.trim().replace(/\\/g, "/");
  const files: string[] = [];

  // 2026-08-26 修复（字段一致性问题根因）：api import 精确反查结果前置。
  // 背景：api 模块路径与 views 目录名常不一致（api user/account_group ↔ views userlayer/accountGroup），
  // safeRg 全文搜 account_group 会把「弹窗/下拉页 import 同一 api 模块」的 configs.data.tsx
  // （如 coo/appModal，19 列）也命中且顺序靠前，导致 get_list_columns 等工具返回错误页面的列。
  // findViewsByApiImport 现为「精确全路径 import 优先、lastSeg 宽匹配兜底」，其结果代表真正的主列表页，
  // 前置插入保证主页面列优先返回。
  for (const f of findViewsByApiImport(views, hint)) {
    if (!files.includes(f)) files.push(f);
  }

  const directCandidates = [
    nodePath.join(views, hint, "configs.data.tsx"),
    nodePath.join(views, hint, "configs.data.ts"),
    nodePath.join(root, "src", "components2", `${hint}.configs.tsx`),
  ];
  for (const p of directCandidates) {
    if (existsSync(p)) files.push(p);
  }

  const rgOut = safeRg(hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), views, "**/configs.data.tsx");
  for (const line of rgOut.split("\n")) {
    const file = line.split(":")[0];
    if (file && existsSync(file) && !files.includes(file)) files.push(file);
  }

  const kebab = hint.replace(/_/g, "-").toLowerCase();
  const camel = hint.replace(/[-_]/g, "").toLowerCase();
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || files.length >= 8) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = nodePath.join(dir, name);
      const lower = name.toLowerCase();
      if (lower.includes(kebab) || lower.replace(/[-_]/g, "").includes(camel)) {
        for (const f of ["configs.data.tsx", "configs.data.ts"]) {
          const cfg = nodePath.join(full, f);
          if (existsSync(cfg) && !files.includes(cfg)) files.push(cfg);
        }
      }
      try {
        walk(full, depth + 1);
      } catch {
        /* ignore */
      }
    }
  };
  if (existsSync(views)) walk(views, 0);

  // api import 反向定位兜底（api 模块 key ≠ views 目录名的场景）
  if (files.length < 8) {
    for (const f of findViewsByApiImport(views, hint)) {
      if (!files.includes(f)) files.push(f);
    }
  }

  const result = files.slice(0, 8);
  configFilesCache.set(cacheKey, { files: result, at: Date.now() });
  return result;
}

/**
 * 从模块对应的 PC 页面表格配置提取「分页参数契约」（对齐 Cursor 工具 schema 层：模型调用 call_api 前
 * 应像读 schema 一样知道该接口真实的分页参数名，而非凭习惯猜）。
 *
 * 提取规则（全部来自源码事实，宁缺毋滥，找不到/无法确认 → 返回 null）：
 *  1. 定位该模块的页面文件（findConfigFiles 找 configs.data.tsx 的目录，同目录找 List.vue / Index.vue）；
 *  2. 读页面里 useStandardTable / useTable({...}) 调用的 fetchSetting：
 *     - 显式传了 pageField/sizeField → 用显式值（页面契约优先）；
 *     - 未显式传 → 用框架默认（useStandardTable 默认 pageField=page、sizeField=size，源码事实）；
 *  3. 页面未用标准表格 hook / 无法定位 → 返回 null（不注入，不臆造）。
 *
 * 返回 { pageField, sizeField, source: "explicit" | "default", file }；字段名均来自源码/框架，
 * 是通用契约语义（page/size/pageNum/pageSize/limit/offset），非业务词。
 */
export function extractPagingContract(
  moduleHint: string,
): { pageField: string; sizeField: string; source: "explicit" | "default"; file: string } | null {
  const root = codebaseRoot();
  const views = nodePath.join(root, "src", "views");
  const hint = moduleHint.trim().replace(/\\/g, "/");
  // 1) 优先按 api import 反查引用该模块的页面（findViewsByApiImport 精确匹配 '@/api/<模块>'，
  //    返回 configs.data.tsx 路径，取其目录找 List.vue/Index.vue）。API 模块路径与视图目录名
  //    常不一致（如 api user/account_group ↔ 视图 userlayer/accountGroup），反查比目录猜测可靠。
  let pageFiles: string[] = [];
  const viewCfgFiles = findViewsByApiImport(views, hint);
  for (const cfg of viewCfgFiles) {
    const dir = nodePath.dirname(cfg);
    for (const name of ["List.vue", "Index.vue"]) {
      const p = nodePath.join(dir, name);
      if (existsSync(p) && !pageFiles.includes(p)) pageFiles.push(p);
    }
  }
  // 2) 兜底：findConfigFiles 目录猜测 + 按视图目录名直查 <views>/<hint>/List.vue
  if (!pageFiles.length) {
    const cfgFiles = findConfigFiles(moduleHint);
    for (const cfg of cfgFiles) {
      const dir = nodePath.dirname(cfg);
      for (const name of ["List.vue", "Index.vue"]) {
        const p = nodePath.join(dir, name);
        if (existsSync(p) && !pageFiles.includes(p)) pageFiles.push(p);
      }
    }
  }
  if (!pageFiles.length && hint) {
    const direct = nodePath.join(views, hint, "List.vue");
    if (existsSync(direct)) pageFiles.push(direct);
  }
  if (!pageFiles.length) return null;

  // 收集所有候选页面的契约；若多页面契约值不一致 → 返回 null（宁缺毋滥，避免注入错误契约）。
  // 说明：同一模块常被多个页面引用（主列表页 + 弹窗下拉页等），各页面 useStandardTable 的
  // fetchSetting 可能不同（显式覆盖 vs 默认）。契约值不一致时无法确认该接口的真实分页参数名，
  // 宁可不注入（不误导模型），比注入可能错误的契约更符合「校验清楚」。
  const candidates: Array<{ pageField: string; sizeField: string; source: "explicit" | "default"; file: string }> = [];
  for (const file of pageFiles) {
    let src: string;
    try {
      src = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    // 页面是否用标准表格 hook（useStandardTable / useTable）
    if (!/(useStandardTable|useTable)\s*\(/.test(src)) continue;
    // 提取 fetchSetting 显式值：fetchSetting: { pageField: 'x', sizeField: 'y', ... }
    const fsRe = /fetchSetting\s*:\s*\{([^}]*)\}/;
    const m = src.match(fsRe);
    if (m) {
      const body = m[1];
      const pf = body.match(/pageField\s*:\s*['"]([^'"]+)['"]/);
      const sf = body.match(/sizeField\s*:\s*['"]([^'"]+)['"]/);
      if (pf?.[1] || sf?.[1]) {
        candidates.push({
          pageField: pf?.[1] || "page",
          sizeField: sf?.[1] || "size",
          source: "explicit",
          file,
        });
        continue;
      }
    }
    // 未显式传 fetchSetting → 框架默认 page+size（useStandardTable.ts 源码默认值，2026-08-26 核实）
    candidates.push({ pageField: "page", sizeField: "size", source: "default", file });
  }
  if (!candidates.length) return null;
  // 校验一致性：所有候选契约必须完全相同（pageField+sizeField 一致）才注入
  const first = candidates[0];
  const allConsistent = candidates.every(
    (c) => c.pageField === first.pageField && c.sizeField === first.sizeField,
  );
  if (!allConsistent) {
    console.log(
      `[extractPagingContract] ${moduleHint} 多页面分页契约不一致，放弃注入：` +
        candidates.map((c) => `${c.file.replace(/\\/g, "/")}(${c.pageField}+${c.sizeField})`).join(" | "),
    );
    return null;
  }
  return first;
}

export function execGetListColumns(input: Record<string, unknown>): string {
  const moduleHint = String(input.module || input.query || "").trim();
  const explicitPath = String(input.path || "").trim();
  if (!moduleHint && !explicitPath) {
    return "错误：参数缺失；module（或 path）为必填；请传入菜单/模块名（英文模块 id 或中文菜单名）";
  }

  const files = explicitPath
    ? [nodePath.isAbsolute(explicitPath) ? explicitPath : nodePath.join(codebaseRoot(), explicitPath)]
    : findConfigFiles(moduleHint);

  if (!files.length) {
    // 2026-08-25 去写死：不再按模块名正则返回手写列（登录数据统计等）。
    // 列定义一律实时读 PC configs.data.tsx（findConfigFiles + extractColumnsFromSource）；
    // 匹配不到时提示改用 path 显式指定，交模型（pc-column-mapping skill）继续定位。
    return `未找到与「${moduleHint}」相关的 configs.data.tsx；可改用 path 指定，如 src/views/account/whiteList/configs.data.tsx 或 src/views/dataReport/loginDataTotal/configs.data.tsx`;
  }

  const results: unknown[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const src = readFileSync(file, "utf-8");
    const columns = extractColumnsFromSource(src);
    results.push({
      file: file.replace(codebaseRoot() + nodePath.sep, "").replace(/\\/g, "/"),
      columnCount: columns.length,
      columns,
    });
  }

  return JSON.stringify(
    {
      _tool: "get_list_columns",
      module: moduleHint || null,
      results,
      _hint: "展示列表前用这些 title 作为表头；call_api 后可配合 render_table / normalize_output",
    },
    null,
    2,
  );
}

/** 从 PC 端详情/编辑表单 schema 提取字段清单（field/label/component/required）。
 *  来源：优先 Edit.vue 引用的 configs.data.tsx 的 `export const formSchema` 导出块；
 *  其次 edit/ 目录的 *.ts。新增/编辑的必填项与详情展示字段以此为准。 */
function extractFormFields(dir: string): Array<Record<string, unknown>> {
  // 候选文件：configs.data.tsx（formSchema 通常在 Edit.vue 的 import 里引用）+ edit/ 目录 + Edit.vue
  const candidates: string[] = [];
  const configs = nodePath.join(dir, "configs.data.tsx");
  if (existsSync(configs)) candidates.push(configs);
  const editDir = nodePath.join(dir, "edit");
  if (existsSync(editDir)) {
    for (const f of readdirSync(editDir)) {
      if (/\.(ts|tsx|vue)$/i.test(f)) candidates.push(nodePath.join(editDir, f));
    }
  }
  const editVue = nodePath.join(dir, "Edit.vue");
  if (existsSync(editVue)) candidates.push(editVue);

  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const file of candidates) {
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // 提取 `export const formSchema ... = [ ... ];` 块（详情/编辑表单字段，排除 searchFormSchema/columns）
    const blocks: string[] = [];
    const headerRe = /export\s+const\s+formSchema\s*(?::[^=]*)?=\s*\[/g;
    let hm: RegExpExecArray | null;
    while ((hm = headerRe.exec(src))) {
      const start = hm.index + hm[0].lastIndexOf("[");
      let depth = 0;
      for (let i = start; i < src.length; i++) {
        const ch = src[i];
        if (ch === "[") depth++;
        else if (ch === "]") {
          depth--;
          if (depth === 0) {
            blocks.push(src.slice(start, i + 1));
            break;
          }
        }
      }
    }
    if (!blocks.length) continue; // 无 formSchema 块则跳过该文件

    for (const block of blocks) {
      // 按顶层对象 `{ ... }` 切分 formSchema 元素：
      // 1) 避免把 EditListText 等组件的 componentProps.columns 子列（如 names 的 languageId/value）
      //    误当成独立顶层字段（它们嵌套在顶层对象内部，depth 不为 0）；
      // 2) label/component 只在字段自身对象内匹配，不会错配到相邻字段（如 terminalFlag 误用 coverImage 的 label）。
      const ranges: Array<[number, number]> = [];
      let depth = 0;
      let objStart = -1;
      for (let i = 0; i < block.length; i++) {
        const ch = block[i];
        if (ch === "{") {
          if (depth === 0) objStart = i;
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0 && objStart >= 0) {
            ranges.push([objStart, i]);
            objStart = -1;
          }
        }
      }
      for (const [objS, objE] of ranges) {
        const obj = block.slice(objS, objE + 1);
        const fm = obj.match(/field\s*:\s*['"`]([^'"`]+)['"`]/);
        if (!fm) continue;
        const field = fm[1];
        if (!field || seen.has(field)) continue;
        const fieldPos = obj.indexOf("field");

        let label = field;
        const gtr = obj.match(/label\s*:\s*getTran\(\s*['"`][^'"`]+['"`]\s*,\s*['"`]([^'"`]*)['"`]\s*\)/);
        if (gtr?.[1] && gtr[1].trim()) label = gtr[1].trim().replace(/^\[|\]$/g, "");
        else {
          const lit = obj.match(/label\s*:\s*['"`]([^'"`]+)['"`]/);
          if (lit?.[1] && !/^[A-Za-z][\w]*$/.test(lit[1])) label = lit[1].trim();
        }
        const component = obj.match(/component\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] || "Input";
        const required = /required\s*:\s*true/.test(obj) || /ruleRequired/.test(obj);
        const show = !/show\s*:\s*false/.test(obj.slice(fieldPos, Math.min(obj.length, fieldPos + 150)));
        if (!show) continue; // 隐藏字段（id 等）不作为展示/填写字段
        seen.add(field);
        out.push({ field, label, component, required });
        if (out.length >= 40) return out;
      }
    }
  }
  return out;
}

export function execGetPageSchema(input: Record<string, unknown>): string {
  const moduleHint = String(input.module || input.query || "").trim();
  if (!moduleHint) {
    return "错误：参数缺失；module 为必填；请传入英文模块 id 或中文菜单名";
  }
  const root = codebaseRoot();
  const views = nodePath.join(root, "src", "views");
  const hits = findConfigFiles(moduleHint).map((f) => nodePath.dirname(f));
  const rgOut = safeRg(moduleHint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), views, "**/*.{vue,tsx,ts}");
  for (const line of rgOut.split("\n")) {
    const file = line.split(":")[0];
    if (!file) continue;
    const dir = nodePath.dirname(file);
    if (!hits.includes(dir) && /[\\/](List|Edit|Analysis|BIPage)\.vue$/i.test(file)) {
      hits.push(dir);
    }
  }

  const pages: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const dir of hits.slice(0, 12)) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const rel = dir.replace(root + nodePath.sep, "").replace(/\\/g, "/");
    const has = (name: string) => existsSync(nodePath.join(dir, name));
    const types: string[] = [];
    if (has("List.vue")) types.push("list");
    if (has("Edit.vue")) types.push("edit");
    if (has("Analysis.vue")) types.push("analysis_chart");
    if (has("BIPage.vue")) types.push("bi_iframe");
    if (has("DeptModal.vue")) types.push("modal_form");
    if (has("BarChart.vue")) types.push("chart");
    const primary =
      types.includes("bi_iframe")
        ? "bi_iframe"
        : types.includes("analysis_chart")
          ? "analysis_chart"
          : types.includes("list")
            ? "list"
            : types.includes("edit")
              ? "edit"
              : types[0] || "unknown";

    pages.push({
      dir: rel,
      primaryType: primary,
      types,
      // 有 Edit.vue（详情/编辑表单页）即提供 formFields，作为详情展示与写操作字段来源
      ...(has("Edit.vue")
        ? { formFields: extractFormFields(dir) }
        : {}),
      outputHint:
        primary === "list"
          ? "用 Markdown 表；先 get_list_columns → call_api → normalize_output / render_table"
          : primary === "analysis_chart"
            ? "图表页：summarize_chart_data 出摘要+关键点表，勿假装画 ECharts"
            : primary === "bi_iframe"
              ? "BI：说明报告入口，不伪造数据"
              : primary === "edit"
                ? "详情/编辑：分块描述；多 Tab 按块输出。写操作（新增/编辑）缺参时按 formFields 澄清必填项"
                : "按 types 选择输出形态",
    });
  }

  if (!pages.length) {
    return `未识别「${moduleHint}」对应页面；请换更具体的目录名或中文菜单名`;
  }

  return JSON.stringify({ _tool: "get_page_schema", module: moduleHint, pages }, null, 2);
}

function toRows(data: unknown): Record<string, unknown>[] {
  if (typeof data === "string") {
    // 容错：模型常把 normalize_output 的整段结果（「[已对齐 PC 端字段」前缀 + JSON 文本，可能转义）
    // 原样传给 render_table。剥前缀/剥引号后 JSON.parse，拿到数组/对象再递归。
    let s = data.trim();
    const m = s.match(/^\[已对齐 PC 端字段[^\n]*\n([\s\S]*)$/);
    if (m) s = m[1].trim();
    while (s.startsWith('"')) {
      try {
        const p = JSON.parse(s);
        if (typeof p === "string") s = p.trim();
        else return toRows(p);
      } catch {
        break;
      }
    }
    if (s.startsWith("[") || s.startsWith("{")) {
      try {
        return toRows(JSON.parse(s));
      } catch {
        return [];
      }
    }
    return [];
  }
  if (Array.isArray(data)) {
    return data.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
  }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.list)) return toRows(obj.list);
    if (Array.isArray(obj.rows)) return toRows(obj.rows);
    if (obj.data && typeof obj.data === "object") {
      const inner = obj.data as Record<string, unknown>;
      if (Array.isArray(inner.list)) return toRows(inner.list);
      if (Array.isArray(inner)) return toRows(inner);
    }
    return [obj];
  }
  return [];
}

function flattenTreeRows(
  rows: Record<string, unknown>[],
  depth = 0,
  out: Array<Record<string, unknown> & { _depth: number }> = [],
): Array<Record<string, unknown> & { _depth: number }> {
  for (const row of rows) {
    const children = Array.isArray(row.children) ? (row.children as Record<string, unknown>[]) : null;
    const rest = { ...row };
    delete rest.children;
    out.push({ ...rest, _depth: depth });
    if (children?.length) flattenTreeRows(children, depth + 1, out);
  }
  return out;
}

function buildFooterRow(
  rows: Record<string, unknown>[],
  columns: Array<{ title: string; key: string }>,
  footerSpec: unknown,
): Record<string, string> | null {
  if (!footerSpec) return null;
  if (
    typeof footerSpec === "object" &&
    !Array.isArray(footerSpec) &&
    !(footerSpec as { sum?: unknown }).sum &&
    !(footerSpec as { avg?: unknown }).avg
  ) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(footerSpec as Record<string, unknown>)) {
      out[k] = String(v ?? "");
    }
    return out;
  }
  const spec = footerSpec as { sum?: string[]; avg?: string[]; count?: boolean; label?: string };
  const label = String(spec.label || "合计");
  const out: Record<string, string> = {};
  const firstKey = columns[0]?.key;
  if (firstKey) out[firstKey] = label;
  for (const key of spec.sum || []) {
    let s = 0;
    for (const r of rows) {
      const n = Number(r[key]);
      if (!Number.isNaN(n)) s += n;
    }
    out[key] = String(Number.isInteger(s) ? s : Number(s.toFixed(2)));
  }
  for (const key of spec.avg || []) {
    let s = 0;
    let c = 0;
    for (const r of rows) {
      const n = Number(r[key]);
      if (!Number.isNaN(n)) {
        s += n;
        c += 1;
      }
    }
    out[key] = c ? (s / c).toFixed(2) : "";
  }
  if (spec.count && columns[1]?.key) out[columns[1].key] = `共${rows.length}条`;
  return out;
}

export function execRenderTable(input: Record<string, unknown>): string {
  const maxRows = Math.min(Number(input.maxRows || 50), 200);
  const title = String(input.title || "数据表").trim() || "数据表";
  let columns = Array.isArray(input.columns)
    ? (input.columns as Array<Record<string, unknown>>)
        .map((c) => ({
          title: String(c.title || c.label || c.key || c.dataIndex || ""),
          key: String(c.key || c.dataIndex || c.title || ""),
        }))
        .filter((c) => c.title && c.key)
    : [];

  let rows = toRows(input.data ?? input.rows);
  if (!rows.length) {
    return "错误：无数据；请传入 data（数组或 {list:[...]}）";
  }

  const isTree = Boolean(input.tree) || rows.some((r) => Array.isArray(r.children));
  if (isTree) rows = flattenTreeRows(rows);

  // 受控渲染（对齐 Cursor「渲染由执行器完成，模型只传数据」）：
  // ① columns 只保留 key 在 rows 中真实存在的列——模型传的 columns.key 与 data 字段
  //    对不上（如 data 是 user_id，模型写 userId）会导致整列空（用户反馈的「全 --」）。
  // ② columns 为空时从 rows 推断列名，并用 field-mapping 中文化（columns 与 rows 同源必一致）。
  if (columns.length) {
    const rowKeys = Object.keys(rows[0] || {});
    columns = columns.filter((c) => rowKeys.includes(c.key));
  }
  if (!columns.length) {
    const keys = Object.keys(rows[0] || {}).filter((k) => !k.startsWith("_") && k !== "children");
    const moduleName = String(input.module || "").trim().toLowerCase();
    let fieldMap: Record<string, string> = {};
    try {
      const mappingRaw = resolveLocalDoc(fieldMappingPath());
      if ("note" in mappingRaw) {
        const mapping = JSON.parse((mappingRaw as { note: { text: string } }).note.text) as {
          modules?: Record<string, { fieldMap?: Record<string, string> }>;
        };
        fieldMap = mapping.modules?.[moduleName]?.fieldMap || {};
      }
    } catch {
      /* 无 field-mapping 时回退原始字段名 */
    }
    columns = keys.slice(0, 12).map((k) => ({ title: fieldMap[k] || k, key: k }));
  }

  // ③ title 权威化：模型常在 title 里写死「共 N 条记录」且与 rows 不一致（用户反馈的
  //    「标题共100条但只有10条」）→ 按实际 rows.length 覆盖条数，保留其余语境。
  const authoritativeTitle = title.replace(/共\s*[\d,]+\s*条(?:记录)?/g, `共 ${rows.length} 条`);

  const footer = buildFooterRow(rows, columns, input.footer);
  const slice = rows.slice(0, maxRows);

  const mdRows = slice.map((row) => {
    const depth = Number(row._depth || 0);
    return columns.map((c, i) => {
      let v = row[c.key];
      if (v === null || v === undefined) v = "";
      let s = String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
      if (i === 0 && depth > 0) s = `${"　".repeat(depth)}└ ${s}`;
      return s;
    });
  });

  const header = `| ${columns.map((c) => c.title).join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  let body = mdRows.map((cells) => `| ${cells.join(" | ")} |`).join("\n");
  if (footer) {
    const fcells = columns.map((c, i) => {
      const v = footer[c.key] ?? (i === 0 ? "合计" : "");
      return String(v).replace(/\|/g, "\\|");
    });
    body += `\n| ${fcells.join(" | ")} |`;
  }

  const note =
    rows.length > maxRows
      ? `\n\n（共 ${rows.length} 条，已展示前 ${maxRows} 条${isTree ? "；树已展平缩进" : ""}）`
      : `\n\n（共 ${rows.length} 条${isTree ? "；树已展平缩进" : ""}${footer ? "；含表尾汇总" : ""}）`;

  const tableView = {
    title: authoritativeTitle,
    total: rows.length,
    tree: isTree,
    columns: columns.map((c) => ({ key: c.key, title: c.title })),
    rows: slice.map((r) => {
      const row: Record<string, string | number | undefined> = { _depth: Number(r._depth || 0) };
      for (const c of columns) row[c.key] = r[c.key] == null ? "" : String(r[c.key]);
      return row;
    }),
    footer: footer || undefined,
  };

  return [
    "UI_TABLE",
    JSON.stringify(tableView),
    "",
    `【表格输出】${authoritativeTitle}`,
    header,
    sep,
    body,
    note,
  ].join("\n");
}

export function execSummarizeChartData(input: Record<string, unknown>): string {
  const label = String(input.metricLabel || input.label || "指标").trim();
  const metricField = String(input.metricField || input.yField || "").trim();
  const xField = String(input.xField || "").trim();
  const seriesFields = Array.isArray(input.seriesFields)
    ? (input.seriesFields as Array<Record<string, unknown>>)
        .map((s) => ({
          field: String(s.field || s.key || ""),
          label: String(s.label || s.title || s.field || ""),
        }))
        .filter((s) => s.field)
    : [];

  const raw = input.data ?? input.series;
  if (raw == null) return "错误：参数缺失；data 为必填";

  let points: Array<{ x: string; y: number; series?: string }> = [];

  const pickY = (o: Record<string, unknown>): number => {
    if (metricField && o[metricField] != null) {
      const n = Number(o[metricField]);
      if (!Number.isNaN(n)) return n;
    }
    // PC 报表常见字段（登录统计 / 观影统计等）
    for (const k of [
      "value",
      "y",
      "count",
      "total",
      "num",
      "successCount",
      "totalCount",
      "successRatio",
      "amount",
      "uv",
      "pv",
    ]) {
      if (o[k] != null) {
        const n = Number(o[k]);
        if (!Number.isNaN(n)) return n;
      }
    }
    return NaN;
  };

  const pickX = (o: Record<string, unknown>, idx: number): string => {
    if (xField && o[xField] != null) return String(o[xField]);
    for (const k of ["date", "x", "name", "label", "day", "cycle", "time", "statDate"]) {
      if (o[k] != null) return String(o[k]);
    }
    return String(idx + 1);
  };

  if (Array.isArray(raw) && raw.every((n) => typeof n === "number")) {
    points = (raw as number[]).map((y, i) => ({ x: String(i + 1), y }));
  } else if (Array.isArray(raw)) {
    // 多序列：按 seriesFields 展开（对齐 PC Analysis 多折线）
    if (seriesFields.length) {
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;
        if (String(o.cycle) === "汇总") continue;
        const x = pickX(o, points.length);
        for (const sf of seriesFields) {
          const y = Number(o[sf.field]);
          if (Number.isNaN(y)) continue;
          points.push({ x, y, series: sf.label || sf.field });
        }
      }
    } else {
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;
        if (String(o.cycle) === "汇总") continue;
        const y = pickY(o);
        if (Number.isNaN(y)) continue;
        points.push({ x: pickX(o, points.length), y, series: o.series ? String(o.series) : undefined });
      }
    }
  } else if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const categories = Array.isArray(o.categories) ? o.categories.map(String) : [];
    const series = Array.isArray(o.series) ? o.series : [];
    for (const s of series) {
      if (!s || typeof s !== "object") continue;
      const so = s as Record<string, unknown>;
      const name = String(so.name || "系列");
      const data = Array.isArray(so.data) ? so.data : [];
      data.forEach((v, i) => {
        const y = Number(v);
        if (Number.isNaN(y)) return;
        points.push({ x: categories[i] || String(i + 1), y, series: name });
      });
    }
    if (!points.length && Array.isArray(o.list)) {
      return execSummarizeChartData({ ...input, data: o.list });
    }
  }

  if (!points.length) {
    return "错误：无法解析为数值序列；请传 number[] 或含 cycle/successCount 等报表行，或 {date,value}[] / {categories,series}";
  }

  // 主趋势用默认序列（无 series 或第一个 series / metricLabel 匹配）
  const primarySeries = seriesFields[0]?.label;
  const primaryPoints = primarySeries
    ? points.filter((p) => p.series === primarySeries)
    : points.filter((p) => !p.series || p.series === label);
  const trendPoints = primaryPoints.length ? primaryPoints : points.filter((p, _i, arr) => {
    const firstSeries = arr.find((x) => x.series)?.series;
    return !firstSeries || p.series === firstSeries;
  });

  const ys = trendPoints.map((p) => p.y);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const sum = ys.reduce((a, b) => a + b, 0);
  const avg = sum / ys.length;
  const first = trendPoints[0];
  const last = trendPoints[trendPoints.length - 1];
  const delta = last.y - first.y;
  const trend = delta > 0 ? "上升" : delta < 0 ? "下降" : "持平";

  const top = [...trendPoints].sort((a, b) => b.y - a.y).slice(0, 8);
  const table = execRenderTable({
    columns: [
      { title: "坐标", key: "x" },
      { title: label, key: "y" },
      ...(points.some((t) => t.series) ? [{ title: "系列", key: "series" }] : []),
    ],
    data: top,
    maxRows: 8,
  });

  const seriesNote = seriesFields.length
    ? `- 序列：${seriesFields.map((s) => s.label).join("、")}（与 PC Analysis 图例一致）`
    : null;

  return [
    `【图表摘要 - ${label}】`,
    `- 点数：${trendPoints.length}`,
    `- 趋势：${trend}（首 ${first.y} → 末 ${last.y}，Δ ${delta}）`,
    `- 最小/最大/平均：${min} / ${max} / ${avg.toFixed(2)}`,
    seriesNote,
    `- 说明：PC 端为 ECharts 可视化；此处用文字+关键点表对齐，不假装画图。`,
    "",
    "关键点（按数值 Top）：",
    table.replace(/^UI_TABLE\n[^\n]+\n\n/, "").replace(/^【表格输出】\n?/, ""),
  ]
    .filter((line) => line != null)
    .join("\n");
}

export function execReadFieldMapping(input: Record<string, unknown>): string {
  const moduleName = String(input.module || "").trim().toLowerCase();
  if (!moduleName) return "错误：参数缺失；module 为必填（如 <模块> 等英文模块 key）";

  const mappingRaw = resolveLocalDoc(fieldMappingPath());
  if (!("note" in mappingRaw)) {
    return `错误：无法读取 field-mapping.json；${(mappingRaw as { error: string }).error}`;
  }
  let mapping: Record<string, unknown> = {};
  try {
    mapping = JSON.parse(mappingRaw.note.text);
  } catch {
    return "错误：field-mapping.json 不是合法 JSON";
  }
  const modules = (mapping.modules || {}) as Record<string, unknown>;
  let key = moduleName;
  if (!modules[key]) {
    const found = Object.keys(modules).find(
      (k) =>
        k.toLowerCase() === moduleName ||
        k.toLowerCase().includes(moduleName) ||
        moduleName.includes(k.toLowerCase()),
    );
    if (found) key = found;
  }
  if (!modules[key]) {
    return JSON.stringify(
      {
        _tool: "read_field_mapping",
        found: false,
        module: moduleName,
        availableModules: Object.keys(modules).slice(0, 40),
        hint: "该模块无渲染规则配置。字段/枚举中文映射已不在配置表维护：请按 pc-column-mapping 技能到当前项目源码找中文映射（configs.data.tsx 列 title / useFormSchema options / locale zh-CN），不要编造",
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      _tool: "read_field_mapping",
      found: true,
      module: key,
      config: modules[key],
      hint: "renderRules 为渲染行为定义（位掩码位值/图片/数组分隔等），非字段映射。字段/枚举中文映射请按 pc-column-mapping 技能到当前项目源码找",
    },
    null,
    2,
  );
}
