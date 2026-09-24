// 定时任务的**共享服务层**（§17）：
// 建定时任务不是只插一条记录——它要连带建「任务专属对话」（否则每期结果都灌进用户自己的聊天，
// 周期任务 = 反复刷屏），还要做配额校验、MCP id 过滤、失败回滚删掉刚建的对话。
//
// 这段逻辑原本只存在于 HTTP 处理器里；工具化（模型也能建任务）时**不能复制一份**——
// 两条路径一旦漂移，表现就是「网页建的会回投到专属对话、模型建的会把结果刷进当前聊天」。
// 故抽到这里，HTTP 与内置工具共用同一实现；错误带 code 供 HTTP 映射状态码，工具只用 error 文案。
import { createConversation, deleteConversation, getConversation } from "./conversations.js";
import {
  countSchedulesOf,
  createSchedule,
  MAX_SCHEDULES_PER_OWNER,
  validateTiming,
  type ChatSchedule,
  type ScheduleNotifyOn,
} from "./schedules.js";
import { hasRole } from "./roles.js";
import { loadServers } from "./mcp/config.js";

/**
 * 定时任务入参里的 id 集合一律**按当前配置过滤**：
 * 悬空引用（服务器已被删）写进任务只会让到点运行静默少能力，排查时毫无线索。
 * 只过滤、不报错——响应里回传落库后的任务，调用方一眼能看出哪些没生效。
 */
export function knownMcpIds(ids?: string[]): string[] {
  const known = new Set(loadServers().map((server) => server.id));
  return [...new Set((ids || []).map((id) => String(id || "").trim()).filter((id) => known.has(id)))];
}

/** 投递触发条件：只认这两个状态，其余（跳过/取消）一律不推。 */
export function pickNotifyOn(values?: ScheduleNotifyOn[]): ScheduleNotifyOn[] {
  return [...new Set((values || []).filter((v): v is ScheduleNotifyOn => v === "success" || v === "failed"))];
}

/** 任务专属对话的标题：任务名优先（侧栏里一眼认出），缺省退回任务内容的前 24 字。 */
export function scheduleConversationTitle(schedule: Pick<ChatSchedule, "name" | "prompt">): string {
  const name = (schedule.name || "").trim();
  if (name) return name.slice(0, 40);
  return schedule.prompt.trim().replace(/\s+/g, " ").slice(0, 24) || "定时任务";
}

/** 建一个任务专属对话（id 生成口径与 POST /chat/conversations 一致）。 */
export async function createTaskConversation(input: {
  ownerKey: string;
  title: string;
  /** 任务勾了哪些服务器就带哪些（空 = 跟随默认启用集，别写成空数组把工具能力清掉）。 */
  mcpServers?: string[];
  agentId?: string;
}) {
  return createConversation({
    id: `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: input.title,
    ownerKey: input.ownerKey,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.mcpServers?.length ? { mcpServers: input.mcpServers } : {}),
  });
}

export type ScheduleErrorCode = "SCHEDULE_INVALID" | "SCHEDULE_INVALID_TIME" | "SCHEDULE_LIMIT" | "AGENT_ROLE_UNKNOWN";

export interface CreateScheduleInput {
  ownerKey: string;
  prompt: string;
  name?: string;
  /** 周期任务的 5 段 cron（croner 语法）；与 onceAt 二选一。 */
  cron?: string;
  /** 一次性任务的目标时刻（毫秒）。 */
  onceAt?: number;
  mcpServers?: string[];
  notifyOn?: ScheduleNotifyOn[];
  locale?: string;
  /** 来源对话（可选）：只用来沿用它的 Agent 角色；结果回投的对话由服务端另建。 */
  sourceConversationId?: string;
  agentId?: string;
}

export type CreateScheduleResult =
  | { ok: true; schedule: ChatSchedule; conversation: { id: string } }
  | { ok: false; code: ScheduleErrorCode; error: string };

/**
 * 建一个定时任务（HTTP 与内置工具的唯一入口）。
 * 顺序与回滚都有讲究：先建专属对话，落库失败就把对话删掉，别在侧栏留一个空对话。
 */
export async function createScheduleTask(input: CreateScheduleInput): Promise<CreateScheduleResult> {
  const prompt = String(input.prompt || "").trim();
  if (!prompt) return { ok: false, code: "SCHEDULE_INVALID", error: "prompt 必填" };

  const timingError = validateTiming({ cron: input.cron, onceAt: input.onceAt });
  if (timingError) return { ok: false, code: "SCHEDULE_INVALID_TIME", error: timingError };

  if ((await countSchedulesOf(input.ownerKey)) >= MAX_SCHEDULES_PER_OWNER) {
    return { ok: false, code: "SCHEDULE_LIMIT", error: `每个设备最多 ${MAX_SCHEDULES_PER_OWNER} 个定时任务` };
  }

  // 角色：显式传入优先，其次沿用来源对话的角色（旧客户端只带 conversationId 的兼容路径）。
  const agentId = String(input.agentId || "").trim();
  if (agentId && !hasRole(agentId)) {
    return { ok: false, code: "AGENT_ROLE_UNKNOWN", error: `未知 Agent 角色：${agentId}` };
  }
  const sourceId = String(input.sourceConversationId || "").trim();
  const sourceAgentId =
    agentId || (sourceId ? (await getConversation(sourceId))?.agentId : undefined) || undefined;

  const taskMcp = knownMcpIds(input.mcpServers);
  const conversation = await createTaskConversation({
    ownerKey: input.ownerKey,
    title: scheduleConversationTitle({ name: String(input.name || ""), prompt }),
    mcpServers: taskMcp,
    ...(sourceAgentId ? { agentId: sourceAgentId } : {}),
  });
  try {
    const schedule = await createSchedule({
      conversationId: conversation.id,
      ownConversation: true,
      ownerKey: input.ownerKey,
      prompt,
      ...(input.onceAt !== undefined ? { onceAt: Number(input.onceAt) } : { cron: String(input.cron || "") }),
      ...(input.name ? { name: input.name } : {}),
      mcpServers: taskMcp,
      notifyOn: pickNotifyOn(input.notifyOn),
      ...(input.locale ? { locale: String(input.locale) } : {}),
    });
    return { ok: true, schedule, conversation: { id: conversation.id } };
  } catch (err) {
    await deleteConversation(conversation.id).catch(() => undefined);
    throw err;
  }
}
