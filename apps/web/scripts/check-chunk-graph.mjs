#!/usr/bin/env node
// 首屏 chunk 图校验：从 dist/index.html 入口递归静态 import，校验分包边界。
// 纯 Node ESM + node:fs/path，无第三方依赖；路径全部以本脚本所在目录推导，Windows 安全。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDir, "..");
const distDir = join(webRoot, "dist");
const assetsDir = join(distDir, "assets");
const indexPath = join(distDir, "index.html");

const results = [];
function assert(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function abort(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

if (!existsSync(indexPath)) abort(`缺少 ${indexPath}，请先执行 pnpm build`);
if (!existsSync(assetsDir)) abort(`缺少 ${assetsDir}，请先执行 pnpm build`);

const html = readFileSync(indexPath, "utf8");
const allFiles = readdirSync(assetsDir);
const jsFiles = allFiles.filter((f) => f.endsWith(".js"));
const cssFiles = allFiles.filter((f) => f.endsWith(".css"));
const cache = new Map();
function readJs(name) {
  if (!cache.has(name)) cache.set(name, readFileSync(join(assetsDir, name), "utf8"));
  return cache.get(name);
}

// 入口：index.html 中 type=module 的 <script src="/assets/xxx.js">
const scriptTags = [...html.matchAll(/<script\b[^>]*\bsrc="(\/assets\/[^"]+\.js)"[^>]*>/g)];
const entryMatch = scriptTags.find((m) => /\btype="module"/.test(m[0]));
if (!entryMatch) abort("index.html 中找不到 type=module 的 /assets/*.js 入口");
const entry = basename(entryMatch[1]);

// 静态 import：from "./x.js" / import "./x.js"；刻意不匹配 import("./x.js") 动态加载。
const STATIC_RE = /(?:from\s*|import\s*)(["'])(\.\/[^"']+\.js)\1/g;
function staticImports(name) {
  const out = new Set();
  for (const m of readJs(name).matchAll(STATIC_RE)) {
    const target = basename(m[2]);
    if (jsFiles.includes(target)) out.add(target);
  }
  return [...out].sort();
}

// 首屏静态链（DFS）
const chain = [];
const seen = new Set();
function walk(name) {
  if (seen.has(name)) return;
  seen.add(name);
  chain.push(name);
  for (const dep of staticImports(name)) walk(dep);
}
walk(entry);

console.log("首屏静态链：");
chain.forEach((n, i) => console.log(`  ${i + 1}. ${n}`));
console.log("");

// 断言 1：首屏链中无 pinyin-pro 指纹 NumberDICT
const tainted = chain.filter((n) => readJs(n).includes("NumberDICT"));
assert(
  "首屏静态链不含 pinyin-pro 指纹 NumberDICT",
  tainted.length === 0,
  tainted.length ? `命中: ${tainted.join(", ")}` : `已扫描 ${chain.length} 个 chunk`,
);

// 断言 1b：首屏静态链中不得出现 ChatPage-*.js
const chatInChain = chain.filter((n) => /^ChatPage-.*\.js$/.test(n));
assert(
  "首屏静态链不含 ChatPage-*.js",
  chatInChain.length === 0,
  chatInChain.length ? `命中: ${chatInChain.join(", ")}` : `已扫描 ${chain.length} 个 chunk`,
);

// 断言 2：vendor-pinyin-pro 恰一份，且有其它 chunk 动态 import 它
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pinyinChunks = jsFiles.filter((f) => /^vendor-pinyin-pro-.*\.js$/.test(f));
assert("dist/assets 恰有一个 vendor-pinyin-pro-*.js", pinyinChunks.length === 1, pinyinChunks.join(", ") || "未找到");
if (pinyinChunks.length === 1) {
  const pinyin = pinyinChunks[0];
  const dynRe = new RegExp(`import\\(\\s*["']\\.\\/${escapeRegExp(pinyin)}["']\\s*\\)`);
  const importers = jsFiles.filter((f) => f !== pinyin && dynRe.test(readJs(f)));
  assert(`存在其它 chunk 动态 import("./${pinyin}")`, importers.length > 0, importers.join(", ") || "未找到");
}

// 断言 3：vendor-vue 存在且静态 import 数必须为 0
const vueChunks = jsFiles.filter((f) => /^vendor-vue-.*\.js$/.test(f));
assert("dist/assets 恰有一个 vendor-vue-*.js", vueChunks.length === 1, vueChunks.join(", ") || "未找到");
if (vueChunks.length === 1) {
  const vue = vueChunks[0];
  const vueImports = staticImports(vue);
  assert(
    "vendor-vue 静态 import 数必须为 0",
    vueImports.length === 0,
    `静态 import: ${vueImports.join(", ") || "0"}`,
  );
}

// 断言 4：ChatPage 的 JS / CSS 各一份
const chatJs = jsFiles.filter((f) => /^ChatPage-.*\.js$/.test(f));
const chatCss = cssFiles.filter((f) => /^ChatPage-.*\.css$/.test(f));
assert("ChatPage-*.js 恰有一份", chatJs.length === 1, chatJs.join(", ") || "未找到");
assert("ChatPage-*.css 恰有一份", chatCss.length === 1, chatCss.join(", ") || "未找到");

const failed = results.filter((r) => !r.ok);
console.log("");
console.log(`结果：${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.error(`失败 ${failed.length} 项，退出码 1`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
