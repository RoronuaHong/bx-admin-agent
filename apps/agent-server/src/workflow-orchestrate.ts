/**
 * workflow 层：规则编排（在大模型理解之后）
 * parse_intent 校验 → grep → search_api_module → call_api → 服务端受控渲染（列表/详情/报表）
 * 渲染由执行器完成（对齐 Cursor），模型不手动 normalize_output / render_table（仅 output-align 兜底时）。
 */
import { randomUUID } from "node:crypto";
import nodePath from "node:path";
import type { ChatEvent, ChatTableRow, ChatTableView } from "@bx/shared";
import type { AgentStep } from "./models.js";
import { runAgentTool, READONLY_REPLY, type ApiCallOptions } from "./tools.js";
import { execGetFieldMapping } from "./output-tools.js";
import { resolveCodebaseRoot } from "./project-context.js";
import { lookupTermModules, formatTranslationHits } from "./translation-lookup.js";
import { resolveApiModules } from "./api-index.js";
import { loadApiOperationIndex, resolveApiOperation } from "./api-operation-index.js";
import { extractGrepPattern } from "./tool-gate.js";
import { runContractSearch } from "./query-contraction.js";
import { truncateToolResultForUi } from "./ui-truncate.js";
import { resolveLocalDoc } from "./sources.js";
import { defaultFieldMappingPath } from "./agent-docs.js";
import { getSession } from "./session.js";
import type { UnderstoodIntent } from "./understood-intent.js";

export type OrchestrateResult =
  | { kind: "clarification"; clarificationText: string; steps: AgentStep[] }
  | { kind: "executed"; steps: AgentStep[]; module: string; normalizedText: string }
  | { kind: "partial"; steps: AgentStep[] }
  | { kind: "skip" };

export interface OrchestrateContext extends ApiCallOptions {
  userText: string;
  llmIntent?: UnderstoodIntent;
  priorSteps?: AgentStep[];
  emitEvent?: (ev: ChatEvent) => void;
}

function extractExplicitOperation(text: string): string | null {
  // 通用匹配「模块.接口名」格式（不写死具体 func 名）：用户显式说接口 id 时抽取（如 user.getList / film.getMovieSearchStatList）
  const m = text.match(/\b([A-Za-z][\w-]*)\.([A-Za-z][\w-]*)\b/);
  return m ? `${m[1]}.${m[2]}` : null;
}

/** 剥离 HTML 富文本标签（前端聊天框偶发带 <div data-v-.. class="body"><p>..</p></div> 包裹）。
 *  server 端 grep 定位模块时若直接用原始 HTML，会把 <divdata-v-32b89 当成业务词去 grep → 永远命中不到，
 *  导致 module 为空、inferCallOperation 返回 null、误报「未找到该模块对应的详情/列表接口」。 */
