/**
 * 统一输出 schema 校验层（OWASP LLM02 不安全的输出处理 / ASI10 不安全输出处理）。
 *
 * 模型不只是产出自由文本——它还会产出**结构化子输出**（澄清卡片、任务计划、图表 spec、
 * 导出报告里的图表）。这些子输出会被渲染成卡片 / 清单 / 图表，或喂给下游（报告合成、前端渲染）。
 * 一旦结构非法，要么前端渲染崩、要么脏数据静默混入导出文件。
 *
 * 这里把所有结构化输出的 schema 校验**集中收口**：每个校验都是 fail-closed——
 * 不合法就返回错误文本、回灌给模型让它重试，**绝不把畸形结构交付前端 / 下游**。
 * 校验逻辑此前散落在 builtins.ts 各处（normalizeClarification / normalizeTodos /
 * isChartSpecLike / render_chart 内联判断），现统一到本模块，行为完全不变，只是可审计、可观测。
 *
 * 设计取舍（与本项目其它护栏一致）：
 *  - 只校验「结构」，不校验「语义」（选项是否真能区分、图表数据是否真相关交给模型）。
 *  - 宽松于可选字段（澄清的 missingField / whyItMatters 缺失不报错，弱模型漏填不该整次判失败）。
 *  - 不引入任何业务词 / JSON 字段名白名单——校验只看形态（数组 / 对象 / 字符串非空 / 枚举状态）。
 */

import type { ChartSpec, ClarifyOption, TodoItem } from "@bx/shared";
import { CHART_TYPES as SHARED_CHART_TYPES, GRAPH_CHART_TYPES as SHARED_GRAPH_CHART_TYPES } from "@bx/shared";

// ── 校验常量（原在 builtins.ts，集中到此处作为单一真相） ──────────────────────
export const TODO_STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);
export const MAX_TODOS = 20;
export const MAX_TODO_CHARS = 200;
export const MAX_CLARIFY_OPTIONS = 6;
export const MAX_CLARIFY_QUESTION = 300;
export const MAX_CLARIFY_LABEL = 80;
export const MAX_CLARIFY_DESC = 200;
export const MAX_CLARIFY_FIELD = 60;
export const MAX_CLARIFY_WHY = 200;

/** 受支持图表类型（统计类，走 G2）；清单来自 @bx/shared，与前端分流同源。 */
export const CHART_TYPES = new Set<string>(SHARED_CHART_TYPES);
/** 图形类（走 G6）：形态与统计图完全不同，不能用同一把尺子量。 */
export const GRAPH_CHART_TYPES = new Set<string>(SHARED_GRAPH_CHART_TYPES);

/** 结构化澄清载荷（与 BuiltinOutcome.clarification 同形）。 */
export interface ClarificationPayload {
  question: string;
  options: ClarifyOption[];
  missingField?: string;
  whyItMatters?: string;
}

/** 统一校验结果：成功带 value，失败带 error 文本（回灌模型）。 */
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * 校验 request_clarification 的结构化输出。
 * 非法 → {ok:false, error}；合法 → {ok:true, value}。
 */
export function validateClarification(raw: Record<string, unknown>): ValidationResult<ClarificationPayload> {
  const question = String(raw.question || "").trim().slice(0, MAX_CLARIFY_QUESTION);
  if (!question) return { ok: false, error: "request_clarification 需要 question" };
  if (!Array.isArray(raw.options) || raw.options.length < 2) {
    return { ok: false, error: "options 至少需要 2 个选项（不足 2 个请直接按最合理的理解执行，不要提问）" };
  }
  const options: ClarifyOption[] = [];
  for (const item of raw.options.slice(0, MAX_CLARIFY_OPTIONS)) {
    const entry = (item && typeof item === "object" ? item : {}) as { label?: unknown; description?: unknown };
    const label = String(entry.label || "").trim().slice(0, MAX_CLARIFY_LABEL);
    if (!label) continue;
    const description = String(entry.description || "").trim().slice(0, MAX_CLARIFY_DESC);
    options.push({ label, ...(description ? { description } : {}) });
  }
  if (options.length < 2) return { ok: false, error: "options 至少需要 2 个带 label 的有效选项" };
  // 澄清契约字段可选：缺失不算错误（弱模型漏填时不该把整次澄清判失败）。
  const missingField = String(raw.missing_field || "").trim().slice(0, MAX_CLARIFY_FIELD);
  const whyItMatters = String(raw.why_it_matters || "").trim().slice(0, MAX_CLARIFY_WHY);
  return {
    ok: true,
    value: {
      question,
      options,
      ...(missingField ? { missingField } : {}),
      ...(whyItMatters ? { whyItMatters } : {}),
    },
  };
}

