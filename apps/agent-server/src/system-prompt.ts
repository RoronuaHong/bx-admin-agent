// 系统提示层（Deep Agents 的「详细系统提示」一块）。
// 拆成「稳定前缀」与「动态后缀」两段：
//   稳定段 = 角色与守则 + skills 索引 —— 跨轮不变，是 prompt caching 的命中对象；
//   动态段 = 长期记忆 / 历史摘要 / 回复语言 —— 变化频率低但非零，放后面避免破坏前缀缓存。
import type { TodoItem } from "@bx/shared";
import { renderMemory } from "./memory.js";
import { renderSkillIndex } from "./skills.js";

/**
 * 稳定前缀：改这里会影响缓存命中（改一次 = 全量缓存失效一次），保持精炼且通用，
 * 不写任何业务/客户相关的易变内容。
 */
const BASE_PROMPT = [
  "你是一个数据分析助手，通过工具查询真实数据并回答问题。",
  "",
  "工具使用守则：",
  "1. 只依据工具返回的真实数据作答；查不到、超时或出错时明确说明，不要编造数字。",
  "2. 工具结果很大时，先在回复里给出结论与关键数字，不要整段搬运原始数据。",
  "3. 引用数据时注明来自哪次工具调用（工具名 + 关键参数），便于核查与追问。",
  "4. 多步任务先拆解步骤再执行；已确认的结论不要重复查询。",
].join("\n");

/**
 * 工具模式专属守则：只在真的注入了工具时才说。
 * 直连模式（无工具）下提到具体工具名，会让模型去调用并不存在的工具。
 */
const TOOLING_RULES = "5. 需要把中间结果留给后续使用时，用 fs_write 存入工作区，之后用 fs_read 取回。";

/** 子代理系统提示：上下文隔离，只拿任务描述与最小工具集，回传摘要（对齐 Deep Agents Subagents）。 */
export const SUBAGENT_PROMPT = [
  "你是被主代理委派的执行子代理，只负责完成给定的单一任务。",
  "守则：",
  "1. 只依据工具返回的真实数据；查不到就如实说明。",
  "2. 过程中的中间结果不要复述，只保留得出结论所需的最小信息。",
  "3. 最终回复就是交给主代理的唯一交接物：给出结论与关键数字，控制在 400 字以内，不要贴原始数据。",
].join("\n");

/**
 * 工具通道现状：**勾选 ≠ 可用**。把「哪个服务器提供了工具 / 谁缺席 / 为什么缺席」明确告诉模型，
 * 避免它把「这次拿不到某个域的数据」当成「那个域没有数据」而编造或沉默。
 */
export interface ToolingStatus {
  /** 本次实际注入模型的 MCP 工具数 / 内置工具数（按需加载模式下前者为 0）。 */
  mcpToolCount: number;
  builtinToolCount: number;
  /** 成功提供工具的服务器。 */
  ready: Array<{ id: string; label: string; tools: number }>;
  /** 勾选但本次没提供工具的服务器（未配置 / 已禁用 / 连接失败 / 工具清单失败 / 无工具）。 */
  unavailable: Array<{ id: string; label: string; reason: string }>;
  /** 因单次工具数上限被裁掉的服务器（显示名）。 */
  dropped: string[];
  /** 单次工具数上限，仅用于文案。 */
  limit: number;
  /** 可用的 MCP 工具总数（按需加载模式下与 mcpToolCount 不同）。 */
  totalMcpTools?: number;
  /** 按需加载模式：MCP 工具 schema 未全量注入，需先用检索工具加载。 */
  deferred?: boolean;
  /** 检索工具名（按需加载模式的入口）。 */
  searchToolName?: string;
  /** 工具索引（仅名称，按服务器分组）。 */
  catalog?: Array<{ id: string; label: string; tools: string[] }>;
}

/** 工具索引（仅名称）最多列多少个：几千个工具时，索引本身也不能变成新的负担。 */
const TOOL_CATALOG_MAX_NAMES = Number(process.env.TOOL_CATALOG_MAX_NAMES || 200);

function renderCatalog(catalog: NonNullable<ToolingStatus["catalog"]>): string {
  const shown: string[] = [];
  const parts: string[] = [];
  let total = 0;
  for (const server of catalog) {
    total += server.tools.length;
    const room = TOOL_CATALOG_MAX_NAMES - shown.length;
    if (room <= 0) continue;
    const names = server.tools.slice(0, room);
    parts.push(`${server.label}：${names.join("、")}${names.length < server.tools.length ? "…" : ""}`);
    shown.push(...names);
  }
  const head = `- 可用工具索引（仅名称）：${parts.join("；")}。`;
  const tail =
    total > shown.length ? `\n- 索引只列了 ${shown.length}/${total} 个工具名，其余请直接用关键词检索。` : "";
  return head + tail;
}

