// 聊天引擎（自研 agent harness，路线 B 补齐 Deep Agents 能力）。
// 未勾选 MCP：一次模型调用 + 流式输出（直连语义，零工具）。
// 勾选 MCP：MCP 工具 + 内置工具（fs_* / write_todos / read_skill / task）注入模型，
//           按「模型出 tool_calls → 执行 → 结果回灌 → 再调用」循环，直到结论或轮次上限。
// 能力层：系统提示两段式（稳定前缀可缓存）· 工具结果超预算卸载到工作区 · 任务规划持久化 ·
//         子代理（task 工具：独立上下文 + 最小工具集 + 只回摘要）。
import type { ChatEvent, RiskLevel } from "@bx/shared";
import { config, defaultModel, getModel, listModels, type ModelEntry } from "./config.js";
import { BUILTIN_SERVER, builtinToolSpecs, execBuiltin, TOOL_SEARCH_NAME } from "./builtins.js";
import { requestConfirmation } from "./confirm.js";
import { appendAudit, argsDigestOf } from "./audit.js";
import { appendContext, getConversation, setConversationSummary } from "./conversations.js";
import { offloadToolResult } from "./fs-store.js";
import {
  callAgent,
  estimateTokens,
  estimateTokensOf,
  safeJsonParse,
  type OptionImage,
  type ToolCall,
  type ToolSpec,
  type Turn,
} from "./models.js";
import { callMcpTool, collectToolsDetailed, type McpToolInfo } from "./mcp/hub.js";
import { resolveToolRisk, verdictNeedsConfirm } from "./risk.js";
import type { ToolHandle } from "./session.js";
import { buildSystemPrompt, SUBAGENT_PROMPT, type SystemPrompt, type ToolingStatus } from "./system-prompt.js";
import { wrapUntrusted } from "./untrusted.js";
import { getUploadImage } from "./uploads.js";
import { assembleContext } from "./history.js";

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

// 循环护栏：同轮同参数去重 + 跨轮 Doom Loop 熔断（防止模型卡在无效工具循环空耗 token）。
const TOOL_DEDUP_SAME_ROUND = (process.env.MCP_DEDUP_SAME_ROUND || "on").toLowerCase() !== "off";
const DOOM_LOOP_MAX_ROUNDS = Math.max(2, Number(process.env.MCP_DOOM_LOOP_MAX || 3));
// 循环内层瞬时重试：某轮模型调用遇 SSE 断流 / 超时 / 限流等瞬态错误时重试，
// 不累加失败文本、对用户透明。4xx 等永久错误（401/402/400）不重试。
const MODEL_CALL_RETRIES = Math.max(0, Number(process.env.MODEL_CALL_RETRIES || 2));
// 成本护栏：单轮对话累计 prompt token 上限（0 = 关闭）。轮次上限之外的第二道成本闸门，
// 防止「每轮调不同工具、不触发 Doom Loop」时轮次未到但 token 已爆。
const MAX_TOTAL_TOKENS = Math.max(0, Number(process.env.MCP_MAX_TOTAL_TOKENS || 0));
// 失败熔断：同一工具连续失败达阈值后，本对话内不再实际执行（避免对已挂的上游反复空耗）。
const TOOL_FAILURE_LIMIT = Math.max(1, Number(process.env.MCP_TOOL_FAILURE_LIMIT || 3));

// 子代理护栏：轮次、回传摘要上限、并发数（对齐 Deep Agents「同步子代理」语义）。
const SUBAGENT_MAX_ROUNDS = Number(process.env.SUBAGENT_MAX_ROUNDS || 10);
const SUBAGENT_RESULT_CHARS = Number(process.env.SUBAGENT_RESULT_CHARS || 4000);
const SUBAGENT_MAX_PARALLEL = Number(process.env.SUBAGENT_MAX_PARALLEL || 3);

// 子代理运行注册表（Async subagents）：用于「独立取消某一个正在运行的子代理」，
// 而不影响主代理继续运行。key = 子代理运行 id（subagent_start 事件里的 id）。
interface SubagentHandle {
  id: string;
  conversationId: string;
  description: string;
  controller: AbortController;
  status: "running" | "done" | "cancelled" | "error";
}
const subagentRegistry = new Map<string, SubagentHandle>();
let subagentSeq = 0;
function nextSubagentId(conversationId: string): string {
  subagentSeq += 1;
  return `sa_${conversationId}_${subagentSeq}`;
}

/** 独立取消某一个运行中的子代理（不影响主代理）。返回是否命中了运行中实例。 */
export function cancelSubagent(conversationId: string, id: string): boolean {
  const handle = subagentRegistry.get(id);
  if (!handle || handle.conversationId !== conversationId || handle.status !== "running") return false;
  handle.status = "cancelled";
  handle.controller.abort();
  return true;
}

/** 主代理整体取消时，级联取消本会话下所有运行中的子代理。 */
export function cancelSubagentsOfConversation(conversationId: string): void {
  for (const handle of subagentRegistry.values()) {
    if (handle.conversationId === conversationId && handle.status === "running") {
      handle.status = "cancelled";
      handle.controller.abort();
    }
  }
}

// 工具按需加载（对齐 Claude Code 的 ToolSearch：工具定义占用超过窗口一定比例时改为「按需检索加载」）。
const TOOL_SEARCH_MODE = (process.env.TOOL_SEARCH_MODE || "auto").toLowerCase(); // auto | on | off
const TOOL_SEARCH_RATIO = Number(process.env.TOOL_SEARCH_RATIO || 0.1);
const TOOL_SEARCH_RESULTS = Number(process.env.TOOL_SEARCH_RESULTS || 8);
const TOOL_SEARCH_MAX_RESULTS = 20;

/** 历史预算 = (窗口 − 输出预留 − 工具 schema − 本轮工具结果预算) × 安全系数。 */
function historyBudgetTokens(model: ModelEntry, toolSchemaTokens: number): number {
  const reserved = config.maxOutputTokens + toolSchemaTokens + TOOL_RESULT_BUDGET;
  return Math.max(1000, Math.floor((model.contextWindow - reserved) * CONTEXT_SAFETY_RATIO));
}

/** 摘要生成：用同一个模型做一次无工具的普通调用。 */
async function summarizeWith(model: ModelEntry, prompt: string, signal?: AbortSignal): Promise<string> {
  const result = await callAgent(model, [{ role: "user", content: prompt }], [], signal);
  return result.text;
}

function truncateArgs(raw: string): string {
  const text = (raw || "").trim();
  return text.length > HANDLE_ARGS_CHARS ? `${text.slice(0, HANDLE_ARGS_CHARS)}…` : text;
}

/** 判定模型调用错误是否瞬态（可重试）：限流/5xx/超时/中断/网络抖动。4xx 等永久错误返回 false。 */
function isTransientModelError(msg: string | null): boolean {
  if (!msg) return false;
  return /(?:429|503|5\d\d|timeout|timed?\s*out|abort|rate\s*limit|freeusagelimit|econn|fetch failed|network|socket|模型服务暂时不可用|gateway)/i.test(
    msg,
  );
}

/** 伪工具调用被拦截后的纠正提示（回灌给模型，要求走函数调用通道）。 */
const PSEUDO_CALL_HINT =
  "上一条回复把工具调用写成了正文文本（而不是通过函数调用通道发起），该文本已作废。\n" +
  "请通过函数调用（tool_calls）发起工具调用；不要在回复正文里书写调用语句（JSON / XML / 方括号等）。";

