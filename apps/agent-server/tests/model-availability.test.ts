// 模型可用性分类与钉钉文案回归（2026-11-02）。
//
// 核心修复：每日免费额度耗尽（OpenRouter free tier / TokenHub 免费档 / 上游标成 429 的日限额）
// 本质是「额度 / 余额没了」而不是限流，必须归 402（欠费 / 额度耗尽），不能误归 429（请求过于频繁），
// 否则群里无从判断「该充钱」还是「该等一会」。同时把每个状态码的推送文案写成
// 「发生了什么 + 下一步做什么」，对齐清晰报错的最佳实践。
import { test, expect, beforeEach, afterEach } from "vitest";
import {
  modelAvailabilityStatus,
  noteDailyQuotaExhausted,
  quotaCooldownUntil,
  quotaCooldownStatus,
  uniformFailureStatus,
} from "../src/model-availability.js";
import { modelAvailabilityNotice } from "../src/chat.js";

beforeEach(() => {
  quotaCooldownUntil.clear();
  quotaCooldownStatus.clear();
});
afterEach(() => {
  quotaCooldownUntil.clear();
  quotaCooldownStatus.clear();
});

test("每日免费额度耗尽归为 402（欠费 / 额度耗尽），而不是 429 限流", () => {
  expect(modelAvailabilityStatus("free-models-per-day limit reached")).toBe("402");
  expect(modelAvailabilityStatus("OpenRouter free_tier_daily limit exceeded")).toBe("402");
  expect(modelAvailabilityStatus("免费额度已耗尽，请明日再试")).toBe("402");
});

test("免费额度耗尽即便被上游标成 429 也归 402", () => {
  expect(modelAvailabilityStatus("model http 429 free-models-per-day limit reached")).toBe("402");
});

test("真实限流 429 仍是 429，不会被误判成额度耗尽", () => {
  expect(modelAvailabilityStatus("model http 429 Rate limit exceeded")).toBe("429");
  // 没带 model http 前缀、也不含额度 / 余额词 → 认不出，回落 null（交 unclassified 文案）。
  expect(modelAvailabilityStatus("Too many requests")).toBeNull();
});

test("通用额度 / 余额 / 未开通归 402，权限类 401 / 403 保持原码", () => {
  expect(modelAvailabilityStatus("model http 402 insufficient balance")).toBe("402");
  expect(modelAvailabilityStatus("401008 额度不足")).toBe("402");
  expect(modelAvailabilityStatus("模型未开通")).toBe("402");
  expect(modelAvailabilityStatus("model http 401 Unauthorized")).toBe("401");
  expect(modelAvailabilityStatus("model http 403 Forbidden")).toBe("403");
});

test("其它状态码原样返回", () => {
  expect(modelAvailabilityStatus("model http 500 internal error")).toBe("500");
  expect(modelAvailabilityStatus("model http 404 not found")).toBe("404");
  expect(modelAvailabilityStatus("model http 400 bad request")).toBe("400");
});

test("402 文案明确是欠费 / 额度耗尽，429 文案明确是限流", () => {
  const n402 = modelAvailabilityNotice("402");
  expect(n402).toContain("402");
  expect(n402).toMatch(/欠费|额度|余额/);
  expect(n402).toContain("切换到仍有额度的模型");

  const n429 = modelAvailabilityNotice("429");
  expect(n429).toContain("429");
  expect(n429).toContain("限流");
});

test("所有候选都 402 额度耗尽时，提示改成「全部耗尽，请充值」而非「切换到仍有额度的模型」", () => {
  const n = modelAvailabilityNotice("402", true);
  expect(n).toContain("402");
  expect(n).toContain("所有候选模型额度均已耗尽，请充值 / 续费");
  expect(n).not.toContain("切换到仍有额度的模型");
  // 非全耗尽（默认）仍保留切换建议。
  expect(modelAvailabilityNotice("402")).toContain("切换到仍有额度的模型");
});

test("uniformFailureStatus：判断候选是否都因同一状态码失败", () => {
  expect(uniformFailureStatus([])).toBeNull();
  expect(uniformFailureStatus([null, undefined])).toBeNull();
  expect(uniformFailureStatus(["402", "402", "402"])).toBe("402");
  // 只要有任一不同，就认不出统一码（避免误判成「全耗尽」）。
  expect(uniformFailureStatus(["402", "429"])).toBeNull();
  expect(uniformFailureStatus(["500", "500", "402"])).toBeNull();
  // 任一候选原因未知（null）也不能算「全同码」：2 个 402 + 1 个未归类，不能误判成全部耗尽。
  expect(uniformFailureStatus(["402", null, "402"])).toBeNull();
  expect(uniformFailureStatus([null, "402", "402"])).toBeNull();
});

test("noteDailyQuotaExhausted 把冷却状态记成 402（与 modelAvailabilityStatus 归口一致）", () => {
  noteDailyQuotaExhausted("kimi-free", 0);
  expect(quotaCooldownStatus.get("kimi-free")).toBe("402");
  expect(quotaCooldownUntil.get("kimi-free")).toBeGreaterThan(0);
});
