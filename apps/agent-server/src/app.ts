import { Hono, type Context } from "hono";
import type { ApiErrorPayload, LocalizedToken } from "@bx/shared";
import { cors } from "hono/cors";
import { getCookie, setCookie } from "hono/cookie";
import { config, getModel, defaultModel, listModels } from "./config.js";
import { clearSessionContext, ensureSession, SESSION_COOKIE } from "./session.js";
import {
  clearConversation,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  renameConversation,
  upsertMessages,
  type StoredMessage,
} from "./conversations.js";
import { MAX_AT_ONCE, getUploadImage, saveUpload } from "./uploads.js";

const COOKIE = SESSION_COOKIE;

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

  // 一轮对话：用户输入 → 模型 → 流式回包（SSE）。
  app.post("/chat/stream", async (c) => {
    try {
      const body = await readJson<{ text?: string; model?: string; images?: string[] }>(c);
      const text = String(body.text || "").trim();
      if (!text) return errorJson(c, 400, "CHAT_EMPTY_INPUT", "请输入内容");
      const sessionId = getCookie(c, COOKIE);
      const session = ensureSession(sessionId);
      if (session.id !== sessionId) setCookie(c, COOKIE, session.id, cookieOpts());
      const model = getModel(body.model) || defaultModel();

      return streamSse(async (send) => {
        const { chatStream } = await import("./chat.js");
        for await (const event of chatStream(session, text, {
          model: model?.id,
          images: Array.isArray(body.images) ? body.images.filter((x): x is string => typeof x === "string") : [],
        })) {
          send(event);
        }
      });
    } catch (error) {
      console.error("[chat/stream] error:", error);
      return errorJson(c, 500, "CHAT_STREAM_FAILED", error instanceof Error ? error.message : "请求失败");
    }
  });

  // 清空服务端上下文（历史消息），不影响会话记录。
  app.post("/chat/context/clear", (c) => {
    const ok = clearSessionContext(getCookie(c, COOKIE));
    return c.json({ ok });
  });

  // ---- 聊天记录持久化 ----
  app.get("/chat/conversations", async (c) => {
    const list = await listConversations();
    return c.json({ conversations: list });
  });

  app.post("/chat/conversations", async (c) => {
    const body = await readJson<{ id?: string; title?: string }>(c);
    const id = body.id || `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const doc = await createConversation({ id, title: body.title || "新对话" });
    return c.json({ conversation: doc });
  });

  app.get("/chat/conversations/:id", async (c) => {
    const doc = await getConversation(c.req.param("id"));
    if (!doc) return errorJson(c, 404, "CHAT_CONVERSATION_NOT_FOUND", "会话不存在");
    return c.json({ conversation: doc });
  });

  app.post("/chat/conversations/:id/messages", async (c) => {
    const body = await readJson<{ messages?: StoredMessage[]; title?: string }>(c);
    if (!Array.isArray(body.messages)) {
      return errorJson(c, 400, "CHAT_CONVERSATION_INVALID_MESSAGES", "messages 必须为数组");
    }
    await upsertMessages({ id: c.req.param("id"), messages: body.messages, title: body.title });
    return c.json({ ok: true });
  });

  app.put("/chat/conversations/:id", async (c) => {
    const body = await readJson<{ title?: string }>(c);
    if (!body.title?.trim()) return errorJson(c, 400, "CHAT_CONVERSATION_EMPTY_TITLE", "标题不能为空");
    await renameConversation(c.req.param("id"), body.title.trim());
    return c.json({ ok: true });
  });

  app.delete("/chat/conversations/:id", async (c) => {
    await deleteConversation(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/chat/conversations/:id/clear", async (c) => {
    await clearConversation(c.req.param("id"));
    return c.json({ ok: true });
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
        // 流已开启后无法再改 HTTP 状态码，转成一条 error 事件推给前端。
        const message = error instanceof Error ? error.message : "请求失败";
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "error", message, code: "STREAM_ERROR", error: token("STREAM_ERROR") })}\n\n`,
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
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
