// 聊天会话持久化，存 MongoDB（连不上则降级进程内存）。
//
// 设计要点：
//  - MongoClient 单例懒连接；失败降级进程内存 Map。
//  - 单一集合 chat_conversations（本机单用户，无归属隔离）。

import { MongoClient, type Collection, type Db, type ObjectId } from "mongodb";

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const MONGO_DB = process.env.MONGO_DB_NAME || "bx_agent";
const COLL = "chat_conversations";

export interface StoredMessage {
  id?: string | number;
  role: "user" | "assistant";
  text: string;
  images?: Array<{ id: string; name: string }>;
}

export interface ConversationDoc {
  _id?: ObjectId;
  id: string;
  title: string;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
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

function dedupeDocs(list: ConversationDoc[]): ConversationDoc[] {
  const byId = new Map<string, ConversationDoc>();
  for (const doc of list) {
    const prev = byId.get(doc.id);
    if (!prev || doc.updatedAt >= prev.updatedAt) byId.set(doc.id, doc);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---- CRUD ----
export async function listConversations(): Promise<ConversationDoc[]> {
  const coll = await getColl();
  if (!coll) return dedupeDocs([...memory.values()]);
  const docs = await coll.find({}).sort({ updatedAt: -1 }).toArray();
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

export async function renameConversation(id: string, title: string): Promise<void> {
  const coll = await getColl();
  if (!coll) {
    const doc = memory.get(id);
    if (doc) {
      doc.title = title;
      doc.updatedAt = Date.now();
    }
    return;
  }
  await coll.updateMany({ id }, { $set: { title, updatedAt: Date.now() } });
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
