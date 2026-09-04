import { Hono, type Context } from "hono";
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
import { listAuditEvents, type AuditEventKind } from "./audit.js";

const COOKIE = "bx_agent_sid";

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

  app.get("/models", (c) => {
    const session = getSession(getCookie(c, COOKIE));
    if (!session) return c.json({ message: "未登录" }, 401);
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
    const body = await c.req.json<{ country?: string; username?: string; password?: string }>();
    const countryId = body.country || "";
    const username = (body.username || "").trim();
    const password = body.password || "";
    if (!countryId || !username || !password) {
      return c.json({ message: "请填写国家线、账号和密码" }, 400);
    }
    try {
      const country = getCountry(countryId);
      if (!country) return c.json({ message: "未知或未配置的国家线" }, 400);
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
      });
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "登录失败" }, 401);
    }
  });

  app.post("/auth/logout", (c) => {
    deleteSession(getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/auth/me", (c) => {
    const session = getSession(getCookie(c, COOKIE));
    if (!session) return c.json({ message: "未登录" }, 401);
    return c.json({
      user: session.user,
      country: { id: session.country.id, label: session.country.label },
    });
  });

  app.post("/chat/stream", async (c) => {
    try {
      const session = getSession(getCookie(c, COOKIE));
      if (!session) return c.json({ message: "会话失效，请重新登录" }, 401);
      const body = await c.req.json<{ text?: string; model?: string; images?: string[]; files?: string[] }>();
      const text = preprocess(body.text || "");
      if (!text) return c.json({ message: "请输入内容" }, 400);
      const pickIds = (list: unknown) =>
        Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
      return streamSse(async (send) => {
        for await (const event of chatStream(session, text, {
          model: typeof body.model === "string" ? body.model : undefined,
          images: pickIds(body.images),
          files: pickIds(body.files),
        }, c.req.raw.signal)) {
          send(event);
        }
      });
    } catch (error) {
      console.error("[chat/stream] error:", error);
      return c.json({ message: error instanceof Error ? error.message : "请求失败" }, 500);
    }
  });

  // 写操作确认回调：前端点"确认/取消"后调用此接口，唤醒 chatStream 里的 waitForConfirmation
  app.post("/chat/confirm", async (c) => {
    const session = getSession(getCookie(c, COOKIE));
    if (!session) return c.json({ message: "会话失效，请重新登录" }, 401);
    const body = await c.req.json<{ callId?: string; confirmed?: boolean }>();
    if (!body.callId) return c.json({ message: "缺少 callId" }, 400);
    const found = resolveConfirmWaiter(session.id, body.callId, body.confirmed ?? false);
    return c.json({ ok: found });
  });

  // 清空当前登录会话的上下文（历史消息 + 待澄清状态），不影响登录态。
  app.post("/chat/context/clear", (c) => {
    const sid = getCookie(c, COOKIE);
    const session = getSession(sid);
    if (!session) return c.json({ message: "会话失效，请重新登录" }, 401);
    const ok = clearSessionContext(sid);
    return c.json({ ok });
  });

  // ---- 聊天记录持久化（方案 C：MongoDB，按登录用户归属）----
  // 身份验证：与 /chat/stream 一致，require session；ownerKey = countryId:loginName。
  const requireOwner = (c: Context) => {
    const session = getSession(getCookie(c, COOKIE));
    if (!session) return null;
    return { session, ownerKey: ownerKeyOf(session.user, session.country.id) };
  };
  async function readJson<T>(c: Context): Promise<T> {
    return c.req.json<T>().catch(() => ({} as T));
  }

  // 会话列表（按 updatedAt 倒序）
  app.get("/chat/conversations", async (c) => {
    const ctx = requireOwner(c);
    if (!ctx) return c.json({ message: "会话失效，请重新登录" }, 401);
    const list = await listConversations(ctx.ownerKey);
    return c.json({ conversations: list });
  });

  // 新建会话（body: { id?, title? }；id 缺省由服务端生成）
  app.post("/chat/conversations", async (c) => {
    const ctx = requireOwner(c);
    if (!ctx) return c.json({ message: "会话失效，请重新登录" }, 401);
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
    if (!ctx) return c.json({ message: "会话失效，请重新登录" }, 401);
    const doc = await getConversation(ctx.ownerKey, c.req.param("id"));
    if (!doc) return c.json({ message: "会话不存在" }, 404);
    return c.json({ conversation: doc });
  });

  // 保存整段消息（upsert；body: { messages, title? }）
  app.post("/chat/conversations/:id/messages", async (c) => {
    const ctx = requireOwner(c);
    if (!ctx) return c.json({ message: "会话失效，请重新登录" }, 401);
    const body = await readJson<{ messages?: StoredMessage[]; title?: string }>(c);
    if (!Array.isArray(body.messages)) return c.json({ message: "messages 必须为数组" }, 400);
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
    if (!ctx) return c.json({ message: "会话失效，请重新登录" }, 401);
    const body = await readJson<{ title?: string }>(c);
    if (!body.title?.trim()) return c.json({ message: "标题不能为空" }, 400);
    await renameConversation(ctx.ownerKey, c.req.param("id"), body.title.trim());
    return c.json({ ok: true });
  });

  // 删除会话
  app.delete("/chat/conversations/:id", async (c) => {
    const ctx = requireOwner(c);
    if (!ctx) return c.json({ message: "会话失效，请重新登录" }, 401);
    await deleteConversation(ctx.ownerKey, c.req.param("id"));
    return c.json({ ok: true });
  });

  // 清空会话消息（保留会话壳）
  app.post("/chat/conversations/:id/clear", async (c) => {
    const ctx = requireOwner(c);
    if (!ctx) return c.json({ message: "会话失效，请重新登录" }, 401);
    await clearConversation(ctx.ownerKey, c.req.param("id"));
    return c.json({ ok: true });
  });

  // 成本汇总（只读，登录即可查）：从 trace 落盘聚合 token/费用 + 预算告警
  app.get("/cost/summary", (c) => {
    const ctx = requireOwner(c);
    if (!ctx) return c.json({ message: "会话失效，请重新登录" }, 401);
    const report = aggregateCost({
      fromDay: c.req.query("from") || undefined,
      toDay: c.req.query("to") || undefined,
      sessionId: c.req.query("session") || undefined,
      slowestTopN: Number(c.req.query("top")) || 10,
    });
    return c.json({ report, alerts: budgetAlerts(report) });
  });

  // 安全审计（只读）：越权拒绝 / 写确认事件。最小权限口径——登录用户只能查
  // 自己（ownerKey）的审计事件；全局视角走服务端 CLI（inspect-audit.mjs）。
  app.get("/audit/list", (c) => {
    const ctx = requireOwner(c);
    if (!ctx) return c.json({ message: "会话失效，请重新登录" }, 401);
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
      if (!session) return c.json({ message: "会话失效，请重新登录" }, 401);
      const form = await c.req.formData();
      const files = form.getAll("files") as Array<{
        name: string;
        type: string;
        size: number;
        arrayBuffer(): Promise<ArrayBuffer>;
      }>;
      if (!files.length) return c.json({ message: "未收到文件" }, 400);
      if (files.length > MAX_AT_ONCE) {
        return c.json({ message: `一次最多上传 ${MAX_AT_ONCE} 个文件` }, 400);
      }
      const saved = [];
      for (const file of files) {
        try {
          saved.push(await saveUpload(file));
        } catch (error) {
          return c.json(
            { message: error instanceof Error ? error.message : "文件保存失败" },
            400,
          );
        }
      }
      return c.json({ files: saved });
    } catch (error) {
      console.error("[chat/upload] error:", error);
      return c.json({ message: "上传失败" }, 500);
    }
  });

  app.get("/chat/upload/:id", (c) => {
    const session = getSession(getCookie(c, COOKIE));
    if (!session) return c.json({ message: "未登录" }, 401);
    const image = getUploadImage(c.req.param("id"));
    if (!image) return c.json({ message: "图片不存在或已过期" }, 404);
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
    if (!session) return c.json({ message: "未登录" }, 401);
    const packed = readDownloadBytes(c.req.param("id"));
    if (!packed) return c.json({ message: "文件不存在或已过期" }, 404);
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
// 清多余空白/不可见字符、压缩多空格、截断超长输入。
const MAX_INPUT_LEN = 500;
function preprocess(raw: string): string {
  let text = (raw || "").replace(/\u0000/g, ""); // 去 NUL
  text = text.replace(/[ \t\u3000]+/g, " ").trim(); // 全角/多空格归一
  if (text.length > MAX_INPUT_LEN) text = `${text.slice(0, MAX_INPUT_LEN)}…`;
  return text;
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
            encoder.encode(`data: ${JSON.stringify({ type: "error", message, code: "STREAM_ERROR" })}\n\n`),
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