/**
 * 运行时答案校验（协议级）：识别「把工具调用写成正文文本」的伪调用。
 * 判据是「调用形态 + 已知工具名」双重命中，不涉及任何业务词：
 * XML 标签、行首方括号、或 JSON 中 name 字段命中真实工具名。
 */
export function looksLikePseudoToolCall(text: string, toolNames: ReadonlySet<string>): boolean {
  if (!text || !toolNames.size) return false;
  for (const name of toolNames) {
    if (!name) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`</?${esc}(?:\\s|/?>)`, "i").test(text)) return true; // <tool_name> / </tool_name> / <tool_name/>
    if (new RegExp(`(?:^|\\n)\\s*\\[${esc}\\](?!\\()`, "i").test(text)) return true; // 行首 [tool_name]（排除 markdown 链接）
    if (new RegExp(`"(?:name|tool|tool_name)"\\s*:\\s*"${esc}"`, "i").test(text)) return true; // {"name"/"tool":"tool_name",...}
  }
  return false;
}

/** 结果规模摘要（供跨轮句柄使用，不含正文）。 */
function handleSummary(content: string): string {
  const lines = content ? content.split("\n").length : 0;
  return `${lines} 行 / ${content.length} 字符`;
}

// 确认卡参数摘要（P0-6）：键名命中敏感词的值脱敏，值截断。
const SENSITIVE_KEY_RE = /token|secret|password|key|authorization|cookie/i;
const ARG_SUMMARY_MAX_ITEMS = 8;
const ARG_SUMMARY_VALUE_CHARS = 200;

/** 关键参数摘要：取入参顶层键，值 JSON 化后截断；敏感键只显示占位符（凭据不外泄）。 */
export function summarizeArgsForConfirm(argsJson: string): Array<{ key: string; value: string }> {
  const args = safeJsonParse(argsJson);
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  return Object.entries(args as Record<string, unknown>)
    .slice(0, ARG_SUMMARY_MAX_ITEMS)
    .map(([key, value]) => {
      let text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
      if (text.length > ARG_SUMMARY_VALUE_CHARS) text = `${text.slice(0, ARG_SUMMARY_VALUE_CHARS)}…`;
      if (SENSITIVE_KEY_RE.test(key)) text = "•••";
      return { key, value: text };
    });
}

/**
 * MCP 工具 → 模型 schema。顺序由 hub 保证确定性（serverId、工具名双排序）：
 * 工具清单是注入模型的 system 前缀的一部分，顺序稳定才谈得上 prompt 缓存命中。
 * 超出 MCP_MAX_TOOLS 时按顺序截断，并把「被裁掉的服务器」回报给调用方 —— 不静默丢弃。
 */
export function selectMcpToolSpecs(tools: McpToolInfo[]): { specs: ToolSpec[]; droppedServers: string[] } {
  const specs: ToolSpec[] = [];
  const dropped = new Set<string>();
  for (const tool of tools) {
    if (specs.length >= MCP_MAX_TOOLS) {
      dropped.add(tool.serverId);
      continue;
    }
    specs.push({ name: tool.name, description: tool.description, parameters: tool.inputSchema });
  }
  return { specs, droppedServers: [...dropped].sort() };
}

/** 工具索引（仅名称）：按需加载模式下注入系统提示，让模型知道「有哪些工具可以检索」。 */
function catalogOf(
  tools: McpToolInfo[],
  labels: Map<string, string>,
): Array<{ id: string; label: string; tools: string[] }> {
  const byId = new Map<string, { id: string; label: string; tools: string[] }>();
  for (const tool of tools) {
    const entry = byId.get(tool.serverId) || {
      id: tool.serverId,
      label: labels.get(tool.serverId) || tool.serverId,
      tools: [],
    };
    entry.tools.push(tool.tool);
    byId.set(tool.serverId, entry);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 是否改用「按需检索加载」：off = 永远全量注入；on = 强制；auto（默认）= 工具定义超过窗口的
 * TOOL_SEARCH_RATIO（默认 10%，对齐 Claude Code `ENABLE_TOOL_SEARCH=auto` 的口径）时改成按需。
 */
export function toolSearchEnabled(model: ModelEntry, eagerToolTokens: number): boolean {
  if (TOOL_SEARCH_MODE === "off") return false;
  if (TOOL_SEARCH_MODE === "on") return true;
  return eagerToolTokens > model.contextWindow * TOOL_SEARCH_RATIO;
}

/** 通用关键词切分：按非字母数字/非中日韩字符切分（不含任何业务词）。 */
function keywordsOf(query: string): string[] {
  return String(query || "")
    .toLowerCase()
    .split(/[^0-9a-z\u4e00-\u9fa5]+/i)
    .map((term) => term.trim())
    .filter(Boolean);
}

export interface ToolMatch {
  tool: McpToolInfo;
  score: number;
}

/**
 * 工具检索（本地关键词匹配，确定性排序）：
 * 命中工具名（含原始名）权重最高，其次描述，最后服务器标识；多关键词时未命中的词扣分。
 */
export function searchMcpTools(tools: McpToolInfo[], query: string, limit?: number): ToolMatch[] {
  const terms = keywordsOf(query);
  if (!terms.length) return [];
  const matched: ToolMatch[] = [];
  for (const tool of tools) {
    const name = tool.name.toLowerCase();
    const bare = tool.tool.toLowerCase();
    const description = (tool.description || "").toLowerCase();
    const server = tool.serverId.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (bare === term || name.endsWith(`__${term}`)) score += 100;
      else if (name.includes(term)) score += 60;
      else if (description.includes(term)) score += 20;
      else if (server.includes(term)) score += 10;
      else score -= 5;
    }
    if (score > 0) matched.push({ tool, score });
  }
  const capped = Math.max(
    1,
    Math.min(TOOL_SEARCH_MAX_RESULTS, Math.floor(Number(limit)) || TOOL_SEARCH_RESULTS),
  );
  return matched.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name)).slice(0, capped);
}

/** 判断某条工具结果是否已被治理过（占位/卸载），避免重复处理。 */
function isGovernedPlaceholder(content: string): boolean {
  return content === TOOL_RESULT_CLEARED || content.startsWith("…（该工具结果已卸载");
}

/**
 * 本轮工具结果治理：超出预算时从最旧的开始处理，但永远保留最近 TOOL_RESULT_KEEP 组、
 * 且不处理白名单工具。处理方式（Deep Agents 的 offloading 思路）：
 * 大结果先**卸载到工作区文件**（保留 fs_read 指针，可取回），落盘失败才退化为纯占位符。
 */
export function governToolResults(
  conversation: Turn[],
  conversationId: string,
): { cleared: number; offloaded: number } {
  const toolTurns = conversation.filter((turn) => turn.role === "tool");
  if (!toolTurns.length) return { cleared: 0, offloaded: 0 };
  let total = estimateTokensOf(toolTurns.map((turn) => turn.content));
  const older = toolTurns.filter(
    (turn, index) =>
      index < toolTurns.length - TOOL_RESULT_KEEP &&
      !TOOL_RESULT_PROTECTED.has(turn.name || "") &&
      !isGovernedPlaceholder(turn.content),
  );
  let cleared = 0;
  let offloaded = 0;
  for (const turn of older) {
    if (total <= TOOL_RESULT_BUDGET) break;
    total -= estimateTokens(turn.content);
    const saved = offloadToolResult(conversationId, turn.toolCallId || "unknown", turn.name || "tool", turn.content);
    turn.content =
      "error" in saved
        ? TOOL_RESULT_CLEARED
        : `…（该工具结果已卸载到工作区文件 ${saved.path}，${saved.bytes} 字节；需要时用 fs_read 读取，或重新调用工具）`;
    if ("error" in saved) cleared += 1;
    else offloaded += 1;
  }
  return { cleared, offloaded };
}

