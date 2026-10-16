import { describe, expect, it } from "vitest";
import {
  buildNumericHint,
  extractTotalClaims,
  verifyNumericConsistency,
} from "../src/numeric-verify.js";

describe("extractTotalClaims", () => {
  it("抽取「共 N 条」式声明", () => {
    const claims = extractTotalClaims("本次共 128 条记录，已处理完毕");
    expect(claims).toHaveLength(1);
    expect(claims[0].value).toBe(128);
    expect(claims[0].unit).toBe("条");
  });

  it("抽取「合计: N 个」并去逗号", () => {
    const claims = extractTotalClaims("合计: 1,200 个");
    expect(claims[0].value).toBe(1200);
    expect(claims[0].unit).toBe("个");
  });

  it("无总数声明时返回空", () => {
    expect(extractTotalClaims("这是一段没有数字结论的话")).toHaveLength(0);
  });
});

describe("verifyNumericConsistency - L1 跨源总数", () => {
  it("工具总数与回答总数不一致 → 报不一致", () => {
    const out = verifyNumericConsistency({
      evidence: "【来源 x】\n共 30 条\n| a | b |\n|---|---|\n| 1 | 2 |",
      answer: "共 12 条，华东占多数。",
    });
    expect(out.some((m) => m.includes("30") && m.includes("12"))).toBe(true);
  });

  it("工具总数与回答总数一致 → 不报", () => {
    const out = verifyNumericConsistency({
      evidence: "共 30 条",
      answer: "共 30 条，华东占多数。",
    });
    expect(out).toHaveLength(0);
  });

  it("工具未声明总数时跳过（避免分页误报）", () => {
    const out = verifyNumericConsistency({
      evidence: "| a | b |\n|---|---|\n| 1 | 2 |",
      answer: "共 12 条",
    });
    expect(out).toHaveLength(0);
  });

  it("单位不同不误伤", () => {
    const out = verifyNumericConsistency({
      evidence: "共 30 个",
      answer: "共 30 条",
    });
    expect(out).toHaveLength(0);
  });
});

describe("verifyNumericConsistency - L2 自洽求和", () => {
  it("分项求和等于合计 → 不报", () => {
    const out = verifyNumericConsistency({
      evidence: "",
      answer: "华东: 420\n华北: 310\n华南: 280\n其它: 190\n合计: 1200",
    });
    expect(out).toHaveLength(0);
  });

  it("分项求和不等于合计 → 报不一致", () => {
    const out = verifyNumericConsistency({
      evidence: "",
      answer: "华东: 420\n华北: 310\n华南: 280\n合计: 800",
    });
    // 420+310+280 = 1010 ≠ 800
    expect(out.some((m) => m.includes("1010") && m.includes("800"))).toBe(true);
  });

  it("无合计声明时跳过", () => {
    const out = verifyNumericConsistency({
      evidence: "",
      answer: "华东: 420\n华北: 310",
    });
    expect(out).toHaveLength(0);
  });
});

describe("buildNumericHint", () => {
  it("包裹数据块并带首尾提示", () => {
    const hint = buildNumericHint("- 测试条目");
    expect(hint).toContain("数值校验发现");
    expect(hint).toContain("- 测试条目");
    expect(hint).toContain("不要复述本提示");
  });
});
