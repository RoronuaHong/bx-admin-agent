// 异步任务底座（agent-infrastructure §8：「执行与推送解耦」）。
// 核心语义：/chat/stream 的执行在**后台任务**里跑，HTTP 连接只是转发订阅者——
//  - 客户端断开/关页/断网：任务继续跑完，结果回投（落进对话的 UI 消息快照），回来就能看到；
//  - 重连：GET /chat/task/events?from=<seq> 从游标处续读（断线续传，见下方「续传语义」）；
//  - 取消：POST /chat/cancel 协作式中止（信号贯穿模型调用与工具执行）。
// 并发保护沿用「同一对话同时只允许一条流」：注册表按 conversationId 键，第二请求 409 入队。
//
// 续传语义（对齐 SSE `id:` + `Last-Event-ID`、OpenAI Responses `sequence_number`）：
//  ① 每个进入缓冲的事件都带任务内单调递增的 `seq`；正文增量只累加进 `text/textSeq`，不塞缓冲；
//  ② 续传时先补一条 `text` 快照（**替换**语义，天然幂等，不会把已显示的正文再拼一遍），
//     再回放 `seq > from` 的其余事件——重复订阅不会重复应用副作用；
//  ③ 收束后任务**留档一小段时间**（`CHAT_TASK_RETAIN_MS`），晚到的重连仍能取到尾部终态；
//     过期即回收，不留档时行为回到「明确告知已收束」。
import { randomUUID } from "node:crypto";
import type { ChatEvent } from "@bx/shared";
import {
  TASK_DB_RETAIN_MS,
  flushTask,
  listStaleRunningTasks,
  markTaskInterrupted,
  type TaskRecord,
} from "./task-store.js";

/** 事件缓冲上限（防异常膨胀；长 run 起始的 model 事件可能被裁掉，见 app.ts buildRunTrace 注释）。 */
const MAX_BUFFER_EVENTS = 2000;
/** 收束任务留档时长（毫秒，0 = 不留档）：断线重连晚到一点也能拿到尾部，不必重开对话。 */
const TASK_RETAIN_MS = Math.max(0, Number(process.env.CHAT_TASK_RETAIN_MS ?? 300_000));
/** 留档任务数上限（每对话最多一条，超出按最久未更新淘汰）。 */
const RETAIN_MAX_TASKS = Math.max(1, Number(process.env.CHAT_TASK_RETAIN_MAX ?? 100));
/** 落库间隔（毫秒）：事件缓冲按批写 Mongo（避免逐事件往返），正文与状态整体覆盖。 */
const FLUSH_MS = Math.max(100, Number(process.env.CHAT_TASK_FLUSH_MS ?? 800));
/** 模型调用单次超时（看门狗阈值要大于任何合法静默步长，它是其中最长的那个）。 */
const MODEL_TIMEOUT_MS = Math.max(10_000, Number(process.env.MODEL_TIMEOUT_MS ?? 300_000));
/**
 * 无进展看门狗阈值（毫秒）：距最后一个**实质事件**超过它，就主动收口。
 * 默认 = 模型超时 + 5 分钟（留出「模型最长静默 + 工具执行」的余量），因此正常长跑不会误杀。
 */
const STALL_MS = Math.max(60_000, Number(process.env.CHAT_TASK_STALL_MS ?? MODEL_TIMEOUT_MS + 300_000));
/** 看门狗巡检间隔。 */
const WATCHDOG_TICK_MS = Math.max(5_000, Math.min(30_000, Math.floor(STALL_MS / 10)));
/** 僵尸任务判定：别的实例的心跳停了这么久，就认为它已经不在了（进程重启 / 崩溃）。 */
const RECOVER_STALE_MS = Math.max(30_000, Number(process.env.CHAT_TASK_RECOVER_STALE_MS ?? 120_000));
/** 本进程实例标识：写进留档，供恢复扫描区分「这任务是不是我这边的」。 */
const INSTANCE_ID = process.env.CHAT_INSTANCE_ID || `${process.pid}-${randomUUID().slice(0, 8)}`;

export type TaskStatus = "running" | "success" | "failed" | "cancelled" | "interrupted";

