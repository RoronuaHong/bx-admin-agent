import { randomUUID } from "node:crypto";
import { config, type ModelEntry } from "./config.js";

// 统一模型调用层：三种协议适配（anthropic / openai / ollama），均返回纯文本。
//
// 直连模式：不注入任何提示词、不使用工具调用通道，模型输出即答案。
// 如需极小的固定角色说明，可通过 AGENT_GUIDE 显式注入。
const DEFAULT_CHAT_GUIDE = "";

function chatGuideSystem(): string {
  return process.env.AGENT_GUIDE || DEFAULT_CHAT_GUIDE;
}

/**
 * 粗略 token 估算（无外部分词器依赖）：CJK/全角字符约 1 token/字，其余约 4 字符/token。
 * 只用于上下文预算，不要求精确；比按字符计数更接近真实占用。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = Array.from(text);
  let wide = 0;
  for (const ch of chars) {
    const cp = ch.codePointAt(0) || 0;
    if (cp > 0x2e80) wide++;
  }
  return Math.ceil(wide + (chars.length - wide) / 4);
}

/** 一组文本的 token 合计。 */
export function estimateTokensOf(texts: string[]): number {
  return texts.reduce((sum, text) => sum + estimateTokens(text), 0);
}

export interface ModelTurn {
  role: "user" | "assistant";
  content: string;
  /** assistant 消息携带的工具调用（上一轮模型产出，需回灌给模型保持上下文）。 */
  toolCalls?: ToolCall[];
}

/** 工具执行结果消息（OpenAI 的 role:tool / anthropic 的 tool_result）。 */
export interface ToolResultTurn {
  role: "tool";
  toolCallId: string;
  name: string;
  content: string;
}

export type Turn = ModelTurn | ToolResultTurn;

export interface OptionImage {
  base64: string;
  mediaType: string;
}

/** 注入模型的工具定义（OpenAI function 形状，anthropic 在适配层转换）。 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** 参数 JSON 字符串（流式增量拼接；解析失败时为空对象字符串）。 */
  argsJson: string;
}

export interface AgentResult {
  text: string;
  toolCalls: ToolCall[];
}

export interface CallOptions {
  tools?: ToolSpec[];
  toolChoice?: "auto" | "none" | "required";
  /** 原生联网搜索（选项 A）：对齐通用 Agent「开箱即有联网搜索」的标配；按 host 自适应各家声明方式。 */
  webSearch?: boolean;
  /**
   * 系统提示的两段式形态（Deep Agents 的 prompt caching 思路）：
   * `stable` 跨轮不变（角色守则 + skills 索引）→ anthropic 加 cache_control 标记缓存；
   * `dynamic` 低频变化（记忆 / 摘要 / 语言）。OpenAI 兼容通道的隐式前缀缓存无需标记。
   */
  systemParts?: { stable: string; dynamic: string };
}

export async function callAgent(
  model: ModelEntry,
  turns: Turn[],
  images: OptionImage[],
  signal?: AbortSignal,
  onDelta?: (chunk: string) => void,
  opts: CallOptions = {},
  /** 扩展思考增量回调：仅在支持 thinking 的模型（Claude 3.7+/4、o 系列）且有思考输出时触发。 */
  onThinking?: (chunk: string) => void,
): Promise<AgentResult> {
  switch (model.provider) {
    case "anthropic":
      return callAnthropic(model, turns, images, signal, onDelta, opts, onThinking);
    case "openai":
      return callOpenAi(model, turns, images, signal, onDelta, opts, onThinking);
    default:
      return { text: await callOllama(model, turns, images, signal, opts), toolCalls: [] };
  }
}

/**
 * 是否对该 anthropic 模型开启扩展思考（extended thinking）：
 * - 仅对已知支持思考的模型族启用，避免不支持的网关收到 thinking 参数直接 400。
 * - 环境变量 ANTHROPIC_THINKING 可强制开（"1"/"true"）或关（"0"/"false"）。
 * 开启时返回的 budget_tokens 必须小于 max_tokens（模型硬性约束），这里取一半并夹在 [1024, max-1]。
 */
