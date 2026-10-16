// 模型冷却状态的持久层（第 3 批 P0-2，2026-10-14 事故复盘 §5）。
//
// 解决什么：`chat.ts` 的冷却表是进程内 `Map`，进程一重启就清空——于是每次重启开场都把
// 已经耗尽配额（402 / 每日配额 429）的模型从头打一遍，既白付探测延迟，也刷满错误日志。
// 落库之后，重启后第一个请求的候选链就直接跳过还在冷却期里的模型。
//
// **边界（重要，别误读）**：持久化的只是「这个模型短时间不会自己好」这一**状态**，
// 不是调用本身——恢复路径不重放任何模型调用，冷启动后的第一次失败由正常候选链处理。
// 冷却到期（`until`）之后条目自然失效：Mongo 侧 TTL 索引自动删除，读侧按 `until` 过滤。
//
// 降级口径与 `task-store.ts` / `conversations.ts` 一致：连不上 Mongo 就退回进程内存
// （行为退化为「重启即清」，即修复前的现状），持久化失败只告警、绝不阻断主流程。
import { type Collection, type Db } from "mongodb";
import { getMongoClient, MONGO_DB_NAME } from "./db.js";

const COLL = "model_cooldowns";

export interface CooldownEntry {
  modelId: string;
  /** 冷却截止时刻（epoch ms）。读侧只认 `until > now` 的条目。 */
  until: number;
  /** 冷却原因的状态码（402 / 429 …）：恢复时一并写回 chat.ts 的冷却原因表。 */
  status?: string;
  /** 写入时刻（诊断用）。 */
  at: number;
}

/** 集合是否已就绪（避免每次写入都试连接；失败则退回内存并告警一次）。 */
let mongoReady = false;
let warnedFallback = false;

/** 内存降级副本：Mongo 不可用时它是唯一存储；可用时它只是「尚未落盘」的短窗口兜底。 */
const memory = new Map<string, CooldownEntry>();

/** 持久化开关：`MODEL_COOLDOWN_PERSIST=off` 时整模块静默，行为逐字节回到「进程内 Map」。 */
export function modelCooldownPersistenceEnabled(): boolean {
  return (process.env.MODEL_COOLDOWN_PERSIST || "on").trim().toLowerCase() !== "off";
}

async function getColl(): Promise<Collection<CooldownEntry> | null> {
  if (!mongoReady || !modelCooldownPersistenceEnabled()) return null;
  try {
    const client = await getMongoClient();
    const db: Db = client.db(MONGO_DB_NAME);
    return db.collection<CooldownEntry>(COLL);
  } catch {
    return null;
  }
}

/**
 * 初始化持久层：连不上 Mongo 就静默退回内存（与任务留档同口径）。
 * 返回 true = 落库可用（重启后仍能恢复冷却状态）。
 */
export async function initModelCooldown(): Promise<boolean> {
  if (!modelCooldownPersistenceEnabled()) return false;
  try {
    const client = await getMongoClient();
    const coll = client.db(MONGO_DB_NAME).collection<CooldownEntry>(COLL);
    // TTL：冷却到期后由 Mongo 自动清理——冷却本身就是短时状态，过期条目不值得多留一刻。
    await coll.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch((e) => {
      console.warn(
        `[model-cooldown] TTL 索引创建失败，过期冷却不会被自动清理（集合缓慢膨胀）：${String((e as Error)?.message || e)}`,
      );
    });
    mongoReady = true;
    console.log(`[model-cooldown] MongoDB 已连接，模型冷却状态将跨重启保留（${MONGO_DB_NAME}.${COLL}）`);
    return true;
  } catch (err) {
    mongoReady = false;
    if (!warnedFallback) {
      warnedFallback = true;
      console.warn(
        `[model-cooldown] MongoDB 不可用，冷却状态仅进程内存（重启即清）：${String((err as Error)?.message || err)}`,
      );
    }
    return false;
  }
}

/** 落库是否可用（排障 / 状态展示用）。 */
export function modelCooldownBackend(): "mongo" | "memory" {
  return mongoReady && modelCooldownPersistenceEnabled() ? "mongo" : "memory";
}

/**
 * 读回**未过期**的冷却（启动恢复用）。
 * Mongo 与内存副本都读，同一模型以更晚的 `until` 为准——落盘是 fire-and-forget，
 * 刚写的条目可能只在内存里，直接丢会丢掉最后一次冷却。
 */
export async function loadModelCooldowns(now = Date.now()): Promise<CooldownEntry[]> {
  if (!modelCooldownPersistenceEnabled()) return [];
  const merged = new Map<string, CooldownEntry>();
  const coll = await getColl();
  if (coll) {
    try {
      const docs = await coll.find({ until: { $gt: now } }).limit(500).toArray();
      for (const doc of docs) {
        const entry = doc as unknown as CooldownEntry;
        if (entry.modelId && entry.until > now) merged.set(entry.modelId, entry);
      }
    } catch (err) {
      console.warn(`[model-cooldown] 读取失败（回落内存副本）：${String((err as Error)?.message || err)}`);
    }
  }
  for (const entry of memory.values()) {
    if (entry.until <= now) continue;
    const prev = merged.get(entry.modelId);
    if (!prev || entry.until > prev.until) merged.set(entry.modelId, entry);
  }
  return [...merged.values()];
}

/**
 * 记一次冷却（best-effort）：内存副本**始终**写（进程内短路优先），Mongo 失败只告警——
 * 冷却是优化不是正确性依赖，绝不能因为它把对话打断。
 */
export async function persistModelCooldown(entry: CooldownEntry): Promise<boolean> {
  memory.set(entry.modelId, entry);
  const coll = await getColl();
  if (!coll) return true; // 内存降级路径算「写成功」：进程内照旧生效
  try {
    await coll.updateOne(
      { _id: entry.modelId } as never,
      {
        $set: {
          modelId: entry.modelId,
          until: entry.until,
          ...(entry.status ? { status: entry.status } : {}),
          at: entry.at,
          // TTL 依据：到期即删（Mongo TTL 索引 expireAfterSeconds=0）。
          expiresAt: new Date(entry.until),
        },
      } as never,
      { upsert: true },
    );
    return true;
  } catch (err) {
    console.warn(`[model-cooldown] 落库失败（不影响本轮，重启后需重打）：${String((err as Error)?.message || err)}`);
    return false;
  }
}
