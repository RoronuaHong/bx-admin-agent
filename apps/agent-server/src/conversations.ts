// 聊天会话持久化，存 MongoDB（连不上则降级进程内存）。
//
// 设计要点：
//  - MongoClient 单例懒连接；失败降级进程内存 Map。
//  - 单一集合 chat_conversations（本机单用户，无归属隔离）。

import { MongoClient, type Collection, type Db, type ObjectId } from "mongodb";
import type { TodoItem } from "@bx/shared";
import { touchSession, type ChatTurn, type Session } from "./session.js";

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const MONGO_DB = process.env.MONGO_DB_NAME || "bx_agent";
const COLL = "chat_conversations";

export interface StoredMessage {
  id?: string | number;
  role: "user" | "assistant";
  text: string;
  images?: Array<{ id: string; name: string }>;
  /** 该助手消息用到的工具步骤摘要（便于历史还原"它做了什么"）。 */
  steps?: Array<{ name: string; status: string }>;
}

/** 忙碌期间排队的待发消息（按对话持久化，先进先出）。 */
export interface PendingMessage {
  text: string;
  images?: string[];
  at: number;
}

interface ConversationDoc {
  _id?: ObjectId;
  id: string;
  title: string;
  /** UI 展示快照（含工具步骤摘要、图片）；与模型上下文 `context` 互不自动同步。 */
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;

  // ---- 对话级设置（所有配置按对话独立，全部后端持久化）----
  /** 该对话使用的模型 id；空 = 服务端默认模型。 */
  model?: string;
  /** 该对话启用的 MCP server id。 */
  mcpServers?: string[];
  /** 该对话的界面语言，同时决定回复语言；空 = 客户端默认。 */
  locale?: string;
  /** 忙碌期间排队的待发消息。 */
  pendingQueue?: PendingMessage[];
  /** 任务规划（write_todos 全量替换），跨轮持久化、前端可见。 */
  todos?: TodoItem[];
  /** 置顶时间戳；null / 缺省 = 未置顶。置顶区固定在列表最上（新的置顶在上）。 */
  pinnedAt?: number | null;
  /** 手动顺序（「手动排序」模式下生效）；按下标 × `ORDER_STEP` 分配，便于中间插入。 */
  sortOrder?: number;

  // ---- 模型上下文（thread）----
  /** 发往模型的对话历史（含工具轻量句柄），是上下文的唯一真相。 */
  context?: ChatTurn[];
  /** 原子序列计数器：并发追加时判定顺序。 */
  contextSeq?: number;
  /** 历史摘要（上下文超限后由服务端生成，供后续轮次复用）。 */
  summary?: string;
  summaryAt?: number;
  /** 摘要水位线：已覆盖到 context 的第几条。 */
  summaryCovered?: number;
}

// ---- Mongo 单例 ----
let clientPromise: Promise<MongoClient> | null = null;
let lastConnectFail = 0;
const CONNECT_RETRY_COOLDOWN = 30_000;

function getClient(): Promise<MongoClient> {
  if (clientPromise) return clientPromise;
  if (Date.now() - lastConnectFail < CONNECT_RETRY_COOLDOWN) {
    return Promise.reject(new Error("MongoDB 连接冷却中（上次失败 30s 内）"));
  }
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
  clientPromise = client
    .connect()
    .then((c) => {
      console.log(`[conversations] MongoDB 已连接 ${MONGO_URI}/${MONGO_DB}`);
      return c;
    })
    .catch((err) => {
      clientPromise = null;
      lastConnectFail = Date.now();
      console.warn(`[conversations] MongoDB 连接失败，降级内存存储：${String(err?.message || err)}`);
      throw err;
    });
  return clientPromise;
}

async function getColl(): Promise<Collection<ConversationDoc> | null> {
  try {
    const client = await getClient();
    const db: Db = client.db(MONGO_DB);
    return db.collection<ConversationDoc>(COLL);
  } catch {
    return null;
  }
}

// ---- 内存降级 ----
const memory = new Map<string, ConversationDoc>();

