import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type { ApiErrorPayload, ChatEvent, LocalizedToken } from "@bx/shared";
import { cors } from "hono/cors";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config, getCountry, listModels, listPublicCountries } from "./config.js";
import { clearSessionContext, createSession, deleteSession, getSession } from "./session.js";
import {
  clearConversation,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  ownerKeyOf,
  renameConversation,
  upsertMessages,
  TASK_RESULTS_CONV_ID,
  type StoredMessage,
} from "./conversations.js";
import { callUpstream } from "./upstream.js";
import { mockLogin } from "./mock-upstream.js";
import { chatStream, resolveConfirmWaiter } from "./chat.js";
import { MAX_AT_ONCE, getUploadImage, saveUpload } from "./uploads.js";
import { readDownloadBytes } from "./downloads.js";
import { attachMcp } from "./mcp.js";
import { attachA2a } from "./a2a.js";
import { aggregateCost, budgetAlerts } from "./cost.js";
import { auditEvent, listAuditEvents, type AuditEventKind } from "./audit.js";
import { listRunSummaries, getRun, getRelease } from "./trace.js";
import { checkRateLimit, clientIpFromHeaders } from "./rate-limit.js";
import { notifyAlerts } from "./alert-notify.js";
import { promptGuardAuditEnabled, sanitizeUserInput } from "./prompt-guard.js";
import { resolvePortalPermissions } from "./permissions.js";
import { loadUserPreferences } from "./user-prefs.js";
import { buildStoredAssistantMessageFromEvents } from "./chat-task-persistence.js";
import { analyticsAsk } from "./analytics/pipeline.js";
import {
  listFeedbackCandidates,
  reviewFeedbackCandidate,
  submitFeedback,
  type FeedbackVerdict,
} from "./analytics/audit-ledger.js";
import { enqueueScan, getScanJob, listScanJobs } from "./analytics/scan/runner.js";

const COOKIE = "bx_agent_sid";
/** Analytics 匿名归属 cookie：未登录也能量把会话写入 Mongo（按浏览器稳定 id）。 */
const ANALYTICS_AID_COOKIE = "bx_analytics_aid";

function token(code: string, params?: Record<string, string | number | boolean | null>, defaultMessage?: string): LocalizedToken {
  return { code, params, defaultMessage };
}

function errorJson(c: Context, status: number, code: string, params?: Record<string, string | number | boolean | null>, defaultMessage?: string, extras?: Record<string, unknown>) {
  const body: ApiErrorPayload & { message?: string; code?: string; [key: string]: unknown } = {
    error: token(code, params, defaultMessage),
    code,
    ...(defaultMessage ? { message: defaultMessage } : {}),
    ...(extras || {}),
  };
  return c.json(body, status as never);
}

/** Constant-time string compare for Bearer tokens (length mismatch → false). */
function safeTokenEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function uiText(uiLocale: string | undefined, zh: string, en: string, pt: string, hi: string): string {
  if (uiLocale === "pt-BR") return pt;
  if (uiLocale === "hi") return hi;
  if (uiLocale === "zh") return zh;
  return en;
}

function cookieOpts() {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "Lax" as const,
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  };
}

async function realLogin(countryId: string, username: string, password: string) {
  const country = getCountry(countryId);
  if (!country) throw new Error("未知或未配置的国家线");
  if (!country.backendUrl) throw new Error("该环境不可用");
  const login = await callUpstream({
    country,
    token: "",
    method: "POST",
    path: "/v0.1/useraccount/loginForPassword",
    baseUrlKey: "backend",
    params: { username, loginName: username, password },
  });
  const loginData = (login && typeof login === "object" ? login : {}) as Record<string, unknown>;
  const token = String(loginData.token || loginData.accessToken || "");
  if (!token) throw new Error("登录成功但未返回 token");
  const user = (await callUpstream({
    country,
    token,
    method: "POST",
    path: "/v0.1/useraccount/getCurrentUser",
    baseUrlKey: "backend",
    params: {},
  })) as { id?: number; loginName?: string; name?: string };
  const menusRaw = await callUpstream({
    country,
    token,
    method: "GET",
    path: "/v0.1/menu/getByCurrentUser",
    baseUrlKey: "backend",
    params: {},
  });
  const menus = Array.isArray(menusRaw)
    ? menusRaw
    : (menusRaw as { rows?: unknown[]; list?: unknown[] })?.rows ||
      (menusRaw as { list?: unknown[] })?.list ||
      [];
  return {
    country,
    token,
    user: {
      id: user.id,
      loginName: user.loginName || username,
      name: user.name || user.loginName || username,
    },
    menus: Array.isArray(menus) ? menus : (menus as { rows?: unknown[] })?.rows || [],
  };
}

