import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

/** 工具调用的轻量句柄：跨轮只保留「查过什么」，不保留结果正文（正文由本轮预算管理并可被清理）。 */
export interface ToolHandle {
  /** 工具名（MCP 命名空间名，数据驱动）。 */
  name: string;
  /** 调用参数原文（截断后）。 */
  args?: string;
  /** 结果规模摘要（行数/字符数），不含正文。 */
  summary?: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  /** 该轮执行过的工具句柄，跨轮注入上下文，便于追问时复用或重新取数。 */
  handles?: ToolHandle[];
}

/** 会话列表排序模式。 */
export type ConvSortMode = "recent" | "manual";

/** 设备级 UI 偏好（原前端 localStorage，现改为后端持久化）。 */
export interface SessionPreferences {
  theme?: "light" | "dark";
  /** 客户端默认语言；单个对话未显式设置 locale 时使用。 */
  locale?: string;
  /**
   * 会话列表排序模式：
   *  - `recent`（默认）：普通区按最近活动自动上浮；
   *  - `manual`：按用户手动顺序（`conversation.sortOrder`），新消息不再自动上浮。
   */
  convSortMode?: ConvSortMode;
  /**
   * 客户端完成过一次偏好同步的时间戳。
   * 前端据此判断「旧的 3 个 localStorage 键是否已迁移」，避免换设备/清缓存后重复迁移。
   */
  migratedAt?: number;
}

/**
 * 匿名本地会话：只承载**设备态**（活跃对话、UI 偏好）。
 * 对话内容与对话级设置（context / model / mcpServers / locale）见 conversation 文档。
 */
export interface Session {
  id: string;
  createdAt: number;
  /** @deprecated 上下文唯一真相已迁到 `conversation.context`（resolveConversation 一次性拷贝迁移，此后不再写入）。 */
  messages: ChatTurn[];
  /** @deprecated MCP 启用集已按对话持久化（`conversation.mcpServers`），仅在迁移路径读取。 */
  mcpServers: string[];
  /** 上次打开的对话 id（原前端 localStorage）。 */
  activeConversationId?: string;
  /** 设备级 UI 偏好（主题等）。 */
  preferences?: SessionPreferences;
}

/** 会话 cookie 名。 */
export const SESSION_COOKIE = "bx_agent_sid";

// 文件持久化会话存储：进程重启后按 cookie 恢复历史上下文。
const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = resolve(__dirname, "..", ".data", "sessions.json");

const sessions = new Map<string, Session>();

function loadFromDisk() {
  try {
    if (!existsSync(SESSION_FILE)) return;
    const raw = readFileSync(SESSION_FILE, "utf-8");
    const arr = JSON.parse(raw) as Session[];
    if (!Array.isArray(arr)) return;
    const now = Date.now();
    for (const s of arr) {
      if (now - s.createdAt > config.sessionTtlMs) continue;
      if (!Array.isArray(s.messages)) s.messages = [];
      if (!Array.isArray(s.mcpServers)) s.mcpServers = [];
      sessions.set(s.id, s);
    }
  } catch {
    // 损坏或不可读时忽略，视为无历史会话。
  }
}

let writeChain: Promise<void> = Promise.resolve();
function persist() {
  // 串行化写入，避免并发写导致文件损坏；写入临时文件再 rename 保证原子性。
  writeChain = writeChain.then(
    () =>
      new Promise<void>((resolvePromise) => {
        try {
          mkdirSync(dirname(SESSION_FILE), { recursive: true });
          const tmp = `${SESSION_FILE}.tmp`;
          writeFileSync(tmp, JSON.stringify([...sessions.values()]), "utf-8");
          renameSync(tmp, SESSION_FILE);
        } catch {
          // 持久化失败不影响内存中会话可用性。
        } finally {
          resolvePromise();
        }
      }),
  );
}

loadFromDisk();

// 只接受服务端签发的会话 id（UUID），避免伪造/异常 cookie 造成会话串用。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 取会话，不存在则新建（无需登录）。 */
export function ensureSession(id?: string | null): Session {
  const existing = id ? sessions.get(id) : undefined;
  if (existing && Date.now() - existing.createdAt <= config.sessionTtlMs) return existing;
  if (existing) sessions.delete(existing.id);
  const session: Session = {
    id: id && UUID_RE.test(id) ? id : randomUUID(),
    createdAt: Date.now(),
    messages: [],
    mcpServers: [],
  };
  sessions.set(session.id, session);
  persist();
  return session;
}

// 会话对象被就地修改（messages）后调用，将变更落盘。
export function touchSession(session: Session) {
  if (sessions.has(session.id)) persist();
}

