// 虚拟文件系统（Deep Agents 的 FilesystemMiddleware 定位：*required scaffolding*）。
// 作用：给大结果/中间产物一个「落盘 + 指针」的中间态，替代"要么塞上下文、要么清成占位符"。
// backend：磁盘 `.data/fs/<conversationId>/`（单机单用户起步；后续可换 GridFS/对象存储）。
// 安全：所有路径都限制在该对话命名空间内 —— 拒绝绝对路径、`..`、反斜杠；单文件与总量有上限。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FS_ROOT = resolve(__dirname, "..", ".data", "fs");

const MAX_FILE_BYTES = Number(process.env.FS_MAX_FILE_BYTES || 256 * 1024);
const MAX_FILES = Number(process.env.FS_MAX_FILES || 100);

function convDir(conversationId: string): string {
  const id = String(conversationId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(FS_ROOT, id || "anonymous");
}

/** 校验并解析对话内相对路径；越界/非法返回 null。 */
function safePath(conversationId: string, rawPath: string): string | null {
  const raw = String(rawPath || "").trim().replace(/^\/+/, "");
  if (!raw) return null;
  if (raw.includes("\\") || raw.includes("..") || /^[a-zA-Z]:/.test(raw)) return null;
  const root = convDir(conversationId);
  const target = resolve(root, raw);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return target;
}

/** 写文件（覆盖）。返回实际写入的相对路径。 */
export function fsWrite(conversationId: string, path: string, content: string): { path: string; bytes: number } | { error: string } {
  const target = safePath(conversationId, path);
  if (!target) return { error: "非法路径（只允许对话工作区内的相对路径）" };
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_FILE_BYTES) return { error: `内容过大（${bytes} 字节，上限 ${MAX_FILE_BYTES}）` };
  try {
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(dirname(target))) return { error: "无法创建工作区目录" };
    const count = countFiles(conversationId);
    if (!existsSync(target) && count >= MAX_FILES) return { error: `文件数已达上限（${MAX_FILES}）` };
    writeFileSync(target, content, "utf-8");
    return { path: normalizeRel(conversationId, target), bytes };
  } catch (err) {
    return { error: String((err as Error)?.message || err) };
  }
}

/**
 * 读文件；支持按**行**分页（对齐参考实现的 read_file offset/limit）：
 * offset 从 0 起，limit 为最多返回行数；不传即整读（向后兼容）。
 * 分页时回报总行数与实际区间，便于模型决定是否需要继续翻。
 */
export function fsRead(
  conversationId: string,
  path: string,
  opts: { offset?: number; limit?: number } = {},
): { content: string; totalLines?: number } | { error: string } {
  const target = safePath(conversationId, path);
  if (!target) return { error: "非法路径" };
  try {
    if (!existsSync(target) || !statSync(target).isFile()) return { error: `文件不存在：${path}` };
    let content = readFileSync(target, "utf-8");
    if (content.length > MAX_FILE_BYTES) {
      content = `${content.slice(0, MAX_FILE_BYTES)}\n…（文件过大，仅返回前 ${MAX_FILE_BYTES} 字符）`;
    }
    const hasPaging = opts.offset != null || opts.limit != null;
    if (!hasPaging) return { content };
    const lines = content.split("\n");
    const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
    const limit = Math.max(1, Math.floor(Number(opts.limit) || lines.length));
    const slice = lines.slice(offset, offset + limit);
    const shown = slice.length
      ? `\n\n…（共 ${lines.length} 行，本次返回第 ${offset + 1}–${offset + slice.length} 行；继续读请传 offset=${
          offset + slice.length
        }）`
      : `\n\n…（共 ${lines.length} 行，offset=${offset} 已超出范围）`;
    return { content: slice.join("\n") + shown, totalLines: lines.length };
  } catch (err) {
    return { error: String((err as Error)?.message || err) };
  }
}

