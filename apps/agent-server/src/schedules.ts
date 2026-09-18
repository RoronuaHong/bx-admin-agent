// 定时任务（agent-infrastructure §8：在异步任务底座上加调度器）。
// 存储走 Mongo（失败降级内存）；调度职责只做「到点了吗 → 触发 → 推进 nextRunAt」，
// 真正执行复用对话任务的底座（startTask / consumeTask / 结果回投），不另起一套执行器。
// 定时运行没有 HTTP 订阅者 → 收束后自动走「结果回投」落进对话消息快照，用户回来就能看到。
import { Cron } from "croner";
import { MongoClient, type Collection, type Db } from "mongodb";
import { randomUUID } from "node:crypto";

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const MONGO_DB = process.env.MONGO_DB_NAME || "bx_agent";
const COLL = "chat_schedules";

export interface ChatSchedule {
  id: string;
  conversationId: string;
  ownerKey: string;
  /** 触发时发给对话的提示词。 */
  prompt: string;
  /** 5 段 cron 表达式（croner 语法）。 */
  cron: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastStatus?: "success" | "failed" | "cancelled" | "skipped" | "error";
  nextRunAt?: number;
  /** 最近一次触发的说明（跳过原因 / 错误信息）。 */
  lastNote?: string;
}

const MAX_SCHEDULES_PER_OWNER = 20;
const MAX_PROMPT_LEN = 2000;

// ---- Mongo 单例（独立小集合；失败降级内存，与 conversations 同策略）----
let clientPromise: Promise<MongoClient> | null = null;
async function getColl(): Promise<Collection<ChatSchedule> | null> {
  try {
    if (!clientPromise) {
      clientPromise = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 3000 }).connect();
    }
    const client = await clientPromise;
    const db: Db = client.db(MONGO_DB);
    return db.collection<ChatSchedule>(COLL);
  } catch {
    clientPromise = null;
    return null;
  }
}
const memory = new Map<string, ChatSchedule>();

export function validateCron(expr: string): string | null {
  try {
    // 5 段（分 时 日 月 周）；6 段（带秒）不是本项目的约定，拒绝。
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return "cron 必须为 5 段表达式（分 时 日 月 周）";
    new Cron(expr.trim());
    return null;
  } catch (err) {
    return `非法 cron 表达式：${String((err as Error)?.message || err)}`;
  }
}

export function nextRunOf(expr: string, after = new Date()): number | undefined {
  try {
    return new Cron(expr).nextRun(after)?.getTime();
  } catch {
    return undefined;
  }
}

export async function createSchedule(input: {
  conversationId: string;
  ownerKey: string;
  prompt: string;
  cron: string;
}): Promise<ChatSchedule> {
  const now = Date.now();
  const schedule: ChatSchedule = {
    id: `sched_${randomUUID().slice(0, 12)}`,
    conversationId: input.conversationId,
    ownerKey: input.ownerKey,
    prompt: input.prompt.slice(0, MAX_PROMPT_LEN),
    cron: input.cron.trim(),
    enabled: true,
    createdAt: now,
    nextRunAt: nextRunOf(input.cron),
  };
  const coll = await getColl();
  if (!coll) {
    memory.set(schedule.id, schedule);
    return schedule;
  }
  await coll.insertOne(schedule);
  return schedule;
}

export async function listSchedules(ownerKey?: string): Promise<ChatSchedule[]> {
  const coll = await getColl();
  const list = coll
    ? await coll.find({}).toArray()
    : [...memory.values()];
  return list
    .filter((s) => !ownerKey || s.ownerKey === ownerKey)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getSchedule(id: string): Promise<ChatSchedule | null> {
  const coll = await getColl();
  if (!coll) return memory.get(id) || null;
  return (await coll.findOne({ id })) || null;
}

export async function patchSchedule(
  id: string,
  ownerKey: string,
  patch: { prompt?: string; cron?: string; enabled?: boolean; nextRunAt?: number },
): Promise<ChatSchedule | null> {
  const prev = await getSchedule(id);
  if (!prev || prev.ownerKey !== ownerKey) return null;
  const next: ChatSchedule = {
    ...prev,
    ...(patch.prompt !== undefined ? { prompt: patch.prompt.slice(0, MAX_PROMPT_LEN) } : {}),
    ...(patch.cron !== undefined ? { cron: patch.cron.trim() } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.nextRunAt !== undefined ? { nextRunAt: patch.nextRunAt } : {}),
  };
  // cron / enabled 变更 → 重新计算下次触发时间（显式 nextRunAt 覆盖优先，运维/测试用）。
  if (patch.nextRunAt === undefined && (patch.cron !== undefined || patch.enabled !== undefined)) {
    next.nextRunAt = next.enabled ? nextRunOf(next.cron) : undefined;
  }
  const coll = await getColl();
  if (!coll) {
    memory.set(id, next);
    return next;
  }
  await coll.updateOne({ id }, { $set: next });
  return next;
}

export async function deleteSchedule(id: string, ownerKey: string): Promise<boolean> {
  const prev = await getSchedule(id);
  if (!prev || prev.ownerKey !== ownerKey) return false;
  const coll = await getColl();
  if (!coll) {
    memory.delete(id);
    return true;
  }
  await coll.deleteOne({ id });
  return true;
}

export async function countSchedulesOf(ownerKey: string): Promise<number> {
  return (await listSchedules(ownerKey)).length;
}
export { MAX_SCHEDULES_PER_OWNER };

/**
 * 调度 tick（由 index.ts 定时驱动；测试可直接调用）：
 * 找出所有「已启用且到点」的日程，逐个触发 runner；触发与推进之间是同步的，防同一日程并发重复跑。
 */
export async function schedulerTick(
  runner: (schedule: ChatSchedule) => Promise<"success" | "failed" | "cancelled" | "skipped" | "error">,
  now = Date.now(),
): Promise<number> {
  const all = await listSchedules();
  let triggered = 0;
  for (const schedule of all) {
    if (!schedule.enabled) continue;
    const due = schedule.nextRunAt === undefined ? nextRunOf(schedule.cron, new Date(now - 60_000)) : schedule.nextRunAt;
    if (due === undefined || due > now) continue;
    triggered += 1;
    let outcome: "success" | "failed" | "cancelled" | "skipped" | "error" = "skipped";
    let note = "";
    try {
      outcome = await runner(schedule);
      if (outcome === "skipped") note = "对话正在生成中，本次跳过";
    } catch (err) {
      outcome = "error";
      note = String((err as Error)?.message || err).slice(0, 200);
    }
    const updated: ChatSchedule = {
      ...schedule,
      lastRunAt: now,
      lastStatus: outcome,
      ...(note ? { lastNote: note } : {}),
      nextRunAt: nextRunOf(schedule.cron, new Date(now + 1000)),
    };
    const coll = await getColl();
    if (!coll) memory.set(schedule.id, updated);
    else await coll.updateOne({ id: schedule.id }, { $set: updated });
  }
  return triggered;
}

/** 启动周期调度扫描（30s tick；定时器 unref 不阻止进程退出）。 */
export function startScheduleLoop(
  runner: (schedule: ChatSchedule) => Promise<"success" | "failed" | "cancelled" | "skipped" | "error">,
  intervalMs = 30_000,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void schedulerTick(runner).catch((err) =>
      console.warn(`[scheduler] tick 失败：${String((err as Error)?.message || err)}`),
    );
  }, intervalMs);
  timer.unref();
  return timer;
}
