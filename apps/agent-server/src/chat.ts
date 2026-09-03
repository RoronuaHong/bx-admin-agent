import type { ChatEvent, ChatFileRef, ChatTableView, ChatChartView } from "@bx/shared";
import { config, getModel, listModels, type ModelEntry } from "./config.js";
import { touchSession, getActiveProject, ensureDefaultProject } from "./session.js";
import { setCurrentProject } from "./project-context.js";
import type { Session } from "./session.js";
import type { PendingClarification } from "./session.js";
import { getUpload, MAX_AT_ONCE } from "./uploads.js";
import { callAgent, type AgentStep, type ModelTurn, type OptionImage, type ToolCall, type CallAgentOptions, type AgentToolDef } from "./models.js";
import { extractLocalPaths, extractUrls, fetchLink, resolveLocalDoc, type ContentNote } from "./sources.js";
import { listAgentTools, runAgentTool, resolveOperationByApiGrep, toolCatalogByDomain } from "./tools.js";
import { resolveWorkerById, workerToolNames } from "./worker-registry.js";
import { loadResidentRules, loadSkills } from "./skills.js";
import { transcribeImage } from "./vision.js";
import { getModel as legacyModel } from "./legacy.js";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { getRouterPolicy } from "./router-policy.js";
import { getClarificationPolicy } from "./clarification-policy.js";

import { resolveApiOperation, resolveApiOperationByPath, resolveApiOperationByPathSuffix } from "./api-operation-index.js";
import { guardCallApi, type CallApiGuardInput } from "./call-api-guard.js";
import { orchestrateBusinessQuery, renderDetailForAgent, renderListForAgent } from "./workflow-orchestrate.js";
import { execExportDataset } from "./export-tools.js";
import {
  parseUnderstoodIntent,
  SUBMIT_UNDERSTOOD_INTENT,
  type UnderstoodIntent,
} from "./understood-intent.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { truncateToolResultForUi, describeCallForReasoning } from "./ui-truncate.js";
import {
  extractListRowsFromContent,
  extractReportRows,
  presentGenericChart,
  synthesizeReplyFromToolResults,
} from "./report-pc-parity.js";

// ---- 工具分类（英文契约名，非业务词；全部从注册表派生，集中一处，杜绝散落清单漂移）----
// AGENT_TOOL_NAMES 从工具注册表动态生成（listAgentTools 是唯一事实来源），
// 新增工具自动纳入伪调用检测；分类集合用于业务判定/护栏/保留完整输出等策略，
// 未归类的新工具在启动时告警（防漏网），归类后自动生效。
const AGENT_TOOL_NAMES: string[] = listAgentTools().map((t) => t.name);
/** 方括号工具名形态 `[call_api]` / `[submit_understood_intent]`（模型把工具调用写成文本步骤的又一形态） */
const BRACKET_TOOL_RE = new RegExp(`\\[(?:${AGENT_TOOL_NAMES.join("|")})\\]`, "g");
/** 业务数据获取工具（服务端取数核心，唯一） */
const CALL_API_TOOL = "call_api";
/** 数据产出/收束类：结果需完整回喂模型（业务数据 + 渲染/导出/图表收束） */
const DATA_OUTPUT_TOOLS = new Set([
  CALL_API_TOOL,
  "normalize_output",
  "render_table",
  "summarize_chart_data",
  "export_dataset",
]);
/** 探索/定位类：返回候选/源码/列定义，非真实数据（业务取数护栏：须再 call_api 才算成功取数） */
const EXPLORE_TOOLS = new Set([
  "search_api_module",
  "read_api_module",
  "grep_codebase",
  "search_symbol",
  "get_list_columns",
  "get_page_schema",
  "read_file",
  "list_dir",
  "read_field_mapping",
  "search_knowledge_base",
  "fetch_url",
  "get_current_time",
]);
/** 代码写入/提交类（高危操作，无条件确认，由服务端单独走确认流程） */
const CODE_TOOLS = new Set(["write_code_file", "git_commit_push"]);
/** 提交/会话/澄清类（非业务数据动作） */
const META_TOOLS = new Set([
  "submit_understood_intent",
  "parse_intent",
  "set_project",
  "request_clarification",
]);
/** 业务工具 = 数据产出 + 探索定位（模型真做业务动作的判定集） */
const BUSINESS_TOOLS = new Set([...DATA_OUTPUT_TOOLS, ...EXPLORE_TOOLS]);
/** 启动自检：分类并集必须覆盖注册表全部工具，新增工具未归类时立即告警（防漏网） */
{
  const missing = AGENT_TOOL_NAMES.filter(
    (n) =>
      !DATA_OUTPUT_TOOLS.has(n) && !EXPLORE_TOOLS.has(n) && !META_TOOLS.has(n) && !CODE_TOOLS.has(n),
  );
  if (missing.length) {
    console.warn("[chat:tools] 注册了但未归类的新工具（请补分类）:", missing.join(", "));
  }
}

// ---- 长工具结果「写文件按需读」（对齐 Cursor 动态上下文发现）----
// 工具结果超过阈值时：完整内容写 .agent-context/tool-outputs/，steps 里只放「文件路径+摘要」。
// 模型需要细节时用 read_file 读该绝对路径（resolveLocalDoc 支持任意绝对路径）。
// 效果：上下文不膨胀（对标 Cursor token 降 46.9%），完整数据不丢可随时回查。
const TOOL_OUTPUTS_DIR = join(process.cwd(), ".agent-context", "tool-outputs");
// 4K 阈值：接口源码 read_api_module ≈ 5-15K、源码 read_file/grep 结果等探索类会触发写文件；
// 上下文只留「路径+600字摘要」，模型需要细节时 read_file 按需读回（对标 Cursor 动态上下文）。
const TOOL_OUTPUT_THRESHOLD = 4000;
// 数据类工具（结果要用于 normalize/render 展示）不写文件——模型必须看到完整数据才能
// 做字段对齐与表格渲染；写文件只针对「探索类」（源码/检索结果，模型可按需读回）。
// 教训：曾对所有工具统一写文件，call_api 数据只剩摘要 → 模型无数据可 normalize/render，
// 直接伪 tool_call 文本结束（不渲染表格）。
const TOOL_OUTPUT_KEEP_FULL = new Set([...DATA_OUTPUT_TOOLS, "get_page_schema", "submit_understood_intent", "parse_intent", "search_api_module", "read_api_module"]);
// read_file 读「接口定义文件」（路径含 /api/ 或 .ts 且不在 views/components/layouts 下）也保持完整：
// 模型靠它拿接口函数名/路径/参数，写文件只剩摘要会打断探索（实测「用户列表」读 account.ts 被写文件
// → 看不到 getList → grep/list_dir 空转 → 放弃未调 call_api）。
// 2026-08-24 方案 A 删除 persistRawToolOutput：列表/详情渲染后不再把原始数据落盘替换——
// 渲染后的中文 markdown 表格直接作为 toolResult 回喂模型做校验总结（对齐 Cursor 模型看数据），
// 不再写文件让模型按需 read_file 绕路。
function persistToolOutput(callName: string, content: string, input?: Record<string, unknown>): string | null {
  if (TOOL_OUTPUT_KEEP_FULL.has(callName)) return null;
  // read_file 读「接口定义文件」（路径含 /api/ 或 .ts 且不在 views/components/layouts 下）
  // 保持完整进 steps：模型靠接口定义拿函数名/路径/参数，写文件只剩摘要会打断探索。
  if (callName === "read_file") {
    const p = String(input?.path || "").replace(/\\/g, "/");
    const isApiDef = /\/api\//i.test(p) || (/\.ts$/.test(p) && !/\/views\/|\/components\/|\/layouts\//i.test(p));
    if (isApiDef) return null;
  }
  if (content.length <= TOOL_OUTPUT_THRESHOLD) return null;
  try {
    mkdirSync(TOOL_OUTPUTS_DIR, { recursive: true });
    const file = join(TOOL_OUTPUTS_DIR, `${randomUUID()}.txt`);
    writeFileSync(file, content, "utf-8");
    // 摘要：去掉结构标记后取前 600 字符（保留关键数据行）
    let summary = content
      .replace(/^UI_TABLE\n[^\n]+\n\n?/, "")
      .replace(/^UI_FILE\n[^\n]+\n\n?/, "")
      .replace(/^【(?:表格输出|图表摘要)[^\n]*\n?/, "")
      .trim();
    summary = summary.replace(/\s+/g, " ").trim();
    if (summary.length > 600) summary = `${summary.slice(0, 600)}…`;
    return `（结果较长，已存至本地文件，用 read_file 读取该路径可看完整内容：${file}；摘要：${summary}）`;
  } catch (err) {
    console.error("[tool-output] 写入失败:", err);
    return null;
  }
}

// ---- steps 只读投影压缩（Claude Code Micro-compact 同款）----
// understand 注入模型前，将「旧轮次工具结果」替换为占位符：模型只看到
// 最近 keepRecentRounds 轮完整结果 + 白名单数据类最近一次完整内容 + 全部
// assistant 推理轨迹（toolCalls/system）。state.steps 保持完整（只读投影，
// 返回时用未压缩 steps 写回图状态），仅「模型看到的视图」变小。
// 不删消息（OpenAI 消息配对约束：toolResult 必须对应 assistant toolCalls）。
// 零额外模型调用（免费链下摘要方案每次 4.7s+ 净增延迟，明确排除）。
// 经验值 KEEP=3 来自 Claude Code（太少模型忘事，太多浪费 token）。
const STEPS_KEEP_RECENT_ROUNDS = 3;
// 注入模型 steps 总字符预算（≈15K token）。压缩后仍超限则保留窗口逐级回退 3→2→1，
// 保证注入量有硬上限（杜绝极端大结果顶满上下文）。
const STEPS_CHAR_BUDGET = 60000;
// 数据类白名单：final 收束必需完整数据（call_api 结果 / normalize_output / render_table），
// 压缩时保留「最近一次」完整内容——防「模型无数据可 render 伪 tool_call」教训重演（见上方
// TOOL_OUTPUT_KEEP_FULL 注释）。从 DATA_OUTPUT_TOOLS 取「表格数据产出」子集，避免清单漂移。
const STEPS_KEEP_FULL = new Set([CALL_API_TOOL, "normalize_output", "render_table"]);

/** 估算 steps 注入模型的字符量（≈ token 数 × 4）。 */
export function estimateStepsChars(steps: AgentStep[]): number {
  let total = 0;
  for (const s of steps) {
    if (s.kind === "toolResult") total += s.content.length;
    else if (s.kind === "system") total += s.text.length;
    else total += JSON.stringify(s.calls).length;
  }
  return total;
}

/** 只读投影压缩：注入模型前将旧轮次工具结果替换为占位符。state.steps 不动，零模型调用。 */
export function compactStepsForModel(
  steps: AgentStep[],
  opts: { keepRecentRounds?: number; charBudget?: number } = {},
): AgentStep[] {
  const keepRecentRounds = opts.keepRecentRounds ?? STEPS_KEEP_RECENT_ROUNDS;
  const charBudget = opts.charBudget ?? STEPS_CHAR_BUDGET;
  // 预算兜底：压缩后仍超阈值 → 逐轮缩减保留窗口（3→2→1），注入量硬上限
  let rounds = keepRecentRounds;
  let out = compactWithWindow(steps, rounds);
  while (estimateStepsChars(out) > charBudget && rounds > 1) {
    rounds -= 1;
    out = compactWithWindow(steps, rounds);
  }
  return out;
}

/** 按保留窗口重建压缩视图：system/toolCalls 全保留；窗口内与白名单最近一次 toolResult 完整；其余替换占位符。 */
function compactWithWindow(steps: AgentStep[], keepRecentRounds: number): AgentStep[] {
  // 1) toolCallId → toolName 索引（从 toolCalls 步骤的 calls 数组反查，供占位符标注工具名）
  const nameById = new Map<string, string>();
  for (const s of steps) {
    if (s.kind === "toolCalls") {
      for (const c of s.calls) nameById.set(c.id, c.name);
    }
  }
  // 2) 从后往前定位「最近 keepRecentRounds 轮内的 toolResult」+「白名单最近一次」
  //    轮次按 toolCalls 步骤计数：遇到 toolResult 时其所属轮 = 已数到的 toolCalls 数 + 1
  let roundsSeen = 0;
  let lastKeepFullId: string | null = null;
  const keepIds = new Set<string>();
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.kind === "toolCalls") {
      roundsSeen += 1;
      continue;
    }
    if (s.kind !== "toolResult") continue;
    const name = nameById.get(s.toolCallId);
    // 白名单：从后往前第一个（即最近一次）数据类调用，无条件保留完整
    if (name && STEPS_KEEP_FULL.has(name) && lastKeepFullId === null) lastKeepFullId = s.toolCallId;
    const roundNo = roundsSeen + 1;
    if (roundNo <= keepRecentRounds || s.toolCallId === lastKeepFullId) keepIds.add(s.toolCallId);
  }
  // 3) 重建：替换占位符但不删消息（消息配对约束）
  return steps.map((s) => {
    if (s.kind !== "toolResult" || keepIds.has(s.toolCallId)) return s;
    const name = nameById.get(s.toolCallId);
    return { kind: "toolResult" as const, toolCallId: s.toolCallId, content: `[Previous: used ${name || "tool"}]` };
  });
}

// 阶段2 薄提示：自动渲染失败/字段未中文化时交模型按 pc-column-mapping 技能补中文映射。
// 统一模板替代散落的 output-align 长文案（对齐「工具返回→输出」只留薄 prompt 的分层规范，
// 见 docs/agent/PROMPT_ARCHITECTURE.md §3）。
function outputAlignStep(issue: string, moduleHint?: string): AgentStep {
  return {
    kind: "system",
    text:
      `[workflow/output-align] ${issue}` +
      (moduleHint ? ` module="${moduleHint}"。` : "") +
      "请按 pc-column-mapping 技能到当前项目源码找中文映射后用 render_table 输出（columns.title 传中文表头、枚举值翻译后传中文值，key 保持英文 dataIndex）；" +
      "禁止直接透传原始英文字段名或数字枚举。",
  };
}

// 编排：识别内容源 → 注入 skill/superpower 上下文 → LLM 自主调 tools/MCP → 规则门后再落地 → SSE。
// 主路径：大模型先整理（tools + skill + MCP 检索），整理好后 call_api 才过规则（parse_intent / 写确认 / normalize）。

// 写操作确认等待器：key = `${sessionId}:${callId}`，value = resolve 函数
const confirmWaiterRegistry = new Map<string, (confirmed: boolean) => void>();

export function registerConfirmWaiter(sessionId: string, callId: string, resolve: (confirmed: boolean) => void) {
  confirmWaiterRegistry.set(`${sessionId}:${callId}`, resolve);
}

export function resolveConfirmWaiter(sessionId: string, callId: string, confirmed: boolean): boolean {
  const key = `${sessionId}:${callId}`;
  const resolve = confirmWaiterRegistry.get(key);
  if (!resolve) return false;
  confirmWaiterRegistry.delete(key);
  resolve(confirmed);
  return true;
}

// ---- 历史上下文压缩（对齐 Cursor /summarize + Claude Code /compact 分层）----
// Cursor：长对话超阈值后 LLM 有损摘要替换旧历史（UI 保留完整记录，模型只见压缩后 token）；
// Claude Code：先 prune（无损清理旧输出）→ 仍不足才 LLM 摘要。
// 本项目免费链摘要调用有延迟成本，故分层：① 低损 prune（表格折叠/超长截断，零模型调用）
// → ② 仍超预算才 LLM 摘要（一次调用，结果缓存到 session.historyCompact 跨轮复用）。
// session.messages 本体不动（只读投影），对齐 Cursor「用户可见历史 ≠ 模型实际 token」。
// 换模型后只需调整 HISTORY_* 预算或 MODEL_<ID>_CONTEXT，机制本身与具体模型解耦。
const MAX_HISTORY_TURNS = Number(process.env.HISTORY_MAX_TURNS || 8); // 历史注入轮数上限
const HISTORY_CHAR_BUDGET = Number(process.env.HISTORY_CHAR_BUDGET || 24000); // 历史注入字符预算（≈6K token）
const HISTORY_AUTO_COMPACT = (process.env.HISTORY_AUTO_COMPACT || "on") !== "off"; // LLM 摘要开关
const HISTORY_TABLE_MAX_ROWS = 12; // markdown 表格超过该行数折叠为占位（数据可重新查询）
const HISTORY_MSG_CHAR_CAP = 3000; // 单条历史消息超该长度才截断
const HISTORY_MSG_KEEP_HEAD = 500; // 截断时保留头部字符
const HISTORY_MSG_KEEP_TAIL = 300; // 截断时保留尾部字符
const HISTORY_SUMMARY_INPUT_CHARS = 12000; // 摘要输入截断（避免摘要调用本身超大）
const HISTORY_SUMMARY_MAX_CHARS = 800; // 摘要文本上限
const HISTORY_KEEP_RECENT_TURNS = 3; // LLM 摘要时保留最近 N 轮完整（对齐 Cursor 保留近期）
const MAX_TOOL_ROUNDS = getRouterPolicy().runtimeHints.maxToolRounds;
const MAX_CLARIFICATION_TURNS = getClarificationPolicy().maxClarificationTurnsPerIntent;

// 内容长度超过该阈值时，auto 模式优先选上下文更大的模型。
const AUTO_LONG_TEXT_CHARS = 4000;

// auto 模式自动选模型（Cursor 模型路由的轻量版）：
// 图片 → 视觉模型（direct 优先）；写操作/复杂统计 → strongModels（配置于 router-policy.autoModel）；
// 长内容 → 上下文最大的模型；简单列表/详情 → fastModels 或默认模型。
function pickAutoModel(hasImages: boolean, textLength: number): ModelEntry | null {
  const models = hasImages
    ? listModels().filter((m) => m.vision === "direct" || m.vision === "ocr")
    : listModels();
  if (models.length && hasImages) {
    return models.find((m) => m.vision === "direct") || models[0];
  }
  if (!models.length) return legacyModel();
  const autoModel = getRouterPolicy().autoModel;
  // 跳过本次进程内已标记额度耗尽的模型（避免重复命中已 402 的 fast 首位）
  const fast = (autoModel?.fastModels || []).filter((id) => models.some((m) => m.id === id) && !exhaustedModels.has(id));
  // 模型选择（2026-08-24 去写死）：不再用中文业务词预判「复杂统计/写操作」走强模型
  // （统计/报表/图表等属写死业务词，违反红线）——统一走 fast/默认模型，弱模型由后续
  // 条件边重试护栏兜底，避免服务端写死词表抢路由。
  if (textLength > AUTO_LONG_TEXT_CHARS && models.length > 1) {
    const biggest = [...models].sort((a, b) => b.contextChars - a.contextChars)[0];
    if (biggest && biggest.contextChars > models[0].contextChars) return biggest;
  }
  // 简单请求 → 快模型（fastModels 第一）或默认模型
  if (fast.length) return models.find((m) => m.id === fast[0])!;
  return models[0];
}

// ---- 历史压缩实现（对齐 Cursor：分层 prune → LLM 摘要；只读投影，不动 session.messages 本体）----
function estimateTurnsChars(turns: ModelTurn[]): number {
  return turns.reduce((n, t) => n + t.content.length, 0);
}

/**
 * 组装静态引导前缀（对齐 Cursor「静态 prompt 重度缓存」）：
 * 角色/工具调用协议/项目上下文/常驻底线/技能目录/闲聊边界 拼接为 system 首条消息。
 * preprocess 节点与「模型级门槛轻量路径」共用——同一请求多轮循环中前缀一致，
 * OpenAI 兼容端点可命中 prompt cache。不注入任何业务词/功能词判定（语义 100% 交模型）。
 */
