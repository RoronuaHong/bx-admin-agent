/**
 * 分页列表的服务端计数。
 *
 * 分页是传输问题，不是推理问题：模型逐页把明细搬进上下文再累加，跨页计数会丢状态
 * （Large Result Offloading 的实测：inline 分页计数准确率 0–7%）。
 * 正确做法是 harness 自己翻完页，只把分桶计数交回模型（Anthropic programmatic tool calling：
 * 把一串工具往返收成一次调用；Truto：整库统计走 spool，不要让模型在「下一页」上循环）。
 */

/** 通用页大小。Zoho 会话列表另有 99 的上限，见 pageLimitForTool。 */
export const LIST_COUNT_PAGE_LIMIT = Math.min(
  500,
  Math.max(1, Number(process.env.LIST_COUNT_PAGE_LIMIT) || 100),
);

const ROW_ARRAY_KEYS = ["data", "items", "results", "records", "rows", "list", "conversations", "value", "entries"];
const MORE_BOOL_KEYS = ["more_data_available", "has_more", "hasMore", "more"];
const NEXT_CURSOR_KEYS = ["next_cursor", "nextCursor", "next_page_token", "nextPageToken", "next"];
const REQUEST_CURSOR_KEYS = ["cursor", "page_token", "pageToken", "starting_after", "continuation", "continuation_token", "next_cursor"];
const OFFSET_KEYS = ["index", "offset", "skip"] as const;
const LIMIT_KEYS = ["limit", "page_size", "pageSize", "per_page", "perPage"];
const PAGING_CONTAINER_KEYS = ["query_params", "pagination", "paging", "params"] as const;
const LIST_ARG_KEYS = new Set<string>([...REQUEST_CURSOR_KEYS, ...OFFSET_KEYS, ...LIMIT_KEYS, "page"]);

/** 已知列表的页大小上限。其余工具用通用页大小，不把某一家的 99 写进所有请求。 */
export function pageLimitForTool(toolName: string): number {
  if (/getConversationsList/i.test(toolName)) return Math.min(99, LIST_COUNT_PAGE_LIMIT);
  return LIST_COUNT_PAGE_LIMIT;
}
export const LIST_COUNT_DEFAULT_PAGES = Math.max(1, Number(process.env.LIST_COUNT_DEFAULT_PAGES) || 250);
export const LIST_COUNT_MAX_PAGES = Math.max(
  LIST_COUNT_DEFAULT_PAGES,
  Number(process.env.LIST_COUNT_MAX_PAGES) || 400,
);

export interface PageFetchResult {
  text: string;
  isError: boolean;
}

export interface HourBucket {
  hour: string;
  count: number;
}

export interface CountListRequest {
  arguments: Record<string, unknown>;
  timeField: string;
  idField: string;
  timeZone: string;
  /** 列表数组的字段名。不传则按 data / items / results 等常见名字自动识别。 */
  rowsField?: string;
  /** 单页条数。不传则用通用页大小。 */
  pageLimit?: number;
  above?: number;
  maxPages: number;
}

export interface CountListReport {
  ok: boolean;
  complete: boolean;
  reason: string;
  pages: number;
  rawRows: number;
  unique: number;
  skippedTime: number;
  timeZone: string;
  above?: number;
  minHour?: string;
  maxHour?: string;
  over: HourBucket[];
  top: HourBucket[];
  hours: HourBucket[];
  file?: string;
  fileError?: string;
}

/** `mcp__<serverId>__<tool>` → 服务器 id 与原始工具名。对不上返回 null。 */
export function mcpToolParts(name: string): { serverId: string; tool: string } | null {
  const parts = name.split("__");
  if (parts[0] !== "mcp" || parts.length < 3 || !parts[1]) return null;
  return { serverId: parts[1]!, tool: parts.slice(2).join("__") };
}

/** 合法 IANA 时区原样返回，否则 null。不从语言猜测时区。 */
export function normalizeTimeZone(raw: unknown): string | null {
  const timeZone = typeof raw === "string" ? raw.trim() : "";
  if (!timeZone || timeZone.length > 64) return null;
  return timeZoneError(timeZone) ? null : timeZone;
}

/**
 * 小时桶时区：模型显式传入的优先（包括 UTC）；没传才用用户时区；都没有才是 UTC。
 * 非法的显式值原样留下，交给 countPagedList 报错，避免悄悄改成另一个时区。
 */
export function resolveCountTimeZone(requested: string, fallback?: string | null): string {
  const explicit = requested.trim();
  if (explicit) return explicit;
  return normalizeTimeZone(fallback) || "UTC";
}