function stripHtmlTags(html: string): string {
  if (!html) return html;
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractRecordId(text: string, understoodValue?: string): string | null {
  const fromUnderstood = (understoodValue || "").trim();
  if (/^\d+$/.test(fromUnderstood)) return fromUnderstood;
  const fromValue = fromUnderstood.match(/(?:id\s*[:=]?\s*)?(\d+)/i);
  if (fromValue && /^\d+$/.test(fromValue[1])) return fromValue[1];
  const m = text.match(/(?:^|[\s,，、;；])(?:id\s*[:=]\s*)?(\d{5,})(?!\d)/i);
  if (m) return m[1];
  // 文本中独立长数字 token（>=8 位，通常是记录 id，避免年份/数量误匹配）
  const token = text.match(/(?:^|[\s,，、;；(（])(\d{8,})(?![\d,，、;；)）])/);
  return token ? token[1] : null;
}

/** 模块内读详情：按接口语义通用匹配（不写死候选名）。
 *  优先级：func 含 id/Detail/Info 的详情接口 > 该模块列表接口（getList + id，如会员订单）。
 *  全程从 api-operation-index.json 的真实 operations 推导，不硬编码任何具体接口名。
 *  2026-08-24 去写死：不再写死详情参数键名 "id"——详情接口的参数名因接口而异（getById 用 id、
 *  getMovieDetail 用 movieId），完全由模型按 api-interface-routing skill 读接口源码在 call_api.params
 *  里提供，服务端不猜键名（params 留空，模型后续填充）。 */
function resolveModuleDetail(module: string): { operation: string; params: Record<string, unknown> } | null {
  const ops = loadApiOperationIndex().operations.filter((o) => o.module === module);
  if (!ops.length) return null;
  // 1) 详情接口：func 含 byId/ById/Detail/Info/InfoById 等「单条」语义（覆盖 getById/getDetail/getInfoById 等任意命名）
  const detailHit = ops.find((o) => /byId|ById|Detail|Info\b|InfoById/i.test(o.func));
  if (detailHit) return { operation: detailHit.id, params: {} };
  // 2) 退化：用列表接口 + id 查单条（部分模块列表接口本身支持按 id 过滤返回单条）
  const listHit = ops.find((o) => /list|List/i.test(o.func));
  if (listHit) return { operation: listHit.id, params: {} };
  return null;
}

export function inferCallOperation(
  module: string,
  userText: string,
  operationType: "read" | "write",
  explicitOp: string | null,
  operationHint?: string,
  understoodValue?: string,
  sessionId?: string,
): { operation: string; params: Record<string, unknown> } | null {
  // 模块未定位（空串）：直接返回 null，禁止用空 module 拼 .getList 去模糊命中别的接口
  // （曾发生 resolveApiOperation(".getList") 匹配到无关 operation → Parameter checking failed）。
  if (!module || !module.trim()) return null;
  // 当前句取 ID；取不到时从上一轮对话历史继承（上下文继承）：
  // 例：先问「三级分类，5850754967898112，可以做哪些操作？」再问「查看详情」——
  // 「查看详情」没有 ID，但语义显然是对 5850754967898112 看详情，应继承该 ID。
  let id = extractRecordId(userText, understoodValue);
  // 历史 ID 继承只在「详情/单条意图」时生效：
  // 模型已声明 read 意图且未带 id 时，视为列表查询，不继承上一轮详情 id（否则「三级分类列表」会被误当成
  // 上一轮的详情 id 来查，返回单条而非列表）。列表/详情判定完全由模型提交的 operationType 决定，不靠中文词。
  const inheritHistoryId = operationType !== "read";
  if (!id && inheritHistoryId && sessionId) {
    const session = getSession(sessionId);
    const recent = (session?.messages || []).slice(-4);
    for (const turn of recent) {
      if (id) break;
      const text = String(turn.text || "");
      if (!text) continue;
      // 跳过澄清模板消息（协议标识识别，避免把澄清里的选项序号数字误匹配成 ID；2026-08-25 去中文词判定）
      if (/CLARIFICATION_REQUIRED|missingSlots|clarification/.test(text)) continue;
      // 从历史文本提取长数字 ID（≥5 位，避免年份/数量误匹配；捕获组包住数字本体）
      const hit = text.match(/(?:^|[\s,，、;；])(\d{5,})(?!\d)/);
      if (hit) id = hit[1];
    }
  }
  const hint = `${operationHint || ""} ${userText}`;

  if (explicitOp) {
    const resolved = resolveApiOperation(explicitOp);
    if (resolved) {
      const params: Record<string, unknown> = {};
      return { operation: resolved.id, params };
    }
  }

  // write 分支：模型已明确提交 operationType==="write" 才进入（不靠中文词猜测写意图）。
  // unknown 分支已在上方直接返回 null 交模型/澄清，禁止中文写意图词硬编码。
  if (operationType === "write") {
    let writeKind: "create" | "update" | "delete" | null = null;
    if (operationType === "write") {
      // 模型已明确为写：从 explicitOp / 上下文推断写类型，中文词仅辅助（不覆盖模型 operationType）
      writeKind = explicitOp ? (/(delete|remove|del)/i.test(explicitOp) ? "delete" : /(update|edit)/i.test(explicitOp) ? "update" : "create") : "create";
    } else {
      // operationType 未知：不靠中文词猜测写意图（中文意图词一律不写死），
      // 直接返回 null 交上层澄清/模型自愈，禁止用中文动词硬编码进写分支。
      return null;
    }
    if (!writeKind) return null;
    const opId = explicitOp && resolveApiOperation(explicitOp) ? explicitOp : null;
    if (writeKind && opId) {
      const resolved = resolveApiOperation(opId)!;
      return { operation: resolved.id, params: {} };
    }
    // 未显式指定接口：按模块名 + 写类型推断模块内写接口
    // 只考虑真正的写函数：排除 get 前缀 / List / Page / Stat / Option 等读接口
    // （film.getNeedUpdateList 含 “Update” 但 func 是 get 前缀的查询，不能被误选）
    const ops = loadApiOperationIndex().operations.filter(
      (o) =>
        o.module === module &&
        !/^get/i.test(o.func) &&
        !/List$|Page$|Stat$|Option|Detail|Info$/i.test(o.func) &&
        !/getById|getDetail/i.test(o.func),
    );
    const patterns: Record<string, RegExp> = {
      create: /createOrUpdate|create|save|add|insert/i,
      update: /update|createOrUpdate|edit|save/i,
      delete: /delete|remove|del/i,
    };
    const re = writeKind ? patterns[writeKind] : /createOrUpdate|create|save|update|delete|remove/i;
    const hit = ops.find((o) => re.test(o.func));
    if (hit) {
      const params: Record<string, unknown> = {};
      // create/update：从用户口语中提取业务字段（如「名称叫测试分类ABC，排序 99」→ {names:[{value:测试分类ABC}], order:99}）
      // 2026-08-24 去写死：删除 extractWriteBizParams（写死中文键值词：名称/排序/导航栏/搜索栏/系统内置，
      // 违反红线）。写操作的 name/order/开关等业务参数完全由模型按 api-interface-routing skill 读接口
      // 源码后在 call_api.params 里填；服务端不再从口语猜参数名。缺参时后端如实报错，用户/模型补充。
      return { operation: hit.id, params };
    }
  }

  // 详情判定：模型已声明 read 意图且带了 id → 走详情接口（不靠中文词「详情/明细」硬编码）。
  if (id && operationType === "read") {
    const detail = resolveModuleDetail(module);
    if (detail) return detail;
  }

  // 列表分支：仅由模型提交的 operationType==="read" 进入（不靠中文词「列表/列出/罗列」等硬编码）。
  // 带 id 的列表查询（如「账号合并 5585… 列出所有字段」）也走列表接口，id 作为列表参数。
  if (operationType === "read") {
    // 2026-08-24 去写死：分页参数（page/size 等）不再由服务端从 PaginationPlan 补，完全由模型按接口契约
    // 在 call_api.params 里提供（模型自主决定数据量，参考 Cursor）。
    // 模块内候选列表接口（含统计/报表类 Stat|Report，如 userlayer/wool_user.getWoolReport；排除详情/写接口）
    const listOps = loadApiOperationIndex().operations.filter(
      (o) =>
        o.module === module &&
        /getList|List|Stat|Report|Manage|getAll/i.test(o.func) &&
        !/Detail|ById|Create|Update|Delete|Remove|Add|Set/i.test(o.func),
    );
    // 2026-08-25 彻底去操作级别名：不再按用户文本匹配 op.aliases 精确选接口（中文别名随
    // project-aliases.json 删除，且该写法属人工兜底，与「全交给大模型」相悖）。模块内多列表
    // 接口由模型按 api-interface-routing skill 读源码选（read_api_module 后填完整 operation）；
    // 服务端兜底仅按英文命名语义优先级选第一个（通用约定，非业务写死）。
    // 模块内任意列表类接口（不写死 getList/getWhiteListManage/list 等具体名）：按语义优先级选第一个。
    // 优先级：标准列表 func 全等于 getList/list（最高）> 含 List/Page/Search/Query 的专项列表 > Manage/Stat/Report。
    // 例：account 模块有 getList（用户列表）与 getSystemServerAccountList（系统服务账号列表）时，标准 getList 优先。
    const listPriority = (f: string): number => {
      if (/^(getList|list)$/i.test(f)) return 0;
      if (/list|List|Page|Search|Query|query/i.test(f)) return 1;
      if (/Manage|Stat|Report|report/i.test(f)) return 2;
      return 3;
    };
    const sortedList = [...listOps].sort((a, b) => listPriority(a.func) - listPriority(b.func));
    if (sortedList.length) {
      return { operation: sortedList[0].id, params: {} };
    }
    // 兜底：模块仅有非常规命名的读接口（如 <模块>/<接口模块>.<读日志接口>，POST 列表类但 func 不含 List/Manage，
    // 且含写动词 <合并动词>——<写接口> 才是写接口），且用户为读/列表意图时，选模块内第一个「读型」操作。
    // 判定以「读动词前缀开头」为准（如 get/query/list/logs/search/fetch/find/report/stat/count/export），
    // 不依赖具体接口名，避免写死。<读日志接口> 是读日志接口（get 前缀）不会被误排除（2026-08-24 事故）。
    const readOp = loadApiOperationIndex().operations.find(
      (o) =>
        o.module === module &&
        /^(get|query|list|logs|search|fetch|find|report|stat|count|export)/i.test(o.func) &&
        !/getById|getDetail/i.test(o.func),
    );
    if (readOp) return { operation: readOp.id, params: {} };
  }

  if (id && operationType === "read") {
    return resolveModuleDetail(module);
  }

  return null;
}

/** 从 grep_codebase 结果解析接口模块（完全抛弃 aliases：依赖源码 grep 命中，不靠索引/别名表）。
 *  1) grep 命中 src/api/**\/*.ts 接口文件 → 路径即模块 id（src/api/<模块>/<接口模块>.ts → <模块>/<接口模块>）；
 *  2) 无 api 命中但命中 src/views/**（页面文件）→ read_file 读页面源码，提取 @/api/xxx import 得到接口模块；
 *  3) api/views 均未定位成功且 term 非空 → 翻译表实时反查（「账号合并」类纯 i18n 页面；
 *     lookupTermModules：术语→key→路由 meta.title→组件→api import）。条件不限于 grepText 命中 locales：
 *     extractGrepPattern 可能粘连数字（如「账号合并558523069977」）导致全 src grep 零命中；
 *     唯一候选直接用、多候选提示不硬调；
 *  4) 均无 → 回退模型已提交的模块（可能为空，由调用方决定 partial）。 */
async function resolveModuleFromGrep(
  grepText: string,
  fallbackModule: string,
  ctx: OrchestrateContext,
  steps: AgentStep[],
  term = "",
): Promise<string> {
  // 统一候选收集：所有路径产出的模块 id 都进 candidates（去重），最后按
  // 「唯一直接用 / 多候选诚实澄清 / 全空回退模型」统一裁决。不写死任何模块名或中文词。
  const candidates: string[] = [];
  let translationHits: ReturnType<typeof lookupTermModules> = [];

  // 1) api 接口文件路径命中（rg 反斜杠 与 grepCodebaseNative 正斜杠 均兼容）：可能命中多个 api 文件。
  for (const m of grepText.matchAll(/src[\\/]api[\\/]([A-Za-z0-9_./-]+)\.ts/gi)) {
    candidates.push(m[1].replace(/\\/g, "/"));
  }
  // 2) views 页面命中 → 读页面源码找 api import（服务端代模型确认接口模块）。
  //    Vite alias 有两种写法：/@/api/<模块>/<接口模块> 与 @/api/<模块>/<接口模块>。
  //    遍历最多 4 个命中文件（grep 首个命中文件可能是 Modal 等无 import 的兄弟组件），全部候选收集不静默选一。
  const viewFiles = [...grepText.matchAll(/([A-Za-z]:[\\/][^\n:]*src[\\/]views[\\/][\w/.-]+\.(?:vue|ts|js))/gi)]
    .map((m) => m[1])
    .slice(0, 4);
  for (const viewFile of viewFiles) {
    try {
      const content = await runOrchestrateTool("read_file", { path: viewFile }, ctx, steps);
      const imp = content.content.match(/(?:from\s+['"]|import\s*\(\s*['"])(?:\/@\/|@\/)api\/([A-Za-z0-9_./-]+)['"]/);
      if (imp) candidates.push(imp[1].replace(/\/$/, ""));
    } catch { /* 读文件失败继续下一个 */ }
  }
  // 3) 「账号合并」类纯 i18n 页面 → 翻译表实时反查模块（A+ 方案 2026-08-24）。
  //    条件不限于 grepText 命中 locales：extractGrepPattern 可能粘连数字（如「账号合并558523069977」）
  //    导致全 src grep 零命中，因此只要 api/views 均未定位成功且 term 非空即尝试反查。
  //    反查内部含「剥离数字/英文/标点」的中文变体匹配，多候选命中带菜单标题/路由/组件供澄清区分。
  if (term && candidates.length === 0) {
    try {
      translationHits = lookupTermModules(term, resolveCodebaseRoot());
      for (const h of translationHits) candidates.push(h.moduleId);
    } catch { /* 反查异常回退（不影响主流程） */ }
  }

  // 统一裁决：去重后唯一 → 直接用；多候选 → 交澄清（带清单）；全空 → 回退模型已提交模块。
  const uniq = [...new Set(candidates)];
  if (uniq.length === 1) return uniq[0];
  if (uniq.length > 1) {
    const text = translationHits.length > 1
      ? formatTranslationHits(term, translationHits) // 翻译表歧义带菜单标题/路由/组件，用户可区分
      : `[模块歧义]「${term || grepText}」命中多个候选模块：${uniq.join("、")}，请明确要查哪一个。`;
    steps.push({ kind: "system", text });
    return "";
  }
  return fallbackModule;
}

function parseApiPayload(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && "data" in parsed) return parsed.data;
    return parsed;
  } catch {
    return raw;
  }
}

