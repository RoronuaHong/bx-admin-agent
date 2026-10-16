import { afterEach, describe, expect, it } from "vitest";
import { scoreRunTrace, summarizeEval, type RunEvalScore } from "../src/eval-online.js";
import type { RunTrace } from "../src/trace.js";

/**
 * 在线评测闭环（P1）回归：纯确定性打分，不调模型。
 * 只测纯函数与只读聚合——`recordRunEval` 会写 .data/eval，不在单测里调用（避免污染真实数据）。
 */
function base(over: Partial<RunTrace> = {}): RunTrace {
  return {
    runId: "run_test",
    at: Date.now(),
    conversationId: "conv_test",
    status: "success",
    durationMs: 1000,
    rounds: 2,
    toolCalls: 1,
    tokens: 100,
    modelFallbacks: 0,
    modelRetries: 0,
    groundingRetries: 0,
    ...over,
  };
}

describe("在线评测：纯确定性打分", () => {
  it("全部达标 → good，满分", () => {
    const s = scoreRunTrace(base());
    expect(s.verdict).toBe("good");
    expect(s.score).toBe(1);
    expect(s.failed).toEqual([]);
  });

  it("一项不达标 → degraded；两项以上 → poor", () => {
    const oneBad = scoreRunTrace(base({ rounds: 99 }));
    expect(oneBad.verdict).toBe("degraded");

    const twoBad = scoreRunTrace(base({ rounds: 99, tokens: 999_999 }));
    expect(twoBad.verdict).toBe("poor");
    expect(twoBad.failed.slice().sort()).toEqual(["rounds", "tokens"]);
  });

  it("未取证（ungrounded）单独即算 degraded：模型有编造倾向", () => {
    const s = scoreRunTrace(base({ ungrounded: true }));
    expect(s.failed).toContain("grounded");
    expect(s.verdict).toBe("degraded");
  });

  it("未收束（failed / cancelled）计入未达标", () => {
    expect(scoreRunTrace(base({ status: "failed" })).failed).toContain("converged");
    expect(scoreRunTrace(base({ status: "cancelled" })).failed).toContain("converged");
  });

  it("缺字段的维度不计入分母（不会因为没数据就判差）", () => {
    const sparse = scoreRunTrace({
      runId: "r",
      at: 1,
      conversationId: "c",
      status: "success",
      durationMs: 10,
    });
    // 只有 converged / grounded / latency 三项参与
    expect(sparse.verdict).toBe("good");
    expect(sparse.score).toBe(1);
    expect(sparse.failed).toEqual([]);
  });

  it("阈值走环境变量，可收紧", () => {
    const saved = process.env.EVAL_MAX_ROUNDS;
    process.env.EVAL_MAX_ROUNDS = "1";
    expect(scoreRunTrace(base({ rounds: 2 })).failed).toContain("rounds");
    if (saved === undefined) delete process.env.EVAL_MAX_ROUNDS;
    else process.env.EVAL_MAX_ROUNDS = saved;
  });

  afterEach(() => {
    delete process.env.EVAL_MAX_ROUNDS;
  });
});

describe("在线评测：只读聚合", () => {
  it("无数据时给出安全的零值（不编造、不报劣化）", () => {
    const s = summarizeEval({ ownerKey: "__nobody__", days: 1 });
    expect(s.runs).toBe(0);
    expect(s.avgScore).toBe(0);
    expect(s.qualityDegraded).toBe(false);
    expect(s.behaviorRuns).toBe(0);
    expect(s.good + s.degraded + s.poor).toBe(0);
  });

  it("聚合结构完整（维度计数按失败次数倒序）", () => {
    const s = summarizeEval({ ownerKey: "__nobody__", days: 7 });
    expect(Array.isArray(s.axisFailures)).toBe(true);
    expect(typeof s.qualityDegraded).toBe("boolean");
    // 维度计数是 {axis,count} 且倒序
    for (let i = 1; i < s.axisFailures.length; i++) {
      expect(s.axisFailures[i - 1]!.count).toBeGreaterThanOrEqual(s.axisFailures[i]!.count);
    }
  });

  it("评分结果可序列化（落盘 JSONL 的前提）", () => {
    const s: RunEvalScore = scoreRunTrace(base({ ungrounded: true }));
    expect(() => JSON.stringify(s)).not.toThrow();
    expect(JSON.parse(JSON.stringify(s)).runId).toBe("run_test");
  });
});