function imagesOf(ids: string[] | undefined): OptionImage[] {
  const out: OptionImage[] = [];
  for (const id of ids || []) {
    const img = getUploadImage(id);
    if (img) out.push({ base64: img.data.toString("base64"), mediaType: img.mediaType });
  }
  return out;
}

/** 截断工具结果；尽量切在行边界，避免把 TSV / JSON 的某一行从中间劈开。 */
function truncateResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const head = text.slice(0, MAX_TOOL_RESULT_CHARS);
  const cut = head.lastIndexOf("\n");
  const kept = cut > MAX_TOOL_RESULT_CHARS * 0.6 ? head.slice(0, cut) : head;
  return `${kept}\n…（结果已截断，原始长度 ${text.length} 字符）`;
}

/** 递归按 key 排序对象，产出确定性 JSON（同语义不同 key 顺序的参数视为同一调用）。 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * 工具调用签名（name + 规范化参数）：同轮去重与跨轮 Doom Loop 检测都基于它。
 * 参数按 key 排序后序列化，保证「语义相同但 key 顺序不同」不误判为不同调用。
 */
export function toolCallSignature(name: string, argsJson: string): string {
  let canonical = argsJson || "{}";
  try {
    canonical = JSON.stringify(sortKeys(JSON.parse(argsJson || "{}")));
  } catch {
    /* 非法 JSON 退化为原文比较 */
  }
  return `${name}::${canonical}`;
}

/**
 * 跨轮 Doom Loop 熔断：记录每轮「实际执行的调用指纹」（去重后的签名集合）。
 * 同一指纹**连续**重复达到阈值即判定陷入无效循环（如每次都执行同一组工具却拿不到进展），
 * 返回 true 让上层主动收束，避免无限循环空耗 token。空轮（无执行）不计入连击。
 */
