// 工具失败分类 + 窗口熔断（第 2 批 P1-1 地基 / P2-1）。
//
// 事故形态（2026-10-14）：同一外部查询工具 10 次调用失败 6 次，失败序列是
// err,ok,ok,err,ok,ok,err,err,ok,err —— 交替失败。旧判据「连续失败计数 + 成功即清零」
// 在这个序列下一次都没触发（每次成功都把计数清零），于是 6 次失败全部白打。
//
// 三条回归主线：
//   ① 分类：闸门拒绝 / 参数错误 / 被中止 **不得** 计入熔断（Fowler：客户端参数错误不应触发熔断；
//      我们的闸门拒绝是策略正常工作，熔断它等于自伤）。
//   ② 窗口比率 + 最小样本数：交替失败也必须熔断，且成功一次不得把历史失败洗白。
//   ③ 字段名钉死 OTel 语义约定的 error.type（不漂移成自创字段名，也不把消息文本塞进去）。
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyToolFailure, FUSING_KINDS, KIND_LABEL, ToolHealthWindow } from "../src/tool-failure.js";

test("分类：结构优先于文本——没进上游不是上游的问题", () => {
  expect(classifyToolFailure({ executed: false, ok: false, text: "anything" })).toBe("denied");
  expect(classifyToolFailure({ executed: true, ok: true, text: "成功" })).toBeNull();
  // 即使文本像上游错误，没执行就不是上游问题
  expect(classifyToolFailure({ executed: false, ok: false, text: "fetch failed ECONNRESET" })).toBe("denied");
  // 中止优先于文本
  expect(classifyToolFailure({ executed: true, ok: false, text: "fetch failed", aborted: true })).toBe("aborted");
});

test("分类：超时 / 上游 / 参数语义 / 闸门拒绝 各归各类", () => {
  expect(classifyToolFailure({ executed: true, ok: false, text: "请求超时（30000ms）" })).toBe("timeout");
  expect(classifyToolFailure({ executed: true, ok: false, text: "ECONNRESET while reading socket" })).toBe("upstream");
  expect(classifyToolFailure({ executed: true, ok: false, text: "[502] upstream exploded" })).toBe("upstream");
  expect(classifyToolFailure({ executed: true, ok: false, text: "unknown column foo" })).toBe("schema");
  expect(classifyToolFailure({ executed: true, ok: false, text: "该工具为原生 SQL 工具，按只读策略拒绝执行" })).toBe("denied");
  expect(classifyToolFailure({ executed: true, ok: false, text: "完全没见过的失败形态" })).toBe("other");
});

test("只有依赖侧两类计入熔断（其余不计入）", () => {
  expect([...FUSING_KINDS].sort()).toEqual(["timeout", "upstream"]);
  for (const kind of ["denied", "schema", "aborted", "other"] as const) {
    expect(FUSING_KINDS.has(kind), `${kind} 不该计入熔断`).toBe(false);
  }
});

test("事故序列：交替失败必须熔断（旧判据在这里永不触发）", () => {
  const w = new ToolHealthWindow({ window: 6, minSamples: 3, failRate: 0.5, consecutive: 3 });
  // timeout,ok,timeout,ok,timeout,ok = 6 次里 3 次依赖侧失败（50%），成功从未能「洗白」历史。
  for (const kind of ["timeout", null, "timeout", null, "timeout", null] as const) w.record("t", kind);
  const v = w.fuseVerdict("t");
  expect(v.fuse, "交替失败 3/6 应达 50% 阈值").toBe(true);
  expect(v.reason).toContain("t");
});

test("成功一次不得把历史失败洗白（旧实现的 bug）", () => {
  const w = new ToolHealthWindow({ window: 6, minSamples: 3, failRate: 0.5, consecutive: 3 });
  w.record("t", "timeout");
  w.record("t", "timeout");
  w.record("t", null); // 一次成功：清零旧实现在这里会把统计清空
  const s = w.stats("t");
  expect(s.samples).toBe(3);
  expect(s.fusing).toBe(2);
  expect(s.consecutive).toBe(0);
  expect(w.fuseVerdict("t").fuse).toBe(true);
});

test("样本不足不算比率（Fowler：比率必须配最小样本数）", () => {
  const w = new ToolHealthWindow({ window: 6, minSamples: 3, failRate: 0.5, consecutive: 3 });
  w.record("t", "timeout"); // 1 次失败 0 次成功 = 100%，但样本不足
  expect(w.fuseVerdict("t").fuse).toBe(false);
  w.record("t", null); // 2/2 = 100%，仍不足
  expect(w.fuseVerdict("t").fuse).toBe(false);
});

test("非依赖侧事件既不进分母也不断连续（不稀释真实故障率）", () => {
  const w = new ToolHealthWindow({ window: 6, minSamples: 3, failRate: 0.5, consecutive: 3 });
  w.record("t", "timeout");
  w.record("t", "schema"); // 不计入
  w.record("t", "denied"); // 不计入
  const s = w.stats("t");
  expect(s.samples, "只有 timeout 这一次进窗口").toBe(1);
  expect(s.fusing).toBe(1);
  expect(s.consecutive, "非依赖侧事件把连续计数断开").toBe(0);
  expect(w.fuseVerdict("t").fuse, "样本不足不得熔断").toBe(false);
});

test("连续依赖侧失败走快路径（完全挂掉，不必等比率）", () => {
  const w = new ToolHealthWindow({ window: 6, minSamples: 3, failRate: 0.9, consecutive: 3 });
  w.record("t", "upstream");
  w.record("t", "upstream");
  expect(w.fuseVerdict("t").fuse).toBe(false);
  w.record("t", "upstream");
  const v = w.fuseVerdict("t");
  expect(v.fuse).toBe(true);
  expect(v.reason).toContain("连续");
});

test("全成功不熔断；clear 能显式解除", () => {
  const w = new ToolHealthWindow();
  for (let i = 0; i < 10; i += 1) w.record("t", null);
  expect(w.fuseVerdict("t").fuse).toBe(false);
  w.record("t", "timeout");
  w.record("t", "timeout");
  w.record("t", "timeout");
  expect(w.fuseVerdict("t").fuse).toBe(true);
  w.clear("t");
  expect(w.fuseVerdict("t").fuse).toBe(false);
});

test("lastKind 供熔断提示写人话说明", () => {
  const w = new ToolHealthWindow();
  expect(w.lastKind("t")).toBeNull();
  w.record("t", null);
  expect(w.lastKind("t")).toBeNull();
  w.record("t", "timeout");
  expect(w.lastKind("t")).toBe("timeout");
  expect(KIND_LABEL.timeout).toBe("超时");
});

test("P2-1：span 失败分类字段名钉死 OTel 语义约定，不许漂移成自创字段", () => {
  const chat = readFileSync(fileURLToPath(new URL("../src/chat.ts", import.meta.url)), "utf8");
  // 官方字段名（高基数消息文本只能进 description，不能进 type）
  expect(chat).toContain('"error.type"');
  expect(chat).toContain('"error.description"');
  // 旧的错误文本截断仍作为 span.error 保留（向后兼容），但分类必须是新字段
  expect(chat).not.toMatch(/errorKind:\s*rawText/);
  // 并发批必须也有 span：本次事故 53 次调用只有 17 条 span，缺口就在批量路径
  expect(chat).toContain('"gen_ai.tool.concurrent": true');
});

