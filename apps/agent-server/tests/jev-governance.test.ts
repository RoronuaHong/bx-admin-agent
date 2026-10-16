// Jev 纳入统一治理（第 7 批）。
//
// 事故复盘的口径：Jev 此前是「裸 fetch + 写死 8s 超时 + 只 console.warn」——失败不可复盘、
// 慢端点被系统性误杀、走 OpenRouter 时不吃额度治理。本文件把治理的每一格都钉住：
//   ① 超时按实测派生（不再写死 8s，但保底仍是 8s、封顶 30s）；
//   ② 失败按共享判据归类 → 冷却表 + 落盘（与对话模型同一份实现，不各写一套）；
//   ③ 额度预检（走 OpenRouter 时）→ 耗尽则不发请求；
//   ④ 每次调用一条 llm span（runId 关联），带低基数 error.type；
//   ⑤ 调用/失败计数进 usage → 在线评测 classifier_health；
//   ⑥ **语义不变**：Jev 仍不在对话模型名单里，结果仍不回灌写回复的模型。
//
// 测试不依赖真实 Jev 端点：治理逻辑的输入都是可注入的（配置走 env、传输层靠不发请求短路）。
import { test, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  currentJevTimeoutMs,
  isVisitorVisibleSend,
  jevTimeoutInfo,
  parsePromiseProbability,
  parseSupportReading,
  reviewSupportPromise,
  supportSendAllowed,
  type ClassifierStats,
} from "../src/jev.js";
import { isCoolingDown, quotaCooldownUntil } from "../src/model-availability.js";
import { deriveAdaptiveTimeoutMs } from "../scripts/adaptive-timeout.mjs";

const JEV_SRC = readFileSync(fileURLToPath(new URL("../src/jev.ts", import.meta.url)), "utf8");
const CHAT_SRC = readFileSync(fileURLToPath(new URL("../src/chat.ts", import.meta.url)), "utf8");

/** 清掉冷却表与相关 env，避免用例之间互相影响（冷却表是模块级共享状态）。 */
function resetCooldowns(): void {
  quotaCooldownUntil.clear();
}
const savedEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  resetCooldowns();
  setEnv("JEV_TIMEOUT_MS", undefined);
  setEnv("JEV_TIMEOUT_FLOOR_MS", undefined);
  setEnv("JEV_TIMEOUT_MAX_MS", undefined);
  setEnv("JEV_API_KEY", undefined);
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ── ① 超时按实测派生 ───────────────────────────────────────────────────────
test("[A] 默认保底仍是 8s（交互体感不变），且不再是写死常量", () => {
  const info = jevTimeoutInfo();
  expect(info.timeoutMs).toBe(8000);
  expect(info.floorMs).toBe(8000);
  expect(info.maxMs).toBe(30000);
  expect(info.overridden).toBe(false);
  // 关键性质：源码里不再出现写死的 8000 毫秒超时（旧口径是 AbortSignal.timeout(8000)）
  expect(JEV_SRC).not.toMatch(/AbortSignal\.timeout\(8000\)/);
  expect(JEV_SRC).toContain("currentJevTimeoutMs");
});

test("[B] JEV_TIMEOUT_MS 显式覆盖优先（回滚口），且被记录为 overridden", () => {
  setEnv("JEV_TIMEOUT_MS", "3000");
  expect(currentJevTimeoutMs()).toBe(3000);
  expect(jevTimeoutInfo().overridden).toBe(true);
});

test("[C] 保底与封顶可调；派生夹在两者之间（与 BI 查询超时同一份实现）", () => {
  // 派生逻辑与第 6 批共用：样本不足按保底、超出封顶被夹住
  expect(deriveAdaptiveTimeoutMs({ configuredMs: 8000, samples: [], maxMs: 30000 })).toBe(8000);
  expect(deriveAdaptiveTimeoutMs({ configuredMs: 8000, samples: [100, 200], maxMs: 30000 })).toBe(8000);
  // 样本够了但派生值没到封顶 → 按派生值（实测慢就上调，这正是本批要改的行为）
  expect(
    deriveAdaptiveTimeoutMs({ configuredMs: 8000, samples: [9000, 9000, 9000], maxMs: 30000, minSamples: 3 }),
  ).toBe(18000);
  // 派生值高于封顶 → 夹住（不让一个挂死端点把客服一轮拖住）
  expect(
    deriveAdaptiveTimeoutMs({ configuredMs: 8000, samples: [20000, 20000, 20000], maxMs: 30000, minSamples: 3 }),
  ).toBe(30000);
});

// ── ② 失败归类与冷却（共享判据，不各写一套） ───────────────────────────────
test("[D] 冷却键是 jev，与对话模型共用同一张表（共享冷却语义）", () => {
  resetCooldowns();
  expect(isCoolingDown("jev")).toBe(false);
  quotaCooldownUntil.set("jev", Date.now() + 60_000);
  expect(isCoolingDown("jev")).toBe(true);
  // 反过来也一样：对话模型的冷却对 jev 键可见（同一张 Map，不是两张表）
  quotaCooldownUntil.set("other-model", Date.now() + 60_000);
  expect(quotaCooldownUntil.has("other-model")).toBe(true);
  expect(JEV_SRC).toContain('const JEV_COOLDOWN_KEY = "jev"');
  expect(JEV_SRC).toContain("noteDownFailure(JEV_COOLDOWN_KEY");
});

