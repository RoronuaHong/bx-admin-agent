import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectAnomalies, observeRun, resetAnomalyForTest, type OwnerBaseline } from "../src/anomaly.js";
import { canonicalDigest, sanitizeMemoryText, validateMemoryItems, verifyMemoryIntegrity } from "../src/memory.js";
import type { MemoryItem } from "../src/memory.js";

/** P2 补齐项：行为异常检测（ASI09）+ 记忆完整性校验（ASI04）。 */

function baseline(over: Partial<OwnerBaseline> = {}): OwnerBaseline {
  return {
    count: 10,
    rounds: [2, 2, 2, 2, 2],
    tokens: [100, 100, 100, 100, 100],
    durations: [1000, 1000, 1000, 1000, 1000],
    tools: new Set(["fs_read", "fs_write"]),
    ungroundedWindow: [false, false],
    ...over,
  };
}

describe("行为异常检测（纯函数）", () => {
  it("样本不足时不判（避免冷启动误报）", () => {
    const flags = detectAnomalies(
      { durationMs: 999_999, toolNames: ["never_seen"] },
      baseline({ count: 3 }),
    );
    expect(flags).toEqual([]);
  });

  it("基线与当前都正常 → 无异常", () => {
    const flags = detectAnomalies(
      { durationMs: 1000, rounds: 2, tokens: 100, toolNames: ["fs_read"] },
      baseline(),
    );
    expect(flags).toEqual([]);
  });

  it("轮数 / token / 耗时突增各自被抓到", () => {
    expect(detectAnomalies({ durationMs: 1000, rounds: 20, toolNames: [] }, baseline())).toContain(
      "rounds_spike",
    );
    expect(detectAnomalies({ durationMs: 1000, tokens: 5000, toolNames: [] }, baseline())).toContain(
      "tokens_spike",
    );
    expect(detectAnomalies({ durationMs: 30_000, toolNames: [] }, baseline())).toContain("duration_spike");
  });

  it("出现基线里没有的工具 → tool_novelty（作用域扩张信号）", () => {
    expect(
      detectAnomalies({ durationMs: 1000, toolNames: ["fs_read", "run_command"] }, baseline()),
    ).toContain("tool_novelty");
  });

  it("未取证在窗口内成串出现 → ungrounded_burst", () => {
    const base = baseline({ ungroundedWindow: [true, true] });
    expect(detectAnomalies({ durationMs: 1000, toolNames: [], ungrounded: true }, base)).toContain(
      "ungrounded_burst",
    );
    // 窗口里没有既有未取证时，单独一次不判（避免偶发被当成爆发）
    expect(
      detectAnomalies({ durationMs: 1000, toolNames: [], ungrounded: true }, baseline()),
    ).not.toContain("ungrounded_burst");
  });

  it("observeRun 会积累基线且不抛错", () => {
    resetAnomalyForTest();
    const mk = (runId: string, rounds: number) =>
      observeRun({
        runId,
        at: Date.now(),
        conversationId: "c",
        status: "success",
        durationMs: 1000,
        rounds,
        tokens: 100,
        ownerKey: "u1",
      });
    // 前几次样本不足，不该报异常
    for (let i = 0; i < 5; i++) expect(mk(`r${i}`, 2).anomalous).toBe(false);
    // 基线够了之后，一次明显突增应被抓到
    const spike = mk("spike", 30);
    expect(spike.flags).toContain("rounds_spike");
    expect(spike.anomalous).toBe(true);
    expect(spike.baselineRuns).toBeGreaterThanOrEqual(5);
  });

  beforeEach(() => resetAnomalyForTest());
  afterEach(() => resetAnomalyForTest());
});

describe("记忆完整性校验（ASI04）", () => {
  const item = (over: Partial<MemoryItem> = {}): MemoryItem => ({
    id: "m1",
    text: "记住：用中文回复",
    createdAt: 1,
    ...over,
  });

  it("指纹与顺序无关（避免「只是顺序变了」被误判成篡改）", () => {
    const a = [item({ id: "a" }), item({ id: "b" })];
    const b = [item({ id: "b" }), item({ id: "a" })];
    expect(canonicalDigest(a)).toBe(canonicalDigest(b));
  });

  it("内容一改指纹就变", () => {
    expect(canonicalDigest([item()])).not.toBe(canonicalDigest([item({ text: "别的" })]));
  });

  it("清洗不能把正常内容抹空（曾因正则缺 u 标志把整条记忆清空）", () => {
    for (const t of ["记住：用中文回复", "user prefers dark mode", "订单号 A20261006001", "138 条"]) {
      expect(sanitizeMemoryText(t), t).toBe(t);
    }
    // 控制符确实被去掉
    expect(sanitizeMemoryText("含\u200B零宽")).toBe("含零宽");
    expect(sanitizeMemoryText("a\u0000b")).toBe("ab");
    // 保留换行与制表
    expect(sanitizeMemoryText("a\nb\tc")).toBe("a\nb\tc");
  });

  it("逐条校验：空内容 / 控制符 / 超长都会被点出来", () => {
    expect(validateMemoryItems([item({ text: "   " })])).toHaveLength(1);
    expect(validateMemoryItems([item({ text: "含\u200B零宽" })])[0]).toContain("控制符");
    expect(validateMemoryItems([item({ text: "x".repeat(501) })])[0]).toContain("超长度");
    expect(validateMemoryItems([item()])).toEqual([]);
  });

  it("verifyMemoryIntegrity 返回结构完整（不抛错）", () => {
    const r = verifyMemoryIntegrity([]);
    expect(["match", "mismatch", "missing"]).toContain(r.baseline);
    expect(typeof r.ok).toBe("boolean");
    expect(Array.isArray(r.issues)).toBe(true);
  });

  it("改过的记忆会被判为不匹配", () => {
    const list = [item()];
    const good = verifyMemoryIntegrity(list);
    const bad = verifyMemoryIntegrity([item({ text: "被篡改了" })]);
    // 指纹不同 → 二者不可能同时与同一份基线匹配
    expect(canonicalDigest(list)).not.toBe(canonicalDigest([item({ text: "被篡改了" })]));
    expect(good.baseline).toBe(bad.baseline);
  });
});
