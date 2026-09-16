import type { ModelEntry } from "./config.js";

// 统一模型调用层：三种协议适配（anthropic / openai / ollama），均返回纯文本。
//
// 直连模式：不注入任何提示词、不使用工具调用通道，模型输出即答案。
// 如需极小的固定角色说明，可通过 AGENT_GUIDE 显式注入。
const DEFAULT_CHAT_GUIDE = "";

export function chatGuideSystem(): string {
  return process.env.AGENT_GUIDE || DEFAULT_CHAT_GUIDE;
}

export interface ModelTurn {
  role: "user" | "assistant";
  content: string;
}

export interface OptionImage {
  base64: string;
  mediaType: string;
}

export interface AgentResult {
  text: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export interface CallAgentOptions {
  /** 附加 system 前缀（可选）。 */
  systemExtra?: string;
}

export async function callAgent(
  model: ModelEntry,
  turns: ModelTurn[],
  images: OptionImage[],
  signal?: AbortSignal,
  opts: CallAgentOptions = {},
  onDelta?: (chunk: string) => void,
): Promise<AgentResult> {
  switch (model.provider) {
    case "anthropic":
      return callAnthropic(model, turns, images, signal, opts);
    case "openai":
      return callOpenAi(model, turns, images, signal, opts, onDelta);
    default:
      return { text: await callOllama(model, turns, images, signal) };
  }
}

// ---- 多 key 轮询与限流重试 ----
// 模块级计数器：跨请求轮询均匀分布 key（Node 单线程事件循环，无并发安全风险）。
let keyRotationCounter = 0;

/**
 * 按 key 池逐个尝试发起请求：当前 key 遇 429（限流）/5xx（服务端错误）或网络异常时，
 * 自动切换池中下一个 key 重试（最多 pool.length 轮）。4xx（如 401/403）等不可重试错误
 * 原样返回，交由上层错误处理。
 */
async function fetchWithKeyRotation(
  model: ModelEntry,
  attempt: (key: string) => Promise<Response>,
): Promise<Response> {
  const pool = model.apiKeys.length ? model.apiKeys : model.apiKey ? [model.apiKey] : [""];
  if (pool.length <= 1) return attempt(pool[0] || "");
  const start = (keyRotationCounter++) % pool.length;
  let lastErr: Error | null = null;
  for (let i = 0; i < pool.length; i++) {
    const key = pool[(start + i) % pool.length];
    try {
      const res = await attempt(key);
      if (res.ok) return res;
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        lastErr = new Error(`model http ${res.status}`);
        continue;
      }
      return res; // 4xx 等不可重试，原样返回
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      // 超时/中断不再重试（避免无限拖慢响应）
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw e;
      continue;
    }
  }
  throw lastErr || new Error(`model request failed: all ${pool.length} keys exhausted`);
}

function timeoutSignalOf(model: ModelEntry, signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(model.timeoutMs)])
    : AbortSignal.timeout(model.timeoutMs);
}

async function callAnthropic(
  model: ModelEntry,
  turns: ModelTurn[],
  images: OptionImage[],
  signal?: AbortSignal,
  opts: CallAgentOptions = {},
): Promise<AgentResult> {
  const base = model.baseUrl.replace(/\/+$/, "");
  const messages: Array<Record<string, unknown>> = turns.map((turn, index) => {
    if (index !== turns.length - 1) return { role: turn.role, content: turn.content };
    const content: Array<Record<string, unknown>> = [{ type: "text", text: turn.content }];
    if (model.vision === "direct") {
      for (const image of images) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: image.mediaType, data: image.base64 },
        });
      }
    }
    return { role: "user", content };
  });
  const system = [chatGuideSystem(), opts.systemExtra || ""].filter(Boolean).join("\n\n");
  const body: Record<string, unknown> = {
    model: model.name,
    max_tokens: 8192,
    ...(system ? { system } : {}),
    messages,
  };
  const response = await fetchWithKeyRotation(model, (key) =>
    fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: timeoutSignalOf(model, signal),
    }),
  );
  const bodyResult = (await response.json().catch(() => null)) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  } | null;
  if (!response.ok) {
    const detail = bodyResult ? JSON.stringify(bodyResult).slice(0, 500) : "";
    if (response.status === 503) {
      throw new Error(`model http 503: 模型服务暂时不可用（过载或维护中），请稍后重试（${model.name}）。原始错误：${detail}`);
    }
    throw new Error(`model http ${response.status}: ${detail}`);
  }
  const text = (bodyResult?.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text || "")
    .join("")
    .trim();
  return {
    text,
    usage: bodyResult?.usage
      ? {
          promptTokens: bodyResult.usage.input_tokens || 0,
          completionTokens: bodyResult.usage.output_tokens || 0,
          totalTokens: (bodyResult.usage.input_tokens || 0) + (bodyResult.usage.output_tokens || 0),
        }
      : undefined,
  };
}

