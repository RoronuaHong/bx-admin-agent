/**
 * 通用报表图表呈现（PC 报表页统一入口）。
 * 登录数据统计渲染不再特判：实时读 PC configs.data.tsx + resolveI18nTitle 可还原中文列
 * （如「谷歌登录成功总数」）。
 * 已删除的渲染/参数特例：presentLoginDataTotal / pcLoginDataColumns / isLoginDataTotalCall /
 * LOGIN_TYPE_LABEL / enrichLoginDataTotalParams（2026-08-22~25，通用链路覆盖验证通过）。
 * 服务端不按接口名正则适配任何接口（含 loginDataTotal）：参数（loginType/startTime/endTime/
 * statisticalCycle）与默认值由模型按 api-interface-routing skill 读 PC searchFormSchema /
 * 接口源码自行补齐，漏参时由后端如实报错回显，交模型自愈。
 */
import { execGetListColumns, execRenderTable, execSummarizeChartData } from "./output-tools.js";
import { resolveLocalDoc } from "./sources.js";
import { defaultFieldMappingPath } from "./agent-docs.js";

/** 从 call_api 返回文本中抽出行数组（兼容裸数组 / data / result / list / rows） */
export function extractReportRows(content: string): Record<string, unknown>[] {
  let raw: unknown;
  try {
    raw = JSON.parse(content.replace(/\n\.\.\.\(.*$/, "").trim());
  } catch {
    return [];
  }
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  for (const key of ["data", "result", "list", "rows"]) {
    const v = o[key];
    if (Array.isArray(v)) return v as Record<string, unknown>[];
    if (v && typeof v === "object") {
      const inner = v as Record<string, unknown>;
      for (const k2 of ["list", "rows", "data", "result"]) {
        if (Array.isArray(inner[k2])) return inner[k2] as Record<string, unknown>[];
      }
    }
  }
  return [];
}

/** 栈式括号配平定位文本中第一个完整 JSON 值（对象/数组）的起止下标：
 *  兼容模型在 JSON 前后夹带说明文本、字符串含转义/嵌套对象等场景。
 *  替代原 search(/[[{]/)+slice 脆弱解析（遇 {code,data:{rows}} 两层封装即切片错位/解析失败）。 */
export function findFirstBalancedJson(c: string): { start: number; end: number } | null {
  const s = String(c || "");
  for (let i = 0; i < s.length; i++) {
    const open = s[i];
    if (open !== "{" && open !== "[") continue;
    let depth = 0;
    let j = i;
    let inStr = false;
    let esc = false;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue; // 未配平跳过
    return { start: i, end: j };
  }
  return null;
}

/** 递归下钻列表容器（深度护栏 6）：
 *  数组 → 过滤非对象元素后返回（模型可能夹带「获取成功」等说明字符串）；
 *  对象 → 先查 rows/list/records/items/data/result 数组容器，data/result 为对象时继续下钻
 *  （{code,data:{rows}} 两层封装）。纯通用 JSON 语义键，无业务词。
 *  注意：判定依据是「数组容器结构」而非条数——1 条数据的列表也是列表
 *  （2026-08-26 实测 mock 影片列表 data.list 仅 1 条，旧 length>=2 门槛把它误判详情渲染成键值对）。 */
export function drillListRows(payload: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (Array.isArray(payload)) {
    const rows = (payload as unknown[]).filter(
      (r): r is Record<string, unknown> => r != null && typeof r === "object",
    );
    return rows.length >= 1 ? rows : null;
  }
  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    for (const key of ["rows", "list", "records", "items", "data", "result"]) {
      if (Array.isArray(o[key])) {
        const rows = (o[key] as unknown[]).filter(
          (r): r is Record<string, unknown> => r != null && typeof r === "object",
        );
        if (rows.length >= 1) return rows;
      }
    }
    for (const key of ["data", "result"]) {
      const v = o[key];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const r = drillListRows(v, depth + 1);
        if (r) return r;
      }
    }
  }
  return null;
}

/** 从 call_api 返回文本提取「列表行数组」（配平定位 + 递归下钻），取不到返回 null。
 *  列表受控渲染分支统一入口（对齐 extractReportRows 的 data/result 下钻语义）。 */
