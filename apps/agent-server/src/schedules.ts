// 定时任务（agent-infrastructure §8：在异步任务底座上加调度器）。
// 存储走 Mongo（失败降级内存）；调度职责只做「到点了吗 → 触发 → 推进 nextRunAt」，
// 真正执行复用对话任务的底座（startTask / consumeTask / 结果回投），不另起一套执行器。
// 定时运行没有 HTTP 订阅者 → 收束后自动走「结果回投」落进对话消息快照，用户回来就能看到。
import { Cron } from "croner";
import { type Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { getMongoClient, MONGO_DB_NAME } from "./db.js";
import {
  alertNextRunAt,
  type AlertMarker,
  type ScheduleAlertState,
  type ScheduleNotifyPolicy,
  type SchedulePurpose,
} from "./schedule-alert.js";

const COLL = "chat_schedules";

/** 投递触发条件：只列「要推的状态」，未列的一律不推（跳过永远不推）。 */
export type ScheduleNotifyOn = "success" | "failed";

/**
 * 每期结果的落点（docs/scheduled-task-sessions-plan.md §3.1，对齐 ChatGPT standalone / in-chat 两种任务）：
 * - "new"（缺省）：每期开一个新会话——各期独立、可单独回溯与对比（日报 / 监控 / 周期报告）；
 * - "same"：每期回投同一个会话、沿用上下文（盯一件事直到它完成）。
 */
export type ScheduleRunMode = "new" | "same";

export type ScheduleRunStatus = "success" | "failed" | "cancelled" | "skipped" | "error";

/** 一期的运行记录（新的在前）。 */
export interface ScheduleRun {
  /** 该期结果所在的会话。 */
  conversationId: string;
  /** 该期的运行时刻。 */
  at: number;
  /** 该期的真实结果（与 lastStatus 同一口径）。 */
  status?: ScheduleRunStatus;
  /** 预警任务结论文本首行标记（SPIKE / NORMAL / NO_DATA）；报告型任务通常没有。 */
  marker?: AlertMarker;
  /** 定时触发 / 手动执行 / 事件唤醒。老记录没有这个字段。 */
  trigger?: "schedule" | "manual" | "wake";
  /** 从开跑到收尾的毫秒数。 */
  durationMs?: number;
}

export interface ChatSchedule {
  id: string;
  /**
   * 结果回投的对话：默认是**任务专属**的那种（`ownConversation`）。
   * 历史形态是「绑到建任务时正打开的那个对话」，于是每期结果都灌进用户自己的聊天里（周期任务 = 反复刷屏），
   * 现已改为专属对话；老数据由启动维护一次性迁移（见 app.ts 的 migrateTaskConversations）。
   * `runMode:"new"` 时语义收窄为「**最近一期**的会话」（IM 投递链接与任务卡片「打开对话」都指向最新一期）。
   */
  conversationId: string;
  /** 每期结果的落点；缺省 "new"（每期新会话）。 */
  runMode?: ScheduleRunMode;
  /** 各期运行记录（新的在前，受 MAX_RUNS_PER_SCHEDULE 限制）。 */
  runs?: ScheduleRun[];
  /** 未读的期数：每期结束 +1，用户打开任一期会话后清零（对齐 ChatGPT「Scheduled 视图当收件箱」）。 */
  unreadRuns?: number;
  /** 建任务时的 Agent 角色：每期新建会话要继承它，否则新会话退回 generic、与老会话不在同一个入口。 */
  agentId?: string;
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

  /**
   * 任务级技能勾选（技能目录名，落库前经服务端按清单过滤）：
   * 写到任务专属对话与每期运行会话的 skillsEnabled 上，随当期运行注入系统提示。
   * 缺省 = 不额外勾选（default: true 的技能本来就随索引生效，无需勾选）。
   */
  skills?: string[];

  /** 投递触发条件；缺省 success + failed，跳过不投。 */
  notifyOn?: ScheduleNotifyOn[];
  /**
   * 通知策略（docs/scheduled-spike-detection-plan.md）：
   * - "always"（缺省）：成功/失败都推（报告型）；
   * - "on_alert"：失败仍推；成功则只在结论首行 [SPIKE]（及恢复）时推。
   */
  notifyPolicy?: ScheduleNotifyPolicy;
  /**
   * 任务用途：表单「周期报告 / 数据预警」；引擎以 notifyPolicy 为准，purpose 便于列表展示与回填。
   */
  purpose?: SchedulePurpose;
  /** 预警是否仍在告警中，以及恢复计数（调度器回写；前端不可改）。 */
  alertState?: ScheduleAlertState;
  /** 最近一期预警结论标记（调度器回写；侧栏健康态用；报告型任务通常没有）。 */
  lastMarker?: AlertMarker;
  /** 投递文案语言（建任务时由前端写入；缺省中文）。 */
  locale?: string;
  /** 建任务时从来源对话带上的 IANA 时区。每期运行的小时分桶用它。 */
  timeZone?: string;
  /** 最近一次投递结果（前端显示「上次推送」用；不含任何凭据）。 */
  lastDelivery?: { at: number; ok: boolean; sent: number; error?: string };
  /**
   * 预警启动确认已发出的时刻。空 = 启用后还没发过。
   * 暂停或重新启用会清掉，下一期（立即执行或到点）再发一条，不论是否破线。
   */
  armedNotifiedAt?: number;
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
  /**
   * 立即执行 / 事件唤醒：有值且已到点时，即使任务暂停、或 nextRunAt 还在未来，也会多跑一期。
   * 跑完即清。只由运行入口写入，前端 PATCH 改不了。
   */
  runRequestedAt?: number;
  /** 立即执行前记下的原 nextRunAt。跑完若仍在未来则还原，避免把原定周期推走。 */
  holdNextRunAt?: number;
  /** 事件唤醒说明：只加在这一期的用户消息前面，跑完即清。 */
  wakeReason?: string;
}

/**
 * 名称或任务内容几乎全是问号 / 替换符时返回原因。
 * 正常中文、英文、数字返回 null。用来拦住已经损坏的任务名，避免再推成「??????」。
 */
export function garbledTextReason(text: string | undefined): string | null {
  const compact = String(text ?? "").replace(/\s/g, "");
  if (!compact) return null;
  const marks = (compact.match(/[?？\uFFFD]/g) || []).length;
  if (marks < 3) return null;
  const rest = compact.replace(/[?？\uFFFD.,，。、;；:：!！'"“”‘’\-_\/\\|()[\]{}]/g, "");
  if (rest.length === 0 || marks / compact.length >= 0.8) return "几乎全是问号，无法保存";
  return null;
}

const MAX_SCHEDULES_PER_OWNER = 20;
const MAX_PROMPT_LEN = 2000;
const MAX_NAME_LEN = 60;
/**
 * 每任务保留的运行期数（`SCHEDULE_MAX_RUNS` 可配）。
 * 超上限只把最旧的会话**归档**，不删除——静默删用户数据是这类系统里最坏的一类行为，
 * 归档后仍可从「显示归档」找回（docs/scheduled-task-sessions-plan.md §3.4）。
 */
export const MAX_RUNS_PER_SCHEDULE = Math.max(1, Number(process.env.SCHEDULE_MAX_RUNS) || 50);
/** 调度扫描间隔：既是 startScheduleLoop 的默认值，也是「补跑窗口」判定的步长。 */
const SCHEDULE_TICK_MS = 30_000;
/**
 * 到点但对话正忙时的最长排队等待（默认 10 分钟，SCHEDULE_SKIP_RETRY_MINUTES 可配）：
 * 窗口内每 tick 重试补跑（等价排队，不丢这一期报告）；超窗才如实记为「已错过」并推进到下一周期。
 */
const SKIP_RETRY_GRACE_MS = Math.max(1, Number(process.env.SCHEDULE_SKIP_RETRY_MINUTES) || 10) * 60_000;

// ---- Mongo 连接（单例见 ./db.ts；失败降级内存，与 conversations 同策略）----
async function getColl(): Promise<Collection<ChatSchedule> | null> {
  try {
    const client = await getMongoClient();
    const db = client.db(MONGO_DB_NAME);
    return db.collection<ChatSchedule>(COLL);
  } catch {
    return null;
  }
}
// ---- 跨实例分布式锁（agent-infrastructure §8「跨进程任务队列」最小必要补齐）----
// 多实例部署下，每个进程都跑 startScheduleLoop；同一日程若被多个进程同时走到「到点」，会重复触发。
// 用 Mongo 单文档锁（findOneAndUpdate upsert + TTL）保证同一时刻只有一个进程执行该日程；
// 抢不到锁的实例直接跳过，交给其它实例或下一 tick。无 Mongo 时退化为单进程原行为（不阻塞）。
const SCHEDULE_LOCK_MS = 30 * 60_000; // 锁最长持有时间：runner 异常崩溃时由 TTL 自动释放，避免死锁
interface ScheduleLockDoc {
  _id: string;
  owner: string;
  expireAt: Date;
  acquiredAt: Date;
}
async function getLockColl(): Promise<Collection<ScheduleLockDoc> | null> {
  const coll = await getColl();
  if (!coll) return null;
  const lock = coll.db.collection<ScheduleLockDoc>("schedule_locks");
  await lock.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }).catch((e) => {
    console.warn(`[schedules] 调度锁 TTL 索引创建失败，锁可能不自动释放导致死锁：${String((e as Error)?.message || e)}`);
  });
  return lock;
}
async function tryAcquireScheduleLock(id: string, owner: string): Promise<boolean> {
  const lock = await getLockColl();
  if (!lock) return true; // 无 Mongo：退化为单进程原行为
  const now = Date.now();
  try {
    // 仅当「锁不存在 / 属于自己 / 已过期」时才获取成功；并发插入冲突由 catch 吞掉（视为失败）。
    const res = await lock.findOneAndUpdate(
      { _id: id, $or: [{ owner }, { expireAt: { $lt: new Date(now) } }] },
      { $set: { owner, expireAt: new Date(now + SCHEDULE_LOCK_MS), acquiredAt: new Date(now) } },
      { upsert: true, returnDocument: "after" },
    );
    return !!res && (res as { owner?: string }).owner === owner;
  } catch {
    return false;
  }
}
/** 锁的 owner 形如 `主机名-pid-随机串`。认不出本机 pid 时返回 null（别的机器的锁不动）。 */
export function scheduleLockPid(owner: string, host = hostname()): number | null {
  const prefix = `${host}-`;
  if (!owner.startsWith(prefix)) return null;
  const pid = Number(owner.slice(prefix.length).split("-")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** pid 还在就返回 true。EPERM 表示进程在、只是没权限发信号，不能当成已死。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 进程被重启或杀掉时，调度锁要等 30 分钟 TTL 才过期，这期间到点的任务会一直被静默跳过。
 * 启动时清掉「owner 是本机、但那个 pid 已经不在」的锁。
 */
export async function releaseDeadScheduleLocks(): Promise<number> {
  const lock = await getLockColl();
  if (!lock) return 0;
  const docs = await lock.find({}).toArray();
  let released = 0;
  for (const doc of docs) {
    const pid = scheduleLockPid(String(doc.owner || ""));
    if (pid === null || pid === process.pid || isProcessAlive(pid)) continue;
    const gone = await lock.deleteOne({ _id: doc._id, owner: doc.owner });
    if (gone.deletedCount) released += 1;
  }
  if (released) console.warn(`[scheduler] 已释放 ${released} 把失效调度锁（原进程已退出）`);
  return released;
}

async function releaseScheduleLock(id: string, owner: string): Promise<void> {
  const lock = await getLockColl();
  if (!lock) return;
  await lock.deleteOne({ _id: id, owner }).catch((e) => {
    console.warn(`[schedules] 调度锁释放失败，需等 TTL 自动过期：${String((e as Error)?.message || e)}`);
  });
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

/** 周期任务相邻两次触发的最小间隔：短于 1 分钟会打成风暴（单期 Agent 常要数十秒）。 */
export const MIN_CRON_INTERVAL_MS = 60_000;

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
  const cronErr = validateCron(cron);
  if (cronErr) return cronErr;
  // 最小间隔：用两次 nextRun 差值卡住 */1 这类风暴表达式（croner 原生支持秒级步进）。
  const first = nextRunOf(cron.trim());
  if (first === undefined) return "非法 cron 表达式：无法计算下次触发";
  const second = nextRunOf(cron.trim(), new Date(first));
  if (second !== undefined && second - first < MIN_CRON_INTERVAL_MS) {
    return "周期间隔不能短于 1 分钟";
  }
  return null;
}

function cleanName(name?: unknown): string | undefined {
  const text = typeof name === "string" ? name.trim() : "";
  return text ? text.slice(0, MAX_NAME_LEN) : undefined;
}

/**
 * 追加一期运行记录（新的在前）并截断到上限。
 * 被截掉的那几期只从本任务的历史里移除，会话本身由调用方决定是否归档（绝不在这里删）。
 */
export function prependRun(runs: ScheduleRun[] | undefined, run: ScheduleRun): ScheduleRun[] {
  const next = [run, ...(runs || []).filter((r) => r.conversationId !== run.conversationId)];
  return next.slice(0, MAX_RUNS_PER_SCHEDULE);
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
  /** 任务级技能勾选（调用方已过滤；存储层只去重）。 */
  skills?: string[];
  notifyOn?: ScheduleNotifyOn[];
  notifyPolicy?: ScheduleNotifyPolicy;
  purpose?: SchedulePurpose;
  locale?: string;
  timeZone?: string;
  /** 每期结果的落点（缺省 "new"）。 */
  runMode?: ScheduleRunMode;
  /** 建任务时的 Agent 角色（每期建会话继承）。 */
  agentId?: string;
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
    ...(input.skills?.length ? { skills: [...new Set(input.skills)] } : {}),
    ...(input.notifyOn?.length ? { notifyOn: [...new Set(input.notifyOn)] } : {}),
    ...(input.notifyPolicy ? { notifyPolicy: input.notifyPolicy } : {}),
    ...(input.purpose ? { purpose: input.purpose } : {}),
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    // 落点**总是显式落库**（缺省写 "new"）：把默认值留在「读的时候补」会让库里出现
    // 「没写 = 新会话」和「写了 = 新会话」两种形态，排查时得多推一层。
    runMode: input.runMode === "same" ? "same" : "new",
    ...(input.agentId ? { agentId: input.agentId } : {}),
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
  skills?: string[];
  notifyOn?: ScheduleNotifyOn[];
  notifyPolicy?: ScheduleNotifyPolicy;
  purpose?: SchedulePurpose;
  /** 预警状态（调度器回写；前端不可改）。 */
  alertState?: ScheduleAlertState;
  /** 最近一期预警结论标记（调度器回写；前端不可改）。 */
  lastMarker?: AlertMarker;
  /** 每期结果的落点（docs/scheduled-task-sessions-plan.md §3.1）；只影响**此后**的运行。 */
  runMode?: ScheduleRunMode;
  /** 运行记录（调度器回写；前端不可改）。 */
  runs?: ScheduleRun[];
  /** 未读期数：前端打开任一期会话后置 0。 */
  unreadRuns?: number;
  /** Agent 角色（建任务时落库；每期建会话继承）。 */
  agentId?: string;
  /** 重新绑定结果回投对话（迁移到专属对话 / 专属对话被删后重建时用）。 */
  conversationId?: string;
  /** 标记该对话为任务专属。 */
  ownConversation?: boolean;
  /** 本次投递结果（调度器回写用；前端不可改）。 */
  lastDelivery?: ChatSchedule["lastDelivery"];
  /** 启动确认已发出的时刻（调度器回写；暂停 / 重新启用时清掉）。 */
  armedNotifiedAt?: number;
  /** 显式覆盖下次触发时刻（运维 / 测试用）。 */
  nextRunAt?: number;
}

/**
 * 会话被删除时，把任务运行记录里指向它的条目清掉（一致性修复）：
 * 之前只删会话不动 runs[]，侧栏任务组会留下「幽灵运行记录」——点了才提示会话已不存在。
 * unreadRuns 按被删条数同步下调（下限 0）：用户主动删结果 = 已读过/不要了，角标不该继续指向不存在的期。
 * schedule.conversationId 不动：它指向的会话删了会由下一次运行自动重建（前端已有对应提示文案）。
 */
export async function pruneRunsOfConversation(ownerKey: string, conversationId: string): Promise<number> {
  if (!conversationId) return 0;
  let removed = 0;
  for (const s of await listSchedules(ownerKey)) {
    const runs = s.runs || [];
    const kept = runs.filter((r) => r.conversationId !== conversationId);
    if (kept.length === runs.length) continue;
    const gone = runs.length - kept.length;
    removed += gone;
    await patchSchedule(s.id, ownerKey, {
      runs: kept,
      unreadRuns: Math.max(0, (s.unreadRuns || 0) - gone),
    });
  }
  return removed;
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
    ...(patch.skills !== undefined ? { skills: [...new Set(patch.skills)] } : {}),
    ...(patch.notifyOn !== undefined ? { notifyOn: [...new Set(patch.notifyOn)] } : {}),
    ...(patch.notifyPolicy !== undefined ? { notifyPolicy: patch.notifyPolicy } : {}),
    ...(patch.purpose !== undefined ? { purpose: patch.purpose } : {}),
    ...(patch.alertState !== undefined ? { alertState: patch.alertState } : {}),
    ...(patch.lastMarker !== undefined ? { lastMarker: patch.lastMarker } : {}),
    ...(patch.runMode !== undefined ? { runMode: patch.runMode } : {}),
    ...(patch.runs !== undefined ? { runs: patch.runs.slice(0, MAX_RUNS_PER_SCHEDULE) } : {}),
    ...(patch.unreadRuns !== undefined ? { unreadRuns: Math.max(0, Math.floor(patch.unreadRuns)) } : {}),
    ...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
    ...(patch.conversationId ? { conversationId: patch.conversationId } : {}),
    ...(patch.ownConversation !== undefined ? { ownConversation: patch.ownConversation } : {}),
    ...(patch.lastDelivery !== undefined ? { lastDelivery: patch.lastDelivery } : {}),
    ...(patch.armedNotifiedAt !== undefined ? { armedNotifiedAt: patch.armedNotifiedAt } : {}),
    ...(patch.nextRunAt !== undefined ? { nextRunAt: patch.nextRunAt } : {}),
  };
  // 暂停或重新启用：下一期再发启动确认。字段必须从库里删掉，留着会让「第一次」永远不再发生。
  const resetArm =
    patch.enabled === false || (patch.enabled === true && prev.enabled === false);
  if (resetArm) delete next.armedNotifiedAt;
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
  await coll.updateOne(
    { id },
    resetArm ? { $set: next, $unset: { armedNotifiedAt: "" } } : { $set: next },
  );
  return next;
}

// ---- 运行中定时任务的 abort 注册表（进程内；跨实例的最终兜底见 schedulerTick 的「跑完再查一次」）----
// 删除任务时 abort 掉正在跑的那一期：否则它跑完仍会把结果（如 [NO_DATA] 预警）写进对话并投递，
// 表现为「删了还收到预警」。key = schedule.id（同一任务串行，不会并发重入，故不会误覆盖）。
const activeRunAborts = new Map<string, AbortController>();
export function registerActiveScheduleRun(scheduleId: string, controller: AbortController): void {
  activeRunAborts.set(scheduleId, controller);
}
export function unregisterActiveScheduleRun(scheduleId: string): void {
  activeRunAborts.delete(scheduleId);
}
export function abortActiveScheduleRun(scheduleId: string): boolean {
  const c = activeRunAborts.get(scheduleId);
  if (!c) return false;
  c.abort();
  return true;
}

export async function deleteSchedule(id: string, ownerKey: string): Promise<boolean> {
  const prev = await getSchedule(id);
  if (!prev || prev.ownerKey !== ownerKey) return false;
  const coll = await getColl();
  if (!coll) {
    memory.delete(id);
    abortActiveScheduleRun(id);
    return true;
  }
  await coll.deleteOne({ id });
  // 任务可能在删除的这一刻正在跑（尤其多步工具 / 长思考的预警任务）：立刻中断它的运行，
  // 避免它跑完把结果写进对话 + 投递出去 —— 这就是「删了还收到预警」的根因。
  abortActiveScheduleRun(id);
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
  const { nextRunAt, queuedSince, runRequestedAt, holdNextRunAt, wakeReason, armedNotifiedAt, ...rest } = doc;
  // 这些字段「不存在」有语义：有值就 $set，缺值就 $unset 真删。
  // 注意 $set 的载荷必须**按值重新组装**——直接用 rest 会把拆出来的字段一起漏掉。
  const set: Record<string, unknown> = { ...rest };
  const unset: Record<string, ""> = {};
  if (nextRunAt === undefined) unset.nextRunAt = "";
  else set.nextRunAt = nextRunAt;
  if (queuedSince === undefined) unset.queuedSince = "";
  else set.queuedSince = queuedSince;
  if (runRequestedAt === undefined) unset.runRequestedAt = "";
  else set.runRequestedAt = runRequestedAt;
  if (holdNextRunAt === undefined) unset.holdNextRunAt = "";
  else set.holdNextRunAt = holdNextRunAt;
  if (wakeReason === undefined) unset.wakeReason = "";
  else set.wakeReason = wakeReason;
  if (armedNotifiedAt === undefined) unset.armedNotifiedAt = "";
  else set.armedNotifiedAt = armedNotifiedAt;
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
    // 立即执行 / 事件唤醒：多跑一期，不看启用开关，也不等原来的 nextRunAt。
    const manualDue = schedule.runRequestedAt !== undefined && schedule.runRequestedAt <= now;
    if (!schedule.enabled && !manualDue) continue;
    const fallback = new Date(now - 60_000);
    const due = manualDue
      ? schedule.runRequestedAt!
      : (schedule.onceAt ?? schedule.nextRunAt ?? nextRunAtOf(schedule, fallback));
    if (due === undefined || due > now) continue;
    // 跨实例互斥：同一日程同一时刻只由一个进程触发；抢不到锁的交给其它实例或下一 tick。
    const lockOwner = `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    if (!(await tryAcquireScheduleLock(schedule.id, lockOwner))) {
      console.warn(`[scheduler] ${schedule.id} 调度锁被占用，本拍跳过`);
      continue;
    }
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
          // 立即执行排队时，界面上的「下次」仍显示原来的下一拍，不要改成已经过去的请求时刻。
          const keepStanding =
            schedule.runRequestedAt !== undefined &&
            schedule.holdNextRunAt !== undefined &&
            schedule.holdNextRunAt > now;
          await writeSchedule({
            ...schedule,
            nextRunAt: keepStanding ? schedule.holdNextRunAt : due,
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
    } finally {
      await releaseScheduleLock(schedule.id, lockOwner).catch((e) => {
        console.warn(`[schedules] 调度锁释放失败，下一轮调度要等 TTL 过期：${String((e as Error)?.message || e)}`);
      });
    }
    // 写回前**重新读一次**：runner 内部可能已经写入了 runs / unreadRuns / conversationId
    // （「每期新会话」的实现就写在 runner 里）。沿用 runner 执行前的快照整体写回会把这些字段
    // 静默回退——症状是「运行记录偶发丢失」，且只在 schedulerTick 这一侧可见，极难定位。
    const fresh = await getSchedule(schedule.id);
    // 本期里任务已被删掉：不能退回开跑前的快照再写回去，否则「删了又复活、明天继续推」。
    if (!fresh) continue;
    const finishedAt = Date.now();
    // 本期里被暂停：保持暂停，且不要再排下一拍。
    // 若仍用开跑前的 enabled=true 写回，或给暂停任务排上下一拍，它会在下一周期自己跑起来。
    if (fresh.enabled === false) {
      const paused: ChatSchedule = {
        ...fresh,
        lastRunAt: finishedAt,
        lastStatus: outcome,
        lastNote: note,
      };
      delete paused.queuedSince;
      delete paused.nextRunAt;
      delete paused.runRequestedAt;
      delete paused.holdNextRunAt;
      delete paused.wakeReason;
      delete paused.armedNotifiedAt;
      await writeSchedule(paused);
      continue;
    }
    // 用「跑完时刻」推进周期：预警等长跑常跨过多个 cron 拍；若仍按 tick 入口的 `now` 算下一拍，
    // 会得到已经过去的 nextRunAt，下一 tick 立刻连环补跑（实测 */5 + 4 分钟跑会连打）。
    const updated: ChatSchedule = {
      ...fresh,
      lastRunAt: finishedAt,
      lastStatus: outcome,
      // 跑成的那一轮 note 为空也要写回：否则上一次的「跳过」说明会一直挂着，看着像这次也被跳过了。
      lastNote: note,
    };
    // 不再排队：清掉排队起点（下一期重新计时），writeSchedule 会把它从库里真删掉。
    delete updated.queuedSince;
    const wasManual = fresh.runRequestedAt !== undefined || schedule.runRequestedAt !== undefined;
    const held = fresh.holdNextRunAt ?? schedule.holdNextRunAt;
    delete updated.runRequestedAt;
    delete updated.holdNextRunAt;
    delete updated.wakeReason;
    // 一次性任务跑完即停用：不能按 cron 推进（那会推到明年同一分钟）。
    // 立即执行不算「到点的那一次」，未来的一次性时刻还留着。
    if (schedule.onceAt !== undefined && !wasManual) {
      updated.enabled = false;
      delete updated.nextRunAt;
    } else if (wasManual && held !== undefined && held > finishedAt) {
      updated.nextRunAt = held;
    } else {
      const cron = fresh.cron || schedule.cron || "";
      updated.nextRunAt = alertNextRunAt({
        cron,
        finishedAt,
        purpose: fresh.purpose,
        firing: fresh.alertState?.firing === true,
        marker: fresh.lastMarker ?? null,
        cronNext: nextRunOf,
      });
    }
    await writeSchedule(updated);
  }
  return triggered;
}

/**
 * 立即执行 / 事件唤醒：多跑一期，不改原来的 nextRunAt（若仍在未来）。
 * 暂停中的任务也可以跑这一期，跑完仍然暂停。reason 有内容时当作事件唤醒，写进这一期的消息前缀。
 */
export async function requestScheduleRun(
  id: string,
  ownerKey: string,
  reason?: string,
): Promise<ChatSchedule | null> {
  const prev = await getSchedule(id);
  if (!prev || prev.ownerKey !== ownerKey) return null;
  if (prev.runRequestedAt !== undefined) return prev;
  const wake = String(reason || "").trim().slice(0, 200);
  const now = Date.now();
  const next: ChatSchedule = {
    ...prev,
    runRequestedAt: now,
    ...(prev.nextRunAt !== undefined && prev.nextRunAt > now ? { holdNextRunAt: prev.nextRunAt } : {}),
    ...(wake ? { wakeReason: wake } : {}),
  };
  await writeSchedule(next);
  return next;
}

/** 调度循环的「马上再扫一次」。没启动循环时是空操作（测试直接调 schedulerTick）。 */
let kickSchedule: (() => void) | null = null;
export function kickScheduleLoop(): void {
  kickSchedule?.();
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
  let pending = false;
  const run = (): void => {
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    void schedulerTick(runner)
      .catch((err) => console.warn(`[scheduler] tick 失败：${String((err as Error)?.message || err)}`))
      .finally(() => {
        inFlight = false;
        if (!pending) return;
        pending = false;
        run();
      });
  };
  kickSchedule = run;
  void releaseDeadScheduleLocks()
    .catch((err) => console.warn(`[scheduler] 清理失效锁失败：${String((err as Error)?.message || err)}`))
    .finally(() => run());
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}
