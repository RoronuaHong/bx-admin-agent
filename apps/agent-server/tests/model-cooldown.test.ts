// 模型冷却状态持久化（第 3 批 P0-2）。
//
// 要补的洞：chat.ts 的冷却表是进程内 Map，重启即清——每次重启开场都把已耗尽配额的模型
// 从头打一遍（2026-10-14 事故的跨进程形态）。本模块把冷却状态落 Mongo（TTL 自愈），
// 连不上时退回进程内存（行为回到修复前现状），与 task-store.ts 同口径。
//
// 测试不依赖 Mongo 是否存在：未 init ⇒ mongoReady=false，天然走内存降级路径。
import { test, expect } from "vitest";
import {
  loadModelCooldowns,
  modelCooldownBackend,
  modelCooldownPersistenceEnabled,
  persistModelCooldown,
} from "../src/model-cooldown.js";

test("[A] 写入与读回（Mongo 不可用时走内存降级，行为一致）", async () => {
  expect(["memory", "mongo"]).toContain(modelCooldownBackend());
  const now = Date.now();
  await persistModelCooldown({ modelId: "model_a", until: now + 3_600_000, status: "402", at: now });
  const hit = (await loadModelCooldowns()).find((entry) => entry.modelId === "model_a");
  expect(hit?.status).toBe("402");
  expect(hit?.until).toBeGreaterThan(now);
});

test("[B] 过期条目读不回（冷却到期即失效，不拖一天）", async () => {
  const now = Date.now();
  await persistModelCooldown({ modelId: "model_expired", until: now - 1_000, at: now - 3_600_000 });
  const loaded = await loadModelCooldowns();
  expect(loaded.find((entry) => entry.modelId === "model_expired")).toBeUndefined();
});

test("[C] 同模型以更晚的 until 为准（重复写不丢更长的冷却）", async () => {
  const now = Date.now();
  await persistModelCooldown({ modelId: "model_dup", until: now + 60_000, at: now });
  await persistModelCooldown({ modelId: "model_dup", until: now + 7_200_000, at: now });
  const hit = (await loadModelCooldowns()).find((entry) => entry.modelId === "model_dup");
  expect(hit?.until).toBe(now + 7_200_000);
});

test("[D] 开关 MODEL_COOLDOWN_PERSIST=off 时整模块静默（回到进程内 Map 现状）", async () => {
  const saved = process.env.MODEL_COOLDOWN_PERSIST;
  process.env.MODEL_COOLDOWN_PERSIST = "off";
  try {
    expect(modelCooldownPersistenceEnabled()).toBe(false);
    expect(modelCooldownBackend()).toBe("memory");
    await persistModelCooldown({ modelId: "model_off", until: Date.now() + 60_000, at: Date.now() });
    expect(await loadModelCooldowns()).toEqual([]);
  } finally {
    if (saved === undefined) delete process.env.MODEL_COOLDOWN_PERSIST;
    else process.env.MODEL_COOLDOWN_PERSIST = saved;
  }
});

test("[E] 冷却原因状态码随条目保留（恢复时写回冷却原因表，供「定时运行跳过冷却」如实告知）", async () => {
  const now = Date.now();
  await persistModelCooldown({ modelId: "model_429", until: now + 3_600_000, status: "429", at: now });
  const hit = (await loadModelCooldowns()).find((entry) => entry.modelId === "model_429");
  expect(hit?.status).toBe("429");
});