export function buildStaticGuide(session: Session): string {
  const parts: string[] = [];
  parts.push(
    "[workflow/agent] 你是影视后台管理系统的智能助手。需要业务数据时调用可用工具（工具自带完整使用规范）：" +
      "业务请求第一步调用 submit_understood_intent 提交理解，再按需 search_api_module / read_api_module 定位接口并 call_api；" +
      "可多轮调用工具直至拿到数据；取到数据后组织自然语言总结，始终用中文回复，不向用户复述内部工具调用过程。\n" +
      "[workflow/tool-calling]（对齐 Cursor agent，最高优先级）：\n" +
      "1. 所有工具调用必须通过函数调用通道（tool_calls）发起；禁止以任何文本形式模拟工具调用" +
      "（JSON/XML/方括号/自然语言描述），此类输出一律无效，会被系统丢弃；\n" +
      "2. 回复用户时禁止提及工具名，只说明做了什么、拿到什么；需要数据就真正调用工具，" +
      "不要用文本描述打算调用的工具；连续多次文本模拟会被视为无效并转入自动执行；\n" +
      "3. 业务与闲聊的判定完全由你决定：涉及任何业务数据（查询/列表/详情/统计/报表/导出或任何数据操作）" +
      "就必须调用工具获取真实数据后回答；仅当纯问候/寒暄/闲聊才直接回复，无需调用工具。\n" +
      "4. 当请求目标/关键用词语义模糊、无法确定唯一业务含义，或缺少必要操作对象时，用 request_clarification 反问用户确认后再执行，" +
      "禁止硬猜取数；已明确的请求直接执行，可选筛选条件缺失时用默认参数，不反问。\n" +
      "5. 取到数据后、总结前必须先核对「数据语义是否对应用户问题」：返回记录的业务对象类别是否与用户请求一致。" +
      "若发现取错模块或数据对象不符，禁止硬收束——用 search_api_module 重新定位正确模块后再 call_api 取数。",
  );

  const currentProject = getActiveProject(session.id);
  if (currentProject) {
    parts.push(
      `[workflow/intent-context] 当前会话全局项目：${currentProject.label}（key=${currentProject.key}），默认在此项目范围内执行，无需再问。`,
    );
  }
  // 常驻底线（alwaysApply）合并为 1 个 [workflow/rules] step（对齐 Cursor rules 块注入）：
  // 原 7 条精简为 5 条——删「PC 日志对齐」「展示前 normalize_output」两条纯重复（已下沉服务端机制），
  // 「先检索再调用」并入「禁止编造」；2026-08-25 对齐 Cursor 反问语义：去掉「查询一律不反问可选条件」的写死压制，
  // 改为「目标/词义不明先反问」+「已明确请求直接执行、可选筛选条件缺失用默认参数」；
  // 逐条一个 system step 会稀释遵循度并多耗 token，合并后更清晰。
  const residentRules = loadResidentRules();
  if (residentRules.length) {
    parts.push(
      "[workflow/rules] 常驻底线（alwaysApply，优先级最高，不得被模型或技能覆盖）：\n" +
        residentRules.map((r) => `- ${r.body}`).join("\n"),
    );
  }
  // Skills 按需加载（对齐 Cursor Skills 语义）：不再由服务端关键词硬匹配注入，
  // 而是把可用技能的 name + description 列表交给模型，由模型自主判断相关性后加载正文。
  const availableSkills = loadSkills().filter((s) => !s.disabledInvocation);
  if (availableSkills.length) {
    // 预算护栏（对齐 Claude 官方 Layer1 预算：上下文 2%，回退 16000 字符）：
    // 技能清单超出预算时优先保留靠前技能，超出部分不列出（技能正文仍可在模型显式加载）。
    const SKILL_CATALOG_BUDGET = 16000;
    const skillLines: string[] = [];
    let catalogUsed = 0;
    for (const s of availableSkills) {
      const line = `- ${s.name}：${s.description}`;
      if (catalogUsed + line.length > SKILL_CATALOG_BUDGET && skillLines.length) {
        skillLines.push(
          `- …（另有 ${availableSkills.length - skillLines.length} 个技能因超出上下文预算未列出，如需使用请说明技能名）`,
        );
        break;
      }
      skillLines.push(line);
      catalogUsed += line.length;
    }
    parts.push(
      "[workflow/skills] 以下是可用技能清单（name + 用途描述）。请基于用户意图自主判断是否加载相关技能正文：" +
        "若某技能与本次请求相关，先说明「加载技能 <name>」，再按其指南执行；无关技能不要加载。\n" +
        skillLines.join("\n"),
    );
  }
  // 参数契约引导（2026-08-26，对齐 Cursor「模型按接口契约控制参数」）：
  // 事故复盘：「人群包配置，第二页」模型凭习惯传 page/pageNum/pageSize，而该接口真实分页参数是 page+size，
  // 导致接口返回全量、两次调用同一份 22 条被无去重合并成 44 行、模型误判「不分页」。
  // 全部为通用契约语义（分页参数名/表格 hook 名/相对量词均跨系统通用），零业务词写死。
  parts.push(
    "[workflow/param-contract]（对齐 Cursor「模型按接口契约控制参数」，通用契约，非业务词）：\n" +
      "1. 不同接口的分页/筛选参数名各不相同（常见 page+size、pageNum+pageSize、page+pageSize、limit+offset 等），" +
      "调用 call_api 前必须用 read_api_module 读接口源码，或用 read_file 读前端页面表格配置确认真实参数名与必填项，" +
      "禁止凭习惯臆造参数名；\n" +
      "1b. read_api_module 返回的「分页参数契约」是权威来源（它来自页面表格真实配置），调用 call_api 时" +
      "优先采用契约给出的参数名，不要被此处默认值覆盖；仅当 read_api_module 未返回契约且页面未显式传" +
      "fetchSetting 时，才用标准表格 hook 默认分页参数（pageField=page、sizeField=size，即 page+size），" +
      "勿因页面无显式声明而反复搜索、陷入探索，直接按默认调用；\n" +
      "2. 用户口语中的相对量词（第二页/前N页/今天/本周等）须自行换算为接口要求的参数值后传入，禁止丢弃；\n" +
      "3. 接口返回中的 total/总条数用于计算总页数并回答「有几页」；若接口未按分页参数生效（返回全量），" +
      "如实说明接口行为，不编造页数。",
  );
  // 闲聊/KB 边界（仅作模型输入提示，不抢路由；业务 vs 闲聊判定见 tool-calling 第 3 条，此处不重复）：
  // 只补充知识库文档类问题的检索引导 + 输出纪律 + 中文输入兜底提示。模型自主判别，服务端不预分类。
  parts.push(
    "[workflow/chit-chat] 若用户询问公司内部规范、制度、流程、报销、考勤、部署等**知识库文档类**问题，" +
      "可调用 search_knowledge_base 检索本地知识库后基于检索结果回答（仅此一个工具可用）。" +
      "回答必须是普通文本：禁止输出 JSON、禁止输出工具调用描述，一段话说清即收束。" +
      "注意：中文输入默认视为有效请求（可能含业务/知识库/闲聊意图），不要当作乱码或测试内容。",
  );

  // M0（工具领域分组）：注入按领域分组的工具目录，让模型看清工具归属（不裁掉任何工具；按请求裁剪由 M1 路由层负责）。
  parts.push(toolCatalogByDomain());

  return parts.join("\n\n");
}

/** 低损 prune：长 markdown 表格折叠 + 超长消息保头尾截断。零模型调用。 */
function pruneHistoryTurns(turns: ModelTurn[]): ModelTurn[] {
  return turns.map((t) => {
    let c = t.content;
    // ① 长 markdown 表格折叠为占位（表格数据来自接口，可重新查询，属低损）
    const TABLE_BLOCK = /((?:\n\|[^\n]*\|[^\n]*)+)/g;
    c = c.replace(TABLE_BLOCK, (block) => {
      const rowCount = block.split("\n").filter((l) => l.trim().startsWith("|")).length;
      return rowCount > HISTORY_TABLE_MAX_ROWS ? `\n（数据表格 ${rowCount - 1} 行已折叠，如需细节可重新查询）\n` : block;
    });
    // ② 单条仍超阈值 → 保头尾截断（保留关键上下文与结论）
    if (c.length > HISTORY_MSG_CHAR_CAP) {
      c =
        c.slice(0, HISTORY_MSG_KEEP_HEAD) +
        `\n…（本条消息过长，中间 ${Math.max(0, c.length - HISTORY_MSG_KEEP_HEAD - HISTORY_MSG_KEEP_TAIL)} 字已省略）…\n` +
        c.slice(-HISTORY_MSG_KEEP_TAIL);
    }
    return { role: t.role, content: c };
  });
}

/** LLM 摘要（对齐 Cursor /summarize）：把历史压缩成要点，一次模型调用，失败时上层回退低损裁剪。 */
async function summarizeHistory(model: ModelEntry, turns: ModelTurn[], signal?: AbortSignal): Promise<string> {
  const input = turns
    .map((t) => `${t.role === "user" ? "用户" : "助手"}：${t.content}`)
    .join("\n\n")
    .slice(-HISTORY_SUMMARY_INPUT_CHARS);
  const result = await callAgentSafe(
    model,
    [
      { role: "user", content: "你是对话历史压缩助手。请把用户与助手的对话压缩成简洁中文摘要。" },
      {
        role: "user",
        content:
          "压缩要求：只保留对后续对话有用的信息——①当前任务目标与进展；②已确认的模块、接口或操作；" +
          "③已获取的数据规模（条数/页数）与关键结论；④未解决的问题、用户明确偏好或约束。" +
          "禁止编造历史中不存在的信息；用 200 字以内纯文本要点输出，不要任何格式标记。\n\n以下是对话历史：\n\n" +
          input,
      },
    ],
    [],
    [],
    [],
    signal,
    {},
  );
  const text = (result.text || "").trim();
  return text ? text.slice(0, HISTORY_SUMMARY_MAX_CHARS) : "";
}

/**
 * 组装模型可见 turns（对齐 Cursor）：
 * - 已有摘要 → 前置 [history/summary] 块 + 摘要点之后的新消息（增量追加，不重复摘要）
 * - 无摘要且历史超预算 → 低损 prune；仍超且开启摘要 → LLM 摘要（保留最近几轮完整）
 * session.messages 本体保持完整（持久化/UI 不变），仅「模型看到的视图」被压缩。
 */
async function buildModelTurns(
  session: Session,
  humanText: string,
  model: ModelEntry,
  signal?: AbortSignal,
): Promise<ModelTurn[]> {
  const total = session.messages.length;
  const covered = session.historyCompact?.coveredIndex ?? 0;
  const freshStart = Math.max(covered, total - 1 - MAX_HISTORY_TURNS);
  const fresh = session.messages.slice(freshStart, -1);
  const historyTurns: ModelTurn[] = fresh.map((t) => ({ role: t.role, content: t.text }));
  const before = estimateTurnsChars(historyTurns);

  const summaryPrefix: ModelTurn[] = session.historyCompact?.summary
    ? [
        {
          role: "user",
          content: `[history/summary] 以下为较早对话的压缩摘要（如需细节可重新查询）：\n${session.historyCompact.summary}`,
        },
      ]
    : [];

  if (before <= HISTORY_CHAR_BUDGET) {
    console.log(`[chat:history] mode=full turns=${historyTurns.length} chars=${before} budget=${HISTORY_CHAR_BUDGET}`);
    return [...summaryPrefix, ...historyTurns, { role: "user", content: humanText }];
  }

  const pruned = pruneHistoryTurns(historyTurns);
  const afterPrune = estimateTurnsChars(pruned);
  if (afterPrune <= HISTORY_CHAR_BUDGET) {
    console.log(
      `[chat:history] mode=prune turns=${historyTurns.length} chars=${before}→${afterPrune} budget=${HISTORY_CHAR_BUDGET}`,
    );
    return [...summaryPrefix, ...pruned, { role: "user", content: humanText }];
  }

  if (HISTORY_AUTO_COMPACT && !session.historyCompact?.summary) {
    try {
      const summary = await summarizeHistory(model, historyTurns, signal);
      if (summary) {
        const keepStart = Math.max(freshStart, total - 1 - HISTORY_KEEP_RECENT_TURNS);
        const kept = pruneHistoryTurns(historyTurns.slice(keepStart - freshStart));
        session.historyCompact = { summary, coveredIndex: keepStart, at: Date.now() };
        touchSession(session);
        console.log(
          `[chat:history] mode=summary turns=${historyTurns.length} chars=${before}→${estimateTurnsChars(kept)} + 摘要${summary.length}字 coveredIndex=${keepStart}`,
        );
        return [
          {
            role: "user",
            content: `[history/summary] 以下为较早对话的压缩摘要（如需细节可重新查询）：\n${summary}`,
          },
          ...kept,
          { role: "user", content: humanText },
        ];
      }
    } catch (err) {
      console.error("[chat:history] LLM 摘要失败，回退低损裁剪:", err instanceof Error ? err.message : String(err));
    }
  }

  console.log(
    `[chat:history] mode=prune(fallback) turns=${historyTurns.length} chars=${before}→${afterPrune} budget=${HISTORY_CHAR_BUDGET}`,
  );
  return [...summaryPrefix, ...pruned, { role: "user", content: humanText }];
}

function parseClarificationPayload(raw: string): Omit<PendingClarification, "id" | "createdAt" | "turns"> | null {
  if (!raw.startsWith("CLARIFICATION_REQUIRED")) return null;
  const json = raw.replace(/^CLARIFICATION_REQUIRED\s*/, "").trim();
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const options = Array.isArray(parsed.options) ? parsed.options : [];
    const normalized = options
      .map((x) => (x && typeof x === "object" ? x as Record<string, unknown> : null))
      .filter(Boolean)
      .map((x) => ({ label: String(x!.label || ""), value: String(x!.value || "") }))
      .filter((x) => x.label);
    return {
      intent: String(parsed.intent || "调用业务接口"),
      question: String(parsed.question || ""),
      missingSlots: Array.isArray(parsed.missingSlots) ? parsed.missingSlots.map((x) => String(x)) : [],
      options: normalized,
      riskLevel: String(parsed.riskLevel || "read") === "write" ? "write" : "read",
      resumeTool: CALL_API_TOOL,
      resumeInput: (parsed.resumeInput && typeof parsed.resumeInput === "object")
        ? parsed.resumeInput as Record<string, unknown>
        : {},
    };
  } catch {
    return null;
  }
}

// 槽位 → 自然语言提示词映射
const SLOT_LABELS: Record<string, string> = {
  project: "项目",
  module: "模块",
  value: "操作对象",
  operation: "操作",
  "module.operation": "模块/操作",
  "operation_or_path_or_url": "模块",
};

function renderClarificationForUser(raw: string): string {
  const parsed = parseClarificationPayload(raw);
  if (!parsed) return "请补充信息后重试。";

  // 缺失槽位的自然语言描述
  const missingLabel = parsed.missingSlots
    .map((s) => SLOT_LABELS[s] || s)
    .join("、");

  // 选项列表（有 label 即展示；value 可为空表示“请用户自由输入”）
  const hasRealOptions = parsed.options.some((o) => o.label);
  const optionLines = hasRealOptions
    ? parsed.options
        .filter((o) => o.label)
        .map((o, i) => `  ${i + 1}. ${o.label}`)
        .join("\n")
    : "";

  const lines: string[] = [];
  lines.push(`需要确认【${missingLabel}】，${parsed.question}`);
  if (optionLines) {
    lines.push(optionLines);
    lines.push("请回复序号，或直接描述你的需求。");
  } else {
    lines.push("请直接描述你要操作的内容。");
  }
  return lines.join("\n");
}

function pickClarificationOption(pending: PendingClarification, userText: string): { value: string; label: string } | null {
  const txt = userText.trim();
  if (!txt) return null;
  const num = Number(txt);
  if (!Number.isNaN(num) && Number.isInteger(num) && num >= 1 && num <= pending.options.length) {
    const hit = pending.options[num - 1];
    return { value: hit.value, label: hit.label };
  }
  const lowered = txt.toLowerCase();
  const byValue = pending.options.find((o) => o.value.toLowerCase() === lowered);
  if (byValue) return { value: byValue.value, label: byValue.label };
  const byLabel = pending.options.find((o) => o.label.includes(txt));
  if (byLabel) return { value: byLabel.value, label: byLabel.label };
  return null;
}

// 网关瞬时错误偶发兜底：最多重试 2 次（含 429 限流退避）。
// 覆盖 TokenHub 504001 网关超时 / 503 服务暂不可用（过载、健康检查、限流，body 常为空）
// / 429 限流（zen 免费链 FreeUsageLimitError 按窗口重置，退避 3s×attempt 后可恢复）。
// 流式已大幅降低概率，此处仅防偶发网关抖动直接炸掉整轮。
const MODEL_GATEWAY_RETRIES = 2;

// ---- 模型额度耗尽标记（2026-08-24 起不再降级）----
// TokenHub 免费体验额度逐模型耗尽（已实测 dsflash/dspro/hy3 402/401008）。
// 2026-08-24 决策：模型调用异常一律直接抛出错误信息（前端提示用户处理/换模型），**不再降级重试**——
// 免费备选链本身不稳（zen 免费链慢且误识别），静默降级会把「模型故障」包装成「自动修复」，误导排查。
// 这里仅保留「标记耗尽 30min」：auto 模式选模型时跳过已耗尽模型（避免每次 auto 都选中 402 模型白撞）。
const exhaustedModels = new Map<string, number>();
// TokenHub 免费额度耗尽是持续性状态（非 5 分钟自愈），TTL 30 分钟；过期惰性解封，期间 auto 选模型跳过。
const EXHAUSTED_TTL_MS = 30 * 60 * 1000;
function markModelExhausted(id: string) {
  const now = Date.now();
  for (const [k, ts] of exhaustedModels) if (now - ts > EXHAUSTED_TTL_MS) exhaustedModels.delete(k);
  exhaustedModels.set(id, now);
}
/** 是否「永久额度耗尽」（区别于 429 限流）：仅 402/401008/quota/exhausted/额度/后付费。
 *  永久耗尽才 markModelExhausted 封禁 30min；限流不封禁（换模型后可能恢复）。 */
