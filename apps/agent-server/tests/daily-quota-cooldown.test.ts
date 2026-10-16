// 每日配额型失败的冷却时长必须对齐「UTC 日切」（2026-10-14 事故复盘 §5 P0-1）。
//
// 事故形态：某聚合网关的免费额度按 **UTC 日**重置（当日 00:00 UTC 进入新周期），
// 而冷却时长是固定小时数 → 同一 UTC 日内冷却先到期，之后每个请求开场都把已耗尽的
// 模型重打一遍（本次开场连续 4 个候选 429，外加一个免费模型跑满 5 轮才撞死）。
//
// 本文件钉住：① 冷却终点 = 下一个 UTC 日切 + 缓冲；② 分流只影响「每日配额型」，
// 其它额度类失败仍走原小时级冷却；③ 显式覆盖后按覆盖值走（回滚口）。
import { test, expect } from "vitest";
import {
  dailyQuotaCooldownMs,
  isDailyQuotaFailure,
  isModelDownFailure,
  modelDownCooldownMs,
} from "../src/chat.js";

const DAY_MS = 86_400_000;
/** 事故当天 12:44:00Z，距当日日切 11h16m。 */
const NOON_UTC = Date.UTC(2026, 9, 14, 12, 44, 0);
/** 23:59:00Z——距日切只剩 1 分钟，最容易算出「几乎不冷却」的错值。 */
const ONE_MIN_BEFORE_MIDNIGHT = Date.UTC(2026, 9, 14, 23, 59, 0);

test("配额型 429 的冷却终点是下一个 UTC 日切 + 缓冲，而不是固定小时数", () => {
  const ms = dailyQuotaCooldownMs(NOON_UTC, 0);
  expect(ms).toBe(DAY_MS - (12 * 3600 + 44 * 60) * 1000 + 60_000);
  // 关键性质：必须**大于** 6 小时（旧口径），否则当日日切前一定会再被打一次。
  expect(ms).toBeGreaterThan(6 * 3600 * 1000);
  expect(ms).toBeLessThanOrEqual(DAY_MS + 60_000);
});

test("临近日切也要给缓冲，不得算出 0 长度冷却", () => {
  const ms = dailyQuotaCooldownMs(ONE_MIN_BEFORE_MIDNIGHT, 0);
  expect(ms).toBe(120_000); // 剩余 1 分钟 + 1 分钟缓冲
  expect(ms).toBeGreaterThan(0);
});

test("恰好落在日切瞬间时给到下一个日切，而不是当前这一瞬", () => {
  const exact = Date.UTC(2026, 9, 15, 0, 0, 0);
  expect(dailyQuotaCooldownMs(exact, 0)).toBe(DAY_MS + 60_000);
});

test("显式覆盖生效（回滚 / 自建网关口径不同）", () => {
  expect(dailyQuotaCooldownMs(NOON_UTC, 3_600_000)).toBe(3_600_000);
});

test("modelDownCooldownMs 分流：只有每日配额型走日切，其余口径不变", () => {
  const dailyQuota = 'model http 429: {"error":{"message":"Rate limit exceeded: free-models-per-day"}}';
  // 分流：配额型 → 日切
  expect(isDailyQuotaFailure(dailyQuota)).toBe(true);
  expect(modelDownCooldownMs(dailyQuota, NOON_UTC)).toBe(dailyQuotaCooldownMs(NOON_UTC, 0));
  // 仍是模型级失败（要进冷却表、要切候选）
  expect(isModelDownFailure(dailyQuota)).toBe(true);
  // 非配额型：402 仍走原小时级冷却，行为不变
  const quota402 = "model http 402: 额度不足";
  expect(isDailyQuotaFailure(quota402)).toBe(false);
  expect(modelDownCooldownMs(quota402, NOON_UTC)).toBe(6 * 3600 * 1000);
  // 500 仍走短周期冷却，行为不变
  expect(modelDownCooldownMs("model http 500: internal", NOON_UTC)).toBe(10 * 60 * 1000);
});

test("每分钟限流（plain 429）走短冷却档：分钟级恢复，不按小时/日冷却（§4.4 三类分层第一层）", () => {
  const perMinute =
    'model http 429: {"error":{"message":"Rate limit exceeded","metadata":{"error_type":"rate_limit_exceeded"}}}';
  expect(isDailyQuotaFailure(perMinute)).toBe(false);
  // 短冷却档（默认 90s）：既不是旧行为的不冷却，也不是配额型的 6 小时 / 日切。
  expect(modelDownCooldownMs(perMinute, NOON_UTC)).toBe(90_000);
  // plain 429 也是模型级失败：要进冷却表、要切候选（旧行为它俩都不进）。
  expect(isModelDownFailure(perMinute)).toBe(true);
});

test("短冷却档可调（env 覆盖，回滚 / 自建网关口径不同）", () => {
  const perMinute = 'model http 429: {"error":{"message":"Rate limit exceeded"}}';
  const saved = process.env.MODEL_RATE_LIMIT_COOLDOWN_MS;
  process.env.MODEL_RATE_LIMIT_COOLDOWN_MS = "30000";
  try {
    expect(modelDownCooldownMs(perMinute, NOON_UTC)).toBe(30_000);
    // 下限 5s：比这更短等于没冷却
    process.env.MODEL_RATE_LIMIT_COOLDOWN_MS = "1000";
    expect(modelDownCooldownMs(perMinute, NOON_UTC)).toBe(5_000);
  } finally {
    if (saved === undefined) delete process.env.MODEL_RATE_LIMIT_COOLDOWN_MS;
    else process.env.MODEL_RATE_LIMIT_COOLDOWN_MS = saved;
  }
});
