import type { ModelEntry } from "./config.js";

// 统一模型调用层：三种协议适配（anthropic / openai / ollama），均返回纯文本。
// 调用方只需传入模型条目与本轮消息数组（含 OptionImage 时自动按模型能力处理）。

// 去 Prompt 依赖：默认不注入任何业务提示词。
// 如需过渡期兼容，可通过 AGENT_GUIDE 显式注入最小提示。
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

// ---- 工具调用支持（tool_use / function calling）----

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// 工具循环步骤序列：模型发出的工具调用 → 服务端执行的工具结果，交替累积。
// system: workflow 层注入的引导提示（如字段对齐指令），作为 user 消息追加到 messages。
export type AgentStep =
  | { kind: "toolCalls"; calls: ToolCall[] }
  | { kind: "toolResult"; toolCallId: string; content: string }
  | { kind: "system"; text: string };

export interface AgentToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** M0（工具领域分组）：通用分类词（backend-api/knowledge/common 等），非业务词，符合红线；listAgentTools 自动附带 */
  domain?: string;
}

export interface AgentResult {
  text: string;
  toolCalls: ToolCall[];
}

export interface CallAgentOptions {
  /** auto=模型自行决定；required=本轮必须调用至少一个工具（workflow tool-gate 首轮使用） */
  toolChoice?: "auto" | "required";
  /**
   * 静态引导前缀（对齐 Cursor 静态 prompt 缓存）：作为 system 首条消息稳定注入，
   * 同一请求多轮循环中前缀一致 → OpenAI 兼容端点可命中 prompt cache。
   */
  systemExtra?: string;
}

// 带工具能力的模型调用：按协议构建消息（anthropic: tool_use/tool_result；openai: function calling），
// 返回文本或工具调用。ollama 不支持工具，降级为纯文本调用。
export async function callAgent(
  model: ModelEntry,
  turns: ModelTurn[],
  images: OptionImage[],
  tools: AgentToolDef[],
  steps: AgentStep[],
  signal?: AbortSignal,
  opts: CallAgentOptions = {},
  onDelta?: (chunk: string) => void,
): Promise<AgentResult> {
  switch (model.provider) {
    case "anthropic":
      return callAnthropicAgent(model, turns, images, tools, steps, signal, opts);
    case "openai":
      return callOpenAiAgent(model, turns, images, tools, steps, signal, opts, onDelta);
    default:
      return { text: await callOllama(model, turns, images, signal), toolCalls: [] };
  }
}

// ---- 多 key 轮询与限流重试（对齐 NVIDIA 免费层单 key 40 RPM 限额的绕开方案）----
// 模块级计数器：跨请求轮询均匀分布 key（Node 单线程事件循环，无并发安全风险）。
let keyRotationCounter = 0;

/**
 * 从模型 key 池中 round-robin 选取一个 key。
 * 池为空时退回单 key / 空串，保证任意模型可调用。
 */
function pickRotationKey(model: ModelEntry): string {
  const pool = model.apiKeys.length ? model.apiKeys : model.apiKey ? [model.apiKey] : [""];
  return pool[(keyRotationCounter++) % pool.length];
}