/** 从 normalize_output 返回文本中提取对齐后的 JSON 对象（剥离“[已对齐 PC 端字段 …]”等前缀文本） */
function extractJsonFromNormalized(text: string): unknown {
  const idx = text.indexOf("{");
  if (idx < 0) return undefined;
  try {
    return JSON.parse(text.slice(idx));
  } catch {
    // 前缀行内就含 {（如“结果:{...”）时会从 { 截断，兼容处理：找不到首个 { 处合法则按行逐段尝试
    const lines = text.split("\n");
    for (const l of lines) {
      const i = l.indexOf("{");
      if (i < 0) continue;
      try {
        return JSON.parse(l.slice(i));
      } catch {
        /* continue */
      }
    }
    return undefined;
  }
}

/** 从接口返回值中取出行数组（兼容 {rows} / {list} / 裸数组） */
function extractTableRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.rows)) return o.rows as Record<string, unknown>[];
    if (Array.isArray(o.list)) return o.list as Record<string, unknown>[];
    if (Array.isArray(o.data)) return o.data as Record<string, unknown>[];
  }
  return [];
}

/** 从 get_page_schema 返回文本解析页面主形态（list / edit / analysis_chart / …） */
function extractPageShape(text: string): string {
  try {
    const parsed = JSON.parse(text) as { pages?: Array<{ primaryType?: string }> };
    const primary = parsed?.pages?.[0]?.primaryType;
    return primary || "unknown";
  } catch {
    return "unknown";
  }
}

/** 从 get_list_columns 返回文本解析 PC 端列定义（列序 + 表头 + dataIndex）。
 *  多组 results 时，优先选与行数据字段交集最多的那组（避免命中错误模块的列定义）。 */
interface PcColumnDef {
  title: string;
  dataIndex: string;
  width?: number;
}
function extractPcColumns(text: string, rows: Record<string, unknown>[]): PcColumnDef[] {
  try {
    const parsed = JSON.parse(text) as {
      results?: Array<{ columns?: Array<{ title?: string; dataIndex?: string; width?: number }> }>;
    };
    const groups = (parsed?.results || [])
      .map((r) =>
        (r.columns || [])
          .map((c) => ({ title: String(c.title || ""), dataIndex: String(c.dataIndex || ""), width: c.width }))
          .filter((c) => c.dataIndex),
      )
      .filter((g) => g.length);
    if (!groups.length) return [];
    const rowKeys = new Set(Object.keys(rows[0] || {}));
    const score = (g: PcColumnDef[]) =>
      g.reduce((n, c) => n + (rowKeys.has(c.dataIndex) || rowKeys.has(c.dataIndex.replace(/Str$/, "").replace(/Name$/, "")) ? 1 : 0), 0);
    return groups.reduce((best, g) => (score(g) > score(best) ? g : best));
  } catch {
    return [];
  }
}

/** PC 列与行数据匹配：支持 dataIndex 精确 / 后缀别名（statusStr↔status）/ Name 派生（memberLevel→memberLevelName）。
 *  匹配失败的列保留原 dataIndex（渲染层按通用规则尝试从 record 派生）。 */
function resolvePcColumnDataIndex(pc: PcColumnDef, row: Record<string, unknown>): string {
  if (pc.dataIndex in row) return pc.dataIndex;
  const noSuffix = pc.dataIndex.replace(/Str$/, "").replace(/Name$/, "");
  if (noSuffix in row) return noSuffix;
  // Name 派生：PC 列 dataIndex 无 Name，但记录里有 XxxName（如 memberLevel → memberLevelName）
  if (`${pc.dataIndex}Name` in row) return `${pc.dataIndex}Name`;
  // 数组派生：PC 列如 categories，记录里字段本身就是数组
  if (Array.isArray(row[pc.dataIndex])) return pc.dataIndex;
  return pc.dataIndex;
}

/** 按 PC 列定义确定展示列（列序 + 表头 + 取值 key），保留整行数据供渲染层派生字段；
 *  无 PC 列时回退通用精简。
 *  无条件保留所有 PC 列：后端 row 字段缺失时（特别是点路径 dataIndex 如 <嵌套对象>.<字段名>）
 *  走 renderCell 优雅降级（空字符串），保证 PC 端列定义不丢失（修 2026-08-24 用户列表只渲染 4 列）。 */
function pickRowsByPcColumns(
  rows: Record<string, unknown>[],
  pcColumns: PcColumnDef[],
): { rows: Record<string, unknown>[]; headers: string[]; keys: string[]; widths?: (number | undefined)[] } {
  if (!pcColumns.length) {
    const clean = sanitizeRowsForTable(rows);
    const keys = Object.keys(clean[0] || {});
    return { rows: clean, headers: keys.map(colTitle), keys };
  }
  const sample = rows[0] || {};
  const chosen: Array<{ title: string; dataIndex: string; width?: number }> = [];
  for (const pc of pcColumns) {
    const k = resolvePcColumnDataIndex(pc, sample);
    // 无条件保留 PC 列：缺数据时 renderCell 返回空，列定义不丢
    chosen.push({ title: pc.title, dataIndex: k, width: pc.width });
  }
  if (!chosen.length) {
    const clean = sanitizeRowsForTable(rows);
    const keys = Object.keys(clean[0] || {});
    return { rows: clean, headers: keys.map(colTitle), keys };
  }
  const keys = chosen.map((c) => c.dataIndex);
  const headers = chosen.map((c) => c.title);
  const widths = chosen.map((c) => c.width);
  // 保留整行（不裁剪），供 renderCell 按同记录字段派生（memberLevelName/tags 组合等）
  return { rows, headers, keys, widths };
}

/** 列表展示用：仅保留标量且非图片/长文本/数组类字段，列数上限 10，贴近 PC 端列表核心列 */
function sanitizeRowsForTable(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const DROP = /(cover|image|img|url|banner|poster|avatar|bucket|provider|secure|serverTime|brief|introduction|description|imdb|severity|category|tag|language|country|unlock|store|token|password)/i;
  const keys = Object.keys(rows[0] || {}).filter((k) => {
    if (DROP.test(k)) return false;
    const v = (rows[0] as Record<string, unknown>)[k];
    return v == null || typeof v !== "object"; // 仅保留标量
  });
  // 若同时存在 Xxx 与 XxxName（后者是中文枚举名），去掉冗余的数字枚举字段 Xxx
  const keep0 = keys.slice(0, 10);
  const keep = keep0.filter((k) => !(keep0.includes(`${k}Name`)));
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const k of keep) out[k] = r[k];
    return out;
  });
}

/** 字段 → 中文列标题（2026-08-24 去写死）：静态 MAP 已删除，表头中文化完全交给
 *  pc-column-mapping skill 实时读 PC 源码（configs.data.tsx / i18n），此处直接返回原 key。
 *  保留函数签名仅为兼容「英文表头检测」（colTitle(k)===k 即视为需模型映射的英文字段）。 */
function colTitle(key: string): string {
  return key;
}

/** 详情（单条对象）PC 端 Form 格式渲染：按 PC 端 formSchema 字段顺序，以两列表格（字段 | 值）输出。
 *  - 字段顺序/label/控件以 PC 端 formSchema（formFields）为准，对齐 PC 端详情/编辑页。
 *  - 无 formFields 时回退：fieldMap（superpower 配置）→ colTitle（通用字典）→ 原字段名。
 *  - 空字段也显示（占位"-"），与 PC 端 Edit 页一致；仅过滤无关元数据字段；
 *    Boolean 开关 → 是/否，时间戳 → 日期。
 *  - 返回 { md, rows }：md 为 Markdown 表格文本（前端 markdown-it 直接渲染表格），
 *    rows 为结构化行数据（供推送 { type: "table" } 事件，ResultTable 组件渲染）。 */
function renderDetail(
  record: Record<string, unknown>,
  moduleKey: string,
  formFields?: Array<{ field: string; label: string; component?: string; required?: boolean }>,
  fieldMap?: Record<string, string>,
  enums?: Record<string, Record<string, string>>,
  rules?: ModuleRenderRules,
): { md: string; rows: Array<{ field: string; value: string }> } {
  const DROP_KEY = /(secure|serverTime|bucket|_v|__v|isDelete|deleted|updateBy|createBy|operator)/i;
  const cells: Array<{ field: string; value: string }> = [];
  // PC 端 Edit 页会显示所有表单字段，值为空时展示占位"-"，不省略字段
  const push = (label: string, key: string) => {
    if (DROP_KEY.test(key)) return;
    const v = record[key];
    const isEmpty = v == null || v === "" || (Array.isArray(v) && v.length === 0)
      || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);
    if (isEmpty) {
      cells.push({ field: label, value: "-" });
      return;
    }
    cells.push({ field: label, value: renderCell(record, key, enums?.[key], rules) });
  };

  if (formFields?.length) {
    // 严格按 PC 端 formSchema 字段顺序展示（与 PC 端详情/编辑页一致）：
    // 所有 formSchema 字段都展示，即使记录里没有该字段也显示占位"-"。
    // 之后再补充 record 中存在但 formFields 未覆盖的字段（如 id/createTime/updateTime 等），
    // 保证"所有相关字段"都输出，不遗漏详情数据里实际存在的业务字段。
    const covered = new Set(formFields.map((f) => f.field));
    for (const f of formFields) {
      push(f.label || colTitle(f.field), f.field);
    }
    for (const key of Object.keys(record)) {
      if (covered.has(key) || DROP_KEY.test(key)) continue;
      const label = (fieldMap && fieldMap[key]) || colTitle(key);
      push(label, key);
    }
  } else {
    // 无 formFields 时回退：优先按 fieldMap 全字段清单展示（PC 端配置的字段都显示，含空字段占位"-"），
    // 保证空字段不因 record 缺少 key 而被省略；fieldMap 为空才退化为仅展示记录中存在的字段。
    const keys = fieldMap && Object.keys(fieldMap).length
      ? Object.keys(fieldMap)
      : Object.keys(record);
    for (const key of keys) {
      if (DROP_KEY.test(key)) continue;
      const label = (fieldMap && fieldMap[key]) || colTitle(key);
      push(label, key);
    }
  }
  const md =
    `| 字段 | 值 |\n` +
    `| --- | --- |\n` +
    cells.map((c) => `| ${c.field} | ${mdCellEscape(c.value)} |`).join("\n");
  return {
    md: `【${moduleKey} 详情】\n\n${md}`,
    rows: cells,
  };
}

