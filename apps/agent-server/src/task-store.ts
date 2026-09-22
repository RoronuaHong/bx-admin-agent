// 任务留档的持久层（2026-09-22）：把「任务状态 + 事件缓冲 + 正文累积」按固定间隔落 MongoDB。
//
// 解决什么：`chat-tasks` 的注册表在进程内存里，服务重启 / 崩溃后这一轮连同已产出的事件一起消失，
// 晚到的重连只能被告知「没有这个任务」。落库之后，重启后仍能：
//   ① 把断线期间产出、客户端还没看到的事件补齐（配合 `seq` 游标，只补更新的部分）；
//   ② 按 `status` 如实收口（`interrupted`），而不是假装还在跑、也不是丢掉已产出的内容。
//
// **边界（重要，别误读）**：能续的是「**流的读取**」，不是「这一轮的执行」——
// 进程一没，模型循环就随之消失。这里刻意**不做**任何「重放 / 重试模型调用」的恢复
// （重放可能重复副作用），只保证「已产出的内容不丢 + 状态诚实」。
//
// 降级口径与 `conversations.ts` 一致：连不上 Mongo 就退回进程内存（行为退化为「重启即丢」），
// 持久化失败只告警、绝不阻断主流程。
import { MongoClient, type Collection, type Db } from "mongodb";
import type { ChatEvent } from "@bx/shared";

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const MONGO_DB = process.env.MONGO_DB_NAME || "bx_agent";
const COLL = "chat_tasks";

/** 单任务保留的事件条数上限：超出丢最旧的（只影响「很晚才回来的重连」能看到的历史长度）。 */
export const TASK_EVENTS_CAP = Math.max(100, Number(process.env.CHAT_TASK_EVENTS_CAP ?? 2000));
/** 留档总时长（毫秒）：Mongo 侧按 `expiresAt` TTL 索引自动清理，内存降级侧按它惰性回收。 */
export const TASK_DB_RETAIN_MS = Math.max(60_000, Number(process.env.CHAT_TASK_DB_RETAIN_MS ?? 1_800_000));

export type StoredTaskStatus = "running" | "success" | "failed" | "cancelled" | "interrupted";

export interface TaskRecord {
  taskId: string;
  conversationId: string;
  userText: string;
  ownerKey?: string;
  /** 承载该任务的进程实例：恢复（判定僵尸任务）与看门狗据此区分「是不是我这边的」。 */
  instanceId: string;
  status: StoredTaskStatus;
  startedAt: number;
  settledAt?: number;
  /** 已分配的事件序号上界（续传游标的上界，与内存语义一致）。 */
  seq: number;
  /** 累积正文（续传时作为一条 `text` 快照补发，替换语义 → 幂等）。 */
  text: string;
  /** `text` 对应的序号水位。 */
  textSeq: number;
  /** 事件留档（不含 text_delta——正文另有累积字段，见上）。 */
  events: ChatEvent[];
  /** 心跳时间（每次 flush 更新）：跨进程判定「这个任务是不是已经死了」的唯一依据。 */
  updatedAt: number;
  /** TTL 依据：Mongo TTL 索引（expireAfterSeconds=0）按它自动删除。 */
  expiresAt: Date;
}

// ---- Mongo 单例（与 conversations.ts 同一套懒连接 + 失败冷却）----
let clientPromise: Promise<MongoClient> | null = null;
let lastConnectFail = 0;
const CONNECT_RETRY_COOLDOWN = 30_000;
/** 集合是否已就绪（避免每次写入都试连接；失败则退回内存并告警一次）。 */
let mongoReady = false;
let warnedFallback = false;

function getClient(): Promise<MongoClient> {
  if (clientPromise) return clientPromise;
  if (Date.now() - lastConnectFail < CONNECT_RETRY_COOLDOWN) {
    return Promise.reject(new Error("MongoDB 连接冷却中（上次失败 30s 内）"));
  }
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
  clientPromise = client
    .connect()
    .then((c) => c)
    .catch((err) => {
      clientPromise = null;
      lastConnectFail = Date.now();
      throw err;
    });
  return clientPromise;
}

async function getColl(): Promise<Collection<TaskRecord> | null> {
  if (!mongoReady) return null;
  try {
    const client = await getClient();
    const db: Db = client.db(MONGO_DB);
    return db.collection<TaskRecord>(COLL);
  } catch {
    return null;
  }
}

// ---- 内存降级 ----
const memory = new Map<string, TaskRecord>();

function memPut(record: TaskRecord, newEvents: ChatEvent[]): void {
  const merged = [...(memory.get(record.conversationId)?.events || []), ...newEvents];
  const events = merged.slice(-TASK_EVENTS_CAP);
  memory.set(record.conversationId, { ...record, events });
}

function memSweep(): void {
  const now = Date.now();
  for (const [id, record] of memory) if (record.expiresAt.getTime() <= now) memory.delete(id);
}

/**
 * 初始化留档仓储：连不上 Mongo 就静默退回内存（与对话持久化同口径）。
 * 返回 true = 落库可用（重启后仍能续读）。
 */
