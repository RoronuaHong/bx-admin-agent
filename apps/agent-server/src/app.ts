import { Hono, type Context } from "hono";
import type { ApiErrorPayload, LocalizedToken, TodoItem } from "@bx/shared";
import { cors } from "hono/cors";
import { getCookie, setCookie } from "hono/cookie";
import { config, listModels } from "./config.js";
import { answerConfirmation } from "./confirm.js";
import { connect, disconnect, listStatuses, reload } from "./mcp/hub.js";
import {
  deleteServer,
  loadServers,
  toPublic,
  upsertServer,
  validateServerInput,
  type McpServerConfig,
} from "./mcp/config.js";
import { ensureSession, SESSION_COOKIE, touchSession, type Session } from "./session.js";
import { resolveOwner } from "./owner.js";
import { addMemory, clearMemory, listMemory, removeMemory } from "./memory.js";
import { appendAudit, listAuditEvents, type AuditDecision } from "./audit.js";
import {
  addConversationReadGrant,
  clearContext,
  conversationOwnedBy,
  clearConversation,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listEnabledMcpServers,
  patchConversation,
  pullMcpServerFromAllConversations,
  duplicateConversation,
  getFullConversation,
  renderConversationMarkdown,
  reorderConversations,
  resolveConversation,
  upsertMessages,
  type ConversationPatch,
  type PendingMessage,
  type StoredMessage,
} from "./conversations.js";
import { chatStream, cancelSubagent, cancelSubagentsOfConversation } from "./chat.js";
import { listSelectableSkillMetas, listSkillMetas } from "./skills.js";
import { hasRole } from "./roles.js";
import {
  cancelTask,
  countRunningForOwner,
  detachTask,
  finishTask,
  finalTextOf,
  followTask,
  getLastTaskSummary,
  getRunningTask,
  isTaskRunning,
  publishTaskEvent,
  startTask,
  type ChatTask,
} from "./chat-tasks.js";
import { fsList, fsRead, fsRemoveConversation } from "./fs-store.js";
import { getRelease, listRunTraces, newRunId, appendRunTrace, type RunStatus, type RunTrace } from "./trace.js";
import { summarizeCost } from "./cost.js";
import { hitRateLimit } from "./rate-limit.js";
import {
  countSchedulesOf,
  createSchedule,
  deleteSchedule,
  listSchedules,
  MAX_SCHEDULES_PER_OWNER,
  patchSchedule,
  startScheduleLoop,
  validateCron,
} from "./schedules.js";
import { MAX_AT_ONCE, getUploadImage, saveUpload } from "./uploads.js";

const COOKIE = SESSION_COOKIE;

// 会话中间件写入的上下文变量类型声明，使 c.set("session") / c.get("session") 类型安全。
declare module "hono" {
  interface ContextVariableMap {
    session: Session;
    /** 设备 owner 标识（轻量归属隔离）：同一中间件解析，守卫函数按它过滤。 */
    owner: string;
  }
}

/**
 * 对话级并发保护由 chat-tasks 注册表承担（异步任务底座）：
 * 同一对话同时只允许一条流在写 context —— 第二个请求返回 409，由前端转入待发队列。
 * 不同对话互不影响，可真正并行。
 */
// 单条用户输入上限（字符）：超出直接截断，避免超长输入打爆模型上下文。
const MAX_INPUT_LEN = Math.max(1, Number(process.env.CHAT_MAX_INPUT_LEN || 8000));
// 入口限流（0 = 关闭）：每 owner 每分钟发起对话次数 + 每 owner 并发运行中的对话任务数。
const RATE_STREAM_PER_MIN = Math.max(0, Number(process.env.RATE_LIMIT_STREAM_PER_MIN ?? 20));
const RATE_CONCURRENT_PER_OWNER = Math.max(0, Number(process.env.RATE_LIMIT_CONCURRENT_PER_OWNER ?? 3));

/** 从任务事件缓冲提取 run 级统计（usage / model / error 事件），落 run 级 trace。
 * model：buffer 有 model 事件时优先用它；该事件在**起始**发射，长 run 会被 chat-tasks.ts 的
 * 缓冲上限裁掉，故以 chatStream 旁路 sink 记录的 **实际服务模型**（servedModelId）兜底。
 * 未发起过模型调用的 run（校验失败等）sink 不写入，model 如实留空——不臆造配置模型。 */
function buildRunTrace(task: ChatTask, runId: string, status: RunStatus, sessionId?: string, ownerKey?: string, servedModelId?: string): RunTrace {
  const reversed = [...task.buffer].reverse();
  const usage = reversed.find((event) => event.type === "usage");
  const modelEvent = reversed.find((event) => event.type === "model");
  const errorEvent = reversed.find((event) => event.type === "error");
  const model = modelEvent?.id || servedModelId || undefined;
  return {
    runId,
    at: task.startedAt,
    conversationId: task.conversationId,
    ...(sessionId ? { sessionId } : {}),
    ...(ownerKey ? { ownerKey } : {}),
    userText: task.userText.slice(0, 200),
    ...(model ? { model } : {}),
    status,
    durationMs: (task.settledAt || Date.now()) - task.startedAt,
    ...(usage ? { rounds: usage.rounds, toolCalls: usage.toolCalls, tokens: usage.tokens, costTokens: usage.costTokens, modelRetries: usage.modelRetries, modelFallbacks: usage.modelFallbacks, groundingRetries: usage.groundingRetries, groundingVerifications: usage.groundingVerifications, ungrounded: usage.ungrounded } : {}),
    ...(errorEvent ? { error: String(errorEvent.message || errorEvent.error?.defaultMessage || "") } : {}),
    release: getRelease(),
  };
}

/**
 * 后台消费一个聊天任务：驱动 chatStream 把事件推进任务缓冲，收束后按状态落摘要与 run 级 trace；
 * 客户端已断开（无订阅者）时，服务端代为把 (用户输入, 最终回复) 回投进对话的 UI 消息快照，
 * 否则刷新后这一轮凭空消失（上下文在、界面看不到）。
 */
