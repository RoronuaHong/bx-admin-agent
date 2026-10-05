import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  counterValue,
  incCounter,
  observeSummary,
  renderPrometheus,
  resetMetricsForTest,
} from "../src/process-metrics.js";
import { addDailyTokens, quotaState, setDailyTokensForTest, trackedOwnerCountForTest } from "../src/quota.js";

/**
 * P1 补齐项回归：
 * - 进程级指标（Prometheus 文本格式，零依赖）
 * - 成本硬配额（默认关闭，开启后 fail-closed）
 */
describe("进程级指标（Prometheus 文本格式）", () => {
  beforeEach(() => resetMetricsForTest());

  it("计数器与观测值都能累加", () => {
    incCounter("bx_test_calls_total", "测试计数", { status: "ok" });
    incCounter("bx_test_calls_total", "测试计数", { status: "ok" });
    incCounter("bx_test_calls_total", "测试计数", { status: "error" });
    expect(counterValue("bx_test_calls_total", { status: "ok" })).toBe(2);
    expect(counterValue("bx_test_calls_total", { status: "error" })).toBe(1);

    observeSummary("bx_test_duration_ms", "测试耗时", {}, 100);
    observeSummary("bx_test_duration_ms", "测试耗时", {}, 300);
    const text = renderPrometheus();
    expect(text).toContain("bx_test_duration_ms_count 2");
    expect(text).toContain("bx_test_duration_ms_sum 400");
  });

  it("输出含 HELP / TYPE，且未打点的指标也出现（序列不消失）", () => {
    incCounter("bx_test_a_total", "甲", {});
    observeSummary("bx_test_b_ms", "乙", {}, 5);
    const text = renderPrometheus();
    expect(text).toContain("# HELP bx_test_a_total 甲");
    expect(text).toContain("# TYPE bx_test_a_total counter");
    expect(text).toContain("# TYPE bx_test_b_ms summary");
    expect(text).toMatch(/bx_test_a_total 1/);
  });

  it("label 中的引号与反斜杠被转义，不破坏文本格式", () => {
    incCounter("bx_test_escape_total", "转义", { model: 'a"b\\c' });
    const text = renderPrometheus();
    expect(text).toContain('bx_test_escape_total{model="a\\"b\\\\c"} 1');
  });
});

describe("成本硬配额（默认关闭）", () => {
  const savedQuota = process.env.COST_HARD_QUOTA;
  const savedBudget = process.env.DAILY_TOKEN_BUDGET;

  afterEach(() => {
    if (savedQuota === undefined) delete process.env.COST_HARD_QUOTA;
    else process.env.COST_HARD_QUOTA = savedQuota;
    if (savedBudget === undefined) delete process.env.DAILY_TOKEN_BUDGET;
    else process.env.DAILY_TOKEN_BUDGET = savedBudget;
    setDailyTokensForTest(0);
  });

  it("默认（未开启）恒等放行，不改变现状", () => {
    delete process.env.COST_HARD_QUOTA;
    process.env.DAILY_TOKEN_BUDGET = "1000";
    setDailyTokensForTest(999_999);
    expect(quotaState().allowed).toBe(true);
    expect(quotaState().enabled).toBe(false);
  });

  it("开启后未达预算放行、达预算拒绝（fail-closed）", () => {
    process.env.COST_HARD_QUOTA = "on";
    process.env.DAILY_TOKEN_BUDGET = "1000";
    setDailyTokensForTest(999);
    expect(quotaState().allowed).toBe(true);
    expect(quotaState().enabled).toBe(true);
    setDailyTokensForTest(1000);
    expect(quotaState().allowed).toBe(false);
  });

  it("开启但未配预算时不拦截（避免误伤）", () => {
    process.env.COST_HARD_QUOTA = "on";
    delete process.env.DAILY_TOKEN_BUDGET;
    delete process.env.DAILY_TOKEN_BUDGET_PER_OWNER;
    setDailyTokensForTest(999_999);
    expect(quotaState().allowed).toBe(true);
  });

  it("addDailyTokens 累加，负数与非法值被忽略", () => {
    setDailyTokensForTest(0);
    addDailyTokens(10);
    addDailyTokens(5);
    expect(quotaState().used).toBe(15);
    addDailyTokens(-100);
    addDailyTokens(Number.NaN);
    expect(quotaState().used).toBe(15);
  });
});

/**
 * 每 owner 配额层（LLM10 / 可用性）：
 * 全局单一池会让**任意一个用户烧光当日共享预算、把其他人全挡住**——单点饿死。
 * 加一层每 owner 池后，A 烧满只挡 A，B 不受影响。
 */
