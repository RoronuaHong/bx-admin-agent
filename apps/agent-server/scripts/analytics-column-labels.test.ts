/**
 * NL → result column titles.
 * Run: tsx scripts/analytics-column-labels.test.ts
 */
import assert from "node:assert/strict";
import { extractNlFieldLabels, relabelAnalyticsCols } from "../src/analytics/column-labels.js";

const ORIGIN = [
  "从观看明细表 elt_watch_detail 中，筛选出观看日期在 2026-08-19 到 2026-08-25 之间、渠道为 IndiaA、影片类型属于 1/2/3/4/10/11 的记录。",
  "按观看日期（由 lastWatchTime 转换而来）和渠道分组。",
  "英语（contentLang=''）的人均时长；",
  "泰卢固语（te-IN）的人均时长；",
  "泰米尔语（ta-IN）的人均时长；",
  "马拉雅拉姆语（ml-IN）的人均时长。",
].join("\n");

{
  const hits = extractNlFieldLabels(ORIGIN);
  const byCode = Object.fromEntries(hits.map((h) => [h.code || "(empty)", h.label]));
  assert.equal(byCode["(empty)"], "英语");
  assert.equal(byCode["te-IN"], "泰卢固语");
  assert.equal(byCode["ta-IN"], "泰米尔语");
  assert.equal(byCode["ml-IN"], "马拉雅拉姆语");
  assert.equal(byCode.watchDate, "观看日期");
  assert.equal(byCode.channel, "渠道");
}

{
  const titles = relabelAnalyticsCols(ORIGIN, ["watchDate", "channel", "ml_IN", "ta_IN", "te_IN"]);
  assert.deepEqual(titles, ["观看日期", "渠道", "马拉雅拉姆语", "泰米尔语", "泰卢固语"]);
}

{
  const titles = relabelAnalyticsCols(ORIGIN, ["watchDate", "channel", "en", "te_IN", "ta_IN", "ml_IN"]);
  assert.deepEqual(titles, ["观看日期", "渠道", "英语", "泰卢固语", "泰米尔语", "马拉雅拉姆语"]);
}

{
  const titles = relabelAnalyticsCols("IndiaA 昨天观看人数", ["watchDate", "users"]);
  assert.deepEqual(titles, ["watchDate", "users"]);
}

console.log("analytics-column-labels.test.ts OK");
