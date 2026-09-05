// 聊天记录服务端持久化（方案 C）：按登录用户归属，存 MongoDB。
// 身份由 cookie session 决定（app.ts 的 getSession），归属 key = `${countryId}:${loginName}`，
// 与前端无关，杜绝 localStorage 时代「身份错位 / 5MB 上限 / filter 误删」导致的记录丢失。
//
// 设计要点：
//  - MongoClient 单例懒连接（进程级复用），不每次新建连接。
//  - 连接/写入失败降级为进程内存 Map（不阻断对话），并打 warn，便于无 Mongo 时本地开发。
//  - 集合 chat_conversations，文档结构见 ConversationDoc。

import { MongoClient, type Collection, type Db, type ObjectId } from "mongodb";
import type { SessionUser } from "@bx/shared";

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const MONGO_DB = process.env.MONGO_DB_NAME || "bx_agent";
const COLL = "chat_conversations";
/** 断线兜底会话稳定 id（按 ownerKey 一份）；旧版 task-<sessionId> 为孤儿。 */
export const TASK_RESULTS_CONV_ID = "task-results";

export function isLegacyTaskConversationId(id: string): boolean {
  return id.startsWith("task-") && id !== TASK_RESULTS_CONV_ID;
}

export interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  images?: string[];
  tables?: unknown[];
  charts?: unknown[];
  files?: unknown[];
  cancelled?: boolean;
  status?: string;
  error?: string;
}

export interface ConversationDoc {
  _id?: ObjectId;
  id: string; // 业务会话 id（前端生成 conv_xxx）
  ownerKey: string; // `${countryId}:${loginName}`
  countryId: string;
  loginName: string;
  title: string;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
}

/** 从 session 用户推导归属 key（国家线 + 登录名，唯一标识一个后端账号）。 */
export function ownerKeyOf(user: SessionUser | undefined, countryId: string): string {
  const loginName = user?.loginName || String(user?.id ?? "anon");
  return `${countryId}:${loginName}`;
}

// ---- Mongo 单例 ----
let clientPromise: Promise<MongoClient> | null = null;
let lastConnectFail = 0;
// 连接失败后的冷却窗口：避免 Mongo 持续不可达时，每次聊天保存都新建连接并阻塞 serverSelectionTimeoutMS(3s)。
// 冷却期内直接 reject → getColl catch 降级内存，不重复建连。
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
      clientPromise = null; // 允许冷却后重试
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
    return null; // 降级
  }
}

// ---- 内存降级（无 Mongo 时） ----
const memory = new Map<string, ConversationDoc[]>();

function memGet(ownerKey: string): ConversationDoc[] {
  return memory.get(ownerKey) || [];
}
function memSet(ownerKey: string, list: ConversationDoc[]) {
  memory.set(ownerKey, list);
}

function dedupeDocs(list: ConversationDoc[]): ConversationDoc[] {
  const byId = new Map<string, ConversationDoc>();
  for (const doc of list) {
    const prev = byId.get(doc.id);
    if (!prev || doc.updatedAt >= prev.updatedAt) byId.set(doc.id, doc);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---- CRUD ----
export async function listConversations(ownerKey: string): Promise<ConversationDoc[]> {
  const coll = await getColl();
  if (!coll) {
    const list = dedupeDocs(memGet(ownerKey));
    return purgeLegacyTaskConversations(ownerKey, list);
  }
  const docs = await coll.find({ ownerKey }).sort({ updatedAt: -1 }).toArray();
  const mapped = dedupeDocs(docs.map(({ _id, ...rest }) => rest as ConversationDoc));
  return purgeLegacyTaskConversations(ownerKey, mapped);
}

/** 列表时顺带清掉旧版按 session 拆分的 task-*，避免刷新冒出一堆「后台任务结果」tab。 */
async function purgeLegacyTaskConversations(
  ownerKey: string,
  list: ConversationDoc[],
): Promise<ConversationDoc[]> {
  const legacy = list.filter((d) => isLegacyTaskConversationId(d.id));
  if (!legacy.length) return list;
  await Promise.all(legacy.map((d) => deleteConversation(ownerKey, d.id).catch(() => {})));
  return list.filter((d) => !isLegacyTaskConversationId(d.id));
}

export async function getConversation(ownerKey: string, id: string): Promise<ConversationDoc | null> {
  const coll = await getColl();
  if (!coll) return dedupeDocs(memGet(ownerKey).filter((c) => c.id === id))[0] || null;
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
}): Promise<ConversationDoc> {
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
  const coll = await getColl();
  if (!coll) {
    const list = memGet(input.ownerKey);
    const idx = list.findIndex((c) => c.id === input.id);
    if (idx >= 0) {
      const existing = list[idx]!;
      existing.title = input.title || existing.title || "新对话";
      existing.updatedAt = now;
      if (!existing.createdAt) existing.createdAt = now;
      memSet(input.ownerKey, dedupeDocs(list));
      return existing;
    }
    list.unshift(doc);
    memSet(input.ownerKey, dedupeDocs(list));
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
  const saved = await getConversation(input.ownerKey, input.id);
  return saved || doc;
}

export async function upsertMessages(input: {
  ownerKey: string;
  countryId: string;
  loginName: string;
  id: string;
  messages: StoredMessage[];
  title?: string;
}): Promise<void> {
  const coll = await getColl();
  if (!coll) {
    const list = memGet(input.ownerKey);
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
    memSet(input.ownerKey, dedupeDocs(list));
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
): Promise<void> {
  const coll = await getColl();
  if (!coll) {
    const list = memGet(ownerKey);
    for (const doc of list) {
      if (doc.id === id) {
        doc.title = title;
        doc.updatedAt = Date.now();
      }
    }
    memSet(ownerKey, dedupeDocs(list));
    return;
  }
  await coll.updateMany({ ownerKey, id }, { $set: { title, updatedAt: Date.now() } });
}

export async function deleteConversation(ownerKey: string, id: string): Promise<void> {
  const coll = await getColl();
  if (!coll) {
    memSet(
      ownerKey,
      memGet(ownerKey).filter((c) => c.id !== id),
    );
    return;
  }
  await coll.deleteMany({ ownerKey, id });
}

export async function clearConversation(ownerKey: string, id: string): Promise<void> {
  const coll = await getColl();
  if (!coll) {
    const list = memGet(ownerKey);
    for (const doc of list) {
      if (doc.id === id) {
        doc.messages = [];
        doc.updatedAt = Date.now();
      }
    }
    memSet(ownerKey, dedupeDocs(list));
    return;
  }
  await coll.updateMany({ ownerKey, id }, { $set: { messages: [], updatedAt: Date.now() } });
}
