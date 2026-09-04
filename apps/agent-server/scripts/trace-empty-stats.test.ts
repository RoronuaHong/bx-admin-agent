/**
 * trace 空轮劣化信号单元闸门（零外部依赖）。
 * 运行：tsx scripts/trace-empty-stats.test.ts
 */
import {
  isEmptyLlmSpan,
  countEmptySignals,
  emptyRoundRateWarnThreshold,
} from "../src/trace.ts";

const results: Array<{ name: string; ok: boolean }> = [];
function assert(name: string, ok: boolean) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} | [trace-empty] ${name}`);
}

assert("tok=0 → empty", isEmptyLlmSpan({ kind: "llm", usage: { totalTokens: 0 } }));
assert("usage 缺失 → empty", isEmptyLlmSpan({ kind: "llm" }));
assert("有 token → 非 empty", !isEmptyLlmSpan({ kind: "llm", usage: { totalTokens: 100 } }));
assert("非 llm → 非 empty", !isEmptyLlmSpan({ kind: "tool", usage: undefined }));

const mixed = [
  { kind: "llm" as const, usage: { totalTokens: 0 } },
  { kind: "llm" as const, usage: { totalTokens: 12000 }, note: "recovered_from_empty", meta: { emptyRetries: 2 } },
  { kind: "llm" as const, usage: { totalTokens: 8000 } },
];
const c = countEmptySignals(mixed);
assert("emptyRounds=1", c.emptyRounds === 1);
assert("emptyRetries=2", c.emptyRetries === 2);

const rate = (c.emptyRounds + c.emptyRetries) / (mixed.length + c.emptyRetries);
assert("rate=0.6 (3/5)", Math.abs(rate - 0.6) < 1e-9);

const prev = process.env.TRACE_EMPTY_ROUND_RATE_WARN;
process.env.TRACE_EMPTY_ROUND_RATE_WARN = "0.15";
assert("warn threshold env=0.15", emptyRoundRateWarnThreshold() === 0.15);
if (prev === undefined) delete process.env.TRACE_EMPTY_ROUND_RATE_WARN;
else process.env.TRACE_EMPTY_ROUND_RATE_WARN = prev;
assert("warn threshold 默认 0.2", emptyRoundRateWarnThreshold() === 0.2);

const pass = results.filter((r) => r.ok).length;
console.log(`\n========== trace-empty-stats ==========\nTOTAL: ${pass}/${results.length}`);
process.exit(pass === results.length ? 0 : 1);
