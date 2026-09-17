import { Hono, type Context } from "hono";
import type { ApiErrorPayload, LocalizedToken } from "@bx/shared";
import { cors } from "hono/cors";
import { getCookie, setCookie } from "hono/cookie";
import { config, listModels } from "./config.js";
import { answerConfirmation } from "./confirm.js";
import { connect, disconnect, disconnectAll, listStatuses, reload } from "./mcp/hub.js";
import {
  deleteServer,
  loadServers,
  toPublic,
  upsertServer,
  validateServerInput,
  type McpServerConfig,
} from "./mcp/config.js";
import { clearSessionContext, ensureSession, SESSION_COOKIE, touchSession } from "./session.js";
import {
  clearContext,
  clearConversation,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listEnabledMcpServers,
  patchConversation,
  pullMcpServerFromAllConversations,
  resolveConversation,
  upsertMessages,
  type ConversationPatch,
  type PendingMessage,
  type StoredMessage,
} from "./conversations.js";
import { chatStream } from "./chat.js";
import { MAX_AT_ONCE, getUploadImage, saveUpload } from "./uploads.js";

const COOKIE = SESSION_COOKIE;

/**
 * 正在进行的对话流（对话级并发保护，非全局）：
 * 同一对话同时只允许一条流在写 context —— 第二个请求返回 409，由前端转入待发队列。
 * 不同对话互不影响，可真正并行。
 */
