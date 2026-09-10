import "dotenv/config";
import { buildClarifyContinuation } from "../../web/src/analytics-clarify.ts";
import { analyticsAsk } from "../src/analytics/pipeline.js";

const ORIG =
  "统计 IndiaA 渠道 在 2026-08-19 至 2026-08-25 期间，按观看日期 + 渠道 维度，两种小语种用户观看视频最大进度的平均值，也就是完播率";

const prior = [
  { role: "user" as const, text: ORIG },
  { role: "assistant" as const, status: "clarify", clarifySlot: "contentLang", text: "lang" },
  { role: "user" as const, text: "ml-IN" },
  { role: "assistant" as const, status: "ok", text: "done" },
];

const payload = buildClarifyContinuation(prior, "te-IN、ml-IN");
console.log("payload", JSON.stringify(payload, null, 2));

const r = await analyticsAsk(payload.text, {
  clock: new Date("2026-09-10T12:00:00+08:00"),
  slotAnswers: {
    ...(payload.slotAnswers || {}),
    result_layout: ["wide"],
  },
});

console.log(
  JSON.stringify(
    {
      status: r.status,
      sqlSource: r.sqlSource,
      cols: r.tables?.[0]?.cols,
      rows: r.tables?.[0]?.rows?.length,
      message: r.message,
      clarifySlot: r.clarifySlot,
      sqlHasTe: /te-IN/.test(r.sqls?.[0] || ""),
      sqlHasMl: /ml-IN/.test(r.sqls?.[0] || ""),
      askedDate: /日期范围/.test(r.message || ""),
    },
    null,
    2,
  ),
);

if (r.status !== "ok" || r.sqlSource !== "intent_compile" || !/te-IN/.test(r.sqls?.[0] || "")) {
  process.exitCode = 1;
}