/**
 * 按 key 池逐个尝试发起请求：当前 key 遇 429（限流）/5xx（服务端错误）或网络异常时，
 * 自动切换池中下一个 key 重试（最多 pool.length 轮）。4xx（如 401/403）等不可重试错误
 * 原样返回，交由上层错误处理。
 * @param model      模型条目（取其 apiKeys 池）
 * @param attempt    以指定 key 发请求，返回 Response
 * @returns 首个成功的 Response（ok 或不可重试的 4xx）
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
        // 可重试：限流 / 服务端错误 → 切下一 key
        lastErr = new Error(`model http ${res.status}`);
        continue;
      }
      return res; // 4xx 等不可重试，原样返回
    } catch (e) {
      // 网络/连接异常也尝试下一 key；超时/中断不再重试（避免无限拖慢响应）
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw e;
      continue;
    }
  }
  throw lastErr || new Error(`model request failed: all ${pool.length} keys exhausted`);
}

async function callAnthropicAgent(
  model: ModelEntry,
  turns: ModelTurn[],
  images: OptionImage[],
  tools: AgentToolDef[],
  steps: AgentStep[],
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
  for (const step of steps) {
    if (step.kind === "toolCalls") {
      messages.push({
        role: "assistant",
        content: step.calls.map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input,
        })),
      });
    } else if (step.kind === "system") {
      // workflow 层注入的引导提示：作为 user 文本消息追加，让模型在下一轮 LLM 调用中感知
      messages.push({ role: "user", content: [{ type: "text", text: step.text }] });
    } else {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: step.toolCallId, content: step.content }],
      });
    }
  }
  const body: Record<string, unknown> = {
    model: model.name,
    max_tokens: 8192,
    ...(chatGuideSystem() ? { system: chatGuideSystem() } : {}),
    messages,
    ...(tools.length && model.tools !== false
      ? {
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
          tool_choice: opts.toolChoice === "required" ? { type: "any" } : { type: "auto" },
        }
      : {}),
  };
  const timeoutSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(model.timeoutMs)])
    : AbortSignal.timeout(model.timeoutMs);
  const response = await fetchWithKeyRotation(model, (key) =>
    fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: timeoutSignal,
    }),
  );
  const bodyResult = (await response.json().catch(() => null)) as {
    content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  } | null;
  if (!response.ok) {
    const detail = bodyResult ? JSON.stringify(bodyResult).slice(0, 500) : "";
    // 服务暂时不可用（过载/维护/上游抖动）：与 openai 分支一致，给「稍后重试」的可操作提示
    if (response.status === 503) {
      throw new Error(
        `model http 503: 模型服务暂时不可用（过载或维护中），请稍后重试（${model.name}）。原始错误：${detail}`,
      );
    }
    throw new Error(`model http ${response.status}: ${detail}`);
  }
  const text = (bodyResult?.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text || "")
    .join("")
    .trim();
  const toolCalls: ToolCall[] = (bodyResult?.content || [])
    .filter((block) => block.type === "tool_use" && block.id && block.name)
    .map((block) => ({ id: block.id!, name: block.name!, input: (block.input as Record<string, unknown>) || {} }));
  return { text, toolCalls };
}

async function callOpenAiAgent(
  model: ModelEntry,
  turns: ModelTurn[],
  images: OptionImage[],
  tools: AgentToolDef[],
  steps: AgentStep[],
  signal?: AbortSignal,
  opts: CallAgentOptions = {},
  onDelta?: (chunk: string) => void,
): Promise<AgentResult> {
  const base = model.baseUrl.replace(/\/+$/, "");
  // system 首条 = 全局指南 + 静态引导前缀（对齐 Cursor 静态 prompt 缓存）：
  // staticGuide 由 preprocess 产出（角色/协议/项目/规则/技能目录/闲聊边界），同一请求
  // 多轮循环中完全一致 → OpenAI 兼容端点命中 prompt cache（省 token + 提速）。
  // 空 system 不发该消息：部分 OpenAI 兼容网关（如 Kimi）严格校验首条 system 不得为空，
  // 会以 400 400001 拒绝。AGENT_GUIDE 未配置时默认不注入任何提示词。
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
  for (const step of steps) {
    if (step.kind === "toolCalls") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: step.calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })),
      });
    } else if (step.kind === "system") {
      // workflow 层注入的引导提示：作为 user 消息追加
      messages.push({ role: "user", content: step.text });
    } else {
      messages.push({ role: "tool", tool_call_id: step.toolCallId, content: step.content });
    }
  }
  const body: Record<string, unknown> = {
    model: model.name,
    max_tokens: 8192,
    // 流式：边生成边回包，避免 TokenHub 网关对慢模型整包超时报 504（504001）。
    stream: true,
    messages,
    ...(tools.length && model.tools !== false
      ? {
          tools: tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
          // 思考模型（如 TokenHub DeepSeek-V4-Pro）在 reasoning 模式下不支持 tool_choice != auto，
          // 强制 required 会触发 400001。对齐腾讯云官方 Function Calling 示例做法：显式关闭思考模式
          // （thinking.type=disabled），从而恢复 tool_choice 的 required/auto 语义，让首轮强制工具
          // 调用机制（方案 C）对其完全生效，且不丢失业务 agent 能力（工具调用链另有 reasoning 事件展示）。
          tool_choice: opts.toolChoice === "required" ? "required" : "auto",
        }
      : {}),
    // 思考模型关闭思考模式：避免与 tool_choice 强制冲突，同时降低 token 消耗（官方推荐）。
    ...(model.thinking ? { thinking: { type: "disabled" } } : {}),
  };
  const timeoutSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(model.timeoutMs)])
    : AbortSignal.timeout(model.timeoutMs);
  const response = await fetchWithKeyRotation(model, (key) =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: timeoutSignal,
    }),
  );
  if (!response.ok) {
    // 网关错误（如 504001 上游超时）也会带 JSON body，原样抛出让上层重试/提示。
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    // 模型服务未开通/额度不足：把 401006（服务 ID 不存在或未开通）与 402（未开通或额度不足）
    // 转成可操作的引导文案，避免前端只看到裸错误码。
    if (/401006|"code"\s*:\s*402|402/.test(detail) || response.status === 402) {
      throw new Error(
        `model http ${response.status}: 模型服务未开通或额度不足（${model.name}）。` +
          `请在腾讯云 TokenHub 控制台（广州地域）为「${model.name}」开通在线推理服务或激活免费体验，` +
          `确认服务状态为「运行中」后重试。原始错误：${detail}`,
      );
    }
    // 服务暂时不可用（过载/维护/上游抖动）：区别于永久性错误，给「稍后重试」的可操作提示
    if (response.status === 503) {
      throw new Error(
        `model http 503: 模型服务暂时不可用（过载或维护中），请稍后重试（${model.name}）。原始错误：${detail}`,
      );
    }
    throw new Error(`model http ${response.status}: ${detail}`);
  }

  // 解析 SSE 流：逐行读取 `data: {...}`，[DONE] 结束。
  // 兼容流式 tool_calls 分片：按 index 累积 function.arguments。
  let text = "";
  // 模型可能不走 function calling 通道，将 tool_calls JSON 以纯文本 delta.content 输出，
  // 甚至用 ```json ... ``` 围栏包裹。用以下状态机缓存并检测：
  let contentPending = "";
  let fenceDetect = false;
  let jsonDetect = false;
  // XML 形态伪调用丢弃（2026-08-26 选项 A）：弱模型退化时把工具调用写成
  // <tool_call><function=call_api>...</tool_call> 伪 XML 文本而非走 schema 通道。
  // 响应层直接丢弃该片段（不累积进 text / 不推前端），understand 节点看到空 text →
  // 触发首轮 [workflow/tool-calling] retry 把调用纠正回 function calling 通道。
  // 仅在「本应走 schema 工具」场景（tools.length 为真）才丢弃，避免误伤闲聊/知识库正常文本
  // （XML 伪调用标签是工具模拟专属形态，与业务语义无关，纯协议层判定）。
  const xmlPseudoActive = tools.length > 0;
  const XML_PSEUDO_RE = /<\s*tool_call\b|<[\w-]+\s*=\s*(?:search_api_module|read_api_module|call_api|grep_codebase|submit_understood_intent|request_clarification|export_dataset)\b/;
  let xmlPseudoDetect = false;
  const toolAccum = new Map<number, { id?: string; name?: string; arguments: string }>();
  // 从文本 JSON 中提取的额外 tool_calls（模型误将 function calling 输出为纯文本）
  const textParsedToolCalls: ToolCall[] = [];

  /** 从一段文本中解析工具调用 JSON。
   *  兼容形态：{"tool_calls":[{name,parameters|input},...]} 对象、
   *  [{name,parameters|input},...] 裸数组、[[{name,...}]] 嵌套数组、单个 {name,parameters} 对象。
   *  JSON 整体解析失败（模型输出残缺/被截断，zen 免费链实测输出未闭合 [[{...}]）时，
   *  退化为正则逐对象提取，不依赖完整闭合。
   *  返回空数组表示非工具调用形态（普通 JSON/普通文本）。 */
  function extractToolCallsFromJson(raw: string): ToolCall[] {
    const out: ToolCall[] = [];
    const stripped = raw.replace(/^```[\s\S]*?\n/, "").replace(/\n?```\s*$/, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      return extractToolCallsViaRegex(stripped);
    }
    const items: unknown[] = [];
    if (Array.isArray(parsed)) {
      // 裸数组或嵌套数组（模型常输出 [[{...}]] 双重包裹）→ 拍平收集元素
      const flatten = (arr: unknown[]) => {
        for (const v of arr) {
          if (Array.isArray(v)) flatten(v);
          else items.push(v);
        }
      };
      flatten(parsed);
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.tool_calls)) items.push(...(obj.tool_calls as unknown[]));
      else if (typeof obj.name === "string") items.push(obj); // 单个工具对象形态
    }
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const fn =
        o.function && typeof o.function === "object" ? (o.function as Record<string, unknown>) : null;
      const name = String(o.name || fn?.name || "").trim();
      if (!name) continue;
      let args: unknown = o.parameters ?? o.input ?? o.arguments ?? fn?.arguments ?? {};
      if (typeof args === "string") args = safeParseJson(args);
      if (args && typeof args === "object") {
        out.push({
          id: `text-parsed-${Date.now()}-${out.length}`,
          name,
          input: args as Record<string, unknown>,
        });
      }
    }
    return out;
  }

  /** 正则 + 括号配平兜底：JSON 整体不完整（模型输出残缺 [[{...}] 等）时，
   *  定位 {"name":"xxx","parameters|input":{...}} 对象，用括号深度配平提取 parameters，
   *  不依赖 JSON 整体闭合、兼容 parameters 内嵌套对象。 */
  function extractToolCallsViaRegex(raw: string): ToolCall[] {
    const out: ToolCall[] = [];
    const nameRe = /\{\s*"name"\s*:\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = nameRe.exec(raw))) {
      const name = m[1];
      const seg = raw.slice(m.index);
      const km = /"(?:parameters|input|arguments)"\s*:\s*/.exec(seg);
      if (!km) continue;
      const argsStart = m.index + km.index + km[0].length;
      if (raw[argsStart] === '"') {
        // arguments 为字符串 → 提取到字符串尾
        const endQuote = raw.indexOf('"', argsStart + 1);
        if (endQuote < 0) continue;
        try {
          const parsed = JSON.parse(raw.slice(argsStart, endQuote + 1));
          if (parsed && typeof parsed === "object") {
            out.push({ id: `text-parsed-${Date.now()}-${out.length}`, name, input: parsed });
          }
        } catch { /* skip */ }
        nameRe.lastIndex = endQuote + 1;
        continue;
      }
      if (raw[argsStart] !== "{") continue;
      // 括号深度配平扫描（忽略字符串内字符）
      let depth = 0;
      let inStr = false;
      let esc = false;
      let end = -1;
      for (let i = argsStart; i < raw.length; i++) {
        const ch = raw[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end < 0) continue;
      try {
        const parsed = JSON.parse(raw.slice(argsStart, end + 1));
        if (parsed && typeof parsed === "object") {
          out.push({ id: `text-parsed-${Date.now()}-${out.length}`, name, input: parsed });
        }
      } catch { /* skip */ }
      nameRe.lastIndex = end + 1; // 跳过已消费片段，避免同对象重复匹配
    }
    return out;
  }
  if (!response.body) {
    throw new Error("model http 200: 响应缺少流式 body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
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
        choices?: Array<{
          delta?: {
            content?: string | null;
            tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
          };
        }>;
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        // ── 状态机：检测模型误将 tool_calls JSON 作为纯文本输出 ──
        // XML 伪调用丢弃（最早判定，优先级高于 fence/json 检测）：
        // 弱模型退化出 <tool_call><function=call_api>... 时直接丢弃，不污染 text/history。
        if (xmlPseudoActive) {
          if (xmlPseudoDetect) {
            // 已在 XML 伪调用缓冲中：遇到 </tool_call> 或行首新标签才退出
            if (/<\s*\/\s*tool_call\s*>|<\s*tool_call\s*>/.test(delta.content)) {
              xmlPseudoDetect = false;
            }
            // 丢弃内容（不累积进 text，不推前端）
            continue;
          }
          if (XML_PSEUDO_RE.test(delta.content)) {
            // 命中 XML 伪调用标记 → 进入丢弃模式
            xmlPseudoDetect = true;
            continue;
          }
        }
        if (fenceDetect) {
          // 在围栏模式：累积到 contentPending，检查是否关闭围栏
          contentPending += delta.content;
          if (/```\s*$/.test(contentPending)) {
            // 围栏结束：尝试解析工具调用（兼容 {tool_calls} / 裸数组 / 嵌套数组）
            const extracted = extractToolCallsFromJson(contentPending);
            if (extracted.length) {
              textParsedToolCalls.push(...extracted);
            } else {
              // 不是工具调用 JSON → 释放围栏内容给前端
              text += contentPending;
              onDelta?.(contentPending);
            }
            contentPending = "";
            fenceDetect = false;
          }
        } else if (jsonDetect) {
          // 在裸 JSON 检测模式：累积内容，尝试解析
          contentPending += delta.content;
          // 尝试完整解析：若成功说明 JSON 已闭合
          let parsed: unknown = null;
          try { parsed = JSON.parse(contentPending); } catch { /* incomplete JSON */ }
          if (parsed !== null) {
            const extracted = extractToolCallsFromJson(contentPending);
            if (extracted.length) {
              textParsedToolCalls.push(...extracted);
            } else {
              // 非工具调用形态的普通 JSON → 释放给前端
              text += contentPending;
              onDelta?.(contentPending);
            }
            contentPending = "";
            jsonDetect = false;
          }
        } else {
          // 新内容到达：判断是否进入检测模式
          if (/^```/.test(delta.content)) {
            // markdown 围栏开头 → 进入围栏检测，缓冲整段
            fenceDetect = true;
            contentPending = delta.content;
          } else if (/^\s*[\{\[]/.test(delta.content)) {
            // 裸 JSON / 数组开头（模型常输出 [[{...}]] 嵌套数组）→ 进入 JSON 检测
            jsonDetect = true;
            contentPending = delta.content;
          } else {
            // 普通文本，直接推送
            text += delta.content;
            onDelta?.(delta.content);
          }
        }
      }
      for (const tc of delta.tool_calls || []) {
        const idx = tc.index;
        const acc = toolAccum.get(idx) || { arguments: "" };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.arguments += tc.function.arguments;
        toolAccum.set(idx, acc);
      }
    }
  }
  if (buffer.trim().startsWith("data:")) {
    const payload = buffer.trim().slice(5).trim();
    if (payload && payload !== "[DONE]") {
      try {
        const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string | null } }> };
        if (chunk.choices?.[0]?.delta?.content) {
          const tail = chunk.choices[0].delta.content!;
          if (xmlPseudoActive && xmlPseudoDetect) {
            if (/<\s*\/\s*tool_call\s*>|<\s*tool_call\s*>/.test(tail)) xmlPseudoDetect = false;
            // 丢弃尾部 XML 伪调用片段
          } else if (xmlPseudoActive && XML_PSEUDO_RE.test(tail)) {
            xmlPseudoDetect = true;
          } else if (fenceDetect) {
            contentPending += tail;
            if (/```\s*$/.test(contentPending)) {
              const extracted = extractToolCallsFromJson(contentPending);
              if (extracted.length) {
                textParsedToolCalls.push(...extracted);
              } else {
                text += contentPending;
                onDelta?.(contentPending);
              }
              contentPending = "";
              fenceDetect = false;
            }
          } else if (jsonDetect) {
            contentPending += tail;
            let parsed: unknown = null;
            try { parsed = JSON.parse(contentPending); } catch { /* incomplete */ }
            if (parsed !== null) {
              const extracted = extractToolCallsFromJson(contentPending);
              if (extracted.length) {
                textParsedToolCalls.push(...extracted);
              } else {
                text += contentPending;
                onDelta?.(contentPending);
              }
              contentPending = "";
              jsonDetect = false;
            }
          } else if (/^```/.test(tail)) {
            fenceDetect = true;
            contentPending = tail;
          } else if (/^\s*[\{\[]/.test(tail)) {
            jsonDetect = true;
            contentPending = tail;
          } else {
            text += tail;
          }
        }
      } catch {
        /* ignore trailing partial */
      }
    }
  }

  // 流结束后：未关闭的围栏或未确认的 JSON → 尝试解析或释放
  if (fenceDetect || jsonDetect) {
    if (contentPending) {
      const extracted = extractToolCallsFromJson(contentPending);
      if (extracted.length) {
        textParsedToolCalls.push(...extracted);
      } else {
        text += contentPending;
        onDelta?.(contentPending);
      }
    }
    contentPending = "";
    fenceDetect = false;
    jsonDetect = false;
  }

  // 合并两种来源的 tool_calls：正常 function calling 通道 + 纯文本 JSON 解析
  const toolCalls: ToolCall[] = [
    ...[...toolAccum.values()]
      .filter((acc) => acc.id && acc.name)
      .map((acc) => ({
        id: acc.id!,
        name: acc.name!,
        input: safeParseJson(acc.arguments),
      })),
    ...textParsedToolCalls,
  ];

  return { text: text.trim(), toolCalls };
}

function safeParseJson(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function callOllama(model: ModelEntry, turns: ModelTurn[], images: OptionImage[], signal?: AbortSignal): Promise<string> {
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
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(model.timeoutMs)]) : AbortSignal.timeout(model.timeoutMs),
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