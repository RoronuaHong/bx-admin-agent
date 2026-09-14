import assert from "node:assert/strict";
import {
  enforceStructurePolicy,
  extractLocalesFromText,
  formatConversationTranscript,
  impliesLangSetWithoutMembers,
  impliesMovieTypeSetWithoutMembers,
  neededProbeFields,
  needsDimensionProbe,
  normalizeClarifySlot,
  parseStructureResponse,
  userDemandsLangFilter,
} from "../src/analytics/conversation-structure.js";

{
  const four = extractLocalesFromText(
    [
      "从观看明细表 elt_watch_detail 中，筛选出观看日期在 2026-08-19 到 2026-08-25 之间、渠道为 IndiaA、影片类型属于 1/2/3/4/10/11 的记录。",
      "对每一组，分别按内容语言做条件聚合，计算人均观看时长：",
      "英语（contentLang=''）的人均时长；",
      "泰卢固语（te-IN）的人均时长；",
      "泰米尔语（ta-IN）的人均时长；",
      "马拉雅拉姆语（ml-IN）的人均时长。",
    ].join("\n"),
  );
  assert.deepEqual(four, ["(empty)", "te-IN", "ta-IN", "ml-IN"]);
  assert.deepEqual(extractLocalesFromText("IndiaA 英语人均观看时长"), ["(empty)"]);
  assert.deepEqual(extractLocalesFromText("te-IN、ta-IN、ml-IN 完播率"), ["te-IN", "ta-IN", "ml-IN"]);
}

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
  assert.equal(needsDimensionProbe("三种小语种用户完播率"), true);
  assert.equal(needsDimensionProbe("电影观看人数"), true);
  assert.equal(needsDimensionProbe("IndiaA 上周观看人数"), false);
  assert.deepEqual(neededProbeFields("三种小语种用户完播率"), ["contentLang"]);
  assert.deepEqual(neededProbeFields("电影观看人数"), ["movieType"]);
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

{
  // 澄清选择确定性落槽：模型漏填 filters 时仍能从 transcript 回填
  const r = enforceStructurePolicy(
    {
      status: "ok",
      mergedNl: "完播率",
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"] },
      outputDims: ["watch_date", "channel"],
      metricId: "avg_max_progress",
    },
    formatConversationTranscript([
      {
        role: "user",
        text: "三种小语种完播率 IndiaA 2026-08-19 至 2026-08-25 按天+渠道",
      },
      { role: "user", text: "澄清选择：contentLang=(empty),ta-IN,te-IN；result_layout=wide" },
    ]),
  );
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.deepEqual(r.filters.contentLang?.slice().sort(), ["(empty)", "ta-IN", "te-IN"]);
    assert.equal(r.layout, "wide");
    assert.equal(r.pivotDim, "contentLang");
  }
}

{
  // 用户回「全部」：从上一轮助手候选落地，不再因原问「四种语言」被政策拦下
  const transcript = formatConversationTranscript([
    {
      role: "user",
      text: "IndiaA 2026-08-19到25 四种内容语言人均观看时长 按天渠道",
    },
    {
      role: "assistant",
      text: "请确认语言\n候选：\n1. 英语（contentLang 为空）\n2. ta-IN\n3. te-IN\n4. ml-IN\ncontentLang: (empty), ta-IN, te-IN, ml-IN",
    },
    { role: "user", text: "全部" },
  ]);
  const r = enforceStructurePolicy(
    {
      status: "ok",
      mergedNl: "IndiaA 四种内容语言人均观看时长",
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"], contentLang: ["(empty)", "ta-IN", "te-IN", "ml-IN"] },
      outputDims: ["watch_date", "channel"],
      metricId: "avg_watch_second_per_user",
    },
    transcript,
  );
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.deepEqual(r.filters.contentLang?.slice().sort(), ["(empty)", "ml-IN", "ta-IN", "te-IN"]);
    // 非 pivot 指标 + 多语言成员确认 + 不按语言分组 → 自动宽表（per-value 条件聚合展开）
    assert.equal(r.layout, "wide");
    assert.equal(r.pivotDim, "contentLang");
  }
}