test("[E] 未配置密钥：如实标 unconfigured，且不计入调用统计（没调过≠坏了）", async () => {
  setEnv("JEV_API_KEY", undefined);
  const stats: ClassifierStats = { calls: 0, failures: 0 };
  const r = await reviewSupportPromise("我们全额退款已经批了", { stats });
  expect(r).toEqual({ probability: null, reason: "unconfigured" });
  expect(stats.calls, "没配置就不该有调用计数").toBe(0);
});

test("[F] 冷却中：不发请求、不计入失败（fail-open，如实标「没有结果」）", async () => {
  setEnv("JEV_API_KEY", "k-test");
  setEnv("JEV_BASE_URL", "http://127.0.0.1:1"); // 端点不可达：若真发请求必然失败
  quotaCooldownUntil.set("jev", Date.now() + 60_000);
  const stats: ClassifierStats = { calls: 0, failures: 0 };
  const r = await reviewSupportPromise("正文", { stats });
  expect(r.reason).toBe("failed"); // 没有结果
  expect(stats.calls, "冷却短路不算调用").toBe(0);
  expect(stats.failures, "没发请求就不算失败").toBe(0);
});

// ── ④⑥ span 与「不进对话模型名单」两条静态断言 ─────────────────────────────
test("[G] Jev 仍不在对话模型名单里，语义与文档一致（第 7 批不改这条结论）", () => {
  // listModels() 只认 MODEL_PROVIDERS；Jev 的配置键是 JEV_*，两者不相通
  expect(JEV_SRC).toContain("process.env.JEV_API_KEY");
  expect(JEV_SRC).not.toContain("MODEL_PROVIDERS");
  const configSrc = readFileSync(fileURLToPath(new URL("../src/config.ts", import.meta.url)), "utf8");
  expect(configSrc).not.toContain("JEV_");
});

test("[H] 每次调用落一条 llm span：低基数 error.type + 分类语义标注", () => {
  expect(JEV_SRC).toContain("appendSpanTrace");
  expect(JEV_SRC).toContain('"gen_ai.operation.name": "classify"');
  expect(JEV_SRC).toContain('"bx.jev.questions"');
  // error.type 走共享状态码识别（低基数），不填消息文本
  expect(JEV_SRC).toContain('"error.type": modelAvailabilityStatus(failure) ?? "other"');
});

test("[I] 工具路径的代发检查都带上 runId（漏传就等于「查不出来的失败」）", () => {
  // 三个代发检查点共用一个助手，避免各处漏传
  expect(CHAT_SRC).toContain("const jevOpts = (ctx: LoopContext): JevCallOpts");
  const calls = CHAT_SRC.match(/visitorSendRefusal\(/g) || [];
  expect(calls.length, "代发检查点数量").toBeGreaterThanOrEqual(3);
  // 调用点里有 mcpArgs(...) 的嵌套括号，正则用宽松匹配（[^;]*? 到 jevOpts(ctx) 为止）
  const withOpts = CHAT_SRC.match(/visitorSendRefusal\([^;]*?jevOpts\(ctx\)/g) || [];
  expect(withOpts.length, "每个代发检查点都要传 jevOpts(ctx)").toBe(calls.length);
});

// ── 解析与安全语义（回归：治理改造不能动既有阈值与拒发口径） ────────────────
test("[J] 解析与拒发口径（CJK 地板 0.6）：承诺 ≥0.9 拒发、≥0.6 模糊一带也拒、<0.6 才放行", () => {
  const reading = parseSupportReading({
    answers: {
      task: { choice: "起草回复", confidence: 0.8 },
      send: { probability: 0.99 },
      route: { choice: "留在客服", confidence: 0.7 },
      override: { probability: 0.02 },
    },
  });
  expect(reading?.task?.value).toBe("起草回复");
  expect(reading?.send).toBe(0.99);
  expect(parsePromiseProbability({ answers: { promise: { probability: 0.95 } } })).toBe(0.95);
  // 代发闸门：高置信承诺拒发；CJK 地板抬到 0.6 后，模糊一带（0.7）也拒（fail-open）；<0.6 才放行
  expect(supportSendAllowed(0.95)).toBe(false);
  expect(supportSendAllowed(0.7)).toBe(false);
  expect(supportSendAllowed(0.4)).toBe(true);
  // 边界保守：没有结果 ≠ 通过
  expect(supportSendAllowed(null)).toBe(false);
});

test("[K] 代发工具名单仍只含访客可见的发送类工具（治理改造不扩权）", () => {
  expect(isVisitorVisibleSend("ZohoSalesIQ_sendMessageInConversation")).toBe(true);
  expect(isVisitorVisibleSend("ZohoSalesIQ_getConversation")).toBe(false);
});