// 聊天引擎（自研 agent harness，路线 B 补齐 Deep Agents 能力）。
// 工具注入：内置工具（fs_* / write_todos / read_skill / task / render_chart …）**始终注入**——
//           它们是本机能力、不含外部数据面；勾选的 MCP 服务器再额外注入其外部工具。
//           「勾选」只表达「要接哪些外部数据源」，不再兼职当「要不要本机能力」的开关。
//           模型出 tool_calls → 执行 → 结果回灌 → 再调用，直到结论或轮次上限。
// 能力层：系统提示两段式（稳定前缀可缓存）· 工具结果超预算卸载到工作区 · 任务规划持久化 ·
//         子代理（task 工具：独立上下文 + 最小工具集 + 只回摘要）。
import type { ArtifactSpec, ChatEvent, ClarifyOption, RiskLevel, TodoItem } from "@bx/shared";
import { config, defaultModel, getModel, listModels, type ModelEntry } from "./config.js";
import { BUILTIN_SERVER, builtinToolSpecs, execBuiltin, TOOL_SEARCH_NAME, WORKSPACE_FILE_WRITE_TOOLS } from "./builtins.js";
import { requestClarification, requestConfirmation } from "./confirm.js";
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
import { resolveToolRisk, subagentMayExecute, verdictNeedsConfirm } from "./risk.js";
import type { ToolHandle } from "./session.js";
import { buildSystemPrompt, SUBAGENT_PROMPT, type SystemPrompt, type ToolingStatus } from "./system-prompt.js";
import { getRole } from "./roles.js";
import { enforceRoleIdentity } from "./role-guard.js";
import {
  buildDataNeedPrompt,
  buildGroundedFallbackSystem,
  buildVerifyHint,
  buildVerifyPrompt,
  consensusUnsupported,
  crossCheckSources,
  DATA_NEED_SYSTEM,
  decideGrounding,
  GROUNDING_HINT,
  hasExternalDataSource,
  isGroundingEvidenceTool,
  MAX_UNSUPPORTED_CLAIMS,
  parseDataNeed,
  parseVerifyResult,
  shouldRunVerification,
  unknownToolRefs,
  UNGROUNDED_REPLY,
  VERIFY_SYSTEM,
  type VerifyResult,
} from "./grounding.js";
import { wrapUntrusted } from "./untrusted.js";
import { webSearchStatus } from "./web-search.js";
import { getUploadImage, getUploadFile } from "./uploads.js";
import { parseFile } from "./rag/parsers.js";
import { assembleContext } from "./history.js";

// 上下文预算以 token 计，并由「模型窗口」推导（不再用与模型无关的固定字符数）。
const CONTEXT_SAFETY_RATIO = Number(process.env.CONTEXT_SAFETY_RATIO || 0.8);
// 本轮工具结果预算（token）与「最近 N 组不清理」——沿用 trigger / keep 的语义。
const TOOL_RESULT_BUDGET = Number(process.env.MCP_TOOL_RESULT_BUDGET || 12_000);
const TOOL_RESULT_KEEP = Number(process.env.MCP_TOOL_RESULT_KEEP || 3);
// 白名单：名单内工具的结果永不清理（逗号分隔；支持 * 通配，如 mcp__movie__* 保护整台 MCP 服务器的工具）。
const TOOL_RESULT_PROTECT_PATTERNS = (process.env.MCP_TOOL_RESULT_PROTECT || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
function isToolResultProtected(name: string): boolean {
  if (!name) return false;
  return TOOL_RESULT_PROTECT_PATTERNS.some((pat) => {
    if (pat === name) return true;
    if (!pat.includes("*")) return false;
    const re = new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").split("*").join(".*") + "$");
    return re.test(name);
  });
}
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
/**
 * 从 `start` 起收集一段**连续的**可并发调用（纯函数，便于单测）。
 * 遇到「已执行过 / 批内重复 / 已熔断 / 不可并发」任一项即停止，长度受 `max` 限制。
 * 连续段的语义：不重排模型给出的顺序，也不跳过中间某个调用去凑批。
 */
export function planConcurrentBatch<T extends { name: string; argsJson: string }>(
  calls: readonly T[],
  opts: {
    start: number;
    max: number;
    signature: (name: string, argsJson: string) => string;
    isExecuted: (sig: string) => boolean;
    isFused: (name: string) => boolean;
    canRun: (name: string, argsJson: string) => boolean;
  },
): Array<{ call: T; sig: string }> {
  const out: Array<{ call: T; sig: string }> = [];
  const seen = new Set<string>();
  for (let j = opts.start; j < calls.length && out.length < opts.max; j += 1) {
    const c = calls[j]!;
    const sig = opts.signature(c.name, c.argsJson);
    if (opts.isExecuted(sig) || seen.has(sig)) break;
    if (opts.isFused(c.name)) break;
    if (!opts.canRun(c.name, c.argsJson)) break;
    seen.add(sig);
    out.push({ call: c, sig });
  }
  return out;
}

/**
 * 单轮里可并发执行的调用上限（G1）：模型一轮返回多个独立只读调用时并发发出，
 * 省掉 N×RTT。上限避免一次打爆上游；需要确认的写操作与交互式调用永不进并发批。
 */
const MAX_CONCURRENT_CALLS = Math.max(1, Number(process.env.MCP_CONCURRENT_CALLS || 4));
// 接地护栏（防「零数据凭记忆作答」，详见 src/grounding.ts）：仅对声明 enforceGrounding 的角色生效。
// GROUNDING_MAX_RETRIES = 允许的纠正次数（作废文本 + 回灌提示让模型补取数据）；用尽后改用确定性拒答。
const GROUNDING_GUARD = (process.env.GROUNDING_GUARD || "on").toLowerCase() !== "off";
const GROUNDING_MAX_RETRIES = Math.max(0, Number(process.env.GROUNDING_MAX_RETRIES || 1));
// 事后核验（Chain-of-Verification 最小版，详见 src/grounding.ts）：补齐「拿到部分数据后仍有超出证据的断言」。
// 代价 = 每次收束多一次模型调用（不流式、不展示给用户）；GROUNDING_VERIFY=off 可关闭。
const GROUNDING_VERIFY = (process.env.GROUNDING_VERIFY || "on").toLowerCase() !== "off";
const GROUNDING_VERIFY_MAX = Math.max(0, Number(process.env.GROUNDING_VERIFY_MAX || 1));
// 多票裁决次数（≤1 = 单次，默认；>1 = 跑 N 次独立核验、多数票认定无支持才作废，降低核验器自身误判）。
// 代价随票数线性叠加（每次收束多 N 次模型调用）；属「更稳但更贵」的可选项，默认不开启。
const GROUNDING_VERIFY_VOTES = Math.max(1, Number(process.env.GROUNDING_VERIFY_VOTES || 1));
// 送入核验器的证据上限（字符）：证据本身也可能很长，核验不能变成新的上下文负担。
const GROUNDING_EVIDENCE_CHARS = Math.max(1000, Number(process.env.GROUNDING_EVIDENCE_CHARS || 12_000));
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

/**
 * 事后核验调用（Chain-of-Verification 最小版）：同一个模型、无工具、非流式——结果只用于判定，
 * 不展示给用户。返回无支持断言列表；`null` 表示核验不可用（解析失败），调用方按「不阻断」处理。
 */
async function verifyAnswerWith(
  model: ModelEntry,
  input: { question: string; evidence: string; answer: string },
  signal?: AbortSignal,
): Promise<VerifyResult> {
  const result = await callAgent(
    model,
    [{ role: "user", content: buildVerifyPrompt(input) }],
    [],
    signal,
    undefined,
    // 判定型调用：温度归零——核验器自己在采样会让同一段回答今天拦、明天放，护栏就成了新的随机源。
    { systemParts: { stable: VERIFY_SYSTEM, dynamic: "" }, temperature: 0 },
  );
  return parseVerifyResult(result.text);
}

/**
 * 零证据收束的「受约束诚实兜底」：同一个模型、无工具、非流式，按 `buildGroundedFallbackSystem` 的严格口径
 * 写最后一段回复（只能说明职责边界 / 如实说没取到 / 请用户补充，严禁任何事实性断言）。
 *
 * 为什么需要它：确定性兜底文案（`UNGROUNDED_REPLY`）没有语义，无法区分「本轮本就不需要数据」与
 * 「需要数据但没取到」，于是打招呼、超出职责范围的提问也会被回成一句「没有取得任何数据源返回的数据」。
 * 返回 `null` = 兜底调用不可用（异常 / 空文本），由调用方回落到确定性文案——绝不因此展示未接地内容。
 */
/**
 * 「本轮是否需要外部数据」的轻判定调用（无工具、极短提示，通常几百毫秒级）。
 * 只在**零证据收束**时使用（见 runLoop 的 grounding 分支），用来决定是「补取数据再答」（重试重提示）
 * 还是「本就不需要数据 → 直接受约束兜底」（轻提示）。判定不可用（异常 / 解析不出）返回 null = 按 DATA 处理。
 */
async function probeNeedsExternalData(
  model: ModelEntry,
  question: string,
  answer: string,
  signal?: AbortSignal,
): Promise<"data" | "no_data" | null> {
  try {
    const result = await callAgent(
      model,
      [{ role: "user", content: buildDataNeedPrompt(question.trim() || "（本轮没有可识别的文本输入）", answer) }],
      [],
      signal,
      undefined,
      // 判定对象是「待上屏的回答」，不是用户的问题：护栏拦的是无证据的事实断言，必须以回答为准。
      { systemParts: { stable: DATA_NEED_SYSTEM, dynamic: "" }, disableThinking: true, temperature: 0 },
    );
    return parseDataNeed(result.text);
  } catch (err) {
    console.warn(`[chat:grounding] 数据需求分诊调用失败，按 DATA 处理：${String((err as Error)?.message || err)}`);
    return null;
  }
}

async function honestFallbackWith(
  model: ModelEntry,
  question: string,
  roleLabel: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const result = await callAgent(
      model,
      [{ role: "user", content: question.trim() || "（用户本轮没有可识别的文本输入）" }],
      [],
      signal,
      undefined,
      {
        systemParts: { stable: buildGroundedFallbackSystem(roleLabel), dynamic: "" },
        disableThinking: true,
        temperature: 0,
      },
    );
    return result.text.trim() || null;
  } catch (err) {
    console.warn(`[chat:grounding] 诚实兜底调用失败，改用确定性兜底文案：${String((err as Error)?.message || err)}`);
    return null;
  }
}