/**
 * 手动顺序步长：相邻项间隔 1000，方便将来在中间插入而不必整体重排。
 * 服务端按下标 × 本值分配 `sortOrder`。
 */
export const ORDER_STEP = 1000;

/**
 * 列表排序规则：置顶优先 → 手动顺序（排过的在前）→ 默认序。
 * 默认序：置顶组按置顶时间（新的在上），普通组按最近活动。
 *
 * 注意：排序模式的最终裁决在前端（`convRank`）——「按最近活动」模式下前端会忽略 `sortOrder`。
 * 这里给的是一份稳定的默认序（也是「手动排序」模式下的正确序）。
 */
function conversationRank(a: ConversationDoc, b: ConversationDoc): number {
  const ap = a.pinnedAt ? 1 : 0;
  const bp = b.pinnedAt ? 1 : 0;
  if (ap !== bp) return bp - ap;
  const ao = a.sortOrder ?? Number.POSITIVE_INFINITY;
  const bo = b.sortOrder ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao - bo;
  if (ap && bp) return (b.pinnedAt || 0) - (a.pinnedAt || 0);
  return b.updatedAt - a.updatedAt;
}

function dedupeDocs(list: ConversationDoc[]): ConversationDoc[] {
  const byId = new Map<string, ConversationDoc>();
  for (const doc of list) {
    const prev = byId.get(doc.id);
    if (!prev || doc.updatedAt >= prev.updatedAt) byId.set(doc.id, doc);
  }
  return [...byId.values()].sort(conversationRank);
}

// ---- CRUD ----
export async function listConversations(): Promise<ConversationDoc[]> {
  const coll = await getColl();
  // 列表不返回 context（体积大）：切对话时用 GET /chat/conversations/:id 单独取。
  if (!coll) {
    return dedupeDocs([...memory.values()].map(({ context, ...rest }) => rest as ConversationDoc));
  }
  const docs = await coll.find({}, { projection: { context: 0 } }).sort({ updatedAt: -1 }).toArray();
  return dedupeDocs(docs.map(({ _id, ...rest }) => rest as ConversationDoc));
}

export async function getConversation(id: string): Promise<ConversationDoc | null> {
  const coll = await getColl();
  if (!coll) return memory.get(id) || null;
  const doc = await coll.find({ id }).sort({ updatedAt: -1 }).limit(1).next();
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest as ConversationDoc;
}

