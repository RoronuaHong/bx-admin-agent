import { test, expect } from "vitest";
import { bodyLimitFor } from "../src/app.js";

const general = 1_048_576;
const messages = 8 * general;

test("对话消息快照用放宽上限，其它接口仍是 1MB", () => {
  expect(bodyLimitFor("/chat/conversations/conv_1/messages", general, messages)).toBe(messages);
  expect(bodyLimitFor("/chat/conversations/conv_1/messages/", general, messages)).toBe(messages);
  expect(bodyLimitFor("/chat/stream", general, messages)).toBe(general);
  expect(bodyLimitFor("/chat/conversations", general, messages)).toBe(general);
});
