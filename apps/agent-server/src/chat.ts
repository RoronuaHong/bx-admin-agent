// 聊天引擎。
// 未勾选 MCP：一次模型调用 + 流式输出（与瘦身后的直连行为完全一致）。
// 勾选 MCP：把 MCP 工具注入模型，按「模型出 tool_calls → 执行 → 结果回灌 → 再调用」循环，
//           直到模型给出结论或达到轮次上限。
import type { ChatEvent } from "@bx/shared";
import { config, defaultModel, getModel, type ModelEntry } from "./config.js";
import { waitForConfirmation } from "./confirm.js";
import { appendContext, getConversation } from "./conversations.js";
import {
  callAgent,
  estimateTokens,
  estimateTokensOf,
  type OptionImage,
  type ToolCall,
  type ToolSpec,
  type Turn,
} from "./models.js";
import { callMcpTool, collectTools, toolNeedsConfirm, type McpToolInfo } from "./mcp/hub.js";
import type { ChatTurn, ToolHandle } from "./session.js";
import { getUploadImage } from "./uploads.js";

const HISTORY_MAX_TURNS = Number(process.env.HISTORY_MAX_TURNS || 8);
// 上下文预算以 token 计，并由「模型窗口」推导（不再用与模型无关的固定字符数）。
const CONTEXT_SAFETY_RATIO = Number(process.env.CONTEXT_SAFETY_RATIO || 0.8);
// 本轮工具结果预算（token）与「最近 N 组不清理」——沿用 trigger / keep 的语义。
const TOOL_RESULT_BUDGET = Number(process.env.MCP_TOOL_RESULT_BUDGET || 12_000);
const TOOL_RESULT_KEEP = Number(process.env.MCP_TOOL_RESULT_KEEP || 3);
// 白名单：名单内工具的结果永不清理（逗号分隔工具名）。
const TOOL_RESULT_PROTECTED = new Set(
  (process.env.MCP_TOOL_RESULT_PROTECT || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);
const TOOL_RESULT_CLEARED = "…（较早的工具结果已清理以节省上下文；需要该数据请重新调用对应工具）";
// 句柄里的参数原文上限，避免参数本身占满上下文。
const HANDLE_ARGS_CHARS = Number(process.env.MCP_HANDLE_ARGS_CHARS || 200);
// MCP 护栏：工具数量、工具循环轮次、单条工具结果回灌长度。
const MCP_MAX_TOOLS = Number(process.env.MCP_MAX_TOOLS || 80);
const MAX_TOOL_ROUNDS = Number(process.env.MCP_MAX_TOOL_ROUNDS || 14);
const MAX_TOOL_RESULT_CHARS = Number(process.env.MCP_MAX_TOOL_RESULT_CHARS || 12_000);

// 对话语言 → 回复语言指令（通用 i18n 语言名，与业务无关）。
const LOCALE_DIRECTIVES: Record<string, string> = {
  zh: "Respond in Simplified Chinese.",
  en: "Respond in English.",
  "pt-BR": "Respond in Brazilian Portuguese.",
  hi: "Respond in Hindi.",
};

/** 该对话指定的语言 → 一条 system 指令；未指定语言时返回空串（不打扰模型）。 */
function languageDirective(locale?: string | null): string {
  return LOCALE_DIRECTIVES[locale || ""] || "";
}

/** 把某轮的工具句柄渲染成可读行（只有「查过什么」，不含结果正文）。 */
export function renderHandles(handles: ToolHandle[] | undefined): string {
  if (!handles?.length) return "";
  const lines = handles.map(
    (handle) => `- ${handle.name}${handle.args ? ` ${handle.args}` : ""}${handle.summary ? ` → ${handle.summary}` : ""}`,
  );
  return `\n\n[本轮已执行的工具]\n${lines.join("\n")}`;
}

/** 单轮对话在上下文里的文本形态：正文 + 工具句柄。 */
function turnContent(turn: { text: string; handles?: ToolHandle[] }): string {
  return `${turn.text}${renderHandles(turn.handles)}`;
}

/** 历史预算 = (窗口 − 输出预留 − 工具 schema − 本轮工具结果预算) × 安全系数。 */
function historyBudgetTokens(model: ModelEntry, toolSchemaTokens: number): number {
  const reserved = config.maxOutputTokens + toolSchemaTokens + TOOL_RESULT_BUDGET;
  return Math.max(1000, Math.floor((model.contextWindow - reserved) * CONTEXT_SAFETY_RATIO));
}

/**
 * 构造发往模型的跨轮上下文：窗口内最近若干轮（正文 + 工具句柄），再按 token 预算丢弃最早的消息。
 * 丢弃时保证首条是 user —— 部分 provider（如 anthropic）要求消息以 user 开头。
 * `history` 即该对话的 `conversation.context`（thread 的唯一真相）。
 */
export function buildTurns(
  history: ChatTurn[],
  userText: string,
  budgetTokens: number,
): { turns: Turn[]; dropped: number; tokens: number } {
  const all = Array.isArray(history) ? history : [];
  const windowed = all.slice(-HISTORY_MAX_TURNS * 2);
  const turns: Turn[] = windowed.map((m) => ({ role: m.role, content: turnContent(m) }));
  turns.push({ role: "user", content: userText });
  let tokens = estimateTokensOf(turns.map((turn) => turn.content));
  let dropped = all.length - windowed.length;
  while (turns.length > 1 && (tokens > budgetTokens || turns[0].role !== "user")) {
    const removed = turns.shift() as Turn;
    tokens -= estimateTokens(removed.content);
    dropped += 1;
  }
  return { turns, dropped, tokens };
}

function truncateArgs(raw: string): string {
  const text = (raw || "").trim();
  return text.length > HANDLE_ARGS_CHARS ? `${text.slice(0, HANDLE_ARGS_CHARS)}…` : text;
}

/** 结果规模摘要（供跨轮句柄使用，不含正文）。 */
function handleSummary(content: string): string {
  const lines = content ? content.split("\n").length : 0;
  return `${lines} 行 / ${content.length} 字符`;
}

function toolSpecsOf(tools: McpToolInfo[]): ToolSpec[] {
  return tools.slice(0, MCP_MAX_TOOLS).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

/**
 * 本轮工具结果治理：超出预算时从最旧的开始清理并替换为占位文本，
 * 但永远保留最近 TOOL_RESULT_KEEP 组、且不清理白名单工具。返回清理条数。
 */
export function governToolResults(conversation: Turn[]): number {
  const toolTurns = conversation.filter((turn) => turn.role === "tool");
  if (!toolTurns.length) return 0;
  let total = estimateTokensOf(toolTurns.map((turn) => turn.content));
  const older = toolTurns.filter(
    (turn, index) =>
      index < toolTurns.length - TOOL_RESULT_KEEP &&
      !TOOL_RESULT_PROTECTED.has(turn.name || "") &&
      turn.content !== TOOL_RESULT_CLEARED,
  );
  let cleared = 0;
  for (const turn of older) {
    if (total <= TOOL_RESULT_BUDGET) break;
    total -= estimateTokens(turn.content);
    turn.content = TOOL_RESULT_CLEARED;
    cleared += 1;
  }
  return cleared;
}

function imagesOf(ids: string[] | undefined): OptionImage[] {
  const out: OptionImage[] = [];
  for (const id of ids || []) {
    const img = getUploadImage(id);
    if (img) out.push({ base64: img.data.toString("base64"), mediaType: img.mediaType });
  }
  return out;
}

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 截断工具结果；尽量切在行边界，避免把 TSV / JSON 的某一行从中间劈开。 */
function truncateResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const head = text.slice(0, MAX_TOOL_RESULT_CHARS);
  const cut = head.lastIndexOf("\n");
  const kept = cut > MAX_TOOL_RESULT_CHARS * 0.6 ? head.slice(0, cut) : head;
  return `${kept}\n…（结果已截断，原始长度 ${text.length} 字符）`;
}

interface CallOutcome {
  text: string;
  toolCalls: ToolCall[];
  failure: string | null;
}

/** 一次模型调用：边收增量边 yield text_delta，结束时返回全文与工具调用。 */
async function* streamCall(
  model: ModelEntry,
  turns: Turn[],
  images: OptionImage[],
  tools: ToolSpec[],
  signal?: AbortSignal,
  systemExtra?: string,
): AsyncGenerator<ChatEvent, CallOutcome> {
  const chunks: string[] = [];
  let settled = false;
  let failure: string | null = null;
  let wake: (() => void) | null = null;
  let toolCalls: ToolCall[] = [];

  const running = callAgent(
    model,
    turns,
    images,
    signal,
    (chunk) => {
      chunks.push(chunk);
      wake?.();
    },
    tools.length ? { tools, toolChoice: "auto", ...(systemExtra ? { systemExtra } : {}) } : systemExtra ? { systemExtra } : {},
  )
    .then((result) => {
      toolCalls = result.toolCalls || [];
    })
    .catch((err) => {
      failure = String((err as Error)?.message || err);
    })
    .finally(() => {
      settled = true;
      wake?.();
    });

  let text = "";
  while (!settled || chunks.length) {
    if (!chunks.length) {
      await new Promise<void>((resolve) => {
        wake = () => {
          wake = null;
          resolve();
        };
      });
      continue;
    }
    const chunk = chunks.shift() as string;
    text += chunk;
    yield { type: "text_delta", text: chunk };
  }
  await running;
  return { text, toolCalls, failure };
}

/** MCP 工具循环：执行工具 → 结果回灌 → 再次调用模型，直到模型不再要工具。 */
async function* runWithTools(
  model: ModelEntry,
  turns: Turn[],
  images: OptionImage[],
  tools: McpToolInfo[],
  specs: ToolSpec[],
  signal?: AbortSignal,
  systemExtra?: string,
): AsyncGenerator<
  ChatEvent,
  { text: string; failure: string | null; handles: ToolHandle[]; clearedToolResults: number }
> {
  const serverOf = new Map(tools.map((tool) => [tool.name, tool.serverId]));
  const conversation: Turn[] = [...turns];
  const handles: ToolHandle[] = [];
  let text = "";
  let failure: string | null = null;
  let clearedToolResults = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const outcome = yield* streamCall(model, conversation, images, specs, signal, systemExtra);
    text += outcome.text;
    if (outcome.failure) {
      failure = outcome.failure;
      break;
    }
    if (!outcome.toolCalls.length) break;

    conversation.push({ role: "assistant", content: outcome.text, toolCalls: outcome.toolCalls });
    for (const call of outcome.toolCalls) {
      yield {
        type: "tool_call",
        id: call.id,
        name: call.name,
        server: serverOf.get(call.name),
        args: call.argsJson,
      };

      let content: string;
      let ok = true;
      if (toolNeedsConfirm(call.name)) {
        // 先登记等待器再下发确认事件：避免调用方在 waiter 注册前应答导致永久挂起（竞态）。
        const pendingConfirm = waitForConfirmation(call.id);
        yield { type: "confirmation_required", id: call.id, name: call.name, args: call.argsJson };
        const answer = await pendingConfirm;
        yield { type: "confirmation_response", id: call.id, confirmed: answer.confirmed };
        if (!answer.confirmed) {
          ok = false;
          content = answer.timedOut ? "等待确认超时，已取消该工具调用" : "用户已拒绝该工具调用";
          yield { type: "tool_result", id: call.id, name: call.name, ok, text: content };
          conversation.push({ role: "tool", toolCallId: call.id, name: call.name, content });
          handles.push({ name: call.name, args: truncateArgs(call.argsJson), summary: "未执行（未确认）" });
          continue;
        }
      }

      const result = await callMcpTool(call.name, parseToolArgs(call.argsJson));
      ok = !result.isError;
      content = truncateResult(result.text);
      yield { type: "tool_result", id: call.id, name: call.name, ok, text: content };
      conversation.push({ role: "tool", toolCallId: call.id, name: call.name, content });
      // 句柄记录的是「原文规模」而非回灌后正文，便于下一轮按需重取。
      handles.push({
        name: call.name,
        args: truncateArgs(call.argsJson),
        summary: ok ? handleSummary(result.text) : "执行失败",
      });
    }
    // 每轮结束治理一次：给下一轮模型调用留出预算。
    clearedToolResults += governToolResults(conversation);
  }

  return { text, failure, handles, clearedToolResults };
}