/** 渲染规则类型（superpower 层 field-mapping.json 的 modules.<m>.renderRules 驱动） */
interface ModuleRenderRules {
  boolean?: string[]; // 布尔字段：true/false → 是/否
  nameFrom?: Record<string, string>; // 用同记录 XxxName 展示：{ memberLevel: "memberLevelName" }
  image?: string[]; // 图片字段（值 URL → markdown 图片）
  arrayJoin?: Record<string, string>; // 数组字段 join 分隔符：{ languages: "、", tags: "、" }
  // 位掩码字段（位或组合 → 解析出命中项列表）：{ terminalFlag: [{ bit: 2, label: "Android" }, ...] }
  // 与 PC 端 options.ts 的 getClientType*ByOperatorOptions 对齐；未配置时按字段名通用兜底（见 TERMINAL_FLAG_BITS）
  bitmask?: Record<string, Array<{ bit: number; label: string }>>;
  // 简化摘要（一行组合）：{ field: 触发字段, parts: 组成字段数组, sep: 分隔符, labelMap: 可选 { 字段: 前缀标签 } }
  summary?: Array<{
    field: string;
    parts: string[];
    sep?: string;
    labelMap?: Record<string, string>;
  }>;
}

interface ModuleRenderConfig {
  enums: Record<string, Record<string, string>>;
  rules: ModuleRenderRules;
  fieldMap: Record<string, string>; // 字段名 → PC 中文列标题（列标题兜底用）
}

/** 模块渲染配置：renderRules/fieldMap 读 field-mapping.json（渲染行为定义），
 *  enums（枚举值翻译）由源码提取（configs.data.tsx customRender / useFormSchema options）
 *  驱动——2026-08-24 起枚举映射不再配置维护，改源码提取（确定性、零成本、多项目按 codebaseRoot）。
 *  缓存 TTL 30s（key 含 codebaseRoot 隔离多项目）。 */
const renderConfigCache = new Map<string, { cfg: ModuleRenderConfig; at: number }>();
const RENDER_CONFIG_TTL = 30_000;
function loadModuleRenderConfig(module: string): ModuleRenderConfig {
  const root = resolveCodebaseRoot();
  const cacheKey = `${root}::${module}`;
  const cached = renderConfigCache.get(cacheKey);
  if (cached && Date.now() - cached.at < RENDER_CONFIG_TTL) return cached.cfg;

  const cfg: ModuleRenderConfig = { enums: {}, rules: {}, fieldMap: {} };
  try {
    const raw = resolveLocalDoc(defaultFieldMappingPath());
    if ("note" in raw) {
      const mapping = JSON.parse((raw as { note: { text: string } }).note.text) as {
        modules?: Record<
          string,
          {
            renderRules?: ModuleRenderRules;
            fieldMap?: Record<string, string>;
          }
        >;
      };
      const mod = mapping.modules?.[module];
      if (mod) {
        cfg.rules = mod.renderRules || {};
        cfg.fieldMap = mod.fieldMap || {};
      }
    }
  } catch { /* field-mapping 渲染规则读不到时回退空 */ }
  // 源码枚举提取（customRender MAP / 三目 / useFormSchema options），渲染值翻译的第一来源
  try {
    const fmRaw = execGetFieldMapping({ module });
    const fm = JSON.parse(fmRaw) as { enumMap?: Record<string, Record<string, string>> };
    if (fm.enumMap && Object.keys(fm.enumMap).length) cfg.enums = fm.enumMap;
  } catch { /* 源码提取失败时 enums 为空，renderCell 走通用推断 */ }

  renderConfigCache.set(cacheKey, { cfg, at: Date.now() });
  return cfg;
}

/** 语言 id → 中文名（2026-08-24 去写死）：静态 MAP 已删除，语言中文化交给模型
 *  （有真实来源时调 language/getOptionList 或按 pc-column-mapping 方式读源码），此处直接返回原值。 */
function langLabel(id: string): string {
  return id;
}

/** 时间戳 → YYYY-MM-DD HH:mm（毫秒/秒自动识别） */
function formatTs(v: unknown): string | null {
  if (typeof v !== "number" && typeof v !== "string") return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n) || n <= 0) return null;
  // 秒级时间戳（10 位）补成毫秒
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 通用单元格渲染（对齐 PC 端 customRender）：
 * - 布尔 → 是/否
 * - 有 XxxName 的枚举数字字段 → 取同记录 XxxName（memberLevel → memberLevelName）
 * - 图片字段（cover/image/poster/avatar/banner/icon，值为 URL）→ Markdown 图片
 * - 时间戳 → 日期；枚举 → field-mapping enumMap；数组 → 按语义 join；URL → 截断
 */
const IMAGE_KEY_RE = /(cover|image|img|poster|avatar|banner|icon|pic)/i;
const ARRAY_JOIN_RE = /(language|tag|country|categories|category|area|resolution|quality|type)/i;
/** PC 端终端标识位掩码（options.ts getClientTypeByOperatorOptions）：
 *  2: Android, 4: iOS, 8: web, 16: h5, 32: windows, 64: Android TV
 *  值为位或组合，渲染时按 (value & bit) === bit 解析出具体终端列表 */
/** 通用终端标识位掩码（PC options.ts getClientTypeByOperatorOptions）：2 Android, 4 iOS, 8 web, 16 h5, 32 windows, 64 Android_TV。
 *  仅作未配置 renderRules.bitmask 时的字段名兜底；productFlag 等不同掩码集字段须在 field-mapping.json 显式配置。 */
const TERMINAL_FLAG_BITS: Array<{ bit: number; label: string }> = [
  { bit: 2, label: "Android" },
  { bit: 4, label: "iOS" },
  { bit: 8, label: "Web" },
  { bit: 16, label: "H5" },
  { bit: 32, label: "Windows" },
  { bit: 64, label: "Android TV" },
];
const TERMINAL_FLAG_KEY_RE = /^terminalFlag$/i;

