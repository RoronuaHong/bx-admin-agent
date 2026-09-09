import assert from "node:assert/strict";
import { loadRuleset } from "../src/analytics/scan/ruleset.js";
import { evaluateThreshold, type ScanMetricRow } from "../src/analytics/scan/threshold.js";
import type { RuleSet } from "../src/analytics/scan/types.js";

const baseRuleSet = loadRuleset("watch-users");

function row(partial: Partial<ScanMetricRow> & Pick<ScanMetricRow, "entityKey">): ScanMetricRow {
  return {
    scanValue: null,
    dodValue: null,
    wowValue: null,
    ...partial,
  };
}

{
  const result = evaluateThreshold(baseRuleSet, []);
  assert.equal(result.severity, null);
  assert.deepEqual(result.quietReasons, ["empty"]);
  assert.equal(result.children.length, 0);
}

{
  const result = evaluateThreshold(baseRuleSet, [
    row({ entityKey: "ch-a", scanValue: null, dodValue: 1000, wowValue: 1000 }),
  ]);
  assert.equal(result.severity, "info");
  assert.equal(result.children.length, 0);
  assert.ok(result.quietReasons.some((r) => r.includes("scan 值为空")));
}

{
  const result = evaluateThreshold(baseRuleSet, [
    row({ entityKey: "ch-a", scanValue: 50, dodValue: 1000, wowValue: 1000, sample: 50 }),
  ]);
  assert.equal(result.severity, "info");
  assert.equal(result.children.length, 0);
  assert.ok(result.quietReasons.some((r) => r.includes("样本量")));
}

{
  const result = evaluateThreshold(baseRuleSet, [
    row({ entityKey: "ch-a", scanValue: 500, dodValue: null, wowValue: null }),
  ]);
  assert.equal(result.severity, "info");
  assert.equal(result.children.length, 0);
  assert.ok(result.quietReasons.some((r) => r.includes("基线缺失")));
}

{
  const result = evaluateThreshold(baseRuleSet, [
    row({ entityKey: "ch-a", scanValue: 850, dodValue: 1000, wowValue: 1000 }),
  ]);
  assert.equal(result.severity, "warn");
  assert.equal(result.children.length, 1);
  assert.equal(result.children[0]?.entityKey, "ch-a");
  assert.equal(result.children[0]?.baseline, "dod");
  assert.ok(result.children[0]!.ratio < 0.9);
  assert.equal(result.children[0]?.delta, -150);
}

{
  const strictRuleSet: RuleSet = { ...baseRuleSet, minAbsDelta: 200 };
  const result = evaluateThreshold(strictRuleSet, [
    row({ entityKey: "ch-a", scanValue: 850, dodValue: 1000, wowValue: 1000 }),
  ]);
  assert.equal(result.severity, null);
  assert.equal(result.children.length, 0);
}

{
  const result = evaluateThreshold(baseRuleSet, [
    row({ entityKey: "ch-a", scanValue: 800, dodValue: 1000, wowValue: 1200 }),
    row({ entityKey: "ch-b", scanValue: 700, dodValue: 1000, wowValue: 1100 }),
  ]);
  assert.equal(result.severity, "warn");
  assert.equal(result.children.length, 2);
  assert.match(result.parentMessage, /2 个实体/);
}

{
  const result = evaluateThreshold(baseRuleSet, [
    row({ entityKey: "ch-a", scanValue: 800, dodValue: 1000, wowValue: 1200 }),
    row({ entityKey: "ch-b", scanValue: 700, dodValue: 1000, wowValue: 1100 }),
    row({ entityKey: "ch-c", scanValue: 600, dodValue: 1000, wowValue: 1300 }),
  ]);
  assert.equal(result.severity, "critical");
  assert.equal(result.children.length, 3);
  assert.match(result.parentMessage, /critical/);
}

{
  const smallCapRuleSet: RuleSet = { ...baseRuleSet, maxChildAlerts: 2, criticalEntityCount: 10 };
  const rows = Array.from({ length: 5 }, (_, i) =>
    row({
      entityKey: `ch-${i}`,
      scanValue: 500 - i * 10,
      dodValue: 1000,
      wowValue: 1000,
    }),
  );
  const result = evaluateThreshold(smallCapRuleSet, rows);
  assert.equal(result.severity, "warn");
  assert.equal(result.children.length, 2);
  assert.match(result.parentMessage, /另有 3 个细分/);
  assert.ok(result.children[0]!.ratio <= result.children[1]!.ratio);
}

console.log("analytics-scan-threshold.test.ts OK");
