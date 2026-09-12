/**
 * Demand–Capability gate unit tests (zero network).
 * Run: tsx scripts/analytics-capability-gate.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateCapabilityGate,
  groundOpsFromNl,
  resolvePackCapabilities,
} from "../src/analytics/capability-gate.js";
import { alignMetricIdToNl, coerceUnknownMetricId } from "../src/analytics/metric-infer.js";
import type { AnalyticsPack } from "../src/analytics/semantic-layer.js";
import { assertSqlAstSafe, analyzeSqlAst } from "../src/analytics/sql-ast.js";

const pack = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../config/analytics/watch-detail.pack.json"),
    "utf8",
  ),
) as AnalyticsPack;

{
  const caps = resolvePackCapabilities(pack);
  assert.ok(caps.ops.has("base_aggregate"));
  assert.ok(caps.ops.has("yoy"));
  assert.ok(caps.ops.has("mom"));
  assert.ok(caps.ops.has("merge_ratio"));
  assert.ok(caps.metrics.has("uniq_users"));
  assert.ok(caps.unsupportedHints.yoy);
  assert.ok(caps.unsupportedHints.mom);
  assert.ok(caps.ops.has("mom"));
}

{
  const grounded = groundOpsFromNl(
    "2026-08-19到2026-08-25，各渠道观看人数的同比增长率",
    resolvePackCapabilities(pack).unsupportedHints,
  );
  assert.ok(grounded.includes("yoy") || grounded.includes("growth_rate"));
}

{
  const grounded = groundOpsFromNl(
    "观看时长合计 Top 10 渠道",
    resolvePackCapabilities(pack).unsupportedHints,
  );
  assert.ok(grounded.includes("top_n"), `got ${grounded.join(",")}`);
}

{
  const grounded = groundOpsFromNl(
    "按语言观看人数排行",
    resolvePackCapabilities(pack).unsupportedHints,
  );
  assert.ok(grounded.includes("top_n"), `got ${grounded.join(",")}`);
}

// C6: NL grounds yoy — now supported (double-window + merge_ratio)
{
  const gate = evaluateCapabilityGate({
    structure: {
      status: "ok",
      mergedNl: "各渠道观看人数的同比增长率",
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: {},
      outputDims: ["channel"],
      metricId: "uniq_users",
      ops: ["base_aggregate"],
    },
    pack,
    nl: "2026-08-19到2026-08-25，各渠道观看人数的同比增长率",
  });
  assert.equal(gate.status, "ok");
  if (gate.status === "ok") {
    assert.ok(gate.ops.includes("yoy") || gate.ops.includes("growth_rate"));
  }
}

// Baseline: plain UV ok
{
  const gate = evaluateCapabilityGate({
    structure: {
      status: "ok",
      mergedNl: "IndiaA 按天观看人数",
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"] },
      outputDims: ["watch_date"],
      metricId: "uniq_users",
      ops: ["base_aggregate"],
    },
    pack,
    nl: "IndiaA 在 2026-08-19 至 2026-08-25 按天观看人数",
  });
  assert.equal(gate.status, "ok");
}

// Declared yoy is supported
{
  const gate = evaluateCapabilityGate({
    structure: {
      status: "ok",
      mergedNl: "x",
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: {},
      outputDims: ["channel"],
      metricId: "uniq_users",
      ops: ["base_aggregate", "yoy"],
    },
    pack,
  });
  assert.equal(gate.status, "ok");
}

// mom is supported (equal-length prior window)
{
  const gate = evaluateCapabilityGate({
    structure: {
      status: "ok",
      mergedNl: "环比",
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: {},
      outputDims: ["channel"],
      metricId: "uniq_users",
      ops: ["base_aggregate", "mom"],
    },
    pack,
    nl: "各渠道观看人数环比",
  });
  assert.equal(gate.status, "ok");
}

// top_n still refused
{
  const gate = evaluateCapabilityGate({
    structure: {
      status: "ok",
      mergedNl: "Top 10",
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: {},
      outputDims: ["channel"],
      metricId: "sum_watch_second",
      ops: ["base_aggregate", "top_n"],
    },
    pack,
    nl: "观看时长合计 Top 10 渠道",
  });
  assert.equal(gate.status, "refuse");
}

// Follow-up UV must not inherit TopN from history NL
{
  const uv = {
    status: "ok" as const,
    mergedNl: "IndiaA 按天观看人数",
    time: { start: "2026-08-19", end: "2026-08-25" },
    filters: { channel: ["IndiaA"] },
    outputDims: ["watch_date"],
    metricId: "uniq_users",
    ops: ["base_aggregate"],
  };
  const current = evaluateCapabilityGate({ structure: uv, pack, nl: "FoxA呢？" });
  assert.equal(current.status, "ok");
  const polluted = evaluateCapabilityGate({
    structure: uv,
    pack,
    nl: "观看时长合计 Top 10 渠道\nFoxA呢？",
  });
  assert.equal(polluted.status, "refuse");
}

// Nested WHERE must pass requireWhere (C2 false missing_where)
{
  const sql = `
SELECT channel,
  round(sumIf(a, contentLang = 'te-IN') / nullIf(countIf(contentLang = 'te-IN'), 0), 0) AS te_IN,
  round(sumIf(a, contentLang = 'ta-IN') / nullIf(countIf(contentLang = 'ta-IN'), 0), 0) AS ta_IN
FROM (
  SELECT channel, guid, eid, contentLang, max(maxWatchProgress) AS a
  FROM elt_watch_detail
  WHERE toDate(lastWatchTime) BETWEEN '2026-08-19' AND '2026-08-25'
    AND channel = 'IndiaA'
  GROUP BY channel, guid, eid, contentLang
)
GROUP BY channel
ORDER BY channel`;
  const ast = analyzeSqlAst(sql);
  assert.equal(ast.hasWhere, true);
  assert.doesNotThrow(() =>
    assertSqlAstSafe(sql, { requireWhere: true, allowedTables: ["elt_watch_detail"] }),
  );
}

{
  assert.throws(
    () => assertSqlAstSafe("SELECT uniq(guid) FROM elt_watch_detail", { requireWhere: true }),
    /missing_where/,
  );
}

{
  assert.equal(coerceUnknownMetricId("watch_user_count", "改成观看人数", pack), "uniq_users");
  assert.equal(coerceUnknownMetricId("uniq_users", "改成观看人数", pack), "uniq_users");
  assert.equal(coerceUnknownMetricId("not_a_metric", "同比呢？", pack), "not_a_metric");
  assert.equal(coerceUnknownMetricId("count:*", "观看人数", pack), "count:*");
  assert.equal(alignMetricIdToNl("count:*", "elt_film_order 用户数", pack), "count:*");
}

console.log("analytics-capability-gate.test.ts OK");