function anthropicThinkingBudget(model: ModelEntry): number | null {
  const env = process.env.ANTHROPIC_THINKING;
  if (env === "0" || env === "false") return null;
  const name = model.name.toLowerCase();
  const supports = /claude-(3-7-sonnet|opus-4|sonnet-4|3-7|4[.\-])/.test(name);
  const forced = env === "1" || env === "true";
  if (!supports && !forced) return null;
  const budget = Math.floor(config.maxOutputTokens / 2);
  return budget >= 1024 && budget < config.maxOutputTokens ? budget : null;
}

function hasTools(opts: CallOptions): boolean {
  return Array.isArray(opts.tools) && opts.tools.length > 0;
}

/** 系统提示 = 两段式（稳定段 + 动态段），缺失时退化为固定引导。 */
function systemPrompt(opts: CallOptions): string {
  const parts: string[] = [chatGuideSystem()];
  if (opts.systemParts) parts.push(opts.systemParts.stable, opts.systemParts.dynamic);
  return parts.filter((part) => part && part.trim()).join("\n\n");
}

/**
 * anthropic 的 system 形态：两段式时把稳定段标记为可缓存（cache_control ephemeral），
 * 动态段跟随其后 —— 摘要/记忆变化只破坏后缀，前缀仍命中。
 */
function anthropicSystem(opts: CallOptions): string | Array<Record<string, unknown>> | undefined {
  if (!opts.systemParts) {
    const system = systemPrompt(opts);
    return system || undefined;
  }
  const { stable, dynamic } = opts.systemParts;
  if (!stable && !dynamic) return undefined;
  const blocks: Array<Record<string, unknown>> = [];
  if (stable) blocks.push({ type: "text", text: stable, cache_control: { type: "ephemeral" } });
  if (dynamic) blocks.push({ type: "text", text: dynamic });
  return blocks;
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

/** 转成 anthropic 消息：工具结果用 user 消息里的 tool_result 块回灌（与官方文档一致）。 */
function toAnthropicMessages(
  model: ModelEntry,
  turns: Turn[],
  images: OptionImage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const isLast = i === turns.length - 1;
    if (turn.role === "tool") {
      const block = { type: "tool_result", tool_use_id: turn.toolCallId, content: turn.content };
      const prev = out[out.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content)) {
        (prev.content as unknown[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (turn.role === "assistant" && turn.toolCalls?.length) {
      const content: unknown[] = [];
      if (turn.content) content.push({ type: "text", text: turn.content });
      for (const call of turn.toolCalls) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: safeJsonParse(call.argsJson) });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    if (turn.role === "user" && isLast && model.vision === "direct" && images.length) {
      const content: unknown[] = [{ type: "text", text: turn.content }];
      for (const image of images) {
        content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } });
      }
      out.push({ role: "user", content });
      continue;
    }
    out.push({ role: turn.role, content: turn.content });
  }
  return out;
}