export interface ChatTask {
  id: string;
  conversationId: string;
  userText: string;
  /** 发起方设备 owner（限流按它数并发）。 */
  ownerKey?: string;
  startedAt: number;
  settledAt?: number;
  status: TaskStatus;
  /** 事件缓冲（回放用；**不含** text_delta——增量只累加进 `text`，故缓冲体积可控）。 */
  buffer: ChatEvent[];
  /** 已分配的事件序号（下一条事件用完即自增；续传游标的上界）。 */
  seq: number;
  /** 本轮累积的可见正文（text_delta 累加 / text 事件替换），续传时作为一条 `text` 快照补发。 */
  text: string;
  /** `text` 对应的序号水位：客户端的 from 不小于它就不必再收快照。 */
  textSeq: number;
  /** 是否还有 HTTP 订阅者挂着（断开后为 false，任务照跑）。 */
  live: boolean;
  abort: AbortController;
  /** 跟随订阅者的唤醒器（resolve(null) = 结束）。 */
  waiters: Set<(event: ChatEvent | null) => void>;
  /** 留档截止时间（收束后才有；过期即回收）。 */
  retainedUntil?: number;
  /** 最后一个**实质事件**的时间（看门狗判据：HTTP 层的 ping 不算进展）；正文增长/事件入缓冲都会刷新它。 */
  lastEventAt: number;
  /** 已落库的序号水位（只把更新的部分追加进留档，避免整表重写）。 */
  flushedSeq: number;
  /** 落库定时器（按批合并，任务收束时立即刷一次）。 */
  flushTimer?: NodeJS.Timeout;
}

export interface TaskSummary {
  id: string;
  conversationId: string;
  status: TaskStatus;
  startedAt: number;
  settledAt: number;
  durationMs: number;
  /** 收束后是否发生过结果回投（客户端断开时落库）。 */
  outcomePersisted: boolean;
}

/** 运行中任务：按对话键（同一对话同时只允许一条流在写 context）。 */
const running = new Map<string, ChatTask>();
/** 最近收束任务摘要（状态查询/排障用；每对话只留最新一条）。 */
const lastTask = new Map<string, TaskSummary>();
/** 已收束任务的留档（供晚到的重连续传取尾部；按对话键，过期/超量回收）。 */
const retained = new Map<string, ChatTask>();

export function isTaskRunning(conversationId: string): boolean {
  return running.has(conversationId);
}

export function getRunningTask(conversationId: string): ChatTask | undefined {
  return running.get(conversationId);
}

/** 某 owner 当前并发运行中的任务数（限流用）。 */
export function countRunningForOwner(ownerKey?: string): number {
  if (!ownerKey) return 0;
  let count = 0;
  for (const task of running.values()) if (task.ownerKey === ownerKey) count += 1;
  return count;
}

export function getLastTaskSummary(conversationId: string): TaskSummary | undefined {
  return lastTask.get(conversationId);
}

/**
 * 已收束但仍在留档期内的任务（续传用）。
 * 过期即视为不存在——由读取路径顺手回收，不依赖清扫器准时跑到。
 */
export function getRetainedTask(conversationId: string): ChatTask | undefined {
  const task = retained.get(conversationId);
  if (!task) return undefined;
  if (task.retainedUntil !== undefined && task.retainedUntil <= Date.now()) {
    retained.delete(conversationId);
    return undefined;
  }
  return task;
}

/** 定期回收过期留档（定时器 unref，不阻止进程退出）；留档关闭时返回 null。 */
export function startTaskRetentionSweeper(): NodeJS.Timeout | null {
  if (TASK_RETAIN_MS <= 0) return null;
  const everyMs = Math.min(60_000, Math.max(5_000, Math.floor(TASK_RETAIN_MS / 2)));
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [conversationId, task] of retained) {
      if (task.retainedUntil !== undefined && task.retainedUntil <= now) retained.delete(conversationId);
    }
  }, everyMs);
  timer.unref();
  return timer;
}

export function startTask(input: { conversationId: string; userText: string; ownerKey?: string }): ChatTask {
  const task: ChatTask = {
    id: `task_${randomUUID()}`,
    conversationId: input.conversationId,
    userText: input.userText,
    ...(input.ownerKey ? { ownerKey: input.ownerKey } : {}),
    startedAt: Date.now(),
    status: "running",
    buffer: [],
    seq: 0,
    text: "",
    textSeq: 0,
    live: false,
    abort: new AbortController(),
    waiters: new Set(),
    lastEventAt: Date.now(),
    flushedSeq: 0,
  };
  running.set(input.conversationId, task);
  // 立刻落一次「任务已开始」：进程紧接着崩掉时，恢复扫描才知道有过这一轮（否则连「中断」都无从谈起）。
  void flushNow(task);
  return task;
}

/** 本进程实例标识（落库与恢复扫描共用；排障时能看出任务归哪个进程）。 */
export function instanceIdOf(): string {
  return INSTANCE_ID;
}

