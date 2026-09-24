// MCP 服务器配置持久化（全局一份列表；会话只存「启用的 id 集合」）。
// 凭据（env / headers）只落本机 .data/mcp-servers.json，对外接口一律只返回键名。
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR, atomicWriteJson } from "../store-util.js";

export type McpTransport = "stdio" | "http";

export interface McpServerConfig {
  /** 稳定标识，同时作为工具命名空间前缀，仅允许 [A-Za-z0-9_-] */
  id: string;
  label: string;
  transport: McpTransport;
  enabled: boolean;
  // stdio
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  // http
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 该服务器的**全部**工具调用都需用户二次确认 */
  requireConfirm?: boolean;
  /** 工具级风险覆盖（键 = 裸工具名或命名空间名，`*` = 本服务器全部未单独声明的工具；优先级高于 requireConfirm 与注解，见 src/risk.ts）。 */
  toolRisks?: Record<string, "read" | "write" | "destructive">;
  /** 命名「原生 SQL 工具」：这些工具若被定为 destructive，可在服务端按只读 SQL 判定降级免确认（见 src/risk.ts）。 */
  readOnlySqlTools?: string[];
  /**
   * 工具白名单（server 上的**原始**工具名，非命名空间名）：声明后只把列出的工具注入模型，其余忽略。
   * 用于「一个 server 提供多个领域的工具、但某个角色只需要其中一部分」——收窄暴露面、减少无关 schema。
   * 未声明 = 全部注入（向后兼容）。
   */
  tools?: string[];
  /** 新建对话默认勾选该服务器（仅影响新建，已有对话的启用集不受影响）。 */
  defaultEnabled?: boolean;
}

/** 新建对话应默认启用的服务器 id 集（defaultEnabled 且未停用）。 */
export function defaultMcpServers(): string[] {
  return loadServers()
    .filter((s) => s.defaultEnabled === true && s.enabled !== false)
    .map((s) => s.id);
}

/** 对外输出的服务器信息：凭据只保留键名，绝不回传值。 */
export interface McpServerPublic extends Omit<McpServerConfig, "env" | "headers"> {
  envKeys: string[];
  headerKeys: string[];
}

const CONFIG_PATH = resolve(DATA_DIR, "mcp-servers.json");
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const TRANSPORTS: McpTransport[] = ["stdio", "http"];

/** 文件配置（唯一会被写回 .data/mcp-servers.json 的部分）。 */
let fileCache: McpServerConfig[] | null = null;
/**
 * 缓存对应的文件 mtime（毫秒）。
 *
 * 为什么必须记 mtime：配置可能被**本进程之外**改动（手工编辑文件、部署脚本写盘、另起脚本初始化），
 * 只靠内存缓存会让「文件已改、服务仍用旧值」——最痛的表现是换了 token 却一直 401，
 * 而且直连 API 与独立起 MCP 进程都能验证通过，唯独对话里失败，排查成本极高。
 * 这里与 rag/store.ts 同一口径：**按文件 mtime 失效**，而不是「只有自己写过才刷新」。
 */
let fileCacheMtime = 0;
/**
 * 缓存对应文件的 size（与 mtime 共同构成失效键）。
 *
 * 只看 mtime 不够：同一毫秒内连续改写（部署脚本 write+write、或极快的外部编辑）mtime 可能完全相同，
 * 缓存就会命中旧值——正是这套缓存要消灭的「文件已改、服务仍用旧值」。加上 size 后，
 * 长度变化的改写即使 mtime 撞车也能被感知（长度恰好相同的改写由 mtime 递增兜底，概率极低且无害）。
 */
let fileCacheSize = 0;
/** 内置服务器（由环境变量提供，不落盘）。 */
let builtinCache: McpServerConfig[] | null = null;

export function validateServerInput(input: Partial<McpServerConfig>): string | null {
  const id = String(input.id || "").trim();
  if (!id) return "缺少 id";
  if (!ID_RE.test(id)) return "id 仅允许字母、数字、下划线、短横线（1-32 字符）";
  if (input.transport === "stdio" && !String(input.command || "").trim()) return "stdio 传输必须提供 command";
  if (input.transport === "http" && !String(input.url || "").trim()) return "http 传输必须提供 url";
  if (input.transport && !TRANSPORTS.includes(input.transport)) return "transport 非法（stdio | http）";
  if (input.timeoutMs !== undefined && !(Number(input.timeoutMs) > 0)) return "timeoutMs 必须为正数";
  if (
    input.tools !== undefined &&
    (!Array.isArray(input.tools) || input.tools.some((t) => typeof t !== "string" || !t.trim()))
  ) {
    return "tools 必须是工具名（非空字符串）数组";
  }
  return null;
}

