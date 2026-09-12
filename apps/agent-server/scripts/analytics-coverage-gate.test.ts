/**
 * Coverage Gate: NL-grounded filters backfill schema omissions.
 * Run: tsx scripts/analytics-coverage-gate.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCoverageGate, groundFiltersFromNl } from "../src/analytics/coverage-gate.js";
import { buildDimLexicon, extractCodesFromText } from "../src/analytics/dim-lexicon.js";
import type { AnalyticsPack } from "../src/analytics/semantic-layer.js";

const pack = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../config/analytics/watch-detail.pack.json"),
    "utf8",
  ),
) as AnalyticsPack;

const channelLex = buildDimLexicon({
  field: "channel",
  valuesRows: [["IndiaA"], ["FoxA"], ["GoGo"], ["India2"]],
});

{
  const codes = extractCodesFromText("IndiaA 2026-08 同比观看人数", channelLex);
  assert.deepEqual(codes, ["IndiaA"]);
}

{
  const codes = extractCodesFromText("八月二十到二十一FoxA和IndiaA", channelLex);
  assert.deepEqual(codes.slice().sort(), ["FoxA", "IndiaA"]);
}

{
  const grounded = groundFiltersFromNl({
    nl: "IndiaA 2026-08 同比观看人数",
    pack,
    lexicons: { channel: channelLex },
  });
  assert.deepEqual(grounded.channel, ["IndiaA"]);
}

{
  const grounded = groundFiltersFromNl({
    nl: "印度A 2026-08 同比观看人数",
    pack,
  });
  assert.deepEqual(grounded.channel, ["IndiaA"]);
}

{
  const r = applyCoverageGate({
    filters: {},
    nl: "IndiaA 2026-08 同比观看人数",
    pack,
    lexicons: { channel: channelLex },
  });
  assert.deepEqual(r.filters.channel, ["IndiaA"]);
  assert.ok(r.notes.some((n) => n.startsWith("coverage_backfill:channel:IndiaA")));
}

{
  const r = applyCoverageGate({
    filters: { channel: ["IndiaA"] },
    nl: "IndiaA 2026-08 同比观看人数",
    pack,
    lexicons: { channel: channelLex },
  });
  assert.deepEqual(r.filters.channel, ["IndiaA"]);
  assert.equal(r.notes.length, 0);
}

{
  const r = applyCoverageGate({
    filters: { channel: ["IndiaA"] },
    nl: "IndiaA 在 2026-08-19 至 2026-08-25，te-IN 观看人数按天",
    pack,
    lexicons: { channel: channelLex },
  });
  assert.deepEqual(r.filters.contentLang, ["te-IN"]);
  assert.ok(r.notes.some((n) => n.includes("contentLang")));
}

{
  const movieLex = buildDimLexicon({
    field: "movieType",
    valuesRows: [
      [1, "电影"],
      [2, "电视剧"],
    ],
    description: "1:电影，2:电视剧",
  });
  const r = applyCoverageGate({
    filters: {},
    nl: "电影观看人数按天 2026-08-19 到 2026-08-21",
    pack,
    lexicons: { movieType: movieLex },
  });
  assert.deepEqual(r.filters.movieType, ["1"]);
}

{
  const orderPack = {
    ...pack,
    warehouse: {
      tables: [
        {
          schema: "film_report",
          name: "elt_film_order",
          fields: ["createdTime", "amount"],
        },
      ],
    },
  };
  const r = applyCoverageGate({
    filters: {},
    nl: "IndiaA 查 elt_film_order 订单数",
    pack: orderPack,
    lexicons: { channel: channelLex },
    table: "elt_film_order",
  });
  assert.ok(!r.filters.channel);
  assert.equal(r.notes.length, 0);
}

console.log("analytics-coverage-gate.test.ts OK");