export class LoopGuard {
  private lastFp = "";
  private streak = 0;
  constructor(private readonly maxRepeats: number) {}
  record(roundExecuted: string[]): boolean {
    if (roundExecuted.length === 0) {
      this.lastFp = "";
      this.streak = 0;
      return false;
    }
    const fp = JSON.stringify([...new Set(roundExecuted)].sort());
    if (fp === this.lastFp) this.streak += 1;
    else {
      this.lastFp = fp;
      this.streak = 1;
    }
    return this.streak >= this.maxRepeats;
  }
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
  system?: SystemPrompt,
): AsyncGenerator<ChatEvent, CallOutcome> {
  const chunks: string[] = [];
  let settled = false;
  let failure: string | null = null;
  let wake: (() => void) | null = null;
  let toolCalls: ToolCall[] = [];
  // 是否收到过增量回调：用于区分「流式通道（增量已逐片推进 chunks）」与
  // 「非流式通道（ollama / 不支持 SSE 的网关，onDelta 永不触发）」。
  let streamed = false;

  const running = callAgent(
    model,
    turns,
    images,
    signal,
    (chunk) => {
      chunks.push(chunk);
      streamed = true;
      wake?.();
    },
    tools.length
      ? { tools, toolChoice: "auto", systemParts: system }
      : { systemParts: system },
  )
    .then((result) => {
      toolCalls = result.toolCalls || [];
      // 非流式通道（如 ollama、不支持 SSE 的网关）没有增量回调，整包文本在这里补齐，
      // 否则模型明明有输出，最终却拼出空回复。注意：判据用 streamed 而非 chunks.length——
      // 流式通道的 chunks 在消费循环里会被即时 shift 清空，若按 chunks.length 判断会在
      // 流式结束后误把整段最终文本再压入一次，导致最终回复翻倍。
      if (result.text && !streamed) chunks.push(result.text);
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

/** 工具循环的运行上下文：主代理与子代理共用同一个循环，差别在工具集 / 系统提示 / 轮次上限。 */
interface LoopContext {
  conversationId: string;
  model: ModelEntry;
  images: OptionImage[];
  /** MCP 工具（执行用）。 */
  mcpTools: McpToolInfo[];
  /** 初始工具 schema（内置 + 已加载的 MCP）；按需加载模式下会在循环内增长。 */
  specs: ToolSpec[];
  /** 按需加载模式：MCP 工具 schema 未全量注入，需经检索工具加载后才可调用。 */
  toolSearch: boolean;
  /** 已加载的 MCP 工具名（按需加载模式下的可调用集合）；子代理各自独立一份。 */
  loadedTools: Set<string>;
  system: SystemPrompt;
  signal?: AbortSignal;
  /** 主代理 = true（可用 task 委派）；子代理 = false（防递归）。 */
  allowTask: boolean;
  /** 主代理 = true；子代理 = false（默认只读：非只读操作立即拒绝，不进入确认流程）。 */
  allowWrite: boolean;
  /** 会话级只读授权（conversation.readGrants）：仅对「未声明级别」的同服务器工具降级为只读。 */
  grantServers: ReadonlySet<string>;
  /** 发起请求的会话 id：确认票据与它绑定（跨会话应答会被拒绝）。 */
  sessionId?: string;
  /** 发起请求的设备 owner：用于按用户隔离的本地状态（如观影画像），不暴露给模型。 */
  ownerKey?: string;
  maxRounds: number;
  /** 知识库命名空间（按角色隔离）：默认 "generic"，由当前会话角色决定。 */
  namespace: string;
}

interface LoopOutcome {
  text: string;
  failure: string | null;
  handles: ToolHandle[];
  clearedToolResults: number;
  offloadedToolResults: number;
  /** 执行的工具调用次数（子代理回传规模摘要用）。 */
  toolCallCount: number;
  /** 工具循环实际使用的轮次（模型调用次数）。 */
  rounds: number;
  /** 模型调用瞬时失败重试次数。 */
  modelRetries: number;
  /** 因连续失败被熔断跳过的工具调用次数。 */
  toolFusions: number;
  /** 伪工具调用被拦截纠正的次数。 */
  pseudoCallRetries: number;
  /** 累计发送的 prompt token 估算（成本护栏开启时统计）。 */
  spentTokens: number;
}

/** 工具循环：模型 → tool_calls → 执行（内置 / MCP / 委派）→ 回灌 → 再调用，直到结论或轮次上限。 */
async function* runLoop(ctx: LoopContext, turns: Turn[]): AsyncGenerator<ChatEvent, LoopOutcome> {
  const serverOf = new Map<string, string>(ctx.mcpTools.map((tool) => [tool.name, tool.serverId]));
  for (const item of builtinToolSpecs({ toolSearch: ctx.toolSearch })) serverOf.set(item.name, BUILTIN_SERVER);
  // 按需加载模式下 specs 会随检索增长，用局部变量（ctx.specs 只作初始值）。
  let specs = ctx.specs;
  const specOfTool = new Map<string, ToolSpec>(
    ctx.mcpTools.map((tool) => [
      tool.name,
      { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    ]),
  );
  const conversation: Turn[] = [...turns];
  const handles: ToolHandle[] = [];
  let text = "";
  let failure: string | null = null;
  let clearedToolResults = 0;
  let offloadedToolResults = 0;
  let toolCallCount = 0;
  // 循环护栏：同轮去重集合（每轮重置）+ 跨轮 Doom Loop 检测器。
  const executedSigs = new Set<string>();
  let roundExecuted: string[] = [];
  const guard = new LoopGuard(DOOM_LOOP_MAX_ROUNDS);
  // 成本护栏：累计本轮已发送的 prompt token 估算；失败熔断：各工具连续失败计数。
  let spentTokens = 0;
  const failedTools = new Map<string, number>();
  // 运行时统计（回填 usage 事件）：轮次 / 重试 / 熔断 / 伪调用纠正。
  let rounds = 0;
  let modelRetries = 0;
  let toolFusions = 0;
  let pseudoCallRetries = 0;
  let pseudoCallRetried = false;

  for (let round = 0; round < ctx.maxRounds; round++) {
    // 成本护栏：轮次上限之外的第二道闸门。累计每轮实际发送的 prompt（历史 + 工具 schema）
    // 估算，超过预算即停止继续调用（已生成内容仍会正常返回）。
    if (MAX_TOTAL_TOKENS > 0) {
      spentTokens +=
        estimateTokensOf(conversation.map((turn) => turn.content)) +
        (specs.length ? estimateTokens(JSON.stringify(specs)) : 0);
      if (spentTokens > MAX_TOTAL_TOKENS) {
        text +=
          `\n\n（本轮已累计约 ${spentTokens} token，达到预算上限 ${MAX_TOTAL_TOKENS}，` +
          "已停止继续调用以避免超额消耗；如需继续，请收窄问题范围或新开对话。）";
        break;
      }
    }
    let outcome: CallOutcome;
    let callAttempt = 0;
    // 该轮模型调用瞬时失败重试：SSE 中途断流 / 超时 / 限流等瞬态错误应重试，
    // 4xx 等永久错误不重试。重试对用户透明（不累加失败文本，成功后才计入 text）。
    while (true) {
      outcome = yield* streamCall(ctx.model, conversation, ctx.images, specs, ctx.signal, ctx.system);
      if (!outcome.failure) break;
      if (callAttempt < MODEL_CALL_RETRIES && isTransientModelError(outcome.failure)) {
        callAttempt += 1;
        modelRetries += 1;
        console.log(`[chat:retry] 模型调用瞬时失败，重试 ${callAttempt}/${MODEL_CALL_RETRIES}：${outcome.failure}`);
        continue;
      }
      break;
    }
    text += outcome.text;
    rounds = round + 1;
    if (outcome.failure) {
      failure = outcome.failure;
      break;
    }
    if (!outcome.toolCalls.length) {
      // 运行时校验：模型把工具调用写成正文文本（伪调用）→ 不当作终态，
      // 作废该段文本并回灌纠正提示继续下一轮（只纠正一次，避免陷入循环）。
      if (!pseudoCallRetried && looksLikePseudoToolCall(outcome.text, new Set(specs.map((s) => s.name)))) {
        pseudoCallRetried = true;
        pseudoCallRetries += 1;
        text = text.slice(0, Math.max(0, text.length - outcome.text.length));
        conversation.push({ role: "assistant", content: outcome.text });
        conversation.push({ role: "user", content: PSEUDO_CALL_HINT });
        console.log("[chat:pseudo-call] 检出文本形式的工具调用，已作废并回灌纠正提示");
        continue;
      }
      break;
    }

    // 每轮重置同轮去重集合（跨轮允许重新执行，避免误杀「重新取数」等合法重复）。
    executedSigs.clear();
    roundExecuted = [];

    conversation.push({ role: "assistant", content: outcome.text, toolCalls: outcome.toolCalls });

    // 逐个处理；**连续的** task 委派合并成一批并行执行（对齐 Deep Agents：单轮多个 task 并行）。
    const calls = outcome.toolCalls;
    let index = 0;
    while (index < calls.length) {
      const call = calls[index]!;
      // 同轮去重：本轮已执行过的相同调用（name + 规范化参数）不再重复执行，仍回灌结果保持模型上下文对齐。
      const sig = toolCallSignature(call.name, call.argsJson);
      if (TOOL_DEDUP_SAME_ROUND && executedSigs.has(sig)) {
        index += 1;
        yield { type: "tool_call", id: call.id, name: call.name, server: serverOf.get(call.name), args: call.argsJson };
        yield {
          type: "tool_result",
          id: call.id,
          name: call.name,
          ok: false,
          text: `跳过：本轮已执行过相同调用（${call.name} + 相同参数），不重复执行。`,
        };
        conversation.push({ role: "tool", toolCallId: call.id, name: call.name, content: "（重复调用已跳过）" });
        handles.push({ name: call.name, args: truncateArgs(call.argsJson), summary: "已跳过（同轮重复）" });
        continue;
      }
      if (call.name === "task" && ctx.allowTask) {
        const batch: ToolCall[] = [];
        while (index < calls.length && calls[index]!.name === "task") {
          const t = calls[index]!;
          const tsig = toolCallSignature(t.name, t.argsJson);
          if (TOOL_DEDUP_SAME_ROUND && executedSigs.has(tsig)) {
            // 重复子任务：单独回灌跳过结果，不进并行批量。
            yield { type: "tool_call", id: t.id, name: "task", server: BUILTIN_SERVER, args: t.argsJson };
            yield { type: "tool_result", id: t.id, name: "task", ok: false, text: "跳过：本轮已委派过相同子任务。" };
            conversation.push({ role: "tool", toolCallId: t.id, name: "task", content: "（重复子任务已跳过）" });
            handles.push({ name: "task", args: truncateArgs(t.argsJson), summary: "已跳过（同轮重复）" });
            index += 1;
            continue;
          }
          batch.push(t);
          executedSigs.add(tsig);
          index += 1;
        }
        if (!batch.length) continue;
        toolCallCount += batch.length;
        for (const item of batch) {
          yield { type: "tool_call", id: item.id, name: "task", server: BUILTIN_SERVER, args: item.argsJson };
        }
        const results: SubagentResult[] = new Array(batch.length);
        const batchGen = runSubagentBatch(batch, ctx, results);
        // 逐片转发子代理的 subagent_start / subagent_delta / subagent_end 独立事件。
        for await (const ev of batchGen) yield ev;
        for (const result of results) {
          yield { type: "tool_result", id: result.id, name: "task", ok: result.ok, text: result.text };
          // 子代理回传同样是不可信数据（它自己读的也都是外部内容）：定界后回灌。
          const wrappedTask = wrapUntrusted(result.text, { kind: "subagent_summary", source: "task" });
          conversation.push({ role: "tool", toolCallId: result.id, name: "task", content: wrappedTask.text });
          roundExecuted.push(toolCallSignature("task", result.args));
          handles.push({
            name: "task",
            args: truncateArgs(result.args),
            summary: result.ok ? `子代理 · ${result.toolCalls} 次工具调用` : "子代理执行失败",
          });
        }
        continue;
      }
      // 工具检索（按需加载模式）：把命中的 MCP 工具 schema 加载进来，后续轮次即可直接调用。
      if (ctx.toolSearch && call.name === TOOL_SEARCH_NAME) {
        index += 1;
        toolCallCount += 1;
        executedSigs.add(sig);
        roundExecuted.push(sig);
        yield { type: "tool_call", id: call.id, name: call.name, server: BUILTIN_SERVER, args: call.argsJson };
        const args = safeJsonParse(call.argsJson);
        const query = String(args.query || "").trim();
        const matches = query ? searchMcpTools(ctx.mcpTools, query, Number(args.limit)) : [];
        let ok = matches.length > 0;
        let rawText: string;
        if (!query) {
          const servers = [...new Set(ctx.mcpTools.map((tool) => tool.serverId))].sort();
          rawText =
            `请提供检索关键词（工具名 / 能力描述 / 服务器名）。当前可用 ${ctx.mcpTools.length} 个工具，` +
            `来自：${servers.join("、") || "（无）"}。`;
        } else if (!matches.length) {
          rawText = `没有匹配「${query}」的工具。换个关键词再试，或参考系统提示里的工具索引（服务器 + 工具名）。`;
        } else {
          const loaded: string[] = [];
          const capped: string[] = [];
          for (const match of matches) {
            if (ctx.loadedTools.has(match.tool.name)) continue;
            const spec = specOfTool.get(match.tool.name);
            if (!spec || specs.length >= MCP_MAX_TOOLS) {
              capped.push(match.tool.name);
              continue;
            }
            specs = [...specs, spec];
            ctx.loadedTools.add(match.tool.name);
            loaded.push(match.tool.name);
          }
          rawText = [
            `命中 ${matches.length} 个工具（本次新加载 ${loaded.length} 个，现在可直接调用）：`,
            ...matches.map((match) => `- ${match.tool.name}：${match.tool.description}`),
            capped.length ? `注意：已达单次工具数上限 ${MCP_MAX_TOOLS}，以下命中未加载：${capped.join("、")}。` : "",
          ]
            .filter(Boolean)
            .join("\n");
        }
        const searched = truncateResult(rawText);
        yield { type: "tool_result", id: call.id, name: call.name, ok, text: searched };
        conversation.push({ role: "tool", toolCallId: call.id, name: call.name, content: searched });
        handles.push({
          name: call.name,
          args: truncateArgs(call.argsJson),
          summary: ok ? `${matches.length} 个命中` : "无命中",
        });
        continue;
      }
      // 失败熔断：某工具连续失败达上限后，本对话内不再实际执行（避免对已挂的上游反复空耗）。
      const failCount = failedTools.get(call.name) || 0;
      if (failCount >= TOOL_FAILURE_LIMIT) {
        index += 1;
        toolFusions += 1;
        const fused =
          `工具 ${call.name} 已连续失败 ${failCount} 次，本对话内暂时跳过；` +
          "请改用其他工具，或换一种方式完成任务。";
        yield { type: "tool_call", id: call.id, name: call.name, server: serverOf.get(call.name), args: call.argsJson };
        yield { type: "tool_result", id: call.id, name: call.name, ok: false, text: fused };
        conversation.push({ role: "tool", toolCallId: call.id, name: call.name, content: fused });
        handles.push({
          name: call.name,
          args: truncateArgs(call.argsJson),
          summary: `已熔断（连续失败 ${failCount} 次）`,
        });
        continue;
      }
      index += 1;
      toolCallCount += 1;
      yield {
        type: "tool_call",
        id: call.id,
        name: call.name,
        server: serverOf.get(call.name),
        args: call.argsJson,
      };

      let content: string;
      let rawText: string;
      let ok = true;
      // ── 写操作安全闸门（src/risk.ts 单一真相）─────────────────────────────
      const verdict = resolveToolRisk(call.name, ctx.grantServers);
      const auditBase = {
        conversationId: ctx.conversationId,
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        tool: call.name,
        ...(verdict.serverId ? { server: verdict.serverId } : {}),
        level: verdict.level,
        unknown: verdict.unknown,
        reason: verdict.reason,
        argsDigest: argsDigestOf(call.argsJson),
      };
      // 子代理默认只读（P0-5）：非只读操作立即拒绝——不登记等待器、不发确认事件（否则确认事件
      // 被子代理消费循环丢弃，调用会静默挂到超时），模型拿到明确错误可自行调整。
      if (!ctx.allowWrite && verdict.level !== "read") {
        ok = false;
        rawText = `该操作（${verdict.level}）不能委派给子代理执行：请在主对话里直接发起，届时会弹出确认卡。`;
        yield { type: "tool_result", id: call.id, name: call.name, ok, text: rawText };
        conversation.push({ role: "tool", toolCallId: call.id, name: call.name, content: rawText });
        handles.push({ name: call.name, args: truncateArgs(call.argsJson), summary: "未执行（子代理禁止写操作）" });
        appendAudit({ kind: "gate", decision: "subagent_refused", ...auditBase });
        continue;
      }
      // 未声明工具按 MCP_UNKNOWN_TOOLS=deny 的口径直接拒绝。
      if (verdict.deny) {
        ok = false;
        rawText = `工具 ${call.name} 未声明操作级别，按当前安全口径拒绝执行；如确需使用，请在服务器配置中显式声明该工具的风险级别。`;
        yield { type: "tool_result", id: call.id, name: call.name, ok, text: rawText };
        conversation.push({ role: "tool", toolCallId: call.id, name: call.name, content: rawText });
        handles.push({ name: call.name, args: truncateArgs(call.argsJson), summary: "未执行（未知工具被拒绝）" });
        appendAudit({ kind: "gate", decision: "denied", ...auditBase });
        continue;
      }
      if (verdictNeedsConfirm(verdict)) {
        // 先登记等待器（拿到票据）再下发确认事件：避免调用方在 waiter 注册前应答导致永久挂起（竞态）。
        const pending = requestConfirmation({
          sessionId: ctx.sessionId || "",
          conversationId: ctx.conversationId,
          callId: call.id,
          tool: call.name,
          ...(verdict.serverId ? { serverId: verdict.serverId } : {}),
        });
        const argSummary = summarizeArgsForConfirm(call.argsJson);
        // 只读授权勾选：仅「未声明级别」的外部服务器工具可提供（写/破坏性永不适用）。
        const canGrantRead = Boolean(verdict.unknown && verdict.serverId && ctx.allowWrite);
        yield {
          type: "confirmation_required",
          id: call.id,
          ticket: pending.ticket,
          name: call.name,
          ...(verdict.serverId ? { server: verdict.serverId } : {}),
          args: call.argsJson,
          level: verdict.level as RiskLevel,
          reason: verdict.reason,
          ...(argSummary.length ? { argSummary } : {}),
          ...(canGrantRead ? { canGrantRead: true } : {}),
          expiresInMs: pending.timeoutMs,
        };
        const answer = await pending.wait;
        appendAudit({
          kind: "gate",
          decision: answer.confirmed ? "confirmed" : answer.timedOut ? "timeout" : "denied",
          ...auditBase,
          ticket: pending.ticket,
          ...(argSummary.length ? { argsSummary: argSummary } : {}),
        });
        yield { type: "confirmation_response", id: call.id, confirmed: answer.confirmed };
        if (!answer.confirmed) {
          ok = false;
          rawText = answer.timedOut ? "等待确认超时，已取消该工具调用" : "用户已拒绝该工具调用";
          yield { type: "tool_result", id: call.id, name: call.name, ok, text: rawText };
          conversation.push({ role: "tool", toolCallId: call.id, name: call.name, content: rawText });
          handles.push({ name: call.name, args: truncateArgs(call.argsJson), summary: "未执行（未确认）" });
          continue;
        }
      } else if (verdict.external) {
        // 只读放行也留痕（仅外部工具；工作区工具不记，避免噪音）。
        appendAudit({ kind: "gate", decision: "allowed", ...auditBase });
      }

      // 内置工具优先（fs_* / write_todos / read_skill）；其余走 MCP 通道。
      executedSigs.add(sig);
      roundExecuted.push(sig);
      const builtin = await execBuiltin(call.name, call.argsJson, ctx.conversationId, ctx.namespace, ctx.ownerKey);
      // executed=false 表示并未真正执行（如按需加载模式下未检索的工具）——不计入失败熔断。
      let executed = true;
      if (builtin) {
        ok = builtin.ok;
        rawText = builtin.text;
        // 任务规划即时可见（事件流），同时已持久化到 conversation.todos。
        if (builtin.todos) yield { type: "todos", todos: builtin.todos };
      } else if (ctx.toolSearch && specOfTool.has(call.name) && !ctx.loadedTools.has(call.name)) {
        // 按需加载模式：没检索加载过的工具不给调用（模型是照着索引里的名字猜的，参数说明它没见过）。
        ok = false;
        executed = false;
        rawText = `工具 ${call.name} 尚未加载：请先调用 ${TOOL_SEARCH_NAME} 检索它（关键词可用工具名），加载后再调用。`;
      } else {
        const result = await callMcpTool(call.name, safeJsonParse(call.argsJson), ctx.signal);
        ok = !result.isError;
        rawText = result.text;
      }
      // 失败计数（供失败熔断）：真正执行且成功 → 清零；真正执行但失败 → 累计。
      if (executed) {
        if (ok) failedTools.delete(call.name);
        else failedTools.set(call.name, (failedTools.get(call.name) || 0) + 1);
      }
      content = truncateResult(rawText);
      yield { type: "tool_result", id: call.id, name: call.name, ok, text: content };
      // 注入防护：外部内容回灌模型前包成带 nonce 与来源的不可信数据块（指令与数据分离）。
      // 展示给用户的事件流仍是原文（UI 不受影响），只有模型看到的上下文被定界。
      const wrapped = wrapUntrusted(content, {
        kind: "tool_result",
        source: serverOf.get(call.name) || call.name,
      });
      if (wrapped.collisions || wrapped.stripped) {
        console.log(
          `[chat:guard] 工具 ${call.name} 返回内容已加固：中和伪造定界 ${wrapped.collisions} 处、剥离不可见控制符 ${wrapped.stripped} 个`,
        );
      }
      conversation.push({ role: "tool", toolCallId: call.id, name: call.name, content: wrapped.text });
      // 句柄记录的是「原文规模」而非回灌后正文，便于下一轮按需重取。
      handles.push({
        name: call.name,
        args: truncateArgs(call.argsJson),
        summary: ok ? handleSummary(rawText) : "执行失败",
      });
    }
    // 每轮结束治理一次：给下一轮模型调用留出预算（超预算的大结果卸载到工作区）。
    const governed = governToolResults(conversation, ctx.conversationId);
    clearedToolResults += governed.cleared;
    offloadedToolResults += governed.offloaded;
    // 跨轮 Doom Loop 熔断：同一组工具调用连续重复达阈值 → 主动收束，避免无效循环空耗 token。
    if (guard.record(roundExecuted)) {
      text +=
        "\n\n（检测到工具调用陷入重复循环，已主动停止以避免无效消耗；如需继续，请调整问题、换用更具体的检索词，" +
        "或收窄勾选的服务器范围后再试。）";
      break;
    }
  }

  return {
    text,
    failure,
    handles,
    clearedToolResults,
    offloadedToolResults,
    toolCallCount,
    rounds,
    modelRetries,
    toolFusions,
    pseudoCallRetries,
    spentTokens,
  };
}

interface SubagentResult {
  id: string;
  args: string;
  ok: boolean;
  text: string;
  toolCalls: number;
}

/**
 * 解析子代理的服务器白名单（纯函数，便于测试）：
 * 空数组 = 不做限定（继承主代理全部工具）；给了 id 但没有匹配到任何工具 → 返回 error 让模型纠正。
 */
export function resolveSubagentTools(
  tools: McpToolInfo[],
  requested: string[],
): { tools: McpToolInfo[]; error?: string } {
  const wanted = [...new Set(requested.map((id) => String(id || "").trim()).filter(Boolean))].sort();
  if (!wanted.length) return { tools };
  const allowed = new Set(wanted);
  const filtered = tools.filter((tool) => allowed.has(tool.serverId));
  if (!filtered.length) {
    const known = [...new Set(tools.map((tool) => tool.serverId))].sort();
    return {
      tools: [],
      error: `task 的 servers 没有可用工具：${wanted.join("、")}。当前可用服务器：${known.join("、") || "（无）"}`,
    };
  }
  return { tools: filtered };
}

/**
 * 子代理（Deep Agents 的 task 工具，通用型）：独立上下文（只看任务描述）+
 * 最小工具集（剔除 task / write_todos 防递归；可选按 servers 收窄到指定服务器）+
 * 只回摘要（单一交接）。取消级联：沿用主代理的 abort signal。
 */
/**
 * 子代理（Deep Agents 的 task 工具，通用型，Async subagents）：
 * 独立上下文（只看任务描述）+ 最小工具集（剔除 task / write_todos 防递归；可选按 servers 收窄）+
 * 只回摘要（单一交接）。取消级联：沿用主代理的 abort signal；同时注册到 subagentRegistry，
 * 支持「独立取消某一个子代理」而不影响主代理继续运行。
 *
 * 以 async generator 形式产出 `subagent_start / subagent_delta / subagent_end` 独立事件维度，
 * 主循环把它们逐片转发给前端（旧前端忽略未知 type 即向后兼容）；最终 return 子代理交接结果。
 */
async function* runSubagent(
  call: ToolCall,
  ctx: LoopContext,
  parentId: string,
): AsyncGenerator<ChatEvent, SubagentResult> {
  const args = safeJsonParse(call.argsJson);
  const description = String(args.description || args.task || "").trim();
  if (!description) {
    return { id: call.id, args: call.argsJson, ok: false, text: "task 需要提供 description（要委派的具体任务）", toolCalls: 0 };
  }
  // 可选白名单：把子代理的工具限定在它真正需要的服务器上（对齐 Deep Agents「只给它需要的工具」）。
  const resolved = resolveSubagentTools(
    ctx.mcpTools,
    Array.isArray(args.servers) ? args.servers.map((id) => String(id || "")) : [],
  );
  if (resolved.error) {
    return { id: call.id, args: call.argsJson, ok: false, text: resolved.error, toolCalls: 0 };
  }
  const subTools = resolved.tools;
  const subBuiltins = builtinToolSpecs({ toolSearch: ctx.toolSearch }).filter(
    (spec) => spec.name !== "task" && spec.name !== "write_todos",
  );

  const subagentId = nextSubagentId(ctx.conversationId);
  const controller = new AbortController();
  const handle: SubagentHandle = {
    id: subagentId,
    conversationId: ctx.conversationId,
    description,
    controller,
    status: "running",
  };
  subagentRegistry.set(subagentId, handle);
  // 级联：主代理整体取消 → 子代理也中止。
  const onParentAbort = (): void => {
    if (handle.status === "running") {
      handle.status = "cancelled";
      controller.abort();
    }
  };
  const detachParent = (): void => {
    if (ctx.signal) ctx.signal.removeEventListener("abort", onParentAbort);
  };
  if (ctx.signal) {
    if (ctx.signal.aborted) onParentAbort();
    else ctx.signal.addEventListener("abort", onParentAbort, { once: true });
  }

  yield { type: "subagent_start", id: subagentId, parentId, description };

  const subCtx: LoopContext = {
    ...ctx,
    images: [],
    mcpTools: subTools,
    // 按需加载模式：子代理同样只拿内置工具 + 检索入口，自己检索加载。
    specs: [...subBuiltins, ...(ctx.toolSearch ? [] : selectMcpToolSpecs(subTools).specs)],
    toolSearch: ctx.toolSearch,
    loadedTools: new Set<string>(),
    system: { stable: SUBAGENT_PROMPT, dynamic: "" },
    allowTask: false,
    // 子代理默认只读（写操作安全闸门 P0-5）：非只读操作在闸门处立即拒绝。
    // SUBAGENT_ALLOW_WRITE=on 仅作预留（确认事件转发未实现，放开会导致挂起到超时），不改变本值。
    allowWrite: false,
    maxRounds: SUBAGENT_MAX_ROUNDS,
    namespace: ctx.namespace,
    ownerKey: ctx.ownerKey,
    signal: controller.signal,
  };

  let toolCalls = 0;
  let outcome: LoopOutcome | null = null;
  try {
    const gen = runLoop(subCtx, [{ role: "user", content: description }]);
    let next = await gen.next();
    while (!next.done) {
      const ev = next.value;
      if (ev.type === "text_delta" || ev.type === "text") {
        yield { type: "subagent_delta", id: subagentId, text: ev.text };
      } else if (ev.type === "tool_call") {
        toolCalls += 1;
      }
      next = await gen.next();
    }
    outcome = next.value;
  } catch (err) {
    detachParent();
    const cancelled = controller.signal.aborted || ctx.signal?.aborted;
    const status = cancelled ? "cancelled" : "error";
    handle.status = status;
    const text = cancelled ? "子代理已被取消。" : `子代理执行出错：${String((err as Error)?.message || err)}`;
    yield { type: "subagent_end", id: subagentId, ok: false, status, text };
    subagentRegistry.delete(subagentId);
    return { id: call.id, args: call.argsJson, ok: false, text, toolCalls };
  }

  detachParent();
  handle.status = outcome!.failure ? "error" : "done";
  if (outcome!.failure) {
    const text = `子代理执行失败：${outcome!.failure}`;
    yield { type: "subagent_end", id: subagentId, ok: false, status: "error", text };
    subagentRegistry.delete(subagentId);
    return { id: call.id, args: call.argsJson, ok: false, text, toolCalls };
  }
  const summary = outcome!.text.trim() || "（子代理未返回内容）";
  const clipped =
    summary.length > SUBAGENT_RESULT_CHARS
      ? `${summary.slice(0, SUBAGENT_RESULT_CHARS)}\n…（已截断；如需完整数据，让子代理先用 fs_write 落盘，再用 fs_read 读取）`
      : summary;
  yield { type: "subagent_end", id: subagentId, ok: true, status: "done", text: clipped };
  subagentRegistry.delete(subagentId);
  return { id: call.id, args: call.argsJson, ok: true, text: clipped, toolCalls };
}

/**
 * 一批子代理并行执行（并发上限 SUBAGENT_MAX_PARALLEL）。
 * 以 async generator 形式把各子代理的 `subagent_*` 事件逐片转发；`results` 按调用顺序回填交接结果，
 * 供主循环转成 `tool_result` 回灌模型上下文。
 */
async function* runSubagentBatch(
  batch: ToolCall[],
  ctx: LoopContext,
  results: SubagentResult[],
): AsyncGenerator<ChatEvent> {
  const queue: ChatEvent[] = [];
  let cursor = 0;
  let settled = 0;
  const runOne = async (index: number): Promise<void> => {
    const call = batch[index]!;
    const gen = runSubagent(call, ctx, call.id);
    let n = await gen.next();
    while (!n.done) {
      queue.push(n.value);
      n = await gen.next();
    }
    results[index] = n.value;
    settled += 1;
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(SUBAGENT_MAX_PARALLEL, batch.length); i++) {
    workers.push(
      (async () => {
        let idx: number;
        while ((idx = cursor++) < batch.length) await runOne(idx);
      })(),
    );
  }
  void Promise.all(workers).catch(() => undefined);
  while (settled < batch.length || queue.length) {
    if (queue.length) {
      yield queue.shift() as ChatEvent;
    } else {
      await new Promise((r) => setTimeout(r, 15));
    }
  }
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
  opts: { model?: string; images?: string[]; sessionId?: string; ownerKey?: string } = {},
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

  // 去重 + 排序：工具清单的确定性来自这里（顺序稳定 → system+tools 前缀稳定 → prompt 缓存命中）。
  const enabled = [...new Set((conversation?.mcpServers || []).map((id) => String(id || "").trim()))]
    .filter(Boolean)
    .sort();
  // 「工具模式」由「是否勾选了 MCP」决定，而不是「是否成功发现到 MCP 工具」：
  // 否则某个服务器连不上会让整个对话静默降级成直连（内置工具一并消失），且模型无从知晓原因。
  const toolMode = enabled.length > 0;
  const collected = toolMode
    ? await collectToolsDetailed(enabled)
    : { tools: [] as McpToolInfo[], unavailable: [], ready: [] };
  const selection = selectMcpToolSpecs(collected.tools);
  // 工具定义本身就是纯开销：超过窗口的一定比例就改成「按需检索加载」（对齐 Claude Code ToolSearch 阈值策略）。
  const eagerTokens = selection.specs.length ? estimateTokens(JSON.stringify(selection.specs)) : 0;
  const toolSearch = toolMode && collected.tools.length > 0 && toolSearchEnabled(model, eagerTokens);
  // 内置工具（fs_* / write_todos / read_skill / task / search_tools）只在工具模式注入 —— 直连模式保持零工具语义。
  const builtinSpecs = toolMode ? builtinToolSpecs({ toolSearch }) : [];
  const specs = [...builtinSpecs, ...(toolSearch ? [] : selection.specs)];
  const labels = new Map<string, string>();
  for (const server of [...collected.ready, ...collected.unavailable]) labels.set(server.id, server.label);
  // 工具通道现状 → 进系统提示动态段：让模型知道「哪些域这次真的能查、哪些缺席、为什么缺席」。
  const tooling: ToolingStatus | null = toolMode
    ? {
        mcpToolCount: toolSearch ? 0 : selection.specs.length,
        totalMcpTools: collected.tools.length,
        builtinToolCount: builtinSpecs.length,
        ready: collected.ready,
        unavailable: collected.unavailable,
        dropped: toolSearch ? [] : selection.droppedServers.map((id) => labels.get(id) || id),
        limit: MCP_MAX_TOOLS,
        ...(toolSearch
          ? {
              deferred: true,
              searchToolName: TOOL_SEARCH_NAME,
              catalog: catalogOf(collected.tools, labels),
            }
          : {}),
      }
    : null;
  if (toolMode) {
    // 工具通道一行日志：排查「模型说没有这个能力」时，先看这里（谁缺席、为什么）。
    console.log(
      `[chat:tools] mode=${toolSearch ? "search" : "eager"} ` +
        `mcp=${specs.length - builtinSpecs.length}/${collected.tools.length} builtin=${builtinSpecs.length} ` +
        `ready=${collected.ready.map((item) => `${item.id}(${item.tools})`).join(",") || "-"} ` +
        `unavailable=${collected.unavailable.map((item) => `${item.id}(${item.reason})`).join("|") || "-"} ` +
        `dropped=${toolSearch ? "-" : selection.droppedServers.join(",") || "-"}`,
    );
  }
  // 预算先算：窗口 − 输出预留 − 工具 schema − 本轮工具结果预算（工具定义也是纯开销）。
  const toolSchemaTokens = specs.length ? estimateTokens(JSON.stringify(specs)) : 0;

  // 候选模型链：选定模型失败（瞬态 / 限流）时按注册表顺序切到下一个可用模型重试（韧性降级）。
  // 永久错误（4xx / 配额耗尽）不切模型。每段依赖模型的预算 / 上下文装配在循环内基于候选模型重算。
  const allModels = listModels();
  const candidates = [model, ...allModels.filter((m) => m.id !== model.id)];
  let text = "";
  let failure: string | null = null;
  let handles: ToolHandle[] = [];
  let clearedToolResults = 0;
  let offloadedToolResults = 0;
  let budget = 0;
  let usedWindow = model.contextWindow;
  let turnsCount = 0;
  let droppedCount = 0;
  let summarized = false;
  let totalTokens = 0;
  // 运行时统计（回填 usage 事件，便于可观测与成本归因）。
  let rounds = 0;
  let toolCalls = 0;
  let modelRetries = 0;
  let toolFusions = 0;
  let pseudoCallRetries = 0;
  let costTokens = 0;
  let modelFallbacks = 0;

  for (const m of candidates) {
    budget = historyBudgetTokens(m, toolSchemaTokens);
    // 上下文装配（history.ts）：窗口 → 无损裁剪 → 超预算时 LLM 摘要（水位线增量）→ 硬丢弃。
    const assembled = await assembleContext({
      history: conversation?.context || [],
      userText,
      budgetTokens: budget,
      summary: conversation?.summary,
      summaryCovered: conversation?.summaryCovered,
      compact: (prompt) => summarizeWith(m, prompt, signal),
    });
    turnsCount = assembled.usage.turns;
    droppedCount = assembled.usage.dropped;
    summarized = assembled.usage.summarized;
    const turns = assembled.turns;
    totalTokens = estimateTokensOf(turns.map((turn) => turn.content)) + estimateTokens(assembled.summary);
    // 摘要只在确实发生压缩时写回（水位线单调前移，下一轮增量扩展）。
    if (assembled.usage.compacted) {
      await setConversationSummary(conversationId, assembled.summary, assembled.summaryCovered).catch(() => undefined);
    }
    // 系统提示两段式：稳定前缀（角色守则 + skills 索引，可被 prompt cache 命中）
    // + 动态后缀（长期记忆 / 历史摘要 / 回复语言）。
    const system = buildSystemPrompt({
      locale: conversation?.locale,
      summary: assembled.summary || null,
      tooling,
      todos: conversation?.todos,
      enabledSkills: conversation?.skillsEnabled,
      role: conversation?.agentId,
      ownerKey: opts.ownerKey,
    });
    // 模型不支持直读图片时不再加载图片（避免无用 base64），由前端给出明确提示。
    const images = opts.images?.length && m.vision === "direct" ? imagesOf(opts.images) : [];
    // 重 yield model 事件：前端据此更新当前模型标签，用户可感知已切换到备用模型。
    yield { type: "model", id: m.id, label: m.label };
    usedWindow = m.contextWindow;

    const outcome: LoopOutcome | CallOutcome =
      toolMode
        ? yield* runLoop(
            {
              conversationId,
              model: m,
              images,
              mcpTools: collected.tools,
              specs,
              toolSearch,
              loadedTools: new Set<string>(),
              system,
              signal,
              allowTask: true,
              allowWrite: true,
              grantServers: new Set(conversation?.readGrants || []),
              sessionId: opts.sessionId,
              maxRounds: MAX_TOOL_ROUNDS,
              namespace: conversation?.agentId || "generic",
              ownerKey: opts.ownerKey,
            },
            turns,
          )
        : yield* streamCall(m, turns, images, [], signal, system);
    text = outcome.text;
    const loop = outcome as LoopOutcome;
    handles = loop.handles || [];
    clearedToolResults = loop.clearedToolResults || 0;
    offloadedToolResults = loop.offloadedToolResults || 0;
    rounds = loop.rounds || 0;
    toolCalls = loop.toolCallCount || 0;
    modelRetries = loop.modelRetries || 0;
    toolFusions = loop.toolFusions || 0;
    pseudoCallRetries = loop.pseudoCallRetries || 0;
    costTokens = loop.spentTokens || 0;
    if (!outcome.failure) break;
    failure = outcome.failure;
    if (!isTransientModelError(failure)) break; // 永久错误不切模型
    // 安全护栏：已执行过工具调用（可能含写操作 / 用户已确认的调用）时不再换模型重跑，
    // 避免重复副作用；此时直接按失败收束（下方会保留已生成的中间结果）。
    if (toolCalls > 0) break;
    modelFallbacks += 1;
    console.log(`[chat:fallback] model ${m.label} failed (${failure}); trying next candidate`);
  }

  const usage: ChatEvent = {
    type: "usage",
    tokens: totalTokens,
    budget,
    window: usedWindow,
    turns: turnsCount,
    dropped: droppedCount,
    summarized,
    toolResultsCleared: clearedToolResults,
    toolResultsOffloaded: offloadedToolResults,
    rounds,
    toolCalls,
    modelRetries,
    modelFallbacks,
    toolFusions,
    pseudoCallRetries,
    costTokens,
  };

  if (failure) {
    // 用户主动中断（点「停止」/ 关页面）：这一轮已经发生了，仍要写回上下文，
    // 否则下一轮模型看不到它，而界面上用户已经看到这段内容 —— 上下文与界面不一致。
    if (signal?.aborted) {
      await appendContext(
        conversationId,
        [{ role: "user", text: userText }, { role: "assistant", text: text.trim() }],
      ).catch(() => undefined);
    } else if (text.trim()) {
      // 模型调用中途失败：保留已生成的中间结论，避免整轮成果丢失（如限流前已产出的部分答案），
      // 并附中断说明。仅当完全无产出时才退回纯错误提示。
      yield {
        type: "text",
        text: `${text.trim()}\n\n⚠️ 生成因以下原因中断：${failure}（以上为中断前的中间结果，可能不完整）`,
      };
    }
    if (!text.trim()) {
      yield {
        type: "error",
        error: { code: "MODEL_ERROR", defaultMessage: failure },
        message: failure,
      };
    }
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