export function extractListRowsFromContent(content: string): unknown {
  const first = findFirstBalancedJson(content);
  if (!first) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(String(content).slice(first.start, first.end + 1));
  } catch {
    return null;
  }
  return drillListRows(payload);
}

/**
 * 通用报表图表呈现：所有 Analysis / 报表页共用。
 * 自动从 call_api 返回的行推断 X 轴字段与数值序列，产出与 PC 一致的
 * UI_TABLE + UI_CHART（真 ECharts）+ 文字摘要，无需模型手动拼图。
 *
 * 字段推断策略：
 * - X 轴：优先 cycle/date/time/period/statDate/day/name，否则下标
 * - 数值序列：所有可 Number() 的字段，排除汇总行与明显的非指标字段
 * - 表头/序列中文名：优先读取 docs/agent/field-mapping.json 对应模块的 fieldMap
 *   （与 PC 端 columns 中文一致），未收录才走 humanize 兜底
 *   （历史事故：用户观影数据统计显示 Stat Date/Total Watch Count 英文，
 *   而 PC configs.data.tsx 是「统计日期/观影总次数」）。
 */
export function presentGenericChart(
  rows: Record<string, unknown>[],
  moduleName = "",
): { tableBlock: string; chartBlock: string; chartUiBlock: string; reply: string } | null {
  if (!rows.length) return null;

  // 字段中文映射：实时读 PC 源码 configs.data.tsx（get_list_columns）优先，
  // 其次 field-mapping.json 手工配置，最后 humanize 兜底
  const fieldMap = loadFieldMap(moduleName, rows);

  // 排除「汇总」行（与 PC Analysis filter 一致；覆盖所有候选 X 字段）
  const chartRows = rows
    .filter((r) =>
      !X_FIELD_CANDIDATES.some((k) => String(r[k] ?? "") === "汇总"),
    )
    .slice()
    .sort((a, b) =>
      String(pickXKey(a)).localeCompare(String(pickXKey(b))),
    );
  if (!chartRows.length) return null;

  // 推断 X 轴字段
  const xField = inferXField(chartRows[0]);
  // 无可用 X 轴字段时无法渲染有意义图表，交回模型旧路径
  if (xField === "index") return null;
  const categories = chartRows.map((r) => String(r[xField] ?? pickXKey(r)));

  // 推断数值序列字段（排除 X 字段与非指标字段）
  const numericFields = inferNumericFields(chartRows, xField, fieldMap);
  if (!numericFields.length) return null;

  const series = numericFields.map((f, i) => ({
    name: f.label,
    data: chartRows.map((r) => toNum(r[f.field])),
    selected: i === 0, // 第一条默认选中（与 PC 一致）
    type: "line" as const,
  }));

  const chartView = {
    title: "报表趋势",
    categories,
    height: 280,
    series,
  };
  const chartUiBlock = ["UI_CHART", JSON.stringify(chartView)].join("\n");

  // 表头：X 字段 + 各数值字段（中文优先）
  const columns = [
    { title: fieldMap[xField] || humanize(xField), key: xField },
    ...numericFields.map((f) => ({ title: f.label, key: f.field })),
  ];
  const tableBlock = execRenderTable({
    title: "报表数据",
    columns,
    data: chartRows,
    maxRows: 100,
  });

  const chartBlock = execSummarizeChartData({
    metricLabel: numericFields[0].label,
    metricField: numericFields[0].field,
    xField,
    data: chartRows,
    seriesFields: numericFields.map((f) => ({ field: f.field, label: f.label })),
  });

  // 正文只保留短摘要；完整表/图走 UI_TABLE / UI_CHART
  const trendOnly = chartBlock
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      if (line.startsWith("UI_")) return false;
      if (line.startsWith("|")) return false;
      if (line.startsWith("【表格")) return false;
      if (line.startsWith("关键点")) return false;
      if (line.startsWith("数据表")) return false;
      if (line.startsWith("（共")) return false;
      return true;
    })
    .join("\n")
    .slice(0, 1200);

  const reply = [
    `已按 PC「数据报表」口径查询并渲染图表：`,
    `- X 轴：${fieldMap[xField] || humanize(xField)}`,
    `- 序列：${numericFields.map((f) => f.label).join("、")}`,
    `- 行数：${chartRows.length}`,
    "",
    `已推送与 PC 一致的 ECharts 折线图与数据表（${numericFields[0].label} 默认选中；可点图例切换）。`,
    "",
    trendOnly,
  ]
    .join("\n")
    .trim();

  return { tableBlock, chartBlock, chartUiBlock, reply };
}

