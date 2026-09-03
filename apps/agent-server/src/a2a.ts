// A2A (Agent2Agent) Server 出口 —— A0 阶段（语义 A：把本 agent 暴露给自有其他 agent 调用）。
// 协议依据：A2A v1.0（JSON-RPC 2.0 绑定）。本文件最小自实现，零新依赖（不引入 @a2a-js/sdk）。
//
// 设计边界（详见 docs/agent/A2A_INTEGRATION.md §3）：
// - Agent Card 用占位符级别描述，不写具体业务菜单词（守红线）。
// - A2A 层零语义判断：自然语言任务进入后全交 chatStream 引擎判断。
// - 默认只读：token 未显式 readonly:false 时，遇到写操作确认直接 REJECTED（无界面不可确认）。
// - 会话隔离：每个 A2A 任务用独立 session，loginName 前缀 `a2a:` 确保不混进 web 会话列表。
// - 不改任何现有代码路径：chatStream / tools.ts / Session 逻辑完全复用。

import type { Context, MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";
import { getCountry } from "./config.js";
import { chatStream } from "./chat.js";
import { createSession, setActiveProject } from "./session.js";

// ---- Agent Card（占位符级别，部署时替换 <...>） ----
// 规范路径：/.well-known/agent-card.json。description/skills 用通用词，不落业务词。
export const AGENT_CARD = {
  name: "BX Admin Agent",
  description:
    "企业内部后台业务查询/操作 agent：接收自然语言任务，自动定位模块与接口取数，返回整理后的文本/表格结果。仅限内部系统间调用。",
  version: "1.0.0",
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain", "application/json", "text/markdown"],
  capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
  skills: [
    {
      id: "business-query",
      name: "后台业务数据查询",
      description:
        "用自然语言描述查询目标（模块/列表/详情/统计/筛选条件），agent 自主完成接口定位与取数。",
      tags: ["query", "list", "detail", "statistics", "export"],
    },
  ],
  supportedInterfaces: [
    {
      // 部署时把 <host> 换成 agent-server 实际可达地址。
      url: "<https://<your-host>>/a2a",
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    },
  ],
  securitySchemes: {
    internalBearer: { type: "http", scheme: "bearer", bearerFormat: "opaque" },
  },
  securityRequirements: [{ internalBearer: [] }],
} as const;

// ---- Token 配置（来自 .env A2A_TOKENS，JSON 数组） ----
// 每项：{ key, label, country, project, environment, readonly? }
// readonly 缺省 true（默认拒绝写操作）。environment 仅作元数据记录（引擎当前不消费，预留）。
interface A2AToken {
  key: string;
  label: string;
  country: string;
  project: string;
  environment: string;
  readonly?: boolean;
}

function loadTokens(): A2AToken[] {
  const raw = process.env.A2A_TOKENS;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as A2AToken[]) : [];
  } catch {
    return [];
  }
}

// ---- Task 存储（进程内存；重启丢失，A0 足够；后续可换 Mongo 与会话同库） ----
type TaskState =
  | "SUBMITTED"
  | "WORKING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED"
  | "REJECTED"
  | "INPUT_REQUIRED"
  | "AUTH_REQUIRED";

interface A2AArtifactPart {
  kind: "text" | "data" | "url" | "raw";
  text?: string;
  data?: unknown;
  [k: string]: unknown;
}

interface A2AArtifact {
  artifactId: string;
  name?: string;
  parts: A2AArtifactPart[];
}

interface A2ATask {
  id: string;
  contextId: string;
  state: TaskState;
  artifacts: A2AArtifact[];
  history: Array<{ role: string; parts: A2AArtifactPart[] }>;
}

const tasks = new Map<string, A2ATask>();
const controllers = new Map<string, AbortController>();

// ---- JSON-RPC helpers ----
function rpcResult(c: Context, id: unknown, result: unknown) {
  return c.json({ jsonrpc: "2.0", id, result });
}
function rpcError(c: Context, id: unknown, code: number, message: string, httpStatus = 200) {
  return c.json({ jsonrpc: "2.0", id, error: { code, message } }, httpStatus as never);
}