/** 任务快照 → 留档记录（事件另行增量追加，这里 events 留空）。 */
function snapshotOf(task: ChatTask): TaskRecord {
  return {
    taskId: task.id,
    conversationId: task.conversationId,
    userText: task.userText,
    ...(task.ownerKey ? { ownerKey: task.ownerKey } : {}),
    instanceId: INSTANCE_ID,
    status: task.status,
    startedAt: task.startedAt,
    ...(task.settledAt !== undefined ? { settledAt: task.settledAt } : {}),
    seq: task.seq,
    text: task.text,
    textSeq: task.textSeq,
    events: [],
    updatedAt: Date.now(),
    expiresAt: new Date(Date.now() + TASK_DB_RETAIN_MS),
  };
}

/** 立即落一次（任务开始 / 收束 / 定时器到期）。失败只告警——落档是尽力而为，不阻断本轮。 */
async function flushNow(task: ChatTask): Promise<void> {
  const pending = task.buffer.filter((event) => (event.seq ?? 0) > task.flushedSeq);
  task.flushedSeq = Math.max(task.flushedSeq, task.seq);
  await flushTask(snapshotOf(task), pending);
}

/** 按批合并落库：同一轮里高频事件不会每个都往返一次 Mongo。 */
function scheduleFlush(task: ChatTask): void {
  if (task.flushTimer) return;
  const timer = setTimeout(() => {
    task.flushTimer = undefined;
    void flushNow(task);
  }, FLUSH_MS);
  timer.unref?.();
  task.flushTimer = timer;
}

/**
 * 发布事件：打上任务内递增 `seq` 并唤醒所有跟随订阅者。
 * 订阅者拿到的是**打了号**的事件（前端据此记游标，断线时带回来续传）；
 * 正文增量只累加进 `text/textSeq`、不进缓冲——续传时用一条正文快照替代，避免回放体积与重复拼接。
 */
export function publishTaskEvent(task: ChatTask, event: ChatEvent): void {
  // 僵尸产物守卫：任务已被看门狗 / 取消收口之后，迟到的产出（例如某个不理会 abort 的 await 终于返回）
  // 一律丢弃——否则它会写进留档、出现在晚到的续传里，与「已收口」的状态自相矛盾。
  if (task.status !== "running") return;
  const seq = ++task.seq;
  const stamped: ChatEvent = { ...event, seq };
  if (event.type === "text_delta") {
    task.text += event.text;
    task.textSeq = seq;
  } else {
    if (event.type === "text") {
      // 终稿全文：替换累积值（`text` 事件语义始终是「本轮完整可见正文」）。
      task.text = event.text;
      task.textSeq = seq;
    }
    task.buffer.push(stamped);
    if (task.buffer.length > MAX_BUFFER_EVENTS) {
      task.buffer.splice(0, task.buffer.length - MAX_BUFFER_EVENTS); // 硬护栏，防异常膨胀
    }
  }
  // 进展信号（看门狗判据）与落库调度：只有**实质事件**才刷新，传输层的 ping 不算。
  task.lastEventAt = Date.now();
  scheduleFlush(task);
  for (const wake of task.waiters) wake(stamped);
}

/** HTTP 订阅者离开：标记 live=false 并清掉自己的唤醒器。 */
export function detachTask(task: ChatTask, wake?: (event: ChatEvent | null) => void): void {
  task.live = false;
  if (wake) task.waiters.delete(wake);
}

/** 收束任务：出注册表、留摘要、留档（供晚到的续传）、唤醒所有等待者（null = 结束）。 */
export function finishTask(task: ChatTask, status: TaskStatus, outcomePersisted: boolean): void {
  if (task.status !== "running") return;
  task.status = status;
  task.settledAt = Date.now();
  running.delete(task.conversationId);
  lastTask.set(task.conversationId, {
    id: task.id,
    conversationId: task.conversationId,
    status,
    startedAt: task.startedAt,
    settledAt: task.settledAt,
    durationMs: task.settledAt - task.startedAt,
    outcomePersisted,
  });
  retainTask(task);
  // 收束立即落一次（终态 + 尾部事件），别等定时器——进程要是接着重启，这一笔就是最后一次机会。
  if (task.flushTimer) {
    clearTimeout(task.flushTimer);
    task.flushTimer = undefined;
  }
  void flushNow(task);
  for (const wake of task.waiters) wake(null);
  task.waiters.clear();
}

/**
 * 无进展看门狗：由**服务端**判定「这一轮还活着吗」。
 * 判据只有一个——**距最后一个实质事件的时长**（`lastEventAt`）：HTTP 层的 `ping` 是无条件保活，
 * 不能当进展证据。命中后先发一条诚实的 `error` 事件（前端据此收口并保留已产出内容），
 * 再 abort 并收束；之后迟到的产出由 `publishTaskEvent` 的守卫丢弃。
 */
