/**
 * llm-verify unit tests (no network).
 * Run: tsx scripts/analytics-llm-verify.test.ts
 */
import assert from "node:assert/strict";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";
import { alignMetricIdToNl } from "../src/analytics/metric-infer.js";
import {
  parseLlmVerifyResponse,
  llmVerifyEnabled,
  sampleTablesForVerify,
  resolveUnclearVerify,
  buildLlmVerifyPrompt,
  buildLlmVerifyRetryPrompt,
  checkMetricIntentAlignment,
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
  const withMetric = buildLlmVerifyPrompt({
    nl: "人均观看时长",
    timeEcho: "昨天",
    sqls: ["SELECT 1"],
    sampleTables: [{ title: "t", cols: ["a"], rows: [[1]] }],
    metricId: "avg_watch_second_per_user",
  });
  assert.ok(withMetric.user.includes("Compiled metricId"));
  assert.ok(withMetric.system.includes("metric_nl_mismatch"));
}

{
  const pack = loadAnalyticsPack("watch-detail");
  assert.equal(
    alignMetricIdToNl("sum_watch_second", "八月二十到二十一印度A观看人数合计", pack),
    "uniq_users",
  );
  assert.equal(
    alignMetricIdToNl("avg_max_progress", "八月二十印度A按天人均观看时长秒", pack),
    "avg_watch_second_per_user",
  );
  assert.equal(alignMetricIdToNl("uniq_users", "FoxA呢", pack), "uniq_users");
  const mismatch = checkMetricIntentAlignment({
    nl: "八月二十印度A按天人均观看时长秒",
    metricId: "avg_max_progress",
    pack,
  });
  assert.ok(mismatch);
  assert.equal(mismatch!.verdict, "fail");
  assert.ok(mismatch!.codes.includes("metric_nl_mismatch"));
  assert.equal(
    checkMetricIntentAlignment({
      nl: "FoxA呢",
      metricId: "uniq_users",
      pack,
    }),
    null,
  );
}

console.log("analytics-llm-verify.test.ts OK");
