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
  llmInsightEnabled,
  collectGroundedNumbers,
  sanitizeInsightText,
  parseInsightResponse,
  composeInsightMarkdown,
  buildInsightPrompt,
  buildLocalInsight,
  runPostExecLlm,
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

{
  assert.equal(llmInsightEnabled({ ANALYTICS_LLM_INSIGHT: "1" } as NodeJS.ProcessEnv), true);
  assert.equal(llmInsightEnabled({ ANALYTICS_LLM_INSIGHT: "0" } as NodeJS.ProcessEnv), false);
}

{
  const grounded = collectGroundedNumbers(
    [{ cols: ["channel", "n"], rows: [["GoGo", 96901], ["FoxA", 69335]] }],
    ["按 2026-08-19～2026-08-25"],
  );
  assert.ok(grounded.has("96901"));
  assert.ok(grounded.has("2026"));
  const ok = sanitizeInsightText("GoGo 为 96901，高于 FoxA 的 69335。", grounded);
  assert.match(ok, /96901/);
  const bad = sanitizeInsightText("预计下周将到 200000。GoGo 为 96901。", grounded);
  assert.doesNotMatch(bad, /200000/);
  assert.match(bad, /96901/);
}

{
  const parsed = parseInsightResponse('{"summary":"GoGo 96901 居首。","trend":"头部集中在 2.1.2。"}');
  assert.match(parsed.summary, /96901/);
  const grounded = collectGroundedNumbers(
    [{ cols: ["c", "v", "n"], rows: [["GoGo", "2.1.2", 96901]] }],
    [],
  );
  const md = composeInsightMarkdown(parsed, grounded);
  assert.match(md, /96901/);
  assert.match(md, /2\.1\.2/);
}

{
  const prompt = buildInsightPrompt({
    nl: "渠道交叉",
    timeEcho: "按 2026-08-19～2026-08-25",
    sqls: ["SELECT 1"],
    sampleTables: [{ title: "t", cols: ["a"], rows: [[1]] }],
  });
  assert.match(prompt.system, /Do not invent/);
}

{
  const local = buildLocalInsight({
    timeEcho: "按 2026-08-19～2026-08-25",
    tables: [{ cols: ["rows"], rows: [[141567]] }],
  });
  assert.match(local, /141567/);
}

{
  const prevV = process.env.ANALYTICS_LLM_VERIFY;
  const prevI = process.env.ANALYTICS_LLM_INSIGHT;
  process.env.ANALYTICS_LLM_VERIFY = "1";
  process.env.ANALYTICS_LLM_INSIGHT = "1";
  let calls = 0;
  const compiled = await runPostExecLlm({
    nl: "订单数",
    timeEcho: "按 2026-08-19～2026-08-25",
    sqls: ["SELECT count() AS rows FROM elt_film_order"],
    tables: [{ title: "结果", cols: ["rows"], rows: [[141567]] }],
    trust: "trusted",
    llmText: async () => {
      calls += 1;
      return "";
    },
  });
  assert.equal(calls, 0);
  assert.equal(compiled.verify?.verdict, "pass");
  assert.match(compiled.insight || "", /141567/);

  const post = await runPostExecLlm({
    nl: "渠道交叉",
    timeEcho: "按 2026-08-19～2026-08-25",
    sqls: ["SELECT 1"],
    tables: [{ title: "结果", cols: ["channel", "n"], rows: [["GoGo", 96901]] }],
    trust: "unverified",
    llmText: async () => {
      calls += 1;
      return '{"verdict":"pass","codes":[],"reason":"ok","summary":"GoGo 为 96901。","trend":"预计下周 200000。"}';
    },
  });
  assert.equal(calls, 1);
  assert.equal(post.verify?.verdict, "pass");
  assert.match(post.insight || "", /96901/);
  assert.doesNotMatch(post.insight || "", /200000/);
  process.env.ANALYTICS_LLM_VERIFY = prevV;
  process.env.ANALYTICS_LLM_INSIGHT = prevI;
}

console.log("analytics-llm-verify.test.ts OK");