export async function initTaskStore(): Promise<boolean> {
  try {
    const client = await getClient();
    const coll = client.db(MONGO_DB).collection<TaskRecord>(COLL);
    // TTL：留档过期由 Mongo 自动清理，不需要额外的清扫任务。
    await coll.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => undefined);
    // 恢复扫描要按「状态 + 心跳」找僵尸任务。
    await coll.createIndex({ status: 1, updatedAt: 1 }).catch(() => undefined);
    mongoReady = true;
    console.log(`[task-store] MongoDB 已连接，任务留档启用（${MONGO_URI}/${MONGO_DB}.${COLL}，TTL ${Math.round(TASK_DB_RETAIN_MS / 1000)}s）`);
    return true;
  } catch (err) {
    mongoReady = false;
    if (!warnedFallback) {
      warnedFallback = true;
      console.warn(
        `[task-store] MongoDB 不可用，任务留档降级进程内存（重启后无法续读）：${String((err as Error)?.message || err)}`,
      );
    }
    return false;
  }
}

/** 落库是否可用（排障 / 状态展示用）。 */
export function taskStoreBackend(): "mongo" | "memory" {
  return mongoReady ? "mongo" : "memory";
}

/**
 * 落一次快照：状态与正文整体覆盖，**只把 `pendingEvents` 追加进留档**（`$push + $slice`，避免整表重写）。
 * 注意 `record.events` **不参与写入**（它只是快照形状的一部分，读侧才用）——把「全量事件」与
 * 「本次新增」混为一谈会重复追加。失败只告警，不影响本轮执行。
 */
export async function flushTask(record: TaskRecord, pendingEvents: ChatEvent[]): Promise<boolean> {
  const newEvents = pendingEvents;
  memPut(record, newEvents);
  const coll = await getColl();
  // 内存降级路径算「写成功」：事件已进内存副本（进程内续传照旧可用）。
  if (!coll) return true;
  try {
    await coll.updateOne(
      { _id: record.conversationId } as never,
      {
        $set: {
          taskId: record.taskId,
          conversationId: record.conversationId,
          userText: record.userText,
          ...(record.ownerKey ? { ownerKey: record.ownerKey } : {}),
          instanceId: record.instanceId,
          status: record.status,
          startedAt: record.startedAt,
          ...(record.settledAt !== undefined ? { settledAt: record.settledAt } : {}),
          seq: record.seq,
          text: record.text,
          textSeq: record.textSeq,
          updatedAt: record.updatedAt,
          expiresAt: record.expiresAt,
        },
        ...(newEvents.length
          ? { $push: { events: { $each: newEvents, $slice: -TASK_EVENTS_CAP } } }
          : {}),
      } as never,
      { upsert: true },
    );
    return true;
  } catch (err) {
    // 返回 false = 这批事件没进去：调用方**不要**前移水位，下次重试同一批
    // （宁可重复落档——读侧按 seq 去重——也不要静默丢事件）。
    console.warn(`[task-store] 落库失败（不影响本轮，下次重试）：${String((err as Error)?.message || err)}`);
    return false;
  }
}

/** 读取某对话的任务留档（没有 / 已过 TTL → null）。 */
export async function loadTaskRecord(conversationId: string): Promise<TaskRecord | null> {
  memSweep();
  const coll = await getColl();
  if (coll) {
    try {
      const doc = await coll.findOne({ _id: conversationId } as never);
      if (doc) return { ...(doc as unknown as TaskRecord), conversationId };
    } catch (err) {
      console.warn(`[task-store] 读取留档失败：${String((err as Error)?.message || err)}`);
    }
  }
  return memory.get(conversationId) || null;
}

/** 把「僵尸任务」（进程已死但状态还写着 running）改成 interrupted——恢复扫描与续读路径共用。 */
export async function markTaskInterrupted(conversationId: string): Promise<boolean> {
  const now = Date.now();
  const local = memory.get(conversationId);
  if (local && local.status === "running") {
    memory.set(conversationId, { ...local, status: "interrupted", settledAt: now, updatedAt: now });
  }
  const coll = await getColl();
  if (!coll) return Boolean(local);
  try {
    const res = await coll.updateOne(
      { _id: conversationId, status: "running" } as never,
      { $set: { status: "interrupted", settledAt: now, updatedAt: now } } as never,
    );
    return res.modifiedCount > 0;
  } catch {
    return false;
  }
}

/**
 * 找出「心跳已经停了的 running 任务」——别的实例上次 flush 之后就没声了，说明它已经不在了。
 * `exceptInstanceId` = 本进程实例（自己的任务由自己的看门狗负责，不走恢复路径）。
 */
export async function listStaleRunningTasks(
  staleBefore: number,
  exceptInstanceId: string,
): Promise<Array<{ conversationId: string; taskId: string; updatedAt: number }>> {
  const coll = await getColl();
  const out: Array<{ conversationId: string; taskId: string; updatedAt: number }> = [];
  for (const record of memory.values()) {
    if (record.status === "running" && record.updatedAt < staleBefore && record.instanceId !== exceptInstanceId) {
      out.push({ conversationId: record.conversationId, taskId: record.taskId, updatedAt: record.updatedAt });
    }
  }
  if (!coll) return out;
  try {
    const docs = await coll
      .find({ status: "running", updatedAt: { $lt: staleBefore }, instanceId: { $ne: exceptInstanceId } } as never)
      .limit(200)
      .toArray();
    for (const doc of docs) {
      out.push({ conversationId: doc.conversationId, taskId: doc.taskId, updatedAt: doc.updatedAt });
    }
  } catch (err) {
    console.warn(`[task-store] 恢复扫描失败：${String((err as Error)?.message || err)}`);
  }
  return out;
}
