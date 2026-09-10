import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAmbiguityGate } from "../src/analytics/ambiguity-gate.js";
import { buildAnalyticsIntent, extractChannelsFromNl } from "../src/analytics/intent.js";
import { compileAnalyticsIntent } from "../src/analytics/sql-compile.js";
import type { AnalyticsPack } from "../src/analytics/semantic-layer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../config/analytics");
const pack = JSON.parse(readFileSync(join(root, "watch-detail.pack.json"), "utf8")) as AnalyticsPack;

const ORIG =
  "统计 IndiaA 渠道 在 2026-08-19 至 2026-08-25 期间，按观看日期 + 渠道 维度，三种小语种用户观看视频最大进度的平均值，也就是完播率";

{
  assert.deepEqual(extractChannelsFromNl(ORIG), ["IndiaA"]);
  assert.deepEqual(extractChannelsFromNl("印度A 按天人数"), ["IndiaA"]);
}

// Gate 接地 + wide → Intent → 宽表 avg_of_max（sumIf/countIf，无 LLM）
{
  const g = runAmbiguityGate(ORIG, pack, {
    slotAnswers: { contentLang: ["te-IN", "ta-IN", "ml-IN"], result_layout: ["wide"] },
  });
  assert.equal(g.ok, true);
  if (!g.ok) throw new Error("gate");

  const built = buildAnalyticsIntent({
    nl: ORIG,
    range: { start: "2026-08-19", end: "2026-08-25" },
    gate: g,
    pack,
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  assert.equal(built.intent.metric.kind, "avg_of_max");
  assert.equal(built.intent.layout, "wide");
  assert.equal(built.intent.pivotDim, "contentLang");
  assert.deepEqual(built.intent.filters.channel, ["IndiaA"]);
  assert.deepEqual(built.intent.filters.contentLang?.slice().sort(), ["ml-IN", "ta-IN", "te-IN"]);
  assert.ok(built.intent.filters.movieType?.includes("1"));

  const compiled = compileAnalyticsIntent(built.intent, pack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  const sql = compiled.sql;
  assert.match(sql, /elt_watch_detail/);
  assert.match(sql, /max\(maxWatchProgress\)\s+AS\s+a/i);
  assert.match(sql, /sumIf\s*\(\s*a\s*,\s*contentLang\s*=\s*'te-IN'\s*\)/i);
  assert.match(sql, /countIf\s*\(\s*contentLang\s*=\s*'ta-IN'\s*\)/i);
  assert.match(sql, /AS\s+ml_IN/i);
  assert.match(sql, /channel\s*=\s*'IndiaA'/);
  assert.match(sql, /movieType\s+IN\s*\(\s*1\s*,/);
  assert.match(sql, /GROUP BY\s+watchDate\s*,\s*channel\s*$/m);
  // 外层不得把 contentLang 当输出维
  assert.doesNotMatch(sql, /GROUP BY\s+watchDate\s*,\s*channel\s*,\s*contentLang/i);
  assert.doesNotMatch(sql, /uniq\s*\(\s*guid\s*\)/i);
}

// long 布局：contentLang 进 GROUP BY，avg(a)
{
  const g = runAmbiguityGate(ORIG, pack, {
    slotAnswers: { contentLang: ["te-IN", "ta-IN"], result_layout: ["long"] },
  });
  assert.equal(g.ok, true);
  if (!g.ok) throw new Error("gate");
  const built = buildAnalyticsIntent({
    nl: ORIG,
    range: { start: "2026-08-19", end: "2026-08-25" },
    gate: g,
    pack,
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  const compiled = compileAnalyticsIntent(built.intent, pack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  assert.match(compiled.sql, /round\(\s*avg\(a\)\s*,\s*0\)\s+AS\s+avg_max_progress/i);
  assert.match(compiled.sql, /contentLang/);
  assert.doesNotMatch(compiled.sql, /sumIf/);
}

// uniq 人数可编译
{
  const nl = "IndiaA 2026-08-20到21 按天观看人数";
  const g = runAmbiguityGate(nl, pack);
  assert.equal(g.ok, true);
  if (!g.ok) throw new Error("gate");
  const built = buildAnalyticsIntent({
    nl,
    range: { start: "2026-08-20", end: "2026-08-21" },
    gate: g,
    pack,
  });
  // gate 未接地 metric；infer 从 NL 得 uniq_users
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  assert.equal(built.intent.metric.kind, "uniq");
  const compiled = compileAnalyticsIntent(built.intent, pack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  assert.match(compiled.sql, /uniq\(guid\)\s+AS\s+users/i);
  assert.match(compiled.sql, /channel\s*=\s*'IndiaA'/);
}

// 完播率无口径 → Gate 已拦；若强行走 intent 则 metric not inferred（无 grounded）
{
  const nl = "IndiaA 2026-08-19到25 完播率按天";
  const g = runAmbiguityGate(nl, pack);
  assert.equal(g.ok, false);
}

console.log("analytics-intent-compile.test.ts OK");