export function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function callAnthropic(
  model: ModelEntry,
  turns: Turn[],
  images: OptionImage[],
  signal: AbortSignal | undefined,
  onDelta: ((chunk: string) => void) | undefined,
  opts: CallOptions = {},
  onThinking?: ((chunk: string) => void) | undefined,
): Promise<AgentResult> {
  const base = model.baseUrl.replace(/\/+$/, "");
  const messages = toAnthropicMessages(model, turns, images);
  const system = anthropicSystem(opts);
  // 扩展思考：开启后模型先产出 thinking 块再产出正文；thinking 块不计入最终回复正文。
  const budget = anthropicThinkingBudget(model);
  const body: Record<string, unknown> = {
    model: model.name,
    max_tokens: config.maxOutputTokens,
    // 流式：边生成边回包，避免网关对慢模型整包超时（不支持时按非流式降级解析）。
    stream: true,
    ...(budget ? { thinking: { type: "enabled", budget_tokens: budget } } : {}),
    ...(system ? { system } : {}),
    messages,
    ...(hasTools(opts)
      ? {
          tools: (opts.tools || []).map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
          tool_choice: { type: opts.toolChoice || "auto" },
        }
      : {}),
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
  const isStream = (response.headers.get("content-type") || "").includes("text/event-stream");
  if (!isStream) {
    // 网关不支持流式：按整包 JSON 解析（保持原有语义）。
    const bodyResult = (await response.json().catch(() => null)) as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    } | null;
    if (!response.ok) {
      const detail = bodyResult ? JSON.stringify(bodyResult).slice(0, 500) : "";
      if (response.status === 503) {
        throw new Error(
          `model http 503: 模型服务暂时不可用（过载或维护中），请稍后重试（${model.name}）。原始错误：${detail}`,
        );
      }
      throw new Error(`model http ${response.status}: ${detail}`);
    }
    const blocks = bodyResult?.content || [];
    // 非流式降级：若网关回包含 thinking 块，整段回传给前端做「思考过程」展示。
    const thinkingText = blocks
      .filter((block) => block.type === "thinking")
      .map((block) => (block as { thinking?: string }).thinking || "")
      .join("");
    if (thinkingText) onThinking?.(thinkingText);
    return {
      text: blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text || "")
        .join("")
        .trim(),
      toolCalls: blocks
        .filter((block) => block.type === "tool_use")
        .map((block, index) => ({
          id: block.id || `tool_${index}`,
          name: block.name || "",
          argsJson: JSON.stringify(block.input ?? {}),
        })),
    };
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    if (response.status === 503) {
      throw new Error(`model http 503: 模型服务暂时不可用（过载或维护中），请稍后重试（${model.name}）。原始错误：${detail}`);
    }
    throw new Error(`model http ${response.status}: ${detail}`);
  }
  if (!response.body) throw new Error("model http 200: 响应缺少流式 body");

  // 解析 SSE：event 行给出事件名，data 行是 JSON 负载（text_delta / input_json_delta / message_stop）。
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let text = "";
  // 工具调用按 content block 的 index 累积：start 给 id/name，delta 给 arguments 片段。
  const pendingTools = new Map<number, { id: string; name: string; args: string }>();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let event: {
        type?: string;
        index?: number;
        delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
        content_block?: { type?: string; id?: string; name?: string };
      };
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        const index = typeof event.index === "number" ? event.index : 0;
        pendingTools.set(index, {
          id: event.content_block.id || "",
          name: event.content_block.name || "",
          args: "",
        });
        continue;
      }
      if (event.type === "content_block_delta") {
        const index = typeof event.index === "number" ? event.index : 0;
        if (event.delta?.type === "text_delta" && event.delta.text) {
          text += event.delta.text;
          onDelta?.(event.delta.text);
        } else if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
          // 扩展思考增量：回传前端做实时「思考过程」展示（不计入最终正文）。
          onThinking?.(event.delta.thinking);
        } else if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
          const current = pendingTools.get(index) || { id: "", name: "", args: "" };
          current.args += event.delta.partial_json;
          pendingTools.set(index, current);
        }
        continue;
      }
      if (event.type === "error") {
        throw new Error(`model stream error: ${payload.slice(0, 300)}`);
      }
      if (eventName === "message_stop" || event.type === "message_stop") break;
    }
  }
  const toolCalls: ToolCall[] = [...pendingTools.entries()]
    .map(([index, call]) => ({
      id: call.id || `tool_${index}`,
      name: call.name,
      argsJson: call.args || "{}",
    }))
    .filter((call) => call.name);
  return { text, toolCalls };
}

/** 转成 OpenAI 消息：assistant 带 tool_calls，工具结果用 role:tool 回灌。 */
function toOpenAiMessages(
  model: ModelEntry,
  turns: Turn[],
  images: OptionImage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const isLast = i === turns.length - 1;
    if (turn.role === "tool") {
      out.push({ role: "tool", tool_call_id: turn.toolCallId, content: turn.content });
      continue;
    }
    if (turn.role === "assistant" && turn.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: turn.content || null,
        tool_calls: turn.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.argsJson },
        })),
      });
      continue;
    }
    if (turn.role === "user" && isLast && model.vision === "direct" && images.length) {
      const content: Array<Record<string, unknown>> = [{ type: "text", text: turn.content }];
      for (const image of images) {
        content.push({
          type: "image_url",
          image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
        });
      }
      out.push({ role: "user", content });
      continue;
    }
    out.push({ role: turn.role, content: turn.content });
  }
  return out;
}