/** 候选 X 轴字段（按优先级） */
const X_FIELD_CANDIDATES = [
  "cycle",
  "statDate",
  "date",
  "time",
  "period",
  "day",
  "month",
  "name",
  "label",
  "title",
];

/** 候选数值字段（白名单优先，命中即用）。2026-08-24 去写死：
 *  删除业务特定指标名（successCount/income/recharge/retention/ltv/uv/pv/duration 等，
 *  属写死特定业务字段，违反红线）——仅保留跨项目通用的数值语义词
 *  （value/y/count/total/num/amount/rate/ratio），特定指标列由模型按图表上下文判断。 */
const NUMERIC_FIELD_HINTS = ["value", "y", "count", "total", "num", "amount", "rate", "ratio"];

/** 明显非指标字段，绝不归入序列 */
const NON_METRIC_FIELDS = new Set([
  "id",
  "ids",
  "name",
  "label",
  "title",
  "cycle",
  "period",
  "statDate",
  "date",
  "time",
  "day",
  "month",
  "type",
  "category",
  "remark",
  "note",
  "children",
  "moreLoding",
]);

function pickXKey(o: Record<string, unknown>): string | number {
  for (const k of X_FIELD_CANDIDATES) {
    if (o[k] != null && String(o[k]).trim() !== "") return String(o[k]);
  }
  return "";
}

function inferXField(o: Record<string, unknown>): string {
  for (const k of X_FIELD_CANDIDATES) {
    if (o[k] != null && String(o[k]).trim() !== "") return k;
  }
  return "index";
}

function inferNumericFields(
  rows: Record<string, unknown>[],
  xField: string,
  fieldMap: Record<string, string> = {},
): Array<{ field: string; label: string }> {
  const sample = rows[0];
  const fields = Object.keys(sample).filter(
    (k) => k !== xField && !NON_METRIC_FIELDS.has(k) && !/^(children|moreLoding)$/.test(k),
  );
  const out: Array<{ field: string; label: string }> = [];
  for (const f of fields) {
    // 该字段在所有行都能解析为数值才纳入
    const allNumeric = rows.every((r) => {
      const n = toNum(r[f]);
      return Number.isFinite(n);
    });
    if (!allNumeric) continue;
    // 中文映射优先（field-mapping.json），否则白名单提示，最后 humanize
    const label = fieldMap[f] || (NUMERIC_FIELD_HINTS.includes(f) ? f : humanize(f));
    out.push({ field: f, label });
  }
  return out;
}

/** 通用字段映射：优先实时读 PC 端 configs.data.tsx（get_list_columns），
 *  其次 docs/agent/field-mapping.json 手工配置，最后 humanize 兜底。
 *  ——新增项目/模块零配置：PC 端 columns（dataIndex→中文 title）即真实来源，
 *  无需手工维护映射表；field-mapping.json 仅作历史兼容兜底。
 */
