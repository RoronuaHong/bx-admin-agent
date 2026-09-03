// A2A (Agent2Agent) Client 出口 —— 语义 B 的协议客户端半边（B0 代码骨架）。
// 零新依赖：原生 fetch 实现 A2A v1.0 的 JSON-RPC 2.0 绑定。
// 用途：把本 agent 作为 client 调外部自有 agent 的 A2A Server；亦可自环测试本 agent 的 A0 /a2a。
// 红线：本文件只做协议客户端（方法名/状态机/Task 结构均为跨系统通用协议契约），不含任何业务词；
//       不集成进 multi-agent 路由（remote worker 接入留 M3，见 A2A_INTEGRATION.md §3.3）。

import { randomUUID } from "node:crypto";

// ---- 最小协议类型（与 a2a.ts Server 端一致，独立定义避免跨文件耦合） ----
export type A2ATaskState =
  | "SUBMITTED"
  | "WORKING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED"
  | "REJECTED"
  | "INPUT_REQUIRED"
  | "AUTH_REQUIRED";

export interface A2AArtifactPart {
  kind: "text" | "data" | "url" | "raw";
  text?: string;
  data?: unknown;
  [k: string]: unknown;
}

export interface A2AArtifact {
  artifactId: string;
  name?: string;
  parts: A2AArtifactPart[];
}

export interface A2ATask {
  id: string;
  contextId: string;
  state: A2ATaskState;
  artifacts: A2AArtifact[];
  history: Array<{ role: string; parts: A2AArtifactPart[] }>;
}

export interface A2AAgentCard {
  name: string;
  description?: string;
  version?: string;
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    extendedAgentCard?: boolean;
    extensions?: unknown[];
  };
  skills?: Array<{ id: string; name?: string; description?: string; tags?: string[]; [k: string]: unknown }>;
  supportedInterfaces?: Array<{ url: string; protocolBinding?: string; protocolVersion?: string; [k: string]: unknown }>;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  securitySchemes?: Record<string, unknown>;
  securityRequirements?: unknown[];
  [k: string]: unknown;
}

export interface A2AClientOptions {
  agentCardUrl?: string; // 覆盖发现端点（默认 `${baseUrl}/.well-known/agent-card.json`）
  timeoutMs?: number; // 默认 60000
  fetchImpl?: typeof fetch; // 注入（测试/SSR 环境）
}

export class A2AClientError extends Error {
  constructor(public code: number, message: string) {
    super(`[A2A ${code}] ${message}`);
    this.name = "A2AClientError";
  }
}

// ---- 超时包装：统一 AbortController + setTimeout，避免每处重复 ----
async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, opts: A2AClientOptions = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60000);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

// ---- 底层 JSON-RPC 调用 ----
async function rpcCall(baseUrl: string, token: string, method: string, params: unknown, opts: A2AClientOptions = {}): Promise<any> {
  const doFetch = opts.fetchImpl ?? fetch;
  return withTimeout(async (signal) => {
    const res = await doFetch(`${baseUrl}/a2a`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "A2A-Version": "1.0",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
      signal,
    });
    const json: any = await res.json().catch(() => ({}));
    if (json.error) throw new A2AClientError(json.error.code, json.error.message);
    if (!res.ok) throw new A2AClientError(-32000, `HTTP ${res.status}`);
    return json.result;
  }, opts);
}

// ---- 发现：获取对端 Agent Card ----
export async function fetchAgentCard(baseUrl: string, opts: A2AClientOptions = {}): Promise<A2AAgentCard> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = opts.agentCardUrl ?? `${baseUrl}/.well-known/agent-card.json`;
  return withTimeout(async (signal) => {
    const res = await doFetch(url, { signal });
    if (!res.ok) throw new A2AClientError(-32000, `AgentCard HTTP ${res.status}`);
    return (await res.json()) as A2AAgentCard;
  }, opts);
}

// ---- 主交互：发消息（同步，returnImmediately=false） ----
export async function sendA2AMessage(
  baseUrl: string,
  token: string,
  text: string,
  opts: A2AClientOptions & { contextId?: string; messageId?: string } = {},
): Promise<A2ATask> {
  const messageId = opts.messageId ?? randomUUID();
  const result = await rpcCall(
    baseUrl,
    token,
    "SendMessage",
    { message: { messageId, contextId: opts.contextId, parts: [{ kind: "text", text }] } },
    opts,
  );
  return result.task as A2ATask;
}

export async function getA2ATask(baseUrl: string, token: string, taskId: string, opts: A2AClientOptions = {}): Promise<A2ATask> {
  const result = await rpcCall(baseUrl, token, "GetTask", { id: taskId }, opts);
  return result.task as A2ATask;
}

export async function cancelA2ATask(baseUrl: string, token: string, taskId: string, opts: A2AClientOptions = {}): Promise<A2ATask> {
  const result = await rpcCall(baseUrl, token, "CancelTask", { id: taskId }, opts);
  return result.task as A2ATask;
}

// ---- 便捷：从 task 聚合最终文本 ----
export function extractTaskText(task: A2ATask): string {
  return (task.artifacts ?? [])
    .flatMap((a) => a.parts.filter((p) => p.kind === "text").map((p) => p.text ?? ""))
    .join("\n\n")
    .trim();
}

export async function a2aRunTask(
  baseUrl: string,
  token: string,
  text: string,
  opts: A2AClientOptions & { contextId?: string } = {},
): Promise<{ task: A2ATask; text: string }> {
  const task = await sendA2AMessage(baseUrl, token, text, opts);
  return { task, text: extractTaskText(task) };
}
