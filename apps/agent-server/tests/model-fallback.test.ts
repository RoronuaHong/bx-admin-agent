import { expect, test } from "vitest";
import {
  isDailyQuotaFailure,
  isModelDownFailure,
  modelDownCooldownMs,
  isTransientModelError,
  modelAvailabilityNotice,
  partialInterruptLine,
  UNCLASSIFIED_MODEL_FAILURE,
  modelAvailabilityStatus,
  orderModelCandidates,
  toolRoundsForRun,
} from "../src/chat.js";

test("402、500、503 都换模型，不在同一个模型上重试", () => {
  expect(isModelDownFailure("model http 402: 额度不足")).toBe(true);
  expect(isModelDownFailure("model http 500: internal")).toBe(true);
  expect(isTransientModelError("model http 402: 额度不足")).toBe(false);
  expect(isTransientModelError("model http 500: internal")).toBe(false);
  expect(isTransientModelError("model http 503: 模型服务暂时不可用")).toBe(false);
  expect(isModelDownFailure("model http 400: max 500")).toBe(false);
  expect(isTransientModelError("model http 400: max 500")).toBe(false);
});

test("402、500、429 都立刻换模型；当日额度用尽才冷却，短暂 429 不冷却", () => {
  const daily = 'model http 429: {"error":{"message":"Rate limit exceeded: free-models-per-day"}}';
  const brief = "model http 429: temporarily rate-limited upstream";
  expect(isDailyQuotaFailure(daily)).toBe(true);
  expect(isModelDownFailure(daily)).toBe(true);
  expect(isTransientModelError(daily)).toBe(false);
  expect(modelAvailabilityStatus(daily)).toBe("429");
  expect(isDailyQuotaFailure("model http 429: FreeUsageLimitError")).toBe(true);
  expect(isTransientModelError(brief)).toBe(false);
  expect(isModelDownFailure(brief)).toBe(false);
  expect(modelAvailabilityStatus(brief)).toBe("429");
  expect(modelAvailabilityStatus("model http 402: 额度不足")).toBe("402");
  expect(modelAvailabilityStatus("model http 500: internal")).toBe("500");
  expect(modelAvailabilityStatus("model http 503: 模型服务暂时不可用")).toBe("503");
  expect(isTransientModelError("model http 503: 模型服务暂时不可用")).toBe(false);
  expect(isModelDownFailure("model http 503: 模型服务暂时不可用")).toBe(false);
  expect(modelAvailabilityNotice("503")).toContain("503");
  expect(modelAvailabilityNotice("503")).toContain("仍然失败");
  expect(modelAvailabilityNotice("429")).toContain("429");
  expect(modelAvailabilityNotice("429")).not.toContain("{");
  const raw = 'model http 402: {"error":{"message":"insufficient_quota"}}';
  expect(partialInterruptLine(raw)).toContain("402");
  expect(partialInterruptLine(raw)).not.toContain("insufficient_quota");
  expect(partialInterruptLine("socket hang up")).toBe(
    `生成中断，详情见服务端日志（以上为中断前的中间结果，可能不完整）`,
  );
  expect(UNCLASSIFIED_MODEL_FAILURE).not.toContain("{");
  for (const code of ["400", "401", "403", "404", "408", "413", "422", "529"] as const) {
    expect(modelAvailabilityStatus(`model http ${code}: detail`)).toBe(code);
    expect(isTransientModelError(`model http ${code}: detail`)).toBe(false);
    expect(modelAvailabilityNotice(code)).toContain(code);
    expect(modelAvailabilityNotice(code)).toContain("仍然失败");
  }
  expect(isModelDownFailure("model http 401: unauthorized")).toBe(true);
  expect(isModelDownFailure("model http 403: forbidden")).toBe(true);
  expect(isModelDownFailure("model http 404: missing")).toBe(true);
  expect(isModelDownFailure("model http 408: timeout")).toBe(false);
  expect(isModelDownFailure("model http 529: overloaded")).toBe(false);
  expect(isModelDownFailure("model http 400: bad request")).toBe(false);
});

test("未开通的模型按小时冷却，500 只冷却一个调度周期", () => {
  expect(modelDownCooldownMs("model http 402: 额度不足")).toBeGreaterThan(60 * 60 * 1000);
  expect(modelDownCooldownMs("model http 500: internal")).toBe(10 * 60 * 1000);
});

test("预警轮次不被自主度下调；其它运行仍用收紧后的预算", () => {
  expect(toolRoundsForRun(12, 8, true)).toBe(12);
  expect(toolRoundsForRun(28, 8, false)).toBe(8);
});

test("自动模式把刚失败的模型放到队尾，从还能用的开始", () => {
  const all = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const cooling = new Map<string, number>([["a", 9_999]]);
  expect(orderModelCandidates(all, all[0]!, true, cooling, 1).map((item) => item.id)).toEqual(["b", "c", "a"]);
  expect(orderModelCandidates(all, all[1]!, false, cooling, 1).map((item) => item.id)).toEqual(["b", "c", "a"]);
});

test("自动模式先免费模型，DeepSeek-Flash 兜底，不把默认模型插到队首", () => {
  const all = [
    { id: "ds4flash0731", name: "deepseek/deepseek-flash", label: "DeepSeek-Flash" },
    { id: "step5", name: "step-5-preview", label: "Step-5-Preview" },
    { id: "spacebunny", name: "space-bunny-free", label: "Space Bunny Free" },
    { id: "ornem3u", name: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron-3-Ultra(OR免费)" },
    { id: "orling31", name: "inclusionai/ling-3.1-flash", label: "Ling-3.1-Flash(OR免费)" },
  ];
  expect(orderModelCandidates(all, all[0]!, true).map((item) => item.id)).toEqual([
    "spacebunny",
    "ornem3u",
    "orling31",
    "ds4flash0731",
    "step5",
  ]);
  const cooling = new Map<string, number>([["spacebunny", 9_999]]);
  expect(orderModelCandidates(all, all[0]!, true, cooling, 1, true).map((item) => item.id)).toEqual([
    "ornem3u",
    "orling31",
    "ds4flash0731",
    "step5",
  ]);
});

test("定时运行跳过冷却中的模型；一个能用的都没有就返回空名单", () => {
  const all = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const cooling = new Map<string, number>([
    ["a", 9_999],
    ["b", 9_999],
    ["c", 9_999],
  ]);
  const partial = new Map<string, number>([["a", 9_999]]);
  expect(orderModelCandidates(all, all[0]!, true, partial, 1, true).map((item) => item.id)).toEqual(["b", "c"]);
  expect(orderModelCandidates(all, all[0]!, false, partial, 1, true).map((item) => item.id)).toEqual(["a", "b", "c"]);
  expect(orderModelCandidates(all, null, true, cooling, 1, true)).toEqual([]);
});
