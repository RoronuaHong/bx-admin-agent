import { expect, test } from "vitest";
import { isModelDownFailure, isTransientModelError, orderModelCandidates } from "../src/chat.js";

test("402 和 HTTP 500 换模型，不在同一个模型上重试；503 仍可重试当前模型", () => {
  expect(isModelDownFailure("model http 402: 额度不足")).toBe(true);
  expect(isModelDownFailure("model http 500: internal")).toBe(true);
  expect(isTransientModelError("model http 402: 额度不足")).toBe(false);
  expect(isTransientModelError("model http 500: internal")).toBe(false);
  expect(isTransientModelError("model http 503: 模型服务暂时不可用")).toBe(true);
  expect(isModelDownFailure("model http 400: max 500")).toBe(false);
  expect(isTransientModelError("model http 400: max 500")).toBe(false);
});

test("自动模式把刚失败的模型放到队尾，从还能用的开始", () => {
  const all = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const cooling = new Map<string, number>([["a", 9_999]]);
  expect(orderModelCandidates(all, all[0]!, true, cooling, 1).map((item) => item.id)).toEqual(["b", "c", "a"]);
  expect(orderModelCandidates(all, all[1]!, false, cooling, 1).map((item) => item.id)).toEqual(["b", "c", "a"]);
});