function truncateArgs(raw: string): string {
  const text = (raw || "").trim();
  return text.length > HANDLE_ARGS_CHARS ? `${text.slice(0, HANDLE_ARGS_CHARS)}…` : text;
}

/**
 * 判定模型调用错误是否「瞬态」（同一模型重试有意义）：限流 / 5xx / 超时 / 中断 / 网络抖动。
 * 额度类（402 / 401008 / 额度不足）与参数 / 鉴权类（400 / 401 / invalid_request）是确定性失败：
 * 同模型重试只会得到同一结果，应直接交给候选链切下一个模型。
 * 注意必须先做确定性排除再跑正向匹配——上游错误 JSON 里顺带的词（如 "source":"gateway"）
 * 会把 402 误判成瞬态，让每个死模型都白打满重试次数（实测 kimi26 额度耗尽即如此）。
 */
function isTransientModelError(msg: string | null): boolean {
  if (!msg) return false;
  if (/(?:model http )?40[012]\b|401008|额度不足|额度已耗尽|permission_error|invalid_request_error|unauthorized/i.test(msg)) {
    return false;
  }
  return /(?:429|503|5\d\d|timeout|timed?\s*out|abort|rate\s*limit|freeusagelimit|econn|fetch failed|network|socket|模型服务暂时不可用|gateway)/i.test(
    msg,
  );
}

/** 伪工具调用被拦截后的纠正提示（回灌给模型，要求走函数调用通道）。 */
const PSEUDO_CALL_HINT =
  "上一条回复把工具调用写成了正文文本（而不是通过函数调用通道发起），该文本已作废。\n" +
  "请通过函数调用（tool_calls）发起工具调用；不要在回复正文里书写调用语句（JSON / XML / 方括号等）。";

/**
 * 伪出图被拦截后的纠正提示（回灌给模型，要求走 render_chart 通道）。
 * 与 PSEUDO_CALL_HINT 同源——都是「把工具的产出写成了正文文本」，只是载体从调用语句换成了图片语法。
 */
const FAKE_CHART_HINT =
  "上一条回复用 Markdown 图片语法占位了图表，但目标不是可访问的图片地址：浏览器只会去请求一个不存在的地址，" +
  "用户看到的不是图、而是一个破图。该文本已作废。\n" +
  "要出图必须调用 render_chart 工具（图表会作为对话内的卡片直接显示）；不要在正文里自己写图片链接或图片占位符。" +
  "本轮若没有可出图的真实数据，就不出图，改为如实说明缺什么，不要编造数据。";

/**
 * 无人值守运行走到最后一轮的收尾提示（与工具一并摘掉）。
 * 只摘工具不够：这类模型会把「想调工具」写成一句过程叙述就停下，仍然没有结论。
 * 故显式要求「基于已有数据给结论」，并允许它如实说「数据不足」——两种都是结论，编造不是。
 */
const WRAP_UP_HINT =
  "本轮已达到工具调用轮次上限，工具不可再用。\n" +
  "请仅基于已经获得的数据，直接给出结论性回答；不要再描述你打算查什么。\n" +
  "若已有数据不足以支撑结论，就如实说明已经查到什么、还缺哪一项，禁止编造数据。";

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

/**
 * 运行时答案校验（协议级）：识别正文里的**图片占位符**——模型用 Markdown 图片语法假装出图，
 * 实测形态：`![近 7 天 vs 前 7 天 各来源日均环比（%）](chart)`（图根本没出，正文只留一行占位）。
 *
 * 判据只看目标能不能解析成图片地址（`http(s):` / `data:` / 协议相对 `//`），不涉及任何业务词：
 * 其余形态——`(chart)`、`(url)`、空目标、相对路径——在浏览器里一律按相对 URL 去请求 → 404，
 * 用户看到的不是「没有图」而是一个**破图图标**：比不出图更糟，它看起来像图挂了、而不是没出图。
 *
 * 代码块与行内代码里的图片语法是**示例**（写文档、贴代码片段时会出现），不是假装出图，先剥掉再扫。
 * 返回命中的目标（去重）供调用方回灌点名；未命中返回空数组。
 */
export function unresolvableImageTargets(text: string): string[] {
  if (!text || !text.includes("![")) return [];
  const body = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const targets = new Set<string>();
  // Markdown 图片语法：![alt](target)。alt 可为空、可含中文与空格；target 取到右括号或空白为止。
  const re = /!\[[^\]]*\]\(\s*([^)\s]*)/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(body))) {
    const target = hit[1] || "";
    if (/^(?:https?:|data:|\/\/)/i.test(target)) continue;
    targets.add(target);
  }
  return [...targets];
}

/** 结果规模摘要（供跨轮句柄使用，不含正文）。 */
function handleSummary(content: string): string {
  const lines = content ? content.split("\n").length : 0;
  return `${lines} 行 / ${content.length} 字符`;
}

/**
 * 澄清回执（对齐「答案必须绑定回被问的那一项」的通行做法）：
 * 用户点选 = 回传值恰好等于某个选项标题；自由文本 = 回传值不等于任何选项标题；跳过/超时 = 显式说明。
 * 三种口径分开表述，避免出现「用户已澄清：X」而 X 其实只是模型自己给的兜底选项——那对模型是零信息，
 * 它只会卡住（实测：用户点了「其他…」之后模型直接空回复）。
 * 判定只做字符串相等（协议层），不解读语义、不含任何词表。
 */
export function buildClarifyAck(
  answer: { confirmed: boolean; timedOut: boolean; value?: string },
  options: ClarifyOption[],
): string {
  if (answer.timedOut) return "等待澄清超时：请按最合理的理解继续，并在回复里说明你的假设。";
  // 非确认（拒绝）与空值统一按「跳过」处理：拒绝时不应把任何值当作用户的选择。
  if (!answer.confirmed || !answer.value) return "用户跳过了澄清：请按最合理的理解继续，并在回复里说明你的假设。";
  const picked = options.find((opt) => opt.label === answer.value);
  if (!picked) return `用户补充说明：${answer.value}。据此继续。`;
  const note = picked.description ? `（该选项说明：${picked.description}）` : "";
  return (
    `用户选择了选项「${picked.label}」${note}。据此继续；` +
    "如果这条选择仍不足以确定你要的信息（例如它只是一个没有指明具体内容的兜底项），" +
    "请就最关键的一点再具体追问一次，不要凭空假设。"
  );
}

// 确认卡参数摘要（P0-6）：键名命中敏感词的值脱敏；长值**头尾保留 + 显式省略计数**（不静默截断：
// 只留头部的摘要会把藏在尾部的内容藏起来，而确认卡的全部价值就是让用户看清「到底要执行什么」）。
const SENSITIVE_KEY_RE = /token|secret|password|key|authorization|cookie/i;
const ARG_SUMMARY_MAX_ITEMS = 8;
/** 单值展示总长（超出即头尾保留并标注省略量）。 */
const ARG_SUMMARY_VALUE_CHARS = 1200;
/** 头尾保留里头部占比（其余留给尾部）。 */
const ARG_SUMMARY_HEAD_CHARS = 800;

