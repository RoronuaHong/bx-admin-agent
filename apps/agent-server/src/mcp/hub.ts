// MCP Hub（客户端侧）：连接外部 MCP 服务器、发现工具、执行工具调用。
// 1. 每个 server 一个长连接，全局复用（连接单飞 + 空闲回收）；会话只决定「启用哪些」，不重复建连；
// 2. 工具以 mcp__<serverId>__<tool> 命名空间注入模型，避免多 server 重名冲突；
// 3. 注解/配置只提供事实（readOnlyHint / destructiveHint / requireConfirm / toolRisks），
//    「是否需要确认」的判定统一在 src/risk.ts（本文件只暴露 describeMcpTool）；
// 4. 连接失败不抛错对外，只记录 error，由状态接口暴露给前端。
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
  /** MCP 工具注解（readOnlyHint / destructiveHint / idempotentHint / title）。 */
  annotations?: Record<string, unknown>;
}

export interface ServerStatus {
  id: string;
  label: string;
  transport: string;
  enabled: boolean;
  connected: boolean;
  /** 新建对话/任务默认勾选（配置 defaultEnabled，前端预选用）。 */
  defaultEnabled?: boolean;
  /** 连接过程进行中（尚未列完工具）。 */
  connecting?: boolean;
  error?: string;
  /** 连接正常但工具清单获取失败：与「服务器本来就没有工具」区分开。 */
  toolsError?: string;
  tools: number;
  toolNames: string[];
}

interface Conn {
  cfg: McpServerConfig;
  client: Client;
  tools: McpToolInfo[];
  /** 连接失败原因（连不上）。 */
  error?: string;
  /** 工具清单获取失败原因（连上了但 listTools 失败）：与「服务器本来就没有工具」区分开。 */
  toolsError?: string;
  /** 最近一次连接尝试的时间戳：失败后进入冷却窗口，见 RECONNECT_COOLDOWN_MS。 */
  attemptedAt: number;
  /** 连接过程进行中（工具清单还没列完）：此时不算「已连接」，也不能被上层当成空服务器。 */
  connecting: boolean;
  /** 最近一次被使用（列工具 / 调用工具）的时间戳：空闲回收依据。 */
  lastUsedAt: number;
  /** 在途调用计数：>0 时不允许被空闲回收断开。 */
  busy: number;
}

const conns = new Map<string, Conn>();
/**
 * 连接中的 promise（单飞）：并发的 `connect` 复用同一次连接过程。
 * 否则第二次调用会拿到 conns 里的半成品（工具清单还是空的）→ 上层误判「服务器未暴露工具」。
 */
const pendingConns = new Map<string, Promise<Conn | null>>();
const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * 连接失败后的重试冷却：多服务器场景下，一个挂掉的 server 不该让**每一轮对话**都等一次连接超时。
 * 冷却窗口内直接复用上次的失败状态（前端仍可手动「重连」即时绕过）。
 */
const RECONNECT_COOLDOWN_MS = Number(process.env.MCP_RECONNECT_COOLDOWN_MS || 30_000);
/**
 * 空闲连接回收：stdio server 是子进程，常驻长连接会一直占资源。
 * 超过 IDLE_TIMEOUT_MS 没被使用（列工具 / 调用工具）就断开，下次用到时自动重连；
 * 正在连接（connecting）或正在调用（busy>0）的连接不会被回收。配 0 关闭回收。
 */