async function consumeTask(
  task: ChatTask,
  opts: { model?: string; images?: string[]; attachments?: string[]; sessionId?: string; ownerKey?: string },
): Promise<void> {
  const runId = newRunId();
  let status: RunStatus = "failed";
  let outcomePersisted = false;
  // run 级追踪旁路 sink：chatStream 在此记录实际服务模型（first-class，不依赖受限的事件缓冲）。
  const traceMeta: { servedModel?: string } = {};
  try {
    for await (const event of chatStream(task.conversationId, task.userText, opts, task.abort.signal, traceMeta)) {
      publishTaskEvent(task, event);
    }
    // 诚实状态：生成器正常结束但产出过 error 事件（如无模型/模型失败）→ 标 failed 而非 success。
    const hadError = task.buffer.some((event) => event.type === "error");
    status = hadError ? "failed" : "success";
    finishTask(task, status, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : "请求失败";
    if (task.abort.signal.aborted) {
      status = "cancelled";
      finishTask(task, "cancelled", false);
    } else {
      status = "failed";
      console.error(`[chat/task] ${task.id} failed:`, error);
      publishTaskEvent(task, {
        type: "error",
        error: { code: "CHAT_TASK_FAILED", defaultMessage: message },
        message,
      });
      finishTask(task, "failed", false);
    }
  }
  // run 级追踪（§10 最小版）：每次任务收束落一行 JSONL。
  // model 只认 chatStream 旁路 sink 的**实际服务模型**：长 run 起始 model 事件被缓冲裁剪也不受影响，
  // 未真正发起模型调用的 run（如 0ms 校验失败）sink 为空 → model 留空，不臆造配置模型。
  appendRunTrace(
    buildRunTrace(task, runId, status, opts.sessionId, opts.ownerKey, traceMeta.servedModel),
  );
  // 结果回投：仅在客户端已断开时做（订阅者在线时由前端负责 UI 消息持久化，避免双写竞态）。
  if (!task.live) {
    outcomePersisted = await persistTaskOutcome(task).catch(() => false);
    if (outcomePersisted) console.log(`[chat/task] ${task.id} 结果已回投（客户端断开）`);
  }
  const summary = getLastTaskSummary(task.conversationId);
  if (summary) summary.outcomePersisted = outcomePersisted;
}

/** 把任务收束结果写进对话 UI 消息快照（upsertMessages 是全量替换，需先读后并）。 */
async function persistTaskOutcome(task: ChatTask): Promise<boolean> {
  let finalText = finalTextOf(task).trim();
  const hasToolCalls = task.buffer.some((event) => event.type === "tool_call");
  if (!finalText && !hasToolCalls && task.status === "failed") return false;
  if (!finalText) finalText = task.status === "cancelled" ? "（已停止生成）" : "（生成未产出内容）";
  const doc = await getConversation(task.conversationId);
  const resultOk = new Map<string, boolean>();
  for (const event of task.buffer) {
    if (event.type === "tool_result") resultOk.set(event.id, event.ok);
  }
  const steps = task.buffer
    .filter((event) => event.type === "tool_call")
    .map((event) => ({
      name: event.name,
      status: resultOk.get(event.id) === false ? "error" : "ok",
    }));
  // 推理面板相关字段重建（与前端 toStored 对称）：客户端断开后由服务端代为落库，
  // 思考过程 / 任务规划必须从事件缓冲里拼回，否则刷新后推理面板内容丢失。
  let thinking = "";
  let todos: TodoItem[] | undefined;
  for (const event of task.buffer) {
    if (event.type === "thinking_delta") thinking += event.text;
    else if (event.type === "todos") todos = event.todos;
  }
  const messages = [
    ...((doc?.messages || []) as StoredMessage[]),
    {
      role: "user" as const,
      text: task.userText,
    },
    {
      role: "assistant" as const,
      text: finalText,
      ...(thinking ? { thinking } : {}),
      ...(todos?.length ? { todos } : {}),
      ...(steps.length ? { steps } : {}),
    },
  ];
  await upsertMessages({ id: task.conversationId, messages });
  return true;
}

function token(code: string, defaultMessage?: string): LocalizedToken {
  return { code, defaultMessage };
}

function errorJson(c: Context, status: number, code: string, defaultMessage?: string) {
  const body: ApiErrorPayload & { message?: string; code?: string } = {
    error: token(code, defaultMessage),
    code,
    ...(defaultMessage ? { message: defaultMessage } : {}),
  };
  return c.json(body, status as never);
}

function cookieOpts() {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "Lax" as const,
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  };
}

async function readJson<T>(c: Context): Promise<T> {
  return c.req.json<T>().catch(() => ({} as T));
}

