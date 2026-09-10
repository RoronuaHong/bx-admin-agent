/**
 * Live smoke: Intent compile path for three-lang wide completion rate.
 */
import "dotenv/config";
import { analyticsAsk } from "../src/analytics/pipeline.js";

const ORIG =
  "统计 IndiaA 渠道 在 2026-08-19 至 2026-08-25 期间，按观看日期 + 渠道 维度，三种小语种用户观看视频最大进度的平均值，也就是完播率";

const r = await analyticsAsk(ORIG, {
  clock: new Date("2026-09-10T12:00:00+08:00"),
  slotAnswers: {
    contentLang: ["te-IN", "ta-IN", "ml-IN"],
    result_layout: ["wide"],
  },
});

console.log(
  JSON.stringify(
    {
      status: r.status,
      sqlSource: r.sqlSource,
      verifySkipped: r.verifySkipped,
      message: r.message,
      timeEcho: r.timeEcho,
      cols: r.tables?.[0]?.cols,
      rowCount: r.tables?.[0]?.rows?.length,
      sampleRows: r.tables?.[0]?.rows?.slice(0, 3),
      sqlPreview: r.sqls?.[0]?.slice(0, 800),
      error: r.error,
    },
    null,
    2,
  ),
);

if (r.status !== "ok" || r.sqlSource !== "intent_compile") {
  process.exitCode = 1;
}