function renderToolingStatus(status: ToolingStatus): string {
  const readyList = status.ready.map((server) => `${server.label}（${server.tools} 个）`).join("、");
  const lines = [
    "工具通道现状（用于判断你的能力边界；不要向用户复述服务器标识）：",
  ];
  if (status.deferred) {
    lines.push(
      `- 本次已注入内置工具 ${status.builtinToolCount} 个；可用的 MCP 工具共 ${status.totalMcpTools ?? 0} 个，` +
        `参数说明**未载入**上下文（见下方索引）。要调用某个 MCP 工具前，先调 ${status.searchToolName || "工具检索工具"}` +
        "按关键词加载它；未加载的工具直接调用会被拒绝。",
    );
  } else {
    lines.push(
      `- 本次已注入：MCP 工具 ${status.mcpToolCount} 个${readyList ? `（来自 ${readyList}）` : ""}，内置工具 ${status.builtinToolCount} 个。`,
    );
  }
  if (status.deferred && status.catalog?.length) lines.push(renderCatalog(status.catalog));
  if (status.unavailable.length) {
    lines.push(
      `- 勾选但当前不可用：${status.unavailable
        .map((server) => `${server.label}（${server.reason}）`)
        .join("、")}。这些能力域本次拿不到数据：用户问到时如实说明不可用，不要用别的域的数据推断或编造。`,
    );
  }
  if (status.dropped.length) {
    lines.push(
      `- 因单次工具数上限 ${status.limit} 未注入：${status.dropped.join("、")}。` +
        "若用户请求需要这些能力域，说明本次工具已超载，建议其在对话设置里收窄勾选的服务器后重试。",
    );
  }
  return lines.join("\n");
}

/** 任务计划状态标记（对齐 Claude Code TodoWrite 的进度可见性，避免 emoji 依赖）。 */
const TODO_MARKERS: Record<TodoItem["status"], string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
  cancelled: "[-]",
};

/**
 * 把跨轮持久化的任务计划渲染进系统提示动态后缀，使模型每轮都能看到当前步骤与进度
 * （对齐 Claude Code 每轮重注入 TodoWrite 的原则；之前只存库 + 发事件，下一轮上下文不回灌）。
 */
function renderTodos(todos: TodoItem[]): string {
  if (!todos.length) return "";
  const lines = todos.map((item) => `${TODO_MARKERS[item.status]} ${item.content}`);
  return "当前任务计划（由 write_todos 维护；推进进度时直接调 write_todos 更新，不要另起一份）：\n" + lines.join("\n");
}

export interface SystemPromptInput {
  /** 回复语言指令（对话级 locale）。 */
  locale?: string | null;
  /** 该对话更早部分的历史摘要（若有）。 */
  summary?: string | null;
  /** 是否注入长期记忆（子代理不注入，避免把主上下文带进隔离上下文）。 */
  withMemory?: boolean;
  /** 工具通道现状（仅在工具模式注入）。 */
  tooling?: ToolingStatus | null;
  /** 跨轮持久化的任务计划（write_todos 全量替换），每轮重注入保持进度可见。 */
  todos?: TodoItem[] | null;
}

const LOCALE_DIRECTIVES: Record<string, string> = {
  zh: "Respond in Simplified Chinese.",
  en: "Respond in English.",
  "pt-BR": "Respond in Brazilian Portuguese.",
  hi: "Respond in Hindi.",
};

function languageDirective(locale?: string | null): string {
  return LOCALE_DIRECTIVES[locale || ""] || "";
}

export interface SystemPrompt {
  /** 稳定前缀（跨轮不变 → prompt caching 命中对象）。 */
  stable: string;
  /** 动态后缀（记忆 / 摘要 / 语言）。 */
  dynamic: string;
}

export function buildSystemPrompt(input: SystemPromptInput = {}): SystemPrompt {
  const stableParts = [BASE_PROMPT, input.tooling ? TOOLING_RULES : "", renderSkillIndex()].filter(
    (part) => part && part.trim(),
  );
  const dynamicParts = [
    input.tooling ? renderToolingStatus(input.tooling) : "",
    input.withMemory === false ? "" : renderMemory(),
    input.summary ? `以下是该对话更早部分的摘要：\n${input.summary}` : "",
    renderTodos(input.todos || []),
    languageDirective(input.locale),
  ].filter((part) => part && part.trim());
  return {
    stable: stableParts.join("\n\n"),
    dynamic: dynamicParts.join("\n\n"),
  };
}