function loadFieldMap(moduleName: string, rows: Record<string, unknown>[]): Record<string, string> {
  const map: Record<string, string> = {};

  // 1) 实时读 PC 源码：get_list_columns 返回 { results: [{ columns: [{title,dataIndex}] }] }，
  //    多组结果时选与行数据字段交集最多的那组（避免命中错误模块的列定义）。
  if (moduleName && rows.length) {
    try {
      const text = execGetListColumns({ module: moduleName });
      const parsed = JSON.parse(text) as {
        results?: Array<{ columns?: Array<{ title?: string; dataIndex?: string }> }>;
      };
      const groups = (parsed?.results || [])
        .map((r) =>
          (r.columns || [])
            .map((c) => ({ title: String(c.title || ""), dataIndex: String(c.dataIndex || "") }))
            .filter((c) => c.dataIndex),
        )
        .filter((g) => g.length);
      if (groups.length) {
        const rowKeys = new Set(Object.keys(rows[0] || {}));
        const score = (g: Array<{ title: string; dataIndex: string }>) =>
          g.reduce(
            (n, c) => n + (rowKeys.has(c.dataIndex) ? 1 : 0),
            0,
          );
        const best = groups.reduce((a, b) => (score(b) > score(a) ? b : a));
        for (const c of best) map[c.dataIndex] = c.title;
      }
    } catch {
      /* 实时提取失败则走静态配置兜底 */
    }
  }

  // 2) field-mapping.json 手工配置（历史兼容；实时提取未覆盖时补充）
  if (moduleName) {
    try {
      const mappingRaw = resolveLocalDoc(defaultFieldMappingPath());
      let mapping: Record<string, unknown> = {};
      if ("note" in mappingRaw) {
        try {
          mapping = JSON.parse(mappingRaw.note.text);
        } catch {
          /* ignore */
        }
      }
      const modules = (mapping.modules || {}) as Record<string, { fieldMap?: Record<string, string> }>;
      const staticMap = modules[moduleName]?.fieldMap || {};
      for (const [k, v] of Object.entries(staticMap)) {
        if (!(k in map)) map[k] = v;
      }
    } catch {
      /* ignore */
    }
  }

  return map;
}

function toNum(v: unknown): number {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  const s = String(v).replace(/[%,%]/g, "").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// 2026-08-24 去写死：删除 humanize 的静态中文字典（successCount→成功数 等，属写死字段映射，违反红线）。
// 字段中文化主路径已由「实时读 PC 源码（get_list_columns / pc-column-mapping skill）」覆盖；
// 此处仅做 camelCase → 空格的可读化，中文表头交给模型/skill，不再硬编码字段名→中文。
function humanize(field: string): string {
  return field
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

// 2026-08-24 去写死：删除 isAnalysisReportOperation（写死英文接口名片段正则 report/retention/income/ltv 等，
// 判断「是否报表类」做渲染分流——属写死特定接口名，违反红线）。报表图表渲染改由模型主动提交
// pageKind=analysis_chart 触发（presentGenericChart 通用链路），服务端不再按接口名猜报表。

/** 从工具结果里提取 JSON（支持：UI_TABLE 前缀、normalize_output 的「[已对齐 PC 端字段」前缀、
 *  裸 JSON 数组/对象、```json 围栏）；解析失败返回 null */
function extractJsonFromResult(content: string): unknown {
  let s = content.trim();
  s = s.replace(/^UI_TABLE\n[^\n]+\n\n?/, "").replace(/^UI_FILE\n[^\n]+\n\n?/, "");
  const m = s.match(/^\[已对齐 PC 端字段[^\n]*\n([\s\S]*)$/);
  if (m) s = m[1];
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  // 栈式配平定位（对齐 extractListRowsFromContent）：原 search(/[[{]/)+slice 在 JSON 前有
  // 说明文本或两层封装时解析失败，导致 synthesize 兜底取不到数据。
  const first = findFirstBalancedJson(s);
  if (!first) return null;
  try {
    return JSON.parse(s.slice(first.start, first.end + 1));
  } catch {
    return null;
  }
}

/** 把 JSON 转成 Markdown 表格（数组 / {rows|list:[]} → 表格；单对象 → 键值对；保留 total/page 元信息） */
function jsonToMarkdownTable(value: unknown, maxRows = 50, maxCols = 8): string {
  let rows: Array<Record<string, unknown>> = [];
  let meta = "";
  if (Array.isArray(value)) {
    rows = value.filter((r): r is Record<string, unknown> => r != null && typeof r === "object");
  } else if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    const list = Array.isArray(v.rows) ? v.rows : Array.isArray(v.list) ? v.list : null;
    if (list) {
      rows = list.filter((r): r is Record<string, unknown> => r != null && typeof r === "object");
      const total = v.total ?? rows.length;
      const page = v.page ? `，第 ${v.page}/${v.pages ?? "?"} 页` : "";
      meta = `共 ${total} 条${page}`;
    } else {
      // 单对象详情 → 键值对
      const kv = Object.entries(v).filter(([k]) => !["page", "pages", "total", "current", "size", "list", "rows"].includes(k));
      if (!kv.length) return "";
      const body = kv.map(([k, val]) => `| ${k} | ${String(val ?? "").slice(0, 80)} |`).join("\n");
      return `字段 | 值\n--- | ---\n${body}`;
    }
  } else {
    return "";
  }
  if (!rows.length) return meta ? `${meta}（无数据）` : "（无数据）";
  const cols: string[] = [];
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!cols.includes(k)) cols.push(k);
    }
  }
  const useCols = cols.slice(0, maxCols);
  const cell = (v: unknown) =>
    String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 40);
  const header = `| ${useCols.join(" | ")} |`;
  const sep = `| ${useCols.map(() => "---").join(" | ")} |`;
  const body = rows
    .slice(0, maxRows)
    .map((r) => `| ${useCols.map((c) => cell(r[c])).join(" | ")} |`)
    .join("\n");
  const more = rows.length > maxRows ? `\n\n（仅显示前 ${maxRows} 条，共 ${rows.length} 条）` : "";
  return [meta, header, sep, body, more].filter((l) => l !== "").join("\n");
}

