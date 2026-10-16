import {
  listPagingOffset,
  listProbeKey,
  listProbeShape,
  listResponseHasMore,
  looksLikeListPage,
} from "./list-count.js";

export { listPagingOffset } from "./list-count.js";

/**
 * 列表工具直接翻页的硬闸门。
 *
 * 决策（2026-10-15，取代旧"一个工具本轮只调一次"）：选 (c) 结构化判据，不写死时间窗参数名（红线）。
 * - 仍拒绝 index/offset/page/cursor 指向下一页（listPagingOffset > 0）。
 * - 允许"不同筛选"多角度探查，但每组工具本轮有上限 LIST_PROBE_BUDGET（解决旧版把"换筛选再查一次"也拒掉、
 *   导致模型以为没有数据而答不全的问题）。
 * - 时间切片（from_time:1→2、offset 步进等）仍拒绝，但**靠结构判据**而非参数名：同一工具上一次调用只改了
 *   一个数值叶且递增，即判为步进。字符串换值（country='IN'→'US'）不是步进，属不同筛选，由预算放行。
 *   这样既不碰红线，又保留 {from_time:1}→{from_time:2} 必须被拒的回归锚点。
 *
 * 不再把"探查若干组不同筛选"一律拒绝——那是旧版导致"答不全"的根因；模型真正要跨页计数/分桶时，
 * 拒绝文案会把它导向 count_list_by_time / run_tool_code。
 */

const LIST_PROBE_BUDGET = Math.max(1, Number(process.env.LIST_PROBE_BUDGET) || 4);

export const DIRECT_LIST_PAGE_REFUSAL =
  "已拒绝继续直接翻页：每个列表工具本轮只允许直接调用一次，用来确认字段。" +
  "换时间窗口或筛选再取一页也同样拒绝。" +
  "跨页计数、按小时分桶或和阈值比较，改调 count_list_by_time，一次取回计数。" +
  "小时桶以外的汇总用 run_tool_code，在代码里调用只读工具，只打印聚合结果。" +
  "不要再改 index、offset、page 或 cursor 逐页拉取，也不要把翻页委派给子代理。";

const DIRECT_LIST_PROBE_BUDGET_REFUSAL =
  "已拒绝继续直接探查该列表工具：同一工具本轮已探查过若干组不同筛选。" +
  "跨页计数或按时间/维度分桶汇总改调 count_list_by_time；小时桶以外的汇总用 run_tool_code。" +
  "不要再逐组换筛选反复拉取明细，也不要把探查委派给子代理。";

/** seen 仍是 Set<string>，用前缀区分两类记录，避免改动 chat.ts 的初始化。 */
const SHAPE_PREFIX = "shape\0";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 两棵规格化结构是否只差"一个叶"，且该叶是数值递增（步进）。多叶差异 / 结构不一致返回 false，
 * 交由"不同筛选"判据放行。递归比较，能命中嵌套在 query_params 里的 from_time 这类单叶变化。
 */
export function isSequentialStep(prevShape: string, curShape: string): boolean {
  let a: unknown, b: unknown;
  try {
    a = JSON.parse(prevShape);
    b = JSON.parse(curShape);
  } catch {
    return false;
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;

  const out: { key?: string; prev?: unknown; cur?: unknown } = {};
  if (!diffLeaves(a, b, "", out)) return false;
  if (out.key === undefined) return false; // 完全相同 → 由重复判据拦
  return isStepValue(out.prev, out.cur);
}

function diffLeaves(
  a: unknown,
  b: unknown,
  path: string,
  out: { key?: string; prev?: unknown; cur?: unknown },
): boolean {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a) || !(k in b)) return false; // 结构不一致
      if (!diffLeaves(a[k], b[k], path ? `${path}.${k}` : k, out)) return false;
    }
    return true;
  }
  if (a !== b) {
    if (out.key !== undefined) return false; // 已存在第二个差异
    out.key = path;
    out.prev = a;
    out.cur = b;
  }
  return true;
}

/** 步进值：只认数值递增（from_time 1→2、offset 步进）。字符串换值不算步进（属不同筛选）。不依赖参数名。 */
function isStepValue(prev: unknown, cur: unknown): boolean {
  return (
    typeof prev === "number" &&
    Number.isFinite(prev) &&
    typeof cur === "number" &&
    Number.isFinite(cur) &&
    cur > prev
  );
}

function countSignatures(seen: Set<string>, toolName: string): number {
  const prefix = toolName + "\0";
  let n = 0;
  for (const entry of seen) {
    if (entry.startsWith(prefix) && !entry.startsWith(SHAPE_PREFIX)) n++;
  }
  return n;
}

/**
 * 是否放行一次列表工具的直接调用。返回拒绝理由（非空）或 null（放行）。
 * seen 跨整轮对话复用（chat.ts 传入的 directListSeen）。
 */
export function admitDirectListCall(
  toolName: string,
  argsJson: string,
  seen: Set<string>,
): string | null {
  if (listPagingOffset(argsJson) > 0) return DIRECT_LIST_PAGE_REFUSAL;

  const filterKey = listProbeKey(toolName, argsJson);
  if (seen.has(filterKey)) return DIRECT_LIST_PAGE_REFUSAL; // 同一筛选已调过（含同参数重试）

  if (!looksLikeListPage(argsJson)) return null; // 非列表调用，不计入闸门

  const curShapeJson = listProbeShape(argsJson); // 规格化结构（裸 JSON），用于"单叶数值步进"判据
  if (curShapeJson) {
    const prefix = SHAPE_PREFIX + toolName + "\0";
    for (const entry of seen) {
      if (!entry.startsWith(prefix)) continue;
      // 注意传裸 JSON（entry 去掉前缀后），不是带前缀的整条记录，否则 JSON.parse 抛错被静默吞掉。
      if (isSequentialStep(entry.slice(prefix.length), curShapeJson)) {
        return DIRECT_LIST_PAGE_REFUSAL;
      }
    }
  }

  // 不同筛选的预算：允许有限组多角度探查，但封顶，逼模型走聚合工具而非逐组拉明细。
  if (countSignatures(seen, toolName) >= LIST_PROBE_BUDGET) {
    return DIRECT_LIST_PROBE_BUDGET_REFUSAL;
  }

  seen.add(filterKey);
  if (curShapeJson) seen.add(SHAPE_PREFIX + toolName + "\0" + curShapeJson);
  return null;
}

export function releaseDirectListCall(
  toolName: string,
  argsJson: string,
  seen: Set<string>,
): void {
  seen.delete(listProbeKey(toolName, argsJson));
  const shape = listProbeShape(argsJson);
  if (shape) seen.delete(SHAPE_PREFIX + toolName + "\0" + shape);
}

export function rememberDirectListPage(
  toolName: string,
  argsJson: string,
  resultText: string,
  seen: Set<string>,
): void {
  if (!listResponseHasMore(resultText)) return;
  seen.add(listProbeKey(toolName, argsJson));
  const shape = listProbeShape(argsJson);
  if (shape) seen.add(SHAPE_PREFIX + toolName + "\0" + shape);
}
