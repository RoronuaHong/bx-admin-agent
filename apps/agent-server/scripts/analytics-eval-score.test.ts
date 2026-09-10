/**
 * analytics-eval-score unit tests (no Metabase).
 * Run: tsx scripts/analytics-eval-score.test.ts
 */
import assert from "node:assert/strict";
import {
  softExMatch,
  softExMatchTables,
  cellsClose,
  accumulateOutcome,
  emptyMetrics,
  evaluateGates,
  isGateCase,
  loadGateThresholds,
} from "../src/analytics/eval-score.js";

{
  assert.equal(cellsClose(1, 1), true);
  assert.equal(cellsClose(1.0, "1"), true);
  assert.equal(cellsClose(0.5, 0.6, 0.015), false); // 20% rel, abs 0.1
  assert.equal(cellsClose(100, 101, 0.015), true); // 1% rel
}

{
  const gold = { cols: ["d", "users"], rows: [["2026-08-20", 10], ["2026-08-21", 12]] };
  const pred = {
    cols: ["d", "users", "extra"],
    rows: [
      ["2026-08-20", 10, "x"],
      ["2026-08-21", 12, "y"],
      ["2026-08-22", 1, "z"],
    ],
  };
  const r = softExMatch(gold, pred);
  assert.equal(r.ok, true);
  assert.equal(r.mode, "soft");
}

{
  const gold = { cols: ["d", "users"], rows: [["2026-08-20", 10]] };
  const pred = { cols: ["d", "users"], rows: [["2026-08-20", 99]] };
  assert.equal(softExMatch(gold, pred).ok, false);
}

{
  const gold = { cols: ["users"], rows: [[42]] };
  const pred = { cols: ["viewers"], rows: [[42]] };
  const r = softExMatch(gold, pred);
  assert.equal(r.ok, true);
  assert.equal(r.mode, "strict");
}

{
  const gold = { cols: ["watch_sec"], rows: [[100]] };
  const pred = { cols: ["totalWatchSeconds"], rows: [[100]] };
  assert.equal(softExMatch(gold, pred).ok, true);
}

{
  const golds = [
    { cols: ["d", "users"], rows: [["2026-08-20", 1]] },
    { cols: ["contentLang", "users"], rows: [["te", 5]] },
  ];
  const preds = [
    { cols: ["contentLang", "users"], rows: [["te", 5], ["hi", 1]] },
    { cols: ["d", "users"], rows: [["2026-08-20", 1]] },
  ];
  const r = softExMatchTables(golds, preds);
  assert.equal(r.ok, true);
  assert.equal(r.mode, "soft");
}

{
  const m = emptyMetrics();
  accumulateOutcome(m, "refuse_ok", true);
  accumulateOutcome(m, "refuse_ok", true);
  accumulateOutcome(m, "ex_soft", false);
  accumulateOutcome(m, "ex_fail", false);
  const t = loadGateThresholds({
    GATE_EX_MIN: "0.5",
    GATE_REFUSE_RECALL_MIN: "0.9",
    GATE_REFUSE_PRECISION_MIN: "0.8",
    GATE_CWR_MAX: "0.6",
  });
  const g = evaluateGates(m, t);
  assert.equal(g.ex, 0.5);
  assert.equal(g.refuseRecall, 1);
  assert.equal(g.cwr, 0.5);
  assert.equal(g.pass, true);
}

{
  const m = emptyMetrics();
  accumulateOutcome(m, "ex_fail", false);
  const g = evaluateGates(m, loadGateThresholds({ GATE_EX_MIN: "0.85", GATE_CWR_MAX: "0.1" }));
  assert.equal(g.pass, false);
  assert.ok(g.failures.some((f) => f.includes("EX")));
}

{
  assert.equal(isGateCase({ reviewStatus: "gold" }), true);
  assert.equal(isGateCase({ reviewStatus: "provisional" }), false);
  assert.equal(isGateCase({}), false);
  assert.equal(isGateCase({ reviewStatus: "GOLD" }), true);
}

console.log("analytics-eval-score.test.ts OK");