async function callOpenAi(
  model: ModelEntry,
  turns: ModelTurn[],
  images: OptionImage[],
  signal?: AbortSignal,
  opts: CallAgentOptions = {},
  onDelta?: (chunk: string) => void,
): Promise<AgentResult> {
  const base = model.baseUrl.replace(/\/+$/, "");
  const system = [chatGuideSystem(), opts.systemExtra || ""].filter(Boolean).join("\n\n");
  const messages: Array<Record<string, unknown>> = [
    ...(system ? [{ role: "system", content: system }] : []),
    ...turns.map((turn, index) => {
      if (index !== turns.length - 1) return { role: turn.role, content: turn.content };
      const content: Array<Record<string, unknown>> = [{ type: "text", text: turn.content }];
      if (model.vision === "direct") {
        for (const image of images) {
          content.push({
            type: "image_url",
            image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
          });
        }
      }
      return { role: "user", content };
    }),
  ];
  const body: Record<string, unknown> = {
    model: model.name,
    max_tokens: 8192,
    // 流式：边生成边回包，避免网关对慢模型整包超时。
    stream: true,
    messages,
  };
  const response = await fetchWithKeyRotation(model, (key) =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: timeoutSignalOf(model, signal),
    }),
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    if (/401006|"code"\s*:\s*402|402/.test(detail) || response.status === 402) {
      throw new Error(
        `model http ${response.status}: 模型服务未开通或额度不足（${model.name}）。` +
          `请在模型服务控制台为「${model.name}」开通在线推理或激活免费体验后重试。原始错误：${detail}`,
      );
    }
    if (response.status === 503) {
      throw new Error(`model http 503: 模型服务暂时不可用（过载或维护中），请稍后重试（${model.name}）。原始错误：${detail}`);
    }
    throw new Error(`model http ${response.status}: ${detail}`);
  }
  if (!response.body) throw new Error("model http 200: 响应缺少流式 body");

  // 解析 SSE 流：逐行读 `data: {...}`，[DONE] 结束。
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let lastUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") break;
      let chunk: {
        choices?: Array<{ delta?: { content?: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk.usage) lastUsage = chunk.usage;
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) {
        text += content;
        onDelta?.(content);
      }
    }
  }
  return {
    text: text.trim(),
    usage: lastUsage
      ? {
          promptTokens: lastUsage.prompt_tokens,
          completionTokens: lastUsage.completion_tokens,
          totalTokens: lastUsage.total_tokens,
        }
      : undefined,
  };
}

async function callOllama(
  model: ModelEntry,
  turns: ModelTurn[],
  images: OptionImage[],
  signal?: AbortSignal,
): Promise<string> {
  const base = model.baseUrl.replace(/\/+$/, "");
  const last = turns[turns.length - 1];
  const system = chatGuideSystem();
  const ollamaMessages = [
    ...(system ? [{ role: "system", content: system }] : []),
    ...turns.slice(0, -1).map((turn) => ({ role: turn.role, content: turn.content })),
    {
      role: last.role,
      content: last.content,
      ...(model.vision === "direct" && images.length
        ? { images: images.map((image) => `data:${image.mediaType};base64,${image.base64}`) }
        : {}),
    },
  ];
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: model.name, stream: false, messages: ollamaMessages }),
    signal: timeoutSignalOf(model, signal),
  });
  const body = (await response.json().catch(() => null)) as { message?: { content?: string } };
  if (!response.ok) {
    const detail = body ? JSON.stringify(body).slice(0, 500) : "";
    throw new Error(`model http ${response.status}: ${detail}`);
  }
  const text = body?.message?.content?.trim() || "";
  if (!text) throw new Error("model http 200: 响应为空");
  return text;
}