function renderCell(
  record: Record<string, unknown>,
  key: string,
  enumMap?: Record<string, string>,
  rules?: ModuleRenderRules,
): string {
  // 配置优先：renderRules 显式声明的渲染方式
  if (rules) {
    if (rules.boolean?.includes(key)) {
      const b = record[key];
      return b == null || b === false || b === 0 || b === "0" || b === "false" ? "否" : "是";
    }
    const summaryRule = rules.summary?.find((s) => s.field === key);
    if (summaryRule) {
      // 简化摘要（配置驱动）：按 parts 声明的字段依次取值组合一行
      const parts: string[] = [];
      const sep = summaryRule.sep || " · ";
      for (const src of summaryRule.parts) {
        const v = record[src];
        if (v == null) continue;
        let seg = "";
        if (Array.isArray(v)) {
          seg = v
            .map((it) => (it && typeof it === "object" ? (it as Record<string, unknown>).value ?? "" : it))
            .filter(Boolean)
            .join("、");
        } else {
          seg = String(v);
        }
        if (!seg) continue;
        const label = summaryRule.labelMap?.[src];
        parts.push(label ? `${label}:${seg}` : seg);
      }
      return parts.join(sep) || "-";
    }
    const nameSrc = rules.nameFrom?.[key];
    if (nameSrc && record[nameSrc] != null && String(record[nameSrc]) !== "") return String(record[nameSrc]);
    if (rules.image?.includes(key)) {
      const u = record[key];
      if (typeof u === "string" && /^https?:\/\//i.test(u)) return `![${key}](${u})`;
    }
  }
  // Name 派生：PC 用 XxxName 展示（memberLevel → memberLevelName）；XxxName 缺失或为空则回退原值
  const nameVal = record[`${key}Name`];
  if (nameVal != null && nameVal !== "" && !(nameVal === record[key] && typeof record[key] === "string")) {
    return String(nameVal);
  }
  // 点路径支持：dataIndex 含 . 时按嵌套对象逐层取值（修 2026-08-24 <嵌套对象>.<字段名> 列）
  let v: unknown = record[key];
  if (v == null && key.includes(".")) {
    const parts = key.split(".");
    let cur: unknown = record;
    for (const p of parts) {
      if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        cur = undefined;
        break;
      }
    }
    v = cur;
  }
  if (v == null || v === "") return "";

  // 数组：languages/tags/countries/categories 等按语义 join；categories 为对象数组取 value
  if (Array.isArray(v)) {
    // 多语言对象数组 [{ languageId, value }]（names 等）→ 渲染为「语言:值」
    const first = v[0];
    if (first && typeof first === "object" && "languageId" in (first as object) && "value" in (first as object)) {
      return (v as Array<Record<string, unknown>>)
        .map((it) => `${langLabel(String(it.languageId))}:${String(it.value ?? "")}`)
        .join("；");
    }
    const items = (v as unknown[]).map((it) => (it && typeof it === "object" ? (it as Record<string, unknown>).value ?? "" : it)).filter(Boolean);
    if (!items.length) return "-";
    const sep = rules?.arrayJoin?.[key] || (ARRAY_JOIN_RE.test(key) ? "、" : ", ");
    return items.join(sep);
  }
  if (typeof v === "boolean") return v ? "是" : "否";
  if (typeof v === "object") return "{…}";

  // 位掩码字段（位或组合 → 解析出命中项列表）：优先用 field-mapping.json 的 renderRules.bitmask 配置
  // （对齐 PC 端 options.ts getClientType*ByOperatorOptions，banner 等不同掩码集须显式配置）；
  // 未配置时仅 terminalFlag 字段走通用兜底（TERMINAL_FLAG_BITS）。
  if (/^\d+$/.test(String(v))) {
    const num = Number(v);
    const configured = rules?.bitmask?.[key];
    const bits = configured && configured.length ? configured : (TERMINAL_FLAG_KEY_RE.test(key) ? TERMINAL_FLAG_BITS : undefined);
    if (bits?.length) {
      const labels = bits.filter((el) => (num & el.bit) === el.bit).map((el) => el.label);
      if (labels.length) return labels.join("、");
    }
  }

  const s = String(v);
  // 图片字段且值为 URL → 渲染图片
  if (IMAGE_KEY_RE.test(key) && /^https?:\/\//i.test(s)) {
    return `![${key}](${s})`;
  }
  if (enumMap && s in enumMap) return enumMap[s];
  if (/^1\d{12}$/.test(s) || /^1\d{9}$/.test(s)) {
    const ts = formatTs(s);
    if (ts) return ts;
  }
  if (/^https?:\/\//i.test(s) && s.length > 60) {
    return `${s.slice(0, 55)}…`;
  }
  return s;
}

/** Markdown 单元格转义：竖线改为全角，换行折叠为空格 */
function mdCellEscape(s: string): string {
  return s.replace(/\|/g, "｜").replace(/\n+/g, " ").trim();
}

async function runOrchestrateTool(
  name: string,
  input: Record<string, unknown>,
  ctx: OrchestrateContext,
  steps: AgentStep[],
): Promise<{ content: string; steps: AgentStep[] }> {
  const callId = `orch-${name}-${randomUUID()}`;
  ctx.emitEvent?.({ type: "tool_call", name, input });
  const content = await runAgentTool(name, input, {
    token: ctx.token,
    country: ctx.country,
    menus: ctx.menus,
    sessionId: ctx.sessionId,
  });
  ctx.emitEvent?.({ type: "tool_result", name, result: truncateToolResultForUi(content) });
  const nextSteps: AgentStep[] = [
    ...steps,
    { kind: "toolCalls", calls: [{ id: callId, name, input }] },
    { kind: "toolResult", toolCallId: callId, content },
  ];
  return { content, steps: nextSteps };
}

/** 生成某模块的可执行操作清单（能力询问用）：
 *  从 api-operation-index.json 取该模块全部 operations，按 func 归类，用 logOperator 中文说明展示，
 *  并附示例问法，让用户知道可以说「新增/修改/删除/查看某条」。
 */
function buildModuleCapabilitiesText(moduleId: string): string {
  const index = loadApiOperationIndex();
  const ops = index.operations.filter((o) => o.module === moduleId || o.id.startsWith(`${moduleId}.`));
  // 友好模块名：优先中文别名（如 tag → 三级分类），否则用内部 key
  let moduleLabel = moduleId;
  try {
    const hits = resolveApiModules(moduleId);
    const aliases = hits[0]?.aliases || [];
    // 优先选含中文的别名作友好模块名（业务实体词优先于泛化词，由索引数据驱动，无写死词表）
    const cn = aliases.find((a) => /[\u4e00-\u9fa5]/.test(a));
    if (cn) moduleLabel = cn;
  } catch { /* 回退内部 key */ }
  if (!ops.length) {
    return (
      `【${moduleLabel}】暂未登记可执行操作（api-operation-index.json 无该模块记录）。\n` +
      `你可以直接告诉我具体想做什么，例如「查看${moduleLabel}列表」「${moduleLabel}的详情」等。`
    );
  }

  // 按 func 语义分组，去重同 func 不同 method 的重复项（如 createOrUpdate 同时是 create/update）
  const seen = new Set<string>();
  const lines: string[] = [];
  const opLabel: Record<string, string> = {
    getList: "查看列表",
    getById: "查看详情",
    create: "新增",
    createOrUpdate: "新增 / 编辑",
    update: "修改 / 编辑",
    edit: "修改 / 编辑",
    remove: "删除",
    delete: "删除",
    setVisible: "上下线 / 显示隐藏",
    setState: "状态变更",
    setStatus: "状态变更",
    audit: "审核",
    export: "导出",
  };
  for (const op of ops) {
    if (seen.has(op.func)) continue;
    seen.add(op.func);
    // ⚠️【临时只读模式】只展示当前可执行的读操作：正向白名单「英文读语义前缀」
    // （get/query/list/search/fetch/find/report/stat/count/export/download）；
    // 其余（create/update/delete/remove/set*/audit 等 CRUD 写契约词，含 setStatus 这类改状态）
    // 已被只读拦截，列出会误导用户以为可写。恢复读写时删除本过滤恢复展示全部。
    if (!/^(get|query|list|search|fetch|find|report|stat|count|export|download)/i.test(op.func)) continue;
    // 动作词：优先 logOperator（如"更新标签"）；否则用标准 func 语义标签；
    // 两者都没有的（如 film 的 getRepeat/getLack 等业务扩展接口）不展示，
    // 避免把原始函数名暴露给用户（这些非标准操作用户也无法直接口语化调用）。
    const action = op.logOperator || opLabel[op.func];
    if (!action) continue;
    lines.push(`- **${action}**`);
  }
  // 全部被过滤（模块只有非标准操作）→ 提示可查询能力有限
  if (!lines.length) {
    return (
      `【${moduleLabel}】暂无可直接执行的常规操作（仅查询/维护接口）。\n` +
      `你可以直接告诉我具体想做什么，例如「查看${moduleLabel}列表」「${moduleLabel}的详情」等。`
    );
  }

  return (
    `【${moduleLabel}】支持以下操作：\n\n${lines.join("\n")}\n\n` +
    `你可以直接对我说，例如：「查看${moduleLabel}列表」「${moduleLabel}某条记录的详情」等。`
  );
}