/** 需要转义的正则元字符（逐字符处理，避免正则字面量嵌套）。 */
const REGEX_META = new Set([".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

/**
 * glob 模式 → 正则；非法（空 / 含 `..` / 绝对路径 / 盘符）返回 null。
 * 支持单星（不跨目录）、问号，以及双星递归（双星后带斜杠表示任意层级前缀）。
 */
function globToRegex(pattern: string): RegExp | null {
  const trimmed = String(pattern || "").trim();
  // 绝对路径 / 盘符在「去掉前导斜杠」之前判定：否则 /etc/x 会被规范化成相对模式而静默通过（反馈不清晰）。
  if (!trimmed || trimmed.includes("..") || trimmed.includes("\\") || /^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith("/")) {
    return null;
  }
  const raw = trimmed.replace(/^\/+/, "");
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (ch === "*") {
      if (raw[i + 1] === "*") {
        i += 1;
        if (raw[i + 1] === "/") {
          out += "(?:.*/)?"; // **/ 匹配任意层级前缀（含零层）
          i += 1;
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*"; // 单层：不跨目录
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += REGEX_META.has(ch) ? `\\${ch}` : ch;
    }
  }
  try {
    return new RegExp(`^${out}$`);
  } catch {
    return null;
  }
}

/** glob 匹配（限工作区内）。返回相对路径列表（已排序）与命中总数。 */
export function fsGlob(
  conversationId: string,
  pattern: string,
  limit = 200,
): { files: Array<{ path: string; bytes: number }>; total: number } | { error: string } {
  const re = globToRegex(pattern);
  if (!re) return { error: "非法匹配模式（只允许工作区内的相对路径模式，不支持 .. 与绝对路径）" };
  const matched = fsList(conversationId).filter((file) => re.test(file.path));
  return { files: matched.slice(0, Math.max(1, limit)), total: matched.length };
}

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

/** 单行回显上限：命中行可能极长，截断避免把上下文撑爆。 */
const GREP_LINE_CHARS = 200;

/**
 * 内容检索（限工作区内）。三种模式：
 * - files：只回命中文件名（默认 200 个封顶）
 * - content：回 `路径:行号:命中行`
 * - count：只回每个文件的命中数
 * 正则来自模型，长度与命中数都设上限（防误伤与失控）；二进制文件（含 \0）跳过。
 */
export function fsGrep(
  conversationId: string,
  pattern: string,
  opts: { mode?: "files" | "content" | "count"; glob?: string; maxMatches?: number } = {},
):
  | { files: string[]; hits: GrepHit[]; counts: Array<{ path: string; count: number }>; truncated: boolean }
  | { error: string } {
  const raw = String(pattern || "");
  if (!raw.trim()) return { error: "缺少检索模式" };
  if (raw.length > 200) return { error: "检索模式过长（上限 200 字符）" };
  let re: RegExp;
  try {
    re = new RegExp(raw);
  } catch {
    return { error: "检索模式不是合法正则" };
  }
  const mode = opts.mode === "files" || opts.mode === "count" ? opts.mode : "content";
  const maxMatches = Math.max(1, Math.min(2000, Math.floor(Number(opts.maxMatches) || 200)));
  let candidates = fsList(conversationId);
  if (opts.glob) {
    const gre = globToRegex(opts.glob);
    if (!gre) return { error: "非法 glob 过滤条件" };
    candidates = candidates.filter((file) => gre.test(file.path));
  }
  const files: string[] = [];
  const hits: GrepHit[] = [];
  const counts: Array<{ path: string; count: number }> = [];
  let truncated = false;
  for (const file of candidates) {
    const target = safePath(conversationId, file.path);
    if (!target) continue;
    let text: string;
    try {
      text = readFileSync(target, "utf-8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue; // 二进制跳过
    let count = 0;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (!re.test(line)) continue;
      count += 1;
      if (mode === "content") {
        if (hits.length >= maxMatches) {
          truncated = true;
          break;
        }
        hits.push({
          path: file.path,
          line: i + 1,
          text: line.length > GREP_LINE_CHARS ? `${line.slice(0, GREP_LINE_CHARS)}…` : line,
        });
      }
    }
    if (count > 0) {
      files.push(file.path);
      if (mode === "count") counts.push({ path: file.path, count });
    }
    if (truncated) break;
  }
  return { files, hits, counts, truncated };
}

/** 精确替换（对齐 Deep Agents 的 edit_file：old_string 必须唯一命中）。 */
export function fsEdit(
  conversationId: string,
  path: string,
  oldString: string,
  newString: string,
): { path: string } | { error: string } {
  const file = fsRead(conversationId, path);
  if ("error" in file) return file;
  const occurrences = file.content.split(oldString).length - 1;
  if (occurrences === 0) return { error: "old_string 未在文件中找到" };
  if (occurrences > 1) return { error: `old_string 命中 ${occurrences} 处，需要唯一` };
  const written = fsWrite(conversationId, path, file.content.replace(oldString, newString));
  if ("error" in written) return written;
  return { path: written.path };
}

export function fsList(conversationId: string): Array<{ path: string; bytes: number }> {
  const root = convDir(conversationId);
  if (!existsSync(root)) return [];
  const out: Array<{ path: string; bytes: number }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        out.push({ path: normalizeRel(conversationId, full), bytes: statSync(full).size });
      } catch {
        /* 忽略瞬时变化 */
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function countFiles(conversationId: string): number {
  return fsList(conversationId).length;
}

function normalizeRel(conversationId: string, absolute: string): string {
  const root = convDir(conversationId);
  return absolute.slice(root.length).replace(/^[/\\]/, "").replace(/\\/g, "/");
}

/** 删除对话级联删除其工作区（对话删除时调用）。 */
export function fsRemoveConversation(conversationId: string): void {
  try {
    rmSync(convDir(conversationId), { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

/** 把大工具结果卸载成文件并返回指针文本（D2 的 offloading：替代"清成占位符"后仍可取回）。 */
export function offloadToolResult(
  conversationId: string,
  toolCallId: string,
  toolName: string,
  content: string,
): { path: string; bytes: number } | { error: string } {
  const safeName = String(toolName || "tool").replace(/[^a-zA-Z0-9_-]/g, "_");
  const path = `results/${toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_")}_${safeName}.txt`;
  return fsWrite(conversationId, path, content);
}
