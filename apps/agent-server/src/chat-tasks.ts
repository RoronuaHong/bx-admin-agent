// 异步任务底座（agent-infrastructure §8：「执行与推送解耦」）。
// 核心语义：/chat/stream 的执行在**后台任务**里跑，HTTP 连接只是转发订阅者——
//  - 客户端断开/关页/断网：任务继续跑完，结果回投（落进对话的 UI 消息快照），回来就能看到；
//  - 重连：GET /chat/task/events 回放事件缓冲并继续跟随（断线续传）；
//  - 取消：POST /chat/cancel 协作式中止（信号贯穿模型调用与工具执行）。
// 并发保护沿用「同一对话同时只允许一条流」：注册表按 conversationId 键，第二请求 409 入队。
import { randomUUID } from "node:crypto";
import type { ChatEvent } from "@bx/shared";

export type TaskStatus = "running" | "success" | "failed" | "cancelled";

export interface ChatTask {
  id: string;
  conversationId: string;
  userText: string;
  /** 发起方设备 owner（限流按它数并发）。 */
  ownerKey?: string;
  startedAt: number;
  settledAt?: number;
  status: TaskStatus;
  /** 事件缓冲（回放用；连续 text_delta 合并，避免流式打爆缓冲）。 */
  buffer: ChatEvent[];
  /** 是否还有 HTTP 订阅者挂着（断开后为 false，任务照跑）。 */
  live: boolean;
  abort: AbortController;
  /** 跟随订阅者的唤醒器（resolve(null) = 结束）。 */
  waiters: Set<(event: ChatEvent | null) => void>;
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

export function startTask(input: { conversationId: string; userText: string; ownerKey?: string }): ChatTask {
  const task: ChatTask = {
    id: `task_${randomUUID()}`,
    conversationId: input.conversationId,
    userText: input.userText,
    ...(input.ownerKey ? { ownerKey: input.ownerKey } : {}),
    startedAt: Date.now(),
    status: "running",
    buffer: [],
    live: false,
    abort: new AbortController(),
    waiters: new Set(),
  };
  running.set(input.conversationId, task);
  return task;
}

/** 发布事件：追加进缓冲（连续 text_delta 合并成一条）并唤醒所有跟随订阅者。 */
export function publishTaskEvent(task: ChatTask, event: ChatEvent): void {
  const lastEvent = task.buffer[task.buffer.length - 1];
  if (event.type === "text_delta" && lastEvent?.type === "text_delta") {
    // 合并增量：缓冲只留一份持续增长的 text_delta，回放体积可控。
    lastEvent.text += event.text;
  } else {
    task.buffer.push(event);
    if (task.buffer.length > 2000) task.buffer.splice(0, task.buffer.length - 2000); // 硬护栏，防异常膨胀
  }
  for (const wake of task.waiters) wake(event);
}

/** HTTP 订阅者离开：标记 live=false 并清掉自己的唤醒器。 */
export function detachTask(task: ChatTask, wake?: (event: ChatEvent | null) => void): void {
  task.live = false;
  if (wake) task.waiters.delete(wake);
}

/** 收束任务：出注册表、留摘要、唤醒所有等待者（null = 结束）。 */
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
  for (const wake of task.waiters) wake(null);
  task.waiters.clear();
}

/**
 * 跟随任务：先回放缓冲，再逐事件 yield 直到任务收束。
 * 用于「断线重连续传」与首连订阅；订阅期间 task.live=true。
 */
export async function* followTask(task: ChatTask): AsyncGenerator<ChatEvent> {
  task.live = true;
  for (const event of task.buffer) yield event;
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
  return "";
}
