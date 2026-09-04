/**
 * eval-core 单元闸门（通用、零外部依赖，CI 可跑）。
 *
 * 验证「红线断言逻辑本身」是否正确——这是评测的地基：
 * 如果 assertTraceGates 自己算错了，上层所有评测结论都不可信。
 *
 * 零依赖：只 import eval-core.mjs（纯函数），不碰 .env / 业务源码 /
 * 网络 / 数据库，任何环境都能跑（含 CI runner）。
 *
 * 运行：tsx scripts/eval-core.test.ts
 */
import { assertTraceGates, summarize } from "./eval-core.mjs";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function assert(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} | [core] ${name}${detail ? ` | ${detail}` : ""}`);
}

// ---- 基线 fixtures ----
const baseSpans = [
  { kind: "run", name: "chat.run", endMs: 1700000000000, durationMs: 1000, model: "m" },
  { kind: "llm", name: "m", usage: { totalTokens: 1000 } },
  { kind: "llm", name: "m", usage: { totalTokens: 2000 } },
  { kind: "tool", name: "call_api", status: "ok" },
];

// ---- G5 请求收束 ----
assert(
  "G5 有 run span → pass",
  assertTraceGates({ spans: baseSpans }).find((r) => r.name === "G5_run_completed")!.ok,
);
assert(
  "G5 缺 run span → fail",
  !assertTraceGates({ spans: baseSpans.filter((s) => s.kind !== "run") })
    .find((r) => r.name === "G5_run_completed")!.ok,
);

// ---- G1 轮次 ----
assert(
  "G1 轮次≤阈值 → pass",
  assertTraceGates({ spans: baseSpans, maxLlmRounds: 8 }).find((r) => r.name === "G1_llm_rounds_le")!.ok,
);
assert(
  "G1 轮次超阈值 → fail",
  !assertTraceGates({ spans: baseSpans, maxLlmRounds: 1 }).find((r) => r.name === "G1_llm_rounds_le")!.ok,
);

// ---- G2 越权三态 ----
const withReject = [
  ...baseSpans,
  { kind: "tool", name: "call_api", status: "reject", note: "violation", worker: "w" },
];
assert(
  "G2 observe 无 reject → N/A pass",
  assertTraceGates({ spans: baseSpans, rejectMode: "observe" }).find((r) => r.name === "G2_reject(N/A)")!.ok,
);
assert(
  "G2 observe 有 reject 结构对 → pass",
  assertTraceGates({ spans: withReject, rejectMode: "observe" }).find((r) => r.name === "G2_reject_observed")!.ok,
);
assert(
  "G2 enforce 无 reject → fail",
  !assertTraceGates({ spans: baseSpans, rejectMode: "enforce" }).find((r) => r.name === "G2_reject_enforced")!.ok,
);
assert(
  "G2 enforce 有 reject → pass",
  assertTraceGates({ spans: withReject, rejectMode: "enforce" }).find((r) => r.name === "G2_reject_enforced")!.ok,
);
assert(
  "G2 off → 不产出 G2",
  !assertTraceGates({ spans: baseSpans, rejectMode: "off" }).some((r) => r.name.startsWith("G2")),
);
assert(
  "G2 reject 缺 note → fail",
  !assertTraceGates({
    spans: [...baseSpans, { kind: "tool", name: "call_api", status: "reject", worker: "w" }],
    rejectMode: "enforce",
  }).find((r) => r.name === "G2_reject_enforced")!.ok,
);

// ---- G3 伪调用（黑名单由调用方注入，core 不内置工具名）----
const PSEUDO = ["submit", "submit_understood_intent"];
assert(
  "G3 无伪调用 → pass",
  assertTraceGates({ spans: baseSpans, pseudoToolNames: PSEUDO }).find((r) => r.name === "G3_no_pseudo_tool")!.ok,
);
assert(
  "G3 出现黑名单伪调用 → fail",
  !assertTraceGates({ spans: [...baseSpans, { kind: "tool", name: "submit", status: "ok" }], pseudoToolNames: PSEUDO })
    .find((r) => r.name === "G3_no_pseudo_tool")!.ok,
);
assert(
  "G3 黑名单为空 → 不检测，恒 pass（保持通用，不内置工具名）",
  assertTraceGates({ spans: [...baseSpans, { kind: "tool", name: "submit", status: "ok" }] })
    .find((r) => r.name === "G3_no_pseudo_tool")!.ok,
);

// ---- G4 成本 ----
assert(
  "G4 预算内 → pass",
  assertTraceGates({ spans: baseSpans, maxTotalTokens: 60000 }).find((r) => r.name === "G4_token_budget_le")!.ok,
);
assert(
  "G4 超预算 → fail",
  !assertTraceGates({ spans: baseSpans, maxTotalTokens: 1000 }).find((r) => r.name === "G4_token_budget_le")!.ok,
);
assert(
  "G4 usage 缺失按 0 计 → pass",
  assertTraceGates({
    spans: [{ kind: "run", endMs: 1 }, { kind: "llm" }],
    maxTotalTokens: 10,
  }).find((r) => r.name === "G4_token_budget_le")!.ok,
);

// ---- G6 业务期望（防短路/幻觉直答不调工具却正常收束）----
const noToolSpans = [
  { kind: "run", name: "chat.run", endMs: 1700000000000, durationMs: 900, model: "m" },
  { kind: "llm", name: "m", usage: { totalTokens: 100 } },
];
assert(
  "G6 期望工具已调用 → pass",
  assertTraceGates({ spans: baseSpans, expectTools: ["call_api"] }).find((r) => r.name === "G6_expect_tool_called")!.ok,
);
assert(
  "G6 短路收束（无任何 tool span）→ fail",
  !assertTraceGates({ spans: noToolSpans, expectTools: ["call_api"] }).find((r) => r.name === "G6_expect_tool_called")!.ok,
);
assert(
  "G6 期望列表任一命中 → pass",
  assertTraceGates({ spans: baseSpans, expectTools: ["tool_a", "call_api"] }).find((r) => r.name === "G6_expect_tool_called")!.ok,
);
assert(
  "G6 期望全未命中 → fail",
  !assertTraceGates({ spans: baseSpans, expectTools: ["tool_a", "tool_b"] }).find((r) => r.name === "G6_expect_tool_called")!.ok,
);
assert(
  "G6 无期望（空数组）→ 不产出 G6（默认关）",
  !assertTraceGates({ spans: noToolSpans }).some((r) => r.name === "G6_expect_tool_called"),
);

// ---- summarize ----
const allPass = assertTraceGates({ spans: baseSpans });
const s = summarize(allPass);
assert("summarize pass/total 正确", s.pass === s.total && s.failed.length === 0, `${s.pass}/${s.total}`);
const mixed = summarize([
  { name: "a", ok: true, detail: "" },
  { name: "b", ok: false, detail: "" },
]);
assert("summarize 统计混合结果", mixed.pass === 1 && mixed.total === 2 && mixed.rate === 50 && mixed.failed.length === 1);

// ---- 汇总 ----
const passed = results.filter((r) => r.ok).length;
console.log(`\n========== eval-core 单元闸门 ==========`);
console.log(`TOTAL: ${passed}/${results.length} (${((passed / results.length) * 100).toFixed(1)}%)`);
if (passed < results.length) {
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}`);
  process.exit(1);
}
