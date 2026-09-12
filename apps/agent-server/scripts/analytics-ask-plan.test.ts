/**
 * ask-plan + metric-infer unit tests.
 * Run: tsx scripts/analytics-ask-plan.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  gateAskPlan,
  parseAskPlan,
  compileAskPlanSteps,
  inferPlanTuples,
  mergeRatioTables,
  growthKindToSynthesize,
  relativeGrowthKind,
  resolveMomPriorWindow,
  resolvePlanCardinality,
  shiftYmdDays,
  shiftYmdYears,
  synthesizeMomPlan,
  synthesizeYoyPlan,
} from "../src/analytics/ask-plan.js";
import { buildDimLexicon } from "../src/analytics/dim-lexicon.js";
import {
  ambiguousMetricFamilyClarify,
  inferMetricIdFromNl,
  inferOutputDimsFromNl,
  nlForMetricFamilyGate,
} from "../src/analytics/metric-infer.js";
import type { AnalyticsPack } from "../src/analytics/semantic-layer.js";

const pack = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../config/analytics/watch-detail.pack.json"),
    "utf8",
  ),
) as AnalyticsPack;

assert.equal(inferMetricIdFromNl("电影的观看人数按天", pack), "uniq_users");
assert.equal(inferMetricIdFromNl("IndiaA 完播率按天", pack), undefined);
assert.equal(
  inferMetricIdFromNl("最大进度的平均值，也就是完播率", pack),
  "avg_max_progress",
);
assert.equal(inferMetricIdFromNl("八月二十到二十一印度A观看总时长秒", pack), "sum_watch_second");
assert.ok(ambiguousMetricFamilyClarify("IndiaA 完播率按天", pack));
assert.equal(ambiguousMetricFamilyClarify("最大进度的平均值，也就是完播率", pack), null);
{
  const historyBlob = [
    "2026-08-19到25 IndiaA 完播率按天",
    "「完播率」有多种口径，请确认要用哪一种。",
    "FoxA呢？",
  ].join("\n");
  assert.ok(ambiguousMetricFamilyClarify(historyBlob, pack), "full transcript still looks ambiguous");
  assert.equal(
    ambiguousMetricFamilyClarify(
      nlForMetricFamilyGate({ lastUserText: "FoxA呢？", fallbackNl: historyBlob }),
      pack,
    ),
    null,
    "channel follow-up must not reopen metric family",
  );
  assert.ok(
    ambiguousMetricFamilyClarify(
      nlForMetricFamilyGate({ lastUserText: "IndiaA 完播率按天" }),
      pack,
    ),
    "bare first-turn 完播率 still clarifies",
  );
}
assert.ok(inferOutputDimsFromNl("按天观看人数").includes("watch_date"));
assert.equal(shiftYmdYears("2024-02-29", -1), "2023-02-28");
assert.equal(shiftYmdYears("2026-08-19", -1), "2025-08-19");
assert.equal(shiftYmdDays("2026-08-19", -7), "2026-08-12");

{
  const prior = resolveMomPriorWindow({ start: "2026-08-19", end: "2026-08-25" });
  assert.equal(prior.spanDays, 7);
  assert.equal(prior.start, "2026-08-12");
  assert.equal(prior.end, "2026-08-18");
}

assert.equal(relativeGrowthKind(["mom", "growth_rate"]), "mom");
assert.equal(relativeGrowthKind(["yoy", "growth_rate"]), "yoy");
assert.equal(relativeGrowthKind(["growth_rate"]), "yoy");

{
  const bare = parseAskPlan({
    steps: [
      { id: "current", metricId: "uniq_users", ops: ["base_aggregate"], outputDims: ["channel"] },
      { id: "prior", metricId: "uniq_users", ops: ["base_aggregate"], outputDims: ["channel"] },
    ],
    merge: { kind: "ratio", left: "current", right: "prior" },
  });
  assert.equal(growthKindToSynthesize(["yoy"], bare || undefined), "yoy");
  const withOffset = parseAskPlan({
    steps: [
      { id: "current", metricId: "uniq_users", ops: ["base_aggregate"], outputDims: ["channel"] },
      {
        id: "prior_yoy",
        metricId: "uniq_users",
        ops: ["base_aggregate"],
        outputDims: ["channel"],
        timeOffset: "yoy_window",
      },
    ],
    merge: { kind: "ratio", left: "current", right: "prior_yoy" },
  });
  assert.equal(growthKindToSynthesize(["yoy"], withOffset || undefined), null);
  assert.equal(growthKindToSynthesize(["yoy"], undefined), "yoy");
}

{
  const plan = parseAskPlan({
    steps: [
      { id: "s1", metricId: "uniq_users", ops: ["base_aggregate"], outputDims: ["channel"] },
      { id: "s2", metricId: "sum_watch_second", ops: ["base_aggregate"], outputDims: ["channel"] },
    ],
    merge: { kind: "side_by_side", left: "s1", right: "s2" },
  });
  assert.ok(plan);
  const base = {
    status: "ok" as const,
    mergedNl: "对比人数与时长",
    time: { start: "2026-08-19", end: "2026-08-25" },
    filters: { channel: ["IndiaA"] },
    outputDims: ["channel"],
    metricId: "uniq_users",
  };
  const g = gateAskPlan(plan!, pack, base);
  assert.equal(g.status, "ok");
  const c = compileAskPlanSteps({ plan: plan!, base, pack, fallbackNl: base.mergedNl });
  assert.equal(c.ok, true);
  if (c.ok) assert.equal(c.steps.length, 2);
}

{
  const plan = parseAskPlan({
    steps: [
      { id: "s1", metricId: "uniq_users", ops: ["base_aggregate"], outputDims: ["channel"] },
      {
        id: "s2",
        metricId: "uniq_users",
        ops: ["base_aggregate"],
        outputDims: ["channel"],
        timeOffset: "yoy_window",
      },
    ],
    merge: { kind: "ratio", left: "s1", right: "s2" },
  });
  assert.ok(plan);
  const base = {
    status: "ok" as const,
    mergedNl: "同比",
    time: { start: "2026-08-19", end: "2026-08-25" },
    filters: {},
    outputDims: ["channel"],
    metricId: "uniq_users",
  };
  const g = gateAskPlan(plan!, pack, base);
  assert.equal(g.status, "ok", g.status === "refuse" ? g.message : "");
  const c = compileAskPlanSteps({ plan: plan!, base, pack, fallbackNl: base.mergedNl });
  assert.equal(c.ok, true);
  if (c.ok) {
    assert.match(c.steps[1]!.sql, /2025-08-19/);
    assert.match(c.steps[1]!.sql, /2025-08-25/);
    assert.match(c.steps[0]!.sql, /2026-08-19/);
  }
}

{
  const syn = synthesizeYoyPlan({
    status: "ok",
    mergedNl: "各渠道观看人数同比",
    time: { start: "2026-08-19", end: "2026-08-25" },
    filters: {},
    outputDims: ["channel"],
    metricId: "uniq_users",
    ops: ["yoy", "growth_rate"],
  });
  assert.ok(syn);
  assert.equal(syn!.merge.kind, "ratio");
  assert.equal(syn!.steps[1]!.timeOffset, "yoy_window");
}

{
  const syn = synthesizeMomPlan({
    status: "ok",
    mergedNl: "各渠道观看人数环比",
    time: { start: "2026-08-19", end: "2026-08-25" },
    filters: {},
    outputDims: ["channel"],
    metricId: "uniq_users",
    ops: ["mom"],
  });
  assert.ok(syn);
  assert.equal(syn!.steps[1]!.timeOffset, "mom_window");
  const g = gateAskPlan(syn!, pack, {
    status: "ok",
    mergedNl: "环比",
    time: { start: "2026-08-19", end: "2026-08-25" },
    filters: {},
    outputDims: ["channel"],
    metricId: "uniq_users",
  });
  assert.equal(g.status, "ok", g.status === "refuse" ? g.message : "");
  const c = compileAskPlanSteps({
    plan: syn!,
    base: {
      status: "ok",
      mergedNl: "环比",
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: {},
      outputDims: ["channel"],
      metricId: "uniq_users",
    },
    pack,
    fallbackNl: "环比",
  });
  assert.equal(c.ok, true);
  if (c.ok) {
    assert.match(c.steps[1]!.sql, /2026-08-12/);
    assert.match(c.steps[1]!.sql, /2026-08-18/);
    assert.match(c.steps[0]!.sql, /2026-08-19/);
  }
}

{
  const merged = mergeRatioTables({
    left: {
      cols: ["channel", "users"],
      rows: [
        ["IndiaA", 200],
        ["IndiaB", 100],
      ],
    },
    right: {
      cols: ["channel", "users"],
      rows: [
        ["IndiaA", 100],
        ["IndiaB", 50],
      ],
    },
  });
  assert.deepEqual(merged.cols.slice(-1), ["growth_rate"]);
  assert.equal(merged.rows[0]![3], 1); // (200-100)/100
  assert.equal(merged.rows[1]![3], 1);
}

{
  const merged = mergeRatioTables({
    align: { years: 1 },
    left: { cols: ["watchDate", "users"], rows: [["2026-08-19", 20]] },
    right: { cols: ["watchDate", "users"], rows: [["2025-08-19", 10]] },
  });
  assert.equal(merged.rows[0]![3], 1);
}

{
  const merged = mergeRatioTables({
    align: { days: 7 },
    left: { cols: ["watchDate", "users"], rows: [["2026-08-19", 20]] },
    right: { cols: ["watchDate", "users"], rows: [["2026-08-12", 10]] },
  });
  assert.equal(merged.rows[0]![3], 1);
}

{
  const channelLex = buildDimLexicon({
    field: "channel",
    valuesRows: [["IndiaA"], ["FoxA"]],
  });
  const lexicons = { channel: channelLex };
  const mixedNl = "八月二十到二十一印度A按天观看人数，同时FoxA按语言观看人数";
  const tuples = inferPlanTuples(mixedNl, lexicons, pack);
  assert.equal(tuples.length, 2);
  assert.deepEqual(tuples[0]!.channels, ["IndiaA"]);
  assert.ok(tuples[0]!.outputDims.includes("watch_date"));
  assert.deepEqual(tuples[1]!.channels, ["FoxA"]);
  assert.ok(tuples[1]!.outputDims.includes("contentLang"));

  const base = {
    status: "ok" as const,
    mergedNl: mixedNl,
    time: { start: "2026-08-20", end: "2026-08-21" },
    filters: { channel: ["IndiaA", "FoxA"] },
    outputDims: ["watch_date", "contentLang", "channel"],
    metricId: "uniq_users",
  };
  const mixed = resolvePlanCardinality({ structure: base, nl: mixedNl, lexicons, pack });
  assert.equal(mixed.kind, "plan");
  if (mixed.kind === "plan") {
    assert.equal(mixed.plan.steps.length, 2);
    assert.equal(mixed.plan.merge.kind, "side_by_side");
    assert.deepEqual(mixed.plan.steps[0]!.filters?.channel, ["IndiaA"]);
    assert.deepEqual(mixed.plan.steps[1]!.filters?.channel, ["FoxA"]);
  }

  const splitNl = "八月二十到二十一印度A和FoxA各自按天观看人数";
  const split = resolvePlanCardinality({
    structure: {
      ...base,
      mergedNl: splitNl,
      outputDims: ["watch_date", "channel"],
    },
    nl: splitNl,
    lexicons,
    pack,
  });
  assert.equal(split.kind, "plan");
  if (split.kind === "plan") assert.equal(split.plan.steps.length, 2);

  const keep = resolvePlanCardinality({
    structure: {
      status: "ok",
      mergedNl: "IndiaA te-IN 观看人数按天",
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"], contentLang: ["te-IN"] },
      outputDims: ["watch_date"],
      metricId: "uniq_users",
    },
    nl: "IndiaA 在 2026-08-19 至 2026-08-25，te-IN 观看人数按天",
    lexicons,
    pack,
  });
  assert.equal(keep.kind, "keep");
}

console.log("analytics-ask-plan.test.ts OK");
