import assert from "node:assert/strict";
import {
  buildClarifyContinuation,
  looksLikeSlotOnlyReply,
  resolveOptionIndexes,
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

// 序号短答 → slotAnswers
{
  const prior = [
    { role: "user" as const, text: ORIG_TWO },
    {
      role: "assistant" as const,
      status: "clarify",
      clarifySlot: "contentLang",
      text: "请确认语言",
      clarifyOptions: [
        { id: "(empty)", label: "1. 空（未标注）" },
        { id: "ta-IN", label: "2. ta-IN" },
        { id: "te-IN", label: "3. te-IN" },
        { id: "ml-IN", label: "4. ml-IN" },
      ],
    },
  ];
  const r = buildClarifyContinuation(prior, "2,3,4");
  assert.equal(r.text, ORIG_TWO);
  assert.deepEqual(r.slotAnswers?.contentLang, ["ta-IN", "te-IN", "ml-IN"]);
}

{
  const prior = [
    { role: "user" as const, text: ORIG_TWO },
    {
      role: "assistant" as const,
      status: "clarify",
      clarifySlot: "result_layout",
      text: "宽或长",
      clarifyOptions: [
        { id: "wide", label: "1. 宽表" },
        { id: "long", label: "2. 长表" },
      ],
    },
  ];
  const r = buildClarifyContinuation(prior, "1");
  assert.deepEqual(r.slotAnswers?.result_layout, ["wide"]);
}

{
  const ORIG_TWO =
    "统计 IndiaA 渠道 在 2026-08-19 至 2026-08-25 期间，按观看日期 + 渠道 维度，两种小语种用户观看视频最大进度的平均值，也就是完播率";
  // 宽表序号短答时，不得丢掉上一轮已选语言
  const prior = [
    { role: "user" as const, text: ORIG_TWO },
    {
      role: "assistant" as const,
      status: "clarify",
      clarifySlot: "contentLang",
      text: "请确认语言",
      clarifyOptions: [
        { id: "ta-IN", label: "1. ta-IN" },
        { id: "te-IN", label: "2. te-IN" },
        { id: "ml-IN", label: "3. ml-IN" },
      ],
    },
    { role: "user" as const, text: "1,2,3" },
    {
      role: "assistant" as const,
      status: "clarify",
      clarifySlot: "result_layout",
      text: "宽或长",
      clarifyOptions: [
        { id: "wide", label: "1. 宽表" },
        { id: "long", label: "2. 长表" },
      ],
    },
  ];
  const r = buildClarifyContinuation(prior, "1");
  assert.equal(r.text, ORIG_TWO);
  assert.deepEqual(r.slotAnswers?.result_layout, ["wide"]);
  assert.deepEqual(r.slotAnswers?.contentLang?.slice().sort(), ["ml-IN", "ta-IN", "te-IN"]);
}

{
  // movieType：回「10」应匹配 option id，而不是第 10 个序号
  const ids = resolveOptionIndexes("10", [
    { id: "1", label: "1. 1" },
    { id: "2", label: "2. 2" },
    { id: "10", label: "3. 10" },
  ]);
  assert.deepEqual(ids, ["10"]);
}

{
  const prior = [
    { role: "user" as const, text: ORIG_TWO },
    {
      role: "assistant" as const,
      status: "clarify",
      clarifySlot: "contentLang",
      text: "请确认语言",
      clarifyOptions: [
        { id: "(empty)", label: "1. 英语" },
        { id: "ta-IN", label: "2. ta-IN" },
        { id: "te-IN", label: "3. te-IN" },
        { id: "ml-IN", label: "4. ml-IN" },
      ],
    },
  ];
  const r = buildClarifyContinuation(prior, "全部");
  assert.deepEqual(r.slotAnswers?.contentLang, ["(empty)", "ta-IN", "te-IN", "ml-IN"]);
}

{
  const prior = [
    { role: "user" as const, text: "2026-08-19 到 2026-08-25 成交了多少" },
    {
      role: "assistant" as const,
      status: "clarify",
      clarifySlot: "table",
      text: "请选择表",
      clarifyOptions: [
        { id: "elt_watch_detail", label: "1. elt_watch_detail" },
        { id: "elt_film_order", label: "2. elt_film_order" },
      ],
    },
  ];
  const typed = buildClarifyContinuation(prior, "elt_film_order");
  assert.deepEqual(typed.slotAnswers?.table, ["elt_film_order"]);
  const picked = buildClarifyContinuation(prior, "2");
  assert.deepEqual(picked.slotAnswers?.table, ["elt_film_order"]);
}

console.log("analytics-clarify.test.ts OK");