/** 文件配置：读取 .data/mcp-servers.json（可写，用户可增删改）。 */
function fileServers(): McpServerConfig[] {
  // 缓存命中还要再看 mtime：外部改过文件就重新读（见 fileCacheMtime 的注释）。
  // 文件被删（mtime=0）也要能感知：否则删除后仍按旧列表提供服务。
  let mtime = 0;
  let size = 0;
  try {
    const stat = statSync(CONFIG_PATH);
    mtime = stat.mtimeMs;
    size = stat.size;
  } catch {
    mtime = 0;
    size = 0;
  }
  // 失效键 = mtime + size（见 fileCacheSize 注释）：同毫秒改写的兜底。
  if (fileCache && mtime === fileCacheMtime && size === fileCacheSize) return fileCache;
  if (fileCache && mtime !== fileCacheMtime) {
    console.log("[mcp:config] 检测到配置文件变更（mtime 变化），已重新加载");
  }
  try {
    if (existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as unknown;
      if (Array.isArray(parsed)) {
        fileCache = parsed
          .filter((s): s is McpServerConfig => Boolean(s && typeof s === "object" && (s as McpServerConfig).id))
          .map((s) => ({ ...s, enabled: s.enabled !== false }));
        fileCacheMtime = mtime;
        fileCacheSize = size;
        return fileCache;
      }
    }
  } catch (err) {
    console.warn(`[mcp:config] 读取失败，按空配置处理：${String((err as Error)?.message || err)}`);
  }
  fileCache = [];
  fileCacheMtime = mtime;
  fileCacheSize = size;
  return fileCache;
}

/**
 * 内置服务器：由环境变量 MCP_BUILTIN_SERVERS（JSON 数组）提供，随环境变化、不落盘。
 * 用于「部署期就确定」的服务器——不必写进代码，也不必让用户手工添加；
 * 凭据无需写进本变量：stdio 子进程会继承父进程环境（放 .env 即可）。
 */
function builtinServers(): McpServerConfig[] {
  if (builtinCache) return builtinCache;
  builtinCache = [];
  const raw = (process.env.MCP_BUILTIN_SERVERS || "").trim();
  if (!raw) return builtinCache;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      builtinCache = parsed
        .filter((s): s is McpServerConfig => Boolean(s && typeof s === "object" && (s as McpServerConfig).id))
        .map((s) => ({ ...s, enabled: s.enabled !== false }));
    }
  } catch (err) {
    console.warn(`[mcp:config] MCP_BUILTIN_SERVERS 解析失败，已忽略：${String((err as Error)?.message || err)}`);
  }
  return builtinCache;
}

/** 全部服务器 = 内置 + 文件配置；同 id 时以文件为准，便于本地覆盖。 */
export function loadServers(): McpServerConfig[] {
  const byId = new Map(builtinServers().map((s) => [s.id, s]));
  for (const s of fileServers()) byId.set(s.id, s);
  return [...byId.values()];
}

function persist(list: McpServerConfig[]): void {
  fileCache = list;
  atomicWriteJson(CONFIG_PATH, list, { logLabel: "mcp:config" });
  // 写回后同步 mtime：否则下一次读取会把「自己刚写的文件」当成外部变更，白刷一次并打日志。
  try {
    const stat = statSync(CONFIG_PATH);
    fileCacheMtime = stat.mtimeMs;
    fileCacheSize = stat.size;
  } catch {
    fileCacheMtime = 0;
    fileCacheSize = 0;
  }
}

export function getServer(id: string): McpServerConfig | null {
  return loadServers().find((s) => s.id === id) ?? null;
}

export function upsertServer(input: Partial<McpServerConfig>): McpServerConfig {
  const list = fileServers().slice();
  const idx = list.findIndex((s) => s.id === input.id);
  const prev = idx >= 0 ? list[idx] : undefined;
  // 凭据只写不回显：未提供的 env/headers 视为「保持原值」，避免保存表单时清空已有凭据。
  const merged: McpServerConfig = {
    ...(prev || {}),
    ...input,
    id: String(input.id || "").trim(),
    label: input.label || prev?.label || String(input.id || "").trim(),
    transport: input.transport || prev?.transport || "stdio",
    enabled: input.enabled === undefined ? (prev ? prev.enabled !== false : true) : input.enabled !== false,
    ...(input.env === undefined && prev?.env ? { env: prev.env } : {}),
    ...(input.headers === undefined && prev?.headers ? { headers: prev.headers } : {}),
  };
  if (idx >= 0) list[idx] = merged;
  else list.push(merged);
  persist(list);
  return merged;
}

export function deleteServer(id: string): boolean {
  const list = fileServers().slice();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return false;
  persist(next);
  return true;
}

export function toPublic(cfg: McpServerConfig): McpServerPublic {
  const { env, headers, ...rest } = cfg;
  return {
    ...rest,
    envKeys: Object.keys(env || {}),
    headerKeys: Object.keys(headers || {}),
  };
}
