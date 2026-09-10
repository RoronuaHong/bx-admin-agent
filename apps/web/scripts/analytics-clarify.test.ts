import assert from "node:assert/strict";
import {
  buildClarifyContinuation,
  looksLikeSlotOnlyReply,
} from "../src/analytics-clarify.ts";

const ORIG_TWO =
  "统计 IndiaA 渠道 在 2026-08-19 至 2026-08-25 期间，按观看日期 + 渠道 维度，两种小语种用户观看视频最大进度的平均值，也就是完播率";

// ok 后只回两种语言 → 合并原问，覆盖 contentLang
{
  const prior = [
    { role: "user" as const, text: ORIG_TWO },
    {
      role: "assistant" as const,
      status: "clarify",
      clarifySlot: "contentLang",
      text: "请确认语言",
    },
    { role: "user" as const, text: "ml-IN" },
    { role: "assistant" as const, status: "ok", text: "按 2026-08-19～2026-08-25" },
  ];
  assert.equal(looksLikeSlotOnlyReply("te-IN、ml-IN"), true);
  const r = buildClarifyContinuation(prior, "te-IN、ml-IN");
  assert.equal(r.text, ORIG_TWO);
  assert.deepEqual(r.slotAnswers?.contentLang?.slice().sort(), ["ml-IN", "te-IN"]);
  // 不应残留仅 ml-IN 的旧答案主导（覆盖后仍是这两种）
  assert.equal(r.slotAnswers?.contentLang?.length, 2);
}

// 活跃澄清链：短答合并
{
  const prior = [
    { role: "user" as const, text: ORIG_TWO },
    {
      role: "assistant" as const,
      status: "clarify",
      clarifySlot: "contentLang",
      text: "请确认语言",
    },
  ];
  const r = buildClarifyContinuation(prior, "te-IN、ml-IN");
  assert.equal(r.text, ORIG_TWO);
  assert.deepEqual(r.slotAnswers?.contentLang?.slice().sort(), ["ml-IN", "te-IN"]);
}

// 完整新问不应误合并
{
  const prior = [
    { role: "user" as const, text: ORIG_TWO },
    { role: "assistant" as const, status: "ok", text: "done" },
  ];
  const neu = "IndiaA 昨天观看人数";
  const r = buildClarifyContinuation(prior, neu);
  assert.equal(r.text, neu);
  assert.equal(r.slotAnswers, undefined);
}

// ok 后回宽表：保留原问 + layout
{
  const prior = [
    { role: "user" as const, text: ORIG_TWO },
    { role: "assistant" as const, status: "clarify", clarifySlot: "contentLang", text: "lang" },
    { role: "user" as const, text: "te-IN、ml-IN" },
    { role: "assistant" as const, status: "clarify", clarifySlot: "result_layout", text: "宽或长" },
    { role: "user" as const, text: "宽表" },
    { role: "assistant" as const, status: "ok", text: "ok" },
  ];
  // 再改语言
  const r = buildClarifyContinuation(prior, "ta-IN、te-IN");
  assert.equal(r.text, ORIG_TWO);
  assert.deepEqual(r.slotAnswers?.contentLang?.slice().sort(), ["ta-IN", "te-IN"]);
}

console.log("analytics-clarify.test.ts OK");
