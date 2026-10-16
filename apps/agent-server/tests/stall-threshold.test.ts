// 看门狗阈值推导（第 3 批 P2-3）。
//
// 事故形态（2026-10-14）：真实模型超时是 180s（.env 每个模型都显式配了），
// 而 chat-tasks.ts 旧口径读了一个与 config.ts 不同的默认 300s，推出 600s 阈值——
// 与实测超时不匹配，一次卡死要 10 分钟后才被收口，用户侧先经历 627s 静默。
//
// 对标 AWS《Timeouts, Retries, and Backoff with Jitter》「超时值按实测分位数反推」：
// 阈值必须由**实测模型超时**派生，并把推导依据显式化（启动日志可读）。
import { test, expect, afterEach } from "vitest";
import { deriveStallMs, stallThresholdInfo, stallIdleMs } from "../src/chat-tasks.js";

const SAVED_STALL = process.env.CHAT_TASK_STALL_MS;

afterEach(() => {
  if (SAVED_STALL === undefined) delete process.env.CHAT_TASK_STALL_MS;
  else process.env.CHAT_TASK_STALL_MS = SAVED_STALL;
});

test("[A] 派生口径 = max(2 × 实测模型超时, 下限)：180s 模型 → 360s，不再失真到 600s", () => {
  delete process.env.CHAT_TASK_STALL_MS;
  expect(deriveStallMs(180_000, undefined, 240_000)).toBe(360_000);
});

test("[B] 下限兜底：模型再快也不低于 240s（工具执行批次同样可以合法静默）", () => {
  delete process.env.CHAT_TASK_STALL_MS;
  expect(deriveStallMs(60_000, undefined, 240_000)).toBe(240_000);
  expect(deriveStallMs(10_000, undefined, 240_000)).toBe(240_000);
});

test("[C] env 显式覆盖优先（回滚/调试用），仍受 60s 绝对下限保护", () => {
  expect(deriveStallMs(180_000, 900_000, 240_000)).toBe(900_000);
  expect(deriveStallMs(180_000, 1_000, 240_000)).toBe(60_000);
});

test("[D] 读不到实测值（0 / NaN）时回落默认口径，不产出 0 或 NaN 阈值", () => {
  delete process.env.CHAT_TASK_STALL_MS;
  expect(deriveStallMs(0, undefined, 240_000)).toBe(240_000);
  expect(deriveStallMs(Number.NaN, undefined, 240_000)).toBe(240_000);
});

test("[E] 启动信息可读：阈值/实测超时/下限/是否被覆盖都如实给出（推导显式化）", () => {
  const info = stallThresholdInfo();
  expect(info.stallMs).toBeGreaterThanOrEqual(60_000);
  expect(info.modelTimeoutMs).toBeGreaterThan(0);
  expect(info.floorMs).toBeGreaterThanOrEqual(60_000);
  expect(typeof info.overridden).toBe("boolean");
  // 未配 env 时：阈值必须恰好等于 max(2 × 实测, 下限)
  if (!info.overridden) {
    expect(info.stallMs).toBe(Math.max(info.floorMs, info.modelTimeoutMs * 2));
  }
});

test("[F] 看门狗判据本身不变：只认实质事件、阈值内不判死", () => {
  const now = 1_000_000;
  expect(stallIdleMs({ lastEventAt: now }, now, 360_000)).toBeNull();
  expect(stallIdleMs({ lastEventAt: now - 359_999 }, now, 360_000)).toBeNull();
  expect(stallIdleMs({ lastEventAt: now - 360_000 }, now, 360_000)).toBe(360_000);
});
