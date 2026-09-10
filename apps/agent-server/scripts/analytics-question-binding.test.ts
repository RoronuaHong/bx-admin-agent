/**
 * question-binding unit tests (no network).
 * Run: tsx scripts/analytics-question-binding.test.ts
 */
import assert from "node:assert/strict";
import {
  applyBindingSqlTemplate,
  buildBindingParameters,
  matchQuestionBinding,
  type QuestionBinding,
} from "../src/analytics/question-binding.js";

const bindings: QuestionBinding[] = [
  {
    id: "indiaA-day-users",
    matchAll: ["印度A", "按天观看人数"],
    matchNone: ["和", "与", "同时", "各自", "分别", "FoxA", "GoGo"],
    sqlTemplate:
      "SELECT 1 WHERE d BETWEEN '{start}' AND '{end}'",
  },
  {
    id: "card-only",
    matchAll: ["标准卡"],
    questionId: 42,
  },
];

{
  const hit = matchQuestionBinding(bindings, "八月二十到二十一印度A按天观看人数");
  assert.ok(hit);
  assert.equal(hit!.id, "indiaA-day-users");
  assert.ok(hit!.sqlTemplate);
}

{
  const miss = matchQuestionBinding(bindings, "八月二十到二十一印度A和FoxA各自按天观看人数");
  assert.equal(miss, null);
}

{
  const card = matchQuestionBinding(bindings, "跑一下标准卡");
  assert.ok(card);
  assert.equal(card!.questionId, 42);
}

{
  assert.equal(matchQuestionBinding(bindings, "随便问问"), null);
  assert.equal(matchQuestionBinding([], "印度A按天观看人数"), null);
}

{
  const sql = applyBindingSqlTemplate(
    "WHERE BETWEEN '{start}' AND '{end}'",
    { start: "2026-08-20", end: "2026-08-21" },
  );
  assert.equal(sql, "WHERE BETWEEN '2026-08-20' AND '2026-08-21'");
}

{
  const params = buildBindingParameters(
    { id: "x", matchAll: ["a"], parameters: { from: "start", to: "end", fixed: "Z" } },
    { start: "2026-01-01", end: "2026-01-02" },
  );
  assert.deepEqual(params, { from: "2026-01-01", to: "2026-01-02", fixed: "Z" });
}

console.log("analytics-question-binding.test.ts OK");
