/**
 * llm-verify unit tests (no network).
 * Run: tsx scripts/analytics-llm-verify.test.ts
 */
import assert from "node:assert/strict";
import {
  parseLlmVerifyResponse,
  llmVerifyEnabled,
  sampleTablesForVerify,
  resolveUnclearVerify,
  buildLlmVerifyPrompt,
  buildLlmVerifyRetryPrompt,
} from "../src/analytics/llm-verify.js";

{
  assert.equal(llmVerifyEnabled({ ANALYTICS_LLM_VERIFY: "1" }), true);
  assert.equal(llmVerifyEnabled({ ANALYTICS_LLM_VERIFY: "0" }), false);
  assert.equal(llmVerifyEnabled({ ANALYTICS_LLM_VERIFY: "false" }), false);
}

{
  const p = parseLlmVerifyResponse('{"verdict":"pass","codes":[],"reason":"ok"}');
  assert.equal(p.verdict, "pass");
}

{
  const p = parseLlmVerifyResponse('```json\n{"verdict":"fail","codes":["wrong_grain"],"reason":"no day group"}\n```');
  assert.equal(p.verdict, "fail");
  assert.deepEqual(p.codes, ["wrong_grain"]);
}

{
  const p = parseLlmVerifyResponse('{"verdict":"unclear","reason":"ambiguous"}');
  assert.equal(p.verdict, "unclear");
}

{
  const p = parseLlmVerifyResponse("not json at all");
  assert.equal(p.verdict, "unclear");
  assert.ok(p.codes.includes("parse_fail"));
}

{
  const sampled = sampleTablesForVerify(
    [{ title: "t", cols: ["a"], rows: Array.from({ length: 30 }, (_, i) => [i]) }],
    12,
  );
  assert.equal(sampled[0].rows.length, 12);
}

{
  const soft = resolveUnclearVerify(
    { verdict: "unclear", codes: ["x"], reason: "ambiguous" },
    { strict: false },
  );
  assert.equal(soft.verdict, "pass");
  assert.ok(soft.codes.includes("unclear_resolved_by_structure"));

  const keep = resolveUnclearVerify(
    { verdict: "unclear", codes: ["x"], reason: "ambiguous" },
    { strict: true },
  );
  assert.equal(keep.verdict, "unclear");
}

{
  const prompt = buildLlmVerifyPrompt({
    nl: "FoxA 昨天 UV",
    timeEcho: "昨天",
    sqls: ["SELECT 1"],
    sampleTables: [{ title: "t", cols: ["a"], rows: [[1]] }],
  });
  assert.ok(prompt.system.includes("prefer pass"));
  const retry = buildLlmVerifyRetryPrompt({
    nl: "FoxA 昨天 UV",
    timeEcho: "昨天",
    sqls: ["SELECT 1"],
    sampleTables: [{ title: "t", cols: ["a"], rows: [[1]] }],
    priorReason: "sample short",
  });
  assert.ok(retry.system.includes("unclear forbidden"));
  assert.ok(retry.user.includes("Prior unclear reason"));
}

console.log("analytics-llm-verify.test.ts OK");
