import { test, expect } from "vitest";
import { execBuiltin } from "../src/builtins.js";
import {
  calendarHourLabel,
  conversationCountTimeField,
  ensureConversationStartTime,
  countListWithRetries,
  countPagedList,
  formatCountReport,
  transientListFetchError,
  hourBucketLabel,
  mcpToolParts,
  LIST_COUNT_PAGE_LIMIT,
  pageArgs,
  pageLimitForTool,
  prepareListArgs,
  resolveCountTimeZone,
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
  const nested = pageArgs({ params: { offset: 0, q: "a" } }, 10, 20);
  expect(nested.params).toMatchObject({ offset: 10, limit: 20, q: "a" });
  expect(nested).not.toHaveProperty("index");
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
  expect(text).toContain("hours:");
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
    text: JSON.stringify({ error: { message: "upstream down" } }),
    isError: true,
  }));
  expect(failed.ok).toBe(false);
  expect(failed.complete).toBe(false);
  expect(failed.reason).toContain("upstream down");
  expect(failed.pages).toBe(1);
});

test("瞬时取页失败会立刻重试，永久错误只请求一次", async () => {
  expect(transientListFetchError("Either the inputstream is invalid or absent")).toBe(true);
  expect(transientListFetchError("unauthorized")).toBe(false);

  let transientCalls = 0;
  const recovered = await countPagedList(request({ fetchRetryDelayMs: 0 }), async () => {
    transientCalls += 1;
    if (transientCalls < 3) {
      return {
        text: JSON.stringify({ error: { message: "Either the inputstream is invalid or absent" } }),
        isError: true,
      };
    }
    return page([row("a", FROM)], false);
  });
  expect(transientCalls).toBe(3);
  expect(recovered.complete).toBe(true);
  expect(recovered.unique).toBe(1);
  expect(recovered.pages).toBe(1);

  let permanentCalls = 0;
  const permanent = await countPagedList(request({ fetchRetryDelayMs: 0 }), async () => {
    permanentCalls += 1;
    return { text: JSON.stringify({ error: { message: "unauthorized" } }), isError: true };
  });
  expect(permanentCalls).toBe(1);
  expect(permanent.reason).toBe("unauthorized");

  let exhausted = 0;
  const stillDown = await countPagedList(request({ fetchRetryDelayMs: 0 }), async () => {
    exhausted += 1;
    return {
      text: JSON.stringify({ error: { message: "Either the inputstream is invalid or absent" } }),
      isError: true,
    };
  });
  expect(exhausted).toBe(3);
  expect(stillDown.complete).toBe(false);
  expect(stillDown.reason).toContain("inputstream");
  expect(stillDown.reason).toContain("同一页已请求 3 次");
});

