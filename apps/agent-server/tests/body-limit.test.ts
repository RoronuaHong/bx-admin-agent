import { test, expect } from "vitest";
import { bodyLimitFor } from "../src/app.js";

const general = 1_048_576;
const messages = 8 * general;

const upload = 22 * general;

test("对话消息快照和上传单独放宽，其它接口仍是 1MB", () => {
  expect(bodyLimitFor("/chat/conversations/conv_1/messages", general, messages, upload)).toBe(messages);
  expect(bodyLimitFor("/chat/conversations/conv_1/messages/", general, messages, upload)).toBe(messages);
  expect(bodyLimitFor("/chat/upload", general, messages, upload)).toBe(upload);
  expect(bodyLimitFor("/chat/stream", general, messages, upload)).toBe(general);
  expect(bodyLimitFor("/chat/conversations", general, messages, upload)).toBe(general);
});