/** 业务请求规则编排；须在大模型理解之后调用 */
export async function orchestrateBusinessQuery(ctx: OrchestrateContext): Promise<OrchestrateResult> {
  const { userText, llmIntent } = ctx;
  if (llmIntent && !llmIntent.isBusinessRequest) return { kind: "skip" };

  // 前端偶发带 HTML 富文本（<div...><p>..</p></div>）。业务编排的 grep 定位 / parse_intent 解析
  // 必须基于纯文本，否则会把 <divdata-v-32b89 当成业务词 grep（永远命中不到 → module 为空 → 误报未找到接口）。
  const plainUserText = stripHtmlTags(userText);

  let steps: AgentStep[] = ctx.priorSteps ? [...ctx.priorSteps] : [];
  // 完整接口 operation（module.func）：优先用模型按 api-interface-routing skill 选定的
  // llmIntent.operation（模型读接口源码精确给出）；模型未给时才回退到从用户原文提取
  // （用户直接说了 <模块>.<接口> 这类显式 id）。两者都没有 → inferCallOperation 按命名惯例兜底。
  const explicitOp = llmIntent?.operation || extractExplicitOperation(plainUserText);

  // 1. 规则校验槽位（使用模型理解结果，不再从原文猜模块）。
  // 完全抛弃 aliases（2026-08-22）：不再用候选索引补全模块——模型没给 module 时，
  // parse_intent 在 retryOnModuleAmbiguity 下放行（module 空），由下方步骤 2/3 的
  // grep_codebase + search_api_module 服务端代模型定位（依赖 grep 命中）。
  const intentModule = llmIntent?.module || "";
  const intent = await runOrchestrateTool(
    "parse_intent",
    {
      userInput: plainUserText,
      understoodFromLlm: Boolean(llmIntent),
      // retryOnModuleAmbiguity：orchestrate 无模型 loop——parse_intent 在「模型未给 module」时放行
      // （不反问），由下方 grep 步骤服务端代模型定位；模型给了不可调用的 id 则返回 MODULE_RETRY。
      retryOnModuleAmbiguity: true,
      understoodProject: llmIntent?.project || "",
      understoodModule: intentModule,
      understoodValue: llmIntent?.value || "",
      understoodOperation: llmIntent?.operationType || "",
    },
    ctx,
    steps,
  );
  steps = intent.steps;

  let parsed: { module?: string; operationType?: "read" | "write" | "capabilities"; value?: string } = {};
  try {
    parsed = JSON.parse(intent.content) as typeof parsed;
  } catch {
    // MODULE_RETRY 文本（非 JSON）：模型给的 module 不可调用（orchestrate 无模型可回传自愈）。
    // 不沿用错误 id（可能误导 grep），放行到下方 grep 步骤用 extractGrepPattern 从用户原文定位。
    if (intent.content.startsWith("MODULE_RETRY")) {
      parsed = {};
    } else {
      return { kind: "partial", steps };
    }
  }

  const parsedModule = String(parsed.module || intentModule || "").trim();
  const operationType = parsed.operationType === "write" ? "write" : parsed.operationType === "capabilities" ? "capabilities" : "read";
  if (!parsedModule) {
    // parse_intent 返回 CLARIFICATION_REQUIRED（主流程风格反问，如模型给了不可调用 id）→ 澄清
    if (intent.content.startsWith("CLARIFICATION_REQUIRED")) {
      return {
        kind: "clarification",
        clarificationText: intent.content.replace(/^CLARIFICATION_REQUIRED\s*/, "").trim(),
        steps,
      };
    }
    // module 为空（模型未给，候选已抛弃）：不直接 partial，放行到下方步骤 2/3，
    // 由 grep_codebase（pattern 取 extractGrepPattern）+ search_api_module 服务端代模型定位，
    // 定位不到（search 无命中）时在步骤 4 后 partial。
  }

  // 能力询问（可以做哪些操作/支持哪些操作）：不调接口，从 api-operation-index 生成该模块的中文操作清单。
  // 模块未定位时无法生成能力清单（避免 buildModuleCapabilitiesText("") 空转）。
  if (operationType === "capabilities") {
    if (!parsedModule) {
      return { kind: "partial", steps };
    }
    const capText = buildModuleCapabilitiesText(parsedModule);
    steps.push({
      kind: "system",
      text: `[workflow/orchestrate] ${parsedModule} 模块能力清单已生成。`,
    });
    return {
      kind: "executed",
      steps,
      module: parsedModule,
      normalizedText: capText,
    };
  }

  // 2. grep 定位接口模块（完全抛弃 aliases：依赖源码 grep 命中，不靠索引/别名表）。
  //    无 module 时 pattern 直接取模型原始输入（extractGrepPattern 仅做英文 module.operation 归一 +
  //    截断，不做中文剥词——「口语词→核心词」语义判断交模型，对齐 Cursor 红线）。grep 未直接命中
  //    api 文件时，resolveModuleFromGrep 会读命中 views 页面源码提取 @/api/xxx import。
  const pattern = llmIntent?.module || parsedModule || extractGrepPattern(plainUserText);
  const grep = await runOrchestrateTool("grep_codebase", { pattern, maxResults: 12 }, ctx, steps);
  steps = grep.steps;
  let module = await resolveModuleFromGrep(grep.content, parsedModule, ctx, steps, extractGrepPattern(plainUserText));
  // 收缩重搜兜底（2026-08-24，方案 A）：口语词「留存报表」≠ 源码命名「留存率数据统计」（retentionTotal），
  // 整词 grep 零命中且模块未解析时，词尾逐字收缩（报表→留存）后轻量 grep api/views，首个命中候选即返回。
  // 命中结果复用 resolveModuleFromGrep 提取模块 id（api 路径直接命中 / views 读页面源码找 api import），
  // 多候选不硬调（resolveModuleFromGrep 内部有候选裁决逻辑），不引入映射表。
  if (!module) {
    const term = extractGrepPattern(plainUserText);
    if (/[\u4e00-\u9fa5]{2,}/.test(term)) {
      try {
        const root = resolveCodebaseRoot();
        const hit = runContractSearch(term, [nodePath.join(root, "src", "api"), nodePath.join(root, "src", "views")], 6);
        if (hit) {
          steps.push({
            kind: "system",
            text:
              `[收缩重搜]「${term}」在源码中未直接命中（口语词/别名与源码命名不一致），收缩为「${hit.pattern}」命中：` +
              hit.files.map((f) => f.split(/[\\/]/).slice(-2).join("/")).join("、"),
          });
          module = await resolveModuleFromGrep(hit.files.join("\n"), parsedModule, ctx, steps, hit.pattern);
        }
      } catch { /* 收缩重搜失败不影响主流程（module 保持空走原 partial 路径） */ }
    }
  }
  // grep 兜底：源码 grep（依赖中文/英文命中）对「账号合并」这类源码无文本对应的中文术语必然落空。
  // 2026-08-22/24：索引文件已删除（完全抛弃 aliases），resolveApiModules 降级返回空结果，
  // 原「索引术语兜底」if 块（引用未定义的 usableModules）为死代码，2026-08-24 一并删除；
  // 模块定位完全交模型 grep 源码（search_api_module / read_api_module）。

  // 4. 推断 operation 并 call_api
  let callSpec: ReturnType<typeof inferCallOperation>;
  try {
    callSpec = inferCallOperation(
      module,
      plainUserText,
      operationType,
      explicitOp,
      llmIntent?.operationHint,
      llmIntent?.value || parsed.value,
      ctx.sessionId,
    );
  } catch (e) {
    steps.push({
      kind: "system",
      text: `查询失败：无法定位到可调用的接口（${(e as Error).message}）。请稍后重试或换个说法。`,
    });
    return { kind: "partial", steps };
  }
  if (!callSpec) {
    // 多候选歧义未决：resolveModuleFromGrep 已 push「[翻译表反查]」候选清单（带菜单标题/路由/组件），
    // 此处转 clarification 交用户区分（如「用户列表」= 业务账号 user / 系统用户），而非失败或沿用模型拍板。
    const ambiguityStep = steps.find((s) => s.kind === "system" && s.text.includes("[翻译表反查]"));
    if (ambiguityStep) {
      return { kind: "clarification", clarificationText: ambiguityStep.text, steps };
    }
    steps.push({
      kind: "system",
      text: "查询失败：未找到该模块对应的详情/列表接口。请提供更明确的信息后重试。",
    });
    return { kind: "partial", steps };
  }

  // ⚠️【临时只读模式】写操作在 orchestrate 兜底路径直接短路：不再引导补齐写参（缺 ID/必填字段的
  // 澄清文案会诱导用户先凑齐写参数，凑齐后仍被 execCallApi 的只读拦截挡住，绕一圈白问），
  // 统一返回只读提示。恢复读写时删除本短路，恢复原「写缺参澄清」（增/改/删关键参数不完整时
  // 先按 PC 端表单字段向用户澄清需要补哪些，避免后端返回笼统的 Parameter checking failed）。
  if (operationType === "write") {
    steps.push({ kind: "system", text: `[workflow/orchestrate] ${READONLY_REPLY}` });
    return { kind: "partial", steps };
  }

  // method 优先取索引中 operation 的真实 HTTP 方法（如 <模块>/<接口模块>.<读日志接口> 是 POST 列表接口，
  // 若按 operationType=read 推断成 GET 会被网关拒绝「invalid method of HTTP」，2026-08-24 事故）；
  // operationType 推断仅作索引缺失时的兜底。
  const opMeta = loadApiOperationIndex().operations.find((o) => o.id === callSpec.operation);
  const httpMethod = opMeta?.method || (operationType === "write" ? "POST" : "GET");

  // 2026-08-24 去写死（对齐 Cursor）：服务端不再做分页循环/多页拼接/补默认分页值。
  // 分页参数（page/size 等）完全由模型按接口契约在 callSpec.params 里提供；分页多页需求由模型在主路径
  // tool-loop 里多次调 call_api 自行拼接。此处只做单次 call_api 调用，服务端不循环、不兜底默认值。
  const api = await runOrchestrateTool(
    "call_api",
    { method: httpMethod, operation: callSpec.operation, params: callSpec.params },
    ctx,
    steps,
  );
  steps = api.steps;
  const payload = parseApiPayload(api.content);

  if (api.content.startsWith("CLARIFICATION_REQUIRED")) {
    return {
      kind: "clarification",
      clarificationText: api.content.replace(/^CLARIFICATION_REQUIRED\s*/, "").trim(),
      steps,
    };
  }

  if (api.content.startsWith("错误：")) {
    steps.push({
      kind: "system",
      text: `查询失败：${api.content.slice(0, 300)}。请核对记录是否存在或稍后重试。`,
    });
    return { kind: "partial", steps };
  }

  // 5. 多轮搜索校对（原则 1.1）：定形态 → 取 PC 列定义 → 字段对齐 → 渲染
  const moduleKey = callSpec.operation.split(".")[0] || module;

  // Step 1: get_page_schema 判定页面形态（list/edit/analysis_chart/…）
  let pageShape = "unknown";
  const shape = await runOrchestrateTool("get_page_schema", { module: moduleKey }, ctx, steps);
  steps = shape.steps;
  if (!shape.content.startsWith("错误：") && !shape.content.startsWith("未识别")) {
    pageShape = extractPageShape(shape.content);
  }

  // Step 2: get_list_columns 取 PC 端真实列定义（表头 + 列序 + dataIndex）
  const columns = await runOrchestrateTool("get_list_columns", { module: moduleKey }, ctx, steps);
  steps = columns.steps;
  const pcColumns = extractPcColumns(columns.content, extractTableRows(payload));

  // Step 3-5: normalize_output 字段名中文化 + 枚举翻译 + 结构对齐
  const normalized = await runOrchestrateTool(
    "normalize_output",
    { module: moduleKey, data: payload },
    ctx,
    steps,
  );
  steps = normalized.steps;

  if (normalized.content.startsWith("错误：")) {
    steps.push({
      kind: "system",
      text: `查询结果处理失败：\n${api.content.slice(0, 2000)}`,
    });
    return { kind: "partial", steps };
  }

  // 5.1 渲染：列表/明细 → 按 PC 列定义裁剪排序输出 Markdown 表格（不再推送 ResultTable 事件，
  // 避免同一份数据在 text 与 tables 双轨重复渲染；最终结果统一由 Markdown 承载）。
  // 数据源用 call_api 原始行（英文 dataIndex），与 PC 列定义对齐；枚举/时间在渲染层转换，避免 key 中文化错位。
  const rawTableRows = extractTableRows(payload);
  const tableRows = rawTableRows.length ? rawTableRows : extractTableRows(extractJsonFromNormalized(normalized.content));
  if (tableRows.length) {
    const { rows: cleanRows, headers, keys } = pickRowsByPcColumns(tableRows, pcColumns);
    const { enums, rules, fieldMap } = loadModuleRenderConfig(moduleKey);
    // 列标题中文化兜底：PC 列 title 为英文（变量 title 用 dataIndex 兜底时）→ 用 fieldMap 中文标题
    const finalHeaders = headers.map((h, i) => {
      const k = keys[i];
      if (/^[A-Za-z_][\w]*$/.test(h) && fieldMap[k]) return fieldMap[k];
      return h;
    });
    const mdRows = cleanRows.map((r) =>
      keys.map((k) => renderCell(r as Record<string, unknown>, k, enums[k], rules)),
    );
    const md =
      `| ${finalHeaders.join(" | ")} |\n` +
      `| ${finalHeaders.map(() => "---").join(" | ")} |\n` +
      mdRows.map((row) => `| ${row.map(mdCellEscape).join(" | ")} |`).join("\n");

    steps.push({
      kind: "system",
      text:
        "[workflow/orchestrate] 已完成 grep → search → call_api → get_page_schema → get_list_columns → normalize → render_table。" +
        "列定义取自 PC 端 configs.data.tsx，请以表格向用户展示，勿再调用工具。",
    });

    const payloadTotal =
      payload && typeof payload === "object" && "total" in (payload as Record<string, unknown>)
        ? (payload as Record<string, unknown>).total
        : tableRows.length;
    const summary = `【${moduleKey}】共 ${payloadTotal} 条记录，已展示前 ${Math.min(tableRows.length, 50)} 条：`;

    return {
      kind: "executed",
      steps,
      module: moduleKey,
      normalizedText: `${summary}\n\n${md}`,
    };
  }

  steps.push({
    kind: "system",
    text:
      "[workflow/orchestrate] 已完成 grep → search → call_api → get_page_schema → get_list_columns → normalize。" +
      "请根据 normalize_output 结果直接向用户展示，勿再调用工具。",
  });

  // 详情（单条对象）：按 PC 端 Form 格式渲染（formSchema 字段顺序 + 中文 label），避免裸 JSON 上屏。
  const detailObj = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
  if (detailObj && Object.keys(detailObj).length) {
    const { enums, rules, fieldMap } = loadModuleRenderConfig(moduleKey);
    // 优先复用 get_page_schema 的 formFields（PC 端 formSchema 字段，含中文 label 与顺序）。
    // 遍历所有 pages 取第一个有 formFields 的页，避免 pages[0] 无表单字段（如列表页）导致空字段不显示。
    let formFields: Array<{ field: string; label: string; component?: string; required?: boolean }> | undefined;
    try {
      const schemaJson = JSON.parse(shape.content) as { pages?: Array<{ formFields?: Array<Record<string, unknown>> }> };
      for (const pg of schemaJson?.pages || []) {
        const ff = pg?.formFields as Array<{ field: string; label: string }> | undefined;
        if (Array.isArray(ff) && ff.length) {
          formFields = ff;
          break;
        }
      }
    } catch { /* ignore */ }
    const detail = renderDetail(detailObj, moduleKey, formFields, fieldMap, enums, rules);
    // 与列表一致：只返回 Markdown 表格文本（normalizedText），不再推送 ResultTable 事件（避免重复渲染）
    steps.push({
      kind: "system",
      text: "[workflow/orchestrate] 已按 PC 端 Form 格式渲染单条记录（两列表格：字段 | 值）。",
    });
    return {
      kind: "executed",
      steps,
      module: moduleKey,
      normalizedText: detail.md,
    };
  }

  return {
    kind: "executed",
    steps,
    module: moduleKey,
    normalizedText: normalized.content,
  };
}