/**
 * 执行一轮对话，产出 ChatEvent 流（HTTP Streamable / NDJSON 契约）。
 * 上下文与设置全部取自该对话（thread）：`conversation.context` 是唯一真相。
 * 无 MCP 工具时走直连单次调用；有工具时走 MCP 工具循环。
 * signal 由调用方传入（app.ts 接客户端断连信号），用于中止在途模型调用。
 */
export async function* chatStream(
  conversationId: string,
  userText: string,
  opts: { model?: string; images?: string[] } = {},
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const conversation = await getConversation(conversationId);
  // 优先级：请求显式指定 > 对话设置 > 服务端默认。
  const model = getModel(opts.model) || getModel(conversation?.model) || defaultModel();
  if (!model) {
    yield {
      type: "error",
      error: { code: "MODEL_UNAVAILABLE", defaultMessage: "没有可用模型" },
      message: "没有可用模型",
    };
    yield { type: "done" };
    return;
  }
  yield { type: "model", id: model.id, label: model.label };

  const enabled = (conversation?.mcpServers || []).filter(Boolean);
  const tools = enabled.length ? await collectTools(enabled) : [];
  // 工具 schema 只序列化一次：既用于预算估算，也用于后续每轮的模型调用。
  const specs = tools.length ? toolSpecsOf(tools) : [];
  // 预算先算：窗口 − 输出预留 − 工具 schema − 本轮工具结果预算（工具定义也是纯开销）。
  const toolSchemaTokens = specs.length ? estimateTokens(JSON.stringify(specs)) : 0;
  const budget = historyBudgetTokens(model, toolSchemaTokens);
  const built = buildTurns(conversation?.context || [], userText, budget);
  const turns = built.turns;
  // 该对话指定的语言 → 一条通用回复语言指令（未指定则不注入）。
  const systemExtra = languageDirective(conversation?.locale) || undefined;
  // 模型不支持直读图片时不再加载图片（避免无用 base64），由前端给出明确提示。
  const images = opts.images?.length && model.vision === "direct" ? imagesOf(opts.images) : [];

  let text = "";
  let failure: string | null = null;
  let handles: ToolHandle[] = [];
  let clearedToolResults = 0;
  if (tools.length) {
    const outcome = yield* runWithTools(model, turns, images, tools, specs, signal, systemExtra);
    text = outcome.text;
    failure = outcome.failure;
    handles = outcome.handles;
    clearedToolResults = outcome.clearedToolResults;
  } else {
    const outcome = yield* streamCall(model, turns, images, [], signal, systemExtra);
    text = outcome.text;
    failure = outcome.failure;
  }

  const usage: ChatEvent = {
    type: "usage",
    tokens: built.tokens,
    budget,
    window: model.contextWindow,
    turns: Math.max(0, turns.length - 1),
    dropped: built.dropped,
    toolResultsCleared: clearedToolResults,
  };

  if (failure) {
    yield {
      type: "error",
      error: { code: "MODEL_ERROR", defaultMessage: failure },
      message: failure,
    };
    yield usage;
    yield { type: "done" };
    return;
  }

  const finalText = text.trim();
  // 上下文写回该对话（thread）：单文档原子追加（$push + $inc）。
  await appendContext(conversationId, [
    { role: "user", text: userText },
    handles.length ? { role: "assistant", text: finalText, handles } : { role: "assistant", text: finalText },
  ]);
  yield { type: "text", text: finalText };
  yield usage;
  yield { type: "done" };
}
