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

export function fsRead(conversationId: string, path: string): { content: string } | { error: string } {
  const target = safePath(conversationId, path);
  if (!target) return { error: "非法路径" };
  try {
    if (!existsSync(target) || !statSync(target).isFile()) return { error: `文件不存在：${path}` };
    const content = readFileSync(target, "utf-8");
    if (content.length > MAX_FILE_BYTES) {
      return { content: `${content.slice(0, MAX_FILE_BYTES)}\n…（文件过大，仅返回前 ${MAX_FILE_BYTES} 字符）` };
    }
    return { content };
  } catch (err) {
    return { error: String((err as Error)?.message || err) };
  }
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
