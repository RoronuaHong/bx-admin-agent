import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CountryConfig, SessionUser } from "@bx/shared";
import { config } from "./config.js";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

// 全局项目上下文：用户可随时切换"当前项目"，后续所有轮次默认使用该项目，无需重复声明。
export interface ActiveProject {
  key: string;        // 项目唯一标识，如 bx-film-admin
  label: string;      // 展示名，如 影视后台管理系统
  setAt: number;      // 设置时间戳
}

export interface Session {
  id: string;
  token: string;
  country: CountryConfig;
  user: SessionUser;
  menus: unknown[];
  createdAt: number;
  // 聊天历史（直连大模型时随请求上送）。
  messages: ChatTurn[];
  // 历史压缩缓存（对齐 Cursor /summarize）：LLM 摘要 + 已覆盖消息下标。
  // 只读投影压缩：session.messages 本体保持完整（UI/持久化不变），模型只见摘要 + 摘要点之后的新消息。
  historyCompact?: { summary: string; coveredIndex: number; at: number };
  // 最近一次服务端渲染的表格数据（call_api 列表/详情渲染分支写入）。
  // 供「导出」延续场景兜底：模型未走 function calling 时，服务端用此数据自动执行导出。
  lastTable?: { title: string; columns: Array<{ key: string; title: string }>; rows: Record<string, unknown>[]; total: number; at: number };
  pendingClarification?: PendingClarification;
  // 全局项目上下文：跨轮记忆，用户切换项目后所有请求都在该项目范围内执行。
  activeProject?: ActiveProject;
}

export interface PendingClarificationOption {
  label: string;
  value: string;
}

export interface PendingClarification {
  id: string;
  intent: string;
  question: string;
  options: PendingClarificationOption[];
  missingSlots: string[];
  riskLevel: "read" | "write";
  turns: number;
  createdAt: number;
  resumeTool: "call_api";
  resumeInput: Record<string, unknown>;
}

// 文件持久化会话存储：进程（含 tsx watch 重启）内存清空后，从磁盘恢复，
// 避免 bx_agent_sid cookie 因重启而查不到 session → 401。
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
      // 防御性补齐：升级前持久化的旧会话可能缺新字段，补齐默认值避免运行时报错。
      if (!Array.isArray(s.messages)) s.messages = [];
      // historyCompact 字段不完整视为无效，丢弃（下次超预算时重新生成）
      if (s.historyCompact && typeof s.historyCompact.summary !== "string") {
        delete s.historyCompact;
      }
      if (s.pendingClarification && !Array.isArray(s.pendingClarification.options)) {
        delete s.pendingClarification;
      }
      if (!s.activeProject?.key) {
        const def = config.defaultProject;
        s.activeProject = { key: def.key, label: def.label, setAt: Date.now() };
      }
      // 丢弃仅问 project 的陈旧待澄清
      if (
        s.pendingClarification?.missingSlots?.length === 1 &&
        s.pendingClarification.missingSlots[0] === "project"
      ) {
        delete s.pendingClarification;
      }
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

export function createSession(
  input: Omit<Session, "id" | "createdAt" | "messages">,
) {
  const id = randomUUID();
  const def = config.defaultProject;
  const session: Session = {
    ...input,
    id,
    createdAt: Date.now(),
    messages: [],
    // 登录即绑定默认项目（本部署面向影视后台），用户仍可用 set_project 切换
    activeProject: input.activeProject || {
      key: def.key,
      label: def.label,
      setAt: Date.now(),
    },
  };
  sessions.set(id, session);
  persist();
  return session;
}

export function getSession(id?: string | null) {
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

// 会话对象被就地修改（messages / lastResults）后调用，将变更落盘。
export function touchSession(session: Session) {
  if (sessions.has(session.id)) persist();
}

export function deleteSession(id?: string | null) {
  if (id && sessions.delete(id)) persist();
}

export function clearSessionContext(id?: string | null): boolean {
  if (!id) return false;
  const session = sessions.get(id);
  if (!session) return false;
  session.messages = [];
  delete session.pendingClarification;
  persist();
  return true;
}

// 设置会话的全局项目上下文（跨轮持久），用户切换项目时调用。
export function setActiveProject(id: string | null | undefined, project: ActiveProject): boolean {
  if (!id) return false;
  const session = sessions.get(id);
  if (!session) return false;
  session.activeProject = project;
  persist();
  return true;
}

// 读取当前会话的全局项目上下文。
export function getActiveProject(id: string | null | undefined): ActiveProject | null {
  if (!id) return null;
  return sessions.get(id)?.activeProject ?? null;
}

/** 若会话尚无 activeProject，补齐默认项目并落盘（兼容升级前旧会话）。 */
export function ensureDefaultProject(id: string | null | undefined): ActiveProject | null {
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (session.activeProject?.key) return session.activeProject;
  const def = config.defaultProject;
  session.activeProject = { key: def.key, label: def.label, setAt: Date.now() };
  persist();
  return session.activeProject;
}
