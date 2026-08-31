/**
 * 符号级索引（AST 解析）：对齐 Cursor 的 codebase retrieval 中"符号索引"层。
 *
 * 设计意图（双轨并存，不替代实时 grep）：
 *  - 实时 grep（grep_codebase / search_api_module）：文本出现在哪一行 —— 适合"模糊关键词扫全库"
 *  - 符号索引（buildSymbolIndex + searchSymbol）：函数签名/HTTP 方法/URL/中文动作/跨文件调用关系
 *    —— 适合"精确命中某个接口函数、看清它的签名与调用链"
 *  两者互补：模型先符号检索定位函数，再 grep/read_file 看实现细节。
 *
 * 解析目标：bx-film-admin-in2/src/api 下的 .ts 接口定义文件（标准 Vue3+TS）：
 *   export const <fnName> = (params?) => defHttp.<method>({ url: getUrl(Api.XXX), ... }, ...)
 *   并用 getLogOptions('<module>', '<中文动作>', ...) 提取模块名与中文动作。
 *
 * 依赖：typescript 编译器 API（已在 devDependencies，无需新增重依赖）。
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";
import ts from "typescript";

// 2026-08-25 去写死：符号索引生成源不再硬编码 D:/Code/bx-film-admin-in2/src/api，
// 改由 project-registry 按当前项目解析（与 grep/渲染/索引的 resolveCodebaseRoot 同一来源，
// 多项目按 activeProject 隔离）。env.CODEBASE_ROOT 与默认单项目目录仅作兜底。
import { listProjects } from "./project-registry.js";
function resolvePcApiRoot(): string {
  const explicit = process.env.CODEBASE_ROOT;
  if (explicit) return nodePath.join(explicit, "src", "api");
  const proj = listProjects().find((p) => p.codebaseRoot && fs.existsSync(nodePath.join(p.codebaseRoot, "src", "api")));
  if (proj) return nodePath.join(proj.codebaseRoot, "src", "api");
  return nodePath.join("D:", "Code", "bx-film-admin-in2", "src", "api");
}
const PC_API_ROOT = resolvePcApiRoot();
const INDEX_PATH = nodePath.join(process.cwd(), "data", "symbol-index.json");

export interface SymbolEntry {
  /** 导出函数名，如 getMovieSearchStatList */
  fn: string;
  /** 所属 api 文件（相对 src/api），如 search.ts */
  file: string;
  /** 模块 id（由文件名推导），如 search */
  module: string;
  /** HTTP 方法（get/post/put/delete），从 defHttp.<method> 提取 */
  method: string;
  /** 接口 URL，从 Api.XXX 枚举解析（需先解析同文件 enum Api） */
  url: string;
  /** 引用到的 Api 枚举键，如 getMovieSearchStat */
  apiKey: string;
  /** 中文动作（从 getLogOptions('模块','动作',...) 提取），如 "导出影片搜索" */
  action?: string;
  /** 日志模块名（getLogOptions 第一参），如 "search" */
  logModule?: string;
  /** 参数签名文本，如 "(params?: Recordable)" */
  params: string;
  /** 跨文件 import 的依赖（来自本文件顶部 import），用于调用关系 */
  imports: string[];
}

