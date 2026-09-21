// 聊天附件注入预算：附件文本拼进**系统提示**，不参与历史预算，故自带 token 闸门。
// 覆盖四类真实边界：中文（≈1 token/字）超限、英文（≈4 字符/token）不误伤、短文本不动、空文本。
import { test, expect } from "vitest";
import { truncateToTokens } from "../src/chat.js";
import { estimateTokens } from "../src/models.js";

test("[A] 中文长文本：按 token 截断且不越界", () => {
  const text = "数据".repeat(10_000); // 20k 字符 ≈ 20k token
  const capped = truncateToTokens(text, 1000);
  expect(capped.truncated).toBe(true);
  expect(estimateTokens(capped.text)).toBeLessThanOrEqual(1000);
  expect(capped.text.length).toBeGreaterThan(0);
});

test("[B] 英文长文本：同样受 token 预算约束（不是按字符）", () => {
  const text = "a".repeat(40_000); // 40k 字符 ≈ 10k token
  const capped = truncateToTokens(text, 1000);
  expect(capped.truncated).toBe(true);
  expect(estimateTokens(capped.text)).toBeLessThanOrEqual(1000);
  // 英文每 token 装 4 字符：留下的字符数应显著多于中文同预算下的字符数。
  expect(capped.text.length).toBeGreaterThan(2000);
});

test("[C] 未超预算：原样返回且不标记截断", () => {
  const text = "短文本";
  const capped = truncateToTokens(text, 1000);
  expect(capped.truncated).toBe(false);
  expect(capped.text).toBe(text);
});

test("[D] 空文本与零预算：不抛异常", () => {
  expect(truncateToTokens("", 1000)).toEqual({ text: "", truncated: false });
  const capped = truncateToTokens("内容", 1);
  expect(estimateTokens(capped.text)).toBeLessThanOrEqual(1);
});
