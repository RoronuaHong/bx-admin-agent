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
  mergeRatioTables,
  relativeGrowthKind,
  resolveMomPriorWindow,
  shiftYmdDays,
  shiftYmdYears,
  synthesizeMomPlan,
  synthesizeYoyPlan,
} from "../src/analytics/ask-plan.js";
import { inferMetricIdFromNl, inferOutputDimsFromNl } from "../src/analytics/metric-infer.js";
import type { AnalyticsPack } from "../src/analytics/semantic-layer.js";

const pack = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../config/analytics/watch-detail.pack.json"),
    "utf8",
  ),
) as AnalyticsPack;

assert.equal(inferMetricIdFromNl("电影的观看人数按天", pack), "uniq_users");
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

console.log("analytics-ask-plan.test.ts OK");