function isHardQuotaErrorMsg(msg: string): boolean {
  return /401008|"code"\s*:\s*402|quota|exhausted|额度|后付费|postpaid/i.test(msg);
}
async function callAgentSafe(
  model: ModelEntry,
  turns: ModelTurn[],
  images: OptionImage[],
  tools: AgentToolDef[],
  steps: AgentStep[],
  signal: AbortSignal | undefined,
  opts: CallAgentOptions,
  onDelta?: (chunk: string) => void,
): Promise<Awaited<ReturnType<typeof callAgent>>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MODEL_GATEWAY_RETRIES; attempt++) {
    try {
      return await callAgent(model, turns, images, tools, steps, signal, opts, onDelta);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 瞬时错误才重试：504001/504（上游超时）、503（服务暂不可用）、429（限流，
      // 如 zen 免费链 FreeUsageLimitError 按窗口重置，退避后可恢复）均属此类；
      // 402/401008（永久额度耗尽）等业务性错误不重试，直接抛出走友好提示。
      const isTransientGateway = /504001|gateway_error|model http 50[34][:\s]|model http 429|rate.?limit|FreeUsageLimit/i.test(msg);
      if (!isTransientGateway || attempt >= MODEL_GATEWAY_RETRIES) throw err;
      lastErr = err;
      console.log(`[chat:model] 瞬时错误重试 ${attempt + 1}/${MODEL_GATEWAY_RETRIES}（退避 ${3000 * (attempt + 1)}ms）: ${msg.slice(0, 180)}`);
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * 判断用户输入是「对旧澄清的回复」还是「新请求」（2026-08-25 收窄为纯协议判定）：
 * 此前含中文业务词（推荐片段/时间标签/用户等）与功能词（查询/查看/列表等）正则预判，
 * 违反「全部由大模型判断」红线（语义判定应交给模型，服务端不写死业务词/功能词）。
 * 现在只识别强结构信号：
 *  - 纯序号 / 纯候选值（1、<模块>/<接口模块>、xxx）→ 澄清回复
 *  - 简短明确选择短语（是/否/好的/确认/取消）→ 澄清回复
 *  - 其余一律按「新请求」处理（宁可交给主流程/模型判断，不让旧澄清劫持新任务）。
 * 语义歧义（用户新输入恰好类似选择短语）由模型在主流程上下文判断，服务端不做词形预判。
 */
function isLikelyFreshRequest(userText: string): boolean {
  const txt = userText.trim();
  if (!txt) return false;
  // 纯序号 / 纯候选值（对澄清选项的回复）
  if (/^\d+$/.test(txt)) return false;
  if (txt.length <= 64 && /^[a-zA-Z0-9_.\-\/]+$/.test(txt)) return false;
  // 简短明确选择短语（协议级，非语义）
  if (/^(是|否|好的|好|确认|取消|嗯|行)$/i.test(txt)) return false;
  // 其余（含中文长句 / 标点 / 自然语言）一律视为新请求
  return true;
}

/** 从工具结果中解析 UI_TABLE / UI_FILE / UI_CHART 块并推送到前端 */
function emitUiPayloadsFromToolResult(content: string, emitEvent: (e: ChatEvent) => void) {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "UI_TABLE" && lines[i + 1]) {
      try {
        const table = JSON.parse(lines[i + 1]) as ChatTableView;
        if (table?.columns && Array.isArray(table.rows)) emitEvent({ type: "table", table });
      } catch {
        /* ignore */
      }
    }
    if (lines[i] === "UI_FILE" && lines[i + 1]) {
      try {
        const file = JSON.parse(lines[i + 1]) as ChatFileRef;
        if (file?.id && file?.url) emitEvent({ type: "file", file });
      } catch {
        /* ignore */
      }
    }
    if (lines[i] === "UI_CHART" && lines[i + 1]) {
      try {
        const chart = JSON.parse(lines[i + 1]) as ChatChartView;
        if (chart?.categories && Array.isArray(chart.series)) emitEvent({ type: "chart", chart });
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 聚合上屏（对齐 Cursor 数据处理：多页分表 → 一张总表）：
 * 分页查询期间，call_api 列表渲染把每页结果暂存 pendingTables，final 收束时统一合并：
 *  - columns 相同的表（同一模块的多页）→ 合并 rows 为一张总表上屏，total 求和；
 *  - columns 不同的表（多模块混查）→ 分别上屏（保留原多表行为）。
 * 合并/最后一张表写入 session.lastTable（导出延续场景同样拿全量数据）。
 */
function flushPendingTables(
  pending: ChatTableView[] | undefined,
  session: Session,
  emitEvent: (e: ChatEvent) => void,
): void {
  if (!pending || !pending.length) return;
  const groups = new Map<string, ChatTableView[]>();
  for (const t of pending) {
    const key = (t.columns || []).map((c) => c.key).join("|");
    const g = groups.get(key) || [];
    g.push(t);
    groups.set(key, g);
  }
  let lastShown: ChatTableView | undefined;
  for (const [, group] of groups) {
    if (group.length === 1) {
      emitEvent({ type: "table", table: group[0] });
      lastShown = group[0];
      continue;
    }
    // 2026-08-26 修复：跨页合并前去重。事故复盘：「人群包配置，第二页」接口未按 page 生效返回全量，
    // 两次调用同一份 22 条被 flatMap 合并成 44 行、total 求和 44。现按整行 JSON 序列化去重（无业务键名
    // 写死、纯通用），total 取第一张表的声明值（各页 total 是同一全局总数，求和不适用于重复页）。
    const flatRows = group.flatMap((g) => g.rows);
    const seen = new Set<string>();
    const dedupRows = flatRows.filter((r) => {
      const key = JSON.stringify(r ?? null);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const merged: ChatTableView = {
      title: group[0].title,
      columns: group[0].columns,
      rows: dedupRows,
      total: group[0].total ?? dedupRows.length,
    };
    console.log(
      `[chat:table] 聚合上屏：${group.length} 张分表合并为 1 张（rows=${merged.rows.length} total=${merged.total}${dedupRows.length !== flatRows.length ? `，去重 ${flatRows.length - dedupRows.length} 行` : ""}）`,
    );
    emitEvent({ type: "table", table: merged });
    lastShown = merged;
  }
  if (lastShown) {
    session.lastTable = {
      title: lastShown.title,
      columns: lastShown.columns,
      rows: lastShown.rows,
      total: lastShown.total,
      at: Date.now(),
    };
  }
}

/** 写操作确认的影响面描述（Cursor 权限分级的轻量版）：
 *  从用户原话 + 参数推断「高危标识 / 影响对象 / 数量」，随 confirmation_required 事件给前端展示，
 *  让用户在确认前知道这次操作会影响什么（对齐 Cursor「敏感操作用户授权」体验）。 */
function buildConfirmationImpact(
  userText: string,
  callInput: Record<string, unknown>,
  method: string,
): { highRisk: boolean; target: string; count: number } {
  // 确认弹窗展示辅助（2026-08-24 去写死）：不再内置业务实体词表（兑换码/影片/用户...）与
  // 中文危险动词表（删除/移除...）——它们属写死业务词，违反「禁止写死」红线。
  // target 退化为通用「该记录」+ 参数名（若有）；高危等级改由 HTTP 方法判定（delete/remove 恒高危）。
  // 具体操作对象/影响的业务描述由模型在确认输入 description 中表达，展示层不猜业务词。
  const m = String(method || "GET").toUpperCase();
  const params = (callInput.params as Record<string, unknown>) || {};
  const name = String(params.name || callInput.name || "").trim();
  const target = name ? `对象「${name}」` : "该记录";
  let count = 0;
  // 数量只从结构化参数取（ids 数组长度），不解析用户话术（此前 [条个] 中文数量词判定
  // 属功能词写死，违反红线；数量展示为可选项，取不到就 0，不影响确认本身）。
  const ids = params.ids || params.idList || params.selectIds;
  if (Array.isArray(ids)) count = ids.length;
  const highRisk = /delete|remove/i.test(m);
  return { highRisk, target, count };
}

/**
 * 识别模型"假装调工具"的计划文本：即模型不真正发起 function call，
 * 却把工具调用写成 JSON/XML/围栏文本输出（{"tool": "...", "parameters": {...}}、
 * {"tool_calls": [...]} 或 <export_dataset>参数...</export_dataset>）。
 * 这类文本应视为噪音，禁止展示给用户；真实结果由服务端兜底编排产出。
 * （PM2 watch 自愈验证注释：2026-08-21）
 */
/**
 * 伪工具调用检测（协议护栏，对齐 Cursor「工具调用必须走函数调用通道」）。
 * 仅识别「模型把工具调用写成文本而非 function calling」的纯协议结构形态，
 * 全部基于英文工具名契约（AGENT_TOOL_NAMES）与 JSON/XML 结构字符判定：
 *  - 不做任何业务词/功能词/语言判定（业务/闲聊/意图 100% 交模型，2026-08-25 章程红线）
 *  - 不写死任何中文词或参数键名（删除 2026-08-25 前的「第X步」/中文参数键/JSON 字段名功能词检测）
 */
function isToolPlanText(text: string): boolean {
  const t = text || "";
  if (!t) return false;
  // ① JSON 对象形态：含工具名键（tool/tool_calls/name）+ 参数键（parameters/arguments/input）
  if (
    (/"tool"\s*:\s*["']|"tool_calls"\s*:|"name"\s*:\s*["'](?:${AGENT_TOOL_NAMES.join("|")})["']/.test(t)) &&
    /"parameters"\s*:|"arguments"\s*:|"input"\s*:/.test(t)
  ) {
    return true;
  }
  // ② XML 围栏形态：<工具名> 或 </工具名>（工具名=英文契约，非业务词）
  if (new RegExp(`<\\/?(?:${AGENT_TOOL_NAMES.join("|")})(?:\\s|>)`).test(t)) return true;
  // ②b XML 属性形态：<function=工具名> / <工具名=...> / <parameter=工具名>（工具名作属性值而非标签名；
  //     覆盖 2026-08-26 实测 laguna 系弱模型输出 <tool_call><function=call_api><parameter=...> 伪调用漏检）
  if (new RegExp(`<[\\w-]+\\s*=\\s*(?:${AGENT_TOOL_NAMES.join("|")})`).test(t)) return true;
  // ②c <tool_call> 包裹形态：顶层含 <tool_call> 标签且内部含参数标签 <...=...> 或 </...>（结构信号，非语义判定）
  if (/<\s*tool_call\s*>/.test(t) && /<\s*[\w-]+\s*=\s*[\w\u4e00-\u9fa5]+/.test(t)) return true;
  // ③ 方括号形态：[工具名]（多工具步骤列表 ≥2 个，或单/多个 + XML 参数标签 <...>）
  const bracketMatches = (t.match(new RegExp(BRACKET_TOOL_RE.source, "g")) || []);
  if (bracketMatches.length >= 2) return true;
  if (bracketMatches.length === 1 && /<[\w-]+>/.test(t)) return true;
  // ④ action 键引用工具名（"action":"工具名" JSON 片段）
  if (new RegExp(`"action"\\s*:\\s*["'](?:${AGENT_TOOL_NAMES.join("|")})["']`).test(t)) return true;
  return false;
}

/**
 * 统一输出校验（协议护栏，对齐 Cursor 输出校验的轻量版）：
 * 仅拦「未对齐的协议结构」——裸 JSON / 工具计划（文本模拟工具调用）/ 澄清 JSON。
 * 与 isToolPlanText 同样只基于英文工具名契约与 JSON/XML 结构字符，无任何业务词/功能词/语言写死。
 */
function validateFinalText(text: string): "tool-call" | "clarification" | "bare-json" | "pseudo-plan" | null {
  const t = String(text || "").trim();
  if (!t) return null;
  if (/^\s*\{/.test(t) && /"tool_calls"\s*:/.test(t)) return "tool-call";
  // 澄清 JSON（结构化澄清产物，非用户可见回答）
  if (/^\s*\{/.test(t) && /"missingSlots"\s*:/.test(t) && /"question"\s*:/.test(t)) return "clarification";
  // 整体为裸 JSON 对象（含键值对且以 } 结尾）：未对齐的裸 JSON，禁止上屏
  if (/^\s*\{/.test(t) && /"[\w\u4e00-\u9fa5]+"\s*:/.test(t) && /\}\s*$/.test(t)) return "bare-json";
  // 伪工具调用（与 isToolPlanText 同一协议护栏）
  if (isToolPlanText(t)) return "pseudo-plan";
  return null;
}

/**
 * 折叠最终回复中重复的 markdown 表格（2026-08-26，方案 B 兜底）。
 *
 * 背景：列表/详情渲染分支会把真实数据以 UI_TABLE 上屏（前端 admin-table 展示），同时 list-verify/
 * detail-verify 引导模型校验总结。若模型不听引导仍把完整 markdown 表格写进最终文本，用户会看到
 * 「两块数据」（上屏表格 + 文本内重复表格）。此处做服务端兜底折叠。
 *
 * 规则（纯协议结构检测，零业务词）：
 *  - 仅当本轮已上屏表格（session.lastTable 存在且时间在本次请求窗口内）才折叠；
 *  - 检测连续 markdown 表格行（| 开头、含 | 分隔、含分隔行 |---|）：段落行数 >= 5 视为「大段重复表格」，
 *    折叠为一行占位说明；小表格（<5 行，如汇总统计表）不折叠，避免误伤模型合理的小表。
 *  - 表格判定不看列名/内容，只看 markdown 表格结构（协议语义）。
 */
function collapseDuplicateTable(text: string, session: Session): string {
  const t = String(text || "");
  if (!t || !session.lastTable) return t;
  // 上屏时间需在本次请求附近（30s 内），避免跨请求折叠旧表
  if (Date.now() - (session.lastTable.at || 0) > 30_000) return t;
  const lines = t.split("\n");
  const out: string[] = [];
  let i = 0;
  let collapsed = 0;
  while (i < lines.length) {
    const isTableStart = /^\s*\|.+\|/.test(lines[i]) && /^\s*\|[\s:|-]+\|/.test(lines[i + 1] || "");
    if (!isTableStart) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    // 找到表格块结束（连续 | 开头行）
    let j = i;
    while (j < lines.length && /^\s*\|/.test(lines[j])) j += 1;
    const blockLen = j - i;
    if (blockLen >= 5) {
      out.push("> （表格数据已在上方系统表格中展示，此处省略重复明细）");
      collapsed += 1;
    } else {
      for (let k = i; k < j; k += 1) out.push(lines[k]);
    }
    i = j;
  }
  if (!collapsed) return t;
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Validate 环节（Cursor 分层规划器 Validate 的轻量版）：校验 call_api 返回是否为可消费的结构化数据。
 *  仅拦「结构完全异常」（空 / 非 JSON / 非对象数组），空列表/空对象属合法业务结果不拦，避免误伤。
 *  返回空串=通过；返回非空=诊断信息（供提示模型说明，禁止把原始异常内容透传上屏）。 */
function validateApiResultShape(content: string): string {
  const c = String(content || "").trim();
  if (!c) return "返回内容为空";
  try {
    const parsed = JSON.parse(c.replace(/^```json\s*|\s*```$/g, ""));
    if (parsed && typeof parsed === "object") return "";
  } catch {
    // 可能被 UI_TABLE/说明文本包裹，尝试提取首个 JSON 段
    const m = c.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]);
        if (parsed && typeof parsed === "object") return "";
      } catch {
        /* fallthrough */
      }
    }
  }
  return "返回内容不是 JSON 对象/数组";
}

/** 从 call_api 返回文本中提取「多行列表数据」（数组 / {rows|list:[...]}，≥2 行）：
 *  供服务端强制受控渲染列表表格；1 行对象走详情渲染，0 行视为无列表数据。 */
/** 递归检测对象是否含「数组容器」（rows/list/records/items/data/result 任意层级，深度护栏 6）：
 *  详情对象不应有数组容器；列表包装（含 {code,data:{list}} 两层封装）应排除。 */
function hasListContainer(o: Record<string, unknown>, depth = 0): boolean {
  if (depth > 6) return false;
  for (const key of ["rows", "list", "records", "items", "data", "result"]) {
    if (Array.isArray(o[key])) return true;
    const v = o[key];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (hasListContainer(v as Record<string, unknown>, depth + 1)) return true;
    }
  }
  return false;
}

/** 从 call_api 返回文本中提取"单条详情对象"：
 *  优先剥离 [readback] 之后的写操作回读块（回读才对应详情）；
 *  取第一个可解析的 JSON 对象且非含数组容器的对象（含两层封装）时视为详情对象，供服务端强制渲染。 */
function extractSingleDetailPayload(content: string): Record<string, unknown> | undefined {
  const c = String(content || "");
  const readbackIdx = c.indexOf("[readback]");
  const detailPart = readbackIdx >= 0 ? c.slice(readbackIdx) : c;
  // 栈式括号配平提取完整 JSON 对象：非贪婪 /\{[\s\S]*?\}/ 遇到嵌套对象（如 names:[{...}]）会
  // 在第一个 } 截断导致整个详情解析失败，必须按 { } 深度配平才能取到完整对象。
  for (let i = 0; i < detailPart.length; i++) {
    if (detailPart[i] !== "{") continue;
    let depth = 0;
    let j = i;
    let inStr = false;
    let esc = false;
    for (; j < detailPart.length; j++) {
      const ch = detailPart[j];
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
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue; // 未配平，跳过
    const raw = detailPart.slice(i, j + 1);
    // 已配平的完整对象整体跳过（i 直接跳到 j 之后），避免重复扫描内部嵌套对象——
    // 否则 {list:[{id:1}],total:1} 会在跳过外层后把内部 {id:1} 误当成详情。
    i = j;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        // 排除含数组容器的对象（{list:[]}/{rows:[]}/{data:[]} 及两层 {data:{list}} 均非详情）
        if (hasListContainer(obj)) continue;
        if (Object.keys(obj).length) return obj;
      }
    } catch { /* ignore */ }
  }
  return undefined;
}

/** 是否已成功 call_api 取数（steps 中存在 call_api 且结果非错误/重试/澄清开头）：
 *  供「业务请求未取数护栏」判定——模型 submit 后直接文本收束但没拿到数据时强制续探。 */
function hasSuccessfulApiCall(steps: AgentStep[]): boolean {
  const callNames = new Map<string, string>();
  for (const s of steps) {
    if (s.kind === "toolCalls") for (const c of s.calls) callNames.set(c.id, c.name);
  }
  for (const s of steps) {
    if (s.kind !== "toolResult") continue;
    if (callNames.get(s.toolCallId) !== CALL_API_TOOL) continue;
    const c = s.content;
    if (
      c &&
      !c.startsWith("错误：") &&
      !c.startsWith("MODULE_RETRY") &&
      !c.startsWith("CLARIFICATION_REQUIRED")
    ) {
      return true;
    }
  }
  return false;
}

/** 从已执行步骤里取最近一次大模型理解结果 */
function findLastUnderstood(steps: AgentStep[]): UnderstoodIntent | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.kind === "toolCalls") {
      const call = step.calls.find((c) => c.name === SUBMIT_UNDERSTOOD_INTENT);
      if (call) return parseUnderstoodIntent(call.input || {});
    }
    if (step.kind === "toolResult" && step.content.includes('"_understood"')) {
      try {
        const parsed = JSON.parse(step.content) as Record<string, unknown>;
        if (parsed._understood) return parseUnderstoodIntent(parsed);
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

/**
 * 服务端兜底编排：当模型未真正调用工具（只输出计划/说明，或模型故障）时，
 * 主动走规则编排（parse_intent → search_api_module → call_api → normalize）拿真实数据。
 * 不依赖模型自觉，也不调用大模型。返回最终文本或澄清文本。
 */
async function runServerFallback(opts: {
  userText: string;
  llmSteps: AgentStep[];
  session: Session;
  eventQueue: ChatEvent[];
  onEvents: (ev: ChatEvent) => void;
}): Promise<{ text?: string; clarificationText?: string }> {
  const { userText, llmSteps, session } = opts;
  // 仅当模型真正调用了 submit_understood_intent（steps 里有工具结果）才算“模型理解”；
  // 从纯文本 parseUnderstoodFromText 解析的不算——模型噪音文本（“请稍等”/计划）会被误当成理解，
  // 导致 understodFromLlm=true 而让 parse_intent 走模型分支、丢失 write 关键词推断（如“新增/删除”）。
  const llmIntent = findLastUnderstood(llmSteps) || undefined;
  let orch: Awaited<ReturnType<typeof orchestrateBusinessQuery>>;
  try {
    orch = await orchestrateBusinessQuery({
      userText,
      llmIntent,
      priorSteps: llmSteps,
      emitEvent: opts.onEvents,
      token: session.token,
      country: session.country,
      menus: session.menus,
      sessionId: session.id,
    });
  } catch (e) {
    console.error(`[fb-diag] orchestrateBusinessQuery THREW for "${userText}":`, e);
    return {};
  }
  if (orch.kind === "executed") {
    // executed 但未产出可读文本（normalizedText 为空）时，不返回空串（避免上层静默），
    // 返回 null 由上层走「未能理解」兜底。
    return { text: orch.normalizedText?.trim() ? orch.normalizedText : undefined };
  }
  if (orch.kind === "clarification") {
    return { clarificationText: orch.clarificationText };
  }
  // partial：规则编排执行了但未产出可展示结论（如写操作缺参/后端拒绝）。
  // 返回最后一条 system 提示作为如实回显，避免把模型编造/“请稍等”当结果。
  if (orch.kind === "partial") {
    const last = [...orch.steps].reverse().find((s) => s.kind === "system");
    const reason = last?.text || "该操作未能完成，请提供更完整的信息后重试。";
    console.error(
      `[fallback] orchestrate partial for "${userText}"`,
      orch.steps.slice(-2).map((s) =>
        s.kind === "toolResult"
          ? s.content.slice(0, 200)
          : s.kind === "system"
            ? s.text.slice(0, 200)
            : JSON.stringify(s.calls || []).slice(0, 200),
      ),
    );
    return { text: reason };
  }
  // skip：规则层未能命中真实接口（非业务/模块不明），交给上层按原样处理
  return {};
}

/**
 * 规则门：call_api 执行前用 parse_intent 校验槽位。
 * 大模型可先检索整理；真正落地接口前才过规则。
 */
async function rulesGateBeforeCallApi(opts: {
  userText: string;
  call: ToolCall;
  steps: AgentStep[];
  sessionId: string;
}): Promise<
  | { kind: "ok"; warn?: string }
  | { kind: "clarification"; clarification: string }
  | { kind: "retry"; retry: string }
> {
  const understood = findLastUnderstood(opts.steps);
  const op = String(opts.call.input.operation || "");
  const method = String(opts.call.input.method || "GET").toUpperCase();
  // 2026-08-24（Cursor 式信任模型实际调用）：call_api 的 operation/path 若已能解析出
  // 可调用接口（含源码 grep 兜底），直接放行——不再用旧 submit module 否决正确调用。
  // 事故：模型 submit module=<不可调用模块> 后 call_api 传对 operation=<页面目录>.<接口>，
  // 旧逻辑只认 submit module → 反复 MODULE_RETRY「<不可调用模块>」，模型绕十几轮仍失败。
  const opDirect = op ? resolveApiOperation(op) : null;
  const opGrep = !opDirect && op ? resolveOperationByApiGrep(op) : null;
  // 已解析出可调用接口 → 先做确定性参数校验（C/A/D/枚举翻译，不写死业务词），
  // 再决定是否放行。guard 返回 block 则回传模型自愈（retry），warn 仅附加提示后放行。
  if (opDirect || opGrep) {
    const guardRes = guardCallApi({
      operation: op,
      path: String(opts.call.input.path || ""),
      params: (opts.call.input.params && typeof opts.call.input.params === "object"
        ? opts.call.input.params
        : {}) as Record<string, unknown>,
      userText: opts.userText,
      intent: (opts.call.input.intent && typeof opts.call.input.intent === "object"
        ? opts.call.input.intent
        : undefined) as CallApiGuardInput["intent"],
    });
    if (guardRes.block) {
      return { kind: "retry", retry: guardRes.block };
    }
    if (guardRes.warn) {
      // 仅警告：放行但把提示回传模型（不阻断取数）
      return { kind: "ok", warn: guardRes.warn } as { kind: "ok" } & { warn?: string };
    }
    return { kind: "ok" };
  }
  const p = String(opts.call.input.path || "");
  if (p) {
    const byPath = resolveApiOperationByPath(p) || resolveApiOperationByPathSuffix(p);
    if (byPath) {
      const guardRes = guardCallApi({
        operation: byPath.id,
        path: p,
        params: (opts.call.input.params && typeof opts.call.input.params === "object"
          ? opts.call.input.params
          : {}) as Record<string, unknown>,
        userText: opts.userText,
        intent: (opts.call.input.intent && typeof opts.call.input.intent === "object"
          ? opts.call.input.intent
          : undefined) as CallApiGuardInput["intent"],
      });
      if (guardRes.block) return { kind: "retry", retry: guardRes.block };
      if (guardRes.warn) return { kind: "ok", warn: guardRes.warn } as { kind: "ok" } & { warn?: string };
      return { kind: "ok" };
    }
  }
  // 2026-08-26 修复：模型传了 operation 但解析不到任何真实接口（幻觉接口名/拼写错误）。
  // 事故：模型臆造 <模块>.<臆造列表名>，opDirect/opGrep 均 null，parse_intent 兜底直接 ok 放行，
  // 模型收不到「接口不存在」反馈 → 反复用同一错误 operation 空转十几轮（人群包配置实测）。
  // 现返回 warn（放行但提示自查真实接口 id），纯协议反馈、零业务词。
  if (op && !opDirect && !opGrep) {
    const pathResolved = p ? resolveApiOperationByPath(p) || resolveApiOperationByPathSuffix(p) : null;
    if (!pathResolved) {
      console.log(`[gate:call_api] op=${op} 解析不到真实接口 → warn`);
      return {
        kind: "ok",
        warn:
          `检测到 operation「${op}」无法定位到项目内任何真实接口（名称可能拼写有误或混入了不存在的模块名）。` +
          `请用 read_api_module 读取候选模块的接口源码，按函数名精确选择真实可用的接口 id（如 <模块>.<函数名>）` +
          `，再重新调用 call_api；不要臆造接口名。`,
      } as { kind: "ok" } & { warn?: string };
    }
  }
  // 模型可能只传 path 不带 operation：从 path 反推归属模块（供 submit module 兜底校验）
  let moduleFromOp = op.includes(".") ? op.split(".")[0] : "";
  if (!moduleFromOp) {
    if (p) {
      const byPath = resolveApiOperationByPath(p);
      moduleFromOp = byPath?.module?.split("/").slice(-1)[0] || "";
    }
  }
  const gate = await runAgentTool(
    "parse_intent",
    {
      userInput: opts.userText,
      understoodFromLlm: true,
      // A 方案：主流程有模型在 loop 里 → 模块歧义/不可调用时返回 MODULE_RETRY，
      // 错误回传模型自愈（模型结合语境重选或检索），而不是服务端硬反问。
      retryOnModuleAmbiguity: true,
      understoodProject: understood?.project || "",
      understoodModule: understood?.module || moduleFromOp || "",
      understoodValue: understood?.value || "",
      understoodOperation:
        understood?.operationType && understood.operationType !== "unknown"
          ? understood.operationType
          : method === "GET"
            ? "read"
            : "write",
    },
    { sessionId: opts.sessionId },
  );
  if (gate.startsWith("CLARIFICATION_REQUIRED")) {
    return { kind: "clarification", clarification: gate.replace(/^CLARIFICATION_REQUIRED\s*/, "").trim() };
  }
  if (gate.startsWith("MODULE_RETRY")) {
    // 模块定位自愈：把「该模块不可调用/多个候选」反馈给模型，让模型修正后重新调用
    return { kind: "retry", retry: gate.replace(/^MODULE_RETRY\s*/, "").trim() };
  }
  // 对齐 Cursor「信任模型语义判断」：parse_intent 现在只做安全校验（模块可调用性）与
  // 歧义回传/反问，不再做规则层纠正（旧逻辑会用关键词把模型已正确的模块改错，如
  // 「影片采集员」→ videosource 被「影片」短词截胡成 film）。故不再改写 call。
  return { kind: "ok" };
}

export async function* chatStream(
  session: Session,
  userText: string,
  opts: { model?: string; images?: string[]; files?: string[] } = {},
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  if (session.pendingClarification) {
    // 仅问 project 的待澄清：本部署已默认绑定影视后台，直接丢弃，按新消息走主流程
    if (
      session.pendingClarification.missingSlots?.length === 1 &&
      session.pendingClarification.missingSlots[0] === "project"
    ) {
      ensureDefaultProject(session.id);
      delete session.pendingClarification;
      touchSession(session);
    }
  }

  if (session.pendingClarification) {
    const pending: PendingClarification = session.pendingClarification;
    if (isLikelyFreshRequest(userText)) {
      // 用户给了新需求，丢弃旧的待澄清状态，避免“反问上限”误伤新请求。
      delete session.pendingClarification;
      touchSession(session);
    } else {
    const picked = pickClarificationOption(pending, userText);
    if (!picked) {
      pending.turns += 1;
      if (pending.turns >= MAX_CLARIFICATION_TURNS) {
        const ranked = pending.options
          .filter((o) => o.label)
          .map((o, i) => `  ${i + 1}. ${o.label}`)
          .join("\n");
        const missingLabel = pending.missingSlots.map((s) => SLOT_LABELS[s] || s).join("、");
        const text = `还需要确认【${missingLabel}】，请选择一项：\n${ranked}\n请回复序号。`;
        session.messages.push({ role: "assistant", text });
        yield { type: "text", text };
        yield { type: "done" };
        touchSession(session);
        return;
      }
      const options = pending.options
        .filter((o) => o.label)
        .map((o, i) => `  ${i + 1}. ${o.label}`)
        .join("\n");
      const missingLabel = pending.missingSlots.map((s) => SLOT_LABELS[s] || s).join("、");
      const text = `需要确认【${missingLabel}】，${pending.question}\n${options}\n请回复序号。`;
      session.messages.push({ role: "assistant", text });
      yield { type: "text", text };
      yield { type: "done" };
      touchSession(session);
      return;
    }

    const resumeInput = { ...pending.resumeInput };
    if ((pending as PendingClarification).missingSlots.includes("operation") && picked.value) {
      resumeInput.operation = picked.value;
    }
    delete session.pendingClarification;
    const resumed = await runAgentTool(pending.resumeTool, resumeInput, {
      token: session.token,
      country: session.country,
      menus: session.menus,
    });
    const text = resumed.startsWith("CLARIFICATION_REQUIRED")
      ? renderClarificationForUser(resumed)
      : resumed;
    session.messages.push({ role: "user", text: userText });
    session.messages.push({ role: "assistant", text });
    yield { type: "text", text };
    yield { type: "done" };
    touchSession(session);
    return;
    }
  }

  session.messages.push({ role: "user", text: userText });

  // 新会话在 createSession 时已直接绑定默认项目（影视后台），此处 ensureDefaultProject
  // 仅对「升级前创建、无 activeProject 字段」的旧会话做兼容补齐；新会话走到这里为 no-op。
  ensureDefaultProject(session.id);
  // 请求级项目上下文：grep/渲染/索引按当前会话的项目解析代码根目录（方案 A 多项目）。
  // 下一请求会再次 set 覆盖，无需显式 clear（避免 generator 多出口漏清理）。
  setCurrentProject(getActiveProject(session.id)?.key || "");
  // 若仍卡在「选项目」待澄清，直接丢弃（项目已绑定）
  const pendingPc = session.pendingClarification as PendingClarification | undefined;
  if (
    pendingPc?.missingSlots?.length === 1 &&
    pendingPc.missingSlots[0] === "project"
  ) {
    delete session.pendingClarification;
    touchSession(session);
  }

  // ---- 图片：按模型能力处理 ----
  const images: OptionImage[] = (opts.images || [])
    .slice(0, MAX_AT_ONCE)
    .map((id) => getUpload(id))
    .filter((item): item is { kind: "image"; mediaType: string; base64: string } => Boolean(item && item.kind === "image"));

  // ---- 模型解析：显式指定（含"none"）用指定模型；缺省/auto 走自动路由 ----
  const wantAuto = !opts.model || opts.model === "auto" || opts.model === "AUTO";
  let model: ModelEntry | null = wantAuto ? pickAutoModel(images.length > 0, userText.length) : getModel(opts.model);
  if (!model) model = legacyModel();
  if (!model) {
    yield {
      type: "text",
      text: "未配置任何模型。请在服务端 .env 设置 MODEL_PROVIDERS 或旧的 MODEL_PROVIDER/ANTHROPIC_AUTH_TOKEN 后重启。",
    };
    yield { type: "done" };
    touchSession(session);
    return;
  }
  // 自动路由：显式指定的模型不支持图片时，仍尝试遍历模型库找视觉模型。
  if (images.length && model.vision === "none" && wantAuto) {
    const visionModel = pickAutoModel(true, userText.length);
    if (visionModel && visionModel.vision !== "none") {
      model = visionModel;
      yield { type: "model", id: visionModel.id, label: visionModel.label, reason: "image" };
    } else {
      yield {
        type: "error",
        message: `当前模型（${model.label}）不支持图片，且模型库中没有支持图片的模型。请配置 MODEL_<ID>_VISION=direct 或 ocr 的模型。`,
        code: "VISION_DISABLED",
      };
      yield { type: "done" };
      touchSession(session);
      return;
    }
  }
  if (images.length && model.vision === "none") {
    yield {
      type: "error",
      message: `当前模型（${model.label}）不支持图片（MODEL_${model.id.toUpperCase()}_VISION=none）。请去掉图片后重试，或切换支持图片的模型。`,
      code: "VISION_DISABLED",
    };
    yield { type: "done" };
    touchSession(session);
    return;
  }

  const notes: ContentNote[] = [];
  const imageNotes: string[] = [];
  const visionErrors: string[] = [];

  if (images.length && model.vision === "ocr") {
    for (const image of images) {
      try {
        imageNotes.push(await transcribeImage(image.base64, image.mediaType));
      } catch (error) {
        visionErrors.push(error instanceof Error ? error.message : "转录失败");
      }
    }
  }

  // ---- 内容源：本地文件显式引用 + 本地路径自动识别 + 链接自动抓取 + 上传文件 ----
  const localFiles = [...userText.matchAll(/@file:([^\s"']+)/g)].map((m) => m[1]);
  for (const name of [...localFiles, ...extractLocalPaths(userText)]) {
    const result = resolveLocalDoc(name);
    if ("note" in result) notes.push(result.note);
    else notes.push({ label: "本地文件", text: result.error });
  }

  const urls = extractUrls(userText);
  for (const url of urls) {
    const result = await fetchLink(url);
    if (typeof result === "string") {
      notes.push({ label: "链接", text: result });
    } else {
      notes.push(result);
    }
  }

  const fileNotes: string[] = [];
  for (const id of (opts.files || []).slice(0, MAX_AT_ONCE)) {
    const item = getUpload(id);
    if (item && item.kind === "text") fileNotes.push(item.text);
  }

  // ---- 拼装 user 消息 ----
  // 注意：技能指南（Skills）与常驻规则（Rules）统一在 preprocess 节点注入 system 层，
  // 不在 user 消息硬拼（对齐 Cursor：skills/rules 由模型上下文层统一加载，非服务端 if/else 硬匹配）。
  const chunks: string[] = [userText];
  if (fileNotes.length) {
    chunks.push(`\n\n[上传文件内容]\n${fileNotes.map((f, i) => `${i + 1}. ${f}`).join("\n")}`);
  }
  if (imageNotes.length) {
    chunks.push(`\n\n[图片内容附注]\n${imageNotes.map((f, i) => `${i + 1}. ${f}`).join("\n")}`);
  }
  // OCR 转录失败：把失败原因注入上下文，让模型如实告知用户「图片未能识别」，
  // 而不是对一张它看不到的图片瞎编内容（此前 imageNotes 为空 = 模型误以为没图）。
  if (visionErrors.length) {
    chunks.push(`\n\n[图片转录失败]\n以下图片内容未能识别（OCR 转录失败）：${visionErrors.join("；")}。请如实告知用户图片无法读取，不要臆测其内容。`);
  }
  if (notes.length) {
    chunks.push(`\n\n[资料来源]\n${notes.map((n, i) => `${i + 1}. ${n.label}: ${n.text}`).join("\n")}`);
  }
  const humanText = chunks.join("").slice(0, config.contextMaxChars);

  // 历史上下文压缩（对齐 Cursor /summarize 分层）：session.messages 本体保留完整，
  // 模型只见「摘要块 + 预算内历史」的只读投影；超预算先低损 prune，仍超才 LLM 摘要。
  const turns: ModelTurn[] = await buildModelTurns(session, humanText, model, signal);

  // 这些变量需在 try/catch 两级作用域可见（catch 兜底编排要复用），故提升到 try 之外。
  const eventQueue: ChatEvent[] = [];
  function emitEvent(event: ChatEvent) {
    eventQueue.push(event);
  }
  let ls_: { steps?: AgentStep[]; text?: string } | undefined;
  // write（增/改/删）意图判定（2026-08-24 去写死）：不再用服务端中文词预判 isWriteQuery，
  // 改为 graph 完成后从模型提交的 understood.operationType==="write" 计算（模型信号驱动）。
  // 主 fallback 与 catch 兜底都必须先经用户确认再执行（安全红线），writeForce 仅在该处按需计算。

  function waitForConfirmation(_sessionId: string, callId: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      registerConfirmWaiter(session.id, callId, resolve);
      setTimeout(() => {
        // 超时时尝试清理并 resolve false
        if (resolveConfirmWaiter(session.id, callId, false)) {
          // already resolved by registry
        }
      }, timeoutMs);
    });
  }

  try {
    // direct 模型图片随 content block 上送；ocr/none 已转文本注。
    const rawImages = model.vision === "direct" ? images : [];
    // 完全抛弃 aliases（2026-08-22）：submit_understood_intent.module 不再用候选 enum 约束，
    // 改为自由文本英文模块 id。模块定位 100% 交模型实时 grep 源码（search_api_module 底层 rg
    // 扫 PC 端 src/api+src/views；grep_codebase/read_api_module 配合），服务端只做可调用性校验。
    const tools = listAgentTools();

    // 用 LangGraph：START → llm ⇄ tool → final → END
    // 注意：LangGraph recursionLimit 计的是 superstep（每进一次节点 +1），
    // 一轮 llm→tool 约占 2 步；必须保证 recursionLimit > 2*MAX_TOOL_ROUNDS，
    // 否则会先抛 GraphRecursionError，round 上限永远走不到。
    const LoopState = Annotation.Root({
      round: Annotation<number>,
      steps: Annotation<AgentStep[]>,
      toolCalls: Annotation<ToolCall[]>,
      text: Annotation<string>,
      clarificationText: Annotation<string>,
      needsClarification: Annotation<boolean>,
      cancelled: Annotation<boolean>,
      /** 已成功 normalize/render/summarize，下一轮 llm 若仍调工具则强制收束 */
      outputReady: Annotation<boolean>,
      /** 服务端已按 PC 口径拼好最终答复时，跳过 LLM 直接返回 */
      forcedReply: Annotation<string>,
      /** 最近一次 get_page_schema 的 primary 类型 */
      pageKind: Annotation<string>,
      /**
       * 本轮待上屏的表格（对齐 Cursor 数据处理：多页分表→聚合为一张总表）。
       * call_api 列表渲染分支把每页渲染结果暂存于此（不立即上屏）；
       * final 收束时按 columns 分组合并为一张表一次性上屏 + 写 session.lastTable。
       * 详情（单条）渲染维持立即上屏，不走此队列。
       */
      pendingTables: Annotation<ChatTableView[]>,
      /** 模型调用失败时的错误信息（如 402 额度耗尽）；非空时主流程统一返回错误而非业务反问 */
      modelError: Annotation<string>,
      /** preprocess 节点产出的初始 system 步骤（rules/skills/项目上下文等），understand 节点消费 */
      initialSteps: Annotation<AgentStep[]>,
      /**
       * preprocess 产出的静态引导前缀（对齐 Cursor 静态 prompt 缓存）：
       * 作为 system 首条消息稳定注入（而非逐轮 user 消息），多轮循环命中端点 prompt cache。
       */
      staticGuide: Annotation<string>,
      /** 语义理解（understand）重试次数，条件边据此防止首轮无工具调用时无限循环 */
      understandAttempts: Annotation<number>,
      /** M1（Supervisor 路由）：当前选中的 Worker id（route_to_agent 工具命中后写入；null = 未路由/全量工具） */
      activeWorkerId: Annotation<string | null>,
      /**
       * 伪调用耗尽（对齐 Cursor 确定性回退 + 模型门槛）：模型连续多次把工具调用写成文本
       * （JSON/XML/方括号）而非 function calling，达到阈值后不再让它无限 agent，
       * 强制走 final → 服务端规则编排兜底拿真实数据（弱模型不给持续空转）。
       */
      pseudoPlanExhausted: Annotation<boolean>,
      /**
       * 跨轮 Doom Loop 熔断（对齐 OpenCode doom_loop 防护）：
       * 模型连续多次（≥3 次）提交「同一工具 + 同一入参」的调用（如反复 search 相同 query、
       * call_api 相同 params 不递增分页）→ 判定空转死循环，不再续探。
       * lastToolSignature = 最近一次实际执行的业务工具签名；toolSignatureStreak = 连续相同次数；
       * doomLoopExhausted = 达到阈值（≥3）→ 条件边强制 final → 服务端规则编排兜底拿数据。
       * 签名含工具名 + operation/path + params 全等（与 callApiKey 同构），
       * 正确递增分页（page:1→2→3）签名不同不触发，误伤最小。
       */
      lastToolSignature: Annotation<string>,
      toolSignatureStreak: Annotation<number>,
      doomLoopExhausted: Annotation<boolean>,
    });

    const graph = new StateGraph(LoopState)
      // ── 第 0 步：预处理节点（轻量、不抢模型）────────────────────────────
      // 承接原 chatStream 图外的 KB 预检 / pending 恢复之外的上下文拼装、resident rules
      // 注入等，全部收敛进图第一个节点，使「输入→理解」链路在图层面可观测。
      // 指代消解(resolveOrdinal) / 闲聊识别(CHIT_CHAT) 按蓝图留 TODO 空位（见下方标记）。
      //
      // ⚠️ 红线（对齐 Cursor「rules 仅底线、绝不抢路由」）：本节点注入的所有 system 提示
      // （workflow 指南 / resident rules / 全局项目上下文 / 技能目录）**只作模型输入提示**，
      // 不得包含任何「如果用户输入含 X 则走 Y 工具」的关键词路由 if/else 逻辑——那是规则层越权。
      // 完全抛弃 aliases（2026-08-22）：不注入任何候选模块 brief/enum。
      // 模块定位 100% 交模型实时 grep 源码（search_api_module + grep_codebase + read_api_module），
      // 最终由模型结合语义决定，本节点绝不反向纠正模型。
      // 业务/闲聊判别 100% 交模型（对齐 Cursor「无独立意图路由层」）：本节点恒注入业务 rules/skills，
      // 由模型基于始终可用的业务上下文自主判断该调工具还是纯文本收束。服务端不预判 bool 抢路由
      // （原 isActionableBusinessQuery 写死中文动词白名单已于 2026-08-24 删除）。
      .addNode("preprocess", async (state) => {
        if (signal?.aborted) return { cancelled: true, initialSteps: [], understandAttempts: 0 };

        // TODO(蓝图第0步): 轻量指代消解——把"它/这个/上面的"等回指到上文对象，
        // 当前靠模型自身上下文能力，待独立实现后在此补 resolveOrdinal(userText, history)。
        // 业务/闲聊判别 100% 交模型（2026-08-25 章程红线「全部由大模型判断」）：禁止用
        // 问候句式/功能词正则预判闲聊（原 CHITCHAT_REPLY_RE/BIZ_INTENT_HINT_RE 已删）。
        // 若未来要实现闲聊识别，必须是模型输出信号驱动（如模型 toolCalls=0 且明确问候），
        // 不得引入服务端词形匹配规则。

        const steps: AgentStep[] = [];

        // 注（2026-08-24）：已删除 KB 关键词预检短路（KB_KEYWORDS 正则 + searchKnowledgeBase + forcedReply）。
        // 理由：模型已有 search_knowledge_base 工具（description 明确触发场景，实测「上班迟到了会扣钱吗」即模型自主调
        // 工具命中考勤制度），预检只是"省一次模型调用"的加速器；15 词表召回率低（口语"报销流程"不命中）且业务句
        // 含"流程/标准/资料"时存在误短路风险，forcedReply 无模型整合也偏离 RAG「注入+整合」主流。知识库问答改由
        // 模型自主调 search_knowledge_base（chit-chat 分支已补 KB 意图提示，见下）。

        // 阶段1 极简角色（2026-08-24 起，对齐 Function Calling / Cursor 最佳实践，见 docs/agent/PROMPT_ARCHITECTURE.md）：
        // 「输入 → 调用工具返回数据」阶段不注入大段业务工作流指南（原 [workflow/llm-first] 与 [workflow/superpower]
        // 已删除，其行为约束逐条下沉到 resident rules / 工具 description / 服务端机制，可行性对照见该文档 §4）。
        // 此处仅保留角色定位 + 最小流程骨架：工具使用规范、模块定位流程、续探与输出纪律由工具描述承担。
        // 【静态引导 → system 前缀】（2026-08-25，对齐 Cursor「静态 prompt 重度缓存」）：
        // 以下全部静态引导（角色/协议/项目/规则/技能目录/闲聊边界）拼接为 staticGuide，作为
        // system 首条消息注入（而非逐轮重复的 user 消息）——同一请求多轮循环中 system 前缀完全
        // 一致，OpenAI 兼容端点可命中 prompt cache（省 token + 提速）。动态引导（如 [workflow/retry]
        // [workflow/observe] 反馈）仍走 steps 以 user 消息追加，不污染前缀。
        // 拼接逻辑抽为 buildStaticGuide()（preprocess 与「模型级门槛轻量路径」共用，见模块级定义）。
        const staticGuide = buildStaticGuide(session);
        // 2026-08-24：删除 [workflow/superpower]（与已删的 llm-first 重复；列表一次取全已下沉 call_api
        // description，自动渲染/output-align 已下沉 normalize_output / render_table description，不反问
        // 已下沉 request_clarification description + resident rule #3，见 PROMPT_ARCHITECTURE.md §4）。
        // 完全抛弃 aliases（2026-08-22）：不再注入候选模块 brief。
        // 模块定位 100% 交模型实时 grep 源码——模型用 search_api_module（rg 扫 PC 端
        // src/api+src/views）/ grep_codebase / read_api_module 自己确认英文模块 id。

        return {
          initialSteps: steps,
          // 静态引导前缀（对齐 Cursor 静态 prompt 缓存）：system 首条稳定注入
          staticGuide,
          // forcedReply 由后续节点写入（列表/详情/报表受控渲染），preprocess 不设置。
          forcedReply: state.forcedReply || "",
          understandAttempts: 0,
        };
      })
      // ── 第 1 步：语义理解节点（信任模型，拆 ToolCall/QueryPlan）────────────
      // 从原 llm 节点抽出语义理解职责；首轮无工具调用时的 retry 由条件边外化（见下方边定义），
      // 不再内联第二次 callAgentSafe，避免与后续轮次逻辑纠缠。模型失败/伪计划检测在此统一处理。
      .addNode("understand", async (state) => {
        if (signal?.aborted) return { cancelled: true, toolCalls: [], text: "" };

        // 服务端已产出最终答复（受控渲染 forcedReply）时直接返回，不调模型
        if (state.forcedReply?.trim()) {
          return { toolCalls: [], text: state.forcedReply, steps: state.steps };
        }

        // 首轮语义理解：以 preprocess 产出的 initialSteps 为起点（含 rules/skills/项目上下文）；
        // 后续轮次：沿用图累积的 steps（工具结果已在上轮 tool 节点写入）。
        // 首轮（understandAttempts=0）：以 preprocess 产出的 initialSteps 为起点（含 rules/skills/项目上下文）；
        // 自循环（understandAttempts>0，条件边回 understand）：沿用累积的 state.steps，避免重复注入规则且保留模型上下文。
        // 注意不能用 state.round===0 判断，因为自循环时 round 仍=0（round 仅在 tool 节点末尾+1）。
        const baseSteps =
          (state.understandAttempts || 0) === 0
            ? (state.initialSteps || [])
            : (Array.isArray(state.steps) ? [...state.steps] : []);
        const steps = [...baseSteps];
        // 业务请求未取数护栏（2026-08-24）：条件边把「submit 后直接文本收束但从未成功 call_api」
        // 的轮次路由回本节点续探时，注入取数指引——弱模型（zen 免费链）常把 submit 当最终动作
        // 直接结束（实测「影片上传自动化」7s 收束未取数），用户拿不到数据。
        const lastUnderstood = findLastUnderstood(steps);
        if (
          (state.understandAttempts || 0) > 0 &&
          !hasSuccessfulApiCall(steps) &&
          lastUnderstood?.isBusinessRequest === true
        ) {
          steps.push({
            kind: "system",
            text:
              "[workflow/retry] 你已提交业务理解，但尚未调用取数工具（call_api），用户拿不到数据。" +
              "请继续：用 search_api_module / read_api_module 定位模块接口（候选可能已在上文给出），" +
              "然后调用 call_api 获取真实数据；服务端会自动渲染。若确实无法定位接口，再用自然语言明确告知原因。",
          });
        }
        const isFirstRound = state.round === 0 && tools.length > 0;

        // M1（Supervisor 路由）：命中 Worker 后按白名单裁剪工具 + 套用首选模型
        const worker = state.activeWorkerId ? resolveWorkerById(state.activeWorkerId) : null;
        const workerNames = workerToolNames(worker);
        const routedTools: AgentToolDef[] = workerNames
          ? listAgentTools().filter((t) => workerNames.has(t.name))
          : listAgentTools();

        // 输出已就绪却还在空转：禁止再调工具，强制给用户最终答复
        const forceAnswer = state.outputReady === true;
        const llmTools = forceAnswer ? [] : routedTools;
        // steps 只读投影压缩（Claude Code Micro-compact 同款）：注入模型前把旧轮次工具结果
        // 替换占位符，模型只看到最近几轮完整结果——收敛每轮注入量（越到后面越慢的主因）。
        // state.steps 保持完整：返回时写回未压缩 steps（下方 return steps: steps）。
        const compactedSteps = compactStepsForModel(steps);
        const beforeChars = estimateStepsChars(steps);
        const afterChars = estimateStepsChars(compactedSteps);
        let collapsedCount = 0;
        for (let i = 0; i < steps.length; i++) {
          const a = steps[i];
          const b = compactedSteps[i];
          if (a?.kind === "toolResult" && b?.kind === "toolResult" && a.content !== b.content) collapsedCount += 1;
        }
        if (afterChars < beforeChars) {
          console.log(
            `[chat:compact] steps=${steps.length} chars=${beforeChars}→${afterChars} tok≈${Math.round(afterChars / 4)} collapsed=${collapsedCount} saved=${beforeChars - afterChars} (${Math.round((1 - afterChars / beforeChars) * 100)}%)`,
          );
        }
        const llmSteps = forceAnswer
          ? [
              ...compactedSteps,
              {
                kind: "system" as const,
                text:
                  "[workflow/stop] 数据已对齐/图表摘要已完成，请直接用自然语言回复用户，禁止再调用任何工具。" +
                  "务必基于工具结果说明结论；报表页不要声称已画 ECharts，用文字+表即可。",
              },
            ]
          : compactedSteps;

        // 流式模型实时下发 text_delta（打字机）；最终完整文本统一在下方 yield text 事件兜底/校正。
        // 业务请求首轮不做流式：模型常把"工具计划"当文本输出（{"tool": ..., "parameters": {...}}），
        // 实时转发会把噪音推给前端；等完整结果出来再判断是否可展示。
        const onModelDelta = isFirstRound
          ? undefined
          : (chunk: string) => {
              if (chunk) emitEvent({ type: "text_delta", text: chunk });
            };
        let result: Awaited<ReturnType<typeof callAgentSafe>> | undefined;
        // 2026-08-24：模型调用异常一律直接抛错、不再降级，故 tool-loop 每轮固定使用
        // understand 首轮选定的 model（无「降级成功复用」概念）。
        // M1 增强（§3.8）：Worker 配 preferredModel 时覆盖默认模型，实现「按 Agent 维度切模型」
        const activeModel = worker?.preferredModel ? (getModel(worker.preferredModel) ?? model) : model;
        // 对齐 Cursor agent 模式：业务请求**首轮**强制工具调用——tool_choice=required 迫使模型
        // 必须调 submit_understood_intent 提交理解，杜绝「首轮空转文本回复 → 重试仍空转 → final」
        // 的失败路径（实测稳定性 2/3 的根因）。
        // **后续轮次必须 auto**：让模型基于已完成探索自主决定「继续调工具 or 总结收束」——
        // 若续探轮仍 required，模型想收束（gaveFinalText）却被强制调工具，会与收束机制矛盾、
        // 直到 round 上限才被强制打断（Cursor 语义：首轮强制、续探自主）。
        // 首轮强制工具调用（方案 C，2026-08-24）：业务/闲聊判别交模型，故首轮恒 required 迫使模型
        // 调 submit_understood_intent 提交理解（杜绝首轮空转文本→重试空转失败路径）；模型提交理解后
        // 自主决定续探还是纯文本收束。闲聊句首轮也会调 submit_understood_intent，但模型不调后续业务
        // 工具即自然收束，延迟增加可忽略。后续轮次 auto（模型自主决定继续调工具或总结）。
        const toolChoice: "auto" | "required" = isFirstRound ? "required" : "auto";
        try {
          result = await callAgentSafe(activeModel, turns, rawImages, llmTools, llmSteps, signal, {
            toolChoice,
            systemExtra: state.staticGuide || "",
          }, onModelDelta);
        } catch (modelErr) {
          // 模型调用异常（402 额度耗尽 / 超时 / 网络错误）：**一律直接抛出错误信息，不再降级重试**。
          // 原因：免费备选链本身不稳（zen 免费链慢且误识别），静默降级会把「模型故障」包装成
          // 「自动修复」，误导排查。错误如实上抛（modelError），主流程统一返回 402 指引/错误提示，
          // 禁止静默返回空结果后走业务 fallback 反问无关模块。
          const msg = modelErr instanceof Error ? modelErr.message : String(modelErr);
          console.error(`[chat:understand] 模型调用失败 "${userText}":`, msg);
          // 仅「永久额度耗尽」（402/401008）标记封禁 30min，auto 模式选模型时跳过该模型（429 限流不标记）
          if (isHardQuotaErrorMsg(msg)) markModelExhausted(activeModel.id);
          // 如实返回错误（主流程统一 402/错误提示，不走误导性反问）
          return {
            toolCalls: [],
            text: "",
            steps, // 未压缩 steps 写回 state（只读投影：压缩仅影响模型视图）
            needsClarification: false,
            clarificationText: "",
            modelError: msg,
            understandAttempts: (state.understandAttempts || 0) + 1,
          };
        }

        // 诊断日志：打印模型原始输出，区分「空文本」与「JSON/工具调用形态被 final 的 validateFinalText 清空」
        // （坐实「你有哪些能力？」等闲聊问题落兜底文案的根因）。
        console.log(
          `[chat:understand] raw output text=${JSON.stringify((result.text || "").slice(0, 200))} toolCalls=${result.toolCalls?.length ?? 0}`
        );

        // 模型首轮输出了伪计划文本（自然语言 + JSON 代码块 / call_api 形态），未真调工具执行 →
        // 清空 text，禁止把编造的步骤/能力清单透传上屏；最终结果由服务端兜底编排产出。
        // 是否重试用条件边决定：首轮无工具调用且未达上限 → 回 understand 再理解（带 retry 提示）。
        // 伪计划检测与业务/闲聊判定无关（方案 C）：首轮恒检测，模型输出自然语言+JSON 伪计划即清空，
        // 交服务端兜底编排，不依赖任何服务端预判 bool（意图判别 100% 交模型）。
        const firstRoundPlan = isFirstRound && isToolPlanText(result.text || "");
        // 业务/闲聊判定 100% 交模型（对齐 Cursor，2026-08-25 章程红线）：
        // 服务端不做任何问候句式/业务功能词正则预判；模型判断为闲聊就直接回复问候，
        // 判断为业务就应调用工具。若模型输出 toolCalls=0 的文本，按模型判断结果上屏，
        // 不再以正则猜测「它是不是把业务句当闲聊了」。
        // 对齐 Cursor 错误反馈循环：伪调用被拦后把「为什么被拒」注入下一步骤，让模型明确修正
        // （而非静默清空 text 后模型盲重试 → 空转）。此步骤随 steps 写回，条件边回 understand 时可见。
        const pseudoPlanExhausted = firstRoundPlan && (state.understandAttempts || 0) >= 2;
        if (firstRoundPlan) {
          steps.push({
            kind: "system",
            text:
              "[workflow/tool-calling] 你上一条输出是文本形式的工具调用（非合法的函数调用），已被系统丢弃。" +
              "请直接通过函数调用通道发起工具调用（tool_calls），不要用 JSON / XML / 方括号 / 自然语言描述工具调用。" +
              (pseudoPlanExhausted
                ? "注意：你已多次文本模拟工具调用，本次将由系统自动执行获取数据。"
                : ""),
          });
        }
        // understandAttempts 仅统计「首轮理解空转」（对齐 Cursor 循环语义，见条件边注释 2157-2158）：
        // 工具执行后回 understand 的「续探轮」不消耗理解重试——否则弱模型探索几次就耗尽
        // understandAttempts，条件边空响应重试条件（<3）提前失效 → 还没取到数据就收束兜底
        // （实测「影片列表前2页」4 次工具空转后落「已完成若干工具调用」兜底文案、表格由
        // synthesized 合成但模型未校验总结）。本轮是否「已执行过工具」由 round>0 判断
        // （round 仅在 tool 节点末尾 +1；首轮理解 round=0）。伪调用重试属首轮理解，仍 +1。
        const isContinuationRound = (state.round || 0) > 0;
        const nextUnderstandAttempts = isContinuationRound
          ? (state.understandAttempts || 0)
          : (state.understandAttempts || 0) + 1;
        return {
          toolCalls: forceAnswer ? [] : result.toolCalls,
          text: firstRoundPlan ? "" : (result.text || ""),
          steps, // 未压缩 steps 写回 state（只读投影：压缩仅影响模型视图）
          needsClarification: false,
          clarificationText: "",
          understandAttempts: nextUnderstandAttempts,
          pseudoPlanExhausted: pseudoPlanExhausted ? true : (state.pseudoPlanExhausted || false),
        };
      })
      .addNode("tool", async (state) => {
        if (signal?.aborted) return { cancelled: true, toolCalls: [], round: state.round };
        const prevSteps: AgentStep[] = Array.isArray(state.steps) ? state.steps : [];
        const nextSteps: AgentStep[] = [...prevSteps];
        nextSteps.push({ kind: "toolCalls", calls: state.toolCalls });
        let clarificationText = "";
        let outputReady = state.outputReady === true;
        let forcedReply = state.forcedReply || "";
        let pageKind = state.pageKind || "";
        // 对齐 Cursor 数据处理：列表分页渲染结果暂存，final 收束时合并为一张总表
        let pendingTables: ChatTableView[] = Array.isArray(state.pendingTables) ? [...state.pendingTables] : [];
        // M1（Supervisor 路由）：route_to_agent 命中后写入；贯穿整个工具节点，最终回写 state
        let activeWorkerId: string | null = state.activeWorkerId ?? null;
        const toolOpts = {
          token: session.token,
          country: session.country,
          menus: session.menus,
          sessionId: session.id,
          userText,
        };
        // 同轮重复取数调用去重（对齐 Cursor「观察→再决策」循环）：
        // 弱模型常在未见数据时并行提交多个参数完全相同的取数调用（实测 lagunas 两次 pageNum:1），
        // 逐个执行只是重复请求。检测「同一 operation/path 且 params 序列化完全相同」的重复 call_api，
        // 仅执行第一个，其余注入观察提示引导模型基于返回的分页信息（total/页数）递增参数再取。
        // 纯协议去重（比较 operation/path/params 序列化是否完全相同），不写死任何分页参数名，无业务语义。
        const callApiKey = (c: { name: string; input: Record<string, unknown> }): string | null => {
          if (c.name !== CALL_API_TOOL) return null;
          const op = c.input.operation ? String(c.input.operation) : "";
          const path = c.input.path ? String(c.input.path) : "";
          const params = c.input.params ? JSON.stringify(c.input.params) : "";
          return `${op}|${path}|${params}`;
        };
        const seenCallKeys = new Map<string, string>();
        const duplicateNotes = new Map<string, string>();
        // 跨轮 Doom Loop 熔断（对齐 OpenCode doom_loop）：连续 ≥3 次「同一业务工具 + 同一入参」→ 判空转
        let lastToolSignature = state.lastToolSignature || "";
        let toolSignatureStreak = state.toolSignatureStreak || 0;
        const TOOL_SIGNATURE = (c: { name: string; input: Record<string, unknown> }): string => {
          if (c.name === CALL_API_TOOL) {
            const op = c.input.operation ? String(c.input.operation) : "";
            const path = c.input.path ? String(c.input.path) : "";
            const params = c.input.params ? JSON.stringify(c.input.params) : "";
            return `${c.name}|${op}|${path}|${params}`;
          }
          return `${c.name}|${JSON.stringify(c.input || {})}`;
        };
        for (const c of state.toolCalls) {
          const key = callApiKey(c);
          if (!key) continue;
          if (seenCallKeys.has(key)) {
            duplicateNotes.set(
              c.id,
              "[workflow/observe] 你并行提交了多个参数完全相同的取数调用，系统已合并执行第一个（见上一条返回）。" +
                "若需更多页数据，请基于返回中的分页信息（如 total/总页数）递增分页参数后再次调用 call_api；" +
                "不要重复相同参数的调用。",
            );
          } else {
            seenCallKeys.set(key, c.id);
          }
        }
        for (const call of state.toolCalls) {
          emitEvent({ type: "tool_call", name: call.name, input: call.input });
          // 思考过程（对齐 DeepSeek「深度思考」）：把 agent 实际操作链以人类可读摘要流向前端，
          // 折叠块内展示。描述取自工具名 + 关键入参，不编造模型未产生的思维链。
          emitEvent({ type: "reasoning", text: describeCallForReasoning(call) });
          // 重复调用：不真正执行，回喂观察提示（模型基于第一个调用返回的分页信息自行决定是否递增）
          if (duplicateNotes.has(call.id)) {
            const note = duplicateNotes.get(call.id)!;
            emitEvent({ type: "tool_result", name: call.name, result: truncateToolResultForUi(note) });
            nextSteps.push({ kind: "toolResult", toolCallId: call.id, content: note });
            continue;
          }
          // 跨轮 Doom Loop 熔断（业务工具签名连续相同 → 空转）：
          // 只对实际执行的业务/探索工具统计（call_api / search_api_module 等），
          // 正确递增分页（page:1→2→3）签名不同会重置，误伤最小。
          const callSig = TOOL_SIGNATURE(call);
          if (callSig === lastToolSignature) {
            toolSignatureStreak += 1;
            if (toolSignatureStreak >= 3) {
              console.log(
                `[chat:doom-loop] 熔断：${call.name} 连续 ${toolSignatureStreak} 次相同入参（${String(callSig).slice(0, 80)}），转服务端兜底`,
              );
              nextSteps.push({
                kind: "system",
                text:
                  "[workflow/doom-loop] 你已连续多次提交相同工具与参数的调用，视为无效空转，本轮将由系统自动执行获取数据。",
              });
            }
          } else {
            lastToolSignature = callSig;
            toolSignatureStreak = 1;
          }

          let content: string;

          if (call.name === CALL_API_TOOL) {
            const gate = await rulesGateBeforeCallApi({
              userText,
              call,
              steps: nextSteps,
              sessionId: session.id,
            });
            if (gate.kind === "retry") {
              // A 方案：模块定位自愈——错误反馈回传模型（不中断 tool-loop），
              // 模型读反馈后重选模块或检索确认，而不是服务端硬反问用户。
              content = `MODULE_RETRY\n${gate.retry}`;
              emitEvent({ type: "tool_result", name: call.name, result: truncateToolResultForUi(content) });
              nextSteps.push({ kind: "toolResult", toolCallId: call.id, content });
              continue;
            }
            // 确定性护栏的非阻断提示（如 POSSIBLE_FILTER_DROPPED / ENUM_VALUE_HINT 类 warn）：
            // 不阻断取数，但作为 tool_result 前缀回传模型，让其在收束前自查。
            if (gate.kind === "ok" && (gate as { warn?: string }).warn) {
              const warnText = (gate as { warn?: string }).warn!;
              emitEvent({ type: "tool_result", name: call.name, result: truncateToolResultForUi(warnText) });
              nextSteps.push({ kind: "toolResult", toolCallId: call.id, content: warnText });
              // 提示后继续执行真实 call_api（不 continue）
            }
            if (gate.kind === "clarification") {
              content = `CLARIFICATION_REQUIRED\n${gate.clarification}`;
              emitEvent({ type: "tool_result", name: call.name, result: truncateToolResultForUi(content) });
              nextSteps.push({ kind: "toolResult", toolCallId: call.id, content });
              clarificationText = gate.clarification;
              break;
            }
          }

          // 写操作强制确认：无论模型是否传 confirm=true，只要判定为写操作就要求用户确认，
          // 防止模型自主路径绕过确认直接执行删除/修改/新增。
          // 写代码/提交工具（write_code_file / git_commit_push）同样无条件确认。
          const method = String(call.input.method || "GET").toUpperCase();
          // 2026-08-25 去写死：写操作判定不再用「method !== GET」一刀切——PC 端读列表接口也常用 POST
          // （如 <模块>/<接口模块>.<读语义统计接口> 设备粘性值列表，defHttp.post）。改按 operation 解析后的
          // 函数名读/写动词语义判定（通用英文命名约定，非业务写死；与 inferCallOperation 的 readOp 前缀
          // 正则一致）：读前缀函数（get/query/list/search/fetch/find/report/stat/count/export）即使 POST
          // 也视为读（不强制确认）；含写动词（create/update/delete/remove/add/insert/set/enable 等）或
          // 无法解析为读接口的非 GET 才强制确认（写安全红线保留）。
          const gateOp = call.name === CALL_API_TOOL && call.input.operation ? resolveApiOperation(String(call.input.operation)) : null;
          const gateFn = gateOp?.func || "";
          const isReadFunc = /^(get|query|list|logs|search|fetch|find|report|stat|count|export)/i.test(gateFn);
          const isWriteFunc = /createOrUpdate|create|save|update|delete|remove|add|insert|set|enable|disable|online|offline|shelf|unshelf/i.test(gateFn);
          const isWriteCall = method !== "GET" && !(isReadFunc && !isWriteFunc);
          const isCodeWrite = CODE_TOOLS.has(call.name);
          // 导出延续场景数据增强：弱模型常传编造/占位 data（或未走 function calling）。
          // 用最近一次服务端渲染的真实数据（session.lastTable）兜底，确保导出的不是假数据。
          if (call.name === "export_dataset" && session.lastTable?.rows?.length) {
            call.input = {
              ...call.input,
              data: session.lastTable.rows,
              columns:
                Array.isArray(call.input.columns) && call.input.columns.length ? call.input.columns : session.lastTable.columns,
              title: call.input.title || session.lastTable.title,
            };
          }
          if (
            (call.name === CALL_API_TOOL && (call.input.confirm === true || isWriteCall)) ||
            isCodeWrite
          ) {
            const callId = call.id;
            const desc =
              call.name === "write_code_file"
                ? String(call.input.description || `写入代码文件 ${call.input.path}`)
                : call.name === "git_commit_push"
                  ? String(call.input.description || `提交并推送代码：${call.input.message}`)
                  : String(call.input.description || `${call.input.method} ${call.input.url}`);
            // 先注册 waiter 再发事件（同 fallback 分支：避免前端立即 confirm 时 waiter 未注册）
            const confirmPromise = waitForConfirmation(session.id, callId, 60000);
            // 写代码/提交工具是高危操作：impact 强制 highRisk（target=目标文件/分支），不套用 call_api 的推导
            const codeImpact =
              call.name === "write_code_file"
                ? { highRisk: true, target: `代码文件 ${call.input.path}`, count: 0 }
                : call.name === "git_commit_push"
                  ? { highRisk: true, target: `分支 ${call.input.branch || "当前分支"}`, count: 0 }
                  : null;
            emitEvent({
              type: "confirmation_required",
              callId,
              name: call.name,
              input: call.input,
              description: desc,
              impact: codeImpact || buildConfirmationImpact(userText, call.input, method),
            });
            const confirmed = await confirmPromise;
            if (!confirmed) {
              content = "用户取消了该操作，未执行。";
            } else {
              content = await runAgentTool(call.name, call.input, toolOpts);
            }
          } else {
            content = await runAgentTool(call.name, call.input, toolOpts);
          }

          emitEvent({ type: "tool_result", name: call.name, result: truncateToolResultForUi(content) });
          // UI 块（表格/图表）先解析上屏（不依赖 steps 是否截断）
          emitUiPayloadsFromToolResult(content, emitEvent);
          // 长结果写文件（探索类）：steps 只放「路径+摘要」索引，模型需要细节时 read_file 按需读
          const persisted = persistToolOutput(call.name, content, call.input);
          if (persisted) content = persisted;
          nextSteps.push({ kind: "toolResult", toolCallId: call.id, content });
          // M1（Supervisor 路由）：route_to_agent 成功命中后从结果标记提取 worker id，贯穿本节点回写 state
          const workerMatch = /\[ACTIVE_WORKER:([^\]]+)\]/.exec(content);
          if (workerMatch) activeWorkerId = workerMatch[1];

          // 探索型工具结果后追加轻量下一步引导（Cursor 式收敛，非服务端硬判）：
          // 业务数据请求下，search/read/grep 返回的只是「候选/接口信息」，仍须 call_api 取数才能作答。
          // 避免弱模型把候选清单/接口源码当最终答案中途收束（2026-08-24 优惠活动配置实测：
          // submit→search 后即结束，未 read/call，34s 内没拿到任何数据）。
          if (!outputReady && !content.startsWith("错误：")) {
            if (EXPLORE_TOOLS.has(call.name)) {
              const understood = findLastUnderstood(nextSteps);
              if (understood?.isBusinessRequest === true) {
                nextSteps.push({
                  kind: "system",
                  text:
                    "[workflow/next] 以上检索结果只是候选/接口信息，不是业务数据。若用户请求的是数据查询/操作，" +
                    "下一步必须调用 call_api（operation 或 path+base）取真实数据；服务端会自动渲染表格，" +
                    "取到数据后再向用户总结。禁止把接口源码/候选清单当答案直接回复用户。",
                });
              }
            }
          }

          if (call.name === "get_page_schema" && !content.startsWith("错误：")) {
            try {
              const parsed = JSON.parse(content) as { pages?: Array<{ primary?: string }> };
              const primary = parsed.pages?.[0]?.primary;
              if (primary) pageKind = String(primary);
            } catch {
              if (/analysis_chart/.test(content)) pageKind = "analysis_chart";
            }
            // 2026-08-26 诊断：pageKind 被设为 analysis_chart 会把列表数据路由到图表分支（无列表表格）
            console.log(`[chat:render] get_page_schema 设置 pageKind=${JSON.stringify(pageKind)}`);
          }

          if (
            (call.name === "normalize_output" || call.name === "render_table" || call.name === "export_dataset") &&
            !content.startsWith("错误：")
          ) {
            outputReady = call.name !== "normalize_output";
            if (call.name === "normalize_output") {
              nextSteps.push({
                kind: "system",
                text:
                  "[workflow/output] normalize_output 已完成。请接着 render_table（预览表，可带 tree/footer）" +
                  "；用户要下载时再 export_dataset(format=xlsx|pdf)。然后用自然语言简短说明，勿再盲目检索。",
              });
            } else {
              nextSteps.push({
                kind: "system",
                text: `[workflow/stop] ${call.name} 已完成（表格/文件已推送到聊天 UI），请直接用自然语言回复用户，禁止再调工具。`,
              });
              outputReady = true;
            }
          }

          // 图表摘要：成功/失败都收束，禁止空转
          if (call.name === "summarize_chart_data") {
            outputReady = true;
            if (content.startsWith("错误：")) {
              nextSteps.push({
                kind: "system",
                text:
                  `[workflow/stop] summarize_chart_data 失败：${content.slice(0, 240)}。` +
                  "请向用户说明无法生成趋势摘要的原因；若已有表格数据可直接展示表，禁止继续盲目 grep。",
              });
            } else {
              nextSteps.push({
                kind: "system",
                text: "[workflow/stop] summarize_chart_data 已完成，请直接用自然语言回复用户（可引用摘要与关键点），禁止再调工具。",
              });
            }
          }

          // call_api 失败：禁止反复换接口空转，下一轮必须向用户说明失败原因
          if (call.name === CALL_API_TOOL && content.startsWith("错误：")) {
            outputReady = true;
            nextSteps.push({
              kind: "system",
              text:
                `[workflow/stop] call_api 已失败：${content.slice(0, 240)}。` +
                "请直接把失败原因告知用户（如登录过期/参数错误），禁止继续盲目 grep 或反复 call_api。",
            });
          }

          if (call.name === CALL_API_TOOL) {
            // 2026-08-26 诊断：渲染分支是否进入的判据——content 前缀形态（错误/澄清/正常数据）
            console.log(
              `[chat:render] call_api content 前缀: ${JSON.stringify(String(content || "").slice(0, 150))}`,
            );
          }
          if (
            call.name === CALL_API_TOOL &&
            !content.startsWith("错误：") &&
            !content.startsWith("CLARIFICATION_REQUIRED")
          ) {
            const op = String(call.input.operation || "");
            // 受控渲染模块 key（2026-08-24 修复）：用索引解析出规范模块名再取文件名段。
            // 弱模型常传点号模块路径 movie.autoUpload.getList，原 op.split(".")[0] 得 "movie"，
            // findConfigFiles 在 views/**/configs.data.tsx 中匹配不到 → 渲染异常 → output-align → final 兜底
            // （影片上传自动化实测：call_api 成功返回 30 条但无表格，155s 后才兜底）。
            const resolvedOpForRender = op
              ? (resolveApiOperation(op) || resolveOperationByApiGrep(op))
              : null;
            // 只传 path 不传 operation 时（弱模型常见）：从 path 反查索引模块，保证渲染分支
            // + list-verify 校验引导不因 module 为空而跳过（2026-08-25 修复：lagunas「影片前2页」
            // 只取第1页收束的根因——resolvedModule="" → 渲染分支跳过 → 模型没看到用户要求回显
            // 与中文表格，无从核对「前2页」）。
            const resolvedModule =
              resolvedOpForRender?.module?.split("/").filter(Boolean).pop() ||
              op.split(".")[0] ||
              (() => {
                const p = String(call.input.path || "");
                return p ? (resolveApiOperationByPath(p) || resolveApiOperationByPathSuffix(p))?.module?.split("/").filter(Boolean).pop() || "" : "";
              })();

            // Validate 环节：渲染前预检返回结构，异常（空/非 JSON）提示模型说明，
            // 禁止把原始异常内容透传上屏或盲目重试（Cursor 分层规划 Validate 的轻量版）
            const shapeIssue = validateApiResultShape(content);
            // 2026-08-26 诊断：列表渲染分支是否被 validate 拦截（content 纯 JSON 也被拦即 bug）
            console.log(
              `[chat:render] validate 结果: shapeIssue=${JSON.stringify(shapeIssue)} len=${String(content || "").length} head=${JSON.stringify(String(content || "").slice(0, 60))}`,
            );
            if (shapeIssue) {
              outputReady = true;
              nextSteps.push({
                kind: "system",
                text:
                  `[workflow/validate] call_api 返回结构校验未通过：${shapeIssue}。` +
                  "请向用户说明数据异常（接口可能已变更或未登录），禁止直接透传原始返回内容、禁止反复重试。",
              });
            } else {
            // 登录数据统计：不再特判——通用 analysis_chart 链路（presentGenericChart）已覆盖，
            // 实时读 PC configs.data.tsx + resolveI18nTitle 可还原「谷歌登录成功总数」等中文列。
            // （历史特例 presentLoginDataTotal/enrichLoginDataTotalParams/isLoginDataTotalCall 已删除）
            // 2026-08-26 修复：列表数据被误路由到图表分支（模型并行 get_page_schema 把 pageKind
            // 设为 analysis_chart）→ presentGenericChart 对普通列表返回 null → 只提示模型自理 →
            // 模型自己 markdown 编表。修复：图表优先（presentGenericChart 能生成数值序列图表才走），
            // 图表失败且有列表行 → 回退列表受控渲染；两者都不是 → output-align（纯结构判定）。
            const listRows = extractListRowsFromContent(content);
            const chartRows = extractReportRows(content);
            const chartPresented =
              pageKind === "analysis_chart" && chartRows.length
                ? presentGenericChart(chartRows, resolvedModule)
                : null;
            if (chartPresented) {
              // 通用报表/图表（2026-08-24 去写死）：仅当模型主动提交 pageKind=analysis_chart 且
              // 数据非列表结构时走 ECharts 图表渲染（presentGenericChart 通用链路），服务端不再
              // 按接口名正则猜报表（原 isAnalysisReportOperation 写死片段已删）。
              emitUiPayloadsFromToolResult(chartPresented.tableBlock, emitEvent);
              emitUiPayloadsFromToolResult(chartPresented.chartUiBlock, emitEvent);
              nextSteps.push({
                kind: "system",
                text: `[workflow/pc-parity] 已按 PC 报表口径自动对齐表头与 ECharts 图。\n${chartPresented.reply}`,
              });
              forcedReply = chartPresented.reply;
              outputReady = true;
            } else {
              // 列表（多行数据）受控渲染 + 数据回喂模型校验（方案 A，2026-08-24 对齐 Cursor）：
              // 服务端只做「展示渲染」（表格上屏 + 中文列对齐），不再 forcedReply 跳过模型——
              // 渲染表格作为真实数据回喂模型，由模型校验对比用户输入值（页数/条数/筛选条件）后
              // 自主总结收束（Cursor 语义：模型是数据的最终校验者与回答生成者，服务端只兜底）。
              // 2026-08-26 诊断：区分「渲染分支未进入」与「渲染失败」，定位影片列表无表格
              console.log(
                `[chat:render] 列表分支: listRows=${listRows ? (Array.isArray(listRows) ? `array/${listRows.length}` : "obj") : "null"} resolvedModule=${JSON.stringify(resolvedModule)} pageKind=${JSON.stringify(pageKind)}`,
              );
              if (listRows && resolvedModule) {
                try {
                  // 筛选条件摘要：从 call_api 的 params 提取 key=value（通用契约，不写死业务词），
                  // 传入渲染层体现在表格 caption，让用户/模型一眼看到本次取数是否带了筛选条件。
                  // 若 params 无筛选键（仅分页/通用参数），filterSummary 为空 → caption 不显示筛选。
                  const rawParams = (call.input.params && typeof call.input.params === "object" ? call.input.params : {}) as Record<string, unknown>;
                  const genericParamRe = /^(page|pageNum|pageSize|size|current|limit|sort|order|orderBy|asc|desc|token|lang|country|pageIndex)$/i;
                  const filterParts = Object.entries(rawParams)
                    .filter(([k, v]) => !genericParamRe.test(k) && v != null && v !== "")
                    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
                  const filterSummary = filterParts.length ? filterParts.join("，") : undefined;
                  const rendered = await renderListForAgent(listRows, resolvedModule, filterSummary);
                  // 1) 上屏延迟（对齐 Cursor 数据处理）：多页数据暂存 pendingTables，final 收束时
                  //    按 columns 合并且只上屏一张总表（原实现每页立即 emit UI_TABLE → 5 页 = 5 张分表）。
                  //    回喂模型的校验表格仍逐页给（见 2），不影响模型自主分页。
                  pendingTables.push(rendered.view);
                  // 2) 数据回喂：call_api 原始 toolResult 替换为渲染后的中文 markdown 表格（模型直接看真实数据）
                  const idx = nextSteps.findIndex((s) => s.kind === "toolResult" && s.toolCallId === call.id);
                  if (idx >= 0) nextSteps[idx] = { kind: "toolResult", toolCallId: call.id, content: rendered.md };
                  // 3) 校验引导：模型基于真实数据校验对比输入值，符合则总结收束，不符合可补取。
                  //    用户原始要求原样回显（薄 prompt）：给模型明确的核对基准（页数/条数/筛选条件/
                  //    字段范围），逐项比对已渲染数据，避免模型「拿到的不是用户要的」也照常收束。
                  //    回显用户原话是上下文注入（非词形判定），不违反「全部由大模型判断」红线。
                  const missing = [...(rendered.needsModelMapping || []), ...(rendered.needsValueMapping || [])].join("、");
                  // 字段差异清单（2026-08-26）：PC 列定义 vs 接口返回数据的结构差异，显式回喂模型校对。
                  // pcMissing=PC 端有但接口返回缺（空列）；dataExtra=接口返回有但 PC 端未定义列（未展示）。
                  // 由模型裁决：缺字段是接口不对/参数缺/嵌套未展平需补取，还是如实说明；多余字段是否有价值。
                  const fd = rendered.fieldDiff;
                  const diffText = fd
                    ? `【字段差异校对】服务端比对了 PC 端列定义与接口返回字段：\n` +
                      (fd.pcMissing.length ? `- PC 端有定义但接口返回缺失：${fd.pcMissing.join("、")}（已渲染为空列）——请判断是接口不对、缺参数还是嵌套结构未展平，需补取请调 call_api\n` : "") +
                      (fd.dataExtra.length ? `- 接口返回有但 PC 端未定义：${fd.dataExtra.join("、")}（未展示）——请判断是否用户关注字段，需展示可调 render_table\n` : "")
                    : "";
                  // 硬结算清单（对齐 Cursor subagent 自校验 / Claude Code ExitPlanMode 前必须总结）：
                  // 把「请核对」升级为「必须按固定格式输出逐项结论」，模型被迫显式陈述而非内心默念，
                  // 缺任一结论视为未通过、继续补取或反问（仍是 prompt 引导、判定交模型，不写死业务词）。
                  nextSteps.push({
                    kind: "system",
                    text:
                      `[workflow/list-verify] 用户原始要求：${userText}\n` +
                      `以上是服务端按 PC 列定义渲染的真实数据表格（共 ${rendered.view.total} 条）` +
                      (missing ? `；以下字段未能在源码提取到中文映射，已如实展示原文：${missing}` : "") +
                      (diffText ? `\n${diffText}` : "") +
                      `。请在收束前**按以下固定格式输出校验结论**（缺一项视为未通过，继续调 call_api 补取或调 request_clarification 反问）：\n` +
                      `【校验结论】\n` +
                      `- 传入筛选参数：{列出本次 call_api 实际 params 中的筛选键=值；若用户原话有筛选条件但未传入，须显式写明「未传入」}\n` +
                      `- 返回数据体现该筛选：是/否（如否，说明实际返回的是全量还是错误对象，并继续补取正确接口）\n` +
                      `- 业务对象匹配：{返回记录类别} ↔ 用户请求 {target}\n` +
                      `- 页数/条数：要求 {X} ↔ 实际 {Y}（Y 不足则继续分页补取）\n` +
                      `- 字段覆盖：{已覆盖字段}；{用户关注的字段是否都在}\n` +
                      (fd ? `- 字段差异裁决：{对上述 PC 端缺失/多余字段的逐项判断与处理结论}\n` : "") +
                      `- 结论：通过 / 需补取 / 需反问\n` +
                      `表格数据已由系统渲染并上屏展示给用户，**你的最终回复不要再重复输出表格明细**，` +
                      `仅输出上述校验结论与简要说明（如数据规模/关键发现/是否需要补取）；禁止编造数据、禁止重复调同一接口取相同参数。`,
                  });
                  // 不设 outputReady/forcedReply → 回 understand 由模型自主校验并总结收束（Cursor 模型驱动收束）
                } catch (e) {
                  // 列表渲染失败（模块无列定义等）→ 走 output-align 提示模型自行处理。
                  // 2026-08-26 诊断：曾静默吞错导致「影片列表前2页无表格」排查困难——渲染失败必须留痕。
                  console.error(
                    `[chat:render] renderListForAgent 失败 module=${resolvedModule} listRowsType=${Array.isArray(listRows) ? `array/${listRows.length}` : typeof listRows}`,
                    e instanceof Error ? e.message : String(e),
                  );
                  nextSteps.push(
                    outputAlignStep("call_api 已返回列表数据，先 normalize_output 对齐字段，再用 render_table 推送到聊天预览。", resolvedModule),
                  );
                }
              } else {
                // 详情（单条对象）兜底渲染：服务端强制按 PC formSchema 渲染两列表格，
                // 禁止模型自行编表（防止编造字段、把 terminalFlag 位掩码简写成 "all"）。
                // 与报表/登录统计的 forcedReply 机制一致：渲染完成后直接作为最终回复。
                const detailPayload = extractSingleDetailPayload(content);
                if (detailPayload && resolvedModule) {
                try {
                  const rendered = await renderDetailForAgent(detailPayload, resolvedModule);
                  // 方案 A（对齐 Cursor）：详情同样数据回喂模型校验总结，不再 forcedReply 跳过模型
                  emitUiPayloadsFromToolResult(`UI_TABLE\n${JSON.stringify(rendered.view)}\n`, emitEvent);
                  // 缓存最近渲染数据（导出延续场景兜底）
                  session.lastTable = {
                    title: rendered.view.title,
                    columns: rendered.view.columns,
                    rows: rendered.view.rows,
                    total: rendered.view.total,
                    at: Date.now(),
                  };
                  const idx = nextSteps.findIndex((s) => s.kind === "toolResult" && s.toolCallId === call.id);
                  if (idx >= 0) nextSteps[idx] = { kind: "toolResult", toolCallId: call.id, content: rendered.md };
                  const missing = [...(rendered.needsModelMapping || []), ...(rendered.needsValueMapping || [])].join("、");
                  // 详情字段差异清单（同列表语义）：formSchema 定义 vs 返回对象字段
                  const fd = rendered.fieldDiff;
                  const diffText = fd
                    ? `【字段差异校对】服务端比对了 PC 端 formSchema 与接口返回字段：\n` +
                      (fd.pcMissing.length ? `- PC 端有定义但接口返回缺失：${fd.pcMissing.join("、")}（已显示占位"-"）——请判断是否接口不对/缺参数，需补取请调 call_api\n` : "") +
                      (fd.dataExtra.length ? `- 接口返回有但 PC 端未定义：${fd.dataExtra.join("、")}（已补充展示）——请判断是否用户关注字段\n` : "")
                    : "";
                  nextSteps.push({
                    kind: "system",
                    text:
                      `[workflow/detail-verify] 用户原始要求：${userText}\n` +
                      `以上是服务端按 PC 端 formSchema 渲染的真实单条数据表格` +
                      (missing ? `；以下字段未能在源码提取到中文映射，已如实展示原文：${missing}` : "") +
                      (diffText ? `\n${diffText}` : "") +
                      `。请核对「用户原始要求」与以上记录是否对应（业务对象类别是否对应请见 [workflow/tool-calling] 第5条）：\n` +
                      `① 业务对象语义匹配：该记录类别是否与用户请求一致；\n` +
                      `② ID/关键字段是否匹配：符合则简要说明后收束；不符合可继续调 call_api 补取。\n` +
                      `③ 字段差异裁决：{对上述 PC 端缺失/多余字段的逐项判断}\n` +
                      `单条数据已由系统渲染并上屏展示，最终回复不要再重复输出表格明细，仅简要说明关键字段与结论；` +
                      `禁止编造字段、禁止重复调同一接口。`,
                  });
                  // 不设 outputReady/forcedReply → 回 understand 由模型自主校验并总结收束
                } catch {
                  nextSteps.push(
                    outputAlignStep("call_api 已返回数据，先 normalize_output 对齐字段，再用 render_table 推送预览（树表传 tree/children，汇总传 footer）；用户要 Excel/PDF 时调用 export_dataset。", resolvedModule),
                  );
                }
              } else {
                nextSteps.push(
                  outputAlignStep("call_api 已返回数据，先 normalize_output 对齐字段，再用 render_table 推送预览（树表传 tree/children，汇总传 footer）；用户要 Excel/PDF 时调用 export_dataset。", resolvedModule),
                );
              }
            }
            } // 列表/详情受控渲染 else 闭合（含 chartPresented 图表优先）
          }
          } // CALL_API_TOOL if 闭合
          if (content.startsWith("CLARIFICATION_REQUIRED")) {
            clarificationText = content.replace(/^CLARIFICATION_REQUIRED\s*/, "").trim();
            break;
          }
        }
        return {
          steps: nextSteps,
          toolCalls: [],
          round: state.round + 1,
          needsClarification: Boolean(clarificationText),
          clarificationText,
          outputReady,
          forcedReply,
          pageKind,
          pendingTables,
          lastToolSignature,
          toolSignatureStreak,
          doomLoopExhausted: toolSignatureStreak >= 3,
          // M1（Supervisor 路由）：route_to_agent 命中后把 worker id 写回 state，后续 understand 自动裁剪工具
          activeWorkerId: activeWorkerId ?? state.activeWorkerId,
        };
      })
      .addNode("final", async (state) => {
        // 对齐 Cursor 数据处理：分页期间暂存的多张表 → 按 columns 合并为一张总表一次性上屏
        // （写 session.lastTable，导出延续场景同样拿全量数据）。任何收束路径都先落盘，避免模型中途
        // 被迫收束时用户已获取的页丢失。
        flushPendingTables(state.pendingTables, session, emitEvent);
        if (state.needsClarification && state.clarificationText) {
          return { text: renderClarificationForUser(`CLARIFICATION_REQUIRED\n${state.clarificationText}`) };
        }
        if (state.forcedReply?.trim()) return { text: state.forcedReply };

        // 输出校验（Guardrail）：模型误输出裸 JSON / 工具计划 / 澄清 JSON 时统一拦截，
        // 禁止把未加工内容上屏；有工具结果则走 synthesized 合成兜底。
        if (state.text?.trim()) {
          const hasToolResults = (state.steps || []).some((s) => s.kind === "toolResult");
          const v = validateFinalText(state.text);
          if (v === "tool-call" && !hasToolResults) {
            // 原始 JSON 是工具调用描述，但未被执行 → 清空，走下面的 synthesized 兜底
            return { text: "" };
          }
          if (v === "clarification" && !hasToolResults) {
            // 模型把 parse_intent 的 CLARIFICATION_REQUIRED JSON 当最终文本输出（未走 request_clarification 工具）：
            // {"intent":"解析用户意图","missingSlots":["module"],"question":"你要操作哪个模块？",...}
            // 应渲染成友好澄清问题，而不是把裸 JSON 展示给用户。
            return { text: renderClarificationForUser(`CLARIFICATION_REQUIRED\n${state.text}`) };
          }
          if (v === "bare-json") {
            // 其他裸 JSON（如接口原始返回被模型直接透传）：一律清空，走 synthesized 合成兜底
            return { text: "" };
          }
          // 伪调用拦截（对齐 Cursor「工具调用必须走函数调用通道」协议护栏）：
          // 模型把工具调用写成文本（JSON/XML/方括号）而非真实 function call，属泄漏，禁止上屏。
          // 区分两类形态避免误伤闲聊/知识库的正常举例：
          //  - XML 形态伪调用（含 <tool_call> / <function=工具名> / <parameter=...> 标签）：必是工具调用模拟，
          //    无论是否真调过业务工具，一律强制清空 → 走下方 synthesized / 兜底文案（2026-08-26 修复：
          //    req1385 实测弱模型把 call_api 写成 <tool_call><function=call_api>... 文本，businessToolCalled=false
          //    导致原 businessToolCalled 闸门失效、伪 XML 直接泄漏上屏）。
          //  - 纯 JSON 形态（{"tool":...} / {"tool_calls":...} 无 XML 标签）：非业务场景下模型常顺带举例接口 JSON
          //    （如 {"module":"user","operation":"list"}），属正常说明，仅当「真调过业务工具却只给计划」才清空。
          // 判定信号改由「模型是否真调业务工具」驱动（businessToolCalled），不再用写死中文动词预判（已删除）。
          // 业务工具判定集收敛为模块级 BUSINESS_TOOLS（从注册表派生，新增工具自动纳入）。
          const businessToolCalled = (state.toolCalls || []).some((tc) => BUSINESS_TOOLS.has(tc.name));
          const isXmlPseudoCall = /<\s*tool_call\s*>|<[\w-]+\s*=\s*(?:search_api_module|read_api_module|call_api|grep_codebase|submit_understood_intent|request_clarification|export_dataset)\b/.test(state.text);
          if (v === "pseudo-plan" && !hasToolResults) {
            if (isXmlPseudoCall) {
              // XML 形态伪调用：强制清空，禁止泄漏上屏（2026-08-26 修复核心）
              return { text: "" };
            }
            // 导出伪调用兜底（弱模型把 export_dataset 写成 XML/文本而未真正 function call）：
            // 若会话缓存有最近渲染数据 → 服务端自动执行导出（用户直接拿到文件，不依赖模型自觉）。
            if (/<export_dataset/.test(state.text)) {
              const lt = session.lastTable;
              if (lt && lt.rows?.length) {
                try {
                  const out = await execExportDataset({
                    data: lt.rows,
                    columns: lt.columns,
                    title: lt.title,
                    format: "xlsx",
                  });
                  // UI 块（表格预览 + 下载文件）上屏
                  emitUiPayloadsFromToolResult(out, emitEvent);
                  return {
                    text: `已根据最近查询的数据自动生成 Excel 文件（共 ${lt.total} 条），可在聊天中预览与下载。`,
                  };
                } catch (e) {
                  return { text: "导出失败：" + (e instanceof Error ? e.message : String(e)).slice(0, 300) };
                }
              }
              return { text: "请先查询数据（如「XX列表」）获取表格后，再说「导出 Excel」即可生成文件。" };
            }
            if (businessToolCalled) return { text: "" };
          }
          // 导出意图最终兜底（弱模型把「导出」理解成重新查询/伪调用绕路，始终不真调 export_dataset）：
          // 用户明确要求导出/下载表格 + 会话有最近渲染数据 + 模型本轮未走 export_dataset → 服务端自动导出。
          if (
            session.lastTable?.rows?.length &&
            /导出|下载\s*(?:excel|xlsx|表格|文件)/i.test(userText) &&
            !(state.toolCalls || []).some((tc) => tc.name === "export_dataset")
          ) {
            try {
              const out = await execExportDataset({
                data: session.lastTable.rows,
                columns: session.lastTable.columns,
                title: session.lastTable.title,
                format: "xlsx",
              });
              emitUiPayloadsFromToolResult(out, emitEvent);
              return {
                text: `已根据最近查询的数据自动生成 Excel 文件（共 ${session.lastTable.total} 条），可在聊天中预览与下载。`,
              };
            } catch (e) {
              console.error("[chat:export] 自动导出失败:", e instanceof Error ? e.message : String(e));
            }
          }
          return {};
        }
        const toolResults = (state.steps || [])
          .filter((s): s is Extract<AgentStep, { kind: "toolResult" }> => s.kind === "toolResult")
          .map((s) => s.content);
        const synthesized = synthesizeReplyFromToolResults([
          ...toolResults,
          ...((state.steps || [])
            .filter((s): s is Extract<AgentStep, { kind: "system" }> => s.kind === "system")
            .map((s) => s.text)),
        ]);
        if (synthesized) return { text: synthesized };

        const lastApiErr = [...toolResults].reverse().find((c) => c.startsWith("错误："));
        if (lastApiErr) {
          return {
            text: `接口调用未成功：${lastApiErr.replace(/^错误：/, "").slice(0, 400)}。请检查登录状态或换种说法重试。`,
          };
        }
        const hasTools = toolResults.length > 0;
        // 兜底文案（方案 C）：业务/闲聊判别已 100% 交模型，此处仅按是否产生过工具结果分流，
        // 避免误导（非业务走到这里同样是无结果，统一友好兜底）。
        if (hasTools) {
          return {
            text: "已完成若干工具调用，但未能生成最终说明。请换种说法重试，或直接指定模块与操作（如：XX模块列表）。",
          };
        }
        return {
          text: "抱歉，我暂时无法回答这个问题。如需查询业务数据，请明确模块与操作（如：XX列表、XX统计）。",
        };
      })
      .addEdge(START, "preprocess")
      .addEdge("preprocess", "understand")
      // understand 节点后的流转：用条件边表达「为何还在循环」，而非计数器硬上限。
      // 三种出口：模型失败/KB短路→END（直接答复）；无工具但未达上限→understand 自循环（agent 自主续探）；
      // 已产出工具调用→tool（进入执行编排）。
      .addConditionalEdges("understand", (state) => {
        if (state.cancelled) return END;
        // 伪调用耗尽（对齐 Cursor 确定性回退）：模型多次文本模拟工具调用 → 不再续探，
        // 强制 final，主流程据此走服务端规则编排拿真实数据（弱模型门槛）。
        if (state.pseudoPlanExhausted) return "final";
        // 跨轮 Doom Loop 熔断（对齐 OpenCode doom_loop）：同一工具+同一入参连续 ≥3 次 → 判空转，
        // 不再续探，强制 final 走服务端兜底拿数据。
        if (state.doomLoopExhausted) return "final";
        // 模型失败（如 402 额度耗尽）或服务端已产出 forcedReply：直接收束，主流程统一返回错误/答案
        if (state.modelError || state.forcedReply?.trim()) return "final";
        // 服务端判定数据已就绪（outputReady：列表/详情/报表已受控渲染或模型已收束）→ final。
        // 这是对齐 Cursor 的「受控渲染完成后强制收束」——服务端知道什么时候任务完成了，
        // 不依赖模型自觉结束。
        if (state.outputReady === true) return "final";
        // 对齐 Cursor 的"模型自主驱动循环"：模型在理解阶段可显式请求"再检索/再确认"——
        // 通过返回文本信号（NEED_RETRY）主动触发 understand 自循环，而不只是看 toolCalls 数。
        // 这是 Cursor tool-loop 里"模型自己说再调一次"的等价表达。硬上限仍作安全护栏。
        // 工具循环上限用 round（tool 节点执行轮数）控制：Cursor agent 是"模型驱动多轮直到拿到结果"，
        // 硬上限只是安全护栏（防模型失控死循环）。不用 understandAttempts 限——它在每次回 understand
        // 都 +1（含工具执行后的续探），用它限会过早耗尽续探能力。
        // understandAttempts 仅保留给「首轮理解」空转场景（见下方首轮 retry 判断）。
        // 防死循环：模型已给出最终总结文本（非 NEED_RETRY 信号）且本轮无工具调用 → 视为已收束，
        // 不再续探（否则模型每轮输出总结但永不调工具会无限循环，直到 round 上限才被强制打断）。
        const modelAskedRetry = /NEED_RETRY|需要再检索|我需要确认|信息不足/.test(state.text || "");
        const gaveFinalText = Boolean((state.text || "").trim()) && !modelAskedRetry && !state.toolCalls.length;
        // ⚠️ 顺序关键（2026-08-24 修复 understand 空转死循环）：必须先执行工具、再判断续探。
        // 有工具调用 → 进入 tool 节点执行（round 在 tool 末尾 +1，执行完由 tool 条件边回 understand 续探）。
        // 若续探判断抢在前：有工具调用也回 understand → 工具永不执行、round 永不递增 →
        // understand 空转死循环直到 LangGraph recursionLimit 抛错（实测「影片上传自动化」26 轮 52 步卡死 4 分钟）。
        if (state.toolCalls.length) return "tool";
        // 无工具调用：模型给出最终总结文本（非 NEED_RETRY 信号）→ 视为已收束，不再续探
        // （否则模型每轮输出总结但永不调工具会无限循环，直到 round 上限才被强制打断）。
        if (gaveFinalText) {
          // 业务请求未取数护栏（2026-08-24）：submit 已确认业务意图、但从未成功 call_api 取数
          // 就文本收束（弱模型把 submit 当最终动作，7s 结束用户拿不到数据）→ 回 understand 续探，
          // 最多 2 次（understandAttempts<3），仍收束则放行 final 兜底，防死循环。
          const understood = findLastUnderstood(state.steps || []);
          const businessPending =
            understood?.isBusinessRequest === true &&
            !hasSuccessfulApiCall(state.steps || []) &&
            !state.outputReady &&
            !state.forcedReply;
          if (businessPending) return "understand";
          return "final";
        }
        // 无工具调用：模型显式请求再检索（NEED_RETRY 信号）→ 回 understand 再理解（带重试提示），未达上限才允许
        if (modelAskedRetry && state.round < MAX_TOOL_ROUNDS) return "understand";
        // 无工具调用且无最终文本（空响应）：上游模型/网关偶发返回空流（zen 免费链不稳定，同样请求
        // 重试一次往往就正常返回工具调用；日志证实 22 工具下多次调用时而空、时而成功）→ 首轮重试，
        // 避免空流直接落到 final 兜底「无法回答」。仅当 understandAttempts 未达上限且未超轮次才回 understand，
        // 防空转死循环；伪计划被清空（text 亦为空）时重试也安全（模型再理解一次，多次仍空则收束兜底）。
        if (
          !state.text?.trim() &&
          !state.toolCalls.length &&
          (state.understandAttempts || 0) < 3 &&
          state.round < MAX_TOOL_ROUNDS
        ) {
          return "understand";
        }
        return "final";
      })
      .addConditionalEdges("tool", (state) => {
        if (state.cancelled) return END;
        if (state.needsClarification) return "final";
        // round 在 tool 末尾已 +1；达到上限则收束，避免与 recursionLimit 赛跑
        if (state.round >= MAX_TOOL_ROUNDS) return "final";
        return "understand";
      })
      .addEdge("final", END)
      .compile();

    // workflow：LLM 先行（tools/skill/MCP）→ 规则门（call_api 前）
    // 注：候选模块 / resident rules / skills 注入已迁移至 preprocess 节点（图第一个节点），
    // 此处不再重复拼装 initialSteps；understand 节点首轮直接消费 state.initialSteps。

    // 模型级门槛（对齐 Cursor「Agent 模式对模型有硬性要求，弱模型只开放普通对话」）：
    // MODEL_<ID>_AGENT=false 的模型不进多轮工具循环，直接一次模型调用生成纯文本回复。
    // 配置化能力声明（非语义判定），当前默认全部开启保持现状，供强模型可用后标注弱模型。
    if (!model.agentCapable) {
      console.log(`[chat:agent] 模型 ${model.id} 无 agent 能力（MODEL_${model.id.toUpperCase()}_AGENT=false），走纯问答`);
      const light = await callAgentSafe(model, turns, rawImages, [], [], signal, {
        systemExtra: buildStaticGuide(session),
      });
      const text = (light.text || "（模型未返回有效回复，请重试或更换模型。）").slice(0, config.contextMaxChars);
      session.messages.push({ role: "assistant", text });
      touchSession(session);
      yield { type: "text", text };
      return; // finally 统一发 done
    }

    // Agent 自主续探后每轮可能 understand→tool→understand（条件边回跳）≈ 3 步/轮，
    // 再加首轮重试与 final。recursionLimit 必须 > 3*MAX_TOOL_ROUNDS，否则 GraphRecursionError
    // 先抛（实测 36 达上限抛错 → orchestrate 兜底反问，正是「用户列表」2 事件 DONE 的根因）。
    const recursionLimit = MAX_TOOL_ROUNDS * 3 + 10;
    let graphDone = false;
    let graphError: unknown;
    const invokePromise = graph.invoke(
      {
        round: 0,
        steps: [],
        initialSteps: [],
        understandAttempts: 0,
        toolCalls: [],
        text: "",
        clarificationText: "",
        needsClarification: false,
        cancelled: false,
        outputReady: false,
        // forcedReply 由 tool 节点受控渲染（列表/详情/报表）写入，服务端确认结果已就绪后直接短路收束。
        forcedReply: "",
        pageKind: "",
        pseudoPlanExhausted: false,
        staticGuide: "",
        lastToolSignature: "",
        toolSignatureStreak: 0,
        doomLoopExhausted: false,
        // M1（Supervisor 路由）：初始未路由，工具全量可见；route_to_agent 命中后 understand 自动裁剪
        activeWorkerId: null,
      },
      { recursionLimit },
    );
    invokePromise.finally(() => {
      graphDone = true;
    });

    // 在 graph 运行期间实时把队列里的事件 yield 给前端（打字机/工具进度等）
    while (!graphDone || eventQueue.length) {
      if (eventQueue.length) {
        yield eventQueue.shift()!;
      } else {
        await new Promise((r) => setTimeout(r, 8));
      }
    }
    // 等待 graph 结果；错误暂存后交由外层 catch（大 try 486）统一处理
    let loopState: Awaited<typeof invokePromise> | undefined;
    try {
      loopState = await invokePromise;
    } catch (e) {
      graphError = e;
    }
    if (graphError) throw graphError;
    const ls = loopState!; // graphError 为空说明已成功赋值
    ls_ = ls;

    if (ls.cancelled) return; // 用户已取消：不把半截结果写入会话历史

    // 模型调用失败（如 402 额度耗尽）：统一返回错误提示，禁止走业务 fallback 反问无关模块（误导用户）。
    // 这里拦截 graph 内部已捕获的 modelError；若错误未被 graph 捕获而抛到外层，则由下方 catch 的 isQuotaError 兜底。
    if (ls.modelError) {
      const quotaPattern = /401008|quota|exhausted|额度|后付费|postpaid/i;
      if (quotaPattern.test(ls.modelError)) {
        const quotaMsg =
          "模型服务调用失败：HTTP 402，免费体验额度已耗尽且未开启后付费（401008）。" +
          "请前往腾讯云 TokenHub 控制台（https://console.cloud.tencent.com/tokenhub/inference，广州地域）为模型开启后付费计费后重试。";
        session.messages.push({ role: "assistant", text: quotaMsg });
        yield { type: "error", message: quotaMsg, code: "MODEL_QUOTA_EXHAUSTED" };
        return;
      }
      // 非额度类模型错误（如网络异常）：也直接如实返回，不走误导性的业务反问
      const errMsg = `模型服务调用失败：${ls.modelError.slice(0, 300)}`;
      session.messages.push({ role: "assistant", text: errMsg });
      yield { type: "error", message: errMsg, code: "MODEL_CALL_FAILED" };
      return;
    }

    // 服务端兜底编排：业务请求命中但模型整轮未真正调用任何工具（仅输出计划/说明文本、或编造接口）时，
    // 主动走规则编排执行真实接口，确保返回真实数据而非模型编造。不依赖模型自觉。
    // write（增/改/删）意图无条件走规则编排：模型自主常陷入工具循环（缺参数反复试探），
    // 规则编排能确定性地 POST + 回读并如实回显或澄清，禁止模型自由发挥。
    let text = ls.text;
    // forcedReply 已由 tool 节点受控渲染设置（analysis_chart 图表已上屏时的服务端拼好总结）：
    // 直接用它作为最终回答，不进入业务 fallback（避免图表场景被业务兜底路径劫持报错）。
    const forcedReplyHandled = Boolean(ls.forcedReply?.trim());
    if (forcedReplyHandled) {
      text = ls.forcedReply;
    } else {
      // 业务探索护栏（方案 C）：触发条件完全由模型信号驱动，不依赖任何服务端写死预判 bool。
      // 模型本轮真的调过业务工具（call_api / search_api_module / read_api_module / grep_codebase）
      // 或显式 write 意图（writeForce）才走服务端 fallback。纯闲聊句首轮 required 仅调
      // submit_understood_intent 后文本收束，businessToolCalled 为 false → 不进兜底（避免多一次模型延迟、
      // 且对"你好"等落"未能理解"怪文案）。意图判别 100% 交模型，服务端不再用中文动词白名单抢路由。
      const businessToolCalled = (ls.toolCalls || []).some((tc) => BUSINESS_TOOLS.has(tc.name));
      // 写意图判定（模型信号驱动，2026-08-24 去写死）：模型在 submit_understood_intent 提交的
      // operationType==="write" 即视为写操作（服务端不再用中文写词预判）。
      const writeForce = findLastUnderstood(ls.steps || [])?.operationType === "write";
      // 伪调用耗尽 / Doom Loop 熔断（确定性回退）：模型多次文本模拟工具调用未走 function calling，
      // 或同一工具+入参连续重复空转 → 即使 businessToolCalled 为 false 也强制服务端规则编排兜底。
      if (businessToolCalled || writeForce || ls.pseudoPlanExhausted || ls.doomLoopExhausted) {
        // 有无「API 数据产出」：call_api 成功结果（JSON/已对齐/UI_TABLE/表格），
        // 排除探索类 toolResult（[源码定位]/未找到匹配/错误）——否则模型「submit→search→直接结束」
        // 时 search 结果被误当产出，final 合成失败抛「已完成若干工具调用」兜底文案（实测失败路径）。
        const hasApiData = (ls.steps || []).some((s) => {
          if (s.kind !== "toolResult" || !s.content) return false;
          const c = s.content;
          if (c.startsWith("[源码定位]") || c.startsWith("未找到匹配") || c.startsWith("错误：")) return false;
          return (
            c.includes("[已对齐 PC 端字段") ||
            c.includes("UI_TABLE") ||
            c.includes("【表格输出") ||
            c.includes("【图表摘要") ||
            /^\s*[\[{]/.test(c.trim())
          );
        });
        if (!hasApiData || writeForce) {
          // 写操作（增/改/删）在服务端兜底执行前必须经用户确认：
          // 服务端兜底路径（runServerFallback → orchestrate）没有 tool 节点的确认机制，
          // 若模型未传 confirm=true 会绕过确认直接 POST。这里统一在 fallback 前拦截确认。
          let confirmed = true;
          if (writeForce) {
            const confirmCallId = `fb-${randomUUID()}`;
            // 先注册 waiter 再发事件：避免前端收到 confirmation_required 后立即 confirm 时
            // waiter 尚未注册导致 resolveConfirmWaiter 返回 false（超时后误判"未确认"）。
            const confirmPromise = waitForConfirmation(session.id, confirmCallId, 60000);
            // fallback 阶段 graph 已结束、eventQueue 消费循环已退出，事件必须直接 yield 给前端，
            // 否则推入 eventQueue 的 confirmation_required 永远不会被消费（前端收不到 → 60s 超时误判取消）。
            yield {
              type: "confirmation_required",
              callId: confirmCallId,
              name: CALL_API_TOOL,
              input: { operation: "server-fallback-write", description: userText },
              description: userText,
              impact: buildConfirmationImpact(userText, {}, "POST"),
            };
            confirmed = await confirmPromise;
          }
          if (!confirmed) {
            text = "你取消了该操作，未执行。";
          } else {
            const result = await runServerFallback({
              userText,
              llmSteps: ls.steps,
              session,
              eventQueue,
              onEvents: (ev) => eventQueue.push(ev),
            });
            if (result.text != null) text = result.text;
            if (result.clarificationText) {
              console.error(`[chat:main-fallback] "${userText}" 产出澄清（graph 正常返回、未抛异常）`);
              ls.needsClarification = true;
              ls.clarificationText = result.clarificationText;
              // 澄清直接作为最终回答展示给用户（而非模型计划文本/裸 JSON）：
              // 用 renderClarificationForUser 渲染成友好问题（缺槽位 + 可选项列表），禁止把 parse_intent JSON 上屏。
              text = renderClarificationForUser(`CLARIFICATION_REQUIRED\n${result.clarificationText}`);
            }
          }
        }
      }
      // 纯 submit_understood_intent 后文本收束（闲聊/概念咨询）：保留模型原始友好回复，跳过兜底。
    }
    if (ls.needsClarification && ls.clarificationText) {
      const parsed = parseClarificationPayload(`CLARIFICATION_REQUIRED\n${ls.clarificationText}`);
      if (parsed) {
        session.pendingClarification = {
          ...parsed,
          id: randomUUID(),
          createdAt: Date.now(),
          turns: 0,
        };
      }
    }
    // 静默无输出兜底：模型 text 为空（伪计划被清空）、KB 未接管、fallback 返回 skip 时，
    // 必须给用户一句可读回复，禁止空转（前端只收到 done 会误以为卡死）。
    if (!text) {
      text = ls.modelError
        ? "模型服务暂时不可用，请稍后重试或更换模型。"
        : "未能理解你的需求，请换种说法重试（例如直接说清模块名与要查的列表/详情）。";
    }
    // 方案 B 兜底（2026-08-26）：若模型不遵守 list-verify 引导仍把完整表格写进最终文本，
    // 而本轮已上屏 UI_TABLE → 折叠重复的 markdown 表格，避免用户看到「两块数据」。
    text = collapseDuplicateTable(text, session);
    session.messages.push({ role: "assistant", text });
    // 最终完整文本：作为 text_delta 增量后的校正/兜底；前端对 text 事件采用覆盖式，避免与增量重复。
    if (text) yield { type: "text", text };
    if (visionErrors.length) {
      yield { type: "error", message: `图片转录失败：${visionErrors.join("；")}`, code: "VISION_OCR_FAILED" };
    }
  } catch (error) {
    console.error(`[chat:catch] "${userText}" 模型调用失败:`, error instanceof Error ? error.message : String(error));
    console.error(`[chat:catch] stack 前4行:`, error instanceof Error ? error.stack?.split("\n").slice(0, 4).join("\n") : "n/a");
    if (signal?.aborted) {
      yield { type: "error", message: "已取消", code: "CANCELLED" };
    } else {
      // 模型调用失败（如额度 402、网络抖动）时：仅当显式写意图（writeForce）且尚无任何工具结果，
      // 改走服务端规则编排兜底执行写操作（写操作必须经用户确认，不能因模型失败就丢错）。
      // 读操作模型失败不在此兜底——下方 402/error 提示会如实返回，避免无模型理解时误调接口。
      // 触发信号由模型行为驱动（模型提交的 operationType==="write"），不依赖服务端写死中文预判。
      const noToolResultYet = (ls_?.steps || []).every((s: AgentStep) => s.kind !== "toolResult");
      const writeForce = findLastUnderstood(ls_?.steps || [])?.operationType === "write";
      if (noToolResultYet && writeForce) {
        // 与主 fallback 分支一致：catch 兜底前写操作也必须经用户确认，
        // 防止「模型调用失败」时绕过确认直接执行删除/修改/新增（安全红线）。
        let confirmed = true;
        if (writeForce) {
          const confirmCallId = `fb-catch-${randomUUID()}`;
          const confirmPromise = waitForConfirmation(session.id, confirmCallId, 60000);
          yield {
            type: "confirmation_required",
            callId: confirmCallId,
            name: CALL_API_TOOL,
            input: { operation: "server-fallback-write", description: userText },
            description: userText,
            impact: buildConfirmationImpact(userText, {}, "POST"),
          };
          confirmed = await confirmPromise;
        }
        if (!confirmed) {
          session.messages.push({ role: "assistant", text: "你取消了该操作，未执行。" });
          yield { type: "text", text: "你取消了该操作，未执行。" };
          return;
        }
        try {
          const fb = await runServerFallback({
            userText,
            llmSteps: ls_?.steps || [],
            session,
            eventQueue,
            onEvents: (ev) => eventQueue.push(ev),
          });
          // 空串也视为无输出：fallback 返回空 text 时给可读兜底，禁止静默
          if (fb.text != null && String(fb.text).trim()) {
            session.messages.push({ role: "assistant", text: fb.text });
            yield { type: "text", text: fb.text };
            // 排空兜底期间事件
            while (eventQueue.length) yield eventQueue.shift()!;
            return;
          }
          if (fb.clarificationText) {
            // 模型额度类错误（402/401008：免费体验额度耗尽、未开启后付费）时，
            // 服务端兜底无模型理解只能产出「与输入无关的模块列表反问」，对用户是误导；
            // 此时应直接如实返回 402 错误提示，引导用户去 TokenHub 控制台开通后付费。
            const isQuotaError = (() => {
              // 递归穿透 LangGraph 对原始错误的包装（PregelTaskError / cause / originalError 链），
              // 只要任一层 message 命中额度耗尽特征即判定为额度类错误。
              const pattern = /401008|quota|exhausted|额度|后付费|postpaid/i;
              let cur: unknown = error;
              let depth = 0;
              while (cur && depth < 5) {
                if (typeof cur === "string") {
                  if (pattern.test(cur)) return true;
                  break;
                }
                if (typeof cur !== "object" || cur === null) break;
                const rec = cur as Record<string, unknown>;
                if (typeof rec.message === "string" && pattern.test(rec.message)) return true;
                const inner = rec.cause ?? rec.originalError ?? rec.error;
                cur = inner;
                depth++;
              }
              try {
                return pattern.test(JSON.stringify(error));
              } catch {
                return false;
              }
            })();
            if (isQuotaError) {
              const quotaMsg =
                "模型服务调用失败：HTTP 402，免费体验额度已耗尽且未开启后付费（401008）。" +
                "请前往腾讯云 TokenHub 控制台（https://console.cloud.tencent.com/tokenhub/inference，广州地域）为模型开启后付费计费后重试。";
              session.messages.push({ role: "assistant", text: quotaMsg });
              yield { type: "error", message: quotaMsg, code: "MODEL_QUOTA_EXHAUSTED" };
              return;
            }
            // 其他非额度错误：与主 fallback 分支一致，澄清必须走 renderClarificationForUser 渲染成友好中文，
            // 禁止把 parse_intent 的裸 JSON 当 error 上屏（前端会原样显示 <p class="error">）。
            const clarText = renderClarificationForUser(`CLARIFICATION_REQUIRED\n${fb.clarificationText}`);
            const parsedClar = parseClarificationPayload(`CLARIFICATION_REQUIRED\n${fb.clarificationText}`);
            if (parsedClar) {
              session.pendingClarification = {
                ...parsedClar,
                id: randomUUID(),
                createdAt: Date.now(),
                turns: 0,
              };
            }
            session.messages.push({ role: "assistant", text: clarText });
            yield { type: "text", text: clarText };
            return;
          }
        } catch {
          /* 兜底也失败则回退到原错误提示 */
        }
      }
      const raw = error instanceof Error ? error.message : "模型调用失败";
      const message = /recursion limit/i.test(raw)
        ? "本轮工具调用过多已中止，请缩小问题范围后重试（例如直接说清模块名与要查的列表/详情）。"
        : raw;
      yield {
        type: "error",
        message,
        ...( /recursion limit/i.test(raw) ? { code: "RECURSION_LIMIT" } : {}),
      };
    }
  } finally {
    yield { type: "done" };
    touchSession(session);
  }
}