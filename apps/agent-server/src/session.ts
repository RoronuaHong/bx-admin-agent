import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

/** 匿名本地会话：只用于承载历史上下文，无登录态。 */
export interface Session {
  id: string;
  createdAt: number;
  messages: ChatTurn[];
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

/** 取会话，不存在则新建（无需登录）。 */
export function ensureSession(id?: string | null): Session {
  const existing = id ? sessions.get(id) : undefined;
  if (existing && Date.now() - existing.createdAt <= config.sessionTtlMs) return existing;
  if (existing) sessions.delete(existing.id);
  const session: Session = { id: id && id.length > 8 ? id : randomUUID(), createdAt: Date.now(), messages: [] };
  sessions.set(session.id, session);
  persist();
  return session;
}

export function getSession(id?: string | null): Session | null {
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (Date.now() - session.createdAt > config.sessionTtlMs) {
    sessions.delete(id);
    persist();
    return null;
  }
  return session;
}

// 会话对象被就地修改（messages）后调用，将变更落盘。
export function touchSession(session: Session) {
  if (sessions.has(session.id)) persist();
}

export function clearSessionContext(id?: string | null): boolean {
  if (!id) return false;
  const session = sessions.get(id);
  if (!session) return false;
  session.messages = [];
  persist();
  return true;
}
