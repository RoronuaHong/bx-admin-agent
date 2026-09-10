/**
 * analytics audit-ledger unit tests (no network).
 * Run: tsx scripts/analytics-audit-ledger.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveFailureClass,
  listAskLedger,
  listFeedbackCandidates,
  purgeAskLedgerOlderThan,
  recordAskLedger,
  reviewFeedbackCandidate,
  submitFeedback,
} from "../src/analytics/audit-ledger.js";

{
  assert.equal(deriveFailureClass({ status: "ok", message: "x" }), "ok");
  assert.equal(deriveFailureClass({ status: "clarify", message: "最近" }), "clarify");
  assert.equal(
    deriveFailureClass({ status: "refuse", message: "dim", error: "dim_mismatch: a" }),
    "refuse_dim",
  );
  assert.equal(
    deriveFailureClass({
      status: "refuse",
      message: "v",
      verify: { verdict: "fail", codes: [], reason: "x" },
    }),
    "refuse_verify_fail",
  );
  assert.equal(
    deriveFailureClass({ status: "error", message: "SQL 校验未通过: a" }, ["a"]),
    "error_guard",
  );
  assert.equal(deriveFailureClass({ status: "error", message: "已取消", error: "aborted" }), "aborted");
}

const prevCwd = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), "analytics-ledger-"));
process.chdir(tmp);
try {
  recordAskLedger({
    askId: "ask-1",
    nl: "印度A按天",
    status: "ok",
    guardIssues: [],
    rewriteRounds: 1,
    failureClass: "ok",
    packVersion: "1",
    modelId: "glm5turbo",
    ms: 12,
  });
  const rows = listAskLedger({ limit: 5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].askId, "ask-1");
  assert.equal(rows[0].rewriteRounds, 1);

  const c = submitFeedback({
    askId: "ask-1",
    verdict: "wrong",
    reasonTags: ["wrong_number", "wrong_grain"],
    note: "人数不对",
    nl: "印度A按天",
    sqls: ["SELECT 1"],
    status: "ok",
  });
  assert.equal(c.reviewStatus, "pending");
  assert.deepEqual(c.reasonTags, ["wrong_number", "wrong_grain"]);

  const listed = listFeedbackCandidates({ reviewStatus: "pending" });
  assert.equal(listed.length, 1);

  const reviewed = reviewFeedbackCandidate(c.id, "confirmed");
  assert.ok(reviewed);
  assert.equal(reviewed!.reviewStatus, "confirmed");
  assert.equal(listFeedbackCandidates({ reviewStatus: "confirmed" }).length, 1);
  // Confirmed must NOT imply gold write — only reviewStatus flip.

  recordAskLedger({
    askId: "ask-old",
    nl: "旧",
    status: "ok",
    guardIssues: [],
    rewriteRounds: 0,
    failureClass: "ok",
    ms: 1,
    at: Date.parse("2026-07-01T00:00:00.000Z"),
  });
  const purged = purgeAskLedgerOlderThan(30, new Date("2026-09-10T00:00:00.000Z"));
  assert.ok(purged.rowsDropped >= 1);
  assert.equal(listAskLedger({ limit: 10 }).some((r) => r.askId === "ask-old"), false);
  assert.equal(listAskLedger({ limit: 10 }).some((r) => r.askId === "ask-1"), true);
} finally {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
}

console.log("analytics-audit-ledger.test.ts OK");
