// 上次成功的 MCP 工具清单。Zoho 的 tools/list 有时要数分钟才返回，
// 本地超时取消后会话作废，预警会一直拿不到工具。清单本身很少变，超时就用这份缓存。
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR, atomicWriteJson } from "../store-util.js";

export interface CachedMcpTool {
  /** MCP server 上的原始工具名。 */
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

interface CacheEntry {
  savedAt: number;
  tools: CachedMcpTool[];
}

/** 缓存还能直接用、不必再阻塞等待 tools/list 的时长。 */
export const MCP_TOOL_CACHE_FRESH_MS = 24 * 60 * 60 * 1000;

const FILE = resolve(DATA_DIR, "mcp-tool-cache.json");

function readAll(file: string): Record<string, CacheEntry> {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

export function readMcpToolCache(serverId: string, file = FILE): CacheEntry | null {
  const entry = readAll(file)[serverId];
  if (!entry || !Array.isArray(entry.tools) || !entry.tools.length) return null;
  const tools = entry.tools.filter((tool) => tool && typeof tool.name === "string" && tool.name.trim());
  if (!tools.length || typeof entry.savedAt !== "number") return null;
  return { savedAt: entry.savedAt, tools };
}

export function writeMcpToolCache(serverId: string, tools: CachedMcpTool[], file = FILE, savedAt = Date.now()): void {
  const prev = readAll(file);
  prev[serverId] = {
    savedAt,
    tools: tools.filter((tool) => tool.name.trim()).map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    })),
  };
  atomicWriteJson(file, prev, { logLabel: "mcp-tool-cache" });
}

/**
 * 白名单里的工具必须都在缓存中，否则不能拿缓存冒充完整清单。
 * 未声明白名单时，缓存里有工具即可用。
 */
export function usableCachedTools(cached: CachedMcpTool[], allow?: string[]): CachedMcpTool[] | null {
  const names = new Set(cached.map((tool) => tool.name));
  const allowList = (allow || []).map((name) => name.trim()).filter(Boolean);
  if (!allowList.length) return cached.length ? cached : null;
  if (allowList.some((name) => !names.has(name))) return null;
  const allowSet = new Set(allowList);
  const picked = cached.filter((tool) => allowSet.has(tool.name));
  return picked.length ? picked : null;
}

/** 缓存还新鲜时直接用，不再发会把会话取消掉的 tools/list。 */
export function catalogPlan(input: {
  now: number;
  savedAt?: number;
  forceList?: boolean;
  hasUsableCache: boolean;
}): "use-cache" | "list" {
  if (input.forceList || !input.hasUsableCache || input.savedAt == null) return "list";
  if (input.now - input.savedAt >= MCP_TOOL_CACHE_FRESH_MS) return "list";
  return "use-cache";
}
