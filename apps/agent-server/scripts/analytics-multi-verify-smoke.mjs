/**
 * One-off multi-query + verify smoke (M2 unclear regression).
 * Run: pnpm exec tsx scripts/analytics-multi-verify-smoke.mjs
 */
import "dotenv/config";
import { analyticsAsk } from "../src/analytics/pipeline.js";

const CLOCK = new Date("2026-09-09T12:00:00+08:00");
const NL = "八月二十到二十一印度A和FoxA各自按天观看人数";

function pickModel() {
  const ids = (process.env.MODEL_PROVIDERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    ids.find((i) => i.toLowerCase() === "glm5turbo") ||
    ids.find((i) => /flash|dsflash/i.test(i)) ||
    ids[0]
  );
}

const modelId = pickModel();
console.log("[multi-verify-smoke] model=", modelId, "LLM_VERIFY=", process.env.ANALYTICS_LLM_VERIFY ?? "(default 1)");

const r = await analyticsAsk(NL, { clock: CLOCK, modelId });
console.log(
  JSON.stringify(
    {
      status: r.status,
      message: r.message,
      sqlCount: r.sqls?.length,
      verify: r.verify,
      rows: r.tables?.map((t) => t.rows?.length),
    },
    null,
    2,
  ),
);
if (r.status !== "ok") process.exitCode = 1;
