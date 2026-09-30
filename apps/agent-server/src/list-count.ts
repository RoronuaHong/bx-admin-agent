/**
 * 分页列表的服务端计数。
 *
 * 分页是传输问题，不是推理问题：模型逐页把明细搬进上下文再累加，跨页计数会丢状态
 * （Large Result Offloading 的实测：inline 分页计数准确率 0–7%）。
 * 正确做法是 harness 自己翻完页，只把分桶计数交回模型（Anthropic programmatic tool calling：
 * 把一串工具往返收成一次调用；Truto：整库统计走 spool，不要让模型在「下一页」上循环）。
 */

export const LIST_COUNT_PAGE_LIMIT = Math.min(
  99,
  Math.max(1, Number(process.env.LIST_COUNT_PAGE_LIMIT) || 99),
);
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

/**
 * 会话列表不带排序时，offset 翻页会漏行或重复。只给已知的列表工具补开始时间升序，
 * 调用方已经写了 sort_by / sort_order 则不覆盖。
 */
export function prepareListArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(args);
  if (!/getConversationsList/i.test(toolName)) return copy;
  const query = copy.query_params;
  if (!query || typeof query !== "object" || Array.isArray(query)) return copy;
  const params = query as Record<string, unknown>;
  if (params.sort_by == null || String(params.sort_by).trim() === "") params.sort_by = "in_time";
  if (params.sort_order == null || String(params.sort_order).trim() === "") params.sort_order = "asc";
  return copy;
}

export function pageArgs(base: Record<string, unknown>, index: number, limit: number): Record<string, unknown> {
  const args = structuredClone(base);
  const query = args.query_params;
  if (query && typeof query === "object" && !Array.isArray(query)) {
    const params = query as Record<string, unknown>;
    params.index = index;
    params.limit = limit;
    return args;
  }
  args.index = index;
  args.limit = limit;
  return args;
}

/** 统一成毫秒。10 位左右的 Unix 秒若直接分桶会落在 1970 年。 */
function asMillis(n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? Math.round(n * 1000) : n;
}

function readTime(row: Record<string, unknown>, field: string): number | null {
  const raw = row[field] ?? (field === "start_time" ? row.in_time : undefined);
  if (typeof raw === "number") return asMillis(raw);
  if (typeof raw === "string" && raw.trim()) return asMillis(Number(raw));
  return null;
}

function parsePage(
  text: string,
  isError: boolean,
  limit: number,
): { rows: Array<Record<string, unknown>>; more: boolean; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const head = text.replace(/\s+/g, " ").trim().slice(0, 180);
    return { rows: [], more: false, error: isError ? head || "列表工具调用失败" : `返回不是 JSON：${head}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { rows: [], more: false, error: "返回不是对象" };
  }
  const obj = parsed as Record<string, unknown>;
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
  if (!Array.isArray(obj.data)) return { rows: [], more: false, error: "返回里没有 data 数组" };
  const rows = obj.data.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  const more = typeof obj.more_data_available === "boolean" ? obj.more_data_available : rows.length >= limit;
  return { rows, more };
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
  const limit = LIST_COUNT_PAGE_LIMIT;
  const maxPages = Math.min(LIST_COUNT_MAX_PAGES, Math.max(1, Math.floor(request.maxPages) || LIST_COUNT_DEFAULT_PAGES));
  const seen = new Set<string>();
  const buckets = new Map<string, number>();
  let pages = 0;
  let rawRows = 0;
  let skippedTime = 0;
  let missingId = 0;
  let index = 0;
  let complete = false;
  let reason = "";

  while (pages < maxPages) {
    if (signal?.aborted) {
      reason = "已取消";
      break;
    }
    const fetched = await fetchPage(pageArgs(request.arguments, index, limit));
    pages += 1;
    const page = parsePage(fetched.text, fetched.isError, limit);
    if (page.error) {
      reason = page.error;
      break;
    }
    if (!page.rows.length) {
      complete = true;
      reason = "已翻到末页";
      break;
    }
    let fresh = 0;
    for (const row of page.rows) {
      rawRows += 1;
      const id = String(row[request.idField] ?? "").trim();
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
    index += page.rows.length;
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