export function createApp() {
  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: [
        config.webOrigin,
        "http://localhost:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
      ],
      credentials: true,
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/auth/countries", (c) => c.json({ countries: listPublicCountries() }));

  /**
   * 按端点主机推导模型服务商来源（基础设施信息，非业务词）。
   * 仅用于 /models 下拉的来源展示，不参与任何语义/路由判断。
   */
  function resolveModelSource(baseUrl: string, provider: string): string {
    const host = (baseUrl || "").replace(/^https?:\/\//, "").split("/")[0] || "";
    if (host.includes("integrate.api.nvidia.com")) return "NVIDIA";
    if (host.includes("opencode.ai")) return "Zen";
    if (host.includes("tokenhub.tencentmaas.com")) return "TokenHub";
    return provider; // anthropic / ollama / openai 等协议名兜底
  }

  function permissionsOf(session: { menus?: unknown[]; user?: Parameters<typeof ownerKeyOf>[0]; country?: { id?: string } } | null) {
    return resolvePortalPermissions(session, {
      allowedOwners: config.traceAllowedOwners,
      deniedOwners: config.traceDeniedOwners,
      allowedCountries: config.traceAllowedCountries,
    });
  }

  /** Require logged-in session; ownerKey = countryId:loginName (chat + analytics). */
  const requireOwner = (c: Context) => {
    const session = getSession(getCookie(c, COOKIE));
    if (!session) return null;
    return { session, ownerKey: ownerKeyOf(session.user, session.country.id) };
  };

  /**
   * Analytics 会话归属：已登录用账号 ownerKey；未登录发/读 bx_analytics_aid，ownerKey=anon:<aid>。
   * 问数本身仍可完全匿名；会话落库不再依赖登录。
   */
  const resolveAnalyticsOwner = (c: Context) => {
    const session = getSession(getCookie(c, COOKIE));
    if (session) {
      return {
        ownerKey: ownerKeyOf(session.user, session.country.id),
        countryId: session.country.id,
        loginName: session.user.loginName || String(session.user.id ?? "user"),
        via: "session" as const,
      };
    }
    let aid = String(getCookie(c, ANALYTICS_AID_COOKIE) || "").trim();
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(aid)) {
      aid = randomUUID().replace(/-/g, "");
      setCookie(c, ANALYTICS_AID_COOKIE, aid, {
        httpOnly: true,
        path: "/",
        sameSite: "Lax",
        maxAge: 400 * 24 * 3600,
      });
    }
    return {
      ownerKey: `anon:${aid}`,
      countryId: "anon",
      loginName: aid,
      via: "anon" as const,
    };
  };

  async function readJson<T>(c: Context): Promise<T> {
    return c.req.json<T>().catch(() => ({} as T));
  }

  /** Shared multipart save for /chat/upload and /analytics/upload (auth gated by callers). */
  async function saveUploadedFilesFromRequest(c: Context) {
    const form = await c.req.formData();
    const files = form.getAll("files") as Array<{
      name: string;
      type: string;
      size: number;
      arrayBuffer(): Promise<ArrayBuffer>;
    }>;
    if (!files.length) return { response: errorJson(c, 400, "UPLOAD_NO_FILES", undefined, "未收到文件") };
    if (files.length > MAX_AT_ONCE) {
      return {
        response: errorJson(
          c,
          400,
          "UPLOAD_TOO_MANY_FILES",
          { maxCount: MAX_AT_ONCE },
          `一次最多上传 ${MAX_AT_ONCE} 个文件`,
        ),
      };
    }
    const saved = [];
    for (const file of files) {
      try {
        saved.push(await saveUpload(file));
      } catch (error) {
        return {
          response: c.json(
            {
              message: error instanceof Error ? error.message : "文件保存失败",
              code: "UPLOAD_SAVE_FAILED",
              error: token("UPLOAD_SAVE_FAILED"),
            },
            400,
          ),
        };
      }
    }
    return { files: saved };
  }

  app.get("/models", (c) => {
    const session = getSession(getCookie(c, COOKIE));
    if (!session) return errorJson(c, 401, "AUTH_NOT_LOGGED_IN", undefined, "未登录");
    return c.json({
      models: listModels().map((m) => ({
        id: m.id,
        label: m.label,
        provider: m.provider,
        // 服务商来源（基础设施，非业务词）：按端点主机推导，前端展示用。
        source: resolveModelSource(m.baseUrl, m.provider),
        vision: m.vision,
      })),
    });
  });

  app.post("/auth/login", async (c) => {
    const ip = clientIpFromHeaders({ get: (name) => c.req.raw.headers.get(name) ?? undefined });
    const loginRl = checkRateLimit({ bucket: "login", key: ip });
    if (!loginRl.allowed) {
      auditEvent({
        kind: "reject",
        sessionId: "anon",
        detail: `rate_limit:login ip=${ip} limit=${loginRl.limit}`,
      });
      c.header("Retry-After", String(loginRl.retryAfterSec));
      return c.json(
        {
          message: "登录尝试过于频繁，请稍后再试",
          code: "AUTH_LOGIN_RATE_LIMITED",
          error: token("AUTH_LOGIN_RATE_LIMITED"),
          retryAfterSec: loginRl.retryAfterSec,
        },
        429,
      );
    }
    const body = await c.req.json<{ country?: string; username?: string; password?: string }>();
    const countryId = body.country || "";
    const username = (body.username || "").trim();
    const password = body.password || "";
    if (!countryId || !username || !password) {
      return errorJson(c, 400, "AUTH_LOGIN_MISSING_FIELDS", undefined, "请填写国家线、账号和密码");
    }
    try {
      const country = getCountry(countryId);
      if (!country) return errorJson(c, 400, "AUTH_COUNTRY_UNKNOWN", undefined, "未知或未配置的国家线");
      const auth = config.mockUpstream
        ? { country, ...mockLogin(username) }
        : await realLogin(countryId, username, password);
      const session = createSession({
        token: auth.token,
        country: auth.country,
        user: auth.user,
        menus: auth.menus,
      });
      setCookie(c, COOKIE, session.id, cookieOpts());
      return c.json({
        user: session.user,
        country: { id: session.country.id, label: session.country.label },
        permissions: permissionsOf(session),
      });
    } catch (error) {
      return errorJson(c, 401, "AUTH_LOGIN_FAILED", undefined, error instanceof Error ? error.message : "登录失败");
    }
  });

  app.post("/auth/logout", (c) => {
    deleteSession(getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/auth/me", (c) => {
    const session = getSession(getCookie(c, COOKIE));
    if (!session) return errorJson(c, 401, "AUTH_NOT_LOGGED_IN", undefined, "未登录");
    const prefs = loadUserPreferences(ownerKeyOf(session.user, session.country));
    return c.json({
      user: session.user,
      country: { id: session.country.id, label: session.country.label },
      permissions: permissionsOf(session),
      preferences: {
        replyLanguage: prefs.replyLanguage ?? null,
      },
    });
  });

  // ---- P2 异步：任务注册表（执行与 SSE 推送解耦）----
  // 旧行为：c.req.raw.signal（客户端断开）直接传进 chatStream → 刷新/断网即终止任务，
  // 结果不落会话（刷新丢结果）。新行为：由「后台消费者」驱动 chatStream（不依赖客户端
  // 连接），事件写入任务缓冲；SSE 连接只是缓冲的转发订阅者——断开仅停转发，任务照常
  // 跑完并把结果落 session.messages（用户刷新后从会话历史恢复）。显式取消走 /chat/cancel。
  interface RunningTask {
    taskId: string;
    ownerKey: string;
    startedAt: number;
    userText: string;
    events: ChatEvent[];
    settled: boolean;
    /** SSE 是否已把 done 成功转发给当前连接（在线收到结果则不必再建「后台任务结果」会话） */
    clientGotDone: boolean;
    /** 当前仍在转发的 SSE 订阅数；为 0 且未收到 done → 视为断线，可立即落库 */
    sseListeners: number;
    controller: AbortController;
  }
  const runningTasks = new Map<string, RunningTask>(); // sessionId → 进行中任务
  const lastTasks = new Map<string, RunningTask>(); // sessionId → 最近任务（含已完成，供状态查询/回放）
  const TASK_BUFFER_TTL_MS = 5 * 60 * 1000;

  // 任务收束后把结果落库：仅当客户端未收到 done（刷新/断网）时，把
  // (userText, 最终答复) 追加到该用户的「后台任务结果」专用会话（稳定 id=task-results，
  // 按 ownerKey 一份，避免 session 轮换刷出一堆同名 tab）。title 为通用词，无业务语义。
  async function persistTaskOutcome(ownerKey: string, countryId: string, loginName: string, userText: string, assistantMessage: StoredMessage): Promise<void> {
    try {
      const existing = await getConversation(ownerKey, TASK_RESULTS_CONV_ID);
      await upsertMessages({
        ownerKey,
        countryId,
        loginName,
        id: TASK_RESULTS_CONV_ID,
        title: "后台任务结果",
        messages: [
          ...(existing?.messages || []),
          { role: "user", text: userText },
          assistantMessage,
        ],
      });
      console.log(`[chat/task] 结果已落库 ${TASK_RESULTS_CONV_ID}（累计 ${(existing?.messages.length || 0) + 2} 条）`);
    } catch (e) {
      console.warn("[chat/task] 结果落库失败（不影响任务收束）:", e instanceof Error ? e.message : e);
    }
  }

  /** 等 SSE 把 done 刷出去；无订阅者则马上判定未投递，避免固定 sleep。 */
  async function waitForClientDelivery(task: RunningTask, maxMs = 2000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (task.clientGotDone) return true;
      if (task.sseListeners <= 0) return false;
      await new Promise((r) => setTimeout(r, 40));
    }
    return task.clientGotDone;
  }

  // 任务收束后延迟清缓冲（保留摘要字段供 status；防长文本事件长期占内存）
  function scheduleTaskGc(sessionId: string, task: RunningTask): void {
    setTimeout(() => {
      if (lastTasks.get(sessionId) === task) task.events = [];
    }, TASK_BUFFER_TTL_MS);
    // lastTasks 上限保护：只保留最近 100 个会话的任务摘要
    if (lastTasks.size > 100) {
      const oldest = lastTasks.keys().next().value;
      if (oldest !== undefined && !runningTasks.has(oldest)) lastTasks.delete(oldest);
    }
  }

  app.post("/chat/stream", async (c) => {
    try {
      const session = getSession(getCookie(c, COOKIE));
      if (!session) return errorJson(c, 401, "AUTH_SESSION_EXPIRED", undefined, "会话失效，请重新登录");
      const body = await c.req.json<{ text?: string; model?: string; images?: string[]; files?: string[]; uiLocale?: string }>();
      const ownerKey = ownerKeyOf(session.user, session.country.id);
      const cleaned = preprocess(body.text || "");
      const text = cleaned.text;
      if (!text) return errorJson(c, 400, "CHAT_EMPTY_INPUT", undefined, "请输入内容");
      if (promptGuardAuditEnabled() && (cleaned.strippedCount > 0 || cleaned.truncated)) {
        auditEvent({
          kind: "prompt_guard",
          sessionId: session.id,
          ownerKey,
          detail: `controls_stripped=${cleaned.strippedCount} truncated=${cleaned.truncated ? 1 : 0}`,
        });
      }
      const pickIds = (list: unknown) =>
        Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];

      // 并发保护/断线重连：该会话已有任务在跑 → 仅回放缓冲 + 告知进行中，不开第二个任务
      //（防两个并发任务同时写 session.messages 交错污染）
      const existing = runningTasks.get(session.id);
      if (existing && !existing.settled) {
        return streamSse(async (send) => {
          // 先发 task_running（携带回放任务的原始输入 userText），再回放事件：
          // 前端据此判断回放内容与本条发送是否匹配，不匹配立即断开——
          // 防止旧任务的答案流进新问题的气泡（输入输出错配），且断开后旧任务
          // 收不到 done 会把结果落「后台任务结果」会话，不丢数据。
          send({
            type: "task_running",
            taskId: existing.taskId,
            startedAt: existing.startedAt,
            userText: existing.userText,
            note: uiText(
              typeof body.uiLocale === "string" ? body.uiLocale : undefined,
              "该会话已有任务在后台执行，本连接为进度回放；任务完成后结果自动落入会话历史。",
              "A task for this conversation is already running in the background. This connection is replaying progress and the result will be saved to conversation history.",
              "Ja existe uma tarefa em execucao em segundo plano para esta conversa. Esta conexao apenas reproduz o progresso, e o resultado sera salvo no historico.",
              "इस वार्तालाप के लिए एक कार्य पहले से बैकग्राउंड में चल रहा है। यह कनेक्शन केवल प्रगति दिखा रहा है, और परिणाम वार्तालाप इतिहास में सहेजा जाएगा।",
            ),
            noteToken: token("CHAT_TASK_RUNNING"),
          });
          for (const ev of [...existing.events]) send(ev);
        });
      }

      // 新任务才计限流（回放进行中任务不消耗配额）
      const chatRl = checkRateLimit({ bucket: "chat", key: ownerKey });
      if (!chatRl.allowed) {
        auditEvent({
          kind: "reject",
          sessionId: session.id,
          ownerKey,
          detail: `rate_limit:chat owner=${ownerKey} limit=${chatRl.limit}`,
        });
        c.header("Retry-After", String(chatRl.retryAfterSec));
        return c.json(
          {
            message: "请求过于频繁，请稍后再试",
            code: "CHAT_RATE_LIMITED",
            error: token("CHAT_RATE_LIMITED"),
            retryAfterSec: chatRl.retryAfterSec,
          },
          429,
        );
      }
      if (chatRl.limit > 0) {
        c.header("X-RateLimit-Limit", String(chatRl.limit));
        c.header("X-RateLimit-Remaining", String(chatRl.remaining));
      }

      // 新任务：后台消费 chatStream（任务级 AbortController，显式取消走 /chat/cancel）
      const task: RunningTask = {
        taskId: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ownerKey,
        startedAt: Date.now(),
        userText: text,
        events: [],
        settled: false,
        clientGotDone: false,
        // 发起请求自带一条 SSE：先计入，避免任务瞬间结束时 listeners=0 被误判断线落库
        sseListeners: 1,
        controller: new AbortController(),
      };
      runningTasks.set(session.id, task);
      lastTasks.set(session.id, task);
      void (async () => {
        try {
          for await (const event of chatStream(
            session,
            text,
            {
              model: typeof body.model === "string" ? body.model : undefined,
              images: pickIds(body.images),
              files: pickIds(body.files),
              uiLocale: typeof body.uiLocale === "string" ? body.uiLocale : undefined,
            },
            task.controller.signal,
          )) {
            task.events.push(event);
          }
        } catch (error) {
          console.error("[chat/task] 后台任务异常:", error);
          task.events.push({
            type: "error",
            message: error instanceof Error ? error.message : "任务执行异常",
            code: "TASK_FAILED",
            error: token("CHAT_TASK_FAILED"),
          });
        } finally {
          // 保险收束：chatStream 正常路径自带 done；异常路径（含取消）这里确保 done 必达
          const last = task.events[task.events.length - 1];
          if (!last || last.type !== "done") task.events.push({ type: "done" });
          task.settled = true;
          // 有 SSE 订阅则等其刷完 done；已断线（listeners=0）立即落「后台任务结果」
          const delivered = await waitForClientDelivery(task);
          if (!delivered) {
            const assistantMessage = buildStoredAssistantMessageFromEvents(task.events);
            if (assistantMessage) {
              await persistTaskOutcome(
                ownerKey,
                session.country.id,
                session.user?.loginName || "anon",
                text,
                assistantMessage,
              );
            }
          }
          scheduleTaskGc(session.id, task);
          console.log(
            `[chat/task] ${task.taskId} 收束（events=${task.events.length}，clientGotDone=${task.clientGotDone}，sse=${task.sseListeners}，${Date.now() - task.startedAt}ms）`,
          );
        }
      })();

      // SSE 转发：先回放已产生的事件，再轮询追新直到任务收束。
      // 客户端断开 → send 抛错 → 静默退出转发（后台任务不受影响）。
      return streamSse(async (send) => {
        let sent = 0;
        try {
          for (;;) {
            while (sent < task.events.length) {
              const ev = task.events[sent++];
              send(ev);
              if (ev.type === "done") task.clientGotDone = true;
            }
            if (task.settled && sent >= task.events.length) break;
            await new Promise((r) => setTimeout(r, 100));
          }
        } catch {
          // 客户端断开：不标记 clientGotDone，后台 finally 会落「后台任务结果」
        } finally {
          // 与创建时预计入的 1 对应；断线后 listeners=0，waitForClientDelivery 立即返回
          task.sseListeners = Math.max(0, task.sseListeners - 1);
        }
      });
    } catch (error) {
      console.error("[chat/stream] error:", error);
      return errorJson(c, 500, "CHAT_STREAM_FAILED", undefined, error instanceof Error ? error.message : "请求失败");
    }
  });

  // 显式取消进行中任务（对齐前端「停止」按钮语义；客户端断开不再等于取消）
  app.post("/chat/cancel", (c) => {
    const session = getSession(getCookie(c, COOKIE));
    if (!session) return errorJson(c, 401, "AUTH_SESSION_EXPIRED", undefined, "会话失效，请重新登录");
    const task = runningTasks.get(session.id);
    if (!task || task.settled) return errorJson(c, 404, "CHAT_NO_RUNNING_TASK", undefined, "当前没有进行中的任务", { ok: false });
    task.controller.abort();
    return c.json({ ok: true, taskId: task.taskId });
  });

  // Metabase analytics HTTP facade（门户问数可匿名；会话靠登录或匿名 cookie 落库）
  app.get("/analytics/models", (c) => {
    return c.json({
      models: listModels().map((m) => ({
        id: m.id,
        label: m.label,
        provider: m.provider,
        source: resolveModelSource(m.baseUrl, m.provider),
        vision: m.vision,
      })),
    });
  });

  app.post("/analytics/upload", async (c) => {
    try {
      const result = await saveUploadedFilesFromRequest(c);
      if ("response" in result) return result.response;
      return c.json({ files: result.files });
    } catch (error) {
      console.error("[analytics/upload] error:", error);
      return errorJson(c, 500, "UPLOAD_FAILED", undefined, "上传失败");
    }
  });

  app.get("/analytics/upload/:id", (c) => {
    const image = getUploadImage(c.req.param("id"));
    if (!image) return errorJson(c, 404, "UPLOAD_IMAGE_NOT_FOUND", undefined, "图片不存在或已过期");
    return new Response(new Uint8Array(image.data), {
      headers: {
        "Content-Type": image.mediaType,
        "Cache-Control": "private, max-age=604800",
      },
    });
  });

  app.post("/analytics/ask", async (c) => {
    const body = await c.req
      .json<{
        text?: string;
        model?: string;
        images?: string[];
        files?: string[];
        slotAnswers?: Record<string, string[]>;
      }>()
      .catch(() => ({
        text: "",
        model: undefined as string | undefined,
        images: undefined as string[] | undefined,
        files: undefined as string[] | undefined,
        slotAnswers: undefined as Record<string, string[]> | undefined,
      }));
    const text = String(body.text || "").trim();
    const images = Array.isArray(body.images) ? body.images.map(String).filter(Boolean).slice(0, MAX_AT_ONCE) : [];
    const files = Array.isArray(body.files) ? body.files.map(String).filter(Boolean).slice(0, MAX_AT_ONCE) : [];
    if (!text && !images.length && !files.length) {
      return errorJson(c, 400, "ANALYTICS_EMPTY_INPUT", undefined, "请输入问数内容");
    }
    const modelId = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    const slotAnswers =
      body.slotAnswers && typeof body.slotAnswers === "object"
        ? Object.fromEntries(
            Object.entries(body.slotAnswers)
              .map(([k, v]) => [k, Array.isArray(v) ? v.map(String).filter(Boolean) : []])
              .filter(([, v]) => (v as string[]).length > 0),
          )
        : undefined;
    const result = await analyticsAsk(text, {
      modelId,
      signal: c.req.raw.signal,
      images,
      files,
      slotAnswers: slotAnswers && Object.keys(slotAnswers).length ? slotAnswers : undefined,
    });
    return c.json(result);
  });

  // Analytics 会话持久化（Mongo analytics_conversations；登录账号或匿名 cookie 均可）
  app.get("/analytics/conversations", async (c) => {
    const ctx = resolveAnalyticsOwner(c);
    const list = await listConversations(ctx.ownerKey, "analytics");
    return c.json({ conversations: list, ownerVia: ctx.via });
  });

  app.post("/analytics/conversations", async (c) => {
    const ctx = resolveAnalyticsOwner(c);
    const body = await readJson<{ id?: string; title?: string }>(c);
    const id = body.id || `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const doc = await createConversation({
      ownerKey: ctx.ownerKey,
      countryId: ctx.countryId,
      loginName: ctx.loginName,
      id,
      title: body.title || "新对话",
      store: "analytics",
    });
    return c.json({ conversation: doc, ownerVia: ctx.via });
  });

  app.get("/analytics/conversations/:id", async (c) => {
    const ctx = resolveAnalyticsOwner(c);
    const doc = await getConversation(ctx.ownerKey, c.req.param("id"), "analytics");
    if (!doc) return errorJson(c, 404, "ANALYTICS_CONVERSATION_NOT_FOUND", undefined, "会话不存在");
    return c.json({ conversation: doc, ownerVia: ctx.via });
  });

  app.post("/analytics/conversations/:id/messages", async (c) => {
    const ctx = resolveAnalyticsOwner(c);
    const body = await readJson<{ messages?: StoredMessage[]; title?: string }>(c);
    if (!Array.isArray(body.messages)) {
      return errorJson(c, 400, "ANALYTICS_CONVERSATION_INVALID_MESSAGES", undefined, "messages 必须为数组");
    }
    await upsertMessages({
      ownerKey: ctx.ownerKey,
      countryId: ctx.countryId,
      loginName: ctx.loginName,
      id: c.req.param("id"),
      messages: body.messages,
      title: body.title,
      store: "analytics",
    });
    return c.json({ ok: true, ownerVia: ctx.via });
  });

  app.put("/analytics/conversations/:id", async (c) => {
    const ctx = resolveAnalyticsOwner(c);
    const body = await readJson<{ title?: string }>(c);
    if (!body.title?.trim()) {
      return errorJson(c, 400, "ANALYTICS_CONVERSATION_EMPTY_TITLE", undefined, "标题不能为空");
    }
    await renameConversation(ctx.ownerKey, c.req.param("id"), body.title.trim(), "analytics");
    return c.json({ ok: true, ownerVia: ctx.via });
  });

  app.delete("/analytics/conversations/:id", async (c) => {
    const ctx = resolveAnalyticsOwner(c);
    await deleteConversation(ctx.ownerKey, c.req.param("id"), "analytics");
    return c.json({ ok: true, ownerVia: ctx.via });
  });

  app.post("/analytics/conversations/:id/clear", async (c) => {
    const ctx = resolveAnalyticsOwner(c);
    await clearConversation(ctx.ownerKey, c.req.param("id"), "analytics");
    return c.json({ ok: true, ownerVia: ctx.via });
  });

  // M2 Task 5：有用/有误 → 候选池（无人审不进 gold；可匿名）
  app.post("/analytics/feedback", async (c) => {
    const body = await c.req
      .json<{
        askId?: string;
        verdict?: string;
        reasonTags?: string[];
        note?: string;
        nl?: string;
        sqls?: string[];
        status?: string;
        packVersion?: string;
        modelId?: string;
      }>()
      .catch(() => ({} as Record<string, unknown>));
    const askId = String(body.askId || "").trim();
    const verdict = String(body.verdict || "").trim() as FeedbackVerdict;
    if (!askId) {
      return errorJson(c, 400, "ANALYTICS_FEEDBACK_BAD_ASK", undefined, "缺少 askId");
    }
    if (verdict !== "useful" && verdict !== "wrong") {
      return errorJson(c, 400, "ANALYTICS_FEEDBACK_BAD_VERDICT", undefined, "verdict 须为 useful|wrong");
    }
    const candidate = submitFeedback({
      askId,
      verdict,
      reasonTags: Array.isArray(body.reasonTags) ? body.reasonTags.map(String) : undefined,
      note: typeof body.note === "string" ? body.note : undefined,
      nl: typeof body.nl === "string" ? body.nl : undefined,
      sqls: Array.isArray(body.sqls) ? body.sqls.map(String) : undefined,
      status:
        body.status === "ok" ||
        body.status === "clarify" ||
        body.status === "refuse" ||
        body.status === "error"
          ? body.status
          : undefined,
      packVersion: typeof body.packVersion === "string" ? body.packVersion : undefined,
      modelId: typeof body.modelId === "string" ? body.modelId : undefined,
    });
    return c.json({ ok: true, candidateId: candidate.id, reviewStatus: candidate.reviewStatus });
  });

  app.get("/analytics/feedback/candidates", (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
    const reviewStatus = c.req.query("reviewStatus") as "pending" | "confirmed" | "rejected" | undefined;
    const verdict = c.req.query("verdict") as FeedbackVerdict | undefined;
    return c.json({
      candidates: listFeedbackCandidates({
        limit,
        reviewStatus:
          reviewStatus === "pending" || reviewStatus === "confirmed" || reviewStatus === "rejected"
            ? reviewStatus
            : undefined,
        verdict: verdict === "useful" || verdict === "wrong" ? verdict : undefined,
      }),
    });
  });

  app.post("/analytics/feedback/candidates/:id/review", async (c) => {
    const id = c.req.param("id");
    const body = await c.req
      .json<{ reviewStatus?: string }>()
      .catch(() => ({ reviewStatus: undefined as string | undefined }));
    const reviewStatus = String(body.reviewStatus || "").trim();
    if (reviewStatus !== "confirmed" && reviewStatus !== "rejected") {
      return errorJson(c, 400, "ANALYTICS_FEEDBACK_BAD_REVIEW", undefined, "reviewStatus 须为 confirmed|rejected");
    }
    const updated = reviewFeedbackCandidate(id, reviewStatus);
    if (!updated) {
      return errorJson(c, 404, "ANALYTICS_FEEDBACK_NOT_FOUND", undefined, "候选不存在");
    }
    return c.json({ ok: true, candidate: updated });
  });

  // 应用内巡检：与问数一致，暂不复用后台运营 session；独立登录接入前可匿名（内网可控）。
  // cron / 运维仍可用 /internal/analytics/scan + Bearer。
  app.post("/analytics/scan/run", async (c) => {
    if (!config.scan.workerEnabled) {
      return errorJson(c, 403, "SCAN_WORKER_DISABLED", undefined, "本实例未启用 scan worker（ANALYTICS_SCAN_WORKER≠1）");
    }
    const body = await c.req
      .json<{
        ruleSetId?: string;
        scanDate?: string;
        forceRerun?: boolean;
        dryRun?: boolean;
      }>()
      .catch(() => ({} as {
        ruleSetId?: string;
        scanDate?: string;
        forceRerun?: boolean;
        dryRun?: boolean;
      }));
    const ruleSetId = String(body.ruleSetId || "watch-users").trim() || "watch-users";
    const result = await enqueueScan({
      ruleSetId,
      scanDate: body.scanDate,
      forceRerun: body.forceRerun === true,
      dryRun: body.dryRun === true,
    });
    if ("error" in result) {
      if (result.error === "scan_job_running") {
        return errorJson(c, 409, "scan_job_running", undefined, "同 scanDate+ruleSet 已有 running 任务", {
          error: "scan_job_running",
        });
      }
      return errorJson(c, 400, "SCAN_ENQUEUE_FAILED", undefined, result.error);
    }
    return c.json({ jobId: result.jobId }, 202);
  });

  app.get("/analytics/scan/jobs", (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 50);
    return c.json({ jobs: listScanJobs({ limit }) });
  });

  app.get("/analytics/scan/jobs/:jobId", (c) => {
    const job = getScanJob(c.req.param("jobId"));
    if (!job) {
      return errorJson(c, 404, "SCAN_JOB_NOT_FOUND", undefined, "scan job 不存在");
    }
    return c.json(job);
  });

  // M3 巡检内部 API：Bearer SCAN_INTERNAL_TOKEN + ANALYTICS_SCAN_WORKER=1
  function assertScanInternalAuth(c: Context) {
    if (!config.scan.workerEnabled) {
      return errorJson(c, 403, "SCAN_WORKER_DISABLED", undefined, "本实例未启用 scan worker（ANALYTICS_SCAN_WORKER≠1）");
    }
    const expected = config.scan.internalToken;
    const auth = c.req.header("authorization") || "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const provided = m?.[1]?.trim() || "";
    if (!expected || !provided || !safeTokenEqual(expected, provided)) {
      return errorJson(c, 401, "SCAN_UNAUTHORIZED", undefined, "无效或缺失 SCAN_INTERNAL_TOKEN");
    }
    return null;
  }

  app.post("/internal/analytics/scan", async (c) => {
    const denied = assertScanInternalAuth(c);
    if (denied) return denied;
    const body = await c.req
      .json<{
        ruleSetId?: string;
        scanDate?: string;
        forceRerun?: boolean;
        dryRun?: boolean;
      }>()
      .catch(() => ({} as {
        ruleSetId?: string;
        scanDate?: string;
        forceRerun?: boolean;
        dryRun?: boolean;
      }));
    const ruleSetId = String(body.ruleSetId || "").trim();
    if (!ruleSetId) {
      return errorJson(c, 400, "SCAN_MISSING_RULESET", undefined, "ruleSetId 必填");
    }
    const result = await enqueueScan({
      ruleSetId,
      scanDate: body.scanDate,
      forceRerun: body.forceRerun === true,
      dryRun: body.dryRun === true,
    });
    if ("error" in result) {
      if (result.error === "scan_job_running") {
        return errorJson(c, 409, "scan_job_running", undefined, "同 scanDate+ruleSet 已有 running 任务", {
          error: "scan_job_running",
        });
      }
      return errorJson(c, 400, "SCAN_ENQUEUE_FAILED", undefined, result.error);
    }
    return c.json({ jobId: result.jobId }, 202);
  });

  app.get("/internal/analytics/scan/:jobId", (c) => {
    const denied = assertScanInternalAuth(c);
    if (denied) return denied;
    const jobId = c.req.param("jobId");
    const job = getScanJob(jobId);
    if (!job) {
      return errorJson(c, 404, "SCAN_JOB_NOT_FOUND", undefined, "scan job 不存在");
    }
    return c.json(job);
  });

  // 任务状态查询（刷新后前端可据此展示「上一任务仍在后台执行」或最近一次结果）
  app.get("/chat/task/status", (c) => {
    const session = getSession(getCookie(c, COOKIE));
    if (!session) return errorJson(c, 401, "AUTH_SESSION_EXPIRED", undefined, "会话失效，请重新登录");
    const running = runningTasks.get(session.id);
    const last = lastTasks.get(session.id);
    return c.json({
      running: running && !running.settled
        ? { taskId: running.taskId, startedAt: running.startedAt, eventCount: running.events.length, userText: running.userText }
        : null,
      last: last
        ? { taskId: last.taskId, settled: last.settled, startedAt: last.startedAt, userText: last.userText }
        : null,
    });
  });

  // ---- P3 可观测：trace 只读视图（门户级入口 + 权限控制）----
  // 最近 N 个 run 摘要 + 统计（轮次/token/版本分布），供 Web 可视化/巡检接入
  app.get("/trace/runs", (c) => {
    const session = getSession(getCookie(c, COOKIE));
    if (!session) return errorJson(c, 401, "AUTH_SESSION_EXPIRED", undefined, "会话失效，请重新登录");
    if (!permissionsOf(session).canViewTrace) return errorJson(c, 403, "TRACE_FORBIDDEN", undefined, "无权限查看 Trace");
    const limit = Math.min(Number(c.req.query("limit")) || 20, 50);
    const agentId = String(c.req.query("agentId") || "").trim() || undefined;
    const out = listRunSummaries(limit, undefined, agentId);
    if (out.stats?.degradeHint) {
      void notifyAlerts({ kind: "degrade", messages: [out.stats.degradeHint] });
    }
    return c.json(out);
  });

  // 单个 run 的完整 span 树；门户级 trace 仍受权限控制
  app.get("/trace/run/:runId", (c) => {
    const session = getSession(getCookie(c, COOKIE));
    if (!session) return errorJson(c, 401, "AUTH_SESSION_EXPIRED", undefined, "会话失效，请重新登录");
    if (!permissionsOf(session).canViewTrace) return errorJson(c, 403, "TRACE_FORBIDDEN", undefined, "无权限查看 Trace");
    const spans = getRun(c.req.param("runId"));
    const runSpan = spans.find((s) => s.kind === "run");
    if (!runSpan) return errorJson(c, 404, "TRACE_RUN_NOT_FOUND", undefined, "不存在");
    return c.json({ release: getRelease(), spans });
  });

  // 写操作确认回调：前端点"确认/取消"后调用此接口，唤醒 chatStream 里的 waitForConfirmation
  app.post("/chat/confirm", async (c) => {
    const session = getSession(getCookie(c, COOKIE));
    if (!session) return errorJson(c, 401, "AUTH_SESSION_EXPIRED", undefined, "会话失效，请重新登录");
    const body = await c.req.json<{ callId?: string; confirmed?: boolean }>();
    if (!body.callId) return errorJson(c, 400, "CHAT_CONFIRM_MISSING_CALL_ID", undefined, "缺少 callId");
    const found = resolveConfirmWaiter(session.id, body.callId, body.confirmed ?? false);
    return c.json({ ok: found });
  });

  // 清空当前登录会话的上下文（历史消息 + 待澄清状态），不影响登录态。
  app.post("/chat/context/clear", (c) => {
    const sid = getCookie(c, COOKIE);
    const session = getSession(sid);
    if (!session) return errorJson(c, 401, "AUTH_SESSION_EXPIRED", undefined, "会话失效，请重新登录");
    const ok = clearSessionContext(sid);
    return c.json({ ok });
  });

  // ---- 聊天记录持久化（方案 C：MongoDB，按登录用户归属）----
  // 身份验证：与 /chat/stream 一致，require session；ownerKey = countryId:loginName。

  // 会话列表（按 updatedAt 倒序）
  app.get("/chat/conversations", async (c) => {
    const ctx = requireOwner(c);
    if (!ctx) return errorJson(c, 401, "AUTH_SESSION_EXPIRED", undefined, "会话失效，请重新登录");
    const list = await listConversations(ctx.ownerKey);
    return c.json({ conversations: list });
  });

  // 新建会话（body: { id?, title? }；id 缺省由服务端生成）
  app.post("/chat/conversations", async (c) => {
    const ctx = requireOwner(c);
    if (!ctx) return errorJson(c, 401, "AUTH_SESSION_EXPIRED", undefined, "会话失效，请重新登录");
    const body = await readJson<{ id?: string; title?: string }>(c);
    const id = body.id || `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const doc = await createConversation({
      ownerKey: ctx.ownerKey,
      countryId: ctx.session.country.id,
      loginName: ctx.session.user.loginName,
      id,
      title: body.title || "新对话",
    });
    return c.json({ conversation: doc });
  });

  // 单会话详情
  app.get("/chat/conversations/:id", async (c) => {
    const ctx = requireOwner(c);
    if (!ctx) return errorJson(c, 401, "AUTH_SESSION_EXPIRED", undefined, "会话失效，请重新登录");
    const doc = await getConversation(ctx.ownerKey, c.req.param("id"));
    if (!doc) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", undefined, "会话不存在");
    return c.json({ conversation: doc });
  });

  // 保存整段消息（upsert；body: { messages, title? }）
  app.post("/chat/conversations/:id/messages", async (c) => {
    const ctx = requireOwner(c);
    if (!ctx) return errorJson(c, 401, "AUTH_SESSION_EXPIRED", undefined, "会话失效，请重新登录");
    const body = await readJson<{ messages?: StoredMessage[]; title?: string }>(c);
    if (!Array.isArray(body.messages)) return errorJson(c, 400, "CHAT_CONVERSATION_INVALID_MESSAGES", undefined, "messages 必须为数组");
    await upsertMessages({
      ownerKey: ctx.ownerKey,
      countryId: ctx.session.country.id,
      loginName: ctx.session.user.loginName,
      id: c.req.param("id"),
      messages: body.messages,
      title: body.title,
    });
    return c.json({ ok: true });
  });

  // 重命名
  app.put("/chat/conversations/:id", async (c) => {
    const ctx = requireOwner(c);
    if (!ctx) return errorJson(c, 401, "AUTH_SESSION_EXPIRED", undefined, "会话失效，请重新登录");
    const body = await readJson<{ title?: string }>(c);
    if (!body.title?.trim()) return errorJson(c, 400, "CHAT_CONVERSATION_EMPTY_TITLE", undefined, "标题不能为空");
    await renameConversation(ctx.ownerKey, c.req.param("id"), body.title.trim());
    return c.json({ ok: true });
  });

  // 删除会话
  app.delete("/chat/conversations/:id", async (c) => {
    const ctx = requireOwner(c);
    if (!ctx) return errorJson(c, 401, "AUTH_SESSION_EXPIRED", undefined, "会话失效，请重新登录");
    await deleteConversation(ctx.ownerKey, c.req.param("id"));
    return c.json({ ok: true });
  });

  // 清空会话消息（保留会话壳）
  app.post("/chat/conversations/:id/clear", async (c) => {
    const ctx = requireOwner(c);
    if (!ctx) return errorJson(c, 401, "AUTH_SESSION_EXPIRED", undefined, "会话失效，请重新登录");
    await clearConversation(ctx.ownerKey, c.req.param("id"));
    return c.json({ ok: true });
  });

  // 成本汇总（只读）：P2 最小权限——HTTP 面只暴露当前登录操作者自己的数据
  // （ownerKey 过滤）；全局视角走服务端 CLI（inspect-cost.mjs）。
  app.get("/cost/summary", (c) => {
    const ctx = requireOwner(c);
    if (!ctx) return errorJson(c, 401, "AUTH_SESSION_EXPIRED", undefined, "会话失效，请重新登录");
    const report = aggregateCost({
      fromDay: c.req.query("from") || undefined,
      toDay: c.req.query("to") || undefined,
      sessionId: c.req.query("session") || undefined,
      ownerKey: ctx.ownerKey,
      slowestTopN: Number(c.req.query("top")) || 10,
    });
    const alerts = budgetAlerts(report);
    // 异步推送：不阻塞 HTTP；未配 webhook / 去重命中则 no-op
    if (alerts.length) {
      void notifyAlerts({ kind: "budget", messages: alerts });
    }
    return c.json({ report, alerts });
  });

  // 安全审计（只读）：越权拒绝 / 写确认事件。最小权限口径——登录用户只能查
  // 自己（ownerKey）的审计事件；全局视角走服务端 CLI（inspect-audit.mjs）。
  app.get("/audit/list", (c) => {
    const ctx = requireOwner(c);
    if (!ctx) return errorJson(c, 401, "AUTH_SESSION_EXPIRED", undefined, "会话失效，请重新登录");
    const events = listAuditEvents({
      fromDay: c.req.query("from") || undefined,
      toDay: c.req.query("to") || undefined,
      kind: (c.req.query("kind") as AuditEventKind) || undefined,
      ownerKey: ctx.ownerKey,
      limit: Number(c.req.query("limit")) || 200,
    });
    return c.json({ events });
  });

  app.post("/chat/upload", async (c) => {
    try {
      const session = getSession(getCookie(c, COOKIE));
      if (!session) return errorJson(c, 401, "AUTH_SESSION_EXPIRED", undefined, "会话失效，请重新登录");
      const result = await saveUploadedFilesFromRequest(c);
      if ("response" in result) return result.response;
      return c.json({ files: result.files });
    } catch (error) {
      console.error("[chat/upload] error:", error);
      return errorJson(c, 500, "UPLOAD_FAILED", undefined, "上传失败");
    }
  });

  app.get("/chat/upload/:id", (c) => {
    const session = getSession(getCookie(c, COOKIE));
    if (!session) return errorJson(c, 401, "AUTH_NOT_LOGGED_IN", undefined, "未登录");
    const image = getUploadImage(c.req.param("id"));
    if (!image) return errorJson(c, 404, "UPLOAD_IMAGE_NOT_FOUND", undefined, "图片不存在或已过期");
    return new Response(new Uint8Array(image.data), {
      headers: {
        "Content-Type": image.mediaType,
        "Cache-Control": "private, max-age=604800",
      },
    });
  });

  // 导出文件下载 / PDF 预览（xlsx、pdf）
  app.get("/chat/download/:id", (c) => {
    const session = getSession(getCookie(c, COOKIE));
    if (!session) return errorJson(c, 401, "AUTH_NOT_LOGGED_IN", undefined, "未登录");
    const packed = readDownloadBytes(c.req.param("id"));
    if (!packed) return errorJson(c, 404, "DOWNLOAD_FILE_NOT_FOUND", undefined, "文件不存在或已过期");
    const { rec, bytes } = packed;
    const disposition = c.req.query("preview") === "1" && rec.kind === "pdf"
      ? "inline"
      : `attachment; filename*=UTF-8''${encodeURIComponent(rec.name)}`;
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": rec.mimeType,
        "Content-Disposition": disposition,
        "Cache-Control": "private, max-age=3600",
      },
    });
  });

  // MCP Server 出口：/mcp（Streamable HTTP），把本地工具暴露给任何 MCP 客户端。
  attachMcp(app);

  // A2A Server 出口：/a2a（JSON-RPC）+ /.well-known/agent-card.json，把本 agent 作为任务级 agent 暴露给自有其他 agent。
  attachA2a(app);

  return app;
}

// 输入预处理（规范第一层）：纯代码清洗，不走大模型。
// Unicode 危险控制类剥离 + 空白归一 + 长度截断（零自然语言词典）。
const MAX_INPUT_LEN = Math.max(1, Number(process.env.CHAT_MAX_INPUT_LEN) || 500);
function preprocess(raw: string) {
  return sanitizeUserInput(raw, MAX_INPUT_LEN);
}

function streamSse(run: (send: (event: unknown) => void) => Promise<void>) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        await run(send);
      } catch (error) {
        // 流已开启（已发 SSE 头）后发生的异常无法再改 HTTP 状态码，
        // 必须转成一条 error 事件推给前端，否则浏览器会收到 500 空 body。
        const message = error instanceof Error ? error.message : "请求失败";
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "error", message, code: "STREAM_ERROR", error: token("STREAM_ERROR") })}\n\n`),
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
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}