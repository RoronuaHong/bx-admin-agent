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
  /** 该轮模型产出的思考流（reasoning / reasoning_content）。默认只作展示；仅当端点被记为「要求回灌思考」
   *  （见 reasoningReplayRequired）时，才作为 assistant 消息的 reasoning_content 一并回传，保持多轮语义完整。 */
  reasoning?: string;
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
  /** 本轮思考流原文（无思考的模型为空串）。调用方负责决定是否随 assistant 轮回灌（见 ModelTurn.reasoning）。 */
  reasoning?: string;
}

export interface CallOptions {
  tools?: ToolSpec[];
  toolChoice?: "auto" | "none" | "required";
  /**
   * 关闭该次调用的「扩展思考」（OpenAI 兼容通道专用）。
   * 用于**内部辅助调用**（如数据需求分诊、受约束兜底话术）——它们只要一个词或一两句话，思考纯属浪费延迟。
   * 实测（探测脚本 `scripts/_model-thinking-probe.mjs` 已随调试脚本清理移除，口径回归见 `tests/thinking.test.ts`；
   * TokenHub kimi 系端点）：只有 `thinking:{type:"disabled"}`
   * 被端点接受且思考归零（769ms vs 基线 1363ms），`enable_thinking` / `chat_template_kwargs` 会被忽略。
   * 默认不传该字段：不把可能被陌生网关拒绝的参数塞给所有调用；调用方按需显式开启，失败路径本身有兜底。
   */
  disableThinking?: boolean;
  /**
   * 采样温度。**只给判定型内部调用显式设置**（事后核验 / 数据需求分诊 / 诚实兜底）——
   * 它们是「判对错」的调用，采样随机会让同一段回答今天拦、明天放，护栏自己就成了新的随机源。
   * 主对话刻意不设：通用聊天与创作需要多样性，且各网关默认值不同，统一写死反而改变既有行为。
   * 与 `disableThinking` 同风格：不传就不塞参数，避免把可能不被接受的字段塞给所有调用。
   */
  temperature?: number;
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
    // 空 assistant 轮（无正文、也无工具调用）对上游是非法消息（"... with role 'assistant' must not be empty"）。
    // 历史上出现过这种轮次（用户在任何正文产生前点「停止」时曾回写空轮）——这里做**边界自愈**：
    // 直接丢弃、不发给上游。否则一条脏历史会让该会话每次请求都失败，且候选链救不了（所有模型同样 400）。
    if (turn.role === "assistant" && !String(turn.content || "").trim() && !turn.toolCalls?.length) continue;
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
    ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
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

/**
 * 「回灌 assistant 工具调用消息时必须带 reasoning_content」的端点集合（进程内学习，重启后重学一次）。
 *
 * 问题（通用，非某家独有）：思考类模型在**多轮工具循环**里，常要求把上一轮的思考作为 `reasoning_content`
 * 随 assistant 消息一起回灌；缺字段就直接 400，表现为「工具明明取到了数据，最终回复却空白」。
 * 实测原文形如 `thinking is enabled but reasoning_content is missing in assistant tool call message`
 * （DeepSeek / Qwen / Kimi 等 OpenAI 兼容网关的 thinking 模式都有同类校验，措辞各异）。
 *
 * 为什么不「一律带上」：各网关对未知字段的容忍度不同，给不需要它的端点塞这个字段有被 400 的风险
 * （同当年 `web_search_preview` 的教训）。所以按端点学习：首跳缺字段被拒 → 记住 → 同一轮内按新口径重发一次
 * → 之后该端点一直按新口径组装消息。学习信号来自网关自己的报错，不写死任何厂商名或固定话术。
 *
 * 统一纪律（本文件三条端点学习——回灌思考 / 关思考 / 温度——共用）：
 * ①记住后必须落到**默认行为**，不能只在重发那一次生效；②重发仍失败必须**回滚记忆**
 * （见 unmarkReasoningReplayRequired / unmarkDisableThinkingUnsupported / unmarkTemperatureUnsupported）。
 */
const reasoningReplayRequiredEndpoints = new Set<string>();

function openAiEndpointKeyOf(model: ModelEntry): string {
  return `${model.id}@${String(model.baseUrl || "")}`;
}

/** 该模型端点是否已被记为「要求回灌思考」（true 时 assistant 工具调用消息会带 reasoning_content）。 */
export function reasoningReplayRequired(model: ModelEntry): boolean {
  return reasoningReplayRequiredEndpoints.has(openAiEndpointKeyOf(model));
}

/** 记录「该端点要求回灌思考」（进程内记忆；首跳报错由调用方传入）。 */
export function markReasoningReplayRequired(model: ModelEntry): void {
  const key = openAiEndpointKeyOf(model);
  if (reasoningReplayRequiredEndpoints.has(key)) return;
  reasoningReplayRequiredEndpoints.add(key);
  console.warn(
    `[models] 端点要求 assistant 工具调用消息回灌 reasoning_content（模型 ${model.id}）：` +
      "已按该口径重发，且该端点后续都按此口径组装消息",
  );
}

/**
 * 撤销「要求回灌思考」的记忆：补上 reasoning_content 后仍失败 → 根因不在该字段，回滚并如实报错。
 * 与 unmarkTemperatureUnsupported 同一条纪律：学习信号来自报错措辞，措辞是通用串，
 * 有误判空间；自愈无效时若把推测固化，就会永久给每个 assistant 消息挂一个它本不需要的字段。
 */
export function unmarkReasoningReplayRequired(model: ModelEntry): void {
  const key = openAiEndpointKeyOf(model);
  if (!reasoningReplayRequiredEndpoints.delete(key)) return;
  console.warn(
    `[models] 端点（模型 ${model.id}）补 reasoning_content 后仍失败：撤销记忆，根因不在该字段，按原始报错如实抛出`,
  );
}

/**
 * 判定一次失败是否属于「assistant 工具调用消息缺思考内容」。
 * 只认协议级字段名（reasoning_content）+ 通用缺失类措辞，不绑定任何厂商名或整句报错——换网关也适用。
 */
export function isReasoningReplayRejected(detail: string): boolean {
  const text = String(detail || "");
  if (!/reasoning[_\s-]?content/i.test(text)) return false;
  return /(missing|required|absent|not\s+found|expect|need|invalid|empty)/i.test(text);
}

/**
 * 关思考（disableThinking）同样受端点兼容性制约：部分端点（如 kimi27hs）只接受 thinking:{type:"enabled"}，
 * 收 disabled 会 400（"invalid thinking: only type=enabled is allowed"）。按端点运行时学习：首跳被拒 → 记住不支持
 * → 之后内部辅助调用省略 thinking 字段（模型按默认开启），避免每次白打 400 拖垮接地护栏的兜底路径。
 */
const disableThinkingUnsupportedEndpoints = new Set<string>();

/**
 * 本次调用是否要关思考：内部辅助调用（判定型）或模型级主对话开关任一为真。
 * 主对话开关默认关闭，只有被实测确认「思考链是纯延迟负担」的模型才会打开，故不影响通用行为。
 */
function wantNoThinking(model: ModelEntry, opts: CallOptions): boolean {
  return Boolean(opts.disableThinking || model.disableThinking);
}

/** 该模型端点是否仍可尝试关闭思考（false = 已实测被拒，辅助调用省略 thinking 字段）。 */
export function disableThinkingSupported(model: ModelEntry): boolean {
  return !disableThinkingUnsupportedEndpoints.has(openAiEndpointKeyOf(model));
}

/** 记录「该端点不支持关闭思考」（进程内记忆；首跳报错由调用方传入）。 */
function markDisableThinkingUnsupported(model: ModelEntry): void {
  const key = openAiEndpointKeyOf(model);
  if (disableThinkingUnsupportedEndpoints.has(key)) return;
  disableThinkingUnsupportedEndpoints.add(key);
  console.warn(
    `[models] 端点不支持关闭思考（模型 ${model.id}）：内部辅助调用改为省略 thinking 字段，由模型按默认处理`,
  );
}

/** 撤销「不支持关闭思考」的记忆：省略 thinking 后仍失败 → 根因不在该字段，回滚并如实报错（同 unmarkTemperatureUnsupported）。 */
function unmarkDisableThinkingUnsupported(model: ModelEntry): void {
  const key = openAiEndpointKeyOf(model);
  if (!disableThinkingUnsupportedEndpoints.delete(key)) return;
  console.warn(
    `[models] 端点（模型 ${model.id}）省略 thinking 字段后仍失败：撤销记忆，根因不在该字段，按原始报错如实抛出`,
  );
}

/** 判定一次失败是否属于「端点拒绝 disabled 思考」。只认 thinking 相关的通用报错措辞，不绑定厂商。 */
function isThinkingDisabledRejected(detail: string): boolean {
  const text = String(detail || "");
  return /invalid thinking|only type=enabled is allowed|type=disabled|thinking.*(not.*allowed|invalid|unsupported)/i.test(text);
}

/**
 * 温度字段同样受端点兼容性制约：实测 TokenHub 的 kimi 系（kimi-k2.8-preview / kimi-k2.6）根本不接受
 * `temperature` 参数——任何取值（含 0 与 0.01）都 400，但缺省（不带该字段）反而正常。
 * 温度 0 只用于内部判定型辅助调用（见 CallOptions.temperature 注释），故影响的是接地护栏的
 * 分诊 / 诚实兜底等路径。按端点运行时学习：首跳被拒 → 记住整字段不受支持 → 之后这类调用省略 temperature
 * 重发一次，由模型按默认采样，避免每次白打 400、把接地护栏的兜底路径拖垮（表现为「明明有额度却回确定性兜底文案」）。
 */
const temperatureUnsupportedEndpoints = new Set<string>();

/** 该模型端点是否仍可发送 temperature 字段（false = 已实测被拒，辅助调用省略该字段）。 */
export function temperatureSupported(model: ModelEntry): boolean {
  return !temperatureUnsupportedEndpoints.has(openAiEndpointKeyOf(model));
}

/** 记录「该端点不接受 temperature 字段」（进程内记忆）。 */
function markTemperatureUnsupported(model: ModelEntry): void {
  const key = openAiEndpointKeyOf(model);
  if (temperatureUnsupportedEndpoints.has(key)) return;
  temperatureUnsupportedEndpoints.add(key);
  console.warn(
    `[models] 端点不接受 temperature 字段（模型 ${model.id}）：内部判定型辅助调用改为省略该字段，由模型按默认采样`,
  );
}

/**
 * 撤销上面的记忆（自愈无效时回滚）。
 * 为什么必须能回滚：判定「是不是这个字段的锅」靠的是报错措辞，措辞是通用串（invalid_request 一类），
 * 有误判空间。若省略后仍然 400，说明根因在别处——此时若把「该端点不接受 temperature」固化下来，
 * 就会永久拿掉一个本可携带的参数，并把真实原因掩盖成一条无害的默认值。故失败即回滚，如实报错。
 */
function unmarkTemperatureUnsupported(model: ModelEntry): void {
  const key = openAiEndpointKeyOf(model);
  if (!temperatureUnsupportedEndpoints.delete(key)) return;
  console.warn(
    `[models] 端点（模型 ${model.id}）省略 temperature 后仍失败：撤销记忆，根因不在该字段，按原始报错如实抛出`,
  );
}

/**
 * 判定一次失败是否属于「端点拒绝 temperature: 0」。温度 0 只出现在内部辅助调用，
 * 这类调用结构简单（无工具、短提示），且 thinking 拒绝已在上一道分支处理，故剩余 400 多半是温度 0。
 * 只认 temperature 相关措辞或通用 invalid_request 报错，不绑定厂商。
 */
function isTempZeroRejected(detail: string): boolean {
  const text = String(detail || "");
  if (/invalid_request_error|invalid_request|rejected by an internal|check the request body|required fields/i.test(text)) return true;
  if (/temperature/i.test(text)) return true;
  return false;
}

/** 转成 OpenAI 消息：assistant 带 tool_calls，工具结果用 role:tool 回灌。 */
function toOpenAiMessages(
  model: ModelEntry,
  turns: Turn[],
  images: OptionImage[],
  /** 是否给带工具调用的 assistant 消息补 `reasoning_content`（端点要求时开，见 reasoningReplayRequired）。 */
  withReasoningReplay = false,
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
        // 端点要求时回灌上一轮思考：有原文就用原文（多轮语义完整），网关只校验「字段在不在」，故缺了给空串。
        ...(withReasoningReplay ? { reasoning_content: turn.reasoning || "" } : {}),
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
    // 空 assistant 轮自愈（与 Anthropic 转换器同口径）：不带正文、也不带工具调用的 assistant 消息
    // 对上游是非法参数，整条会话会每次请求都 400。丢弃它——这种轮次不含任何信息。
    if (turn.role === "assistant" && !String(turn.content || "").trim() && !turn.toolCalls?.length) continue;
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
  const freqPenalty = parseModelPenalty(process.env.MODEL_FREQUENCY_PENALTY);
  const presPenalty = parseModelPenalty(process.env.MODEL_PRESENCE_PENALTY);
  // 只声明 function tool：Chat Completions 协议里没有服务端内置的联网搜索工具
  // （`web_search_preview` 属于 Responses API，塞进 tools 会被网关判为非法参数直接 400）。
  // 联网能力因此以普通内置工具（web_search / fetch_url）提供，见 src/web-search.ts。
  const functionTools: Array<Record<string, unknown>> = hasTools(opts)
    ? (opts.tools || []).map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }))
    : [];

  /**
   * 组装并按当前口径发一次请求。抽成函数是为了「学习型自愈」能原样重发：
   * `withReasoningReplay` 打开时，带工具调用的 assistant 消息会补 `reasoning_content`（见上方
   * reasoningReplayRequired 的说明）。除该字段外，两次请求的一切都相同。
   */
  const postOnce = (
    withReasoningReplay: boolean,
    // 默认跟随运行时学习结果：已确认「整字段拒收」的端点一律不再带 temperature（见 markTemperatureUnsupported）。
    // 只在这里兜底还不够——自愈分支本身要求 temperatureSupported 为真，端点一旦被记住就会永远跳过自愈，
    // 于是每次调用仍照带该字段、每次都白打 400。故省略必须是「默认行为」，自愈只是首次的触发点。
    omitTemperature = !temperatureSupported(model),
  ): Promise<Response> => {
    const messages: Array<Record<string, unknown>> = [
      ...(system ? [{ role: "system", content: system }] : []),
      ...toOpenAiMessages(model, turns, images, withReasoningReplay),
    ];
    // 温度：仅内部判定型调用显式给 0（见 CallOptions.temperature 注释）。实测 TokenHub 部分端点
    // （kimi 系）根本不接受 temperature 参数——任何值都 400，缺省反而正常；且同样的端点也不接受 top_p，
    // 故这里始终不发送 top_p。拒收过的端点由 omitTemperature 默认值接管，天然不再带该字段。
    const temp = omitTemperature ? undefined : opts.temperature;
    const body: Record<string, unknown> = {
      model: model.name,
      max_tokens: config.maxOutputTokens,
      // 流式：边生成边回包，避免网关对慢模型整包超时。
      stream: true,
      ...(temp != null ? { temperature: temp } : {}),
      messages,
      ...(freqPenalty != null ? { frequency_penalty: freqPenalty } : {}),
      ...(presPenalty != null ? { presence_penalty: presPenalty } : {}),
      // 关思考有两个来源：内部辅助调用（判定型，只要一两个词，见 CallOptions.disableThinking）
      // 与模型级主对话开关（MODEL_<ID>_DISABLE_THINKING，见 config.ts）。
      // 该端点实测不支持 disabled 时省略字段（运行时学习，见 markDisableThinkingUnsupported）。
      ...(wantNoThinking(model, opts) && disableThinkingSupported(model)
        ? { thinking: { type: "disabled" } }
        : {}),
    };
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

  const alreadyReplaying = reasoningReplayRequired(model);
  let response = await postOnce(alreadyReplaying);
  // 失败详情只读一次：Response body 是单次消费流，第二次 .text() 只能拿到空串，
  // 会把网关的真实报错吞成一句「model http 400: 」（排查时完全看不到原因）。
  let detail = "";
  if (!response.ok) {
    detail = (await response.text().catch(() => "")).slice(0, 500);
    // 学习型自愈（通用，不认厂商）：端点抱怨 assistant 工具调用消息缺 reasoning_content → 记住并补上重发一次。
    if (!alreadyReplaying && isReasoningReplayRejected(detail)) {
      markReasoningReplayRequired(model);
      response = await postOnce(true);
      detail = response.ok ? "" : (await response.text().catch(() => "")).slice(0, 500);
      // 自愈无效 → 回滚记忆（同 unmarkTemperatureUnsupported）：别把「按措辞做的推测」固化成永久口径。
      if (!response.ok) unmarkReasoningReplayRequired(model);
    }
    // 辅助调用可能同时带 temperature:0 与 thinking:{type:disabled}。
    // 报错点名时只去掉那一个字段；不点名时先去掉 temperature，仍 400 再把两个都去掉
    // （与主对话已能通过的请求体一致）。某一跳仍失败则回滚对应记忆。
    let healedThinking = false;
    let healedTemp = false;
    let triedCombined = false;
    while (!response.ok) {
      if (!healedThinking && wantNoThinking(model, opts) && disableThinkingSupported(model) && isThinkingDisabledRejected(detail)) {
        markDisableThinkingUnsupported(model);
        response = await postOnce(alreadyReplaying);
        detail = response.ok ? "" : (await response.text().catch(() => "")).slice(0, 500);
        // 自愈无效（省略后仍失败）→ 回滚记忆：根因不是这个字段，别把误判固化成永久行为。
        if (!response.ok) unmarkDisableThinkingUnsupported(model);
        healedThinking = true;
        continue;
      }
      if (!healedTemp && opts.temperature === 0 && response.status === 400 && temperatureSupported(model) && isTempZeroRejected(detail)) {
        markTemperatureUnsupported(model);
        response = await postOnce(alreadyReplaying);
        detail = response.ok ? "" : (await response.text().catch(() => "")).slice(0, 500);
        if (!response.ok) unmarkTemperatureUnsupported(model);
        healedTemp = true;
        continue;
      }
      if (
        !triedCombined &&
        wantNoThinking(model, opts) &&
        opts.temperature === 0 &&
        healedTemp &&
        response.status === 400 &&
        isTempZeroRejected(detail)
      ) {
        triedCombined = true;
        markDisableThinkingUnsupported(model);
        markTemperatureUnsupported(model);
        response = await postOnce(alreadyReplaying);
        detail = response.ok ? "" : (await response.text().catch(() => "")).slice(0, 500);
        if (!response.ok) {
          unmarkDisableThinkingUnsupported(model);
          unmarkTemperatureUnsupported(model);
        }
        continue;
      }
      break;
    }
  }
  if (!response.ok) {
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
  // 思考流累积（除转发展示外还要回传：端点要求时需随 assistant 消息回灌，见 reasoningReplayRequired）。
  let reasoningText = "";
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
      if (reasoning) {
        reasoningText += reasoning;
        onThinking?.(reasoning);
      }
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
  return { text: text.trim(), toolCalls, ...(reasoningText ? { reasoning: reasoningText } : {}) };
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