const IDLE_TIMEOUT_MS = Number(process.env.MCP_IDLE_TIMEOUT_MS || 30 * 60_000);
const IDLE_SWEEP_MS = Number(process.env.MCP_IDLE_SWEEP_MS || 5 * 60_000);
/**
 * 实时读环境变量的旧口径（MCP_CONFIRM_STRICT）已废弃：保守语义（未声明 = 需确认）
 * 已成为 risk.ts 的默认行为，无需开关。
 */
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
    // 工具白名单：声明后只注入列出的原始工具名（未声明 = 全部），用于收窄多领域 server 的暴露面。
    const allow = conn.cfg.tools?.length ? new Set(conn.cfg.tools) : null;
    // 按工具名排序：工具清单是注入模型的 system 前缀的一部分，顺序稳定才谈得上 prompt 缓存命中。
    conn.tools = (res.tools || [])
      .filter((t) => !allow || allow.has(t.name))
      .map((t) => ({
        name: encodeToolName(conn.cfg.id, t.name, used),
        serverId: conn.cfg.id,
        tool: t.name,
        description: t.description || t.name,
        inputSchema: (t.inputSchema as Record<string, unknown>) || { type: "object", properties: {} },
        // 注解是 server 的自我声明（hints），用于确认门判定，不当作安全保证。
        ...(t.annotations ? { annotations: t.annotations as Record<string, unknown> } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    delete conn.toolsError;
  } catch (err) {
    // 连上了但列不出工具：记录原因（上层据此告诉模型「该域暂时不可用」），不做静默 0 工具。
    conn.tools = [];
    conn.toolsError = String((err as Error)?.message || err);
    console.warn(`[mcp:hub] listTools failed ${conn.cfg.id}: ${conn.toolsError}`);
  }
}

/** 真正建立连接（含列工具）。只在 connect 的单飞逻辑里调用。 */
async function openConnection(cfg: McpServerConfig): Promise<Conn | null> {
  const client = new Client({ name: "bx-agent", version: "1.0.0" }, { capabilities: {} });
  const conn: Conn = {
    cfg,
    client,
    tools: [],
    attemptedAt: Date.now(),
    connecting: true,
    lastUsedAt: Date.now(),
    busy: 0,
  };
  conns.set(cfg.id, conn);
  const transport = buildTransport(cfg);
  // stdio 子进程的 stderr 是 MCP server 唯一的日志通道（stdout 被协议帧占用）：不接出来就是日志黑洞，
  // 适配器侧的超时/报错在服务端日志里完全看不到。这里转发并加前缀、截断，避免刷屏。
  if (transport instanceof StdioClientTransport) {
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      const line = String(chunk).trim();
      if (line) console.log(`[mcp:${cfg.id}] ${line.slice(0, 2000)}`);
    });
  }
  try {
    await client.connect(transport, { timeout: timeoutOf(cfg) });
    await refreshTools(conn);
    console.log(
      conn.toolsError
        ? `[mcp:hub] connected ${cfg.id} (${cfg.transport}) 但工具清单获取失败：${conn.toolsError}`
        : `[mcp:hub] connected ${cfg.id} (${cfg.transport}) tools=${conn.tools.length}`,
    );
  } catch (err) {
    conn.error = String((err as Error)?.message || err);
    // 连接失败后必须关掉传输：stdio 传输会拉起子进程，不关就留下孤儿进程（多服务器下会越积越多）。
    await client.close().catch(() => undefined);
    console.warn(`[mcp:hub] connect failed ${cfg.id}: ${conn.error}`);
  } finally {
    conn.connecting = false;
  }
  return conn;
}

export async function connect(serverId: string): Promise<Conn | null> {
  const cfg = getServer(serverId);
  if (!cfg) return null;
  // 连接中：复用同一个 promise —— 直接返回 conns 里的半成品会让上层看到「0 个工具」并误判服务器为空。
  const inflight = pendingConns.get(cfg.id);
  if (inflight) return inflight;
  const existing = conns.get(cfg.id);
  if (existing && !existing.error) return existing;
  // 冷却窗口内直接复用上次的失败状态，避免「一个挂掉的服务器拖慢每一轮对话」。
  if (existing && Date.now() - existing.attemptedAt < RECONNECT_COOLDOWN_MS) return existing;
  if (existing) await disconnect(cfg.id);
  const task = openConnection(cfg).finally(() => pendingConns.delete(cfg.id));
  pendingConns.set(cfg.id, task);
  return task;
}

