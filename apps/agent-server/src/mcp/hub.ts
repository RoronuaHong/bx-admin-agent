// MCP Hub（客户端侧）：连接外部 MCP 服务器、发现工具、执行工具调用。
// 1. 每个 server 一个长连接，全局复用；会话只决定「启用哪些」，不重复建连；
// 2. 工具以 mcp__<serverId>__<tool> 命名空间注入模型，避免多 server 重名冲突；
// 3. 连接失败不抛错对外，只记录 error，由状态接口暴露给前端。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getServer, loadServers, type McpServerConfig } from "./config.js";

export interface McpToolInfo {
  /** 注入模型的工具名（含命名空间） */
  name: string;
  serverId: string;
  /** MCP server 上的原始工具名 */
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ServerStatus {
  id: string;
  label: string;
  transport: string;
  enabled: boolean;
  connected: boolean;
  error?: string;
  tools: number;
  toolNames: string[];
}

interface Conn {
  cfg: McpServerConfig;
  client: Client;
  tools: McpToolInfo[];
  error?: string;
}

const conns = new Map<string, Conn>();
const DEFAULT_TIMEOUT_MS = 60_000;

function timeoutOf(cfg: McpServerConfig): number {
  return cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
}

function buildTransport(cfg: McpServerConfig) {
  if (cfg.transport === "stdio") {
    return new StdioClientTransport({
      command: cfg.command || "",
      args: cfg.args || [],
      env: { ...(process.env as Record<string, string>), ...(cfg.env || {}) } as Record<string, string>,
      cwd: cfg.cwd,
      stderr: "pipe",
    });
  }
  const url = new URL(cfg.url || "");
  const init = cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined;
  return new StreamableHTTPClientTransport(url, init);
}

/** 工具名编码：server 前缀 + 原工具名（非法字符折叠为下划线），冲突时加序号后缀。 */
function encodeToolName(serverId: string, tool: string, used: Set<string>): string {
  const base = `mcp__${serverId}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}_${n++}`.slice(0, 64);
  used.add(name);
  return name;
}

async function refreshTools(conn: Conn): Promise<void> {
  const used = new Set<string>();
  try {
    const res = await conn.client.listTools(undefined, { timeout: timeoutOf(conn.cfg) });
    conn.tools = (res.tools || []).map((t) => ({
      name: encodeToolName(conn.cfg.id, t.name, used),
      serverId: conn.cfg.id,
      tool: t.name,
      description: t.description || t.name,
      inputSchema: (t.inputSchema as Record<string, unknown>) || { type: "object", properties: {} },
    }));
  } catch {
    conn.tools = [];
  }
}

export async function connect(serverId: string): Promise<Conn | null> {
  const cfg = getServer(serverId);
  if (!cfg) return null;
  const existing = conns.get(cfg.id);
  if (existing && !existing.error) return existing;
  if (existing) await disconnect(cfg.id);

  const client = new Client({ name: "bx-agent", version: "1.0.0" }, { capabilities: {} });
  const conn: Conn = { cfg, client, tools: [] };
  conns.set(cfg.id, conn);
  try {
    await client.connect(buildTransport(cfg), { timeout: timeoutOf(cfg) });
    await refreshTools(conn);
    console.log(`[mcp:hub] connected ${cfg.id} (${cfg.transport}) tools=${conn.tools.length}`);
  } catch (err) {
    conn.error = String((err as Error)?.message || err);
    console.warn(`[mcp:hub] connect failed ${cfg.id}: ${conn.error}`);
  }
  return conn;
}

export async function disconnect(serverId: string): Promise<void> {
  const conn = conns.get(serverId);
  if (!conn) return;
  conns.delete(serverId);
  try {
    await conn.client.close();
  } catch {
    /* 关闭失败忽略：进程退出或子进程已终止 */
  }
}

export async function disconnectAll(): Promise<void> {
  for (const id of [...conns.keys()]) await disconnect(id);
}

function statusOf(cfg: McpServerConfig, conn: Conn | null): ServerStatus {
  return {
    id: cfg.id,
    label: cfg.label || cfg.id,
    transport: cfg.transport,
    enabled: cfg.enabled !== false,
    connected: Boolean(conn && !conn.error),
    ...(conn?.error ? { error: conn.error } : {}),
    tools: conn?.tools.length || 0,
    toolNames: (conn?.tools || []).map((t) => t.tool),
  };
}

/** 已配置服务器的连接状态：未连接的只上报配置，不主动建连（勾选才连）。 */
export function listStatuses(): ServerStatus[] {
  return loadServers().map((cfg) => statusOf(cfg, conns.get(cfg.id) || null));
}

/** 重连并重列工具（配置变更后刷新）。 */
export async function reload(serverId: string): Promise<ServerStatus | null> {
  const cfg = getServer(serverId);
  if (!cfg) return null;
  await disconnect(serverId);
  const conn = await connect(serverId);
  return statusOf(cfg, conn);
}

/** 收集一批 server 暴露的工具；未连接/连接失败的静默跳过。 */
export async function collectTools(serverIds: string[]): Promise<McpToolInfo[]> {
  const out: McpToolInfo[] = [];
  for (const id of serverIds) {
    const cfg = getServer(id);
    if (!cfg || cfg.enabled === false) continue;
    const conn = await connect(cfg.id);
    if (!conn || conn.error) continue;
    out.push(...conn.tools);
  }
  return out;
}

export function toolNeedsConfirm(namespacedName: string): boolean {
  const conn = [...conns.values()].find((c) => c.tools.some((t) => t.name === namespacedName));
  return Boolean(conn?.cfg.requireConfirm);
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

/** 执行 MCP 工具：按命名空间定位 server 与原始工具名，结果统一转纯文本回灌模型。 */
export async function callMcpTool(namespacedName: string, args: Record<string, unknown>): Promise<McpCallResult> {
  const conn = [...conns.values()].find((c) => c.tools.some((t) => t.name === namespacedName));
  const info = conn?.tools.find((t) => t.name === namespacedName);
  if (!conn || !info) return { text: `工具未找到或未连接：${namespacedName}`, isError: true };
  try {
    const res = await conn.client.callTool({ name: info.tool, arguments: args }, undefined, {
      timeout: timeoutOf(conn.cfg),
    });
    const content = (res.content || []) as Array<{ type?: string; text?: string }>;
    const text =
      content
        .map((c) => (c.type === "text" ? String(c.text ?? "") : JSON.stringify(c)))
        .filter(Boolean)
        .join("\n") || JSON.stringify(res);
    return { text, isError: Boolean(res.isError) };
  } catch (err) {
    return { text: `MCP 工具调用失败：${String((err as Error)?.message || err)}`, isError: true };
  }
}
