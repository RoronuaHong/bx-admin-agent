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

/** 投递触发条件：只列「要推的状态」，未列的一律不推（跳过永远不推）。 */
export type ScheduleNotifyOn = "success" | "failed";

export interface ChatSchedule {
  id: string;
  /**
   * 结果回投的对话：默认是**任务专属**的那种（`ownConversation`）。
   * 历史形态是「绑到建任务时正打开的那个对话」，于是每期结果都灌进用户自己的聊天里（周期任务 = 反复刷屏），
   * 现已改为专属对话；老数据由启动维护一次性迁移（见 app.ts 的 migrateTaskConversations）。
   */
  conversationId: string;
  /** 该对话由本任务创建、结果只回到这里。缺省 = 老数据（待迁移）。 */
  ownConversation?: boolean;
  ownerKey: string;
  /** 任务名（列表展示与消息标题；缺省回落到 prompt 截断）。 */
  name?: string;
  /** 触发时发给对话的提示词。 */
  prompt: string;
  /** 周期任务的 5 段 cron 表达式（croner 语法）。与 onceAt 二选一。 */
  cron?: string;
  /** 一次性任务的目标时刻（毫秒）。设置后只跑一次，跑完自动停用（不再按 cron 推进下次）。 */
  onceAt?: number;
  /**
   * 任务级外部工具允许清单（MCP 服务器 id）。语义是**只能收窄**：
   * 运行时取「对话启用集 ∩ 本清单」，任务不会放开对话里没勾的服务器。
   * 无人值守场景的通行最小权限做法：任务只带它真正需要的数据源。缺省 = 跟随对话启用集。
   */
  mcpServers?: string[];

  /** 投递触发条件；缺省 success + failed，跳过不投。 */
  notifyOn?: ScheduleNotifyOn[];
  /** 投递文案语言（建任务时由前端写入；缺省中文）。 */
  locale?: string;
  /** 最近一次投递结果（前端显示「上次推送」用；不含任何凭据）。 */
  lastDelivery?: { at: number; ok: boolean; sent: number; error?: string };
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastStatus?: "success" | "failed" | "cancelled" | "skipped" | "error";
  nextRunAt?: number;
  /** 最近一次触发的说明（跳过原因 / 错误信息）。 */
  lastNote?: string;
  /**
   * 因对话被占用而**开始排队等待**的时刻（由调度器回写；前端不可改）。
   * 补跑窗口必须按它计时，而不是按「到点时刻」：同刻的多个任务会被串行 tick 依次执行，
   * 用到点时刻计时会把「被前面任务挤后」的时间也算成等待，凭空判成「已错过」。
   */
  queuedSince?: number;
}

const MAX_SCHEDULES_PER_OWNER = 20;
const MAX_PROMPT_LEN = 2000;
const MAX_NAME_LEN = 60;
/** 调度扫描间隔：既是 startScheduleLoop 的默认值，也是「补跑窗口」判定的步长。 */
const SCHEDULE_TICK_MS = 30_000;
/**
 * 到点但对话正忙时的最长排队等待（默认 10 分钟，SCHEDULE_SKIP_RETRY_MINUTES 可配）：
 * 窗口内每 tick 重试补跑（等价排队，不丢这一期报告）；超窗才如实记为「已错过」并推进到下一周期。
 */
const SKIP_RETRY_GRACE_MS = Math.max(1, Number(process.env.SCHEDULE_SKIP_RETRY_MINUTES) || 10) * 60_000;

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

/** 日程的下次触发时刻：一次性任务认目标时刻；周期任务按 cron 算。 */
export function nextRunAtOf(
  schedule: Pick<ChatSchedule, "cron" | "onceAt">,
  after = new Date(),
): number | undefined {
  if (schedule.onceAt !== undefined) return schedule.onceAt;
  return schedule.cron ? nextRunOf(schedule.cron, after) : undefined;
}

/** 时间参数校验：周期任务给 cron，一次性任务给 onceAt；返回错误文案或 null。 */
export function validateTiming(input: { cron?: unknown; onceAt?: unknown }): string | null {
  const raw = input.onceAt;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    const at = Number(raw);
    if (!Number.isFinite(at) || at <= 0) return "onceAt 必须为正的毫秒时间戳";
    return null;
  }
  const cron = typeof input.cron === "string" ? input.cron : "";
  if (!cron.trim()) return "cron（周期任务）与 onceAt（一次性任务）必须提供其一";
  return validateCron(cron);
}

function cleanName(name?: unknown): string | undefined {
  const text = typeof name === "string" ? name.trim() : "";
  return text ? text.slice(0, MAX_NAME_LEN) : undefined;
}

