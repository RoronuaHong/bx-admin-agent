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
