/**
 * questionBinding shortcut smoke (needs Metabase).
 * Run: pnpm exec tsx scripts/analytics-binding-smoke.mjs
 */
import "dotenv/config";
import { analyticsAsk } from "../src/analytics/pipeline.js";

const CLOCK = new Date("2026-09-09T12:00:00+08:00");
const NL = "八月二十到二十一印度A按天观看人数";

const r = await analyticsAsk(NL, { clock: CLOCK, modelId: "glm5turbo" });
console.log(
  JSON.stringify(
    {
      status: r.status,
      verifySkipped: r.verifySkipped,
      questionBinding: r.questionBinding,
      sqlCount: r.sqls?.length,
      chartCount: r.charts?.length,
      rows: r.tables?.[0]?.rows?.length,
      message: r.message,
    },
    null,
    2,
  ),
);
if (r.status !== "ok" || r.verifySkipped !== "question_binding") process.exitCode = 1;
