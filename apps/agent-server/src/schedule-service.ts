// 定时任务的**共享服务层**（§17）：
// 建定时任务不是只插一条记录——它要连带建「任务专属对话」（否则每期结果都灌进用户自己的聊天，
// 周期任务 = 反复刷屏），还要做配额校验、MCP id 过滤、失败回滚删掉刚建的对话。
//
// 这段逻辑原本只存在于 HTTP 处理器里；工具化（模型也能建任务）时**不能复制一份**——
// 两条路径一旦漂移，表现就是「网页建的会回投到专属对话、模型建的会把结果刷进当前聊天」。
// 故抽到这里，HTTP 与内置工具共用同一实现；错误带 code 供 HTTP 映射状态码，工具只用 error 文案。
import {
  createConversation,
  deleteConversation,
  getConversation,
  listScheduleConversations,
  markConversationSchedule,
  patchConversation,
} from "./conversations.js";
import {
  countSchedulesOf,
  createSchedule,
  deleteSchedule,
  listSchedules,
  patchSchedule,
  prependRun,
  MAX_SCHEDULES_PER_OWNER,
  validateTiming,
  type ChatSchedule,
  type ScheduleNotifyOn,
  type ScheduleRunMode,
  type ScheduleRunStatus,
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

/**
 * 「每期新会话」模式下某一期的会话标题：`任务名 · MM-DD HH:mm`。
 * 侧栏里父节点已经是任务名，子项必须能一眼区分是哪一期；
 * 用时间而不是「第 N 期」——跨月、暂停、手动补跑之后「第几期」与用户直觉对不上。
 */
export function scheduleRunTitle(schedule: Pick<ChatSchedule, "name" | "prompt">, at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${scheduleConversationTitle(schedule)} · ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 建一个任务专属对话（id 生成口径与 POST /chat/conversations 一致）。 */
export async function createTaskConversation(input: {
  ownerKey: string;
  title: string;
  /** 任务勾了哪些服务器就带哪些（空 = 跟随默认启用集，别写成空数组把工具能力清掉）。 */
  mcpServers?: string[];
  agentId?: string;
  /** 产出该对话的任务（每期会话带；任务删除后可据此清理，不依赖任务侧 runs 列表）。 */
  scheduleId?: string;
  /** 该对话对应哪一期。 */
  scheduleRunAt?: number;
}) {
  return createConversation({
    id: `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: input.title,
    ownerKey: input.ownerKey,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.mcpServers?.length ? { mcpServers: input.mcpServers } : {}),
    ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
    ...(input.scheduleRunAt !== undefined ? { scheduleRunAt: input.scheduleRunAt } : {}),
  });
}

/**
 * 为某一期运行开一个新会话（docs/scheduled-task-sessions-plan.md §3.2）。
 * 角色与工具集从**上一期**继承：任务自己没勾 MCP 时不能落到角色/全局默认（往往是空集），
 * 否则老任务的工具能力会被「每期新会话」悄悄砍掉（与 taskConversationMcpServers 同口径）。
 */
export async function createRunConversation(schedule: ChatSchedule, at = Date.now()) {
  const prev = await getConversation(schedule.conversationId);
  const mcp = schedule.mcpServers?.length ? schedule.mcpServers : prev?.mcpServers;
  const agentId = schedule.agentId || prev?.agentId;
  return createTaskConversation({
    ownerKey: schedule.ownerKey,
    title: scheduleRunTitle(schedule, at),
    ...(mcp?.length ? { mcpServers: mcp } : {}),
    ...(agentId ? { agentId } : {}),
    scheduleId: schedule.id,
    scheduleRunAt: at,
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
  /** 每期结果的落点（缺省 "new"：每期新会话）。见 docs/scheduled-task-sessions-plan.md §3.1。 */
  runMode?: ScheduleRunMode;
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
  const runMode: ScheduleRunMode = input.runMode === "same" ? "same" : "new";
  // 建任务时先建「第 0 期」会话（= 任务的落地会话）：runMode 为 new 时它只是占位，
  // 真正的结果从第一次运行起各占一个新会话；不建的话任务卡片「打开对话」与 IM 链接会无处可指。
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
      runMode,
      // 角色落库：每期新建会话要继承它，否则新会话退回 generic、与老会话不在一个入口。
      ...(sourceAgentId ? { agentId: sourceAgentId } : {}),
    });
    // 补标归属：任务 id 现在才有。有了它，删任务时能认出并清理本任务产出的会话。
    await markConversationSchedule(conversation.id, schedule.id).catch(() => undefined);
    return { ok: true, schedule, conversation: { id: conversation.id } };
  } catch (err) {
    await deleteConversation(conversation.id).catch(() => undefined);
    throw err;
  }
}

/**
 * 落一期运行记录（docs/scheduled-task-sessions-plan.md §3.4）：新的在前、截断到上限、未读 +1。
 * 被截掉的最旧几期**只归档不删除**——静默删用户数据是这类系统里最坏的一类行为，
 * 归档后仍可从「显示归档」找回。
 */
export async function recordScheduleRun(
  schedule: ChatSchedule,
  conversationId: string,
  at: number,
  status: ScheduleRunStatus,
): Promise<void> {
  // 重新读一遍最新状态：调度循环里同一任务可能连续两期落记录，
  // 拿着旧对象会丢更新（prependRun 只看到旧 runs）。生产环境每期都是新一轮从 store 取的，
  // 这里再兜底一次，避免测试或重试场景下串台。
  const base = (await listSchedules(schedule.ownerKey)).find((s) => s.id === schedule.id) ?? schedule;
  const prev = base.runs || [];
  const runs = prependRun(prev, { conversationId, at, status });
  const dropped = prev.filter((r) => !runs.some((k) => k.conversationId === r.conversationId));
  for (const gone of dropped) {
    await patchConversation(gone.conversationId, { archived: true }).catch(() => undefined);
  }
  await patchSchedule(base.id, base.ownerKey, {
    conversationId,
    runs,
    unreadRuns: (base.unreadRuns || 0) + 1,
  });
}

/**
 * 删除任务并连带清理它产出的会话。
 * 只删「会话自己标着属于本任务」的那些（见 `ConversationDoc.scheduleId`）：
 * 老任务绑在用户自己聊天上的那种里面混着用户的内容，一律不碰。
 * 返回被删除的会话数，供前端如实回显。
 */
export async function deleteScheduleWithRuns(
  id: string,
  ownerKey: string,
): Promise<{ ok: boolean; removedConversations: number }> {
  // 先取到任务再删：删完就查不到它有哪些运行会话了。
  const list = await listSchedules(ownerKey);
  const target = list.find((s) => s.id === id) || null;
  const ok = await deleteSchedule(id, ownerKey);
  if (!ok) return { ok: false, removedConversations: 0 };
  let removedConversations = 0;
  if (target?.ownConversation) {
    // 三个来源取并集：任务侧的记录会截断，而建任务时的占位会话压根不在 runs 里，
    // 只有按归属标记反查才能认全（它带 scheduleId，正是为这件事落的）。
    const byMarker = await listScheduleConversations(target.id).catch(() => [] as string[]);
    const ids = [...new Set([target.conversationId, ...byMarker, ...(target.runs || []).map((r) => r.conversationId)])];
    for (const convId of ids) {
      const conv = await getConversation(convId).catch(() => null);
      if (!conv || conv.scheduleId !== target.id) continue;
      await deleteConversation(convId).catch(() => undefined);
      removedConversations += 1;
    }
  }
  return { ok: true, removedConversations };
}