/** 模型自主路径的详情兜底渲染：call_api 返回单条对象时，服务端强制按 PC formSchema 渲染成两列表格，
 *  禁止模型自由发挥（编造字段/把位掩码简写成 "all"）。与 orchestrate 详情分支共用同一套 renderDetail。 */
export async function renderDetailForAgent(
  payload: unknown,
  moduleKey: string,
): Promise<{ md: string; view: ChatTableView; needsModelMapping?: string[]; needsValueMapping?: string[]; fieldDiff?: { pcMissing: string[]; dataExtra: string[] } }> {
  const detailObj = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
  if (!detailObj || !Object.keys(detailObj).length) {
    throw new Error(`payload 不是详情对象（module=${moduleKey}）`);
  }
  const { enums, rules, fieldMap } = loadModuleRenderConfig(moduleKey);
  let formFields: Array<{ field: string; label: string; component?: string; required?: boolean }> | undefined;
  try {
    const shape = await runOrchestrateTool("get_page_schema", { module: moduleKey }, {} as OrchestrateContext, [] as AgentStep[]);
    const schemaJson = JSON.parse(shape.content) as { pages?: Array<{ formFields?: Array<Record<string, unknown>> }> };
    for (const pg of schemaJson?.pages || []) {
      const ff = pg?.formFields as Array<{ field: string; label: string }> | undefined;
      if (Array.isArray(ff) && ff.length) {
        formFields = ff;
        break;
      }
    }
  } catch { /* ignore */ }
  const detail = renderDetail(detailObj, moduleKey, formFields, fieldMap, enums, rules);
  // 字段差异清单（与列表同语义）：formSchema 字段 vs 返回对象字段的结构差异，交模型逐项校对。
  // pcMissing=PC formSchema 有定义但返回对象缺失（渲染为占位"-"）；dataExtra=返回对象有但
  // formSchema 未覆盖（renderDetail 会补充展示）——两者都回喂模型，由模型判断是否接口/参数问题。
  const metaKeyRe = /^(page|pages|pageNum|pageSize|size|current|limit|total|count|offset|rows|list|records|items|data|result|code|msg|message|success|ok|_mock|token|traceId|requestId)$/i;
  const formFieldKeys = new Set((formFields || []).map((f) => f.field));
  const pcMissing = (formFields || []).map((f) => f.field).filter((k) => !(k in detailObj));
  const dataExtra = Object.keys(detailObj).filter((k) => !formFieldKeys.has(k) && !metaKeyRe.test(k));
  const fieldDiff = pcMissing.length || dataExtra.length ? { pcMissing, dataExtra } : undefined;
  // 英文 label 检测：详情字段仍为英文字段（formFields/fieldMap 均无中文 label）→ 交模型补映射
  const needsModelMapping = detail.rows
    .map((r) => r.field)
    .filter((f) => /^[A-Za-z_][\w]*$/.test(f) && !/[\u4e00-\u9fa5]/.test(f));
  // 值英文检测：详情值仍为短数字枚举（源码枚举未翻译）→ 交模型按 skill 翻值
  const numericColRe = /\b(count|total|num|amount|price|size|stock|number|quantity|money|balance|ids?|limit|cycle|days|duration|time|hour|minute|second|rate|ratio|percent|score|point|weight|order|index)\b/i;
  const needsValueMapping = detail.rows
    .filter((r) => /^\d{1,3}$/.test(String(r.value)) && !numericColRe.test(r.field))
    .map((r) => `${r.field}(${r.value})`);
  const view: ChatTableView = {
    title: `${moduleKey} 详情`,
    columns: [
      { key: "field", title: "字段" },
      { key: "value", title: "值" },
    ],
    rows: detail.rows,
    total: detail.rows.length,
  };
  return {
    md: detail.md,
    view,
    ...(needsModelMapping.length ? { needsModelMapping } : {}),
    ...(needsValueMapping.length ? { needsValueMapping } : {}),
    ...(fieldDiff ? { fieldDiff } : {}),
  };
}

