/**
 * Live smoke: 完播率宽表（三种小语种）— 逐步对话，对齐 avg_of_max_wide 形状。
 */
import assert from "node:assert/strict";
import "dotenv/config";
import { analyticsAsk } from "../src/analytics/pipeline.js";

const ORIG =
  "统计 IndiaA 渠道 在 2026-08-19 至 2026-08-25 期间，按观看日期 + 渠道 维度，三种小语种用户观看视频最大进度的平均值，也就是完播率";

const clock = new Date("2026-09-11T12:00:00+08:00");

function brief(r: Awaited<ReturnType<typeof analyticsAsk>>, label: string) {
  console.log(
    "\n===" +
      label +
      "===\n" +
      JSON.stringify(
        {
          status: r.status,
          clarifySlot: r.clarifySlot,
          clarifyOptions: r.clarifyOptions?.slice(0, 8),
          message: r.message?.slice(0, 280),
          sqlSource: r.sqlSource,
          structuredFromConversation: r.structuredFromConversation,
          cols: r.tables?.[0]?.cols,
          rowCount: r.tables?.[0]?.rows?.length,
          sample: r.tables?.[0]?.rows?.slice(0, 2),
          sql: r.sqls?.[0],
        },
        null,
        2,
      ),
  );
  return r;
}

// Turn 1: 原问 — 期望 clarify 语言（三种小语种未列具体码）
const t1 = brief(
  await analyticsAsk(ORIG, {
    clock,
    messages: [{ role: "user", text: ORIG }],
  }),
  "T1_orig",
);

const messages: Array<{ role: "user" | "assistant"; text: string }> = [
  { role: "user", text: ORIG },
];

if (t1.status === "clarify") {
  assert.equal(t1.clarifySlot, "contentLang", `T1 should ask contentLang, got ${t1.clarifySlot}`);
  messages.push({ role: "assistant", text: t1.message });
  // 用户补三种语言
  const langReply = "te-IN、ta-IN、ml-IN";
  messages.push({ role: "user", text: langReply });
  const t2 = brief(
    await analyticsAsk(langReply, {
      clock,
      messages,
      slotAnswers: { contentLang: ["te-IN", "ta-IN", "ml-IN"] },
    }),
    "T2_langs",
  );

  if (t2.status === "clarify") {
    assert.equal(t2.clarifySlot, "result_layout", `T2 should ask result_layout, got ${t2.clarifySlot}`);
    messages.push({ role: "assistant", text: t2.message });
    // 若要宽/长表
    const layoutReply = "宽表";
    messages.push({ role: "user", text: layoutReply });
    const t3 = brief(
      await analyticsAsk(layoutReply, {
        clock,
        messages,
        slotAnswers: {
          contentLang: ["te-IN", "ta-IN", "ml-IN"],
          result_layout: ["wide"],
        },
      }),
      "T3_wide",
    );
    assertShape(t3);
  } else {
    assertShape(t2);
  }
} else {
  console.error("T1 expected clarify contentLang");
  process.exitCode = 1;
}

function assertShape(r: Awaited<ReturnType<typeof analyticsAsk>>) {
  const sql = r.sqls?.[0] || "";
  const checks = {
    ok: r.status === "ok",
    intentCompile: r.sqlSource === "intent_compile",
    hasSumIf: /sumIf/i.test(sql),
    hasCountIf: /countIf/i.test(sql),
    hasMaxProgress: /max\s*\(\s*maxWatchProgress\s*\)/i.test(sql),
    hasTe: /te-IN/.test(sql),
    hasTa: /ta-IN/.test(sql),
    hasMl: /ml-IN/.test(sql),
    hasIndiaA: /IndiaA/.test(sql),
    outerNoContentLangGrain: !/GROUP BY\s+watchDate\s*,\s*channel\s*,\s*contentLang/i.test(sql),
    colsWide: (r.tables?.[0]?.cols || []).some((c) => /te|ta|ml/i.test(c)),
  };
  console.log("\n===SHAPE_CHECKS===\n" + JSON.stringify(checks, null, 2));
  if (!checks.ok || !checks.intentCompile || !checks.hasSumIf || !checks.hasTe) {
    process.exitCode = 1;
  }
}
