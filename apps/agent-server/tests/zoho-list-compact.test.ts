import { test, expect } from "vitest";
import { compactFatListToolResult, withListCountHint } from "../src/chat.js";

test("compactFatListToolResult：压扁 Zoho getConversationsList 肥 JSON", () => {
  const fat = JSON.stringify({
    url: "/api/v2/castleapp/conversations",
    object: "list",
    more_data_available: true,
    data: [
      {
        id: "1",
        start_time: "1790676816781",
        visitor: { country_code: "IN", name: "x", channel_details: { source: "huge..." } },
        last_message_info: { message: { text: "pad".repeat(2000) } },
      },
      {
        id: "2",
        start_time: "1790676816000",
        visitor: { country_code: "UG" },
      },
    ],
  });
  expect(fat.length).toBeGreaterThan(4000);
  const slim = compactFatListToolResult("mcp__zoho-salesiq__ZohoSalesIQ_getConversationsList", fat);
  expect(slim.length).toBeLessThan(500);
  const parsed = JSON.parse(slim);
  expect(parsed.count).toBe(2);
  expect(parsed.data[0].id).toBe("1");
  expect(parsed.data[0].start_time).toBe("1790676816781");
  expect(parsed.data[0]["visitor.country_code"]).toBe("IN");
  expect(parsed.data[1]["visitor.country_code"]).toBe("UG");
  expect(slim).not.toMatch(/last_message_info/);
});

test("compactFatListToolResult：items / has_more 同样压扁并提示", () => {
  const fat = JSON.stringify({
    has_more: true,
    items: [{ id: "9", created_at: "2026-09-16T07:30:00.000Z", note: "n".repeat(3000) }],
  });
  const slim = compactFatListToolResult("mcp__crm__listDeals", fat);
  const parsed = JSON.parse(slim);
  expect(parsed.items[0].id).toBe("9");
  expect(parsed.items[0].created_at).toBe("2026-09-16T07:30:00.000Z");
  expect(slim).not.toContain("n".repeat(200));
  expect(withListCountHint("mcp__crm__listDeals", slim).startsWith("（跨页计数不要继续翻本列表")).toBe(true);
});

test("还有下一页时，计数提示放在结果头部", () => {
  const slim = compactFatListToolResult(
    "mcp__zoho-salesiq__ZohoSalesIQ_getConversationsList",
    JSON.stringify({ more_data_available: true, data: [{ id: "1", start_time: "1" }] }),
  );
  const hinted = withListCountHint("mcp__zoho-salesiq__ZohoSalesIQ_getConversationsList", slim);
  expect(hinted.startsWith("（跨页计数不要继续翻本列表")).toBe(true);
  expect(hinted).toContain("count_list_by_time");
  expect(withListCountHint("mcp__zoho-salesiq__ZohoSalesIQ_getConversationsList", '{"more_data_available":false}')).not.toContain(
    "count_list_by_time",
  );
  expect(
    withListCountHint("mcp__zoho-salesiq__ZohoSalesIQ_getConversationsList", '{ "more_data_available" : true }'),
  ).toContain("count_list_by_time");
});

test("compactFatListToolResult：非列表工具原样返回", () => {
  const text = '{"ok":true}';
  expect(compactFatListToolResult("run_script", text)).toBe(text);
});