/** 模型自主路径的列表受控渲染（对齐 Cursor「渲染由执行器完成，模型只触发工具」）：
 *  call_api 返回多行列表时，服务端强制按 PC 列定义渲染表格（与 orchestrate 列表分支共用
 *  pickRowsByPcColumns/renderCell/loadModuleRenderConfig），模型不再需要调 render_table。
 *  返回 { md, view }：md 为 Markdown 文本，view 为 ChatTableView（前端 ResultTable 渲染）。
 *  needsModelMapping：表头仍为英文字段（PC 列 title 提取失败且 fieldMap/colTitle 均无中文映射）
 *  时返回该字段列表——由 chat.ts 走 [workflow/output-align] 交模型按 pc-column-mapping 技能
 *  读当前项目源码补中文映射（配置表退役后，模型读源码是唯一兜底）。 */
export async function renderListForAgent(
  payload: unknown,
  moduleKey: string,
  filterSummary?: string,
): Promise<{ md: string; view: ChatTableView; needsModelMapping?: string[]; needsValueMapping?: string[]; fieldDiff?: { pcMissing: string[]; dataExtra: string[] } }> {
  const rawTableRows = extractTableRows(payload);
  if (!rawTableRows.length) {
    throw new Error(`payload 不是列表数据（module=${moduleKey}）`);
  }
  const tableRows = rawTableRows.slice(0, 100);
  // 取 PC 列定义：与 orchestrate 同款 get_list_columns → 行数据交集
  let pcColumns: Array<{ title: string; dataIndex: string }> = [];
  try {
    const columnsContent = await runAgentTool("get_list_columns", { module: moduleKey });
    pcColumns = extractPcColumns(columnsContent, tableRows);
  } catch { /* 无 PC 列定义时回退通用列 */ }
  const { rows: cleanRows, headers, keys, widths } = pickRowsByPcColumns(tableRows, pcColumns);
  // 字段差异清单（2026-08-26，对齐 Cursor「模型是数据最终校验者」）：
  // 比对「PC 列定义字段」与「接口返回数据字段」的结构差异，回喂模型逐项校对——
  // ①pcMissing：PC 端列定义有、但接口返回数据无该字段（空列，需模型判断是否接口不对/缺参数/嵌套未展平）；
  // ②dataExtra：接口返回有、但 PC 列定义未展示的字段（可能是有价值业务字段或元数据，由模型裁决是否补展示）。
  // 纯数据驱动（字段名来自 PC 源码 dataIndex 与返回数据键），零业务词写死。
  const dataKeysAll = new Set<string>();
  for (const r of tableRows) for (const k of Object.keys(r)) dataKeysAll.add(k);
  const metaKeyRe = /^(page|pages|pageNum|pageSize|size|current|limit|total|count|offset|rows|list|records|items|data|result|code|msg|message|success|ok|_mock|token|traceId|requestId)$/i;
  const pcMissing = pcColumns
    .map((c) => c.dataIndex)
    .filter((k) => !dataKeysAll.has(k) && !dataKeysAll.has(k.replace(/Str$/, "").replace(/Name$/, "")) && !dataKeysAll.has(`${k}Name`));
  const dataExtra = [...dataKeysAll].filter((k) => !keys.includes(k) && !metaKeyRe.test(k));
  const fieldDiff = pcMissing.length || dataExtra.length ? { pcMissing, dataExtra } : undefined;
  const { enums, rules, fieldMap } = loadModuleRenderConfig(moduleKey);
  // 列标题中文化兜底：PC 列 title 为英文 / 模板字符串（如 `${getTran(`）/ 非人类可读时，
  // 回退 fieldMap → colTitle（列 key 是 dataIndex，与 rows 字段同源必可读）。
  const finalHeaders = headers.map((h, i) => {
    const k = keys[i];
    const weird = h.includes("${") || h.includes("}") || /^[A-Za-z_][\w]*$/.test(h);
    if (weird) {
      if (fieldMap[k]) return fieldMap[k];
      return colTitle(k);
    }
    return h;
  });
  // 英文表头检测：仍为纯英文字段（fieldMap 无中文映射 → 交模型按 pc-column-mapping skill 读源码补）。
  // colTitle 静态字典已删（恒返回 key），故所有纯英文字段都视为需模型映射；id→ID 这类通用保留由模型裁决。
  const needsModelMapping = finalHeaders
    .map((h, i) => ({ h, k: keys[i] }))
    .filter(({ h, k }) => /^[A-Za-z_][\w]*$/.test(h) && !/[\u4e00-\u9fa5]/.test(h) && colTitle(k) === k)
    .map(({ h, k }) => `${k}(${h})`);
  // 一次性渲染全部单元格（md 与 view 共用，避免 renderCell 重复调用）：
  // md 用 markdown（图片保持 ![..](url) 回喂模型），view 用展示值（图片还原 URL 供前端缩略图）。
  const cellRenderCache = cleanRows.map((r) => {
    const rec = r as Record<string, unknown>;
    return keys.map((k) => renderCell(rec, k, enums[k], rules));
  });
  const mdRows = cellRenderCache;
  const md =
    `| ${finalHeaders.join(" | ")} |\n` +
    `| ${finalHeaders.map(() => "---").join(" | ")} |\n` +
    mdRows.map((row) => `| ${row.map(mdCellEscape).join(" | ")} |`).join("\n");

  // 值英文检测（2026-08-24）：单元格仍有「短数字枚举」且该列源码枚举未翻译 → 交模型按 skill 翻值。
  // 排除数值语义列（count/total/amount/price/timeLimit/cycle/days 等，其值本就该是数字/时长/周期）。
  const numericColRe = /\b(count|total|num|amount|price|size|stock|number|quantity|money|balance|ids?|limit|cycle|days|duration|time|hour|minute|second|rate|ratio|percent|score|point|weight|order|index)\b/i;
  const needsValueMapping = keys
    .filter((k) => {
      if (numericColRe.test(k)) return false;
      const vals = cleanRows.map((r) => String((r as Record<string, unknown>)[k] ?? ""));
      const shortNum = vals.filter((v) => /^\d{1,3}$/.test(v));
      if (!shortNum.length) return false;
      const en = enums[k];
      if (en && shortNum.every((v) => en[v])) return false;
      return true;
    })
    .map((k) => `${k}(${colTitle(k)})`);

  // view 用展示值（对齐 PC 端 customRender）：每格走 renderCell（时间戳→日期、布尔→是/否、
  // 枚举→翻译、图片→markdown），与回喂模型的 md 保持一致；图片 markdown 还原为 URL，
  // 供前端 ResultTable 的 isImageUrl 检测渲染缩略图。columns 补通用 kind（date/id/number），
  // 前端据此右对齐/等宽，贴近 PC 端表格观感（kind 为通用语义契约，非业务词）。
  const displayRows = cellRenderCache.map((cells, ri) => {
    const out: Record<string, unknown> = { ...(cleanRows[ri] as Record<string, unknown>) };
    keys.forEach((k, ci) => {
      const rendered = cells[ci];
      const imgMatch = rendered.match(/^!\[[^\]]*\]\((\S+)\)$/);
      out[k] = imgMatch ? imgMatch[1] : rendered;
    });
    return out;
  });
  const genericKind = (k: string): string | undefined => {
    if (/\b(id|ids?)\b/i.test(k)) return "id";
    if (/\b(time|date|day|duration|at)\b/i.test(k)) return "date";
    if (/\b(count|total|num|amount|price|size|stock|number|quantity|money|balance|limit|cycle|hour|minute|second|rate|ratio|percent|score|point|weight|order|index)\b/i.test(k)) return "number";
    return undefined;
  };
  const view: ChatTableView = {
    title: filterSummary ? `${moduleKey} 列表（筛选：${filterSummary}）` : `${moduleKey} 列表`,
    columns: keys.map((k, i) => ({
      key: k,
      title: finalHeaders[i],
      kind: genericKind(k) as never,
      width: widths?.[i],
    })),
    rows: displayRows.slice(0, 50) as unknown as ChatTableRow[],
    total: tableRows.length,
  };
  return {
    md,
    view,
    ...(needsModelMapping.length ? { needsModelMapping } : {}),
    ...(needsValueMapping.length ? { needsValueMapping } : {}),
    ...(fieldDiff ? { fieldDiff } : {}),
  };
}
