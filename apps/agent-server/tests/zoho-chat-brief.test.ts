import { test, expect } from "vitest";
import {
  BRIEF_MESSAGE_CAP,
  briefMessageLines,
  composeChatBrief,
  conversationIdField,
  conversationIdKeys,
} from "../src/salesiq-brief.js";

test("conversationIdField：优先 conversation_id，其次 id，schema 缺失落回 id", () => {
  expect(
    conversationIdField({ properties: { path_variables: { properties: { screenname: {}, conversation_id: {} } } } }),
  ).toBe("conversation_id");
  expect(conversationIdField({ properties: { path_variables: { properties: { screenname: {}, id: {} } } } })).toBe("id");
  expect(conversationIdField({ properties: { path_variables: { properties: { screenname: {}, conv_id: {} } } } })).toBe("conv_id");
  expect(conversationIdField(null)).toBe("id");
});

test("conversationIdKeys：返回全部 id 类键，portalid 等其余键由 pathDefaults 逐工具固定", () => {
  expect(conversationIdKeys({ properties: { path_variables: { properties: { id: {}, portalid: {} } } } })).toEqual(["id"]);
  expect(
    conversationIdKeys({ properties: { path_variables: { properties: { screenname: {}, conversation_id: {} } } } }),
  ).toEqual(["conversation_id"]);
  expect(conversationIdKeys(null)).toEqual(["id"]);
});

// 样例取自 Zoho 公开文档（get-conversation-details-v2 / conversation-get-message-v2）的响应结构。
const DETAIL = JSON.stringify({
  object: "conversations",
  data: {
    id: "19000000033103",
    status: "Connected",
    question: "My order is been damaged",
    department: { name: "Zylker Support" },
    attender: { name: "Agent A" },
    owner: { name: "Agent A" },
    start_time: "1708937800000",
    visitor: { name: "Tom", country_code: "JP", channel_name: "website" },
    last_message_info: {
      type: "text",
      time: "1708937814722",
      sender: { name: "Tom" },
      message: { text: "Can I get a picture of it?" },
    },
  },
});

const MSGS = JSON.stringify({
  object: "list",
  more_data_available: false,
  data: [
    {
      sequence_id: "1",
      time: "1773659219453",
      sender: { name: "Visitor 81933", type: "visitor" },
      type: "text",
      message: { text: "Hello, I need help" },
    },
    {
      sequence_id: "2",
      time: "1773659300000",
      sender: { name: "Support Agent", type: "operator" },
      type: "text",
      message: { text: "Sure" },
    },
  ],
});

test("composeChatBrief：详情裁出关键字段，消息压成逐行转录", () => {
  const out = composeChatBrief(DETAIL, MSGS, { conversationId: "19000000033103" });
  expect(out).toContain("会话 19000000033103 简报");
  expect(out).toContain("状态: Connected");
  expect(out).toContain("部门: Zylker Support");
  expect(out).toContain("接待人: Agent A");
  expect(out).toContain("访客: Tom / JP / website");
  expect(out).toContain("最后一条: [text] Tom");
  expect(out).toContain("1 [visitor] Visitor 81933 (1773659219453(ms)): Hello, I need help");
  expect(out).toContain("[operator] Support Agent");
  expect(out).not.toContain("more_data_available");
});

test("composeChatBrief：空消息列表给保留策略提示，不等于没说过话", () => {
  const out = composeChatBrief(DETAIL, JSON.stringify({ object: "list", data: [] }), {});
  expect(out).toContain("保留策略");
});

test("composeChatBrief：超过上限截断并提示 more_data_available", () => {
  const rows = Array.from({ length: BRIEF_MESSAGE_CAP + 5 }, (_, i) => ({
    sequence_id: String(i + 1),
    sender: { name: "v", type: "visitor" },
    message: { text: `m${i}` },
  }));
  const out = composeChatBrief(DETAIL, JSON.stringify({ object: "list", data: rows, more_data_available: true }), {});
  expect(out).toContain("more_data_available=true");
});

test("composeChatBrief：解析失败回退原文截断，不整体失败", () => {
  const out = composeChatBrief("not-json{{", "also-bad", {});
  expect(out).toContain("无法按预期结构解析");
  expect(out).toContain("not-json{{");
});

test("单条消息正文超长被截断", () => {
  const out = briefMessageLines(
    JSON.stringify({ data: [{ sequence_id: "1", sender: { name: "v", type: "visitor" }, message: { text: "x".repeat(600) } }] }),
  );
  expect(out[0].length).toBeLessThan(600);
});
