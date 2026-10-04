/**
 * 模型直接翻页的硬闸门。
 *
 * 提示词挡不住「再调一次下一页」。Anthropic 的 programmatic tool calling 也写明
 * allowed_callers 只是引导，客户端仍要拦住直接调用。
 * 闸门看参数形状，不看工具名：index / offset / page / cursor 离开第一页就拒绝。
 * 每个列表工具本轮只放行一次第一页。换筛选再直接取一页也拒绝，避免模型用时间切片代替翻页。
 * 服务端计数（count_list_by_time）和代码里的只读调用不走这里。
 */

import { listPagingOffset, listProbeKey, listResponseHasMore, listToolProbeKey, looksLikeListPage } from "./list-count.js";

export { listPagingOffset } from "./list-count.js";

export const DIRECT_LIST_PAGE_REFUSAL =
  "已拒绝继续直接翻页：每个列表工具本轮只允许直接调用一次，用来确认字段。" +
  "换时间窗口或筛选再取一页也同样拒绝。" +
  "跨页计数、按小时分桶或和阈值比较，改调 count_list_by_time，一次取回计数。" +
  "小时桶以外的汇总用 run_tool_code，在代码里调用只读工具，只打印聚合结果。" +
  "不要再改 index、offset、page 或 cursor 逐页拉取，也不要把翻页委派给子代理。";

/**
 * 同步占位：必须在 await 之前调用，同一批并发请求里只有第一页能通过。
 * 返回拒绝文案时调用方不要再打 MCP。
 */
export function admitDirectListCall(toolName: string, argsJson: string, seen: Set<string>): string | null {
  if (listPagingOffset(argsJson) > 0) return DIRECT_LIST_PAGE_REFUSAL;
  const filterKey = listProbeKey(toolName, argsJson);
  if (seen.has(filterKey)) return DIRECT_LIST_PAGE_REFUSAL;
  if (!looksLikeListPage(argsJson)) return null;
  if (seen.has(listToolProbeKey(toolName))) return DIRECT_LIST_PAGE_REFUSAL;
  seen.add(listToolProbeKey(toolName));
  seen.add(filterKey);
  return null;
}

/** 第一页调用失败时放开占位，同一参数可以再试一次。 */
export function releaseDirectListCall(toolName: string, argsJson: string, seen: Set<string>): void {
  seen.delete(listToolProbeKey(toolName));
  seen.delete(listProbeKey(toolName, argsJson));
}

/** 响应还表明有下一页时占住这个工具。没带页码的第一页也能挡住接着翻或换窗口再取。 */
export function rememberDirectListPage(toolName: string, argsJson: string, resultText: string, seen: Set<string>): void {
  if (!listResponseHasMore(resultText)) return;
  seen.add(listToolProbeKey(toolName));
  seen.add(listProbeKey(toolName, argsJson));
}