{
  // 模型漏填英语空串时，按用户原文回填四种语言并走宽表
  const origin = [
    "从观看明细表 elt_watch_detail 中，筛选出观看日期在 2026-08-19 到 2026-08-25 之间、渠道为 IndiaA 的记录。",
    "英语（contentLang=''）的人均时长；泰卢固语（te-IN）；泰米尔语（ta-IN）；马拉雅拉姆语（ml-IN）。",
  ].join("\n");
  const r = enforceStructurePolicy(
    {
      status: "ok",
      mergedNl: origin,
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"], contentLang: ["te-IN", "ta-IN", "ml-IN"] },
      outputDims: ["watch_date", "channel"],
      metricId: "avg_watch_second_per_user",
    },
    formatConversationTranscript([{ role: "user", text: origin }]),
  );
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.deepEqual(r.filters.contentLang, ["(empty)", "te-IN", "ta-IN", "ml-IN"]);
    assert.equal(r.layout, "wide");
    assert.equal(r.pivotDim, "contentLang");
  }
}

{
  // 单语言成员：普通筛选，不得触发宽表展开
  const r = enforceStructurePolicy(
    {
      status: "ok",
      mergedNl: "IndiaA 英语人均观看时长",
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"], contentLang: ["(empty)"] },
      outputDims: ["watch_date", "channel"],
      metricId: "avg_watch_second_per_user",
    },
    formatConversationTranscript([{ role: "user", text: "IndiaA 英语人均观看时长 2026-08-19至25" }]),
  );
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.layout, undefined);
    assert.equal(r.pivotDim, undefined);
  }
}

{
  // 按语言分组（outputDims 含 contentLang）：走长表 GROUP BY，不得触发宽表展开
  const r = enforceStructurePolicy(
    {
      status: "ok",
      mergedNl: "IndiaA 按语言分组人均观看时长",
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"], contentLang: ["(empty)", "te-IN", "ta-IN", "ml-IN"] },
      outputDims: ["watch_date", "channel", "contentLang"],
      metricId: "avg_watch_second_per_user",
    },
    formatConversationTranscript([
      { role: "user", text: "IndiaA 按语言分组统计人均观看时长 2026-08-19至25" },
    ]),
  );
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.layout, undefined);
    assert.equal(r.pivotDim, undefined);
  }
}

{
  assert.equal(userDemandsLangFilter("IndiaA 按天观看人数"), false);
  assert.equal(userDemandsLangFilter("按语言看人均时长"), true);
  assert.equal(userDemandsLangFilter("三种小语种完播率"), true);
}

{
  assert.equal(impliesMovieTypeSetWithoutMembers("多种影片类型观看人数"), true);
  assert.equal(impliesMovieTypeSetWithoutMembers("电影的观看人数按天"), false);
  const r = parseStructureResponse(
    JSON.stringify({
      status: "ok",
      mergedNl: "多种影片类型观看人数",
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"], movieType: ["1", "2"] },
      outputDims: ["watch_date"],
      metricId: "uniq_users",
    }),
    "多种影片类型观看人数",
  );
  assert.equal(r.status, "clarify");
  if (r.status === "clarify") assert.equal(r.clarifySlot, "movieType");
}

{
  // 同会话新问：历史「三种小语种」不得再逼 contentLang
  const transcript = formatConversationTranscript([
    { role: "user", text: "IndiaA 2026-08-19到25 三种小语种完播率按天" },
    { role: "assistant", text: "请确认指标口径" },
    { role: "user", text: "电影的观看人数按天" },
  ]);
  const r = parseStructureResponse(
    JSON.stringify({
      status: "ok",
      mergedNl: "三种小语种完播率 电影的观看人数按天",
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"] },
      outputDims: ["watch_date"],
      metricId: "uniq_users",
    }),
    transcript,
  );
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.filters.contentLang, undefined);
}

{
  // baseline: model invents contentLang clarify → drop and promote when metric+time clear
  const transcript = formatConversationTranscript([
    { role: "user", text: "IndiaA 在 2026-08-19 至 2026-08-25 按天观看人数" },
  ]);
  const r = enforceStructurePolicy(
    {
      status: "clarify",
      clarify: "请选择内容语言",
      clarifySlot: "contentLang",
      time: { start: "2026-08-19", end: "2026-08-25" },
      partialFilters: { channel: ["IndiaA"], contentLang: ["te-IN"] },
      mergedNl: "IndiaA 按天观看人数",
    },
    transcript,
  );
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.metricId, "uniq_users");
    assert.equal(r.filters.contentLang, undefined);
    assert.ok(r.notes?.includes("dropped_spurious_contentLang_clarify"));
  }
}

console.log("analytics-conversation-structure.test.ts OK");
