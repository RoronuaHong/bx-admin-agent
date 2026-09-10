// 聊天 / Analytics 会话服务端持久化，存 MongoDB。
// chat：登录 session → ownerKey = `${countryId}:${loginName}`。
// analytics：登录同 chat；未登录用 bx_analytics_aid → ownerKey = `anon:<aid>`（app.ts resolveAnalyticsOwner）。
//
// 设计要点：
//  - MongoClient 单例懒连接；失败降级进程内存 Map。
//  - chat → 集合 chat_conversations；analytics → analytics_conversations（互不串台）。

import { MongoClient, type Collection, type Db, type ObjectId } from "mongodb";
import type { SessionUser } from "@bx/shared";
import type { LocalizedToken } from "./i18n";

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const MONGO_DB = process.env.MONGO_DB_NAME || "bx_agent";

export type ConversationStore = "chat" | "analytics";

const COLL_BY_STORE: Record<ConversationStore, string> = {
  chat: "chat_conversations",
  analytics: "analytics_conversations",
};

/** 断线兜底会话稳定 id（按 ownerKey 一份）；旧版 task-<sessionId> 为孤儿。 */
export const TASK_RESULTS_CONV_ID = "task-results";

export function isLegacyTaskConversationId(id: string): boolean {
  return id.startsWith("task-") && id !== TASK_RESULTS_CONV_ID;
}

export interface StoredMessage {
  id?: string | number;
  role: "user" | "assistant";
  text: string;
  images?: Array<{ id: string; name: string }>;
  tables?: unknown[];
  charts?: unknown[];
  files?: unknown[];
  cancelled?: boolean;
  status?: string;
  error?: string;
  errorToken?: LocalizedToken;
  reasoning?: string;
  toolResults?: Array<{ name: string; result: string }>;
  toolStep?: number;
  currentTool?: string;
  /** Analytics ask extras */
  timeEcho?: string;
  sqls?: string[];
  probeSummary?: string;
  askId?: string;
  modelId?: string;
  packVersion?: string;
  userNl?: string;
  feedback?: string;
  welcome?: boolean;
  pending?: boolean;
  clarifySlot?: string;
}

export interface ConversationDoc {
  _id?: ObjectId;
  id: string;
  ownerKey: string;
  countryId: string;
  loginName: string;
  title: string;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
}