/** 解析单个 api 文件：提取 enum Api 映射 + 所有导出函数签名 */
function parseApiFile(absPath: string, relFile: string): SymbolEntry[] {
  const src = fs.readFileSync(absPath, "utf8");
  const sf = ts.createSourceFile(relFile, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  // 1) 收集顶部 import 依赖（跨文件调用关系的轻量表达）
  const imports: string[] = [];
  // 2) 收集 enum Api { KEY = 'url' } 映射
  const apiEnum: Record<string, string> = {};

  const visit = (node: ts.Node): void => {
    // import { x } from '...'  → 记录来源路径
    if (ts.isImportDeclaration(node)) {
      const mod = node.moduleSpecifier.getText(sf).replace(/['"]/g, "");
      imports.push(mod);
    }
    // enum Api { LIST = '/v0.1/...' }
    if (ts.isEnumDeclaration(node) && node.name.text === "Api") {
      for (const mem of node.members) {
        const key = mem.name.getText(sf);
        const init = mem.initializer;
        if (init && ts.isStringLiteralLike(init)) {
          apiEnum[key] = init.text;
        }
      }
    }
    // export const fnName = (params) => defHttp.xxx(...)
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const fn = decl.name.text;
        const init = decl.initializer;
        if (!init || !ts.isArrowFunction(init)) continue;

        // 参数签名
        const params = init.parameters
          .map((p) => p.getText(sf))
          .join(", ");

        // 找 defHttp.<method>({ url: getUrl(Api.XXX), ... }, ...)
        let method = "unknown";
        let apiKey = "";
        let logModule = "";
        let action = "";
        const scanCall = (n: ts.Node): void => {
          if (
            ts.isCallExpression(n) &&
            ts.isPropertyAccessExpression(n.expression) &&
            ts.isIdentifier(n.expression.expression) &&
            n.expression.expression.text === "defHttp"
          ) {
            method = n.expression.name.text.toLowerCase();
            const arg0 = n.arguments[0];
            if (arg0 && ts.isObjectLiteralExpression(arg0)) {
              for (const prop of arg0.properties) {
                if (
                  ts.isPropertyAssignment(prop) &&
                  ts.isIdentifier(prop.name) &&
                  prop.name.text === "url" &&
                  ts.isCallExpression(prop.initializer)
                ) {
                  const inner = prop.initializer;
                  // getUrl(Api.XXX)
                  if (inner.arguments[0] && ts.isPropertyAccessExpression(inner.arguments[0])) {
                    apiKey = inner.arguments[0].name.text;
                  }
                }
              }
            }
          }
          // getLogOptions('模块', '动作', ...)
          if (
            ts.isCallExpression(n) &&
            ts.isIdentifier(n.expression) &&
            n.expression.text === "getLogOptions"
          ) {
            const a0 = n.arguments[0];
            const a1 = n.arguments[1];
            if (a0 && ts.isStringLiteralLike(a0)) logModule = a0.text;
            if (a1 && ts.isStringLiteralLike(a1)) action = a1.text;
          }
          ts.forEachChild(n, scanCall);
        };
        ts.forEachChild(init, scanCall);

        const module = relFile.replace(/\.ts$/, "").replace(/^.*[\\/]/, "");
        const entry: SymbolEntry = {
          fn,
          file: relFile,
          module,
          method,
          url: apiKey ? apiEnum[apiKey] || "" : "",
          apiKey,
          params,
          imports: imports.filter((i) => i.startsWith("/@/") || i.startsWith(".")),
        };
        if (logModule) entry.logModule = logModule;
        if (action) entry.action = action;
        results.push(entry);
      }
    }
    ts.forEachChild(node, visit);
  };

  const results: SymbolEntry[] = [];
  ts.forEachChild(sf, visit);
  // 注意：enum 解析在 visit 内已完成，url 回填 ok
  return results;
}

let cachedIndex: SymbolEntry[] | null = null;
let cacheTime = 0;

/** 加载符号索引（带 60s 内存缓存，避免每次工具调用重读磁盘） */
export function loadSymbolIndex(): SymbolEntry[] {
  const now = Date.now();
  if (cachedIndex && now - cacheTime < 60_000) return cachedIndex;
  try {
    const raw = fs.readFileSync(INDEX_PATH, "utf8");
    cachedIndex = JSON.parse(raw) as SymbolEntry[];
  } catch {
    cachedIndex = [];
  }
  cacheTime = now;
  return cachedIndex!;
}

/** 构建符号索引（AST 解析全量 api 文件），写入 INDEX_PATH */
export function buildSymbolIndex(root = PC_API_ROOT): SymbolEntry[] {
  const entries: SymbolEntry[] = [];
  const walk = (dir: string): void => {
    let files: import("node:fs").Dirent[];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const f of files) {
      const abs = nodePath.join(dir, f.name);
      if (f.isDirectory()) {
        walk(abs);
      } else if (f.isFile() && f.name.endsWith(".ts") && f.name !== "tran.json") {
        const rel = nodePath.relative(PC_API_ROOT, abs).replace(/\\/g, "/");
        entries.push(...parseApiFile(abs, rel));
      }
    }
  };
  walk(root);
  fs.mkdirSync(nodePath.dirname(INDEX_PATH), { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(entries, null, 2), "utf8");
  cachedIndex = entries;
  cacheTime = Date.now();
  return entries;
}

/**
 * 符号级检索：按函数名/中文动作/URL 片段/模块 精确命中。
 * 与 grep 互补——grep 找"文本在哪行"，本函数找"这个函数签名与调用关系是什么"。
 * @returns 命中条目的可读摘要（含签名、URL、动作、文件行号提示）
 */
export function searchSymbol(query: string, limit = 8): string {
  const idx = loadSymbolIndex();
  if (!idx.length) {
    return "符号索引未构建（运行 npm run build-symbol-index 生成 data/symbol-index.json）。可改用 grep_codebase 做文本检索。";
  }
  const q = query.toLowerCase();
  const scored = idx
    .map((e) => {
      let score = 0;
      if (e.fn.toLowerCase().includes(q)) score += 5;
      if (e.action && e.action.toLowerCase().includes(q)) score += 4;
      if (e.url.toLowerCase().includes(q)) score += 3;
      if (e.module.toLowerCase().includes(q)) score += 3;
      if (e.logModule && e.logModule.toLowerCase().includes(q)) score += 2;
      if (e.apiKey.toLowerCase().includes(q)) score += 2;
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (!scored.length) {
    return `符号索引未命中「${query}」。可尝试函数名片段、中文动作、或 URL 片段；也可用 grep_codebase 做模糊文本检索。`;
  }
  return scored
    .map(({ e }) =>
      [
        `函数: ${e.fn}${e.params ? `(${e.params})` : "()"}`,
        `文件: src/api/${e.file}`,
        `模块: ${e.module}  方法: ${e.method.toUpperCase()}`,
        e.url ? `URL: ${e.url}` : "",
        e.action ? `动作: ${e.action}（log模块: ${e.logModule}）` : "",
        e.imports.length ? `依赖: ${e.imports.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n---\n\n");
}

// 自执行入口：当本文件被直接 `tsx src/symbol-index.ts` 运行时构建索引（避免独立脚本 import 触发 tsx glob 解析报错）。
// 作为模块被 chat.ts / tools.ts import 时不触发（process.argv[1] 不含本文件名）。
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("symbol-index.ts")) {
  const entries = buildSymbolIndex();
  const byModule: Record<string, number> = {};
  for (const e of entries) byModule[e.module] = (byModule[e.module] || 0) + 1;
  console.log(`[build-symbol-index] 已解析 ${entries.length} 个导出函数符号 → data/symbol-index.json`);
  console.log("[build-symbol-index] 按模块分布：", byModule);
}