export async function createSchedule(input: {
  conversationId: string;
  /** 该对话是本任务专属（由调用方创建）；缺省按「调用方自己的对话」处理。 */
  ownConversation?: boolean;
  ownerKey: string;
  prompt: string;
  cron?: string;
  onceAt?: number;
  name?: string;
  mcpServers?: string[];
  notifyOn?: ScheduleNotifyOn[];
  locale?: string;
}): Promise<ChatSchedule> {
  const now = Date.now();
  const name = cleanName(input.name);
  const schedule: ChatSchedule = {
    id: `sched_${randomUUID().slice(0, 12)}`,
    conversationId: input.conversationId,
    ...(input.ownConversation ? { ownConversation: true } : {}),
    ownerKey: input.ownerKey,
    ...(name ? { name } : {}),
    prompt: input.prompt.slice(0, MAX_PROMPT_LEN),
    ...(input.onceAt !== undefined
      ? { onceAt: Number(input.onceAt) }
      : { cron: String(input.cron || "").trim() }),
    ...(input.mcpServers?.length ? { mcpServers: [...new Set(input.mcpServers)] } : {}),
    ...(input.notifyOn?.length ? { notifyOn: [...new Set(input.notifyOn)] } : {}),
    ...(input.locale ? { locale: input.locale } : {}),
    enabled: true,
    createdAt: now,
  };
  schedule.nextRunAt = nextRunAtOf(schedule);
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

export interface SchedulePatch {
  name?: string;
  prompt?: string;
  cron?: string;
  onceAt?: number;
  enabled?: boolean;
  mcpServers?: string[];
  notifyOn?: ScheduleNotifyOn[];
  /** 重新绑定结果回投对话（迁移到专属对话 / 专属对话被删后重建时用）。 */
  conversationId?: string;
  /** 标记该对话为任务专属。 */
  ownConversation?: boolean;
  /** 本次投递结果（调度器回写用；前端不可改）。 */
  lastDelivery?: ChatSchedule["lastDelivery"];
  /** 显式覆盖下次触发时刻（运维 / 测试用）。 */
  nextRunAt?: number;
}

export async function patchSchedule(
  id: string,
  ownerKey: string,
  patch: SchedulePatch,
): Promise<ChatSchedule | null> {
  const prev = await getSchedule(id);
  if (!prev || prev.ownerKey !== ownerKey) return null;
  const name = patch.name !== undefined ? cleanName(patch.name) : undefined;
  // cron 与 onceAt 互斥：换哪一种就把另一种清掉，避免「既按 cron 推进又按目标时刻触发」的歧义。
  const switchingToOnce = patch.onceAt !== undefined;
  const switchingToCron = patch.cron !== undefined;
  const next: ChatSchedule = {
    ...prev,
    ...(patch.name !== undefined ? { name } : {}),
    ...(patch.prompt !== undefined ? { prompt: patch.prompt.slice(0, MAX_PROMPT_LEN) } : {}),
    ...(switchingToOnce ? { onceAt: Number(patch.onceAt) } : {}),
    ...(switchingToCron ? { cron: String(patch.cron).trim() } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.mcpServers !== undefined ? { mcpServers: [...new Set(patch.mcpServers)] } : {}),
    ...(patch.notifyOn !== undefined ? { notifyOn: [...new Set(patch.notifyOn)] } : {}),
    ...(patch.conversationId ? { conversationId: patch.conversationId } : {}),
    ...(patch.ownConversation !== undefined ? { ownConversation: patch.ownConversation } : {}),
    ...(patch.lastDelivery !== undefined ? { lastDelivery: patch.lastDelivery } : {}),
    ...(patch.nextRunAt !== undefined ? { nextRunAt: patch.nextRunAt } : {}),
  };
  if (switchingToOnce) delete next.cron;
  if (switchingToCron) delete next.onceAt;
  // 时间 / 启停变更 → 重新计算下次触发（显式 nextRunAt 覆盖优先）。
  if (patch.nextRunAt === undefined && (switchingToOnce || switchingToCron || patch.enabled !== undefined)) {
    next.nextRunAt = next.enabled ? nextRunAtOf(next) : undefined;
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

/** 落库（Mongo 失败降级内存）：`nextRunAt` 为空时用 $unset 真删掉——
 *  `$set: null` 会留下一个含糊的 null 值，后续按 `nextRunAt === undefined` 判定的分支都会看错。 */
async function writeSchedule(next: ChatSchedule): Promise<void> {
  const doc = { ...(next as ChatSchedule & { _id?: unknown }) };
  delete doc._id;
  const coll = await getColl();
  if (!coll) {
    memory.set(doc.id, doc);
    return;
  }
  const { nextRunAt, queuedSince, ...rest } = doc;
  // 这两个字段「不存在」有语义（未排下次 / 未在排队）：有值就 $set，缺值就 $unset 真删。
  // 注意 $set 的载荷必须**按值重新组装**——直接用 rest 会把 nextRunAt 一起漏掉。
  const set: Record<string, unknown> = { ...rest };
  const unset: Record<string, ""> = {};
  if (nextRunAt === undefined) unset.nextRunAt = "";
  else set.nextRunAt = nextRunAt;
  if (queuedSince === undefined) unset.queuedSince = "";
  else set.queuedSince = queuedSince;
  await coll.updateOne(
    { id: doc.id },
    Object.keys(unset).length ? { $set: set, $unset: unset } : { $set: set },
  );
}

/**
 * 调度 tick（由 index.ts 定时驱动；测试可直接调用）：
 * 找出所有「已启用且到点」的日程，逐个触发 runner；触发与推进之间是同步的，防同一日程并发重复跑。
 *
 * 到点但对话正忙（runner 返回 skipped）时**不推进 nextRunAt**，让下一 tick 继续补跑（等价排队）——
 * 整点直接空过等于丢掉这一期的报告。等待超过 SKIP_RETRY_GRACE_MS 才如实记为「已错过」并推进到下一周期。
 */
export async function schedulerTick(
  runner: (schedule: ChatSchedule) => Promise<"success" | "failed" | "cancelled" | "skipped" | "error">,
  now = Date.now(),
): Promise<number> {
  const all = await listSchedules();
  let triggered = 0;
  for (const schedule of all) {
    if (!schedule.enabled) continue;
    const fallback = new Date(now - 60_000);
    const due = schedule.onceAt ?? schedule.nextRunAt ?? nextRunAtOf(schedule, fallback);
    if (due === undefined || due > now) continue;
    triggered += 1;
    let outcome: "success" | "failed" | "cancelled" | "skipped" | "error" = "skipped";
    let note = "";
    try {
      outcome = await runner(schedule);
      if (outcome === "skipped") {
        const queuedSince = schedule.queuedSince ?? now;
        if (now - queuedSince + SCHEDULE_TICK_MS <= SKIP_RETRY_GRACE_MS) {
          // 钉住本次到点时刻（不能用 now 重算，否则窗口内会被推到下一周期，这期就真丢了）：
          // 下一 tick 发现仍然到点，继续尝试补跑。
          await writeSchedule({
            ...schedule,
            nextRunAt: due,
            queuedSince,
            lastStatus: outcome,
            lastNote: `对话正在生成中，已排队等待补跑（已等待 ${Math.round(
              (now - queuedSince) / 60_000,
            )} 分钟，上限 ${SKIP_RETRY_GRACE_MS / 60_000} 分钟）`,
          });
          continue;
        }
        note = `对话持续占用，本次已错过（等待超过 ${SKIP_RETRY_GRACE_MS / 60_000} 分钟）`;
      }
    } catch (err) {
      outcome = "error";
      note = String((err as Error)?.message || err).slice(0, 200);
    }
    const updated: ChatSchedule = {
      ...schedule,
      lastRunAt: now,
      lastStatus: outcome,
      // 跑成的那一轮 note 为空也要写回：否则上一次的「跳过」说明会一直挂着，看着像这次也被跳过了。
      lastNote: note,
    };
    // 不再排队：清掉排队起点（下一期重新计时），writeSchedule 会把它从库里真删掉。
    delete updated.queuedSince;
    // 一次性任务跑完即停用：不能按 cron 推进（那会推到明年同一分钟）。
    if (schedule.onceAt !== undefined) {
      updated.enabled = false;
      delete updated.nextRunAt;
    } else {
      updated.nextRunAt = nextRunOf(schedule.cron || "", new Date(now + 1000));
    }
    await writeSchedule(updated);
  }
  return triggered;
}

/** 启动周期调度扫描（默认 30s tick；定时器 unref 不阻止进程退出）。 */
export function startScheduleLoop(
  runner: (schedule: ChatSchedule) => Promise<"success" | "failed" | "cancelled" | "skipped" | "error">,
  intervalMs = SCHEDULE_TICK_MS,
): NodeJS.Timeout {
  // 上一次 tick 还没结束（长任务会跨好几个 tick）→ 本轮直接跳过。
  // 否则并发 tick 各自读到同一份 nextRunAt 并回写，会把「已推进到下一周期」又改回本次的到点时刻，
  // 变成同一期重复触发（补跑逻辑上线后这个竞态就致命了）。
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void schedulerTick(runner)
      .catch((err) => console.warn(`[scheduler] tick 失败：${String((err as Error)?.message || err)}`))
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  timer.unref();
  return timer;
}
