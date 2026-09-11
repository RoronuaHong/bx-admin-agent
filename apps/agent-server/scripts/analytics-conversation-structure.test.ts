import assert from "node:assert/strict";
import {
  enforceStructurePolicy,
  formatConversationTranscript,
  impliesLangSetWithoutMembers,
  normalizeClarifySlot,
  parseStructureResponse,
} from "../src/analytics/conversation-structure.js";

{
  const t = formatConversationTranscript([
    { role: "user", text: "IndiaA 人均时长" },
    { role: "assistant", text: "请确认语言" },
    { role: "user", text: "te-IN、ml-IN" },
  ]);
  assert.match(t, /用户: IndiaA/);
  assert.match(t, /助手: 请确认语言/);
  assert.match(t, /用户: te-IN/);
}

{
  const ok = parseStructureResponse(`\`\`\`json
{
  "status": "ok",
  "mergedNl": "IndiaA 人均观看时长",
  "time": { "start": "2026-08-19", "end": "2026-08-25" },
  "filters": { "channel": ["IndiaA"], "contentLang": ["te-IN", "ml-IN"], "movieType": ["1","2"] },
  "outputDims": ["watch_date", "channel"],
  "metricId": "avg_watch_second_per_user"
}
\`\`\``);
  assert.equal(ok.status, "ok");
  if (ok.status === "ok") {
    assert.equal(ok.metricId, "avg_watch_second_per_user");
    assert.deepEqual(ok.filters.channel, ["IndiaA"]);
    assert.equal(ok.layout, undefined);
  }
}

{
  const c = parseStructureResponse(
    JSON.stringify({
      status: "ok",
      mergedNl: "完播率按天渠道 三种语言",
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { contentLang: ["a", "b", "c"], channel: ["IndiaA"] },
      outputDims: ["watch_date", "channel"],
      metricId: "avg_max_progress",
    }),
    "完播率按天渠道 三种语言 IndiaA",
  );
  assert.equal(c.status, "clarify");
  if (c.status === "clarify") assert.equal(c.clarifySlot, "contentLang");
}

{
  assert.equal(normalizeClarifySlot("layout"), "result_layout");
  assert.equal(impliesLangSetWithoutMembers("三种小语种用户完播率"), true);
  assert.equal(impliesLangSetWithoutMembers("te-IN、ta-IN、ml-IN 完播率"), false);
}

{
  const ORIG =
    "统计 IndiaA 渠道 在 2026-08-19 至 2026-08-25 期间，按观看日期 + 渠道 维度，三种小语种用户观看视频最大进度的平均值，也就是完播率";
  const coerced = enforceStructurePolicy(
    {
      status: "clarify",
      clarify: "请选宽表或长表",
      clarifySlot: "layout",
      time: { start: "2026-08-19", end: "2026-08-25" },
      partialFilters: { channel: ["IndiaA"], contentLang: ["te-IN", "ta-IN", "ml-IN"] },
    },
    formatConversationTranscript([{ role: "user", text: ORIG }]),
  );
  assert.equal(coerced.status, "clarify");
  if (coerced.status === "clarify") {
    assert.equal(coerced.clarifySlot, "contentLang");
    assert.equal(coerced.partialFilters?.contentLang, undefined);
  }
}

{
  const transcript = formatConversationTranscript([
    {
      role: "user",
      text: "统计 IndiaA 2026-08-19到25 三种小语种完播率按天渠道",
    },
    { role: "assistant", text: "请确认语言" },
    { role: "user", text: "te-IN、ta-IN、ml-IN" },
  ]);
  const r = parseStructureResponse(
    JSON.stringify({
      status: "ok",
      mergedNl: "IndiaA 三种小语种完播率 te-IN ta-IN ml-IN",
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: {
        channel: ["IndiaA"],
        contentLang: ["te-IN", "ta-IN", "ml-IN"],
      },
      outputDims: ["watch_date", "channel"],
      metricId: "avg_max_progress",
    }),
    transcript,
  );
  assert.equal(r.status, "clarify");
  if (r.status === "clarify") assert.equal(r.clarifySlot, "result_layout");
}

{
  const transcript = formatConversationTranscript([
    { role: "user", text: "IndiaA 2026-08-19到25 te-IN ta-IN ml-IN 完播率按天渠道" },
    { role: "user", text: "宽表" },
  ]);
  const r = parseStructureResponse(
    JSON.stringify({
      status: "ok",
      mergedNl: "完播宽表",
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: {
        channel: ["IndiaA"],
        contentLang: ["te-IN", "ta-IN", "ml-IN"],
      },
      outputDims: ["watch_date", "channel"],
      metricId: "avg_max_progress",
      layout: "wide",
      pivotDim: "contentLang",
    }),
    transcript,
  );
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.layout, "wide");
}

console.log("analytics-conversation-structure.test.ts OK");