/**
 * 重复惩罚（repetition penalty）：默认关闭（返回 null），避免某些网关不支持该参数时整体 400。
 * 模型偶发把同一句话回声式重复多遍，根因在模型侧；设 MODEL_FREQUENCY_PENALTY / MODEL_PRESENCE_PENALTY
 * 开启（0.2 / 0.1 较温和）可从源头抑制。设为 0 或 off 等同关闭。
 */
function parseModelPenalty(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const v = Number(raw.trim());
  return Number.isFinite(v) && v !== 0 ? v : null;
}

/**
 * 已知不支持 OpenAI 原生联网搜索（web_search_preview）的网关（按 baseUrl 记录）。
 * 首次遇到 400 后记住，后续调用直接不带搜索，避免每次白费一次往返与延迟（日志也不再刷屏）。
 */
const webSearchUnsupportedHosts = new Set<string>();

async function callOpenAi(
  model: ModelEntry,
  turns: Turn[],
  images: OptionImage[],
  signal?: AbortSignal,
  onDelta?: (chunk: string) => void,
  opts: CallOptions = {},
  onThinking?: ((chunk: string) => void) | undefined,
): Promise<AgentResult> {
  const base = model.baseUrl.replace(/\/+$/, "");
  const system = systemPrompt(opts);
  const messages: Array<Record<string, unknown>> = [
    ...(system ? [{ role: "system", content: system }] : []),
    ...toOpenAiMessages(model, turns, images),
  ];
  const freqPenalty = parseModelPenalty(process.env.MODEL_FREQUENCY_PENALTY);
  const presPenalty = parseModelPenalty(process.env.MODEL_PRESENCE_PENALTY);
  // 原生联网搜索（选项 A）：对齐 CodeBuddy/Cursor/千问「开箱即有联网搜索」的通用 Agent 标配。
  // 按 host 自适应各家声明方式；未支持的网关在 .env 设 AGENT_WEB_SEARCH=0 即可整体关闭。
  // 若网关不支持该工具声明（如部分私有部署对 web_search_preview 返回 400），自动降级为「不带搜索」
  // 重试一次——保证联网搜索是「尽力增强」而非「可能把整个调用打挂」（工具模式与直连模式共用）。
  const functionToolsBase: Array<Record<string, unknown>> = hasTools(opts)
    ? (opts.tools || []).map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }))
    : [];

  const attempt = async (webSearchOn: boolean): Promise<Response> => {
    const functionTools = [...functionToolsBase];
    const body: Record<string, unknown> = {
      model: model.name,
      max_tokens: config.maxOutputTokens,
      // 流式：边生成边回包，避免网关对慢模型整包超时。
      stream: true,
      messages,
      ...(freqPenalty != null ? { frequency_penalty: freqPenalty } : {}),
      ...(presPenalty != null ? { presence_penalty: presPenalty } : {}),
    };
    if (webSearchOn) {
      const host = (model.baseUrl || "").replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
      if (host.includes("dashscope") || host.includes("aliyun")) {
        // 通义/千问：请求级联网开关（独立参数，不与 tools 数组冲突）。
        body.enable_search = true;
      } else {
        // OpenAI 及兼容网关（DeepSeek / Qwen / Kimi 等走 OpenAI 协议）：声明 web_search_preview。
        functionTools.push({ type: "web_search_preview", search_context_size: "medium" });
      }
    }
    if (functionTools.length) {
      body.tools = functionTools;
      body.tool_choice = opts.toolChoice || "auto";
    }
    return fetchWithKeyRotation(model, (key) =>
      fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: timeoutSignalOf(model, signal),
      }),
    );
  };

  // 已确认不支持的网关直接跳过注入，省掉「先失败再降级」的额外往返。
  const webSearchWanted = !!opts.webSearch && !webSearchUnsupportedHosts.has(base);
  let response = await attempt(webSearchWanted);
  // 失败详情只读一次：Response body 是单次消费流，第二次 .text() 只能拿到空串，
  // 会把网关的真实报错吞成一句「model http 400: 」（排查时完全看不到原因）。
  let failureDetail = "";
  if (!response.ok) {
    failureDetail = (await response.text().catch(() => "")).slice(0, 500);
    const webSearchBroke =
      webSearchWanted &&
      (response.status === 400 ||
        /web.?search|unsupported.?tool|unknown parameter|tool_choice|invalid.*tool/i.test(failureDetail));
    if (webSearchBroke) {
      webSearchUnsupportedHosts.add(base);
      console.warn(
        `[models] 网关不支持联网搜索工具（${response.status}），自动降级为不带搜索重试（后续该网关将直接跳过联网搜索）：${failureDetail}`,
      );
      response = await attempt(false);
      // 换了新响应对象：详情留空，由下面那处按需重新读取这次响应的 body。
      failureDetail = "";
    }
  }
  if (!response.ok) {
    const detail = failureDetail || (await response.text().catch(() => "")).slice(0, 500);
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
  // 流式工具调用是分片增量（index/id/name/arguments 分别到达），按 index 累积拼接。
  const pendingTools = new Map<number, { id: string; name: string; args: string }>();
  let finished = false;
  while (!finished) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        finished = true;
        break;
      }
      let chunk: {
        choices?: Array<{
          delta?: {
            content?: string | null;
            reasoning?: string | null;
            // OpenAI 官方 o 系列用 delta.reasoning；但 DeepSeek / Qwen / Kimi 等 OpenAI 兼容
            // 网关把思考流放在 delta.reasoning_content，漏读会导致思考过程被静默丢弃。
            reasoning_content?: string | null;
            tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
          };
        }>;
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta;
      const content = delta?.content;
      if (content) {
        text += content;
        onDelta?.(content);
      }
      // 推理模型在正式回答前下发思考流：OpenAI 官方 o 系列用 delta.reasoning，
      // DeepSeek / Qwen / Kimi 等兼容网关用 delta.reasoning_content；非推理模型两者皆无，自然忽略。
      const reasoning = delta?.reasoning ?? delta?.reasoning_content;
      if (reasoning) onThinking?.(reasoning);
      for (const part of delta?.tool_calls || []) {
        const index = typeof part.index === "number" ? part.index : 0;
        const current = pendingTools.get(index) || { id: "", name: "", args: "" };
        if (part.id) current.id = part.id;
        // 工具名只在首个分片出现；重复分片时不要拼接成 "namenamename"（部分网关每片都回传 name）。
        if (part.function?.name && !current.name) current.name = part.function.name;
        if (part.function?.arguments) current.args += part.function.arguments;
        pendingTools.set(index, current);
      }
    }
  }
  const toolCalls: ToolCall[] = [...pendingTools.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, call]) => ({
      // 兜底 id 不可猜（原来是 call_<index>）：callId 会参与确认流程关联，可预测 id 有被冒用的空间。
      id: call.id || `call_${randomUUID()}`,
      name: call.name,
      argsJson: call.args || "{}",
    }))
    .filter((call) => Boolean(call.name));
  return { text: text.trim(), toolCalls };
}

async function callOllama(
  model: ModelEntry,
  turns: Turn[],
  images: OptionImage[],
  signal?: AbortSignal,
  opts: CallOptions = {},
): Promise<string> {
  const base = model.baseUrl.replace(/\/+$/, "");
  // ollama 通道不接工具：工具结果降级为 user 文本，保证多轮上下文仍然连贯。
  const plain = turns.map((turn) =>
    turn.role === "tool"
      ? { role: "user" as const, content: `[工具 ${turn.name} 返回]\n${turn.content}` }
      : { role: turn.role, content: turn.content },
  );
  const last = plain[plain.length - 1];
  const system = systemPrompt(opts);
  const ollamaMessages = [
    ...(system ? [{ role: "system", content: system }] : []),
    ...plain.slice(0, -1).map((turn) => ({ role: turn.role, content: turn.content })),
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
