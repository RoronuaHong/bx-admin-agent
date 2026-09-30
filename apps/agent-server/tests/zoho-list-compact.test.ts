import { test, expect } from "vitest";
import { compactFatListToolResult } from "../src/chat.js";

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
  expect(parsed.data[0]).toEqual({ id: "1", start_time: "1790676816781", country_code: "IN" });
  expect(parsed.data[1].country_code).toBe("UG");
  expect(slim).not.toMatch(/last_message_info/);
});

test("compactFatListToolResult：非列表工具原样返回", () => {
  const text = '{"ok":true}';
  expect(compactFatListToolResult("run_script", text)).toBe(text);
});