// ---- 核心：Task → chatStream 映射 ----
async function runTask(
  task: A2ATask,
  text: string,
  tokenCfg: A2AToken,
  controller: AbortController,
): Promise<void> {
  const country = getCountry(tokenCfg.country);
  if (!country) {
    task.state = "FAILED";
    task.history.push({
      role: "agent",
      parts: [{ kind: "text", text: `无效 token 国家配置：${tokenCfg.country}` }],
    });
    return;
  }

  // 会话隔离：独立 session，loginName 前缀 a2a: 确保不出现在 web 用户列表。
  const session = createSession({
    token: tokenCfg.key,
    country,
    user: { loginName: `a2a:${tokenCfg.key.slice(0, 8)}`, name: tokenCfg.label },
    menus: [],
  });
  if (tokenCfg.project) {
    setActiveProject(session.id, {
      key: tokenCfg.project,
      label: tokenCfg.project,
      setAt: Date.now(),
    });
  }

  let finalText = "";
  let rejected = false;

  for await (const ev of chatStream(session, text, {}, controller.signal)) {
    if (controller.signal.aborted) break;
    if (ev.type === "text" || ev.type === "text_delta") {
      finalText += (ev as { text?: string }).text || "";
    } else if (ev.type === "table") {
      // A0：表格以 markdown 文本并入最终总结（可选 DataPart 留 A1）。
      const t = ev as unknown as { title?: string; columns?: Array<{ title: string }>; rows?: Record<string, unknown>[] };
      if (t.rows?.length) {
        finalText += `\n\n（${t.title || "表格"}：${t.rows.length} 行）`;
      }
    } else if (ev.type === "confirmation_required") {
      // 无界面不可确认 → 默认只读拒绝写。
      if (tokenCfg.readonly !== false) {
        rejected = true;
        task.state = "REJECTED";
        task.history.push({
          role: "agent",
          parts: [
            {
              kind: "text",
              text: "写操作被 A2A 通道拒绝（默认只读）。如需写权限，请在 token 配置将 readonly 置 false。",
            },
          ],
        });
        controller.abort(); // 终止引擎对 confirmation 的等待
        break;
      }
    } else if (ev.type === "error") {
      task.history.push({
        role: "agent",
        parts: [{ kind: "text", text: (ev as { message?: string }).message || "error" }],
      });
    }
  }

  if (!rejected && task.state !== "FAILED") {
    task.artifacts = [
      {
        artifactId: randomUUID(),
        parts: [{ kind: "text", text: finalText || "（无内容返回）" }],
      },
    ];
    if (task.state !== "COMPLETED") task.state = "COMPLETED";
  }
}

// ---- 中间件：Bearer 鉴权（仅校验；token 配置在 handler 内重新解析，绕开 Hono Variables 泛型约束） ----
const bearerAuth: MiddlewareHandler = async (c, next) => {
  const tokens = loadTokens();
  if (tokens.length === 0) {
    return rpcError(c, null, -32000, "A2A 未配置：设置环境变量 A2A_TOKENS 后重启", 503);
  }
  const auth = c.req.header("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return rpcError(c, null, -32000, "Unauthorized", 401);
  const cfg = tokens.find((t) => t.key === m[1]);
  if (!cfg) return rpcError(c, null, -32000, "Invalid token", 403);
  await next();
};

// ---- 路由挂载 ----
export function attachA2a(app: import("hono").Hono): void {
  // Agent Card 发现端点
  app.get("/.well-known/agent-card.json", (c) => c.json(AGENT_CARD));

  // 鉴权（仅 /a2a）
  app.use("/a2a", bearerAuth);

  // bearerAuth 中间件已对 /a2a 做「未配置→503 / 无 Auth→401 / 错 token→403」短路，handler 无需重复判空。
  app.post("/a2a", async (c) => {
    let body: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      body = await c.req.json();
    } catch {
      return rpcError(c, null, -32700, "Parse error");
    }
    const { id, method, params } = body;
    const authKey = (c.req.header("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
    const tokenCfg = loadTokens().find((t) => t.key === authKey) as A2AToken;

    if (method === "SendMessage") {
      const message = (params?.message ?? {}) as {
        messageId?: string;
        contextId?: string;
        parts?: Array<{ kind?: string; type?: string; text?: string }>;
      };
      const text = (message.parts || [])
        .filter((p) => p.kind === "text" || p.type === "text")
        .map((p) => p.text || "")
        .join("\n")
        .trim();
      if (!text) return rpcError(c, id, -32602, "message.parts 缺少文本内容");

      const contextId = message.contextId || randomUUID();
      const taskId = randomUUID();
      const task: A2ATask = {
        id: taskId,
        contextId,
        state: "SUBMITTED",
        artifacts: [],
        history: [],
      };
      tasks.set(taskId, task);
      task.state = "WORKING";
      const controller = new AbortController();
      controllers.set(taskId, controller);

      try {
        await runTask(task, text, tokenCfg, controller);
      } catch (e) {
        if ((task.state as TaskState) !== "REJECTED") {
          task.state = "FAILED";
          task.history.push({
            role: "agent",
            parts: [{ kind: "text", text: String((e as Error)?.message || e) }],
          });
        }
      } finally {
        controllers.delete(taskId);
      }
      return rpcResult(c, id, { task });
    }

    if (method === "GetTask") {
      const task = tasks.get(String(params?.id));
      if (!task) return rpcError(c, id, -32001, "Task not found");
      return rpcResult(c, id, { task });
    }

    if (method === "CancelTask") {
      const taskId = String(params?.id);
      const task = tasks.get(taskId);
      if (!task) return rpcError(c, id, -32001, "Task not found");
      task.state = "CANCELED";
      controllers.get(taskId)?.abort();
      controllers.delete(taskId);
      return rpcResult(c, id, { task });
    }

    if (method === "SendStreamingMessage" || method === "SubscribeToTask") {
      // A0 仅同步；流式留 A1。
      return rpcError(c, id, -32601, `方法 ${method} 在 A0 阶段未实现（仅同步 SendMessage）`);
    }

    return rpcError(c, id, -32601, `Method not found: ${method}`);
  });
}