/** 从 session 用户推导归属 key（国家线 + 登录名）。 */
export function ownerKeyOf(user: SessionUser | undefined, countryId: string): string {
  const loginName = user?.loginName || String(user?.id ?? "anon");
  return `${countryId}:${loginName}`;
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

async function getColl(store: ConversationStore = "chat"): Promise<Collection<ConversationDoc> | null> {
  try {
    const client = await getClient();
    const db: Db = client.db(MONGO_DB);
    return db.collection<ConversationDoc>(COLL_BY_STORE[store]);
  } catch {
    return null;
  }
}

// ---- 内存降级（按 store 分桶） ----
const memoryByStore: Record<ConversationStore, Map<string, ConversationDoc[]>> = {
  chat: new Map(),
  analytics: new Map(),
};

function memGet(store: ConversationStore, ownerKey: string): ConversationDoc[] {
  return memoryByStore[store].get(ownerKey) || [];
}
function memSet(store: ConversationStore, ownerKey: string, list: ConversationDoc[]) {
  memoryByStore[store].set(ownerKey, list);
}

function dedupeDocs(list: ConversationDoc[]): ConversationDoc[] {
  const byId = new Map<string, ConversationDoc>();
  for (const doc of list) {
    const prev = byId.get(doc.id);
    if (!prev || doc.updatedAt >= prev.updatedAt) byId.set(doc.id, doc);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function resolveStore(store?: ConversationStore): ConversationStore {
  return store === "analytics" ? "analytics" : "chat";
}

// ---- CRUD ----
export async function listConversations(
  ownerKey: string,
  store: ConversationStore = "chat",
): Promise<ConversationDoc[]> {
  const s = resolveStore(store);
  const coll = await getColl(s);
  if (!coll) {
    const list = dedupeDocs(memGet(s, ownerKey));
    return s === "chat" ? purgeLegacyTaskConversations(ownerKey, list) : list;
  }
  const docs = await coll.find({ ownerKey }).sort({ updatedAt: -1 }).toArray();
  const mapped = dedupeDocs(docs.map(({ _id, ...rest }) => rest as ConversationDoc));
  return s === "chat" ? purgeLegacyTaskConversations(ownerKey, mapped) : mapped;
}

async function purgeLegacyTaskConversations(
  ownerKey: string,
  list: ConversationDoc[],
): Promise<ConversationDoc[]> {
  const legacy = list.filter((d) => isLegacyTaskConversationId(d.id));
  if (!legacy.length) return list;
  await Promise.all(legacy.map((d) => deleteConversation(ownerKey, d.id, "chat").catch(() => {})));
  return list.filter((d) => !isLegacyTaskConversationId(d.id));
}

export async function getConversation(
  ownerKey: string,
  id: string,
  store: ConversationStore = "chat",
): Promise<ConversationDoc | null> {
  const s = resolveStore(store);
  const coll = await getColl(s);
  if (!coll) return dedupeDocs(memGet(s, ownerKey).filter((c) => c.id === id))[0] || null;
  const doc = await coll.find({ ownerKey, id }).sort({ updatedAt: -1 }).limit(1).next();
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest as ConversationDoc;
}

export async function createConversation(input: {
  ownerKey: string;
  countryId: string;
  loginName: string;
  id: string;
  title: string;
  store?: ConversationStore;
}): Promise<ConversationDoc> {
  const s = resolveStore(input.store);
  const now = Date.now();
  const doc: ConversationDoc = {
    id: input.id,
    ownerKey: input.ownerKey,
    countryId: input.countryId,
    loginName: input.loginName,
    title: input.title || "新对话",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  const coll = await getColl(s);
  if (!coll) {
    const list = memGet(s, input.ownerKey);
    const idx = list.findIndex((c) => c.id === input.id);
    if (idx >= 0) {
      const existing = list[idx]!;
      existing.title = input.title || existing.title || "新对话";
      existing.updatedAt = now;
      if (!existing.createdAt) existing.createdAt = now;
      memSet(s, input.ownerKey, dedupeDocs(list));
      return existing;
    }
    list.unshift(doc);
    memSet(s, input.ownerKey, dedupeDocs(list));
    return doc;
  }
  await coll.updateMany(
    { ownerKey: input.ownerKey, id: input.id },
    {
      $set: {
        title: input.title || "新对话",
        updatedAt: now,
      },
      $setOnInsert: {
        countryId: input.countryId,
        loginName: input.loginName,
        createdAt: now,
      },
    },
    { upsert: true },
  );
  const saved = await getConversation(input.ownerKey, input.id, s);
  return saved || doc;
}

export async function upsertMessages(input: {
  ownerKey: string;
  countryId: string;
  loginName: string;
  id: string;
  messages: StoredMessage[];
  title?: string;
  store?: ConversationStore;
}): Promise<void> {
  const s = resolveStore(input.store);
  const coll = await getColl(s);
  if (!coll) {
    const list = memGet(s, input.ownerKey);
    let doc = list.find((c) => c.id === input.id);
    if (!doc) {
      doc = {
        id: input.id,
        ownerKey: input.ownerKey,
        countryId: input.countryId,
        loginName: input.loginName,
        title: input.title || "新对话",
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      list.unshift(doc);
    }
    doc.messages = input.messages;
    doc.updatedAt = Date.now();
    if (input.title) doc.title = input.title;
    memSet(s, input.ownerKey, dedupeDocs(list));
    return;
  }
  await coll.updateMany(
    { ownerKey: input.ownerKey, id: input.id },
    {
      $set: {
        messages: input.messages,
        updatedAt: Date.now(),
        ...(input.title ? { title: input.title } : {}),
      },
      $setOnInsert: {
        countryId: input.countryId,
        loginName: input.loginName,
        createdAt: Date.now(),
      },
    },
    { upsert: true },
  );
}

export async function renameConversation(
  ownerKey: string,
  id: string,
  title: string,
  store: ConversationStore = "chat",
): Promise<void> {
  const s = resolveStore(store);
  const coll = await getColl(s);
  if (!coll) {
    const list = memGet(s, ownerKey);
    for (const doc of list) {
      if (doc.id === id) {
        doc.title = title;
        doc.updatedAt = Date.now();
      }
    }
    memSet(s, ownerKey, dedupeDocs(list));
    return;
  }
  await coll.updateMany({ ownerKey, id }, { $set: { title, updatedAt: Date.now() } });
}

export async function deleteConversation(
  ownerKey: string,
  id: string,
  store: ConversationStore = "chat",
): Promise<void> {
  const s = resolveStore(store);
  const coll = await getColl(s);
  if (!coll) {
    memSet(
      s,
      ownerKey,
      memGet(s, ownerKey).filter((c) => c.id !== id),
    );
    return;
  }
  await coll.deleteMany({ ownerKey, id });
}

export async function clearConversation(
  ownerKey: string,
  id: string,
  store: ConversationStore = "chat",
): Promise<void> {
  const s = resolveStore(store);
  const coll = await getColl(s);
  if (!coll) {
    const list = memGet(s, ownerKey);
    for (const doc of list) {
      if (doc.id === id) {
        doc.messages = [];
        doc.updatedAt = Date.now();
      }
    }
    memSet(s, ownerKey, dedupeDocs(list));
    return;
  }
  await coll.updateMany({ ownerKey, id }, { $set: { messages: [], updatedAt: Date.now() } });
}
