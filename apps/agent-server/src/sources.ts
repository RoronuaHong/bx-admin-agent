import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { config } from "./config.js";
import { transcribeImage } from "./vision.js";

// 内容源读取层：本地文档目录 / 内网链接抓取。
// 读取结果统一为「附注文本」，注入当次 user 消息，不写会话历史。

export interface ContentNote {
  label: string;
  text: string;
}

const MAX_LINK_BYTES = 2 * 1024 * 1024;
const TEXT_CT = /^text\/(plain|html|markdown|x-markdown)|application\/(json|csv|xml|yaml|javascript)/;

// ---- 本地文件读取（@file: 显式引用）----
// 聊天页需登录后方可使用，按产品要求放开路径限制：
//   - 绝对路径：直接读取（如 @file:D:\Code\xxx\src\a.ts）
//   - 相对路径：基于 AGENT_DOCS_DIR 白名单（未配置则提示用绝对路径）
// 防护保留：文件 ≤2MB、文本检测（含 null 字节视为二进制拒绝）、切片 contextMaxChars。

// 索引文件路径纠错（工具层安全纠错，不改变模型语义判断）：
// 模型有时会把 agent-server 数据索引的「项目根目录」拼错（如把 bx-admin-agent 写成
// bx-film-admin-in2，因为 grep_codebase 的工作目录是 PC 端源码）。已知索引文件名出现时，
// 若路径指向其他项目根目录，自动纠正到本 agent 项目的正确路径。
const KNOWN_INDEX_FILES = new Map<string, string>([
  ["api-operation-index.json", "apps/agent-server/data/api-operation-index.json"],
  // 2026-08-22 完全抛弃 aliases：module-api-catalog.json（路由模块级映射数据）已无运行时使用。
  // 2026-08-24：api-module-index.json 与 api-module-index-bx-film-admin.json 已删除
  // （模块定位完全交模型实时 grep 源码），不再纳入路径纠错白名单。
  // 2026-08-25：project-aliases.json（operationAliases/paramAliases）已删除，全交给大模型。
]);

function correctIndexPath(target: string): { corrected: string; note: string } | null {
  const lower = target.replace(/\\/g, "/").toLowerCase();
  for (const [fileName, rel] of KNOWN_INDEX_FILES) {
    if (!lower.endsWith(fileName.toLowerCase())) continue;
    // 路径指向了非本项目的根目录（如 bx-film-admin-in2 / bx-film-admin），纠正到本 agent 项目
    if (!lower.includes("bx-admin-agent")) {
      const agentRoot = resolve(process.cwd(), "..", ".."); // apps/agent-server -> 项目根
      const corrected = resolve(agentRoot, rel);
      return {
        corrected,
        note: `（已纠正索引路径：${target} → ${corrected}）`,
      };
    }
  }
  return null;
}

export function resolveLocalDoc(name: string): { note: ContentNote } | { error: string } {
  let target = name.trim();
  // 已知索引文件路径纠错（见 correctIndexPath 注释）
  const correction = correctIndexPath(target);
  if (correction) target = correction.corrected;
  if (!isAbsolute(target)) {
    const root = config.agentDocsDir;
    if (!root) return { error: "相对路径需配置 AGENT_DOCS_DIR，请改用绝对路径（@file:D:\\盘符\\路径\\文件）" };
    const absRoot = isAbsolute(root) ? root : resolve(process.cwd(), root);
    const resolved = resolve(absRoot, target);
    if (!resolved.startsWith(absRoot + sep) && resolved !== absRoot) {
      return { error: "不允许读取白名单目录外的文件" };
    }
    target = resolved;
  }
  try {
    const stat = statSync(target);
    if (stat.isDirectory()) {
      return listDirectory(target);
    }
    if (stat.size > 2 * 1024 * 1024) return { error: "文件超过 2MB，暂不支持" };
    const buffer = readFileSync(target);
    if (buffer.includes(0)) return { error: "二进制文件，暂不支持读取" };
    const text = buffer.toString("utf-8").slice(0, config.contextMaxChars);
    const correctionNote = correction ? `\n${correction.note}` : "";
    return { note: { label: `本地文件 ${target}`, text: text + correctionNote } };
  } catch {
    return { error: `读取失败：${target}（文件不存在或不可读）` };
  }
}

