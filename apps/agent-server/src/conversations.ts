// 聊天会话持久化，存 MongoDB（连不上则降级进程内存）。
//
// 设计要点：
//  - MongoClient 单例懒连接；失败降级进程内存 Map。
//  - 单一集合 chat_conversations（本机单用户，无归属隔离）。

import { type Collection, type Db, type ObjectId } from "mongodb";
import type { ArtifactSpec, ChartSpec, TodoItem } from "@bx/shared";
import { touchSession, type ChatTurn, type Session } from "./session.js";
import { loadServers } from "./mcp/config.js";
import { getRole } from "./roles.js";
import { getMongoClient, MONGO_DB_NAME } from "./db.js";

const COLL = "chat_conversations";

/** 快照里保留推理细节的尾部条数。更早的只留结论，完整追踪在运行记录里。 */
export const SNAPSHOT_DETAIL_TAIL = 40;
/** 单条思考文本上限。超出留尾部，推理面板看到的是收尾而不是开头。 */
export const SNAPSHOT_THINKING_CAP = 8_000;
export const SNAPSHOT_STEP_RESULT_CAP = 4_000;
const SNAPSHOT_STEP_ARGS_CAP = 400;

type SnapshotStep = {
  name: string;
  status: string;
  id?: string;
  server?: string;
  result?: string;
  args?: string;
};

