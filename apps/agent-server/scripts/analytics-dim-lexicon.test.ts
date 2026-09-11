/**
 * Dim lexicon + resolve unit tests (zero network) + optional live Metabase checks.
 * 运行：tsx scripts/analytics-dim-lexicon.test.ts
 * 带网络：ANALYTICS_LIVE_LEXICON=1 tsx scripts/analytics-dim-lexicon.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import {
  buildDimLexicon,
  extractLabelsFromText,
  parseDescriptionMapping,
  parseFieldValuesRows,
  resolveDimTokens,
} from "../src/analytics/dim-lexicon.js";
import { compileAnalyticsIntent } from "../src/analytics/sql-compile.js";
import { buildAnalyticsIntentFromStructure } from "../src/analytics/intent.js";
import type { AnalyticsPack } from "../src/analytics/semantic-layer.js";
import { clearDimLexiconCache, resolveDimensionValues, resolvePackFilters } from "../src/analytics/dim-resolve.js";

const DESC =
  "映射关系：1:电影，2:电视剧，3:真人秀，4:短剧，5:比赛直播，6:电视直播，7:预告片，8:自制广告，9:第三方广告，10:动漫，11:肥皂剧";

const VALUES = [
  [0, "未知"],
  [1, "电影"],
  [2, "电视剧"],
  [3, "真人秀"],
  [4, "短剧"],
  [5, "比赛直播"],
  [6, "电视直播"],
  [7, "预告片"],
  [8, "自制广告"],
  [9, "第三方广告"],
  [10, "动漫"],
];

{
  const parsed = parseDescriptionMapping(DESC);
  assert.equal(parsed.find((e) => e.code === "1")?.label, "电影");
  assert.equal(parsed.find((e) => e.code === "11")?.label, "肥皂剧");
  assert.ok(parsed.length >= 11);
}

{
  const rows = parseFieldValuesRows(VALUES);
  assert.equal(rows[1]?.label, "电影");
  assert.equal(rows.length, 11);
}

{
  const lex = buildDimLexicon({ field: "movieType", valuesRows: VALUES, description: DESC });
  assert.equal(lex.remapped, true);
  assert.ok(lex.codes.has("11"), "description fills 肥皂剧=11 missing from values API");
  const r = resolveDimTokens(
    ["电影", "电视剧", "真人秀", "短剧", "动漫", "肥皂剧"],
    lex,
  );
  assert.deepEqual(r.unresolved, []);
  assert.deepEqual(r.resolved.sort((a, b) => Number(a) - Number(b)), ["1", "2", "3", "4", "10", "11"]);
}

{
  const lex = buildDimLexicon({ field: "movieType", valuesRows: VALUES, description: DESC });
  const nl =
    "指定影片类型为电影，电视剧，真人秀，短剧，动漫，肥皂剧，四种内容语言的人均观看时长";
  const codes = extractLabelsFromText(nl, lex);
  assert.deepEqual(codes.sort((a, b) => Number(a) - Number(b)), ["1", "2", "3", "4", "10", "11"]);
}

{
  const lex = buildDimLexicon({
    field: "contentLang",
    valuesRows: [["ta-IN"], ["te-IN"], [""]],
  });
  assert.equal(lex.remapped, false);
  const r = resolveDimTokens(["ta-IN", "te-IN"], lex);
  assert.deepEqual(r.resolved, ["ta-IN", "te-IN"]);
}

// compile gate: Chinese movieType must fail (never emit bare identifiers)
{
  const pack = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../config/analytics/watch-detail.pack.json"),
      "utf8",
    ),
  ) as AnalyticsPack;
  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: {
        channel: ["IndiaA"],
        movieType: ["电影", "电视剧"],
        contentLang: ["", "ta-IN"],
      },
      outputDims: ["watch_date", "channel"],
      metricId: "avg_watch_second_per_user",
    },
    pack,
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  const compiled = compileAnalyticsIntent(built.intent, pack);
  assert.equal(compiled.ok, false);
  if (compiled.ok) throw new Error("expected compile fail");
  assert.match(compiled.reason, /filter_movieType_not_numeric/);
}

// compile success after numeric resolve
{
  const pack = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../config/analytics/watch-detail.pack.json"),
      "utf8",
    ),
  ) as AnalyticsPack;
  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: {
        channel: ["IndiaA"],
        movieType: ["1", "2", "3", "4", "10", "11"],
        contentLang: ["", "ta-IN", "te-IN", "ml-IN"],
      },
      outputDims: ["watch_date", "channel"],
      metricId: "avg_watch_second_per_user",
    },
    pack,
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  const compiled = compileAnalyticsIntent(built.intent, pack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  assert.match(compiled.sql, /movieType\s+IN\s*\(\s*1\s*,\s*2\s*,\s*3\s*,\s*4\s*,\s*10\s*,\s*11\s*\)/);
  assert.doesNotMatch(compiled.sql, /电影/);
}

console.log("analytics-dim-lexicon unit: PASS");

const live = process.env.ANALYTICS_LIVE_LEXICON === "1";
if (live) {
  const pack = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../config/analytics/watch-detail.pack.json"),
      "utf8",
    ),
  ) as AnalyticsPack;

  clearDimLexiconCache();
  const runs: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await resolveDimensionValues({
      pack,
      field: "movieType",
      tokens: ["电影", "电视剧", "真人秀", "短剧", "动漫", "肥皂剧"],
    });
    assert.equal(r.ok, true, `live resolve round ${i + 1}: ${r.error || r.unresolved.join(",")}`);
    assert.deepEqual(
      r.resolved.slice().sort((a, b) => Number(a) - Number(b)),
      ["1", "2", "3", "4", "10", "11"],
    );
    runs.push(r.resolved.join(","));
  }
  assert.equal(runs[0], runs[1]);
  assert.equal(runs[1], runs[2]);

  const grounded = await resolvePackFilters({
    pack,
    filters: {
      channel: ["IndiaA"],
      movieType: ["电影", "电视剧", "真人秀", "短剧", "动漫", "肥皂剧"],
      contentLang: ["", "ta-IN", "te-IN", "ml-IN"],
    },
    nl: "按观看日期和渠道分组，统计 IndiaA … 指定影片类型为电影，电视剧，真人秀，短剧，动漫，肥皂剧 …",
  });
  assert.equal(grounded.status, "ok");
  if (grounded.status !== "ok") throw new Error("ground failed");
  assert.deepEqual(
    grounded.filters.movieType!.slice().sort((a, b) => Number(a) - Number(b)),
    ["1", "2", "3", "4", "10", "11"],
  );

  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: grounded.filters,
      outputDims: ["watch_date", "channel"],
      metricId: "avg_watch_second_per_user",
    },
    pack,
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  const compiled = compileAnalyticsIntent(built.intent, pack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error(compiled.reason);
  assert.doesNotMatch(compiled.sql, /电影|电视剧|真人秀/);
  console.log("analytics-dim-lexicon LIVE x3: PASS");
  console.log(compiled.sql);
}