export async function disconnect(serverId: string): Promise<void> {
  pendingConns.delete(serverId);
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

/**
 * 空闲连接回收：超过 IDLE_TIMEOUT_MS 没被使用（列工具 / 调用工具）的连接直接断开，
 * 下次用到时自动重连（connect 是幂等的）。正在连接或正在调用的连接不动。
 * 返回被回收的 serverId 列表（测试与日志用）。
 */
async function reclaimIdleConnections(now = Date.now()): Promise<string[]> {
  if (IDLE_TIMEOUT_MS <= 0) return [];
  const idle: string[] = [];
  for (const [id, conn] of conns) {
    if (conn.connecting || conn.busy > 0) continue;
    if (now - conn.lastUsedAt < IDLE_TIMEOUT_MS) continue;
    idle.push(id);
  }
  for (const id of idle) await disconnect(id);
  if (idle.length) {
    console.log(`[mcp:hub] 空闲回收断开：${idle.join(", ")}（阈值 ${IDLE_TIMEOUT_MS}ms）`);
  }
  return idle;
}

/** 启动周期性空闲回收（定时器 unref，不阻止进程退出）；IDLE_TIMEOUT_MS 配 0 时不启动。 */
export function startIdleSweeper(): NodeJS.Timeout | null {
  if (IDLE_TIMEOUT_MS <= 0 || IDLE_SWEEP_MS <= 0) return null;
  const timer = setInterval(() => void reclaimIdleConnections().catch(() => undefined), IDLE_SWEEP_MS);
  timer.unref();
  return timer;
}

function statusOf(cfg: McpServerConfig, conn: Conn | null): ServerStatus {
  const connecting = Boolean(conn?.connecting);
  return {
    id: cfg.id,
    label: cfg.label || cfg.id,
    transport: cfg.transport,
    enabled: cfg.enabled !== false,
    // 连接过程未完（工具清单还没列完）不算「已连接」：否则前端显示「已连接 · 0 工具」，误导排查。
    connected: Boolean(conn && !conn.error && !connecting),
    ...(cfg.defaultEnabled ? { defaultEnabled: true } : {}),
    ...(connecting ? { connecting: true } : {}),
    ...(conn?.error ? { error: conn.error } : {}),
    ...(conn?.toolsError ? { toolsError: conn.toolsError } : {}),
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

/** 勾选但本次拿不到工具的服务器：带上原因，供上层告知模型「该能力域缺席」。 */
export interface UnavailableServer {
  id: string;
  label: string;
  reason: string;
}

export interface ToolCollection {
  /** 全量工具（按 serverId、工具名确定性排序）。 */
  tools: McpToolInfo[];
  /** 成功提供工具的服务器。 */
  ready: Array<{ id: string; label: string; tools: number }>;
  /** 未能提供工具的服务器（未配置 / 已禁用 / 连接失败 / 工具清单失败 / 服务器无工具）。 */
  unavailable: UnavailableServer[];
}

/**
 * 收集一批 server 暴露的工具，**并如实上报谁缺席、为什么缺席**（不静默跳过）。
 * 多个 server 并行连接：串行会让整个对话的等待时间随服务器数量线性增长。
 */
export async function collectToolsDetailed(serverIds: string[]): Promise<ToolCollection> {
  const ids = [...new Set(serverIds.map((id) => String(id || "").trim()).filter(Boolean))].sort();
  const resolved = await Promise.all(
    ids.map(async (id): Promise<{ id: string; label: string; reason: string; conn: Conn | null }> => {
      const cfg = getServer(id);
      if (!cfg) return { id, label: id, reason: "服务端未配置该服务器", conn: null };
      const label = cfg.label || cfg.id;
      if (cfg.enabled === false) return { id, label, reason: "已在服务端禁用", conn: null };
      const conn = await connect(cfg.id);
      if (!conn || conn.error) {
        return { id, label, reason: `连接失败：${conn?.error || "未知原因"}`, conn: null };
      }
      if (conn.toolsError) {
        return { id, label, reason: `工具清单获取失败：${conn.toolsError}`, conn: null };
      }
      if (!conn.tools.length) return { id, label, reason: "服务器未暴露任何工具", conn: null };
      return { id, label, reason: "", conn };
    }),
  );
  const tools: McpToolInfo[] = [];
  const ready: ToolCollection["ready"] = [];
  const unavailable: UnavailableServer[] = [];
  for (const item of resolved) {
    if (!item.conn) {
      unavailable.push({ id: item.id, label: item.label, reason: item.reason });
      continue;
    }
    item.conn.lastUsedAt = Date.now();
    tools.push(...item.conn.tools);
    ready.push({ id: item.id, label: item.label, tools: item.conn.tools.length });
  }
  return { tools, ready, unavailable };
}

/** 按命名空间工具名定位连接与工具元信息。 */
function findTool(namespacedName: string): { conn: Conn; info: McpToolInfo } | null {
  for (const conn of conns.values()) {
    const info = conn.tools.find((t) => t.name === namespacedName);
    if (info) return { conn, info };
  }
  return null;
}

/** 风险分级所需的服务器事实（不做判定；判定统一在 src/risk.ts）。 */
export interface McpToolFacts {
  serverId: string;
  requireConfirm?: boolean;
  /** 工具级风险覆盖（服务器配置 toolRisks，键为裸工具名或命名空间名）。 */
  toolRisks?: Record<string, "read" | "write" | "destructive">;
  /** 原生 SQL 工具白名单（服务端只读判定后可免确认）。 */
  readOnlySqlTools?: string[];
  /** MCP 工具注解（server 的自我声明）。 */
  annotations?: Record<string, unknown>;
}

/** 按命名空间工具名取回判定所需事实；查不到返回 null（调用方按「未知」保守处理）。 */
export function describeMcpTool(namespacedName: string): McpToolFacts | null {
  const found = findTool(namespacedName);
  if (!found) return null;
  return {
    serverId: found.conn.cfg.id,
    ...(found.conn.cfg.requireConfirm !== undefined ? { requireConfirm: found.conn.cfg.requireConfirm } : {}),
    ...(found.conn.cfg.toolRisks ? { toolRisks: found.conn.cfg.toolRisks } : {}),
    ...(found.conn.cfg.readOnlySqlTools ? { readOnlySqlTools: found.conn.cfg.readOnlySqlTools } : {}),
    ...(found.info.annotations ? { annotations: found.info.annotations } : {}),
  };
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

/**
 * 执行 MCP 工具：按命名空间定位 server 与原始工具名，结果统一转纯文本回灌模型。
 * `signal` 由调用方透传（客户端断开/用户停止）→ 取消能级联到在途的 MCP 调用，不在服务端空跑。
 */
export async function callMcpTool(
  namespacedName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<McpCallResult> {
  const found = findTool(namespacedName);
  if (!found) return { text: `工具未找到或未连接：${namespacedName}`, isError: true };
  const { conn, info } = found;
  conn.lastUsedAt = Date.now();
  conn.busy += 1; // 在途调用期间不让空闲回收断开
  try {
    const res = await conn.client.callTool({ name: info.tool, arguments: args }, undefined, {
      timeout: timeoutOf(conn.cfg),
      ...(signal ? { signal } : {}),
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
  } finally {
    conn.busy -= 1;
  }
}