test("整次计数失败后再重试 3 次，工具未连接也算可重试", async () => {
  expect(transientListFetchError("工具未找到或未连接：ZohoSalesIQ_getConversationsList")).toBe(true);

  let calls = 0;
  const recovered = await countListWithRetries(request({ fetchRetryDelayMs: 0 }), async () => {
    calls += 1;
    if (calls <= 3) {
      return {
        text: JSON.stringify({ error: { message: "工具未找到或未连接：ZohoSalesIQ_getConversationsList" } }),
        isError: true,
      };
    }
    return page([row("a", FROM)], false);
  });
  expect(calls).toBe(4);
  expect(recovered.complete).toBe(true);
  expect(recovered.unique).toBe(1);

  let exhausted = 0;
  const stillDown = await countListWithRetries(request({ fetchRetryDelayMs: 0 }), async () => {
    exhausted += 1;
    return {
      text: JSON.stringify({ error: { message: "Either the inputstream is invalid or absent" } }),
      isError: true,
    };
  });
  expect(exhausted).toBe(12);
  expect(stillDown.complete).toBe(false);
  expect(stillDown.reason).toContain("整次计数已再试 3 次");

  let permanent = 0;
  const denied = await countListWithRetries(request({ fetchRetryDelayMs: 0 }), async () => {
    permanent += 1;
    return { text: JSON.stringify({ error: { message: "unauthorized" } }), isError: true };
  });
  expect(permanent).toBe(1);
  expect(denied.reason).toBe("unauthorized");
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

test("游标和 page 翻页不依赖 Zoho 的 data / index", async () => {
  const cursors: unknown[] = [];
  const byCursor = await countPagedList(
    request({ arguments: { cursor: "", status: "open" }, timeField: "created_at" }),
    async (args) => {
      cursors.push(args.cursor);
      expect(args).not.toHaveProperty("index");
      if (!args.cursor) {
        return {
          text: JSON.stringify({
            items: [{ id: "a", created_at: new Date(FROM).toISOString() }],
            has_more: true,
            next_cursor: "p2",
          }),
          isError: false,
        };
      }
      return {
        text: JSON.stringify({
          items: [{ id: "b", created_at: new Date(FROM + 3_600_000).toISOString() }],
          has_more: false,
        }),
        isError: false,
      };
    },
  );
  expect(cursors).toEqual(["", "p2"]);
  expect(byCursor.complete).toBe(true);
  expect(byCursor.unique).toBe(2);
  expect(byCursor.hours.map((item) => item.hour)).toEqual(["2026-09-16 07:00", "2026-09-16 08:00"]);

  const pages: unknown[] = [];
  const byPage = await countPagedList(request({ arguments: { page: 1, per_page: 2, filter: "x" } }), async (args) => {
    pages.push(args.page);
    expect(args.per_page).toBe(LIST_COUNT_PAGE_LIMIT);
    if (args.page === 1) {
      return { text: JSON.stringify({ results: [row("a", FROM), row("b", FROM)], has_more: true }), isError: false };
    }
    return { text: JSON.stringify({ results: [row("c", FROM + 3_600_000)], has_more: false }), isError: false };
  });
  expect(pages).toEqual([1, 2]);
  expect(byPage.complete).toBe(true);
  expect(byPage.unique).toBe(3);

  let seq = 0;
  const stuck = await countPagedList(request({ arguments: { page_token: "" } }), async () => {
    seq += 1;
    return {
      text: JSON.stringify({ records: [row(`n${seq}`, FROM)], has_more: true, next_page_token: "same" }),
      isError: false,
    };
  });
  expect(stuck.complete).toBe(false);
  expect(stuck.reason).toContain("游标未变化");

  const missing = await countPagedList(request({ arguments: { q: "x" } }), async () => ({
    text: JSON.stringify({ total: 1 }),
    isError: false,
  }));
  expect(missing.complete).toBe(false);
  expect(missing.reason).toContain("没有列表数组");
});

test("空页不装成翻完，点路径能取到时间，页大小被拒时缩小重试", async () => {
  const cursors: unknown[] = [];
  const followed = await countPagedList(request({ arguments: { cursor: "" } }), async (args) => {
    cursors.push(args.cursor);
    if (!args.cursor) {
      return { text: JSON.stringify({ data: [], has_more: true, next_cursor: "p2" }), isError: false };
    }
    return page([row("a", FROM)], false);
  });
  expect(cursors).toEqual(["", "p2"]);
  expect(followed.complete).toBe(true);
  expect(followed.unique).toBe(1);

  const stalled = await countPagedList(request(), async () => ({
    text: JSON.stringify({ data: [], has_more: true }),
    isError: false,
  }));
  expect(stalled.complete).toBe(false);
  expect(stalled.reason).toContain("空页");

  const primitives = await countPagedList(request(), async () => ({
    text: JSON.stringify({ data: ["a", "b"] }),
    isError: false,
  }));
  expect(primitives.complete).toBe(false);
  expect(primitives.reason).toContain("不是对象");

  const nested = await countPagedList(
    request({ timeField: "visitor.created_at", idField: "visitor.id" }),
    async () => ({
      text: JSON.stringify({
        items: [{ visitor: { id: "v1", created_at: new Date(FROM).toISOString() } }],
        has_more: false,
      }),
      isError: false,
    }),
  );
  expect(nested.complete).toBe(true);
  expect(nested.unique).toBe(1);
  expect(nested.hours).toEqual([{ hour: "2026-09-16 07:00", count: 1 }]);

  const sizes: number[] = [];
  const recovered = await countPagedList(request({ pageLimit: 100 }), async (args) => {
    const sent = (args.query_params as { limit: number }).limit;
    sizes.push(sent);
    if (sizes.length === 1) {
      return { text: JSON.stringify({ error: { message: "limit invalid" } }), isError: true };
    }
    return page([row("a", FROM)], false);
  });
  expect(sizes[0]).toBe(100);
  expect(sizes[1]).toBe(50);
  expect(recovered.complete).toBe(true);
  expect(recovered.unique).toBe(1);

  const linked = await countPagedList(request({ arguments: { from_time: 1 } }), async (args) => {
    expect(args).not.toHaveProperty("cursor");
    return {
      text: JSON.stringify({ data: [row("a", FROM)], next: "https://example.test/page2" }),
      isError: false,
    };
  });
  expect(linked.pages).toBe(1);
  expect(linked.complete).toBe(true);
  expect(linked.unique).toBe(1);
});

test("会话列表页大小封顶 99，其它列表用通用页大小", () => {
  const generic = pageLimitForTool("mcp__crm__listDeals");
  expect(generic).toBe(LIST_COUNT_PAGE_LIMIT);
  expect(pageLimitForTool("mcp__zoho-salesiq__ZohoSalesIQ_getConversationsList")).toBe(Math.min(99, generic));
});

test("会话列表把 in_time 改成 start_time 再分桶，其它字段保持原样", () => {
  const tool = "mcp__zoho-salesiq__ZohoSalesIQ_getConversationsList";
  expect(conversationCountTimeField(tool, "in_time")).toBe("start_time");
  expect(conversationCountTimeField(tool, "")).toBe("start_time");
  expect(conversationCountTimeField(tool, "end_time")).toBe("end_time");
  expect(conversationCountTimeField("mcp__other__list", "in_time")).toBe("in_time");
  expect(conversationCountTimeField("mcp__other__list", "")).toBe("start_time");
});

test("会话列表的字段投影必须带上 start_time，否则按 in_time 取回的行无法分桶", async () => {
  const tool = "mcp__zoho-salesiq__ZohoSalesIQ_getConversationsList";
  const projected = ensureConversationStartTime(tool, {
    query_params: { fields: "id,in_time,status", from_time: 1 },
  });
  expect((projected.query_params as { fields: string }).fields).toBe("id,in_time,status,start_time");
  const listed = ensureConversationStartTime(tool, { fields: ["id", "in_time"] });
  expect(listed.fields).toEqual(["id", "in_time", "start_time"]);
  const kept = ensureConversationStartTime(tool, { query_params: { fields: "id,start_time" } });
  expect((kept.query_params as { fields: string }).fields).toBe("id,start_time");

  const counted = await countPagedList(
    request({ timeField: "in_time", fallbackTimeField: "start_time" }),
    async () => page([row("a", FROM), row("b", FROM + 60_000)], false),
  );
  expect(counted.complete).toBe(true);
  expect(counted.unique).toBe(2);
  expect(counted.skippedTime).toBe(0);
});

test("会话列表只保留接口接受的排序，start_time 改回 in_time", () => {
  const filled = prepareListArgs("mcp__zoho-salesiq__ZohoSalesIQ_getConversationsList", {
    query_params: { from_time: 1 },
  });
  expect(filled.query_params).toMatchObject({ sort_by: "in_time", sort_order: "asc", from_time: 1 });
  const kept = prepareListArgs("mcp__zoho-salesiq__ZohoSalesIQ_getConversationsList", {
    query_params: { sort_by: "updated_time", sort_order: "desc" },
  });
  expect(kept.query_params).toMatchObject({ sort_by: "updated_time", sort_order: "desc" });
  const illegal = prepareListArgs("mcp__zoho-salesiq__ZohoSalesIQ_getConversationsList", {
    query_params: { sort_by: "start_time", sort_order: "asc", from_time: 1 },
  });
  expect(illegal.query_params).toMatchObject({ sort_by: "in_time", sort_order: "asc", from_time: 1 });
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
  expect(out?.text).toContain("整次计数已再试 3 次");
}, 20_000);

test("没传时区时用用户时区，显式 UTC 不被改写", () => {
  expect(resolveCountTimeZone("", "Asia/Shanghai")).toBe("Asia/Shanghai");
  expect(resolveCountTimeZone("UTC", "Asia/Shanghai")).toBe("UTC");
  expect(resolveCountTimeZone("", "Not/AZone")).toBe("UTC");
  expect(resolveCountTimeZone("Not/AZone", "Asia/Shanghai")).toBe("Not/AZone");
});