/**
 * 校验 write_todos 的结构化输出（全量替换的任务计划）。
 * 非法 → {ok:false, error}；合法 → {ok:true, value}。
 */
export function validateTodos(raw: unknown): ValidationResult<TodoItem[]> {
  if (!Array.isArray(raw)) return { ok: false, error: "todos 必须为数组" };
  if (raw.length > MAX_TODOS) return { ok: false, error: `计划条数过多（${raw.length}，上限 ${MAX_TODOS}）` };
  const todos: TodoItem[] = [];
  for (const item of raw) {
    const entry = (item || {}) as { content?: unknown; status?: unknown };
    const content = String(entry.content || "").trim().slice(0, MAX_TODO_CHARS);
    const status = String(entry.status || "pending");
    if (!content) return { ok: false, error: "每条计划都需要 content" };
    if (!TODO_STATUSES.has(status)) return { ok: false, error: `非法状态：${status}` };
    todos.push({ content, status: status as TodoItem["status"] });
  }
  return { ok: true, value: todos };
}

/**
 * 一轮已经给出最终回答时，把计划里还开着的步骤收成完成。
 * 模型经常只在开头写一次计划，做完后不再调 write_todos，界面就一直停在进行中。
 * cancelled 保持不动：那是明确不做的步骤，不能算完成。
 * 没有变化时返回 null，调用方不必再发事件。
 */
export function settleFinishedTodos(todos: TodoItem[] | null | undefined): TodoItem[] | null {
  if (!todos?.length) return null;
  let changed = false;
  const next = todos.map((item) => {
    if (item.status !== "pending" && item.status !== "in_progress") return item;
    changed = true;
    return { content: item.content, status: "completed" as const };
  });
  return changed ? next : null;
}

/**
 * 图表 spec 形态校验（导出报告内嵌图表复用）：chartType 受支持且 data 形态正确。
 * 不合规的图表在导出时被安静丢弃（图表是装饰，不拖垮整个文件）。
 */
export function isChartSpecLike(v: unknown): v is ChartSpec {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.chartType !== "string") return false;
  if (GRAPH_CHART_TYPES.has(o.chartType)) return !!o.data && typeof o.data === "object" && !Array.isArray(o.data);
  if (!CHART_TYPES.has(o.chartType)) return false;
  return Array.isArray(o.data) && o.data.every((row) => !!row && typeof row === "object");
}

/**
 * 校验 render_chart 的入参（模型产出的图表 spec）。
 * 只做结构校验（类型受支持 + data 形态正确），不校验数据真实性（是否编造交给 grounding）。
 * 成功返回规范化后的 chartType 与 data，失败返回错误文本。
 */
