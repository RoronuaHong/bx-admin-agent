import { test, expect } from "vitest";
import { execBuiltin } from "../src/builtins.js";
import {
  calendarHourLabel,
  countPagedList,
  formatCountReport,
  hourBucketLabel,
  mcpToolParts,
  pageArgs,
  prepareListArgs,
  type PageFetchResult,
} from "../src/list-count.js";

const FROM = Date.UTC(2026, 8, 16, 7, 30, 0);

function row(id: string, start: number | string | null): Record<string, unknown> {
  const item: Record<string, unknown> = { id };
  if (start != null) item.start_time = start;
  return item;
}

function page(rows: Array<Record<string, unknown>>, more: boolean): PageFetchResult {
  return { text: JSON.stringify({ data: rows, more_data_available: more }), isError: false };
}

function request(extra: Partial<Parameters<typeof countPagedList>[0]> = {}) {
  return {
    arguments: { path_variables: { screenname: "castleapp" }, query_params: { from_time: 1, to_time: 2 } },
    timeField: "start_time",
    idField: "id",
    timeZone: "UTC",
    maxPages: 10,
    ...extra,
  };
}

test("小时桶按 IANA 时区对齐，午夜 24 点进位到下一天", () => {
  expect(hourBucketLabel(FROM, "UTC")).toBe("2026-09-16 07:00");
  expect(hourBucketLabel(FROM, "Asia/Shanghai")).toBe("2026-09-16 15:00");
  expect(hourBucketLabel(Date.UTC(2026, 8, 16, 16, 0, 0), "UTC")).toBe("2026-09-16 16:00");
  expect(calendarHourLabel("2026", "09", "30", "24")).toBe("2026-10-01 00:00");
  expect(calendarHourLabel("2026", "09", "16", "7")).toBe("2026-09-16 07:00");
});

test("翻页写在 query_params，不改调用方原始参数", () => {
  const base = { query_params: { from_time: 1 } };
  const next = pageArgs(base, 99, 99);
  expect((next.query_params as { index: number }).index).toBe(99);
  expect(base.query_params).not.toHaveProperty("index");
  const top = pageArgs({ from_time: 1 }, 0, 99);
  expect(top.index).toBe(0);
  expect(top.limit).toBe(99);
});

test("跨页去重后按小时计数，并列出超过阈值的小时", async () => {
  const calls: number[] = [];
  const report = await countPagedList(request({ above: 2, timeZone: "UTC" }), async (args) => {
    const index = (args.query_params as { index: number }).index;
    calls.push(index);
    if (index === 0) {
      return page(
        [row("a", FROM), row("b", FROM + 60_000), row("c", String(FROM + 3_600_000))],
        true,
      );
    }
    return page([row("a", FROM), row("d", FROM + 3_600_000)], false);
  });
  expect(calls).toEqual([0, 3]);
  expect(report.complete).toBe(true);
  expect(report.unique).toBe(4);
  expect(report.hours).toEqual([
    { hour: "2026-09-16 07:00", count: 2 },
    { hour: "2026-09-16 08:00", count: 2 },
  ]);
  expect(report.over).toEqual([]);
  const text = formatCountReport(report);
  expect(text.startsWith("complete: true")).toBe(true);
  expect(text).toContain("没有小时的计数超过 2");
  expect(text).toContain("top:");
});

test("超过阈值时列出小时，没翻完时禁止当成结论", async () => {
  const hit = await countPagedList(request({ above: 1, maxPages: 5 }), async () =>
    page([row("a", FROM), row("b", FROM)], false),
  );
  expect(formatCountReport(hit)).toContain("2026-09-16 07:00\t2");
  expect(formatCountReport(hit)).toContain("下列小时的计数超过阈值");

  const partial = await countPagedList(request({ above: 300, maxPages: 1 }), async () =>
    page([row("a", FROM)], true),
  );
  expect(partial.complete).toBe(false);
  expect(partial.reason).toContain("已达分页上限");
  const text = formatCountReport(partial);
  expect(text.startsWith("complete: false")).toBe(true);
  expect(text).toContain("计数不完整");
  expect(text).toContain("不能据此判断是否超过阈值");
  expect(text).not.toContain("没有小时的计数超过");
  expect(text).not.toContain("top:");
  expect(text).not.toContain("over_count:");
  expect(text).not.toContain("unique:");
  expect(text).not.toContain("range:");
  expect(text).not.toContain("\t");
});