// 目录列举：列出一层内容（子目录带 /，文件带大小），注入给模型。
function listDirectory(target: string): { note: ContentNote } {
  const entries = readdirSync(target, { withFileTypes: true });
  const lines = entries.slice(0, 300).map((entry) => {
    if (entry.isDirectory()) return `[dir] ${entry.name}/`;
    let size = "";
    try {
      size = ` (${formatSize(statSync(resolve(target, entry.name)).size)})`;
    } catch {
      /* 忽略单个条目 stat 失败 */
    }
    return `[file] ${entry.name}${size}`;
  });
  const truncated = entries.length > 300 ? `\n...（共 ${entries.length} 项，仅列出前 300 项）` : "";
  return {
    note: {
      label: `本地目录 ${target}`,
      text: `目录内容（${entries.length} 项）：\n${lines.join("\n")}${truncated}`,
    },
  };
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

// ---- 内网链接抓取 ----
// 仅 http/https；文本类内容直接注入；图片链接走视觉转录（模型 ocr 模式相关）。

function looksLikeImageUrl(url: string): boolean {
  return /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(new URL(url).pathname);
}

export async function fetchLink(url: string): Promise<ContentNote | string> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "仅支持 http/https 链接";
  }
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(config.linkTimeoutMs),
    });
    if (!response.ok) return `抓取失败：http ${response.status}`;
    const contentType = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_LINK_BYTES) return "链接内容超过 2MB，已跳过";
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_LINK_BYTES) return "链接内容超过 2MB，已跳过";
    if (contentType.startsWith("image/")) {
      const base64 = buffer.toString("base64");
      try {
        const text = await transcribeImage(base64, contentType);
        return { label: `链接图片 ${url}`, text };
      } catch {
        return "图片转录失败，已跳过";
      }
    }
    if (!TEXT_CT.test(contentType) && !contentType.startsWith("text/")) {
      return `暂不支持该内容类型（${contentType || "未知"}），已跳过`;
    }
    const text = stripHtml(buffer.toString("utf-8")).slice(0, config.contextMaxChars);
    return { label: `链接内容 ${url}`, text };
  } catch (error) {
    return `抓取失败：${error instanceof Error ? error.message : "网络错误"}`;
  }
}

// HTML → 纯文本：去 script/style/注释块，去掉标签，压缩空白。
// 不做正文蒸馏（保持与企业内网文档/接口页场景的通用性）。
function stripHtml(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  // 压缩空白：多空格/多换行 → 单换行
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").replace(/^\s*\n/gm, "").trim();
  return text;
}

// 从对话文本中识别 Windows 绝对路径（如 D:\Code\xx\a.ts、D:\Code\xx 目录），去重后读取。
// 排除 http(s) URL 和 @file: 显式语法（避免重复匹配）。路径后紧跟无空格内容时可能误吞，
// 由读取阶段的失败信息兜底提示。
export function extractLocalPaths(text: string): string[] {
  const matches =
    text.match(/[A-Za-z]:[\\/][^\s"'<>()，。；、|?*:]+/g) || [];
  return [...new Set(matches)]
    .filter((p) => !/^https?:/i.test(p))
    .filter((p) => !/^@file:/i.test(p))
    .map((p) => p.replace(/[\\/]+$/, ""))
    .slice(0, 3);
}

// 从对话文本中识别链接（http/https），去重后抓取。
export function extractUrls(text: string): string[] {
  const urls = text.match(/https?:\/\/[^\s"'<>()，。；、]+/g) || [];
  return [...new Set(urls)].slice(0, 3);
}

export { looksLikeImageUrl };