/** 按端点主机推导模型服务商来源（基础设施信息，仅用于下拉展示）。 */
function resolveModelSource(baseUrl: string, provider: string): string {
  const host = (baseUrl || "").replace(/^https?:\/\//, "").split("/")[0] || "";
  if (host.includes("integrate.api.nvidia.com")) return "NVIDIA";
  if (host.includes("opencode.ai")) return "Zen";
  if (host.includes("tokenhub.tencentmaas.com")) return "TokenHub";
  return provider;
}

export function createApp() {
  const app = new Hono();
  // CORS 来源：以配置 webOrigin 为主，额外允许 CHAT_CORS_ORIGINS（逗号分隔）与本地开发端口。
  const corsOrigins = Array.from(
    new Set([
      config.webOrigin,
      ...(process.env.CHAT_CORS_ORIGINS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      "http://localhost:5173",
      "http://localhost:5174",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:5174",
    ]),
  );

  app.use(
    "*",
    cors({
      origin: corsOrigins,
      credentials: true,
    }),
  );

  // 请求日志：method / path / 状态码 / 耗时，便于排查与审计。
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    console.log(`[http] ${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - start}ms`);
  });

  // 基础安全响应头（内联实现，避免额外依赖）。
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
  });

  // 会话中间件（仅 chat 域）：统一解析匿名 cookie 会话 + 设备 owner（轻量归属隔离），
  // 新会话/新 owner 时回写 cookie，handler 直接取 c.get("session") / c.get("owner")。
  app.use("/chat/*", async (c, next) => {
    const sessionId = getCookie(c, COOKIE);
    const session = ensureSession(sessionId);
    if (session.id !== sessionId) setCookie(c, COOKIE, session.id, cookieOpts());
    c.set("session", session);
    c.set("owner", resolveOwner(c));
    await next();
  });

  /** 归属守卫：对话不存在或不属于当前设备 → 统一 404（不区分两种情况，不泄漏存在性）。 */
  async function conversationNotFoundFor(c: Context, id: string): Promise<boolean> {
    const owner = c.get("owner");
    return !(await conversationOwnedBy(id, owner));
  }

  app.get("/health", (c) => c.json({ ok: true, release: getRelease() }));

  // ---- 运行追踪（§10 最小版）：按 owner 过滤的 run 级查询（全局视角留给 CLI 直读 JSONL）----
  app.get("/chat/trace/runs", (c) => {
    const limit = Number(c.req.query("limit")) || 50;
    const conversationId = c.req.query("conversationId") || undefined;
    const runs = listRunTraces({ ownerKey: c.get("owner"), conversationId, limit });
    return c.json({ release: getRelease(), runs });
  });

  // ---- 成本计量（§12 最小版）：按日 / 模型聚合 + 预算告警；未配单价只计 token，不编造金额 ----
  app.get("/chat/cost/summary", (c) => {
    const days = Number(c.req.query("days")) || 7;
    return c.json(summarizeCost({ ownerKey: c.get("owner"), days }));
  });

  // ---- 安全审计留痕查询（写操作安全闸门 P0-7 的读侧）：只写不查等于半个能力 ----
  // 最小权限：HTTP 侧只返回本 owner 的事件与无主遗留事件，全局视角走 CLI 直读 JSONL。
  app.get("/chat/audit", (c) => {
    const decision = (c.req.query("decision") || "").trim();
    const events = listAuditEvents({
      ownerKey: c.get("owner"),
      limit: Number(c.req.query("limit")) || 100,
      ...(c.req.query("fromDay") ? { fromDay: c.req.query("fromDay") } : {}),
      ...(c.req.query("toDay") ? { toDay: c.req.query("toDay") } : {}),
      ...(c.req.query("tool") ? { tool: c.req.query("tool") } : {}),
      ...(decision ? { decision: decision as AuditDecision } : {}),
    });
    return c.json({ events });
  });

  // ---- 定时任务（§8：调度器复用对话任务底座；结果回投让用户回来就能看到）----
  app.get("/chat/schedules", async (c) => {
    const conversationId = c.req.query("conversationId") || undefined;
    let list = await listSchedules(c.get("owner"));
    if (conversationId) list = list.filter((s) => s.conversationId === conversationId);
    return c.json({ schedules: list });
  });

  app.post("/chat/schedules", async (c) => {
    const body = await readJson<{ conversationId?: string; prompt?: string; cron?: string }>(c);
    const conversationId = String(body.conversationId || "").trim();
    const prompt = String(body.prompt || "").trim();
    const cron = String(body.cron || "").trim();
    if (!conversationId || !prompt || !cron) {
      return errorJson(c, 400, "SCHEDULE_INVALID", "conversationId / prompt / cron 必填");
    }
    if (await conversationNotFoundFor(c, conversationId)) {
      return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    }
    const cronError = validateCron(cron);
    if (cronError) return errorJson(c, 400, "SCHEDULE_INVALID_CRON", cronError);
    const owner = c.get("owner");
    if ((await countSchedulesOf(owner)) >= MAX_SCHEDULES_PER_OWNER) {
      return errorJson(c, 400, "SCHEDULE_LIMIT", `每个设备最多 ${MAX_SCHEDULES_PER_OWNER} 个定时任务`);
    }
    const schedule = await createSchedule({ conversationId, ownerKey: owner, prompt, cron });
    return c.json({ schedule });
  });

  app.patch("/chat/schedules/:id", async (c) => {
    const body = await readJson<{ prompt?: string; cron?: string; enabled?: boolean }>(c);
    if (body.cron !== undefined) {
      const cronError = validateCron(String(body.cron));
      if (cronError) return errorJson(c, 400, "SCHEDULE_INVALID_CRON", cronError);
    }
    const updated = await patchSchedule(c.req.param("id"), c.get("owner"), body);
    if (!updated) return errorJson(c, 404, "SCHEDULE_NOT_FOUND", "定时任务不存在");
    return c.json({ schedule: updated });
  });

  app.delete("/chat/schedules/:id", async (c) => {
    const ok = await deleteSchedule(c.req.param("id"), c.get("owner"));
    if (!ok) return errorJson(c, 404, "SCHEDULE_NOT_FOUND", "定时任务不存在");
    return c.json({ ok: true });
  });

  // ---- MCP 服务器管理（全局配置；凭据只写不回显）----
  app.get("/mcp/servers", (c) => c.json({ servers: loadServers().map(toPublic) }));

  app.post("/mcp/servers", async (c) => {
    const body = await readJson<Partial<McpServerConfig>>(c);
    const invalid = validateServerInput(body);
    if (invalid) return errorJson(c, 400, "MCP_SERVER_INVALID", invalid);
    const saved = upsertServer(body as McpServerConfig);
    return c.json({ server: toPublic(saved) });
  });

  app.delete("/mcp/servers/:id", async (c) => {
    const id = c.req.param("id");
    if (!deleteServer(id)) return errorJson(c, 404, "MCP_SERVER_NOT_FOUND", "服务器不存在");
    // 配置删除后断开连接，并从所有对话的启用集里摘除（避免悬空引用）。
    await disconnect(id);
    await pullMcpServerFromAllConversations(id);
    return c.json({ ok: true });
  });

  app.post("/mcp/servers/:id/reload", async (c) => {
    const status = await reload(c.req.param("id"));
    if (!status) return errorJson(c, 404, "MCP_SERVER_NOT_FOUND", "服务器不存在");
    return c.json({ status });
  });

  // ---- 对话级 MCP 启用集（按对话持久化，不再是 cookie 级的全局启用集）----
  // 会话靠匿名 cookie 识别：首次访问要回写 cookie，否则每次请求都是新会话。
  app.get("/chat/mcp/servers", async (c) => {
    const session = c.get("session") as Session;
    const conversationId = c.req.query("conversationId") || session.activeConversationId || "";
    const owned = conversationId ? await conversationOwnedBy(conversationId, c.get("owner")) : false;
    const doc = owned && conversationId ? await getConversation(conversationId) : null;
    const available = listStatuses();
    const known = new Set(available.map((s) => s.id));
    const stored = doc?.mcpServers || [];
    // 只回报「当前配置里确实存在」的启用项：服务器被从 .env / 配置文件里移除后，
    // 对话的启用集里会留下悬空 id（服务器早没了、id 还在），原样回报会让前端按它计数——
    // 表现为面板里一个勾都没有、角标却显示 1。
    // 这里**只过滤、不落库**：GET 是安全方法，写操作由启动维护（pruneUnknownMcpServers）
    // 与写入路径（下面的 PUT、DELETE /mcp/servers/:id）负责。
    const enabled = stored.filter((id) => known.has(id));
    return c.json({ conversationId, available, enabled });
  });

  app.put("/chat/mcp/servers", async (c) => {
    const body = await readJson<{ conversationId?: string; enabled?: string[] }>(c);
    const session = c.get("session") as Session;
    const conversationId = await resolveConversation(
      session,
      typeof body.conversationId === "string" && body.conversationId ? body.conversationId : undefined,
      c.get("owner"),
    );
    if (await conversationNotFoundFor(c, conversationId)) {
      return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    }
    const doc = await getConversation(conversationId);
    const prev = new Set(doc?.mcpServers || []);
    const available = listStatuses();
    const known = new Set(available.map((s) => s.id));
    const next = new Set(
      (Array.isArray(body.enabled) ? body.enabled.filter((x): x is string => typeof x === "string") : []).filter(
        // 落盘前就挡住不存在的 id：悬空引用一旦写进对话文档，就只能靠读取时兜底（见上面的 GET）。
        (id) => known.has(id),
      ),
    );
    await patchConversation(conversationId, { mcpServers: [...next] });
    // 新勾选的立即建连（异步，不阻塞响应）；取消勾选的，只有当**没有任何对话**再用时才断开。
    const used = await listEnabledMcpServers();
    for (const id of next) if (!prev.has(id)) void connect(id);
    for (const id of prev) {
      if (next.has(id) || used.has(id)) continue;
      void disconnect(id);
    }
    return c.json({ conversationId, enabled: [...next], available });
  });

  // ---- 对话级技能（Skills）启用集：与 MCP 启用集同构（按对话持久化）----
  // available = skills 目录索引（name/description/dir）；enabled = 用户勾选的目录名。
  app.get("/chat/skills", async (c) => {
    const session = c.get("session") as Session;
    const conversationId = c.req.query("conversationId") || session.activeConversationId || "";
    const owned = conversationId ? await conversationOwnedBy(conversationId, c.get("owner")) : false;
    const doc = owned && conversationId ? await getConversation(conversationId) : null;
    return c.json({
      conversationId,
      // 面板只列**可勾选**的技能：按对话角色过滤（观影对话只见 generic + movie 技能），
      // 并排除默认生效的技能（`default: true`，它们本来就随索引生效，不需要用户勾选）。
      available: listSelectableSkillMetas(doc?.agentId || "generic"),
      enabled: doc?.skillsEnabled || [],
    });
  });

  app.put("/chat/skills", async (c) => {
    const body = await readJson<{ conversationId?: string; enabled?: string[] }>(c);
    const session = c.get("session") as Session;
    const conversationId = await resolveConversation(
      session,
      typeof body.conversationId === "string" && body.conversationId ? body.conversationId : undefined,
      c.get("owner"),
    );
    if (await conversationNotFoundFor(c, conversationId)) {
      return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    }
    // 只接受真实存在的技能目录名；去重。不存在的目录名直接丢弃（诚实：不落库不存在的技能）。
    // 校验用 **全量** 清单而非面板清单：默认技能（default: true）不再出现在面板里，
    // 但历史对话可能已经勾选过它们，此时不能因为「面板不显示」就把已有勾选判为非法。
    const known = new Set(listSkillMetas().map((s) => s.dir));
    const next = [...new Set((Array.isArray(body.enabled) ? body.enabled : []).filter((x) => typeof x === "string" && known.has(x)))];
    await patchConversation(conversationId, { skillsEnabled: next });
    return c.json({ conversationId, enabled: next, available: listSelectableSkillMetas() });
  });

  // ---- 工具调用二次确认回调（一次性票据 + 会话归属校验，写操作安全闸门 P0-4）----
  app.post("/chat/confirm", async (c) => {
    const body = await readJson<{
      ticket?: string;
      callId?: string;
      confirmed?: boolean;
      grantRead?: boolean;
      /** 澄清类票据带回的选项值（结构化澄清 request_clarification）。 */
      value?: string;
    }>(c);
    // ticket 为主；callId 仅作旧前端兼容，但同样必须通过会话归属校验。
    const ticket = body.ticket || body.callId;
    if (!ticket) return errorJson(c, 400, "CHAT_CONFIRM_MISSING_TICKET", "缺少 ticket");
    const session = c.get("session") as Session;
    const res = answerConfirmation(ticket, session.id, body.confirmed === true, body.value);
    if (!res.ok) {
      appendAudit({
        kind: "gate",
        decision: "ownership_mismatch",
        sessionId: session.id,
        tool: "(confirm)",
        reason: res.reason,
        ticket,
      });
      return errorJson(c, 403, "CHAT_CONFIRM_OWNERSHIP_MISMATCH", res.reason || "该确认不属于当前会话");
    }
    // 会话级只读授权：批准时勾选 → 把该服务器写进对话 readGrants（仅对未声明级别工具生效）。
    if (body.grantRead === true && body.confirmed === true && res.conversationId && res.serverId) {
      await addConversationReadGrant(res.conversationId, res.serverId);
      appendAudit({
        kind: "gate",
        decision: "grant_read",
        sessionId: session.id,
        conversationId: res.conversationId,
        server: res.serverId,
        tool: "(confirm)",
        ticket,
      });
    }
    return c.json({ ok: true, confirmed: body.confirmed === true });
  });

  app.get("/models", (c) =>
    c.json({
      models: listModels().map((m) => ({
        id: m.id,
        label: m.label,
        provider: m.provider,
        source: resolveModelSource(m.baseUrl, m.provider),
        vision: m.vision,
      })),
    }),
  );

  // 一轮对话：用户输入 → 后台任务 → 流式回包（HTTP Streamable，NDJSON 分块）。
  // 执行与推送解耦：HTTP 连接只是订阅者；断开（停止按钮之外的断网/关页）任务照跑，
  // 收束后结果回投进对话消息快照，重连可用 GET /chat/task/events 续传。
  app.post("/chat/stream", async (c) => {
    try {
      const body = await readJson<{ text?: string; model?: string; images?: string[]; attachments?: string[]; conversationId?: string; agentId?: string }>(c);
      const text = String(body.text || "").trim().slice(0, MAX_INPUT_LEN);
      if (!text) return errorJson(c, 400, "CHAT_EMPTY_INPUT", "请输入内容");
      if (body.agentId !== undefined && body.agentId !== "" && !hasRole(body.agentId)) {
        return errorJson(c, 400, "AGENT_ROLE_UNKNOWN", `未知 Agent 角色：${body.agentId}`);
      }
      const session = c.get("session") as Session;

      // 解析本次所属对话（thread）：显式传入优先；否则按角色取活跃对话
      // （首次访问会创建「默认对话」并把旧 session.messages / mcpServers 迁移进去）。
      const conversationId = await resolveConversation(
        session,
        typeof body.conversationId === "string" ? body.conversationId : undefined,
        c.get("owner"),
        typeof body.agentId === "string" && body.agentId ? body.agentId : undefined,
      );
      // 归属守卫：别人的对话统一 404（不泄漏存在性）。
      if (await conversationNotFoundFor(c, conversationId)) {
        return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
      }
      // 活跃槽：generic 走旧字段；其余角色走分槽映射（多 Agent 页面互不顶掉）。
      const reqAgentId = typeof body.agentId === "string" && body.agentId ? body.agentId : "generic";
      if (reqAgentId === "generic") {
        if (session.activeConversationId !== conversationId) {
          session.activeConversationId = conversationId;
          touchSession(session);
        }
      } else if (session.activeByAgent?.[reqAgentId] !== conversationId) {
        session.activeByAgent = session.activeByAgent || {};
        session.activeByAgent[reqAgentId] = conversationId;
        touchSession(session);
      }

      // 对话级并发保护：同一对话已有任务在跑 → 409，前端据此把消息转入待发队列（排队语义）。
      if (isTaskRunning(conversationId)) {
        return errorJson(c, 409, "CONVERSATION_BUSY", "该对话正在生成中：消息可排队，或先停止当前生成");
      }
      // 入口限流（§5/§13）：每 owner 每分钟次数 + 每 owner 并发任务数；429 带 Retry-After。
      const owner = c.get("owner");
      const rate = hitRateLimit(`stream:${owner}`, RATE_STREAM_PER_MIN);
      if (!rate.allowed) {
        c.header("Retry-After", String(rate.retryAfterSec));
        return errorJson(c, 429, "CHAT_RATE_LIMITED", `发起太频繁，请 ${rate.retryAfterSec} 秒后再试`);
      }
      if (RATE_CONCURRENT_PER_OWNER > 0 && countRunningForOwner(owner) >= RATE_CONCURRENT_PER_OWNER) {
        return errorJson(c, 429, "CHAT_CONCURRENT_LIMITED", `同时运行的对话数已达上限（${RATE_CONCURRENT_PER_OWNER}），请稍候`);
      }
      const task = startTask({ conversationId, userText: text, ownerKey: owner });
      void consumeTask(task, {
        model: typeof body.model === "string" ? body.model : undefined,
        images: Array.isArray(body.images) ? body.images.filter((x): x is string => typeof x === "string") : [],
        attachments: Array.isArray(body.attachments)
          ? body.attachments.filter((x): x is string => typeof x === "string")
          : [],
        sessionId: session.id,
        ownerKey: owner,
      });

      return streamNdjson(async (send) => {
        try {
          for await (const event of followTask(task)) {
            send(event);
          }
        } finally {
          // 订阅结束（正常收束 / 客户端断开）：摘除唤醒器并标记无订阅者。
          detachTask(task);
        }
      });
    } catch (error) {
      console.error("[chat/stream] error:", error);
      return errorJson(c, 500, "CHAT_STREAM_FAILED", error instanceof Error ? error.message : "请求失败");
    }
  });

  // ---- 异步任务端点（断线续传 / 显式取消 / 状态查询）----

  // 断线重连续传：回放任务事件缓冲并继续跟随（客户端用同一套 NDJSON 解析逻辑消费）。
  app.get("/chat/task/events", async (c) => {
    const conversationId = c.req.query("conversationId") || "";
    if (await conversationNotFoundFor(c, conversationId)) {
      return errorJson(c, 404, "CHAT_TASK_NOT_FOUND", "该对话没有进行中或最近的任务");
    }
    const task = getRunningTask(conversationId);
    const finished = getLastTaskSummary(conversationId);
    if (!task && !finished) {
      return errorJson(c, 404, "CHAT_TASK_NOT_FOUND", "该对话没有进行中或最近的任务");
    }
    return streamNdjson(async (send) => {
      if (task) {
        for await (const event of followTask(task)) send(event);
      } else if (finished) {
        // 已收束：回放最近一次任务的缓冲没有留档（缓冲随任务销毁），给一个明确的终态事件。
        send({ type: "error", error: { code: "CHAT_TASK_ALREADY_SETTLED", defaultMessage: "任务已收束，结果已回投到对话记录" }, message: "任务已收束" });
        send({ type: "done" });
      }
    });
  });

  // 显式取消（前端「停止」按钮）：协作式中止，abort 信号贯穿模型调用与工具执行。
  // 归属守卫：不能取消别人的任务（不存在/别人的对话统一 running=false，不泄漏）。
  app.post("/chat/cancel", async (c) => {
    const body = await readJson<{ conversationId?: string }>(c);
    const conversationId = String(body.conversationId || "").trim();
    if (!conversationId) return errorJson(c, 400, "CHAT_TASK_MISSING_CONVERSATION", "缺少 conversationId");
    if (await conversationNotFoundFor(c, conversationId)) {
      return c.json({ ok: false, running: false });
    }
    const ok = cancelTask(conversationId);
    cancelSubagentsOfConversation(conversationId);
    return c.json({ ok, running: isTaskRunning(conversationId) });
  });

  // 独立取消某一个运行中的子代理（不影响主代理继续运行）。
  app.post("/chat/subagent/:conversationId/:subagentId/cancel", async (c) => {
    const conversationId = c.req.param("conversationId");
    const subagentId = c.req.param("subagentId");
    if (await conversationNotFoundFor(c, conversationId)) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    const cancelled = cancelSubagent(conversationId, subagentId);
    return c.json({ ok: true, cancelled });
  });

  // 任务状态（跑没跑、最近一次收束摘要），供前端断线后判断「后台还在跑吗」。
  app.get("/chat/task/status", async (c) => {
    const conversationId = c.req.query("conversationId") || "";
    const owned = await conversationOwnedBy(conversationId, c.get("owner"));
    const task = owned ? getRunningTask(conversationId) : undefined;
    const last = owned ? getLastTaskSummary(conversationId) : undefined;
    return c.json({
      conversationId,
      running: Boolean(task),
      ...(task
        ? {
            task: { id: task.id, startedAt: task.startedAt, elapsedMs: Date.now() - task.startedAt, live: task.live },
          }
        : {}),
      ...(last ? { last } : {}),
    });
  });

  // ---- 长期记忆（跨对话注入的小体积事实，持久化在 .data/memory.json；按 owner 隔离）----
  app.get("/chat/memory", (c) => c.json({ memory: listMemory(c.get("owner")) }));

  app.post("/chat/memory", async (c) => {
    const body = await readJson<{ text?: string }>(c);
    const text = String(body.text || "").trim();
    if (!text) return errorJson(c, 400, "MEMORY_EMPTY_TEXT", "请输入要记住的内容");
    return c.json({ memory: addMemory(text, c.get("owner")) });
  });

  // 删单条；不带 id 的 DELETE /chat/memory 表示清空（只清自己可见的）。
  app.delete("/chat/memory/:id", (c) => c.json({ ok: removeMemory(c.req.param("id"), c.get("owner")) }));
  app.delete("/chat/memory", (c) => {
    clearMemory(c.get("owner"));
    return c.json({ ok: true });
  });

  // 观影助手：原「个性化推荐 / 画像 / 反馈」5 个 HTTP 端点已于 2026-09-18 随推荐管线一并移除
  // （前端推荐面板先被删除，而这条离线管线又是豆瓣 MCP 专用：换源 TMDb 后工具名与返回格式都变了）。
  // 口味记录仍有入口：内置工具 `record_watched_movies`（builtins.ts）直接写画像，不经 HTTP。

  // ---- 聊天记录持久化 ----
  app.get("/chat/conversations", async (c) => {
    // 归属过滤：只看自己创建的 + 无主遗留（升级前的旧数据）。
    const includeArchived = c.req.query("includeArchived") === "1";
    // 多 Agent 分槽：?agentId=movie 只返回观影对话（generic 含缺省 agentId 的旧数据）。
    const agentId = c.req.query("agentId") || undefined;
    const list = await listConversations(c.get("owner"), includeArchived, agentId);
    // running：该对话是否有正在进行的流（进程内存态，不持久化），供侧栏标记"生成中"。
    return c.json({
      conversations: list.map((doc) => ({ ...doc, running: isTaskRunning(doc.id) })),
    });
  });

  app.post("/chat/conversations", async (c) => {
    const body = await readJson<{ id?: string; title?: string; agentId?: string }>(c);
    // 角色合法性在服务端判定（前端不实现角色逻辑）；未知角色直接拒绝，防脏数据。
    if (body.agentId !== undefined && !hasRole(body.agentId)) {
      return errorJson(c, 400, "AGENT_ROLE_UNKNOWN", `未知 Agent 角色：${body.agentId}`);
    }
    const id = body.id || `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const agentId = body.agentId || "generic";
    // 新对话不带任何对话级设置（model / mcpServers / locale 均为空）→ 前端默认"不选中 MCP"；带 owner 标注。
    const doc = await createConversation({ id, title: body.title || "新对话", ownerKey: c.get("owner"), ...(agentId !== "generic" ? { agentId } : {}) });
    // 新建即激活：让仍不带 conversationId 的旧客户端也落在新对话上，
    // 否则回退到 activeConversationId 会读到上一个对话的启用集（新对话看起来"默认勾了 MCP"）。
    const session = c.get("session") as Session;
    if (agentId === "generic") session.activeConversationId = id;
    else {
      session.activeByAgent = session.activeByAgent || {};
      session.activeByAgent[agentId] = id;
    }
    touchSession(session);
    return c.json({ conversation: { ...doc, running: isTaskRunning(id) } });
  });

  app.post("/chat/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (await conversationNotFoundFor(c, id)) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    const body = await readJson<{ messages?: StoredMessage[]; title?: string }>(c);
    if (!Array.isArray(body.messages)) {
      return errorJson(c, 400, "CHAT_CONVERSATION_INVALID_MESSAGES", "messages 必须为数组");
    }
    await upsertMessages({ id, messages: body.messages, title: body.title });
    return c.json({ ok: true });
  });

  app.delete("/chat/conversations/:id", async (c) => {
    const id = c.req.param("id");
    if (await conversationNotFoundFor(c, id)) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    cancelTask(id); // 解耦后必须先中止后台任务：否则任务收束时的 upsert 会「复活」已删对话
    await deleteConversation(id);
    fsRemoveConversation(id); // 级联清理该对话的虚拟工作区
    // 删掉的正好是活跃对话时清空指针，避免回退到一个已不存在的 id。
    const session = c.get("session") as Session;
    if (session.activeConversationId === id) {
      session.activeConversationId = "";
      touchSession(session);
    }
    return c.json({ ok: true });
  });

  app.post("/chat/conversations/:id/clear", async (c) => {
    const id = c.req.param("id");
    if (await conversationNotFoundFor(c, id)) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    await clearConversation(id);
    return c.json({ ok: true });
  });

  // ---- 对话级设置与上下文（thread）----
  // 列表接口不带 context（体积大），切对话时用它单独取全量。
  app.get("/chat/conversations/:id", async (c) => {
    const id = c.req.param("id");
    if (await conversationNotFoundFor(c, id)) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    const doc = await getConversation(id);
    if (!doc) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    // 返回时带 running：支持"刷新后仍能看到该对话在生成中"（例如另一标签页在跑）。
    return c.json({ conversation: { ...doc, running: isTaskRunning(doc.id) } });
  });

  // 更新对话设置：标题 / 模型 / MCP 启用集 / 语言 / 待发队列 / 置顶（未提供的字段保持不变）。
  app.patch("/chat/conversations/:id", async (c) => {
    const id = c.req.param("id");
    if (await conversationNotFoundFor(c, id)) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    const body = await readJson<{
      title?: string;
      model?: string;
      mcpServers?: string[];
      locale?: string;
      pendingQueue?: PendingMessage[];
      pinnedAt?: number | null;
      archived?: boolean;
      /** 免打扰：静默该对话的后台完成提醒。 */
      muted?: boolean;
    }>(c);
    const patch: ConversationPatch = {};
    if (typeof body.title === "string") patch.title = body.title;
    if (typeof body.model === "string") patch.model = body.model;
    if (Array.isArray(body.mcpServers)) {
      patch.mcpServers = body.mcpServers.filter((x): x is string => typeof x === "string");
    }
    if (typeof body.locale === "string") patch.locale = body.locale;
    if (Array.isArray(body.pendingQueue)) patch.pendingQueue = body.pendingQueue;
    // 置顶：null = 取消置顶，数字 = 置顶时间戳。
    if (body.pinnedAt === null) patch.pinnedAt = null;
    else if (typeof body.pinnedAt === "number") patch.pinnedAt = body.pinnedAt;
    if (typeof body.archived === "boolean") patch.archived = body.archived;
    if (typeof body.muted === "boolean") patch.muted = body.muted;
    const updated = await patchConversation(id, patch);
    if (!updated) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    return c.json({ conversation: updated });
  });

  // 复制对话（Duplicate）：深拷贝消息/上下文/设置，生成带「 副本」后缀的新对话。
  app.post("/chat/conversations/:id/duplicate", async (c) => {
    const id = c.req.param("id");
    if (await conversationNotFoundFor(c, id)) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    const created = await duplicateConversation(id, c.get("owner"));
    if (!created) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    return c.json({ conversation: created });
  });

  // 导出对话 JSON（含模型上下文与任务规划；下载附件）。
  app.get("/chat/conversations/:id/export.json", async (c) => {
    const id = c.req.param("id");
    if (await conversationNotFoundFor(c, id)) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    const doc = await getFullConversation(id);
    if (!doc) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    const payload = JSON.stringify(doc, null, 2);
    c.header("Content-Type", "application/json; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="conversation-${id}.json"`);
    return c.body(payload);
  });

  // 导出对话 Markdown。
  app.get("/chat/conversations/:id/export.md", async (c) => {
    const id = c.req.param("id");
    if (await conversationNotFoundFor(c, id)) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    const doc = await getFullConversation(id);
    if (!doc) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    const payload = renderConversationMarkdown(doc);
    c.header("Content-Type", "text/markdown; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="conversation-${id}.md"`);
    return c.body(payload);
  });

  // 手动排序：body.ids 的下标即新顺序（一次提交，避免逐条 PATCH 的中间态与竞态）。
  // 归属过滤：别人（或不存在）的 id 直接丢弃，不做任何改动。
  app.post("/chat/conversations/reorder", async (c) => {
    const body = await readJson<{ ids?: string[] }>(c);
    if (!Array.isArray(body.ids)) {
      return errorJson(c, 400, "CHAT_CONVERSATION_INVALID_ORDER", "ids 必须为数组");
    }
    const owner = c.get("owner");
    const candidates = body.ids.filter((id): id is string => typeof id === "string");
    const owned: string[] = [];
    for (const id of candidates) {
      if (await conversationOwnedBy(id, owner)) owned.push(id);
    }
    await reorderConversations(owned);
    return c.json({ ok: true });
  });

  // 清空该对话的模型上下文（不影响 UI 消息快照）。
  app.post("/chat/conversations/:id/context/clear", async (c) => {
    const id = c.req.param("id");
    if (await conversationNotFoundFor(c, id)) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    await clearContext(id);
    return c.json({ ok: true });
  });

  // ---- 对话工作区（虚拟文件系统）：文件列表与内容预览（只读 UI；写走 fs_* 工具）----
  app.get("/chat/conversations/:id/files", async (c) => {
    const id = c.req.param("id");
    if (await conversationNotFoundFor(c, id)) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    return c.json({ conversationId: id, files: fsList(id) });
  });

  app.get("/chat/conversations/:id/files/content", async (c) => {
    const id = c.req.param("id");
    if (await conversationNotFoundFor(c, id)) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    const path = c.req.query("path") || "";
    // 大文件按行分页（与 fs_read 工具的 offset/limit 同语义：offset 从 0 起）。
    const offset = c.req.query("offset");
    const limit = c.req.query("limit");
    const paging = offset != null || limit != null ? { offset: Number(offset) || 0, limit: Number(limit) || 0 } : {};
    const result = fsRead(id, path, paging);
    if ("error" in result) return errorJson(c, 404, "WORKSPACE_FILE_NOT_FOUND", result.error);
    return c.json({ path, content: result.content, ...(result.totalLines ? { totalLines: result.totalLines } : {}) });
  });

  // ---- 设备级偏好（原前端 localStorage：主题 / 客户端默认语言 / 上次打开的对话 / 会话排序模式）----
  function prefsPayload(session: ReturnType<typeof ensureSession>) {
    return {
      activeConversationId: session.activeConversationId || "",
      theme: session.preferences?.theme || "",
      locale: session.preferences?.locale || "",
      convSortMode: session.preferences?.convSortMode || "recent",
      showArchived: session.preferences?.showArchived === true,
      // 客户端据此判断是否需要跑「旧的 localStorage 一次性迁移」。
      migratedAt: session.preferences?.migratedAt || 0,
    };
  }

  app.get("/chat/preferences", (c) => {
    const session = c.get("session") as Session;
    return c.json(prefsPayload(session));
  });

  app.put("/chat/preferences", async (c) => {
    const body = await readJson<{
      activeConversationId?: string;
      theme?: "light" | "dark";
      locale?: string;
      convSortMode?: string;
      showArchived?: boolean;
    }>(c);
    const session = c.get("session") as Session;
    // 归属守卫：活跃对话指针不允许指向别人的对话（否则后续不带 conversationId 的请求会串台）。
    if (typeof body.activeConversationId === "string" && body.activeConversationId) {
      if (await conversationOwnedBy(body.activeConversationId, c.get("owner"))) {
        session.activeConversationId = body.activeConversationId;
      }
    } else if (body.activeConversationId === "") {
      session.activeConversationId = "";
    }
    const prefs = session.preferences || {};
    if (body.theme === "light" || body.theme === "dark") prefs.theme = body.theme;
    if (typeof body.locale === "string") prefs.locale = body.locale;
    if (body.convSortMode === "recent" || body.convSortMode === "manual") prefs.convSortMode = body.convSortMode;
    if (typeof body.showArchived === "boolean") prefs.showArchived = body.showArchived;
    // 首次成功写偏好 = 客户端已把（可能来自旧 localStorage 的）偏好交到后端，迁移完成。
    if (!prefs.migratedAt) prefs.migratedAt = Date.now();
    session.preferences = prefs;
    touchSession(session);
    return c.json(prefsPayload(session));
  });

  app.post("/chat/upload", async (c) => {
    try {
      const form = await c.req.formData();
      const files = form.getAll("files") as Array<{
        name: string;
        type: string;
        size: number;
        arrayBuffer(): Promise<ArrayBuffer>;
      }>;
      if (!files.length) return errorJson(c, 400, "UPLOAD_NO_FILES", "未收到文件");
      if (files.length > MAX_AT_ONCE) {
        return errorJson(c, 400, "UPLOAD_TOO_MANY_FILES", `一次最多上传 ${MAX_AT_ONCE} 个文件`);
      }
      const saved = [];
      for (const file of files) {
        try {
          saved.push(await saveUpload(file));
        } catch (error) {
          return c.json(
            {
              message: error instanceof Error ? error.message : "文件保存失败",
              code: "UPLOAD_SAVE_FAILED",
              error: token("UPLOAD_SAVE_FAILED"),
            },
            400,
          );
        }
      }
      return c.json({ files: saved });
    } catch (error) {
      console.error("[chat/upload] error:", error);
      return errorJson(c, 500, "UPLOAD_FAILED", "上传失败");
    }
  });

  app.get("/chat/upload/:id", (c) => {
    const image = getUploadImage(c.req.param("id"));
    if (!image) return errorJson(c, 404, "UPLOAD_IMAGE_NOT_FOUND", "图片不存在或已过期");
    return new Response(new Uint8Array(image.data), {
      headers: {
        "Content-Type": image.mediaType,
        "Cache-Control": "private, max-age=604800",
      },
    });
  });

  // 全局兜底：未捕获异常统一返回 JSON 错误（而非 Hono 默认 HTML 500）。
  app.onError((err, c) => {
    console.error("[http] unhandled error:", err);
    return errorJson(c, 500, "INTERNAL_ERROR", "服务器内部错误");
  });

  // 未知路由统一返回 JSON 404（而非 Hono 默认 HTML 404）。
  app.notFound((c) => errorJson(c, 404, "NOT_FOUND", "资源不存在"));

  // ---- 定时调度循环（§8）：到点即复用对话任务底座执行——
  // 定时运行没有 HTTP 订阅者 → 收束后自动「结果回投」进对话消息快照。
  startScheduleLoop(async (schedule) => {
    if (isTaskRunning(schedule.conversationId)) return "skipped"; // 对话在跑：跳过本次，不排队
    const task = startTask({ conversationId: schedule.conversationId, userText: schedule.prompt });
    await consumeTask(task, { ownerKey: schedule.ownerKey });
    const status = getLastTaskSummary(schedule.conversationId)?.status;
    return status === "success" || status === "cancelled" ? status : "failed";
  });

  return app;
}

// HTTP Streamable 流式响应：分块传输（Transfer-Encoding: chunked）+ 每行一条 JSON（NDJSON）。
// 不用 SSE（text/event-stream），因为 vite dev 代理会缓冲 SSE 导致事件无法实时到达前端。
function streamNdjson(run: (send: (event: unknown) => void) => Promise<void>) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        await run(send);
      } catch (error) {
        // 流已开启后无法再改 HTTP 状态码，转成一条 error 事件推给前端。
        const message = error instanceof Error ? error.message : "请求失败";
        try {
          controller.enqueue(
            encoder.encode(
              JSON.stringify({ type: "error", message, code: "STREAM_ERROR", error: token("STREAM_ERROR") }) + "\n",
            ),
          );
        } catch {
          /* controller 已关闭则忽略 */
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* 已关闭则忽略 */
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
