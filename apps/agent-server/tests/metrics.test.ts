// Prometheus 指标导出（src/metrics.ts）：纯文本格式 + 只读聚合。
// 断言重点：①输出能被 Prometheus 解析（HELP/TYPE 成对、指标名合法、值可解析）；
// ②标签值转义（枚举之外的脏值不能破坏文本结构）；③聚合口径（分位数/平均/护栏计数）。
import { test, expect } from "vitest";
import { buildMetrics } from "../src/metrics.js";
import type { RunTrace } from "../src/trace.js";
import type { AuditEvent } from "../src/audit.js";

function run(patch: Partial<RunTrace> = {}): RunTrace {
  return {
    runId: "r1",
    at: 1_700_000_000_000,
    conversationId: "c1",
    status: "success",
    durationMs: 1000,
    rounds: 2,
    toolCalls: 3,
    tokens: 100,
    ...patch,
  };
}

/** 逐行解析成 name -> [{labels, value}]，顺带校验 Prometheus 的基本结构。 */
function parse(text: string) {
  const lines = text.split("\n").filter((l) => l.trim());
  const seenHelp = new Set<string>();
  const samples: Array<{ name: string; labels: Record<string, string>; value: number }> = [];
  let pending: string | null = null;
  for (const line of lines) {
    if (line.startsWith("# HELP ")) {
      const name = line.slice(7).split(" ")[0]!;
      seenHelp.add(name);
      pending = name;
      continue;
    }
    if (line.startsWith("# TYPE ")) {
      const name = line.slice(7).split(" ")[0]!;
      expect(seenHelp.has(name), `TYPE 之前必须有同名的 HELP：${name}`).toBe(true);
      expect(["counter", "gauge", "histogram", "summary"]).toContain(line.slice(7).split(" ")[1]);
      continue;
    }
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(.+)$/);
    expect(m, `不是合法的指标行：${line}`).toBeTruthy();
    const labels: Record<string, string> = {};
    for (const pair of (m![2] || "").split(",")) {
      if (!pair.trim()) continue;
      const kv = pair.match(/^([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"$/);
      expect(kv, `标签格式非法：${pair}`).toBeTruthy();
      labels[kv![1]!] = kv![2]!;
    }
    expect(Number.isFinite(Number(m![3])), `值必须是数字：${line}`).toBe(true);
    samples.push({ name: m![1]!, labels, value: Number(m![3]) });
    if (pending) pending = null;
  }
  return samples;
}

test("输出是合法的 Prometheus 文本：HELP/TYPE 成对、指标名与值可解析", () => {
  const text = buildMetrics({ runs: [run(), run({ runId: "r2", status: "failed" })], now: 123 });
  const samples = parse(text);
  expect(samples.length).toBeGreaterThan(0);
  expect(text.endsWith("\n")).toBe(true);
  const total = samples.filter((s) => s.name === "bx_agent_runs_total");
  expect(total.find((s) => s.labels.status === "success")?.value).toBe(1);
  expect(total.find((s) => s.labels.status === "failed")?.value).toBe(1);
  // 构建信息一条，值为 1。
  const info = samples.find((s) => s.name === "bx_agent_build_info");
  expect(info?.value).toBe(1);
  expect(info?.labels.release).toBeTruthy();
});

test("聚合口径：token / 工具调用求和，轮次取平均，耗时给 avg/p50/p95/max", () => {
  const samples = parse(
    buildMetrics({
      runs: [
        run({ durationMs: 1000, rounds: 2, tokens: 100, toolCalls: 3 }),
        run({ runId: "r2", durationMs: 3000, rounds: 4, tokens: 300, toolCalls: 1 }),
      ],
      now: 1,
    }),
  );
  const one = (name: string, labels: Record<string, string> = {}) =>
    samples.find((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v))?.value;

  expect(one("bx_agent_tokens_total")).toBe(400);
  expect(one("bx_agent_tool_calls_total")).toBe(4);
  expect(one("bx_agent_rounds_avg")).toBe(3); // (2+4)/2
  expect(one("bx_agent_run_duration_ms", { quantile: "avg" })).toBe(2000);
  expect(one("bx_agent_run_duration_ms", { quantile: "max" })).toBe(3000);
  // 两个数时 p50/p95 都取上界（最接近秩法，ceil 后不插值）。
  expect(one("bx_agent_run_duration_ms", { quantile: "p50" })).toBe(1000);
  expect(one("bx_agent_run_duration_ms", { quantile: "p95" })).toBe(3000);
});

test("护栏与韧性信号单独成指标（退化比成功率更早变红）", () => {
  const samples = parse(
    buildMetrics({
      runs: [
        run({ modelFallbacks: 2, groundingRetries: 1, groundingVerifications: 3 }),
        run({ runId: "r2", ungrounded: true }),
      ],
      now: 1,
    }),
  );
  const one = (name: string) => samples.find((s) => s.name === name)?.value;
  expect(one("bx_agent_model_fallbacks_total")).toBe(2);
  expect(one("bx_agent_grounding_retries_total")).toBe(1);
  expect(one("bx_agent_grounding_verifications_total")).toBe(3);
  expect(one("bx_agent_ungrounded_runs_total")).toBe(1);
});

test("审计事件按决策计数，且标签值被转义（脏值不破坏文本结构）", () => {
  const audit = [
    { at: 1, kind: "gate", decision: "denied", tool: "x" },
    { at: 2, kind: "gate", decision: "denied", tool: "x" },
    { at: 3, kind: "gate", decision: 'we"ird\nvalue', tool: "x" },
  ] as unknown as AuditEvent[];
  const text = buildMetrics({ runs: [], audit, now: 1 });
  const samples = parse(text); // 解析本身即断言：转义后仍每行合法
  const denied = samples.find((s) => s.name === "bx_agent_audit_events_total" && s.labels.decision === "denied");
  expect(denied?.value).toBe(2);
  // 含引号/换行的标签值被转义成字面量，不会把一行劈成两行。
  const weird = samples.find((s) => s.name === "bx_agent_audit_events_total" && s.labels.decision?.includes("we"));
  expect(weird?.labels.decision).toBe('we\\"ird\\nvalue');
});

test("空输入也输出合法文本（抓取端不该收到空响应）", () => {
  const text = buildMetrics({ runs: [], audit: [], now: 7 });
  const samples = parse(text);
  expect(samples.find((s) => s.name === "bx_agent_scrape_at_ms")?.value).toBe(7);
  expect(samples.find((s) => s.name === "bx_agent_runs_total")).toBeUndefined();
});