export function timeZoneError(timeZone: string): string | null {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return null;
  } catch {
    return `无法识别的时区：${timeZone}`;
  }
}

/**
 * 整点标签。个别 ICU 把当地午夜印成「前一天 24 点」，这里进位到下一天 00:00，
 * 避免同一小时被拆成两个桶。
 */
export function calendarHourLabel(year: string, month: string, day: string, hour: string): string {
  const hh = hour.padStart(2, "0");
  if (hh !== "24") return `${year}-${month}-${day} ${hh}:00`;
  const rolled = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + 1));
  const y = String(rolled.getUTCFullYear());
  const m = String(rolled.getUTCMonth() + 1).padStart(2, "0");
  const d = String(rolled.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d} 00:00`;
}

/** 整点小时标签（IANA 时区）。 */
export function hourBucketLabel(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  }).formatToParts(new Date(ms));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return calendarHourLabel(pick("year"), pick("month"), pick("day"), pick("hour"));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pagingNodes(obj: Record<string, unknown>): Record<string, unknown>[] {
  const out = [obj];
  for (const key of PAGING_CONTAINER_KEYS) {
    const child = asRecord(obj[key]);
    if (child) out.push(child);
  }
  return out;
}

function responseNodes(obj: Record<string, unknown>): Record<string, unknown>[] {
  const out = [obj];
  for (const key of ["pagination", "paging", "meta", "page_info", "pageInfo"] as const) {
    const child = asRecord(obj[key]);
    if (child) out.push(child);
  }
  return out;
}

function readArgs(argsJson: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(argsJson));
  } catch {
    return null;
  }
}

function numericPageValue(value: unknown): number | null {
  if (typeof value === "boolean" || value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** 已经不是第一页：offset/index/skip > 0、page > 1，或带了非空游标。布尔 skip、页面名字不算。 */
export function listPagingOffset(argsJson: string): number {
  const obj = readArgs(argsJson);
  if (!obj) return 0;
  for (const node of pagingNodes(obj)) {
    for (const key of OFFSET_KEYS) {
      const n = numericPageValue(node[key]);
      if (n != null && n > 0) return n;
    }
    const page = numericPageValue(node.page);
    if (page != null && page > 1) return page;
    for (const key of REQUEST_CURSOR_KEYS) {
      if (opaqueCursor(node[key])) return 1;
      const n = numericPageValue(node[key]);
      if (n != null && n > 0) return n;
    }
  }
  return 0;
}

function pagingField(key: string, value: unknown): boolean {
  if (!LIST_ARG_KEYS.has(key)) return false;
  if (key === "page") return numericPageValue(value) != null;
  if ((OFFSET_KEYS as readonly string[]).includes(key)) return numericPageValue(value) != null || value == null || value === "";
  return true;
}

/** 参数里带了分页字段（含第一页的 limit / page / index）。没有这些字段的读取不拦。 */
export function looksLikeListPage(argsJson: string): boolean {
  const obj = readArgs(argsJson);
  if (!obj) return false;
  for (const node of pagingNodes(obj)) {
    for (const [key, value] of Object.entries(node)) if (pagingField(key, value)) return true;
  }
  return false;
}

/** 键顺序固定，避免同一筛选换个字段顺序就绕过闸门。只剥掉分页容器里的页码。 */
function canonicalize(value: unknown, stripPaging: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, false));
  const rec = asRecord(value);
  if (!rec) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(rec).sort()) {
    if (stripPaging && LIST_ARG_KEYS.has(key)) continue;
    const childStrip = stripPaging && (PAGING_CONTAINER_KEYS as readonly string[]).includes(key);
    out[key] = canonicalize(rec[key], childStrip);
  }
  return out;
}

/** 去掉页码后的筛选签名。同一列表工具是否已探过，另见 listToolProbeKey。 */
export function listProbeKey(toolName: string, argsJson: string): string {
  const obj = readArgs(argsJson);
  if (!obj) return `${toolName}\0${argsJson}`;
  return `${toolName}\0${JSON.stringify(canonicalize(obj, true))}`;
}

export function listToolProbeKey(toolName: string): string {
  return `tool\0${toolName}`;
}

/**
 * 已知接口的稳定排序。offset 翻页在无序结果上会漏行或重复。
 * 只补这一家会话列表；其它工具不写入它不认识的 sort 字段。
 */
export function prepareListArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(args);
  if (!/getConversationsList/i.test(toolName)) return copy;
  const query = asRecord(copy.query_params);
  if (!query) return copy;
  if (query.sort_by == null || String(query.sort_by).trim() === "") query.sort_by = "in_time";
  if (query.sort_order == null || String(query.sort_order).trim() === "") query.sort_order = "asc";
  return copy;
}

function writeLimit(container: Record<string, unknown>, limit: number): void {
  const key = LIMIT_KEYS.find((name) => name in container) || "limit";
  container[key] = limit;
}

/**
 * 沿用调用方已经在用的分页字段：游标、page，或 index/offset/skip。
 * 分页对象写在 query_params / pagination / paging / params，否则写在顶层。
 */
export function pageArgs(
  base: Record<string, unknown>,
  index: number,
  limit: number,
  cursor?: string,
  pageNo?: number,
): Record<string, unknown> {
  const args = structuredClone(base);
  const container = pagingNodes(args).find((node) => node !== args) || args;
  const hasCursorKey = REQUEST_CURSOR_KEYS.some((key) => key in container);
  const hasOffsetKey = OFFSET_KEYS.some((key) => key in container);
  writeLimit(container, limit);
  if (cursor || (hasCursorKey && !hasOffsetKey)) {
    const key = REQUEST_CURSOR_KEYS.find((name) => name in container) || "cursor";
    if (cursor) container[key] = cursor;
    return args;
  }
  if ("page" in container && !hasOffsetKey) {
    container.page = pageNo ?? Math.floor(index / Math.max(limit, 1)) + 1;
    return args;
  }
  const offsetKey = OFFSET_KEYS.find((key) => key in container) || "index";
  container[offsetKey] = index;
  return args;
}

/** 统一成毫秒。10 位左右的 Unix 秒若直接分桶会落在 1970 年。 */
function asMillis(n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? Math.round(n * 1000) : n;
}

function valueAt(row: Record<string, unknown>, field: string): unknown {
  if (!field.includes(".")) return row[field];
  let cur: unknown = row;
  for (const part of field.split(".")) {
    const rec = asRecord(cur);
    if (!rec) return undefined;
    cur = rec[part];
  }
  return cur;
}

function readId(row: Record<string, unknown>, field: string): string {
  const raw = valueAt(row, field);
  if (typeof raw === "string" || typeof raw === "number") return String(raw).trim();
  return "";
}

function readTime(row: Record<string, unknown>, field: string): number | null {
  const raw = valueAt(row, field);
  if (typeof raw === "number") return asMillis(raw);
  if (typeof raw !== "string" || !raw.trim()) return null;
  const text = raw.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return asMillis(Number(text));
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function objectRows(value: unknown): { rows: Array<Record<string, unknown>> } | { error: string } | null {
  if (!Array.isArray(value)) return null;
  const rows: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { error: "列表元素不是对象" };
    rows.push(item as Record<string, unknown>);
  }
  return { rows };
}

export function extractListRows(
  obj: Record<string, unknown>,
  rowsField?: string,
): { rows: Array<Record<string, unknown>>; key: string } | { error: string } {
  const named = takeRows(rowsField ? obj[rowsField] : undefined, rowsField);
  if (named) return named;
  for (const key of ROW_ARRAY_KEYS) {
    if (!Array.isArray(obj[key])) continue;
    const read = objectRows(obj[key]);
    if (!read) continue;
    if ("error" in read) return read;
    return { rows: read.rows, key };
  }
  const arrays = Object.entries(obj).filter(([, value]) => Array.isArray(value));
  if (arrays.length === 1) {
    const read = objectRows(arrays[0]![1]);
    if (!read) return { error: "返回里没有列表数组" };
    if ("error" in read) return read;
    return { rows: read.rows, key: arrays[0]![0] };
  }
  return { error: "返回里没有列表数组" };
}

function takeRows(value: unknown, field: string | undefined): { rows: Array<Record<string, unknown>>; key: string } | { error: string } | null {
  if (!field) return null;
  const read = objectRows(value);
  if (!read) return { error: `返回里没有 ${field} 数组` };
  if ("error" in read) return read;
  return { rows: read.rows, key: field };
}

function pageSizeRejected(message: string): boolean {
  return /limit invalid|invalid limit|page size|page_size|per_page|max(?:imum)? limit/i.test(message);
}

function explicitMore(obj: Record<string, unknown>): boolean | undefined {
  for (const node of responseNodes(obj)) {
    for (const key of MORE_BOOL_KEYS) {
      if (typeof node[key] === "boolean") return node[key] as boolean;
    }
  }
  return undefined;
}

/** 只接受不透明页码。链接和路径留给接口自己解释，不能写进 cursor 字段。 */
function opaqueCursor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.startsWith("/") || text.includes("?") || /^[a-z][a-z0-9+.-]*:/i.test(text)) return null;
  return text;
}

function nextCursorOf(obj: Record<string, unknown>): string | undefined {
  for (const node of responseNodes(obj)) {
    for (const key of NEXT_CURSOR_KEYS) {
      const cursor = opaqueCursor(node[key]);
      if (cursor) return cursor;
    }
  }
  return undefined;
}

/** 响应还表明后面有页。认布尔标记和下一页游标，不认工具名。 */
export function listResponseHasMore(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return /"(more_data_available|has_more|hasMore)"\s*:\s*true/.test(text);
  }
  const obj = asRecord(parsed);
  if (!obj) return false;
  const flag = explicitMore(obj);
  if (flag != null) return flag;
  return Boolean(nextCursorOf(obj));
}

function parsePage(
  text: string,
  isError: boolean,
  limit: number,
  rowsField?: string,
): { rows: Array<Record<string, unknown>>; more: boolean; nextCursor?: string; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const head = text.replace(/\s+/g, " ").trim().slice(0, 180);
    return { rows: [], more: false, error: isError ? head || "列表工具调用失败" : `返回不是 JSON：${head}` };
  }
  const obj = asRecord(parsed);
  if (!obj) return { rows: [], more: false, error: "返回不是对象" };
  if (obj.error != null) {
    const err = obj.error;
    const message =
      err && typeof err === "object" && "message" in err
        ? String((err as { message?: unknown }).message || "")
        : JSON.stringify(err);
    return { rows: [], more: false, error: message || "列表工具返回错误" };
  }
  if (isError) {
    return { rows: [], more: false, error: text.replace(/\s+/g, " ").trim().slice(0, 180) || "列表工具调用失败" };
  }
  const extracted = extractListRows(obj, rowsField);
  if ("error" in extracted) return { rows: [], more: false, error: extracted.error };
  const flag = explicitMore(obj);
  const nextCursor = nextCursorOf(obj);
  const more = flag != null ? flag : Boolean(nextCursor) || extracted.rows.length >= limit;
  return { rows: extracted.rows, more, ...(nextCursor ? { nextCursor } : {}) };
}

export async function countPagedList(
  request: CountListRequest,
  fetchPage: (args: Record<string, unknown>) => Promise<PageFetchResult>,
  signal?: AbortSignal,
): Promise<CountListReport> {
  const tzErr = timeZoneError(request.timeZone);
  if (tzErr) {
    return emptyReport(request, false, tzErr, false);
  }
  if (request.above != null && !Number.isFinite(request.above)) {
    return emptyReport(request, false, "above 必须是数字", false);
  }
  let limit = Math.min(LIST_COUNT_PAGE_LIMIT, Math.max(1, Math.floor(request.pageLimit || LIST_COUNT_PAGE_LIMIT)));
  const maxPages = Math.min(LIST_COUNT_MAX_PAGES, Math.max(1, Math.floor(request.maxPages) || LIST_COUNT_DEFAULT_PAGES));
  const seen = new Set<string>();
  const buckets = new Map<string, number>();
  let pages = 0;
  let rawRows = 0;
  let skippedTime = 0;
  let missingId = 0;
  let index = 0;
  let pageNo = 1;
  let cursor: string | undefined;
  let shrunkLimit = false;
  let complete = false;
  let reason = "";

  while (pages < maxPages) {
    if (signal?.aborted) {
      reason = "已取消";
      break;
    }
    const fetched = await fetchPage(pageArgs(request.arguments, index, limit, cursor, pageNo));
    pages += 1;
    const page = parsePage(fetched.text, fetched.isError, limit, request.rowsField);
    if (page.error) {
      if (!shrunkLimit && pages === 1 && limit > 20 && pageSizeRejected(page.error)) {
        shrunkLimit = true;
        limit = Math.max(20, Math.floor(limit / 2));
        pages = 0;
        continue;
      }
      reason = page.error;
      break;
    }
    if (!page.rows.length) {
      if (!page.more) {
        complete = true;
        reason = "已翻到末页";
      } else if (page.nextCursor && page.nextCursor !== cursor) {
        cursor = page.nextCursor;
        continue;
      } else {
        reason = "分页没有推进（空页但仍标记有下一页）";
      }
      break;
    }
    let fresh = 0;
    for (const row of page.rows) {
      rawRows += 1;
      const id = readId(row, request.idField);
      if (!id) {
        missingId += 1;
        fresh += 1;
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      fresh += 1;
      const ms = readTime(row, request.timeField);
      if (ms == null) {
        skippedTime += 1;
        continue;
      }
      const hour = hourBucketLabel(ms, request.timeZone);
      buckets.set(hour, (buckets.get(hour) || 0) + 1);
    }
    if (fresh === 0) {
      if (!page.more) {
        complete = true;
        reason = "已翻到末页";
      } else {
        reason = "分页没有推进（本页 id 全部重复）";
      }
      break;
    }
    if (page.nextCursor) {
      if (cursor === page.nextCursor) {
        reason = "分页没有推进（游标未变化）";
        break;
      }
      cursor = page.nextCursor;
    } else {
      index += page.rows.length;
      pageNo += 1;
    }
    if (!page.more) {
      complete = true;
      reason = "已翻到末页";
      break;
    }
  }
  if (!complete && !reason) reason = `已达分页上限 ${maxPages}，后面还有数据`;
  if (complete && (skippedTime > 0 || missingId > 0)) {
    complete = false;
    const bits: string[] = [];
    if (missingId > 0) bits.push(`有 ${missingId} 条缺少 ${request.idField}，无法去重`);
    if (skippedTime > 0) bits.push(`有 ${skippedTime} 条缺少可用的 ${request.timeField}`);
    reason = bits.join("；");
  }

  const hours = [...buckets.entries()]
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0));
  const top = [...hours].sort((a, b) => b.count - a.count || (a.hour < b.hour ? -1 : 1)).slice(0, 15);
  const over = request.above == null ? [] : hours.filter((item) => item.count > request.above!);
  const unique = [...buckets.values()].reduce((sum, n) => sum + n, 0);
  // 接口失败且一行都没入账才算失败。缺时间、缺 id、翻到上限但仍有行，要 ok，
  // 否则接地护栏会把「如实说没翻完」换成零证据兜底。
  return {
    ok: unique > 0 || complete || skippedTime > 0 || missingId > 0,
    complete,
    reason,
    pages,
    rawRows,
    unique,
    skippedTime,
    timeZone: request.timeZone,
    ...(request.above != null ? { above: request.above } : {}),
    ...(hours.length ? { minHour: hours[0]!.hour, maxHour: hours[hours.length - 1]!.hour } : {}),
    over,
    top,
    hours,
  };
}

function emptyReport(request: CountListRequest, complete: boolean, reason: string, ok: boolean): CountListReport {
  return {
    ok,
    complete,
    reason,
    pages: 0,
    rawRows: 0,
    unique: 0,
    skippedTime: 0,
    timeZone: request.timeZone,
    ...(request.above != null ? { above: request.above } : {}),
    over: [],
    top: [],
    hours: [],
  };
}

function linesOf(items: HourBucket[], cap: number, file?: string): string {
  const shown = items.slice(0, cap);
  const body = shown.map((item) => `${item.hour}\t${item.count}`).join("\n");
  if (!file || items.length <= shown.length) return body;
  return `${body}\n…其余 ${items.length - shown.length} 个小时见文件`;
}

/**
 * 回灌模型的计数摘要。首行是 complete。
 * 不完整时不给条数、区间和各小时计数：模型会把这些前缀数字引用成「没有超过阈值」。
 */
export function formatCountReport(report: CountListReport): string {
  const lines = [
    `complete: ${report.complete ? "true" : "false"}`,
    `reason: ${report.reason}`,
    `pages: ${report.pages}`,
  ];
  if (!report.complete) {
    lines.push(`timezone: ${report.timeZone}`);
    lines.push("note: 计数不完整。已扫页数不能当成窗口总数，也不能据此判断是否超过阈值。不列出各小时计数。");
    return lines.join("\n");
  }
  lines.push(
    `raw_rows: ${report.rawRows}`,
    `unique: ${report.unique}`,
    `timezone: ${report.timeZone}`,
    `labels: 上列小时已按 ${report.timeZone} 标注。回答里照这个时区写，不要改成别的时区。`,
  );
  if (report.minHour && report.maxHour) lines.push(`range: ${report.minHour} .. ${report.maxHour}`);
  if (report.above != null) {
    lines.push(`above: ${report.above}`);
    lines.push(`over_count: ${report.over.length}`);
    if (report.over.length === 0) {
      lines.push(`note: 已覆盖全部已返回页。没有小时的计数超过 ${report.above}。`);
      if (report.top.length) {
        lines.push("top:");
        lines.push(linesOf(report.top, 15, report.file));
      }
    } else {
      lines.push("note: 下列小时的计数超过阈值。");
      lines.push(linesOf(report.over, 40, report.file));
    }
  } else if (report.top.length) {
    lines.push("top:");
    lines.push(linesOf(report.top, 15, report.file));
  }
  if (report.file) lines.push(`file: ${report.file}`);
  if (report.fileError) lines.push(`file_error: ${report.fileError}`);
  return lines.join("\n");
}