export async function createConversation(input: { id: string; title: string }): Promise<ConversationDoc> {
  const now = Date.now();
  const doc: ConversationDoc = {
    id: input.id,
    title: input.title || "新对话",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  const coll = await getColl();
  if (!coll) {
    const existing = memory.get(input.id);
    if (existing) {
      existing.title = input.title || existing.title;
      existing.updatedAt = now;
      return existing;
    }
    memory.set(input.id, doc);
    return doc;
  }
  await coll.updateMany(
    { id: input.id },
    { $set: { title: input.title || "新对话", updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
  const saved = await getConversation(input.id);
  return saved || doc;
}

export async function upsertMessages(input: {
  id: string;
  messages: StoredMessage[];
  title?: string;
}): Promise<void> {
  const coll = await getColl();
  if (!coll) {
    let doc = memory.get(input.id);
    if (!doc) {
      doc = {
        id: input.id,
        title: input.title || "新对话",
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      memory.set(input.id, doc);
    }
    doc.messages = input.messages;
    doc.updatedAt = Date.now();
    if (input.title) doc.title = input.title;
    return;
  }
  await coll.updateMany(
    { id: input.id },
    {
      $set: {
        messages: input.messages,
        updatedAt: Date.now(),
        ...(input.title ? { title: input.title } : {}),
      },
      $setOnInsert: { createdAt: Date.now() },
    },
    { upsert: true },
  );
}

/** 写入/更新会话摘要与水位线（上下文压缩产物跨轮复用，水位线单调前移）。 */
export async function setConversationSummary(
  id: string,
  summary: string,
  summaryCovered: number,
): Promise<void> {
  const now = Date.now();
  const coll = await getColl();
  if (!coll) {
    const doc = memory.get(id);
    if (doc) {
      doc.summary = summary;
      doc.summaryAt = now;
      doc.summaryCovered = summaryCovered;
    }
    return;
  }
  await coll.updateMany({ id }, { $set: { summary, summaryAt: now, summaryCovered } });
}

/** 写入任务规划（write_todos 全量替换；跨轮持久化）。 */
export async function setConversationTodos(id: string, todos: TodoItem[]): Promise<void> {
  const coll = await getColl();
  if (!coll) {
    const doc = memory.get(id);
    if (doc) doc.todos = todos;
    return;
  }
  await coll.updateMany({ id }, { $set: { todos, updatedAt: Date.now() } });
}

export async function deleteConversation(id: string): Promise<void> {
  const coll = await getColl();
  if (!coll) {
    memory.delete(id);
    return;
  }
  await coll.deleteMany({ id });
}

export async function clearConversation(id: string): Promise<void> {
  const coll = await getColl();
  if (!coll) {
    const doc = memory.get(id);
    if (doc) {
      doc.messages = [];
      doc.updatedAt = Date.now();
    }
    return;
  }
  await coll.updateMany({ id }, { $set: { messages: [], updatedAt: Date.now() } });
}

// ---- 对话级设置 ----

export interface ConversationPatch {
  title?: string;
  model?: string;
  mcpServers?: string[];
  locale?: string;
  pendingQueue?: PendingMessage[];
  /** 置顶时间戳；null = 取消置顶。 */
  pinnedAt?: number | null;
}

/**
 * 只改变「列表怎么组织」、不代表对话有新活动的字段：
 * 改它们不应刷新 `updatedAt`，否则在「按最近活动排序」下会把该对话弹到列表最前（与用户预期不符）。
 */
const ACTIVITY_NEUTRAL_KEYS = new Set(["title", "pinnedAt"]);

/**
 * 更新对话设置（未提供的字段保持不变）；对话不存在返回 null。
 *
 * 排序只应由真实活动（新消息）驱动：重命名 / 置顶这类整理动作不刷新 `updatedAt`。
 */
export async function patchConversation(id: string, patch: ConversationPatch): Promise<ConversationDoc | null> {
  const set: Record<string, unknown> = {};
  for (const key of ["title", "model", "mcpServers", "locale", "pendingQueue", "pinnedAt"] as const) {
    if (patch[key] !== undefined) set[key] = patch[key];
  }
  if (!Object.keys(set).length) return getConversation(id);
  if (Object.keys(set).some((key) => !ACTIVITY_NEUTRAL_KEYS.has(key))) set.updatedAt = Date.now();
  const coll = await getColl();
  if (!coll) {
    const doc = memory.get(id);
    if (!doc) return null;
    Object.assign(doc, set);
    return doc;
  }
  await coll.updateOne({ id }, { $set: set });
  return getConversation(id);
}

/**
 * 批量写入手动顺序：`ids` 的下标即新顺序（`sortOrder = index × ORDER_STEP`）。
 *
 * 单请求原子提交（而不是逐条 PATCH），避免中途失败留下半套顺序、以及多次请求间的竞态。
 * 与重命名 / 置顶同理：**整理动作不刷新 `updatedAt`**，否则排序一改就会污染「最近活动」。
 */
export async function reorderConversations(ids: string[]): Promise<void> {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id))];
  if (!unique.length) return;
  const coll = await getColl();
  if (!coll) {
    unique.forEach((id, index) => {
      const doc = memory.get(id);
      if (doc) doc.sortOrder = index * ORDER_STEP;
    });
    return;
  }
  await Promise.all(
    unique.map((id, index) => coll.updateOne({ id }, { $set: { sortOrder: index * ORDER_STEP } })),
  );
}

/** 任意对话启用的 MCP server id 集合（连接引用计数用：还有对话在用就不要断开）。 */
export async function listEnabledMcpServers(): Promise<Set<string>> {
  const docs = await listConversations();
  const used = new Set<string>();
  for (const doc of docs) for (const id of doc.mcpServers || []) used.add(id);
  return used;
}

/** 从所有对话的启用集里摘除某 MCP server（配置被删除时调用，避免留下悬空引用）。 */
export async function pullMcpServerFromAllConversations(id: string): Promise<void> {
  const coll = await getColl();
  if (!coll) {
    for (const doc of memory.values()) {
      if (doc.mcpServers?.includes(id)) doc.mcpServers = doc.mcpServers.filter((x) => x !== id);
    }
    return;
  }
  await coll.updateMany({ mcpServers: id }, { $pull: { mcpServers: id } });
}

// ---- 对话上下文（thread）----

/**
 * 原子追加一轮上下文：单文档 $push + $inc，保证并发追加顺序可判定
 * （对齐 OpenAI Agents SDK MongoDBSession 的「原子序列计数器」做法）。
 */
export async function appendContext(id: string, turns: ChatTurn[]): Promise<void> {
  if (!turns.length) return;
  const now = Date.now();
  const coll = await getColl();
  if (!coll) {
    let doc = memory.get(id);
    if (!doc) {
      doc = { id, title: "新对话", messages: [], createdAt: now, updatedAt: now };
      memory.set(id, doc);
    }
    doc.context = [...(doc.context || []), ...turns];
    doc.contextSeq = (doc.contextSeq || 0) + turns.length;
    doc.updatedAt = now;
    return;
  }
  await coll.updateOne(
    { id },
    {
      $push: { context: { $each: turns } },
      $inc: { contextSeq: turns.length },
      $set: { updatedAt: now },
      $setOnInsert: { title: "新对话", messages: [], createdAt: now },
    },
    { upsert: true },
  );
}

/** 清空该对话的上下文与摘要（不影响 UI 消息快照 messages）。 */
export async function clearContext(id: string): Promise<void> {
  const coll = await getColl();
  if (!coll) {
    const doc = memory.get(id);
    if (doc) {
      doc.context = [];
      doc.summary = "";
      doc.summaryCovered = 0;
      doc.contextSeq = 0;
      doc.updatedAt = Date.now();
    }
    return;
  }
  await coll.updateMany(
    { id },
    { $set: { context: [], summary: "", summaryCovered: 0, contextSeq: 0, updatedAt: Date.now() } },
  );
}

/**
 * 解析本次请求所属的对话（thread）：
 * - 显式传入 conversationId → 用它（不存在则创建）；
 * - 否则用会话里记录的活跃对话；
 * - 都没有 → 创建「默认对话」，并把旧 session.messages / mcpServers **拷贝**迁移进去
 *   （源字段保留一个版本以支持回退，不再写入）。
 */
export async function resolveConversation(session: Session, conversationId?: string): Promise<string> {
  if (conversationId) {
    if (!(await getConversation(conversationId))) {
      await createConversation({ id: conversationId, title: "新对话" });
    }
    return conversationId;
  }
  if (session.activeConversationId && (await getConversation(session.activeConversationId))) {
    return session.activeConversationId;
  }
  const legacyTurns = (session.messages || []).filter((m) => m.text);
  const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await createConversation({ id, title: legacyTurns[0] ? legacyTurns[0].text.slice(0, 24) : "新对话" });
  if (legacyTurns.length || (session.mcpServers || []).length) {
    await appendContext(
      id,
      legacyTurns.map((turn) => ({
        role: turn.role,
        text: turn.text,
        ...(turn.handles?.length ? { handles: turn.handles } : {}),
      })),
    );
    if ((session.mcpServers || []).length) {
      await patchConversation(id, { mcpServers: session.mcpServers });
    }
    console.log(
      `[conversations] 迁移旧会话：上下文 ${legacyTurns.length} 条 / MCP ${(session.mcpServers || []).length} 个 → ${id}`,
    );
  }
  session.activeConversationId = id;
  touchSession(session);
  return id;
}