describe("在线评测：第 3 批 P2-2 四维韧性信号", () => {
  /** 2026-10-14 事故 run 的形态（计数取自复盘文档与逐轮 trace，零业务词）。 */
  const incident = (): RunTrace =>
    base({
      status: "failed",
      durationMs: 1_423_658,
      rounds: 28,
      toolCalls: 48,
      toolFailures: 10, // 外部 7 + 内置 3
      tokens: 210_000,
      modelFallbacks: 3,
      modelRetries: 6,
      synthesisRounds: 0, // 28 轮零综合轮
      toolRepeatMax: 24, // 单一元数据工具 24 次换参数探查
      stalled: true, // 看门狗 627s 静默后收口
    });

  it("事故轨迹回放 → poor，且 failed 含 tool_health / synthesis / stall（单测固定该判定）", () => {
    const s = scoreRunTrace(incident());
    expect(s.verdict).toBe("poor");
    expect(s.failed).toContain("tool_health");
    expect(s.failed).toContain("synthesis");
    expect(s.failed).toContain("stall");
    expect(s.failed).toContain("efficiency");
    expect(s.failed).toContain("converged");
  });

  it("健康运行：四维全部达标，不误伤", () => {
    const s = scoreRunTrace(base({ toolFailures: 0, synthesisRounds: 1, toolRepeatMax: 3, stalled: false }));
    expect(s.failed).not.toContain("tool_health");
    expect(s.failed).not.toContain("synthesis");
    expect(s.failed).not.toContain("stall");
    expect(s.failed).not.toContain("efficiency");
    expect(s.verdict).toBe("good");
  });

  it("缺字段的维度不计入分母（没埋点的运行不因新维度判差）", () => {
    const s = scoreRunTrace(base()); // 不带任何新字段
    expect(s.failed).not.toContain("tool_health");
    expect(s.failed).not.toContain("synthesis");
    expect(s.failed).not.toContain("stall");
    expect(s.failed).not.toContain("efficiency");
    expect(s.verdict).toBe("good");
  });

  it("零工具调用的运行不判 synthesis / tool_health / efficiency（这些维度只对用过工具的 run 有意义）", () => {
    const s = scoreRunTrace(base({ toolCalls: 0, synthesisRounds: 0, toolFailures: 0, toolRepeatMax: 0 }));
    expect(s.failed).not.toContain("synthesis");
    expect(s.failed).not.toContain("tool_health");
    expect(s.failed).not.toContain("efficiency");
  });

  it("tool_health 边界：默认 20% 失败率上限，恰好达标不判差", () => {
    expect(scoreRunTrace(base({ toolCalls: 5, toolFailures: 1, synthesisRounds: 1 })).failed).not.toContain(
      "tool_health",
    ); // 1/5 = 0.2 <= 0.2
    expect(scoreRunTrace(base({ toolCalls: 4, toolFailures: 1, synthesisRounds: 1 })).failed).toContain("tool_health"); // 0.25 > 0.2
  });

  it("stall 只在被看门狗收口时判不达标", () => {
    expect(scoreRunTrace(base({ stalled: false })).failed).not.toContain("stall");
    expect(scoreRunTrace(base({ stalled: true })).failed).toContain("stall");
  });

  it("阈值走环境变量：失败率上限与重复峰值上限都可调", () => {
    const savedRate = process.env.EVAL_MAX_TOOL_FAIL_RATE;
    const savedRepeat = process.env.EVAL_MAX_TOOL_REPEAT;
    process.env.EVAL_MAX_TOOL_FAIL_RATE = "0.5";
    process.env.EVAL_MAX_TOOL_REPEAT = "30";
    try {
      const s = scoreRunTrace(base({ toolCalls: 10, toolFailures: 4, synthesisRounds: 1, toolRepeatMax: 24 }));
      expect(s.failed).not.toContain("tool_health");
      expect(s.failed).not.toContain("efficiency");
    } finally {
      if (savedRate === undefined) delete process.env.EVAL_MAX_TOOL_FAIL_RATE;
      else process.env.EVAL_MAX_TOOL_FAIL_RATE = savedRate;
      if (savedRepeat === undefined) delete process.env.EVAL_MAX_TOOL_REPEAT;
      else process.env.EVAL_MAX_TOOL_REPEAT = savedRepeat;
    }
  });
});