/** 判断工具结果是否为「call_api 裸 JSON 数据」（数组 / 含 rows|list|records|items）：
 *  排除元工具 JSON（_tool：get_list_columns/get_page_schema）、UI 前缀块与 normalize_output 标记 */
function looksLikeListJson(c: string): boolean {
  if (c.includes("_tool") || c.includes("UI_TABLE") || c.includes("UI_FILE") || c.includes("[已对齐 PC 端字段")) {
    return false;
  }
  // 配平定位判定（覆盖两层封装）：原 startsWith+浅层正则漏判 {code,data:{rows}}，synthesize 兜底失效
  return findFirstBalancedJson(c) != null;
}

/** final 兜底：从工具结果拼一段可读说明。
 *  ① 图表/表格类（图表摘要/表格输出/UI_TABLE）直接复用原结果；
 *  ② 列表/详情类（normalize_output 的「[已对齐 PC 端字段」、call_api 的裸 JSON）转 Markdown 表格——
 *     模型收尾超时/失败时用户仍能看到已查到的数据（对齐 Cursor「工具结果即产出」）。 */
export function synthesizeReplyFromToolResults(toolResults: string[]): string | null {
  const prefer = [...toolResults].reverse().find(
    (c) =>
      c.includes("【图表摘要") ||
      c.includes("【表格输出】") ||
      c.includes("UI_TABLE") ||
      c.includes("[已对齐 PC 端字段") ||
      looksLikeMarkdownTable(c) ||
      looksLikeListJson(c),
  );
  if (!prefer || prefer.startsWith("错误：")) return null;

  // ① 图表/表格类：原样复用（render_table / summarize_chart_data / renderListForAgent 的产物）
  if (
    prefer.includes("【图表摘要") ||
    prefer.includes("【表格输出】") ||
    prefer.includes("UI_TABLE") ||
    looksLikeMarkdownTable(prefer)
  ) {
    const cleaned = prefer
      .replace(/^UI_TABLE\n[^\n]+\n\n?/, "")
      .replace(/^UI_FILE\n[^\n]+\n\n?/, "")
      .trim();
    if (!cleaned || cleaned.startsWith("错误：")) return null;
    return cleaned.slice(0, 6000);
  }

  // ② 列表/详情类：normalize_output 或 call_api 的 JSON → Markdown 表格
  const json = extractJsonFromResult(prefer);
  if (json === null) return null;
  const table = jsonToMarkdownTable(json);
  if (!table) return null;
  return table.slice(0, 6000);
}

/** 识别 renderListForAgent 渲染的 Markdown 表格（| 表头 | --- | ...），模型空文本收束时作为最终回复复用。 */
function looksLikeMarkdownTable(text: string): boolean {
  const lines = String(text || "").trim().split("\n").filter(Boolean);
  if (lines.length < 3) return false;
  if (!lines[0].startsWith("|") || !lines[1].includes("---")) return false;
  return lines[0].includes("|");
}