export function startTaskWatchdog(): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const task of [...running.values()]) {
      const idle = now - task.lastEventAt;
      if (idle < STALL_MS) continue;
      const seconds = Math.round(idle / 1000);
      console.warn(
        `[chat:watchdog] 任务 ${task.id} 已 ${seconds}s 无进展（阈值 ${Math.round(STALL_MS / 1000)}s），主动收口`,
      );
      const message = `本轮已 ${seconds} 秒没有任何进展，已主动结束。已产出的内容保留在上面；未完成的部分请重新发起，或缩小问题范围后再试。`;
      publishTaskEvent(task, {
        type: "error",
        error: { code: "CHAT_TASK_STALLED", defaultMessage: message },
        message,
      });
      task.abort.abort();
      finishTask(task, "failed", false);
    }
  }, WATCHDOG_TICK_MS);
  timer.unref?.();
  return timer;
}

/**
 * 启动恢复：把「别的实例（上一次进程）留下、心跳已停的 running 任务」标成 `interrupted`。
 * 刻意**不重放、不重试**——进程一没，那一轮的模型循环就消失了；重放调用可能重复副作用。
 * 恢复只做两件事：状态诚实（晚到的重连据此收口）+ 已落库的事件照旧可续读。
 */
export async function recoverStaleTasks(): Promise<number> {
  const stale = await listStaleRunningTasks(Date.now() - RECOVER_STALE_MS, INSTANCE_ID);
  let recovered = 0;
  for (const item of stale) {
    if (await markTaskInterrupted(item.conversationId)) recovered += 1;
  }
  if (recovered) {
    console.log(`[chat:tasks] 启动恢复：${recovered} 个僵尸任务已标记 interrupted（上次进程留下的）`);
  }
  return recovered;
}

/** 留档：每对话只留最新一条，按最久未更新淘汰（超量时）。 */
function retainTask(task: ChatTask): void {
  if (TASK_RETAIN_MS <= 0) return;
  task.retainedUntil = Date.now() + TASK_RETAIN_MS;
  retained.delete(task.conversationId); // 先删后插：保持「Map 末尾 = 最新」的淘汰顺序
  retained.set(task.conversationId, task);
  while (retained.size > RETAIN_MAX_TASKS) {
    const oldest = retained.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    retained.delete(oldest);
  }
}

/**
 * 跟随任务：先按游标续读（`from` 之后的部分），再逐事件 yield 直到任务收束。
 *  - 正文用**一条 `text` 快照**补上（客户端是替换语义，天然幂等：不会把已显示的正文再拼一遍）；
 *  - 其余事件只回放 `seq > from` 的，重复订阅不会重复应用（步骤按 id、图卡按追加）。
 * `from = 0` 表示从头开始（首连订阅 / 刷新后重新挂上正在跑的任务）。
 */
export async function* followTask(task: ChatTask, from = 0): AsyncGenerator<ChatEvent> {
  task.live = true;
  if (task.text && task.textSeq > from) yield { type: "text", text: task.text, seq: task.textSeq };
  for (const event of task.buffer) {
    if ((event.seq ?? 0) > from) yield event;
  }
  if (task.status !== "running") return;
  const queue: Array<ChatEvent | null> = [];
  let resolveWait: () => void = () => undefined;
  const wake = (event: ChatEvent | null) => {
    queue.push(event);
    resolveWait();
  };
  task.waiters.add(wake);
  try {
    while (true) {
      if (queue.length) {
        const event = queue.shift()!;
        if (!event) return;
        yield event;
        continue;
      }
      await new Promise<void>((resolve) => {
        resolveWait = resolve;
      });
    }
  } finally {
    task.waiters.delete(wake);
    task.live = false;
  }
}

/** 协作式取消：abort 信号会贯穿模型调用与 MCP 工具调用（chat.ts 已透传）。 */
export function cancelTask(conversationId: string): boolean {
  const task = running.get(conversationId);
  if (!task) return false;
  task.abort.abort();
  return true;
}

/** 收束后把 (用户输入, 最终回复) 回投进对话的 UI 消息快照（客户端断开时服务端代为落库）。 */
export function finalTextOf(task: ChatTask): string {
  for (let i = task.buffer.length - 1; i >= 0; i--) {
    const event = task.buffer[i]!;
    if (event.type === "text") return event.text;
  }
  // 没有终稿 `text` 事件（被取消 / 中途失败）：退回增量累积的正文——它同样只记模型真正产出过的内容。
  return task.text;
}