test("缺少时间或 id、重复页、接口错误都标成不完整", async () => {
  const missing = await countPagedList(request(), async () => page([row("a", null), row("b", FROM)], false));
  expect(missing.complete).toBe(false);
  expect(missing.skippedTime).toBe(1);
  expect(missing.unique).toBe(1);
  expect(missing.reason).toContain("start_time");

  const noId = await countPagedList(request(), async () =>
    page([{ start_time: FROM }, row("b", FROM)], false),
  );
  expect(noId.complete).toBe(false);
  expect(noId.unique).toBe(1);
  expect(noId.reason).toContain("无法去重");

  const allBadTime = await countPagedList(request(), async () => page([row("a", null)], false));
  expect(allBadTime.ok).toBe(true);
  expect(allBadTime.complete).toBe(false);
  expect(allBadTime.unique).toBe(0);
  expect(formatCountReport(allBadTime)).not.toContain("unique:");

  const seconds = await countPagedList(request(), async () => page([row("s", FROM / 1000)], false));
  expect(seconds.complete).toBe(true);
  expect(seconds.hours).toEqual([{ hour: "2026-09-16 07:00", count: 1 }]);

  const stalled = await countPagedList(request(), async () => page([row("a", FROM)], true));
  expect(stalled.complete).toBe(false);
  expect(stalled.reason).toContain("没有推进");
  expect(stalled.pages).toBe(2);

  const repeatedLastPage = await countPagedList(request(), async (args) => {
    const index = (args.query_params as { index: number }).index;
    return page([row("a", FROM)], index === 0);
  });
  expect(repeatedLastPage.complete).toBe(true);
  expect(repeatedLastPage.unique).toBe(1);

  const failed = await countPagedList(request(), async () => ({
    text: JSON.stringify({ error: { message: "limit invalid" } }),
    isError: true,
  }));
  expect(failed.ok).toBe(false);
  expect(failed.complete).toBe(false);
  expect(failed.reason).toContain("limit invalid");
});

test("空窗口是完整的零，取消和非法时区不装成零结果", async () => {
  const empty = await countPagedList(request(), async () => page([], false));
  expect(empty.ok).toBe(true);
  expect(empty.complete).toBe(true);
  expect(empty.unique).toBe(0);

  const aborted = await countPagedList(request(), async () => page([row("a", FROM)], true), AbortSignal.abort());
  expect(aborted.complete).toBe(false);
  expect(aborted.reason).toBe("已取消");
  expect(aborted.pages).toBe(0);

  const tz = await countPagedList(request({ timeZone: "Not/AZone" }), async () => page([], false));
  expect(tz.ok).toBe(false);
  expect(tz.reason).toContain("无法识别的时区");
});

test("会话列表缺省按开始时间升序，已写排序则不覆盖", () => {
  const filled = prepareListArgs("mcp__zoho-salesiq__ZohoSalesIQ_getConversationsList", {
    query_params: { from_time: 1 },
  });
  expect(filled.query_params).toMatchObject({ sort_by: "in_time", sort_order: "asc", from_time: 1 });
  const kept = prepareListArgs("mcp__zoho-salesiq__ZohoSalesIQ_getConversationsList", {
    query_params: { sort_by: "updated_time", sort_order: "desc" },
  });
  expect(kept.query_params).toMatchObject({ sort_by: "updated_time", sort_order: "desc" });
  const other = prepareListArgs("mcp__other__list", { query_params: { from_time: 1 } });
  expect(other.query_params).toEqual({ from_time: 1 });
});

test("工具名拆分与未连接的列表工具如实失败", async () => {
  expect(mcpToolParts("mcp__zoho-salesiq__ZohoSalesIQ_getConversationsList")).toEqual({
    serverId: "zoho-salesiq",
    tool: "ZohoSalesIQ_getConversationsList",
  });
  const out = await execBuiltin(
    "count_list_by_time",
    JSON.stringify({
      tool: "mcp__missing__Nope",
      payload: { query_params: { from_time: 1, to_time: 2 } },
    }),
    "conv_list_count_test",
  );
  expect(out?.ok).toBe(false);
  expect(out?.text).toContain("complete: false");
  expect(out?.text).toMatch(/未找到|未连接/);
});