describe("成本硬配额：每 owner 层", () => {
  const savedQuota = process.env.COST_HARD_QUOTA;
  const savedBudget = process.env.DAILY_TOKEN_BUDGET;
  const savedPerOwner = process.env.DAILY_TOKEN_BUDGET_PER_OWNER;
  const savedMaxOwners = process.env.QUOTA_MAX_TRACKED_OWNERS;

  beforeEach(() => {
    process.env.COST_HARD_QUOTA = "on";
    delete process.env.DAILY_TOKEN_BUDGET; // 只测每 owner 层时，全局层不启用
    process.env.DAILY_TOKEN_BUDGET_PER_OWNER = "1000";
    setDailyTokensForTest(0);
  });

  afterEach(() => {
    if (savedQuota === undefined) delete process.env.COST_HARD_QUOTA;
    else process.env.COST_HARD_QUOTA = savedQuota;
    if (savedBudget === undefined) delete process.env.DAILY_TOKEN_BUDGET;
    else process.env.DAILY_TOKEN_BUDGET = savedBudget;
    if (savedPerOwner === undefined) delete process.env.DAILY_TOKEN_BUDGET_PER_OWNER;
    else process.env.DAILY_TOKEN_BUDGET_PER_OWNER = savedPerOwner;
    if (savedMaxOwners === undefined) delete process.env.QUOTA_MAX_TRACKED_OWNERS;
    else process.env.QUOTA_MAX_TRACKED_OWNERS = savedMaxOwners;
    setDailyTokensForTest(0);
  });

  it("未配每 owner 预算时该层不启用（行为与改动前一致）", () => {
    delete process.env.DAILY_TOKEN_BUDGET_PER_OWNER;
    setDailyTokensForTest(0, "a", 999_999);
    expect(quotaState("a").allowed).toBe(true);
    expect(quotaState("a").enabled).toBe(false);
  });

  it("A 烧满只挡 A，不影响 B（这正是双层配额的意义）", () => {
    setDailyTokensForTest(0);
    addDailyTokens(1500, "A");
    expect(quotaState("A").allowed).toBe(false);
    expect(quotaState("A").blockedBy).toBe("owner");
    // B 用量与 A 无关，照常放行——单用户无法把别人一起挡住。
    expect(quotaState("B").allowed).toBe(true);
    expect(quotaState("B").ownerUsed).toBe(0);
  });

  it("两层都要满足：owner 未超但全局已超时仍拒（守钱包优先）", () => {
    process.env.DAILY_TOKEN_BUDGET = "2000";
    setDailyTokensForTest(2500, "A", 10);
    expect(quotaState("A").allowed).toBe(false);
    expect(quotaState("A").blockedBy).toBe("global");
  });

  it("全局未超但 owner 超时拒（blockedBy=owner，与全局区分）", () => {
    process.env.DAILY_TOKEN_BUDGET = "100000";
    setDailyTokensForTest(10, "A", 1000);
    expect(quotaState("A").allowed).toBe(false);
    expect(quotaState("A").blockedBy).toBe("owner");
  });

  it("未传 ownerKey 时只看全局池（无 owner 上下文的调用不被新层误伤）", () => {
    setDailyTokensForTest(0, "A", 5000);
    expect(quotaState().allowed).toBe(true); // 该层对无 owner 场景不生效
    expect(quotaState().ownerUsed).toBe(0);
  });

  it("跨天清空 owner 计数（与全局池同步重置）", () => {
    setDailyTokensForTest(0, "A", 900);
    expect(quotaState("A").ownerUsed).toBe(900);
    // 模拟跨天：把计数置 0 即等价于 rollover 后状态
    setDailyTokensForTest(0);
    expect(quotaState("A").ownerUsed).toBe(0);
    expect(quotaState("A").allowed).toBe(true);
  });

  it("owner 跟踪表有界：超出上限淘汰最早的，不因匿名 ownerKey 无限增长", () => {
    process.env.QUOTA_MAX_TRACKED_OWNERS = "3";
    setDailyTokensForTest(0);
    for (const id of ["o1", "o2", "o3", "o4", "o5"]) addDailyTokens(10, id);
    expect(trackedOwnerCountForTest()).toBe(3);
    // 被淘汰的老 owner 计数归零（其超限不再被单独记住），但全局计数仍完整。
    expect(quotaState("o1").ownerUsed).toBe(0);
    expect(quotaState("o5").ownerUsed).toBe(10);
    expect(quotaState().used).toBe(50);
  });
});
