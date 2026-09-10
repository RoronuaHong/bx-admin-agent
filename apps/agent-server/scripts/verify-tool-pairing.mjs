/**
 * tool_calls / toolResult 配对护栏 + 通用同轮去重单测
 * 运行：cd apps/agent-server && node --import tsx scripts/verify-tool-pairing.mjs
 */
import {
  rewriteLastToolCalls,
  padMissingToolResults,
  dedupeParallelToolCalls,
  deferSystemStepsPastToolResults,
  collectSuccessfulCallApiKeys,
  collectSuccessfulCallApiResults,
  callApiKey,
  formatDuplicateCallApiSkip,
  formatDuplicateCallApiReplay,
  toolCallSignature,
  stableStringify,
  shouldAbortToolCallStream,
  enforceToolCallContract,
} from "../src/tool-call-dedupe.ts";
import { SUBMIT_UNDERSTOOD_INTENT } from "../src/understood-intent.ts";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " | " + detail : ""}`);
  ok ? pass++ : fail++;
}

const steps = [
  {
    kind: "toolCalls",
    calls: [
      { id: "r1", name: "route_to_agent", input: { domain: "backend-api" } },
      { id: "s1", name: "search_api_module", input: { query: "x" } },
    ],
  },
];
rewriteLastToolCalls(steps, [{ id: "r1", name: "route_to_agent", input: { domain: "backend-api" } }]);
check("rewriteLastToolCalls 只留 route", steps[0].calls.length === 1 && steps[0].calls[0].id === "r1");

const orphan = [
  {
    kind: "toolCalls",
    calls: [
      { id: "a", name: "route_to_agent", input: {} },
      { id: "b", name: "search_api_module", input: {} },
    ],
  },
  { kind: "toolResult", toolCallId: "a", content: "ok" },
];
const added = padMissingToolResults(orphan);
check("padMissingToolResults 补 1 条", added === 1 && orphan.some((s) => s.kind === "toolResult" && s.toolCallId === "b"));
check("pad 后再 pad 为 0", padMissingToolResults(orphan) === 0);

const midSys = [
  {
    kind: "toolCalls",
    calls: [
      { id: "x", name: "submit_understood_intent", input: {} },
      { id: "y", name: "search_api_module", input: {} },
    ],
  },
  { kind: "toolResult", toolCallId: "x", content: "ok" },
  { kind: "system", text: "normalize" },
];
padMissingToolResults(midSys);
const yIdx = midSys.findIndex((s) => s.kind === "toolResult" && s.toolCallId === "y");
const sysIdx = midSys.findIndex((s) => s.kind === "system");
check("pad 插在 system 前", yIdx > 0 && yIdx < sysIdx);

const interleaved = [
  {
    kind: "toolCalls",
    calls: [
      { id: "a1", name: "submit_understood_intent", input: {} },
      { id: "a2", name: "search_api_module", input: {} },
    ],
  },
  { kind: "toolResult", toolCallId: "a1", content: "1" },
  { kind: "system", text: "between" },
  { kind: "toolResult", toolCallId: "a2", content: "2" },
];
deferSystemStepsPastToolResults(interleaved);
check(
  "defer system 到 tool 齐套后",
  interleaved.map((s) => s.kind).join(",") === "toolCalls,toolResult,toolResult,system",
);

const d = dedupeParallelToolCalls([
  { id: "1", name: SUBMIT_UNDERSTOOD_INTENT, input: { a: 1 } },
  { id: "2", name: SUBMIT_UNDERSTOOD_INTENT, input: { a: 2 } },
  { id: "3", name: "route_to_agent", input: { domain: "backend-api" } },
  { id: "4", name: "search_api_module", input: { query: "x" } },
  { id: "5", name: "search_api_module", input: { query: "x" } },
]);
check("dedupe submit 不论入参只留 1", d.kept.filter((c) => c.name === SUBMIT_UNDERSTOOD_INTENT).length === 1 && d.droppedSubmit === 1);
check("dedupe 任意工具同参折叠", d.kept.filter((c) => c.name === "search_api_module").length === 1 && d.dropped >= 2);
check(
  "stableStringify 键序无关",
  toolCallSignature({ id: "1", name: "call_api", input: { b: 1, a: 2 } }) ===
    toolCallSignature({ id: "2", name: "call_api", input: { a: 2, b: 1 } }),
);

const okSteps = [
  {
    kind: "toolCalls",
    calls: [{ id: "c1", name: "call_api", input: { operation: "actor.getList", params: { page: 1 } } }],
  },
  { kind: "toolResult", toolCallId: "c1", content: '{\n  "code": 0,\n  "data": {"ok":true}\n}' },
];
const keys = collectSuccessfulCallApiKeys(okSteps);
const results = collectSuccessfulCallApiResults(okSteps);
const sig = callApiKey({ id: "x", name: "call_api", input: { operation: "actor.getList", params: { page: 1 } } });
check("collectSuccessfulCallApiKeys 收录成功签名", keys.has(sig));
check("回放含上次结果", /"ok":true/.test(formatDuplicateCallApiReplay("actor.getList", results.get(sig))));
check("skip 文案含 observe", /已跳过重复/.test(formatDuplicateCallApiSkip("actor.getList")));
check("stableStringify 基本", stableStringify({ z: 1, a: { c: 2, b: 3 } }).includes('"a"'));

const failSteps = [
  {
    kind: "toolCalls",
    calls: [{ id: "c2", name: "call_api", input: { operation: "actor.getList", params: { page: 1 } } }],
  },
  { kind: "toolResult", toolCallId: "c2", content: '{\n  "code": 1,\n  "msg": "fail"\n}' },
];
check("失败 call_api 不收录", collectSuccessfulCallApiKeys(failSteps).size === 0);

check(
  "禁止并行时第2槽即停",
  shouldAbortToolCallStream({ slotCount: 2, toolNames: ["call_api", "call_api"], parallelAllowed: false, maxSlots: 6 }),
);
check(
  "禁止并行时单槽不停",
  !shouldAbortToolCallStream({ slotCount: 1, toolNames: ["call_api"], parallelAllowed: false, maxSlots: 6 }),
);
check(
  "允许并行未满槽不停",
  !shouldAbortToolCallStream({ slotCount: 3, toolNames: ["a", "b", "c"], parallelAllowed: true, maxSlots: 6 }),
);
check(
  "允许并行满槽即停",
  shouldAbortToolCallStream({ slotCount: 6, toolNames: ["a", "b", "c", "d", "e", "f"], parallelAllowed: true, maxSlots: 6 }),
);
const spam = Array.from({ length: 20 }, (_, i) => ({
  id: String(i),
  name: SUBMIT_UNDERSTOOD_INTENT,
  input: { n: i },
}));
const capped = enforceToolCallContract(spam, { parallelAllowed: false, maxSlots: 6 });
check("契约出口禁止并行只留1", capped.length === 1 && capped[0].id === "0");

console.log(`\n结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
