/**
 * Step-by-step live demo: 完播率宽表三轮澄清。
 * Prints full result per turn for review.
 */
import "dotenv/config";
import { analyticsAsk } from "../src/analytics/pipeline.js";

const ORIG =
  "统计 IndiaA 渠道 在 2026-08-19 至 2026-08-25 期间，按观看日期 + 渠道 维度，三种小语种用户观看视频最大进度的平均值，也就是完播率";

const clock = new Date("2026-09-11T12:00:00+08:00");

function dump(label: string, userInput: string, r: Awaited<ReturnType<typeof analyticsAsk>>) {
  const out = {
    step: label,
    userInput,
    status: r.status,
    clarifySlot: r.clarifySlot,
    clarifyOptions: r.clarifyOptions,
    message: r.message,
    timeEcho: r.timeEcho,
    sqlSource: r.sqlSource,
    structuredFromConversation: r.structuredFromConversation,
    cols: r.tables?.[0]?.cols,
    rowCount: r.tables?.[0]?.rows?.length,
    sampleRows: r.tables?.[0]?.rows?.slice(0, 3),
    sql: r.sqls?.[0],
    error: r.error,
  };
  console.log("\n" + "=".repeat(72));
  console.log(JSON.stringify(out, null, 2));
  return r;
}

const messages: Array<{ role: "user" | "assistant"; text: string }> = [];

// ---- Step 1 ----
messages.push({ role: "user", text: ORIG });
const t1 = dump(
  "STEP1_原问",
  ORIG,
  await analyticsAsk(ORIG, { clock, messages: [...messages] }),
);

if (t1.status !== "clarify") {
  console.log("\n[ABORT] STEP1 预期 clarify，实际", t1.status);
  process.exit(1);
}
messages.push({ role: "assistant", text: t1.message });

// ---- Step 2 ----
const langReply = "te-IN、ta-IN、ml-IN";
messages.push({ role: "user", text: langReply });
const t2 = dump(
  "STEP2_补语言",
  langReply,
  await analyticsAsk(langReply, {
    clock,
    messages: [...messages],
    slotAnswers: { contentLang: ["te-IN", "ta-IN", "ml-IN"] },
  }),
);

if (t2.status === "clarify") {
  messages.push({ role: "assistant", text: t2.message });
  // ---- Step 3 ----
  const layoutReply = "宽表";
  messages.push({ role: "user", text: layoutReply });
  const t3 = dump(
    "STEP3_选宽表",
    layoutReply,
    await analyticsAsk(layoutReply, {
      clock,
      messages: [...messages],
      slotAnswers: {
        contentLang: ["te-IN", "ta-IN", "ml-IN"],
        result_layout: ["wide"],
      },
    }),
  );
  if (t3.status !== "ok") process.exitCode = 1;
} else if (t2.status === "ok") {
  console.log("\n[NOTE] STEP2 已直接 ok（未再问 layout）");
} else {
  process.exitCode = 1;
}

console.log("\n" + "=".repeat(72));
console.log("DONE");