function capTail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…\n${text.slice(text.length - max)}`;
}

function slimStep(step: SnapshotStep, keepDetail: boolean): SnapshotStep {
  const brief: SnapshotStep = { name: step.name, status: step.status };
  if (step.id) brief.id = step.id;
  if (step.server) brief.server = step.server;
  if (!keepDetail) return brief;
  if (step.result) brief.result = capTail(step.result, SNAPSHOT_STEP_RESULT_CAP);
  if (step.args) brief.args = capTail(step.args, SNAPSHOT_STEP_ARGS_CAP);
  return brief;
}

function slimStoredMessage(message: StoredMessage, keepDetail: boolean): StoredMessage {
  const steps = (message.steps || []) as SnapshotStep[];
  const thinking = message.thinking || "";
  const thinkingOk = keepDetail ? thinking.length <= SNAPSHOT_THINKING_CAP : thinking.length === 0;
  const stepsOk = steps.every((step) => {
    if (!keepDetail) return !step.result && !step.args;
    return (step.result?.length ?? 0) <= SNAPSHOT_STEP_RESULT_CAP && (step.args?.length ?? 0) <= SNAPSHOT_STEP_ARGS_CAP;
  });
  if (thinkingOk && stepsOk) return message;
  const nextThinking = keepDetail && thinking ? capTail(thinking, SNAPSHOT_THINKING_CAP) : "";
  const { thinking: _thinking, steps: _steps, ...rest } = message;
  return {
    ...rest,
    ...(nextThinking ? { thinking: nextThinking } : {}),
    ...(steps.length ? { steps: steps.map((step) => slimStep(step, keepDetail)) as StoredMessage["steps"] } : {}),
  };
}

/** 列表用：不带思考过程和工具原文。打开对话再取最近一段细节。 */
export function listSnapshot(messages: StoredMessage[]): StoredMessage[] {
  return messages.map((message) => slimStoredMessage(message, false));
}

/** 打开对话 / 落库用：只给最近一段留推理细节，更早的收成结论。 */
export function compactSnapshot(messages: StoredMessage[]): StoredMessage[] {
  const detailFrom = Math.max(0, messages.length - SNAPSHOT_DETAIL_TAIL);
  return messages.map((message, index) => slimStoredMessage(message, index >= detailFrom));
}

export interface StoredMessage {
  id?: string | number;
  role: "user" | "assistant";
  text: string;
  /** 这条消息出现的时刻（毫秒）。只用于气泡上的时间，不回灌模型。 */
  at?: number;
  images?: Array<{ id: string; name: string }>;
  /** 该助手消息用到的工具步骤摘要（便于历史还原"它做了什么"）。 */
  steps?: Array<{ name: string; status: string }>;
  /**
   * 扩展思考（reasoning）文本：仅作展示、不回灌模型上下文。
   * 只留在最近一段快照里；更早的收成结论，完整追踪在运行记录。
   */
  thinking?: string;
  /** 任务规划（write_todos 产出，推理面板展示用；前端一并落库）。 */
  todos?: TodoItem[];
  /**
   * 本地渲染图表（render_chart 产出的 spec 数组；前端一并落库）。
   * 图由浏览器用 AntV 现场绘制、产物只在内存里，不随快照存就会「刷新即消失」。
   * 形状直接用 @bx/shared 的 `ChartSpec`（前端 api.ts 的 ChartSpec 也转出同一份）——
   * 这里**不要再内联一份**：曾内联过一个只认 13 种旧图型、且把图形类 data 写成数组的旧类型，
   * 与工具白名单（17 种）漂移，属于「类型说谎」。
   */
  charts?: ChartSpec[];
  /** @deprecated 早期单图字段，已被 `charts`（数组）取代；保留仅用于兼容历史数据。 */
  chart?: ChartSpec;
  /**
   * 可下载产物（export_data 产出的 ArtifactSpec 数组；前端一并落库）。
   * 与 charts 同构——产物实体始终在服务端工作区，快照只存「指针 + 展示元数据」，
   * 刷新后由下载卡片按 spec 重绘；不随快照存就会「刷新即消失」。
   */
  artifacts?: ArtifactSpec[];
}

/** 忙碌期间排队的待发消息（按对话持久化，先进先出）。 */
export interface PendingMessage {
  text: string;
  /** 随消息一起发出的图片附件 id（上传接口产出）。 */
  images?: string[];
  /** 随消息一起发出的文档附件 id（PDF/Word/Excel/md/txt/csv）：出队时一并带上，否则附件会静默丢失。 */
  docs?: string[];
  at: number;
}

interface ConversationDoc {
  _id?: ObjectId;
  id: string;
  title: string;
  /** UI 展示快照（含工具步骤摘要、图片）；与模型上下文 `context` 互不自动同步。 */
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;

  // ---- 对话级设置（所有配置按对话独立，全部后端持久化）----
  /** 该对话使用的模型 id；空 = 服务端默认模型。 */
  model?: string;
  /** 该对话启用的 MCP server id。 */
  mcpServers?: string[];
  /** 该对话用户主动勾选的技能（skills 目录名）；勾选 = 全文注入系统提示，未勾选保持按需加载。 */
  skillsEnabled?: string[];
  /** 该对话的界面语言，同时决定回复语言；空 = 客户端默认。 */
  locale?: string;
  /** 浏览器上报的 IANA 时区。面向用户的钟点和小时分桶用它，不从语言猜测。 */
  timeZone?: string;
  /** 忙碌期间排队的待发消息。 */
  pendingQueue?: PendingMessage[];
  /** 任务规划（write_todos 全量替换），跨轮持久化、前端可见。 */
  todos?: TodoItem[];
  /** 置顶时间戳；null / 缺省 = 未置顶。置顶区固定在列表最上（新的置顶在上）。 */
  pinnedAt?: number | null;
  /** 手动顺序（「手动排序」模式下生效）；按下标 × `ORDER_STEP` 分配，便于中间插入。 */
  sortOrder?: number;
  /** 归档：true = 收进归档区（默认列表不显示，需显式 includeArchived）。 */
  archived?: boolean;
  /**
   * 免打扰：true = 该对话的后台完成提醒静默（不弹提示）。
   * 只影响「提醒」，不影响消息落库与侧栏状态点 —— 多会话并行时用来避免被打断。
   */
  muted?: boolean;
  /** 会话级只读授权：该对话内，把这些 MCP 服务器上「未声明级别」的工具按只读处理（写操作安全闸门 P0-3）。 */
  readGrants?: string[];
  /**
   * 完全访问：true（默认）= 该对话内的写/破坏性/外部操作不再逐项弹确认卡，直接执行
   * （对齐 CodeBuddy「完全访问模式」）。false = 恢复默认的安全闸门（每次外部副作用前确认）。
   * 缺省按 true 处理，即开箱即「完全授权」。
   */
  fullAccess?: boolean;
  /** 设备 owner 标注（轻量归属隔离，方案 A）：创建该对话的设备标识；缺省 = 遗留数据（对所有人可见）。 */
  ownerKey?: string;
  /**
   * Agent 角色（领域适配指南模式 B）：generic = 通用助手，movie = 观影助手…
   * 决定系统提示人设 / skill 索引可见性；缺省 = generic（旧对话向后兼容）。
   */
  agentId?: string;
  /**
   * 产出该会话的定时任务 id（docs/scheduled-task-sessions-plan.md §3.2）。
   * 「每期新会话」模式下每一期各带一个；有了它，任务被删后也能认出并清理这些会话，
   * 不必依赖任务侧的 runs 列表（列表截断后就认不出来了）。
   */
  scheduleId?: string;
  /** 该会话对应哪一期（运行时刻）；与 scheduleId 配套，用于标题与排序。 */
  scheduleRunAt?: number;

  // ---- 模型上下文（thread）----
  /** 发往模型的对话历史（含工具轻量句柄），是上下文的唯一真相。 */
  context?: ChatTurn[];
  /** 原子序列计数器：并发追加时判定顺序。 */
  contextSeq?: number;
  /** 历史摘要（上下文超限后由服务端生成，供后续轮次复用）。 */
  summary?: string;
  summaryAt?: number;
  /** 摘要水位线：已覆盖到 context 的第几条。 */
  summaryCovered?: number;
}

// ---- Mongo 连接（单例见 ./db.ts）----
let indexEnsured = false;

/**
 * 会话集合索引：`id` 必须唯一。
 * 没有唯一索引时，并发 upsert 会产生同 id 的重复文档——列表侧 dedupeDocs 正是为这个症状打的补丁。
 * 已有重复文档时建唯一索引会失败：这里 fail-soft 只告警，绝不删数据（避免破坏性自愈）。
 */
async function ensureIndexes(coll: Collection<ConversationDoc>): Promise<void> {
  if (indexEnsured) return;
  indexEnsured = true;
  await coll.createIndex({ id: 1 }, { unique: true }).catch((err) => {
    console.warn(
      `[conversations] id 唯一索引未创建（多半是库里已有同 id 重复文档，需人工去重后再建）：${String((err as Error)?.message || err)}`,
    );
  });
}

async function getColl(): Promise<Collection<ConversationDoc> | null> {
  try {
    const client = await getMongoClient();
    const db: Db = client.db(MONGO_DB_NAME);
    const coll = db.collection<ConversationDoc>(COLL);
    await ensureIndexes(coll);
    return coll;
  } catch {
    return null;
  }
}

// ---- 内存降级 ----
const memory = new Map<string, ConversationDoc>();

/**
 * 手动顺序步长：相邻项间隔 1000，方便将来在中间插入而不必整体重排。
 * 服务端按下标 × 本值分配 `sortOrder`。
 */
export const ORDER_STEP = 1000;

/**
 * 列表排序规则：置顶优先 → 手动顺序（排过的在前）→ 默认序。
 * 默认序：置顶组按置顶时间（新的在上），普通组按最近活动。
 *
 * 注意：排序模式的最终裁决在前端（`convRank`）——「按最近活动」模式下前端会忽略 `sortOrder`。
 * 这里给的是一份稳定的默认序（也是「手动排序」模式下的正确序）。
 */
function conversationRank(a: ConversationDoc, b: ConversationDoc): number {
  const ap = a.pinnedAt ? 1 : 0;
  const bp = b.pinnedAt ? 1 : 0;
  if (ap !== bp) return bp - ap;
  const ao = a.sortOrder ?? Number.POSITIVE_INFINITY;
  const bo = b.sortOrder ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao - bo;
  if (ap && bp) return (b.pinnedAt || 0) - (a.pinnedAt || 0);
  return b.updatedAt - a.updatedAt;
}

function dedupeDocs(list: ConversationDoc[]): ConversationDoc[] {
  const byId = new Map<string, ConversationDoc>();
  for (const doc of list) {
    const prev = byId.get(doc.id);
    if (!prev || doc.updatedAt >= prev.updatedAt) byId.set(doc.id, doc);
  }
  return [...byId.values()].sort(conversationRank);
}

// ---- CRUD ----
/**
 * 归属过滤（轻量 owner 标注）：只看「自己创建的 + 无主遗留」。
 * 遗留数据（没有 ownerKey）保持全员可见，避免升级时把既有对话孤儿化；新建对话一律带 owner。
 */
function visibleTo(docs: ConversationDoc[], ownerKey?: string): ConversationDoc[] {
  if (!ownerKey) return docs;
  return docs.filter((doc) => !doc.ownerKey || doc.ownerKey === ownerKey);
}

export async function listConversations(
  ownerKey?: string,
  includeArchived = false,
  /** 按 Agent 角色过滤（缺省/未传 = 不过滤，兼容旧调用方）。 */
  agentId?: string,
): Promise<ConversationDoc[]> {
  const coll = await getColl();
  const stripContext = (doc: ConversationDoc): ConversationDoc => {
    const { context, ...rest } = doc;
    return { ...rest, messages: listSnapshot(rest.messages || []) } as ConversationDoc;
  };
  // 列表不返回 context（体积大）：切对话时用 GET /chat/conversations/:id 单独取。
  const all = visibleTo(
    !coll
      ? dedupeDocs([...memory.values()].map(stripContext))
      : dedupeDocs((await coll.find({}, { projection: { context: 0 } }).sort({ updatedAt: -1 }).toArray()).map(({ _id, ...rest }) => rest as ConversationDoc)),
    ownerKey,
  );
  const byArchive = includeArchived ? all : all.filter((doc) => !doc.archived);
  if (!agentId) return byArchive;
  // 多 Agent 分槽：generic 页看不到 movie 对话，反之亦然（缺省 agentId 的旧数据归 generic）。
  const wanted = agentId === "generic" ? "generic" : agentId;
  return byArchive.filter((doc) => (doc.agentId || "generic") === wanted);
}

export async function getConversation(id: string): Promise<ConversationDoc | null> {
  const coll = await getColl();
  if (!coll) {
    const cached = memory.get(id);
    if (!cached) return null;
    cached.messages = compactSnapshot(cached.messages || []);
    return cached;
  }
  const doc = await coll.find({ id }).sort({ updatedAt: -1 }).limit(1).next();
  if (!doc) return null;
  const { _id, ...rest } = doc;
  const raw = (rest.messages ?? []) as StoredMessage[];
  const messages = compactSnapshot(raw);
  if (messages.some((message, index) => message !== raw[index])) {
    await coll.updateOne({ _id }, { $set: { messages } }).catch((err) => {
      console.warn(`[conversations] 收紧历史快照失败：${String((err as Error)?.message || err)}`);
    });
  }
  // 老数据或 upsert 漏字段时可能没有 messages；兜底成空数组，保证返回形状始终符合契约。
  return { ...rest, messages } as ConversationDoc;
}

export async function createConversation(input: {
  id: string;
  title: string;
  ownerKey?: string;
  /** Agent 角色（缺省 generic）；决定人设 / skill 可见性 / 默认 MCP 勾选。 */
  agentId?: string;
  /** 显式指定 MCP 启用集（缺省 = 角色默认）。 */
  mcpServers?: string[];
  /** 显式指定技能勾选集（定时任务建会话时继承任务配置用；缺省 = 空，仅默认技能生效）。 */
  skillsEnabled?: string[];
  /** 显式指定「完全访问」开关（缺省 = 角色默认，再缺省 = true）。 */
  fullAccess?: boolean;
  /** 产出该会话的定时任务（每期会话带；见 ConversationDoc.scheduleId）。 */
  scheduleId?: string;
  /** 该会话对应的运行时刻（与 scheduleId 配套）。 */
  scheduleRunAt?: number;
  /** 浏览器上报的 IANA 时区，随任务会话继承。 */
  timeZone?: string;
}): Promise<ConversationDoc> {
  const now = Date.now();
  // MCP 勾选：显式传入 > 该助手自带的数据源。通用助手没有自带源，新建就是空。
  // 不读服务器上的 defaultEnabled：连接器要用户在输入栏里手动打开。
  // 显式传入空数组 = 调用方不要任何连接器，不要被 || 当成「没传」而改走角色默认。
  const requested = input.mcpServers ?? getRole(input.agentId).defaultMcpServers ?? [];
  // 角色默认里的 id 必须是当前已配置的服务器。没配上的环境不能把悬空 id 写进对话。
  const known = new Set(loadServers().filter((server) => server.enabled !== false).map((server) => server.id));
  const mcp = input.mcpServers ? requested : requested.filter((id) => known.has(id));
  // 「完全访问」默认：显式传入 > 角色默认（如客服助手关，让写工具走人审确认）> 开箱即完全授权。
  const fullAccess = input.fullAccess ?? getRole(input.agentId).defaultFullAccess ?? true;
  const doc: ConversationDoc = {
    id: input.id,
    title: input.title || "新对话",
    messages: [],
    mcpServers: mcp,
    createdAt: now,
    updatedAt: now,
    // 角色可关掉完全访问：写/破坏性/外部操作逐项弹确认卡（客服助手即如此）。
    fullAccess,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.ownerKey ? { ownerKey: input.ownerKey } : {}),
    ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
    ...(input.scheduleRunAt !== undefined ? { scheduleRunAt: input.scheduleRunAt } : {}),
    ...(input.skillsEnabled?.length ? { skillsEnabled: [...new Set(input.skillsEnabled)] } : {}),
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  };
  const coll = await getColl();
  if (!coll) {
    const existing = memory.get(input.id);
    if (existing) {
      existing.title = input.title || existing.title;
      existing.updatedAt = now;
      return existing;
    }
    memory.set(input.id, doc);
    return doc;
  }
  await coll.updateMany(
    { id: input.id },
    {
      $set: { title: input.title || "新对话", updatedAt: now },
      $setOnInsert: {
        // 新建会话必须落一个空消息数组：只在插入时生效；
        // id 已存在时（幂等 create，如定时任务/ensure 复用 id）不覆盖，保留既有历史。
        messages: doc.messages,
        createdAt: now,
        mcpServers: doc.mcpServers,
        fullAccess,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.ownerKey ? { ownerKey: input.ownerKey } : {}),
        ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
        ...(input.scheduleRunAt !== undefined ? { scheduleRunAt: input.scheduleRunAt } : {}),
        ...(input.skillsEnabled?.length ? { skillsEnabled: [...new Set(input.skillsEnabled)] } : {}),
      },
    },
    { upsert: true },
  );
  const saved = await getConversation(input.id);
  return saved || doc;
}

/**
 * 某定时任务产出的全部会话 id（清理用）。
 * 为什么不能只看任务侧的 `runs`：runs 有保留上限，被截断的那些会话任务侧就认不出来了
 * ——建任务时那个占位会话尤其典型，第一次运行后它就从 runs 里消失了。
 */
export async function listScheduleConversations(scheduleId: string): Promise<string[]> {
  const coll = await getColl();
  const docs = !coll
    ? [...memory.values()].filter((doc) => doc.scheduleId === scheduleId)
    : ((await coll.find({ scheduleId }, { projection: { id: 1 } }).toArray()) as unknown as Array<{ id: string }>);
  return docs.map((doc) => doc.id);
}

/**
 * 把会话标注为「某定时任务产出」（建任务时补标）。
 * 为什么不在 createConversation 里一次带上：任务 id 由 createSchedule 生成，而会话要先建好才能给它——
 * 顺序是「先建会话 → 再建任务（失败要回滚会话）」，故只能事后补这一笔。
 */
export async function markConversationSchedule(id: string, scheduleId: string): Promise<void> {
  const coll = await getColl();
  if (!coll) {
    const doc = memory.get(id);
    if (doc) doc.scheduleId = scheduleId;
    return;
  }
  await coll.updateOne({ id }, { $set: { scheduleId } }).catch((e) => {
    console.warn(`[conversations] 会话绑定任务标记写入失败：${String((e as Error)?.message || e)}`);
  });
}

/** 刚写过的同一句助手结论不再追加。只看最近几条，且时间必须落在本轮，避免把上一期的相同结论误判成重复。 */
export function withoutFreshAssistantDupes(
  existing: Array<{ role?: string; text?: string; at?: number }>,
  incoming: StoredMessage[],
  notBefore: number,
): StoredMessage[] {
  return incoming.filter((message) => {
    if (message.role !== "assistant" || !message.text) return true;
    const start = Math.max(0, existing.length - 6);
    for (let i = existing.length - 1; i >= start; i--) {
      const prior = existing[i];
      if (prior?.role === "assistant" && prior.text === message.text && (prior.at ?? 0) >= notBefore) return false;
    }
    return true;
  });
}

function sameSnapshotMessage(a: StoredMessage, b: StoredMessage): boolean {
  return a.role === b.role && (a.text || "") === (b.text || "");
}

/**
 * 把服务端已有消息数组按 delta 应用成最新状态（与 Mongo 分支语义一致，进程内存降级版复用）。
 * - base === L：尾部全是新增消息 → 直接 push；
 * - base === L-1 且只带来 1 条：是「最后一条正在流式更新」→ 原地替换最后一条（避免重复堆积）；
 * - 服务端若已先写下本轮提问，客户端仍按旧基线交来「提问 + 回复」：跳过库里已有的前缀，避免刷新后出现两条一样的提问；
 * - 其它（多端/异常错位，单客户端理论上不会命中）：尽力 push，保证不丢。
 */
function applyDeltaMessages(arr: StoredMessage[], tail: StoredMessage[], base: number): void {
  let at = base;
  let next = tail;
  if (at >= 0 && at < arr.length) {
    let skip = 0;
    while (at + skip < arr.length && skip < next.length && sameSnapshotMessage(arr[at + skip]!, next[skip]!)) skip += 1;
    if (skip > 0) {
      at += skip;
      next = next.slice(skip);
    }
  }
  if (!next.length) return;
  const last = arr[arr.length - 1];
  if (
    next.length === 1 &&
    next[0]?.role === "user" &&
    last?.role === "user" &&
    (last.text || "") === (next[0].text || "")
  ) {
    return;
  }
  const L = arr.length;
  if (at === L) {
    arr.push(...next);
  } else if (at === L - 1 && next.length === 1) {
    arr[L - 1] = next[0]!;
  } else {
    arr.push(...next);
  }
}

/**
 * 一轮刚开始就把用户提问写进 UI 快照。
 * 刷新发生在模型还没答完时，快照里已经有这条提问，气泡不会空着等整轮结束。
 * 末尾已经是同一句时不追加（客户端抢先落库、或重复进入同一轮）。
 */
export async function appendUserTurnIfMissing(id: string, text: string, at = Date.now()): Promise<void> {
  if (!id || !text.trim()) return;
  const doc = await getConversation(id);
  if (!doc) return;
  const existing = doc.messages || [];
  const last = existing[existing.length - 1];
  if (last?.role === "user" && (last.text || "") === text) return;
  await upsertMessages({
    id,
    messages: [{ role: "user", text, at }],
    base: existing.length,
  });
}

export async function upsertMessages(input: {
  id: string;
  messages: StoredMessage[];
  title?: string;
  /**
   * 增量落库基线：客户端已成功落库的消息条数。
   * 传了 base（且非 full 强制全量）时，messages 只含「自 base 起的新增/最后一条变更」，
   * 后端按 base 与当前长度的关系 push 或原地替换，避免每次把整段长对话（可达 MB 级）全量回写。
   */
  base?: number;
  /** 强制全量替换（对话被清空等长度回退场景，或老客户端不带 base 的全量写法）。 */
  full?: boolean;
}): Promise<void> {
  const { id, messages, title, base, full } = input;
  // 仅当显式 full 或没给 base 时走全量替换：老客户端不带 base 发来的就是整段列表。
  const isDelta = full !== true && typeof base === "number";

  const coll = await getColl();
  if (!coll) {
    let doc = memory.get(id);
    if (!doc) {
      doc = {
        id,
        title: title || "新对话",
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      memory.set(id, doc);
    }
    if (!isDelta) {
      doc.messages = compactSnapshot(messages);
    } else {
      const fresh = withoutFreshAssistantDupes(doc.messages, messages, Date.now() - 120_000);
      if (fresh.length) applyDeltaMessages(doc.messages, fresh, base);
      doc.messages = compactSnapshot(doc.messages);
    }
    doc.updatedAt = Date.now();
    if (title) doc.title = title;
    return;
  }

  if (!isDelta) {
    await coll.updateMany(
      { id },
      {
        $set: {
          messages: compactSnapshot(messages),
          updatedAt: Date.now(),
          ...(title ? { title } : {}),
        },
        $setOnInsert: { createdAt: Date.now() },
      },
      { upsert: true },
    );
    return;
  }

  // 增量：先取当前长度判定 push 还是替换最后一条，再定向更新。
  const cur = await coll.findOne({ id }, { projection: { messages: 1 } });
  const existing = (cur?.messages as StoredMessage[] | undefined) ?? [];
  const fresh = withoutFreshAssistantDupes(existing, messages, Date.now() - 120_000);
  if (!fresh.length) {
    if (title) await coll.updateMany({ id }, { $set: { title, updatedAt: Date.now() } });
    return;
  }
  const titleSet = title ? { title } : {};
  const merged = existing.slice();
  applyDeltaMessages(merged, fresh, base);
  await coll.updateMany(
    { id },
    { $set: { messages: compactSnapshot(merged), updatedAt: Date.now(), ...titleSet } },
    { upsert: true },
  );
}

/** 写入/更新会话摘要与水位线（上下文压缩产物跨轮复用，水位线单调前移）。 */
export async function setConversationSummary(
  id: string,
  summary: string,
  summaryCovered: number,
): Promise<void> {
  const now = Date.now();
  const coll = await getColl();
  if (!coll) {
    const doc = memory.get(id);
    if (doc) {
      doc.summary = summary;
      doc.summaryAt = now;
      doc.summaryCovered = summaryCovered;
    }
    return;
  }
  await coll.updateMany({ id }, { $set: { summary, summaryAt: now, summaryCovered } });
}

/** 写入任务规划（write_todos 全量替换；跨轮持久化）。 */
export async function setConversationTodos(id: string, todos: TodoItem[]): Promise<void> {
  const coll = await getColl();
  if (!coll) {
    const doc = memory.get(id);
    if (doc) doc.todos = todos;
    return;
  }
  await coll.updateMany({ id }, { $set: { todos, updatedAt: Date.now() } });
}

export async function deleteConversation(id: string): Promise<void> {
  const coll = await getColl();
  if (!coll) {
    memory.delete(id);
    return;
  }
  await coll.deleteMany({ id });
}

export async function clearConversation(id: string): Promise<void> {
  const coll = await getColl();
  if (!coll) {
    const doc = memory.get(id);
    if (doc) {
      doc.messages = [];
      doc.updatedAt = Date.now();
    }
    return;
  }
  await coll.updateMany({ id }, { $set: { messages: [], updatedAt: Date.now() } });
}

// ---- 对话级设置 ----

export interface ConversationPatch {
  title?: string;
  model?: string;
  mcpServers?: string[];
  skillsEnabled?: string[];
  locale?: string;
  /** 浏览器上报的 IANA 时区。改它不代表对话有新活动。 */
  timeZone?: string;
  pendingQueue?: PendingMessage[];
  /** 置顶时间戳；null = 取消置顶。 */
  pinnedAt?: number | null;
  /** 归档开关。 */
  archived?: boolean;
  /** 免打扰开关（静默该对话的后台完成提醒）。 */
  muted?: boolean;
  /** 会话级只读授权（服务器 id 白名单）。 */
  readGrants?: string[];
  /** 完全访问开关（true = 不逐项弹确认卡，默认 true）。 */
  fullAccess?: boolean;
}

/**
 * 只改变「列表怎么组织」、不代表对话有新活动的字段：
 * 改它们不应刷新 `updatedAt`，否则在「按最近活动排序」下会把该对话弹到列表最前（与用户预期不符）。
 */
const ACTIVITY_NEUTRAL_KEYS = new Set(["title", "pinnedAt", "archived", "muted", "readGrants", "skillsEnabled", "fullAccess", "timeZone"]);

/**
 * 更新对话设置（未提供的字段保持不变）；对话不存在返回 null。
 *
 * 排序只应由真实活动（新消息）驱动：重命名 / 置顶这类整理动作不刷新 `updatedAt`。
 */
export async function patchConversation(id: string, patch: ConversationPatch): Promise<ConversationDoc | null> {
  const set: Record<string, unknown> = {};
  for (const key of ["title", "model", "mcpServers", "skillsEnabled", "locale", "timeZone", "pendingQueue", "pinnedAt", "archived", "muted", "readGrants", "fullAccess"] as const) {
    if (patch[key] !== undefined) set[key] = patch[key];
  }
  if (!Object.keys(set).length) return getConversation(id);
  if (Object.keys(set).some((key) => !ACTIVITY_NEUTRAL_KEYS.has(key))) set.updatedAt = Date.now();
  const coll = await getColl();
  if (!coll) {
    const doc = memory.get(id);
    if (!doc) return null;
    Object.assign(doc, set);
    return doc;
  }
  await coll.updateOne({ id }, { $set: set });
  return getConversation(id);
}

/**
 * 批量写入手动顺序：`ids` 的下标即新顺序（`sortOrder = index × ORDER_STEP`）。
 *
 * 单请求原子提交（而不是逐条 PATCH），避免中途失败留下半套顺序、以及多次请求间的竞态。
 * 与重命名 / 置顶同理：**整理动作不刷新 `updatedAt`**，否则排序一改就会污染「最近活动」。
 */
export async function reorderConversations(ids: string[]): Promise<void> {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id))];
  if (!unique.length) return;
  const coll = await getColl();
  if (!coll) {
    unique.forEach((id, index) => {
      const doc = memory.get(id);
      if (doc) doc.sortOrder = index * ORDER_STEP;
    });
    return;
  }
  await Promise.all(
    unique.map((id, index) => coll.updateOne({ id }, { $set: { sortOrder: index * ORDER_STEP } })),
  );
}

/** 任意对话启用的 MCP server id 集合（连接引用计数用：还有对话在用就不要断开）。 */
export async function listEnabledMcpServers(): Promise<Set<string>> {
  const docs = await listConversations();
  const used = new Set<string>();
  for (const doc of docs) for (const id of doc.mcpServers || []) used.add(id);
  return used;
}

/**
 * 会话级只读授权：把 serverId 加入该对话的 readGrants（确认卡勾选「按只读处理」时调用）。
 * $addToSet 原子去重；文档不存在则忽略（确认应答已校验票据归属，此处无需再建）。
 */
export async function addConversationReadGrant(id: string, serverId: string): Promise<void> {
  if (!id || !serverId) return;
  const coll = await getColl();
  if (!coll) {
    const doc = memory.get(id);
    if (doc) doc.readGrants = [...new Set([...(doc.readGrants || []), serverId])];
    return;
  }
  await coll.updateMany({ id }, { $addToSet: { readGrants: serverId } });
}

/** 从所有对话的启用集里摘除某 MCP server（配置被删除时调用，避免留下悬空引用）。 */
export async function pullMcpServerFromAllConversations(id: string): Promise<void> {
  const coll = await getColl();
  if (!coll) {
    for (const doc of memory.values()) {
      if (doc.mcpServers?.includes(id)) doc.mcpServers = doc.mcpServers.filter((x) => x !== id);
    }
    return;
  }
  await coll.updateMany({ mcpServers: id }, { $pull: { mcpServers: id } });
}

/**
 * 启动维护：把所有对话启用集里「配置中已不存在」的 id 摘掉，返回被改动的对话数。
 *
 * 为什么需要它：服务器被删除走 `DELETE /mcp/servers/:id` 时会即时清理（见上），但服务器的增减
 * 更常来自 `.env` 的 `MCP_BUILTIN_SERVERS`（只在进程启动时读取）——那条路径没有任何清理点，
 * 于是对话里会留下悬空 id：面板里一个勾都没有、角标却按它计数，且模型侧完全无从知晓。
 * 放在**启动期**而不是塞进 `GET /chat/mcp/servers`：GET 是安全方法，不该产生数据变更
 * （RFC 9110 §9.2.1：安全方法的语义是只读；有实际数据影响的写操作不能挂在它下面，否则
 * 预取 / 重试 / 中间件都可能无意义地触发它）。
 */
export async function pruneUnknownMcpServers(knownIds: string[]): Promise<number> {
  const known = new Set(knownIds);
  const coll = await getColl();
  if (!coll) {
    let changed = 0;
    for (const doc of memory.values()) {
      const stored = doc.mcpServers || [];
      const kept = stored.filter((id) => known.has(id));
      if (kept.length !== stored.length) {
        doc.mcpServers = kept;
        changed += 1;
      }
    }
    return changed;
  }
  const docs = await coll
    .find({ mcpServers: { $exists: true, $ne: [] } }, { projection: { id: 1, mcpServers: 1 } })
    .toArray();
  const unknown = [...new Set(docs.flatMap((d) => (d.mcpServers || []).filter((id) => !known.has(id))))];
  if (!unknown.length) return 0;
  const res = await coll.updateMany({ mcpServers: { $in: unknown } }, { $pull: { mcpServers: { $in: unknown } } });
  return res.modifiedCount;
}

// ---- 对话上下文（thread）----

/**
 * 原子追加一轮上下文：单文档 $push + $inc，保证并发追加顺序可判定
 * （对齐 OpenAI Agents SDK MongoDBSession 的「原子序列计数器」做法）。
 */
export async function appendContext(id: string, turns: ChatTurn[]): Promise<void> {
  // 单点收口：丢弃「正文为空」的 assistant 轮。
  // 上游对空 assistant 消息直接 400（"the message ... with role 'assistant' must not be empty"），
  // 而该错是**确定性**的——候选链逐个都会失败、重试也没用，整个会话就此永久卡死（实测踩过：
  // 用户在任何正文产生前点「停止」时，曾回写一条空的 assistant 轮）。
  // 挡在写入口，任何调用方都不可能再把脏轮写进上下文（序列化层另有一道自愈，见 models.ts，
  // 用于修复已经存在的脏历史）。
  const safe = turns.filter((turn) => turn.role !== "assistant" || String(turn.text || "").trim().length > 0);
  if (!safe.length) return;
  const now = Date.now();
  const coll = await getColl();
  if (!coll) {
    let doc = memory.get(id);
    if (!doc) {
      doc = { id, title: "新对话", messages: [], createdAt: now, updatedAt: now };
      memory.set(id, doc);
    }
    doc.context = [...(doc.context || []), ...safe];
    doc.contextSeq = (doc.contextSeq || 0) + safe.length;
    doc.updatedAt = now;
    return;
  }
  await coll.updateOne(
    { id },
    {
      $push: { context: { $each: safe } },
      $inc: { contextSeq: safe.length },
      $set: { updatedAt: now },
      $setOnInsert: { title: "新对话", messages: [], createdAt: now },
    },
    { upsert: true },
  );
}

/**
 * 归属判定（轻量 owner 标注，方案 A）：ownerKey 缺省 = 遗留数据（人人可见）；
 * 有标注则必须精确匹配。不存在的对话返回 false（HTTP 层统一 404，不泄漏存在性）。
 */
export async function conversationOwnedBy(id: string, ownerKey?: string): Promise<boolean> {
  if (!id) return false;
  const doc = await getConversation(id);
  if (!doc) return false;
  return !doc.ownerKey || (Boolean(ownerKey) && doc.ownerKey === ownerKey);
}

/** 清空该对话的上下文与摘要（不影响 UI 消息快照 messages）。 */
export async function clearContext(id: string): Promise<void> {
  const coll = await getColl();
  if (!coll) {
    const doc = memory.get(id);
    if (doc) {
      doc.context = [];
      doc.summary = "";
      doc.summaryCovered = 0;
      doc.contextSeq = 0;
      doc.updatedAt = Date.now();
    }
    return;
  }
  await coll.updateMany(
    { id },
    { $set: { context: [], summary: "", summaryCovered: 0, contextSeq: 0, updatedAt: Date.now() } },
  );
}

/**
 * 解析本次请求所属的对话（thread）：
 * - 显式传入 conversationId → 用它（不存在则创建）；
 * - 否则用会话里记录的活跃对话；
 * - 都没有 → 创建「默认对话」，并把旧 session.messages / mcpServers **拷贝**迁移进去
 *   （源字段保留一个版本以支持回退，不再写入）。
 */
export async function resolveConversation(
  session: Session,
  conversationId?: string,
  ownerKey?: string,
  /** Agent 角色：无显式对话时按角色取活跃槽（多 Agent 页面不互相顶掉）。 */
  agentId?: string,
): Promise<string> {
  if (conversationId) {
    if (!(await getConversation(conversationId))) {
      await createConversation({ id: conversationId, title: "新对话", ...(agentId ? { agentId } : {}), ...(ownerKey ? { ownerKey } : {}) });
    }
    return conversationId;
  }
  // 按角色取活跃对话：generic 走旧字段（向后兼容），其余角色走分槽映射。
  const activeForAgent = agentId && agentId !== "generic" ? session.activeByAgent?.[agentId] : session.activeConversationId;
  if (activeForAgent && (await getConversation(activeForAgent))) {
    return activeForAgent;
  }
  const legacyTurns = (session.messages || []).filter((m) => m.text);
  const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await createConversation({
    id,
    title: legacyTurns[0] ? legacyTurns[0].text.slice(0, 24) : "新对话",
    ...(agentId ? { agentId } : {}),
    ...(ownerKey ? { ownerKey } : {}),
  });
  // 创建后立即占住该角色的活跃槽：否则在 stream 之外的端点（如 mcp/servers PUT）里
  // 每次无 id 解析都会再造一个新对话（generic 旧路径同款问题的同款修法）。
  if (agentId && agentId !== "generic") {
    session.activeByAgent = session.activeByAgent || {};
    session.activeByAgent[agentId] = id;
  } else {
    session.activeConversationId = id;
  }
  if (legacyTurns.length || (session.mcpServers || []).length) {
    await appendContext(
      id,
      legacyTurns.map((turn) => ({
        role: turn.role,
        text: turn.text,
        ...(turn.handles?.length ? { handles: turn.handles } : {}),
      })),
    );
    if ((session.mcpServers || []).length) {
      await patchConversation(id, { mcpServers: session.mcpServers });
    }
    console.log(
      `[conversations] 迁移旧会话：上下文 ${legacyTurns.length} 条 / MCP ${(session.mcpServers || []).length} 个 → ${id}`,
    );
  }
  // 活跃槽已在上方按角色写好（generic → activeConversationId；其余 → activeByAgent）。
  touchSession(session);
  return id;
}

/** 取含模型上下文（context）的完整对话（导出用）；不存在返回 null。 */
export async function getFullConversation(id: string): Promise<ConversationDoc | null> {
  const coll = await getColl();
  if (!coll) return memory.get(id) || null;
  const doc = await coll.find({ id }).sort({ updatedAt: -1 }).limit(1).next();
  if (!doc) return null;
  const { _id, ...rest } = doc;
  // 与 getConversation 同一契约：老数据缺 messages 时兜底成空数组（导出路径同样不能拿到 undefined）。
  return { ...rest, messages: rest.messages ?? [] } as ConversationDoc;
}

/**
 * 复制对话（Duplicate）：深拷贝消息 / 任务规划 / 模型上下文 / 设置，生成新对话。
 * 标题加「 副本」后缀；归自己所有、不归档、不置顶、不继承手动顺序（回到默认序）。
 */
export async function duplicateConversation(id: string, ownerKey?: string): Promise<ConversationDoc | null> {
  const src = await getFullConversation(id);
  if (!src) return null;
  // 归属校验：无主遗留可复制（与可见性同口径），有主须匹配。
  if (src.ownerKey && src.ownerKey !== ownerKey) return null;
  const newId = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const clone = JSON.parse(JSON.stringify(src)) as ConversationDoc;
  const doc: ConversationDoc = {
    ...clone,
    _id: undefined,
    id: newId,
    title: `${src.title || "对话"} 副本`,
    createdAt: now,
    updatedAt: now,
    archived: false,
    pinnedAt: null,
    sortOrder: undefined,
    ...(ownerKey ? { ownerKey } : {}),
  };
  const coll = await getColl();
  if (!coll) {
    memory.set(newId, doc);
    return doc;
  }
  await coll.insertOne(doc as ConversationDoc & { _id?: ObjectId });
  return getConversation(newId);
}

/** 渲染对话为 Markdown（导出用）。 */
export function renderConversationMarkdown(doc: ConversationDoc): string {
  const lines: string[] = [];
  lines.push(`# ${doc.title || "对话"}`);
  lines.push("");
  lines.push(`- 导出时间：${new Date().toISOString()}`);
  lines.push(`- 对话 ID：${doc.id}`);
  const created = doc.createdAt ? new Date(doc.createdAt).toLocaleString() : "未知";
  lines.push(`- 创建时间：${created}`);
  lines.push("");
  const messages = doc.messages || [];
  for (const msg of messages) {
    const who = msg.role === "user" ? "用户" : "助手";
    lines.push(`## ${who}`);
    lines.push("");
    lines.push(msg.text || "");
    if (msg.thinking) {
      lines.push("");
      lines.push("> 思考过程：");
      lines.push("");
      lines.push(msg.thinking);
    }
    if (msg.steps?.length) {
      lines.push("");
      lines.push(`> 工具：${msg.steps.map((s) => `${s.name}(${s.status})`).join("、")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