/** 关键参数摘要：取入参顶层键，值 JSON 化后按上限头尾保留；敏感键只显示占位符（凭据不外泄）。 */
export function summarizeArgsForConfirm(argsJson: string): Array<{ key: string; value: string }> {
  const args = safeJsonParse(argsJson);
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  return Object.entries(args as Record<string, unknown>)
    .slice(0, ARG_SUMMARY_MAX_ITEMS)
    .map(([key, value]) => {
      let text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
      if (text.length > ARG_SUMMARY_VALUE_CHARS) {
        const head = text.slice(0, ARG_SUMMARY_HEAD_CHARS);
        const tail = text.slice(-(ARG_SUMMARY_VALUE_CHARS - ARG_SUMMARY_HEAD_CHARS));
        text = `${head}\n…（中间省略 ${text.length - ARG_SUMMARY_VALUE_CHARS} 字符）…\n${tail}`;
      }
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
      !isToolResultProtected(turn.name || "") &&
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

/**
 * 单附件注入上限（token）。按 **token** 而非字符计：估算器把 CJK 记作 ~1 token/字，
 * 旧的 30000 字符上限对中文文档等于 30000 token —— 一份文档就能吃掉整个窗口的余量。
 */
const ATTACH_MAX_TOKENS = Math.max(500, Number(process.env.ATTACH_MAX_TOKENS || 8000));
/**
 * 本轮所有附件的**合计**上限（token）。
 * 附件文本拼进系统提示，而系统提示不参与历史预算（`historyBudgetTokens` 只扣输出预留 / 工具 schema /
 * 工具结果预算），所以这一路必须自带闸门——否则「多贴几份文档」会直接把请求顶出模型窗口。
 */
const ATTACH_TOTAL_MAX_TOKENS = Math.max(1000, Number(process.env.ATTACH_TOTAL_MAX_TOKENS || 20000));

/** 按 token 预算截断文本（估算器：CJK ≈ 1 字/token，其余 ≈ 4 字符/token）。导出供单测覆盖。 */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (!text || estimateTokens(text) <= maxTokens) return { text, truncated: false };
  const chars = Array.from(text);
  const tokensPerChar = estimateTokens(text) / chars.length;
  const keep = Math.max(1, Math.floor(maxTokens / tokensPerChar));
  let slice = chars.slice(0, keep).join("");
  // 估算本身有误差：切片后仍超预算就按比例再收，保证「不越界」优先于「切得刚好」。
  while (slice.length > 1 && estimateTokens(slice) > maxTokens) {
    slice = Array.from(slice)
      .slice(0, Math.floor(slice.length * 0.9))
      .join("");
  }
  return { text: slice, truncated: true };
}

/**
 * 把用户本轮在聊天里附加的文档（PDF / Word / Excel / md / txt / csv）解析为文本，
 * 作为临时上下文注入系统提示，让模型直接据此作答（对齐 CodeBuddy「贴文档即读」）。
 * 解析失败的附件不中断对话，仅附一行提示让模型知道它不可用；
 * 超出预算的附件按 token 截断或整体跳过，并把「跳过了哪些」如实写进注入内容（不静默丢）。
 */
async function buildAttachmentContext(ids: string[] | undefined): Promise<string> {
  if (!ids?.length) return "";
  const blocks: string[] = [];
  const skipped: string[] = [];
  let usedTokens = 0;
  for (const id of ids) {
    const f = getUploadFile(id);
    if (!f) {
      blocks.push(`（附件 ${id} 已过期或不存在，已跳过）`);
      continue;
    }
    let parsed: Awaited<ReturnType<typeof parseFile>>;
    try {
      parsed = await parseFile(f.path);
    } catch (e) {
      blocks.push(`（附件《${f.name}》读取失败：${String((e as Error)?.message || e)}，已跳过）`);
      continue;
    }
    if ("error" in parsed) {
      blocks.push(`（附件《${f.name}》解析失败：${parsed.error}，已跳过）`);
      continue;
    }
    const remaining = ATTACH_TOTAL_MAX_TOKENS - usedTokens;
    if (remaining <= 0) {
      skipped.push(f.name);
      continue;
    }
    // 实际可用的额度 = min(单附件上限, 合计剩余额度)：剩余额度不足时按剩余截断。
    const cap = Math.min(ATTACH_MAX_TOKENS, remaining);
    const capped = truncateToTokens(parsed.text, cap);
    usedTokens += estimateTokens(capped.text);
    blocks.push(
      `### 附件《${f.name}》\n${capped.text}` +
        (capped.truncated
          ? `\n…（附件过长，已截断到约 ${cap} token；原文共 ${parsed.text.length} 字符）`
          : ""),
    );
  }
  if (skipped.length) {
    blocks.push(
      `（本轮附件合计超出注入预算，以下附件未提供内容：${skipped.join("、")}。如需按其作答，请单独提问或先精简附件。）`,
    );
  }
  if (!blocks.length) return "";
  return (
    "【用户本次在对话中附加的文档（请优先依据这些内容作答，不要编造；与本地知识库冲突时以附件为准）】\n" +
    blocks.join("\n\n")
  );
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
  /** 本轮思考流原文：端点要求回灌思考时（models.ts 的 reasoningReplayRequired）需随 assistant 轮一起回灌，
   *  否则多轮工具循环会被网关判为「缺 reasoning_content」而断掉。 */
  reasoning: string;
}

/**
 * 已确认「不接受强制工具通道」（`tool_choice: "required"` / 指定函数）的端点。
 *
 * 为什么需要：强制通道是可选项，不是通用能力——Anthropic 官方文档明示部分模型对 any/tool 直接返回 400，
 * 且强制时会预填 assistant 消息（模型无法先给自然语言开场，问候这类轮次因此失去正常回话的机会）。
 * 本仓实测 TokenHub 的 OpenAI 兼容端点（kimi-k2.7-code）对 required 与「指定函数」均回
 * `400 invalid_request_error / 400001 rejected by an internal MaaS component`，只有 auto / none 可用；
 * 探测脚本 `scripts/_model-toolchoice-probe.mjs` 已随 2026-09 的调试脚本清理移除；
 * 这条结论的回归在 `tests/deep-agent-control.test.ts`（`forcedToolChoiceSupported` 的「被拒一次就记住」）。
 *
 * 结论：被拒一次就记住，后续不再发 required；否则**每一轮首调**都要白打一次 400（延迟翻倍 + 日志噪音），
 * 而下面的降级分支本来就会改走 auto 重试。key 含端点地址：换模型 / 换网关重新探测，不把 A 的结论套到 B。
 */
const forcedToolChoiceUnsupported = new Set<string>();

function modelEndpointKey(model: ModelEntry): string {
  return `${model.id}@${String(model.baseUrl || "")}`;
}

/** 该模型端点是否仍可尝试强制工具通道（false = 已实测被拒，直接走 auto）。 */
export function forcedToolChoiceSupported(model: ModelEntry): boolean {
  return !forcedToolChoiceUnsupported.has(modelEndpointKey(model));
}

/** 记录「该模型端点不接受强制工具通道」（进程内记忆，重启后重新探测一次）。 */
export function markForcedToolChoiceUnsupported(model: ModelEntry): void {
  const key = modelEndpointKey(model);
  if (forcedToolChoiceUnsupported.has(key)) return;
  forcedToolChoiceUnsupported.add(key);
  console.warn(
    `[chat:tool-choice] 端点不接受强制工具通道（模型 ${model.id}）：反编造由提示词纪律 + 接地护栏承担，` +
      "该端点不再尝试 tool_choice=required",
  );
}

/** 一次模型调用：边收增量边 yield text_delta / thinking_delta，结束时返回全文与工具调用。 */
export async function* streamCall(
  model: ModelEntry,
  turns: Turn[],
  images: OptionImage[],
  tools: ToolSpec[],
  signal?: AbortSignal,
  system?: SystemPrompt,
  /** 角色级首轮强制工具调用（对齐 Anthropic「防凭记忆作答」最佳实践）：仅当存在且当前尚无工具结果时，
   *  把 tool_choice 设为 required 逼模型先调工具；拿到结果后（或角色未开启）走 auto。不传 = auto。 */
  forceToolCall?: boolean,
): AsyncGenerator<ChatEvent, CallOutcome> {
  // 单一有序队列：文本与思考增量按到达顺序入队（同一 read 内也保持先后），消费循环严格 FIFO
  // 下发，避免「优先取文本」导致整段 SSE 一次性送达时思考被排到正文之后。
  const pending: Array<{ kind: "text" | "thinking"; text: string }> = [];
  let settled = false;
  let failure: string | null = null;
  let wake: (() => void) | null = null;
  let toolCalls: ToolCall[] = [];
  // 思考流原文（按到达顺序累积）：既用于回传本轮的 assistant 轮（端点要求时回灌），也用于「空回合」判定。
  let reasoning = "";
  // 是否收到过文本增量回调：用于区分「流式通道（文本增量已逐片推进 pending）」与
  // 「非流式通道（ollama / 不支持 SSE 的网关，onDelta 永不触发）」。
  let streamed = false;

  // 角色级首轮强制工具调用：当前尚无工具结果（turns 里没有 role==="tool"）且角色开启 forceToolCall 时，
  // 把 tool_choice 设为 required，逼模型先调工具、杜绝凭记忆编造；一旦有工具结果即恢复 auto（模型可正常收尾）。
  // 仅当确有工具 schema 时才设（无工具的直连路径保持原 auto/none 语义，不产生 required+空工具的非法请求）。
  // 注意：required(any) 与「扩展思考(thinking)」在多数端点互斥，且部分端点根本不接受该取值（会直接 4xx）。
  // 首次被端点拒绝时自动降级 auto 重试一次（模型仍靠强提示走工具），并把该模型记入「不支持强制通道」——
  // 否则每一轮首调都要白打一次 400（延迟翻倍 + 日志噪音）。判定与记忆见本模块的 forcedToolChoiceSupported。
  const hasToolResult = turns.some((t) => t.role === "tool");
  const forceApplied = !!forceToolCall && !hasToolResult && forcedToolChoiceSupported(model);
  let toolChoice: "required" | "auto" = forceApplied ? "required" : "auto";
  let text = "";

  const invokeAndDrain = async function* (): AsyncGenerator<ChatEvent> {
    const running = callAgent(
      model,
      turns,
      images,
      signal,
      (chunk) => {
        pending.push({ kind: "text", text: chunk });
        streamed = true;
        wake?.();
      },
      tools.length
        ? { tools, toolChoice, systemParts: system }
        : { systemParts: system },
      (tchunk) => {
        // 注意：thinking 通道不应置 streamed——streamed 只表示「文本增量已通过流式通道到达」，
        // 用于决定是否走非流式文本兜底。否则非流式模型一旦返回 thinking，会误把最终正文丢弃。
        reasoning += tchunk;
        pending.push({ kind: "thinking", text: tchunk });
        wake?.();
      },
    )
      .then((result) => {
        toolCalls = result.toolCalls || [];
        // 非流式通道（如 ollama、不支持 SSE 的网关）没有增量回调，整包文本在这里补齐，
        // 否则模型明明有输出，最终却拼出空回复。注意：判据用 streamed 而非 pending.length——
        // 流式通道的 pending 在消费循环里会被即时 shift 清空，若按 pending.length 判断会在
        // 流式结束后误把整段最终文本再压入一次，导致最终回复翻倍。
        if (result.text && !streamed) pending.push({ kind: "text", text: result.text });
      })
      .catch((err) => {
        failure = String((err as Error)?.message || err);
      })
      .finally(() => {
        settled = true;
        wake?.();
      });

    while (!settled || pending.length) {
      if (!pending.length) {
        await new Promise<void>((resolve) => {
          wake = () => {
            wake = null;
            resolve();
          };
        });
        continue;
      }
      const item = pending.shift() as { kind: "text" | "thinking"; text: string };
      if (item.kind === "text") {
        text += item.text;
        yield { type: "text_delta", text: item.text };
      } else {
        yield { type: "thinking_delta", text: item.text };
      }
    }
    await running;
  };

  yield* invokeAndDrain();
  // 首轮强制 required 被端点拒绝 → 降级 auto 重试一次（仍靠强提示让模型走工具）。
  // 触发面不止「与 thinking 不兼容」：部分网关对 tool_choice=required 直接回 4xx 且不点名字段
  // （例如只回「请求不合法」的通用客户端错误），因此把「任何 4xx 客户端拒绝」都算作端点不接受强制通道。
  // 排除鉴权 / 额度 / 限流类永久错误：那些重试也只会拿到同一个错误，白打一次还拖慢失败反馈。
  const permanentFailure = /402|401006|额度|未开通|余额|无权限|限流|rate.?limit|too many requests/i.test(
    failure || "",
  );
  const forcedToolRejected =
    forceApplied &&
    !!failure &&
    !permanentFailure &&
    (/model http 4\d\d/i.test(failure) ||
      /tool_choice.*(required|any).*(incompatible|thinking|not support|unsupported|invalid)/i.test(failure));
  if (forcedToolRejected) {
    // 记住「该端点不接受强制通道」：下一次调用起直接用 auto，不再为同一个 400 付费（本进程内有效）。
    markForcedToolChoiceUnsupported(model);
    console.log(`[chat:tool-choice] required 被端点拒绝，降级 auto 重试一次：${failure!.slice(0, 200)}`);
    failure = null;
    toolChoice = "auto";
    // 复位消费循环状态：第一次（失败的 required）的 .finally 已把 settled 置 true、wake 置 null，
    // 若不复位，第二个 invokeAndDrain 的 while 循环会因 settled 早已为 true 而直接跳过，导致第二轮文本增量全部丢失（返回空回复）。
    settled = false;
    wake = null;
    yield* invokeAndDrain();
  }
  return { text, toolCalls, failure, reasoning };
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
  /** 主代理 = true；子代理 = false（子代理送不出确认事件 → 需要用户拍板的操作在闸门处立即拒绝，
   *  免确认的工作区写仍可执行；判定见 risk.ts `subagentMayExecute`）。 */
  allowWrite: boolean;
  /** 会话级只读授权（conversation.readGrants）：仅对「未声明级别」的同服务器工具降级为只读。 */
  grantServers: ReadonlySet<string>;
  /**
   * 完全访问（conversation.fullAccess）：true = 写/破坏性/外部操作**不**逐项弹确认卡，直接执行
   * （对齐 CodeBuddy「完全访问模式」）。缺省按 true 处理（开箱即完全授权）。
   * 仅影响「人审确认」：clarify 挂起、失败熔断等安全流程不因此失效；deny（如未知工具=deny）在完全访问下也放行。
   */
  fullAccess: boolean;
  /** 发起请求的会话 id：确认票据与它绑定（跨会话应答会被拒绝）。 */
  sessionId?: string;
  /** 发起请求的设备 owner：用于按用户隔离的本地状态（如观影画像），不暴露给模型。 */
  ownerKey?: string;
  maxRounds: number;
  /** 无人值守运行（定时任务）：最后一轮不再给工具，强制模型用已经取到的数据收尾写结论。
   *  不填 = 交互式行为不变（没人在等，模型可以一路调工具到预算耗尽）。 */
  forceWrapUp?: boolean;
  /** 知识库命名空间（按角色隔离）：默认 "generic"，由当前会话角色决定。 */
  namespace: string;
  /** 角色级首轮强制工具调用（对齐 Anthropic「防凭记忆作答」最佳实践）；仅 "尚无工具结果" 的首轮生效。
   *  不填 = auto，通用角色行为不变。子代理继承主代理值（movie 子代理同样首轮强制）。 */
  forceToolCall?: boolean;
  /** 角色级接地护栏（防「零数据凭记忆作答」，详见 src/grounding.ts）：本轮无任何外部数据时不允许收束。
   *  不填 = 不参与本护栏，通用角色行为不变。 */
  enforceGrounding?: boolean;
}

interface LoopOutcome {
  text: string;
  failure: string | null;
  handles: ToolHandle[];
  clearedToolResults: number;
  offloadedToolResults: number;
  /** 执行的工具调用次数（子代理回传规模摘要用）。 */
  toolCallCount: number;
  /** 真正执行过、且级别非只读（写/删/未知保守）的调用次数：调用方据此判断能否换模型重跑。 */
  sideEffects: number;
  /** 工具循环实际使用的轮次（模型调用次数）。 */
  rounds: number;
  /** 模型调用瞬时失败重试次数。 */
  modelRetries: number;
  /** 因连续失败被熔断跳过的工具调用次数。 */
  toolFusions: number;
  /** 协议护栏拦截纠正的次数（伪工具调用 / 伪出图占位符）。 */
  pseudoCallRetries: number;
  /** 接地护栏纠正次数（零数据作答被作废并回灌提示的次数）。 */
  groundingRetries: number;
  /** 事后核验（断言-证据核对）次数。 */
  groundingVerifications: number;
  /** 纠正后仍未取得数据、最终以确定性拒答收束（true 时调用方须丢弃模型文本）。 */
  ungrounded: boolean;
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
  // 最终回答文本：只有「综合轮」（不调工具、直接收束的那一轮）的文本才作为正式答案。
  // 中间轮（会调工具 / 被纠正重试）的文本属于过程叙述，不进入答案（详见下方流式缓冲）。
  let synthesisText = "";
  let failure: string | null = null;
  let clearedToolResults = 0;
  let offloadedToolResults = 0;
  let toolCallCount = 0;
  // 副作用计数（写/删/未知保守）：与「工具调用次数」分开——只读调用重跑无副作用，不该阻止换模型。
  let sideEffects = 0;
  // 循环护栏：同轮去重集合（每轮重置）+ 跨轮 Doom Loop 检测器。
  const executedSigs = new Set<string>();
  let roundExecuted: string[] = [];
  const guard = new LoopGuard(DOOM_LOOP_MAX_ROUNDS);
  // 成本护栏：累计本轮已发送的 prompt token 估算；失败熔断：各工具连续失败计数。
  let spentTokens = 0;
  const failedTools = new Map<string, number>();
  // 运行时统计（回填 usage 事件）：轮次 / 重试 / 熔断 / 协议护栏纠正（伪调用与伪出图共用一次预算）。
  let rounds = 0;
  let modelRetries = 0;
  let toolFusions = 0;
  let pseudoCallRetries = 0;
  let pseudoCallRetried = false;
  // 接地护栏状态：evidence = 本轮真正执行成功且引入外部数据的工具数；未取证就收束则按 decision 处理。
  let groundingEvidence = 0;
  let groundingRetries = 0;
  let ungrounded = false;
  // 事后核验状态：累积证据原文（供核验器对齐）+ 已核验次数。
  let groundingVerifications = 0;
  const evidence: string[] = [];
  let evidenceChars = 0;
  /** 本轮证据的**来源集合**（工具名 / 服务器标识）：回答里声称的来源要能与它对上，否则就是编造的引用。 */
  const evidenceSources = new Set<string>();
  /** 累积证据原文（受 GROUNDING_EVIDENCE_CHARS 约束；超限后不再追加，保证核验调用不膨胀）。
   *  每条以「【来源 工具名】」前缀标注来源——这是「断言→具体来源」逐条归因的基础（详见 docs），
   *  也便于核验器在口径里据此判断某断言由哪个工具返回支撑。 */
  const pushEvidence = (raw: string, source?: string) => {
    if (!raw || evidenceChars >= GROUNDING_EVIDENCE_CHARS) return;
    if (source) evidenceSources.add(source);
    const labeled = source ? `【来源 ${source}】\n${raw}` : raw;
    const room = GROUNDING_EVIDENCE_CHARS - evidenceChars;
    const piece = labeled.slice(0, room);
    evidence.push(piece);
    evidenceChars += piece.length;
  };
  // 核验与「无数据作答」都以**用户原始问题**为对照基准：取上下文里最后一条 user 消息
  // （后续回灌的纠正提示会往 conversation 追加 user 消息，所以基准必须在这里先取好）。
  const userQuestion = [...turns].reverse().find((turn) => turn.role === "user")?.content || "";

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
    // 本轮正文缓冲：先把本轮的流式正文暂存，其余事件（思考 / 工具调用 / 工具结果）照常转发。
    // 待本轮判定为「综合轮」时才把正文作为回答下发；否则（工具调用轮 / 被纠正重试轮）丢弃，
    // 避免把「让我搜索…」这类过程叙述泄漏进用户可见的答案（对齐 Deep Agents：工具轮的内部
    // 叙述不是答案，答案只看最后一圈综合）。
    let roundText = "";
    // 该轮模型调用瞬时失败重试：SSE 中途断流 / 超时 / 限流等瞬态错误应重试，
    // 4xx 等永久错误不重试。重试对用户透明（不累加失败文本，成功后才计入 text）。
    while (true) {
      // 无人值守的最后一轮：把工具摘掉，强制模型用已取到的数据写结论。
      // 否则它可以一路调工具到预算耗尽——这一期报告就只剩过程叙述、没有任何结论。
      const wrapUp = ctx.forceWrapUp === true && ctx.maxRounds > 1 && round === ctx.maxRounds - 1;
      if (wrapUp && round > 0) {
        console.log("[chat:wrap-up] 无人值守的最后一轮：不收工具，强制收尾出结论");
        // 只摘工具不够：模型会把「想调工具」写成一句过程叙述就停下。显式要求收尾（同 PSEUDO_CALL_HINT 的回灌方式）。
        conversation.push({ role: "user", content: WRAP_UP_HINT });
      }
      // 强制工具通道在「没有工具」时无意义（部分网关会直接 400），收尾轮必须一起关掉。
      const gen = streamCall(
        ctx.model,
        conversation,
        ctx.images,
        wrapUp ? [] : specs,
        ctx.signal,
        ctx.system,
        wrapUp ? false : ctx.forceToolCall,
      );
      let step = await gen.next();
      while (!step.done) {
        const ev = step.value as ChatEvent;
        if (ev.type === "text_delta") {
          roundText += ev.text;
        } else {
          yield ev;
        }
        step = await gen.next();
      }
      outcome = step.value as CallOutcome;
      if (!outcome.failure) {
        // 空回合（既无正文、也无工具调用、连思考都没有）不是「模型表示没有内容」，而是上游抖动：
        // 共享/免费端点上很常见。直接收束会让用户看到空白气泡（同一次提问重发往往就有内容），
        // 故走同一份瞬时重试预算重试；重试用尽才接受空结果（后续还有伪调用/接地等分支兜底）。
        const emptyRound = !outcome.text.trim() && !outcome.toolCalls.length && !outcome.reasoning.trim();
        if (emptyRound && callAttempt < MODEL_CALL_RETRIES) {
          callAttempt += 1;
          modelRetries += 1;
          console.log(`[chat:retry] 模型返回空回合，重试 ${callAttempt}/${MODEL_CALL_RETRIES}`);
          continue;
        }
        break;
      }
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
      if (!pseudoCallRetried) {
        const pseudoCall = looksLikePseudoToolCall(outcome.text, new Set(specs.map((s) => s.name)));
        // 同类问题的另一种载体：把「出图结果」写成正文里的图片占位符。两者共用一次纠正预算——
        // 都是「工具产出被写成了正文文本」，改掉的提示是同一条纪律（走工具通道，别自己造产物）。
        const fakeCharts = pseudoCall ? [] : unresolvableImageTargets(outcome.text);
        const hint = pseudoCall ? PSEUDO_CALL_HINT : fakeCharts.length ? FAKE_CHART_HINT : "";
        if (hint) {
          pseudoCallRetried = true;
          pseudoCallRetries += 1;
          text = text.slice(0, Math.max(0, text.length - outcome.text.length));
          conversation.push({ role: "assistant", content: outcome.text });
          conversation.push({ role: "user", content: hint });
          console.log(
            pseudoCall
              ? "[chat:pseudo-call] 检出文本形式的工具调用，已作废并回灌纠正提示"
              : `[chat:pseudo-chart] 检出图片占位符（${fakeCharts.join(", ")}），已作废并回灌纠正提示`,
          );
          continue;
        }
      }
      // 运行时校验：接地护栏（防「零数据凭记忆作答」）。声明 enforceGrounding 的角色在一条数据都没
      // 拿到时不允许以正文结论收束——先作废该段文本 + 回灌纠正提示（两条路径都写明），纠正用尽仍无数据
      // 则标记 ungrounded，并改用「受约束的诚实兜底」收束（绝不展示可能编造的内容）。
      const grounding = decideGrounding({
        enforceGrounding: ctx.enforceGrounding,
        enabled: GROUNDING_GUARD,
        evidenceCalls: groundingEvidence,
        retries: groundingRetries,
        maxRetries: GROUNDING_MAX_RETRIES,
      });
      // 零证据收束先做一次**轻分诊**（无工具、极短提示）：判定对象是**待上屏的回答本身**。
      //   NO_DATA（回答里没有需外部数据支撑的事实断言：寒暄、身份与能力说明、职责边界、纯推理创作）
      //     → **直接放行**：这类回答不是幻觉来源，纠正它只会把模型本来正确的回复换成兜底话术
      //       （实测过：问候被换成「没取到数据」，既与事实不符、观感也更差）。
      //   DATA / 判定失败 → 维持原路（作废 + 回灌纠正提示再跑一轮），反编造的自愈路径完全不变。
      //     实测一次问候的耗时几乎全在「重提示重试」：重提示每轮 4-10s，轻提示 <1s。
      if (grounding === "retry") {
        const need = await probeNeedsExternalData(ctx.model, userQuestion, outcome.text, ctx.signal);
        if (need === "no_data") {
          console.log("[chat:grounding] 分诊判定本轮回答不含需外部数据支撑的断言：放行，不作废也不兜底");
          synthesisText = outcome.text;
          if (roundText) yield { type: "text_delta", text: roundText };
          break;
        }
        groundingRetries += 1;
        text = text.slice(0, Math.max(0, text.length - outcome.text.length));
        conversation.push({ role: "assistant", content: outcome.text });
        conversation.push({ role: "user", content: GROUNDING_HINT });
        console.log("[chat:grounding] 未取得任何工具数据即作答，已作废并回灌纠正提示");
        continue;
      }
      if (grounding === "block") {
        ungrounded = true;
        // 丢弃本轮未接地的正文（不上屏），改为一次「受约束的诚实兜底」（禁止任何事实性断言）：
        // 不能直接回固定话术——固定话术无法区分「本轮本来就不需要数据」与「需要数据但没取到」，
        // 会把「没有取得任何数据源返回的数据」当成结论告诉用户（与事实不符）。
        // 注：前者已由上面的分诊放行（NO_DATA 直接上屏），走到这里的都是「需要数据但确实没取到」。
        text = text.slice(0, Math.max(0, text.length - outcome.text.length));
        const honest = await honestFallbackWith(ctx.model, userQuestion, getRole(ctx.namespace).label, ctx.signal);
        const finalHonest = honest || UNGROUNDED_REPLY;
        console.log(
          `[chat:grounding] 纠正后仍未取得工具数据，改走受约束的诚实兜底${honest ? "" : "（调用不可用，回落确定性文案）"}`,
        );
        spentTokens += estimateTokens(finalHonest);
        text += finalHonest;
        synthesisText = finalHonest;
        yield { type: "text_delta", text: finalHonest };
        break;
      }
      // 运行时校验：事后核验（Chain-of-Verification 最小版）。零证据的情况已由上面拦截；这里覆盖
      // 「拿到部分数据后仍有超出证据的断言」——发现即作废并回灌纠正（可重新取数或删掉无支持内容）。
      if (
        shouldRunVerification({
          enforceGrounding: ctx.enforceGrounding,
          enabled: GROUNDING_VERIFY,
          evidenceChars,
          verifications: groundingVerifications,
          maxVerifications: GROUNDING_VERIFY_MAX,
        })
      ) {
        groundingVerifications += 1;
        const evidenceText = evidence.join("\n");
        const verifyInput = { question: userQuestion, evidence: evidenceText, answer: outcome.text };
        // 多票裁决：跑 GROUNDING_VERIFY_VOTES 次独立核验，多数票认定无支持才作废（降低核验器自身误判）。
        // 任一票不可用（解析失败 / 调用异常）→ 整体视为「未核验」，不阻断作答（不静默、也不误判）。
        let claims: string[] | null = null;
        let anyVerifyFail = false;
        const results: VerifyResult[] = [];
        for (let v = 0; v < GROUNDING_VERIFY_VOTES; v += 1) {
          spentTokens += estimateTokens(buildVerifyPrompt(verifyInput));
          try {
            results.push(await verifyAnswerWith(ctx.model, verifyInput, ctx.signal));
          } catch (err) {
            anyVerifyFail = true;
            console.warn(`[chat:grounding] 事后核验调用失败（票 ${v + 1}），本轮跳过核验：${String((err as Error)?.message || err)}`);
          }
        }
        // 引用溯源的确定性部分（不依赖核验器，成败都不受影响）：
        // 「声称调用了一个本轮根本不存在的工具」是最典型的硬幻觉，纯字符串比对即可判定，零额外成本。
        const knownSources = [...evidenceSources, ...specs.map((spec) => spec.name)];
        const fakeToolClaims = unknownToolRefs(outcome.text, knownSources).map(
          (ref) => `声称调用的工具「${ref}」本轮并不存在`,
        );
        if (!anyVerifyFail) {
          const unsupported = consensusUnsupported(results.map((run) => run.unsupported));
          const reported = consensusUnsupported(results.map((run) => run.unknownSources));
          // 核验器报出的来源再做一次集合比对：它也可能错报，只有真的对不上本轮来源才算数。
          const unknownSourceClaims = crossCheckSources(reported || [], knownSources).map(
            (ref) => `声称的来源「${ref}」在本轮工具返回的数据里不存在`,
          );
          const merged = [...new Set([...(unsupported || []), ...unknownSourceClaims, ...fakeToolClaims])];
          claims = merged.length ? merged.slice(0, MAX_UNSUPPORTED_CLAIMS) : null;
        } else if (fakeToolClaims.length) {
          // 核验不可用时不阻断作答，但编造的工具引用照样不放过。
          claims = fakeToolClaims.slice(0, MAX_UNSUPPORTED_CLAIMS);
        }
        if (claims && claims.length) {
          // 断言条目来自模型（可能转述了外部内容）→ 按不可信数据处理，回灌前定界。
          const wrapped = wrapUntrusted(claims.map((claim) => `- ${claim}`).join("\n"), {
            kind: "verification_claims",
            source: "grounding-verify",
          });
          text = text.slice(0, Math.max(0, text.length - outcome.text.length));
          conversation.push({ role: "assistant", content: outcome.text });
          conversation.push({ role: "user", content: buildVerifyHint(wrapped.text) });
          console.log(`[chat:grounding] 事后核验发现 ${claims.length} 条无支持断言，已作废并回灌纠正提示`);
          continue;
        }
      }
      // 本轮为「综合轮」（无工具调用、并通过全部纠正后收束）：只有这一轮的正文才是正式回答，
      // 流式下发为回答正文，并记为最终答案（覆盖中间轮的过程叙述）。
      synthesisText = outcome.text;
      if (roundText) yield { type: "text_delta", text: roundText };
      break;
    }

    // 每轮重置同轮去重集合（跨轮允许重新执行，避免误杀「重新取数」等合法重复）。
    executedSigs.clear();
    roundExecuted = [];

    // 工具调用轮：把本轮思考一并带上（`reasoning`）——思考类模型在工具循环里要求 assistant 工具调用消息
    // 携带 reasoning_content，缺了会被网关判为非法请求（详见 models.ts 的 reasoningReplayRequired）。
    // 是否真的下发该字段由端点能力决定（models.ts 按端点学习），这里只保证「有原文就不会丢」。
    conversation.push({
      role: "assistant",
      content: outcome.text,
      toolCalls: outcome.toolCalls,
      ...(outcome.reasoning.trim() ? { reasoning: outcome.reasoning } : {}),
    });

    // 逐个处理；**连续的** task 委派合并成一批并行执行（对齐 Deep Agents：单轮多个 task 并行）。
    const calls = outcome.toolCalls;
    let index = 0;

    /**
     * 本轮是否请求了结构化澄清：包含时，冻结本轮其余**非只读**调用
     * （对齐澄清的通行做法：问题未答前不得产生会锁定方向的副作用，只读探查仍放行）。
     * 判据只看风险级别，与参数内容、模型措辞无关。
     */
    const clarifyRequestedThisRound = calls.some((item) => item.name === "request_clarification");

    /** 审计基础字段（串行 / 并发两条路径共用，保证留痕口径一致）。 */
    const auditBaseOf = (c: ToolCall, v: ReturnType<typeof resolveToolRisk>) => ({
      conversationId: ctx.conversationId,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.ownerKey ? { ownerKey: ctx.ownerKey } : {}),
      tool: c.name,
      ...(v.serverId ? { server: v.serverId } : {}),
      level: v.level,
      unknown: v.unknown,
      reason: v.reason,
      argsDigest: argsDigestOf(c.argsJson),
    });

    /**
     * 能否进并发批（G1）：只读 + 免确认 + 非交互。
     * task 委派自带并行批、工具检索会改工具清单、澄清要挂起等用户——都不进并发批；
     * 写操作 / 需确认 / 被拒的调用一律串行（避免同时弹多张确认卡）。
     */
    const concurrentOk = (name: string, v: ReturnType<typeof resolveToolRisk>) =>
      v.level === "read" &&
      !v.deny &&
      !verdictNeedsConfirm(v) &&
      name !== "task" &&
      name !== TOOL_SEARCH_NAME &&
      name !== "request_clarification";

    /** 单个调用的执行体（不 yield，供并发批复用；事件与回灌由调用方按原始顺序处理）。 */
    const executeOne = async (
      c: ToolCall,
    ): Promise<{
      ok: boolean;
      rawText: string;
      executed: boolean;
      todos?: TodoItem[];
      chart?: { title?: string; chartType: string; data: unknown; encode?: Record<string, string>; options?: Record<string, unknown> };
      artifact?: ArtifactSpec;
    }> => {
      const builtin = await execBuiltin(c.name, c.argsJson, ctx.conversationId, ctx.namespace, ctx.ownerKey);
      if (builtin) {
        return {
          ok: builtin.ok,
          rawText: builtin.text,
          executed: true,
          ...(builtin.todos ? { todos: builtin.todos } : {}),
          ...(builtin.chart ? { chart: builtin.chart } : {}),
          ...(builtin.artifact ? { artifact: builtin.artifact } : {}),
        };
      }
      if (ctx.toolSearch && specOfTool.has(c.name) && !ctx.loadedTools.has(c.name)) {
        return {
          ok: false,
          executed: false,
          rawText: `工具 ${c.name} 尚未加载：请先调用 ${TOOL_SEARCH_NAME} 检索它（关键词可用工具名），加载后再调用。`,
        };
      }
      const result = await callMcpTool(c.name, safeJsonParse(c.argsJson), ctx.signal);
      return { ok: !result.isError, rawText: result.text, executed: true };
    };
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
          // 子代理回传也是外部数据 → 计入接地证据（见 src/grounding.ts）。
          if (result.ok) {
            groundingEvidence += 1;
            pushEvidence(result.text, "task");
          }
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
      // ── 并发批（G1）：连续的「只读 + 免确认」调用一起发出，省掉 N×RTT ──
      // 顺序纪律：事件与上下文回灌仍按模型给出的原始顺序，保证可复现与 prompt cache 稳定。
      if (concurrentOk(call.name, resolveToolRisk(call.name, ctx.grantServers, safeJsonParse(call.argsJson)))) {
        const planned = planConcurrentBatch(calls, {
          start: index,
          max: MAX_CONCURRENT_CALLS,
          signature: toolCallSignature,
          isExecuted: (s) => TOOL_DEDUP_SAME_ROUND && executedSigs.has(s),
          isFused: (name) => (failedTools.get(name) || 0) >= TOOL_FAILURE_LIMIT,
          canRun: (name, argsJson) => concurrentOk(name, resolveToolRisk(name, ctx.grantServers, safeJsonParse(argsJson))),
        });
        const batch = planned.map((item) => ({
          ...item,
          verdict: resolveToolRisk(item.call.name, ctx.grantServers, safeJsonParse(item.call.argsJson)),
        }));
        // 只有 1 个就走原路径（零行为变化），≥2 个才真的并发。
        if (batch.length > 1) {
          for (const item of batch) {
            index += 1;
            toolCallCount += 1;
            yield {
              type: "tool_call",
              id: item.call.id,
              name: item.call.name,
              server: serverOf.get(item.call.name),
              args: item.call.argsJson,
            };
          }
          for (const item of batch) {
            executedSigs.add(item.sig);
            roundExecuted.push(item.sig);
            // 只读放行也留痕（仅外部工具；工作区工具不记，避免噪音）。
            if (item.verdict.external) {
              appendAudit({ kind: "gate", decision: "allowed", ...auditBaseOf(item.call, item.verdict) });
            }
          }
          const outcomes = await Promise.all(batch.map((item) => executeOne(item.call)));
          for (let k = 0; k < batch.length; k += 1) {
            const item = batch[k]!;
            const out = outcomes[k]!;
            // 副作用计数（与单调用路径同口径，见其注释）。
            if (out.executed && item.verdict.level !== "read") sideEffects += 1;
            // 失败计数（供失败熔断）：真正执行且成功 → 清零；真正执行但失败 → 累计。
            if (out.executed) {
              if (out.ok) failedTools.delete(item.call.name);
              else failedTools.set(item.call.name, (failedTools.get(item.call.name) || 0) + 1);
            }
            if (out.executed && out.ok && isGroundingEvidenceTool(item.call.name)) {
              groundingEvidence += 1;
              pushEvidence(out.rawText, item.call.name);
            }
            if (out.todos) yield { type: "todos", todos: out.todos };
            if (out.chart)
              yield {
                type: "chart",
                title: out.chart.title,
                chartType: out.chart.chartType,
                data: out.chart.data,
                encode: out.chart.encode,
                options: out.chart.options,
              };
            if (out.artifact) yield { type: "artifact", ...out.artifact };
            const outContent = truncateResult(out.rawText);
            yield { type: "tool_result", id: item.call.id, name: item.call.name, ok: out.ok, text: outContent };
            const wrappedOut = wrapUntrusted(outContent, {
              kind: "tool_result",
              source: serverOf.get(item.call.name) || item.call.name,
            });
            conversation.push({
              role: "tool",
              toolCallId: item.call.id,
              name: item.call.name,
              content: wrappedOut.text,
            });
            handles.push({
              name: item.call.name,
              args: truncateArgs(item.call.argsJson),
              summary: out.ok ? handleSummary(out.rawText) : "执行失败",
            });
          }
          continue;
        }
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
      const verdict = resolveToolRisk(call.name, ctx.grantServers, safeJsonParse(call.argsJson));
      const auditBase = auditBaseOf(call, verdict);
      // 子代理可执行范围按**作用域**判定（P0-5，2026-09-22 细化）：真正该挡住的是「需要用户拍板」
      // 的操作——子代理的确认事件送不进用户可见的事件流，送不出去就只能挂到超时。
      // 免确认的工作区写（fs_write / fs_edit：沙箱内、路径与体积有上限、可回查）与此无关，照常放行
      // （否则「让子代理把中间结果落盘」这类本来就安全的委派会被无谓挡住）。判定见 risk.ts。
      if (!subagentMayExecute(verdict, ctx.allowWrite)) {
        ok = false;
        rawText = `该操作（${verdict.level}，带外部副作用）不能委派给子代理执行：请在主对话里直接发起（这类操作需要你确认，会在主对话弹确认卡）。`;
        yield { type: "tool_result", id: call.id, name: call.name, ok, text: rawText };
        conversation.push({ role: "tool", toolCallId: call.id, name: call.name, content: rawText });
        handles.push({ name: call.name, args: truncateArgs(call.argsJson), summary: "未执行（子代理不能做需确认的操作）" });
        appendAudit({ kind: "gate", decision: "subagent_refused", ...auditBase });
        continue;
      }
      // 未声明工具按 MCP_UNKNOWN_TOOLS=deny 的口径直接拒绝；原生 SQL 工具的非只读查询也走此处。
      // 完全访问模式下跳过该硬拒（用户已明确授权，缺省即完全访问）。
      if (verdict.deny && !ctx.fullAccess) {
        ok = false;
        rawText = verdict.reason
          ? `工具 ${call.name} 被安全闸门拒绝：${verdict.reason}`
          : `工具 ${call.name} 未声明操作级别，按当前安全口径拒绝执行；如确需使用，请在服务器配置中显式声明该工具的风险级别。`;
        yield { type: "tool_result", id: call.id, name: call.name, ok, text: rawText };
        conversation.push({ role: "tool", toolCallId: call.id, name: call.name, content: rawText });
        handles.push({ name: call.name, args: truncateArgs(call.argsJson), summary: "未执行（未知工具被拒绝）" });
        appendAudit({ kind: "gate", decision: "denied", ...auditBase });
        continue;
      }
      // 待澄清期间冻结非只读调用（问题未答前不得产生会锁定方向的副作用；只读探查照常放行）。
      // 被冻结的调用不算失败（不计入失败熔断），模型收到回答后如需再做可重新调用。
      if (clarifyRequestedThisRound && verdict.level !== "read") {
        ok = false;
        rawText =
          `本轮你请求了澄清，在用户回答之前该操作（${verdict.level}）已暂缓、未执行；` +
          "拿到用户的回答后，如果仍需要做这件事，请重新调用。";
        yield { type: "tool_result", id: call.id, name: call.name, ok, text: rawText };
        conversation.push({ role: "tool", toolCallId: call.id, name: call.name, content: rawText });
        handles.push({ name: call.name, args: truncateArgs(call.argsJson), summary: "已暂缓（等待澄清）" });
        // 闸门决策留痕：与其他 gate 口径一致，便于审计追溯「pending 期间拦下了哪些写操作」。
        appendAudit({ kind: "gate", decision: "clarify_deferred", ...auditBase });
        continue;
      }
      // 完全访问：跳过二次确认，直接执行（缺省即完全访问）。仍走 verdict.deny 之外的正常执行路径。
      if (verdictNeedsConfirm(verdict) && !ctx.fullAccess) {
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
      } else if (verdict.external || WORKSPACE_FILE_WRITE_TOOLS.has(call.name)) {
        // 放行留痕：外部工具（含只读）全记；工作区**文件写**也记一条——它已免确认（见 builtins.ts 登记表），
        // 免确认之后唯一的保障是「可回查」。工作区只读工具与 write_todos 仍不记，避免噪音。
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
        if (builtin.chart)
          yield {
            type: "chart",
            title: builtin.chart.title,
            chartType: builtin.chart.chartType,
            data: builtin.chart.data,
            encode: builtin.chart.encode,
            options: builtin.chart.options,
          };
        if (builtin.artifact) yield { type: "artifact", ...builtin.artifact };
        // 结构化澄清：工具层不能自己挂起（事件发不出去），由循环下发事件并等待用户选择。
        if (builtin.clarification) {
          const pending = requestClarification({
            sessionId: ctx.sessionId || "",
            conversationId: ctx.conversationId,
            callId: call.id,
          });
          yield {
            type: "clarification_required",
            id: call.id,
            ticket: pending.ticket,
            question: builtin.clarification.question,
            options: builtin.clarification.options,
            ...(builtin.clarification.missingField ? { missingField: builtin.clarification.missingField } : {}),
            ...(builtin.clarification.whyItMatters ? { whyItMatters: builtin.clarification.whyItMatters } : {}),
            expiresInMs: pending.timeoutMs,
          };
          const answer = await pending.wait;
          yield {
            type: "clarification_response",
            id: call.id,
            ...(answer.value ? { answer: answer.value } : {}),
          };
          // 回执按「点选 / 自由文本 / 跳过 / 超时」分口径构造（见 buildClarifyAck）；
          // ok 已由 builtin.ok（澄清成功必为 true）给出，无需重复赋值。
          rawText = buildClarifyAck(answer, builtin.clarification.options);
        }
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
      // 副作用计数：真正执行过、且级别非只读的调用。只读（read）不计——换模型重跑只读调用没有副作用，
      // 不该被「已产生副作用就不能切候选」的护栏拦住（见 chatStream 候选循环的说明）。
      if (executed && verdict.level !== "read") sideEffects += 1;
      // 失败计数（供失败熔断）：真正执行且成功 → 清零；真正执行但失败 → 累计。
      if (executed) {
        if (ok) failedTools.delete(call.name);
        else failedTools.set(call.name, (failedTools.get(call.name) || 0) + 1);
      }
      // 接地证据（详见 src/grounding.ts）：真正执行成功、且引入外部数据的工具才算「答案有数据支撑」；
      // 记账 / 工作区类内置工具（write_todos、fs_write 等）成功也不算证据。
      if (executed && ok && isGroundingEvidenceTool(call.name)) {
        groundingEvidence += 1;
        pushEvidence(rawText, call.name);
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
    // 只把综合轮的文本作为答案返回；没有综合轮（失败 / 熔断 / 预算耗尽）时回退到累计文本，
    // 保证这些降级路径仍能看到已完成的部分成果。
    text: synthesisText || text,
    failure,
    handles,
    clearedToolResults,
    offloadedToolResults,
    toolCallCount,
    sideEffects,
    rounds,
    modelRetries,
    toolFusions,
    pseudoCallRetries,
    groundingRetries,
    groundingVerifications,
    ungrounded,
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
  // 子代理不得向用户提问（排除 request_clarification）：用户决策权归父任务（对齐 Deep Agents
  // 「子代理只能回传候选」）——子代理的澄清要么到不了用户（挂到超时），要么绕过父代理的决策上下文。
  const subBuiltins = builtinToolSpecs({ toolSearch: ctx.toolSearch }).filter(
    (spec) =>
      spec.name !== "task" && spec.name !== "write_todos" && spec.name !== "request_clarification",
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
    // 子代理不参与接地护栏：它的产出是回传给主代理的**中间摘要**，不是用户可见的最终答案；
    // 最终答案由主代理那一层护栏把关（零证据照样拦）。让子代理也走护栏会把它正常的工作区操作
    // （fs_write 存中间结果这类工具不构成证据）判成「零证据作答」，摘要被换成兜底话术，
    // 主代理拿到的是一句「没取到数据」而不是子代理真正做出来的东西。
    enforceGrounding: false,
    // 子代理不自己弹确认卡（写操作安全闸门 P0-5）：需要用户拍板的操作由闸门按作用域拒绝
    // （risk.ts subagentMayExecute）——免确认的工作区写可用，外部写留给主对话。
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
      } else if (ev.type === "chart") {
        // 子代理也会用 render_chart（它在子代理的内置工具集里）。图表 spec 只存在于事件里、
        // 不写进子代理回传的摘要文本——不在这里转发就等于「图悄悄丢了」，而模型还会声称已出图。
        yield ev;
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
  // 接地护栏：子代理纠正用尽仍无数据 → 不以「成功摘要」回传，避免把未接地内容当结论回灌主代理。
  if (outcome!.ungrounded) {
    const text = UNGROUNDED_REPLY;
    yield { type: "subagent_end", id: subagentId, ok: false, status: "error", text };
    subagentRegistry.delete(subagentId);
    return { id: call.id, args: call.argsJson, ok: false, text, toolCalls };
  }
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
 * traceMeta 是 run 级追踪的旁路 sink：实际服务模型作为 first-class 字段在此落地，
 * 不依赖受限的事件缓冲（长 run 会裁掉起始的 model 事件，见 chat-tasks.ts 缓冲上限）。
 */
export async function* chatStream(
  conversationId: string,
  userText: string,
  opts: {
    model?: string;
    images?: string[];
    attachments?: string[];
    sessionId?: string;
    ownerKey?: string;
    /**
     * 任务级外部工具允许清单（MCP 服务器 id）。语义是**只能收窄**：
     * 与对话启用集取交集，绝不因为调用方传了某个 id 就放开对话里没勾的服务器。
     * 定时任务（无人值守）用它把数据源限制到任务真正需要的那几个。
     */
    mcpAllowlist?: string[];
    /**
     * 任务级独立启用集（定时任务用）：存在时注入集就是它，
     * 不再与对话启用集取交集——定时任务是一次独立运行，工具清单以任务自身配置为准。
     */
    mcpServers?: string[];
    /** 本次运行的工具轮次预算；不填走全局默认 MCP_MAX_TOOL_ROUNDS（无人值守任务给更宽的预算）。 */
    maxRounds?: number;
    /** 无人值守运行（定时任务）：最后一轮摘掉工具，强制模型收尾写结论（交互式不传，行为不变）。 */
    forceWrapUp?: boolean;
    /** 任务级附加指引：拼进系统提示的**动态后缀**（不进用户可见历史、不污染稳定前缀）。 */
    taskGuide?: string;
  } = {},
  signal?: AbortSignal,
  traceMeta?: { servedModel?: string },
): AsyncGenerator<ChatEvent> {
  const conversation = await getConversation(conversationId);
  // 优先级：请求显式指定 > 对话设置 > 角色默认模型 > 服务端默认。
  const roleDefaultModel = conversation?.agentId ? getRole(conversation.agentId).defaultModel : undefined;
  const roleModel = roleDefaultModel ? getModel(roleDefaultModel) : undefined;
  // 角色钉住的模型已从 MODEL_PROVIDERS 移除（下线 / 改 id）时如实告警一次：否则会静默回落到全局默认，
  // 表现为「页面用的模型和配置里写的不是同一个」，排查时只能靠翻 .env 猜。
  if (roleDefaultModel && !roleModel) {
    console.warn(
      `[chat:model] 角色 ${conversation?.agentId} 的默认模型 ${roleDefaultModel} 未在 MODEL_PROVIDERS 中配置，回落到服务端默认模型`,
    );
  }
  const model =
    getModel(opts.model) || getModel(conversation?.model) || roleModel || defaultModel();
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
  if (traceMeta) traceMeta.servedModel = model.id;

  // 去重 + 排序：工具清单的确定性来自这里（顺序稳定 → system+tools 前缀稳定 → prompt 缓存命中）。
  const conversationEnabled = [...new Set((conversation?.mcpServers || []).map((id) => String(id || "").trim()))].filter(
    Boolean,
  );
  // 允许清单与启用集**取交集**（只收窄、不放开）：定时任务可以少带工具，但不能越过对话的授权范围。
  const allowlist = opts.mcpAllowlist?.length
    ? new Set(opts.mcpAllowlist.map((id) => String(id || "").trim()).filter(Boolean))
    : null;
  // 任务级独立启用集优先：定时任务以自身勾的为准，不受对话勾选影响（对话没勾不代表任务不能用）。
  const taskServers = opts.mcpServers
    ? [...new Set(opts.mcpServers.map((id) => String(id || "").trim()).filter(Boolean))].sort()
    : null;
  const enabled =
    taskServers ?? (allowlist ? conversationEnabled.filter((id) => allowlist.has(id)) : conversationEnabled).sort();
  // 两个正交概念，不能用同一个变量同时管（旧实现把「是否注入内置工具」也压在「勾了 MCP」上，
  // 后果是没勾任何连接器时连本机能力都消失：新对话零工具，本地出图/工作区文件全用不了）：
  //   mcpEnabled —— 外部数据面：勾了哪些外部服务器，决定是否收集外部工具、是否走按需检索。
  //   内置工具   —— 本机能力：fs_* / write_todos / read_skill / task / search_tools / render_chart 等，
  //                 不含任何外部数据面，因此**始终注入**（对齐 Cursor / Claude Code：
  //                 本地能力恒可用，外部数据源按需接入）。勾选状态只影响外部能力域，不影响本机能力。
  const mcpEnabled = enabled.length > 0;
  const collected = mcpEnabled
    ? await collectToolsDetailed(enabled)
    : { tools: [] as McpToolInfo[], unavailable: [], ready: [] };
  const selection = selectMcpToolSpecs(collected.tools);
  // 工具定义本身就是纯开销：超过窗口的一定比例就改成「按需检索加载」（对齐 Claude Code ToolSearch 阈值策略）。
  const eagerTokens = selection.specs.length ? estimateTokens(JSON.stringify(selection.specs)) : 0;
  // 角色级开关：仅 forceEagerTools=true 的角色（如 movie）跳过 deferred、强制全量注入；
  // 通用角色不设置该字段，完全跟随全局 TOOL_SEARCH_MODE=auto 的原有策略，逻辑不变。
  const roleForceEagerTools = conversation?.agentId ? getRole(conversation.agentId).forceEagerTools : undefined;
  const toolSearch = mcpEnabled && collected.tools.length > 0 && toolSearchEnabled(model, eagerTokens) && !roleForceEagerTools;
  // 角色级首轮强制工具调用：仅 forceToolCall=true 的角色（如 movie）首轮 tool_choice=required，逼模型先调工具；
  // 通用角色不设置该字段 → undefined → streamCall 内恒为 auto，行为不变。
  const roleForceToolCall = conversation?.agentId ? getRole(conversation.agentId).forceToolCall : undefined;
  // 角色级接地护栏：仅 enforceGrounding=true 的角色（如 movie）在「零工具数据」时不许收束（见 src/grounding.ts）；
  // 通用角色不设置该字段 → undefined → 不参与本护栏，行为不变。
  const roleEnforceGrounding = conversation?.agentId ? getRole(conversation.agentId).enforceGrounding : undefined;
  // 内置工具与本对话勾了哪些 MCP 无关，始终注入（见上方 mcpEnabled 注释）。
  const builtinSpecs = builtinToolSpecs({ toolSearch });
  const specs = [...builtinSpecs, ...(toolSearch ? [] : selection.specs)];
  // 接地护栏的第二路开启条件：**按工具动态判定**，而不是只认角色声明。
  // 本轮存在外部数据源工具（MCP 工具 / 联网检索 / 知识库检索）时，答案就应当接地于工具数据——
  // 否则「手上明明有取数工具、一次都没调就直接给事实结论」这条最典型的编造路径，
  // 对通用角色与客服角色完全没有拦截（最容易编数字的业务取数、BI 问答恰恰都在这一类）。
  // 只挂工作区工具（fs_* / write_todos 等）时不开启：那类轮次本就允许「没有合适工具时用自身知识作答」，
  // 开了会把写代码、翻译、创作也逼去凑证据——护栏拦的是「无证据的事实断言」，不是「没调工具」。
  // 注意用 `collected.tools`（本轮可用的全部 MCP 工具）而不是 `specs`：按需加载模式下 MCP schema 未注入，
  // 但模型仍可检索后调用，能力并未消失，不能因此放弃护栏。
  const enforceGrounding =
    roleEnforceGrounding === true ||
    hasExternalDataSource([...collected.tools.map((tool) => tool.name), ...builtinSpecs.map((spec) => spec.name)]);
  // 只要有工具就进工具循环。内置工具恒在 → 这里恒真；保留该判断是为了让语义显式：
  // 「零工具直连」只在真的没有任何工具可用时成立，而不是由「勾了几个连接器」间接决定。
  const useTools = specs.length > 0;
  const labels = new Map<string, string>();
  for (const server of [...collected.ready, ...collected.unavailable]) labels.set(server.id, server.label);
  // 联网检索通道状态：一次算好，既进系统提示（诚实上报），也进下面的通道日志。
  const webChannel = webSearchStatus();
  // 工具通道现状 → 进系统提示动态段：让模型知道「哪些域这次真的能查、哪些缺席、为什么缺席」。
  // 未勾任何外部服务器时也照实渲染（「MCP 工具 0 个，内置工具 N 个」），
  // 否则模型会把「没有外部数据源」当成「那个域没有数据」。
  const tooling: ToolingStatus | null = useTools
    ? {
        mcpToolCount: toolSearch ? 0 : selection.specs.length,
        totalMcpTools: collected.tools.length,
        builtinToolCount: builtinSpecs.length,
        ready: collected.ready,
        unavailable: collected.unavailable,
        dropped: toolSearch ? [] : selection.droppedServers.map((id) => labels.get(id) || id),
        limit: MCP_MAX_TOOLS,
        // 联网检索通道：可用性进系统提示，让模型在「不可用」时如实说明而不是凭记忆作答。
        web: webChannel,
        ...(toolSearch
          ? {
              deferred: true,
              searchToolName: TOOL_SEARCH_NAME,
              catalog: catalogOf(collected.tools, labels),
            }
          : {}),
      }
    : null;
  if (useTools) {
    // 工具通道一行日志：排查「模型说没有这个能力」时，先看这里（谁缺席、为什么）。
    console.log(
      `[chat:tools] mode=${toolSearch ? "search" : "eager"} ` +
        `mcp=${specs.length - builtinSpecs.length}/${collected.tools.length} builtin=${builtinSpecs.length} ` +
        `ready=${collected.ready.map((item) => `${item.id}(${item.tools})`).join(",") || "-"} ` +
        `unavailable=${collected.unavailable.map((item) => `${item.id}(${item.reason})`).join("|") || "-"} ` +
        `dropped=${toolSearch ? "-" : selection.droppedServers.join(",") || "-"} ` +
        `web=${webChannel.available ? webChannel.provider : "off"}`,
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
  // 已真正执行过的写/删类调用数（决定候选失败后能否换模型重跑，见下方候选循环）。
  let sideEffects = 0;
  let modelRetries = 0;
  let toolFusions = 0;
  let pseudoCallRetries = 0;
  let groundingRetries = 0;
  let groundingVerifications = 0;
  let ungrounded = false;
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
    // 聊天里随手贴的文档：解析为文本注入系统提示（本轮临时上下文，不污染持久历史）。
    const attachmentCtx = await buildAttachmentContext(opts.attachments);
    // 附件文本与任务级指引都属「本轮临时上下文」，拼进系统提示的**动态后缀**
    // （不污染稳定前缀、不影响 prompt cache；也都不进用户可见历史）。
    const dynamicExtras = [attachmentCtx, opts.taskGuide].filter(
      (part): part is string => Boolean(part && part.trim()),
    );
    const systemPrompt: SystemPrompt = dynamicExtras.length
      ? { ...system, dynamic: `${system.dynamic}\n\n${dynamicExtras.join("\n\n")}` }
      : system;
    // 模型不支持直读图片时不再加载图片（避免无用 base64），由前端给出明确提示。
    const images = opts.images?.length && m.vision === "direct" ? imagesOf(opts.images) : [];
    // 重 yield model 事件：前端据此更新当前模型标签，用户可感知已切换到备用模型。
    yield { type: "model", id: m.id, label: m.label };
    // 旁路 sink：循环内最后一次写入即实际服务模型（成功候选后 break），不受 buffer 裁剪影响。
    if (traceMeta) traceMeta.servedModel = m.id;
    usedWindow = m.contextWindow;

    let outcome: LoopOutcome | CallOutcome;
    if (useTools) {
      outcome = yield* runLoop(
        {
          conversationId,
          model: m,
          images,
          mcpTools: collected.tools,
          specs,
          toolSearch,
          loadedTools: new Set<string>(),
          signal,
          allowTask: true,
          allowWrite: true,
          grantServers: new Set(conversation?.readGrants || []),
          // 完全访问：缺省开箱即 true（conversation.fullAccess 未设置 = 完全授权）。
          fullAccess: conversation?.fullAccess ?? true,
          sessionId: opts.sessionId,
          // 调用方给了预算就用它（无人值守的定时任务比交互式宽），否则走全局默认。
          maxRounds: opts.maxRounds && opts.maxRounds > 0 ? Math.floor(opts.maxRounds) : MAX_TOOL_ROUNDS,
          ...(opts.forceWrapUp ? { forceWrapUp: true } : {}),
          namespace: conversation?.agentId || "generic",
          forceToolCall: roleForceToolCall,
          enforceGrounding,
          ownerKey: opts.ownerKey,
          system: systemPrompt,
        },
        turns,
      );
    } else {
      // 零工具直连路径：无 function tool → 模型无法调用任何工具、也没有联网检索
      // （联网能力由内置工具 web_search 提供）。内置工具恒注入，故正常路径不会走到这里；
      // 保留它是为了让「零工具」的语义有明确落点，而不是靠「没勾连接器」隐式发生。
      outcome = yield* streamCall(m, turns, images, [], signal, systemPrompt);
    }
    text = outcome.text;
    const loop = outcome as LoopOutcome;
    handles = loop.handles || [];
    clearedToolResults = loop.clearedToolResults || 0;
    offloadedToolResults = loop.offloadedToolResults || 0;
    rounds = loop.rounds || 0;
    toolCalls = loop.toolCallCount || 0;
    sideEffects = loop.sideEffects || 0;
    modelRetries = loop.modelRetries || 0;
    toolFusions = loop.toolFusions || 0;
    pseudoCallRetries = loop.pseudoCallRetries || 0;
    groundingRetries = loop.groundingRetries || 0;
    groundingVerifications = loop.groundingVerifications || 0;
    ungrounded = loop.ungrounded || false;
    costTokens = loop.spentTokens || 0;
    if (!outcome.failure) {
      // 成功必须清掉前序候选残留的 failure：否则第一个模型的 402 会阴魂不散地
      // 给成功结果拼上「⚠️ 生成中断」尾巴（实测 kimi26 402 → 后续候选成功仍带中断提示）。
      failure = null;
      break;
    }
    failure = outcome.failure;
    // 模型级失败一律切下一个候选（对齐 LiteLLM / OpenRouter 的 fallback 语义）：
    // 一个模型的 402 额度耗尽 / 400 参数问题都不代表其它模型不可用，只有候选用尽才按失败收束。
    // 原实现「永久错误不切模型」会让默认模型一死整条 auto 链跟着死（auto 形同虚设，
    // 实测 kimi26 额度耗尽 → 切到 kimi27hs 报 400 → 链直接断，后面 10 个注册模型根本没试）。
    // 安全护栏：**已真正执行过写/删类调用**时不再换模型重跑（避免重复副作用），直接按失败收束
    // （下方会保留已生成的中间结果）。
    // 只读调用不算——重跑只读工具没有副作用。原先用「有工具调用就 break」一刀切，会把
    // 「首轮取数成功、次轮模型额度耗尽」的请求挡在原始 402 面前：实测 movie 页就是这样
    // （调过 TMDb 只读工具后再调模型报 402，用户看到的是裸 402，而不是切换后的正常回答）。
    if (sideEffects > 0) break;
    modelFallbacks += 1;
    console.log(`[chat:fallback] model ${m.label} failed (${failure.slice(0, 200)}); trying next candidate`);
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
    groundingRetries,
    groundingVerifications,
    ungrounded,
    costTokens,
  };

  if (failure) {
    // 用户主动中断（点「停止」/ 关页面）：这一轮已经发生了，仍要写回上下文，
    // 否则下一轮模型看不到它，而界面上用户已经看到这段内容 —— 上下文与界面不一致。
    if (signal?.aborted) {
      // 正文为空（用户在任何正文产生前就点了「停止」）时，appendContext 会丢掉这条空的 assistant 轮：
      // 上游对空 assistant 消息直接 400，且确定性成立 → 该会话会永久卡死。只写 user 轮即可。
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

  // 角色身份护栏：兜底纠正模型把自身错认为底层大模型的自报（如「我是 Kimi」），
  // 确定性改写短自报句，长回答交提示词层处理（详见 src/role-guard.ts）。
  // 接地护栏兜底：纠正用尽仍未取得任何工具数据的角色，正文已被换成「受约束的诚实兜底」文本
  // （只允许说明职责边界 / 如实说没取到 / 请用户补充，禁止事实性断言）；该文本缺失时才回落确定性文案。
  // 宁如实说取不到，也不把可能凭记忆编造的内容展示给用户（详见 src/grounding.ts）。
  const roleLabelFinal = getRole(conversation?.agentId).label;
  const guarded = enforceRoleIdentity(text.trim(), roleLabelFinal);
  const finalText = ungrounded ? guarded || UNGROUNDED_REPLY : guarded;
  // 上下文写回该对话（thread）：单文档原子追加（$push + $inc）。
  await appendContext(conversationId, [
    { role: "user", text: userText },
    handles.length ? { role: "assistant", text: finalText, handles } : { role: "assistant", text: finalText },
  ]);
  yield { type: "text", text: finalText };
  yield usage;
  yield { type: "done" };
}
