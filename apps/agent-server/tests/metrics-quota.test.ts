import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  counterValue,
  incCounter,
  observeSummary,
  renderPrometheus,
  resetMetricsForTest,
} from "../src/process-metrics.js";
import { addDailyTokens, quotaState, setDailyTokensForTest } from "../src/quota.js";

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