const runningStreams = new Map<string, number>();
// 单条用户输入上限（字符）：超出直接截断，避免超长输入打爆模型上下文。
const MAX_INPUT_LEN = Math.max(1, Number(process.env.CHAT_MAX_INPUT_LEN || 8000));

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
    const sessionId = getCookie(c, COOKIE);
    const session = ensureSession(sessionId);
    if (session.id !== sessionId) setCookie(c, COOKIE, session.id, cookieOpts());
    const conversationId = c.req.query("conversationId") || session.activeConversationId || "";
    const doc = conversationId ? await getConversation(conversationId) : null;
    return c.json({
      conversationId,
      available: listStatuses(),
      enabled: doc?.mcpServers || [],
    });
  });

  app.put("/chat/mcp/servers", async (c) => {
    const body = await readJson<{ conversationId?: string; enabled?: string[] }>(c);
    const sessionId = getCookie(c, COOKIE);
    const session = ensureSession(sessionId);
    if (session.id !== sessionId) setCookie(c, COOKIE, session.id, cookieOpts());
    const conversationId = await resolveConversation(
      session,
      typeof body.conversationId === "string" && body.conversationId ? body.conversationId : undefined,
    );
    const doc = await getConversation(conversationId);
    const prev = new Set(doc?.mcpServers || []);
    const next = new Set(
      Array.isArray(body.enabled) ? body.enabled.filter((x): x is string => typeof x === "string") : [],
    );
    await patchConversation(conversationId, { mcpServers: [...next] });
    // 新勾选的立即建连（异步，不阻塞响应）；取消勾选的，只有当**没有任何对话**再用时才断开。
    const used = await listEnabledMcpServers();
    for (const id of next) if (!prev.has(id)) void connect(id);
    for (const id of prev) {
      if (next.has(id) || used.has(id)) continue;
      void disconnect(id);
    }
    return c.json({ conversationId, enabled: [...next], available: listStatuses() });
  });

  // ---- 工具调用二次确认回调（MCP requireConfirm 的服务器）----
  app.post("/chat/confirm", async (c) => {
    const body = await readJson<{ callId?: string; confirmed?: boolean }>(c);
    if (!body.callId) return errorJson(c, 400, "CHAT_CONFIRM_MISSING_CALL_ID", "缺少 callId");
    const ok = answerConfirmation(body.callId, body.confirmed === true);
    return c.json({ ok, confirmed: body.confirmed === true });
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

  // 一轮对话：用户输入 → 模型 → 流式回包（HTTP Streamable，NDJSON 分块）。
  app.post("/chat/stream", async (c) => {
    try {
      const body = await readJson<{ text?: string; model?: string; images?: string[]; conversationId?: string }>(c);
      const text = String(body.text || "").trim().slice(0, MAX_INPUT_LEN);
      if (!text) return errorJson(c, 400, "CHAT_EMPTY_INPUT", "请输入内容");
      const sessionId = getCookie(c, COOKIE);
      const session = ensureSession(sessionId);
      if (session.id !== sessionId) setCookie(c, COOKIE, session.id, cookieOpts());

      // 解析本次所属对话（thread）：显式传入优先；否则用会话的活跃对话
      // （首次访问会创建「默认对话」并把旧 session.messages / mcpServers 迁移进去）。
      const conversationId = await resolveConversation(
        session,
        typeof body.conversationId === "string" ? body.conversationId : undefined,
      );
      if (session.activeConversationId !== conversationId) {
        session.activeConversationId = conversationId;
        touchSession(session);
      }

      // 对话级并发保护：同一对话已有流在跑 → 409，前端据此把消息转入待发队列（排队语义）。
      if (runningStreams.has(conversationId)) {
        return errorJson(c, 409, "CONVERSATION_BUSY", "该对话正在生成中：消息可排队，或先停止当前生成");
      }
      runningStreams.set(conversationId, Date.now());

      return streamNdjson(async (send) => {
        try {
          // 传入客户端断连信号：前端点“停止”或关页面时，@hono/node-server 会 abort
          // c.req.raw.signal，从而中断仍在进行的模型调用，避免服务端空跑浪费 token。
          for await (const event of chatStream(
            conversationId,
            text,
            {
              model: typeof body.model === "string" ? body.model : undefined,
              images: Array.isArray(body.images) ? body.images.filter((x): x is string => typeof x === "string") : [],
            },
            c.req.raw.signal,
          )) {
            send(event);
          }
        } finally {
          runningStreams.delete(conversationId);
        }
      });
    } catch (error) {
      console.error("[chat/stream] error:", error);
      return errorJson(c, 500, "CHAT_STREAM_FAILED", error instanceof Error ? error.message : "请求失败");
    }
  });

  // 清空服务端上下文（兼容旧前端）。@deprecated 请改用 POST /chat/conversations/:id/context/clear
  app.post("/chat/context/clear", async (c) => {
    const sessionId = getCookie(c, COOKIE);
    const session = ensureSession(sessionId);
    if (session.id !== sessionId) setCookie(c, COOKIE, session.id, cookieOpts());
    // 上下文的唯一真相已迁到对话，这里同步清掉，避免旧调用"看起来没生效"。
    const conversationId = await resolveConversation(session);
    await clearContext(conversationId);
    const ok = clearSessionContext(sessionId);
    return c.json({ ok, conversationId });
  });

  // ---- 聊天记录持久化 ----
  app.get("/chat/conversations", async (c) => {
    const list = await listConversations();
    // running：该对话是否有正在进行的流（进程内存态，不持久化），供侧栏标记"生成中"。
    return c.json({
      conversations: list.map((doc) => ({ ...doc, running: runningStreams.has(doc.id) })),
    });
  });

  app.post("/chat/conversations", async (c) => {
    const body = await readJson<{ id?: string; title?: string }>(c);
    const id = body.id || `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // 新对话不带任何对话级设置（model / mcpServers / locale 均为空）→ 前端默认"不选中 MCP"。
    const doc = await createConversation({ id, title: body.title || "新对话" });
    // 新建即激活：让仍不带 conversationId 的旧客户端也落在新对话上，
    // 否则回退到 activeConversationId 会读到上一个对话的启用集（新对话看起来"默认勾了 MCP"）。
    const session = ensureSession(getCookie(c, COOKIE));
    session.activeConversationId = id;
    touchSession(session);
    return c.json({ conversation: { ...doc, running: runningStreams.has(id) } });
  });

  app.post("/chat/conversations/:id/messages", async (c) => {
    const body = await readJson<{ messages?: StoredMessage[]; title?: string }>(c);
    if (!Array.isArray(body.messages)) {
      return errorJson(c, 400, "CHAT_CONVERSATION_INVALID_MESSAGES", "messages 必须为数组");
    }
    await upsertMessages({ id: c.req.param("id"), messages: body.messages, title: body.title });
    return c.json({ ok: true });
  });

  app.delete("/chat/conversations/:id", async (c) => {
    const id = c.req.param("id");
    await deleteConversation(id);
    // 删掉的正好是活跃对话时清空指针，避免回退到一个已不存在的 id。
    const sessionId = getCookie(c, COOKIE);
    const session = ensureSession(sessionId);
    if (session.activeConversationId === id) {
      session.activeConversationId = "";
      touchSession(session);
    }
    return c.json({ ok: true });
  });

  app.post("/chat/conversations/:id/clear", async (c) => {
    await clearConversation(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---- 对话级设置与上下文（thread）----
  // 列表接口不带 context（体积大），切对话时用它单独取全量。
  app.get("/chat/conversations/:id", async (c) => {
    const doc = await getConversation(c.req.param("id"));
    if (!doc) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    // 返回时带 running：支持"刷新后仍能看到该对话在生成中"（例如另一标签页在跑）。
    return c.json({ conversation: { ...doc, running: runningStreams.has(doc.id) } });
  });

  // 更新对话设置：标题 / 模型 / MCP 启用集 / 语言 / 待发队列（未提供的字段保持不变）。
  app.patch("/chat/conversations/:id", async (c) => {
    const body = await readJson<{
      title?: string;
      model?: string;
      mcpServers?: string[];
      locale?: string;
      pendingQueue?: PendingMessage[];
    }>(c);
    const patch: ConversationPatch = {};
    if (typeof body.title === "string") patch.title = body.title;
    if (typeof body.model === "string") patch.model = body.model;
    if (Array.isArray(body.mcpServers)) {
      patch.mcpServers = body.mcpServers.filter((x): x is string => typeof x === "string");
    }
    if (typeof body.locale === "string") patch.locale = body.locale;
    if (Array.isArray(body.pendingQueue)) patch.pendingQueue = body.pendingQueue;
    const updated = await patchConversation(c.req.param("id"), patch);
    if (!updated) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "对话不存在");
    return c.json({ conversation: updated });
  });

  // 清空该对话的模型上下文（不影响 UI 消息快照）。
  app.post("/chat/conversations/:id/context/clear", async (c) => {
    await clearContext(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---- 设备级偏好（原前端 localStorage：主题 / 客户端默认语言 / 上次打开的对话）----
  function prefsPayload(session: ReturnType<typeof ensureSession>) {
    return {
      activeConversationId: session.activeConversationId || "",
      theme: session.preferences?.theme || "",
      locale: session.preferences?.locale || "",
      // 客户端据此判断是否需要跑「旧的 localStorage 一次性迁移」。
      migratedAt: session.preferences?.migratedAt || 0,
    };
  }

  app.get("/chat/preferences", (c) => {
    const sessionId = getCookie(c, COOKIE);
    const session = ensureSession(sessionId);
    if (session.id !== sessionId) setCookie(c, COOKIE, session.id, cookieOpts());
    return c.json(prefsPayload(session));
  });

  app.put("/chat/preferences", async (c) => {
    const body = await readJson<{ activeConversationId?: string; theme?: "light" | "dark"; locale?: string }>(c);
    const sessionId = getCookie(c, COOKIE);
    const session = ensureSession(sessionId);
    if (session.id !== sessionId) setCookie(c, COOKIE, session.id, cookieOpts());
    if (typeof body.activeConversationId === "string") session.activeConversationId = body.activeConversationId;
    const prefs = session.preferences || {};
    if (body.theme === "light" || body.theme === "dark") prefs.theme = body.theme;
    if (typeof body.locale === "string") prefs.locale = body.locale;
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
