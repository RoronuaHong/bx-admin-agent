import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectDimRole,
  detectOutputDims,
  formatGroundedHint,
  parseProbeValuesForDim,
  runAmbiguityGate,
} from "../src/analytics/ambiguity-gate.js";
import type { AnalyticsPack } from "../src/analytics/semantic-layer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../config/analytics");
const pack = JSON.parse(readFileSync(join(root, "watch-detail.pack.json"), "utf8")) as AnalyticsPack;

const ORIG =
  "统计 IndiaA 渠道 在 2026-08-19 至 2026-08-25 期间，按观看日期 + 渠道 维度，三种小语种用户观看视频最大进度的平均值，也就是完播率";

// 1) 原句：语言 filter_set 未接地 → clarify contentLang
{
  const g = runAmbiguityGate(ORIG, pack);
  assert.equal(g.ok, false);
  if (!g.ok) {
    assert.equal(g.slot, "contentLang");
    assert.match(g.clarify, /语言|语种|小语种/);
  }
}

// 2) 四种语言 — 同一规则
{
  const g = runAmbiguityGate("IndiaA 2026-08-19到25 四种语言用户完播率，也就是最大进度平均", pack);
  assert.equal(g.ok, false);
  if (!g.ok) assert.equal(g.slot, "contentLang");
}

// 3) 多种影片类型 — movieType filter_set
{
  const g = runAmbiguityGate("IndiaA 2026-08-19到25 多种影片类型观看人数", pack);
  assert.equal(g.ok, false);
  if (!g.ok) assert.equal(g.slot, "movieType");
}

// 4) 已列 locale + 输出维不含语言 → 先问宽/长表（通用布局，不贴金 SQL）
{
  const g = runAmbiguityGate(
    "IndiaA 2026-08-19到25 te-IN ta-IN ml-IN 最大进度平均值完播率 按观看日期和渠道",
    pack,
  );
  assert.equal(g.ok, false);
  if (!g.ok) {
    assert.equal(g.slot, "result_layout");
    assert.match(g.clarify, /宽表|长表/);
  }
}

// 5) 中文名别名接地后同样问布局
{
  const g = runAmbiguityGate(
    "IndiaA 2026-08-19到25 泰卢固、泰米尔、马拉雅拉姆用户最大进度平均完播率 按观看日期+渠道",
    pack,
  );
  assert.equal(g.ok, false);
  if (!g.ok) assert.equal(g.slot, "result_layout");
}

// 6) 按语言 → group_by，不拦、不问布局
{
  const nl = "IndiaA 2026-08-20到21 按语言看观看人数";
  assert.equal(detectDimRole(nl, pack.enumDimensions![0]!).role, "group_by");
  assert.equal(runAmbiguityGate(nl, pack).ok, true);
}

// 7) Top3 语言 → top_n，不拦
{
  const nl = "2026-08-20到21 观看人数最多的前3种语言";
  assert.equal(detectDimRole(nl, pack.enumDimensions![0]!).role, "top_n");
  assert.equal(runAmbiguityGate(nl, pack).ok, true);
}

// 8) 未提 movieType → default，不拦
{
  const g = runAmbiguityGate("IndiaA 2026-08-20到21 按天观看人数", pack);
  assert.equal(g.ok, true);
  if (g.ok) {
    assert.ok(g.groundedFilters.movieType?.includes("1"));
    assert.ok(g.notes.some((n) => /movieType: absent→default/.test(n)));
  }
}

// 9) 完播率无口径 → clarify metric
{
  const g = runAmbiguityGate("IndiaA 2026-08-19到25 完播率按天", pack);
  assert.equal(g.ok, false);
  if (!g.ok) assert.equal(g.slot, "completion_rate");
}

// 10) 语言 + 宽表布局回填 → pass；hint 只含结构词，不含 sumIf 金句
{
  const g = runAmbiguityGate(ORIG, pack, {
    slotAnswers: { contentLang: ["te-IN", "ta-IN", "ml-IN"], result_layout: ["wide"] },
  });
  assert.equal(g.ok, true);
  if (g.ok) {
    assert.deepEqual(g.groundedFilters.contentLang?.slice().sort(), ["ml-IN", "ta-IN", "te-IN"]);
    assert.ok(g.groundedMetrics.includes("avg_max_progress"));
    assert.equal(g.layout, "wide");
    assert.equal(g.pivotDim, "contentLang");
    const hint = formatGroundedHint(g);
    assert.match(hint, /WIDE|wide|pivot/i);
    assert.doesNotMatch(hint, /sumIf/);
    assert.doesNotMatch(hint, /maxWatchProgress AS a/);
  }
}

// 11) probe 解析
{
  const opts = parseProbeValuesForDim(
    "contentLang: te-IN, ta-IN, ml-IN, hi-IN\nchannel: IndiaA",
    "contentLang",
  );
  assert.equal(opts.length, 4);
  assert.equal(opts[0]?.id, "te-IN");
}

// 12) 「三种指标」不应误触发 contentLang
{
  assert.equal(runAmbiguityGate("IndiaA 2026-08-20到21 统计三种指标：人数、时长、次数", pack).ok, true);
}

// 13) 输出维检测
{
  const dims = detectOutputDims(ORIG, pack);
  assert.ok(dims.includes("watch_date"));
  assert.ok(dims.includes("channel"));
  assert.ok(!dims.includes("contentLang"));
}

console.log("analytics-ambiguity-gate.test.ts OK");