export function validateChartArgs(args: Record<string, unknown>): ValidationResult<{ chartType: string; data: unknown }> {
  const chartType = String(args.chartType ?? args.type ?? "").trim().toLowerCase();
  if (!CHART_TYPES.has(chartType)) {
    return { ok: false, error: `不支持的图表类型：${chartType || "(空)"}。支持：${[...CHART_TYPES].join("、")}` };
  }
  // 模型偶尔把结构化参数当 JSON 字符串传（双重编码）：宽容解析，省掉一轮无谓重试。
  const asJson = (v: unknown): unknown => {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };
  const rawData = asJson(args.data);
  if (GRAPH_CHART_TYPES.has(chartType)) {
    // 图形类：接受 {nodes,...} 或层级 {name,children}。
    // 注意数组的 typeof 也是 "object"，必须显式排除——否则 [1,2] 会一路走到前端才抛错降级成表格。
    if (typeof rawData !== "object" || rawData === null || Array.isArray(rawData)) {
      return {
        ok: false,
        error: "render_chart（图形类）需要 data 为 {nodes,edges} 或 {name,children} 结构（不能是数组）",
      };
    }
    const g = rawData as Record<string, unknown>;
    if (!Array.isArray(g.nodes) && !Array.isArray(g.children)) {
      return {
        ok: false,
        error: "render_chart（图形类）的 data 需要含 nodes 数组（关系/流程）或 children 数组（层级/树）",
      };
    }
  } else if (!Array.isArray(rawData)) {
    return { ok: false, error: "render_chart（统计图）需要 data 为行对象数组（真实数据，禁止编造）" };
  } else if (rawData.some((r) => typeof r !== "object" || r === null || Array.isArray(r))) {
    // 纯数字数组（[1,2,3]）画不出图：G2 要靠字段名取 x/y，静默空白比明确回告更糟。
    return {
      ok: false,
      error: 'render_chart（统计图）的 data 必须是「行对象」数组（如 [{"name":"A","value":1}]），纯数字数组无法确定坐标字段',
    };
  }
  return { ok: true, value: { chartType, data: rawData } };
}

/** 已登记的结构化输出 schema（供 GET /chat/output-schema 观测）。 */
export interface OutputSchemaInfo {
  /** 输出名（工具名或 artifact 路径）。 */
  name: string;
  /** tool-output = 模型经工具产出的结构化载荷；artifact = 下游产物里内嵌的结构。 */
  kind: "tool-output" | "artifact";
  /** 是否 fail-closed（非法即拒绝并回灌模型）。artifact 类为宽松过滤。 */
  strict: boolean;
  description: string;
  rules: string[];
}

export const OUTPUT_SCHEMAS: OutputSchemaInfo[] = [
  {
    name: "request_clarification",
    kind: "tool-output",
    strict: true,
    description: "模型发出的结构化澄清请求（渲染为选项卡片，挂起等待用户选择）",
    rules: [
      "question 非空（≤300 字）",
      "options 至少 2 个、至多 6 个，每个必须有 label（≤80 字）",
      "有效 options 不足 2 个 → 拒绝并要求模型直接按最合理理解执行",
      "missingField / whyItMatters 为可选澄清契约字段，缺失不报错",
    ],
  },
  {
    name: "write_todos",
    kind: "tool-output",
    strict: true,
    description: "模型写出的任务计划（渲染为计划清单）",
    rules: [
      "todos 必须是数组且 ≤20 条",
      "每条必须有 content（≤200 字）",
      "status 必须是 pending/in_progress/completed/cancelled，缺省按 pending",
    ],
  },
  {
    name: "render_chart",
    kind: "tool-output",
    strict: true,
    description: "模型产出的图表 spec（本地渲染为图表卡片，数据不出本机）",
    rules: [
      "chartType 必须是受支持类型（统计类 / 图形类，清单与前端同源）",
      "统计图 data 必须是行对象数组（禁止编造数据点），图形类 data 必须是 {nodes,edges} 或 {name,children}",
      "纯数字数组 / 标量 / null 行 → 拒绝并要求模型取真实数据",
    ],
  },
  {
    name: "export_data.charts",
    kind: "artifact",
    strict: false,
    description: "导出报告里内嵌的图表（复用 render_chart 产出的 ChartSpec）",
    rules: [
      "只接纳通过 isChartSpecLike 校验的图表（chartType 受支持 + data 形态正确）",
      "不合规图表被安静丢弃（图表是装饰，不拖垮整个导出）",
    ],
  },
];
