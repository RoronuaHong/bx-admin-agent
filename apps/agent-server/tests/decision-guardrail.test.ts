import { describe, it, expect } from "vitest";
import {
  DECISION_GUARDRAIL_MIN_DEFINITIONS,
  shouldInjectDecisionHint,
  buildDecisionHint,
} from "../src/decision-guardrail.ts";

describe("[P] 决策点护栏：阈值判定", () => {
  it("定义读取不足阈值（<2）不回灌，即使零执行", () => {
    expect(shouldInjectDecisionHint(0, 0)).toBe(false);
    expect(shouldInjectDecisionHint(1, 0)).toBe(false);
  });

  it("定义读取达阈值但已有执行：不回灌（已正常取数）", () => {
    expect(shouldInjectDecisionHint(2, 1)).toBe(false);
    expect(shouldInjectDecisionHint(5, 3)).toBe(false);
  });

  it("定义读取达阈值且零执行：回灌", () => {
    expect(shouldInjectDecisionHint(2, 0)).toBe(true);
    expect(shouldInjectDecisionHint(7, 0)).toBe(true);
  });

  it("非有限数防御（NaN/Infinity/负数）不回灌", () => {
    expect(shouldInjectDecisionHint(NaN, 0)).toBe(false);
    expect(shouldInjectDecisionHint(Infinity, 0)).toBe(false);
    expect(shouldInjectDecisionHint(-1, 0)).toBe(false);
    expect(shouldInjectDecisionHint(3, NaN)).toBe(false);
  });
});

describe("[P] 决策点护栏：提示文案", () => {
  it("文案含读取计数、零业务词、且提示直接取数", () => {
    const hint = buildDecisionHint(3);
    expect(hint).toContain("3");
    expect(hint).toContain("还没有执行任何取数");
    expect(hint).toContain("直接写 SQL");
  });

  it("计数被规整为非负整数", () => {
    expect(buildDecisionHint(2.9)).toContain("2");
    expect(buildDecisionHint(0)).toContain("0");
  });

  it("常量阈值与判定口径一致", () => {
    expect(DECISION_GUARDRAIL_MIN_DEFINITIONS).toBe(2);
  });
});
