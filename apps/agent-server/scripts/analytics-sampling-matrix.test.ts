/**
 * 全场景抽样覆盖矩阵自检（生产就绪广度门）。
 * 纯静态读 seed；不连 LLM/DB，CI 无 Metabase 也能跑。
 * Run: tsx scripts/analytics-sampling-matrix.test.ts
 *
 * 目的：把"全场景抽样"从隐性变显性——任何核心场景（多语言宽表人均/起播/完播、
 * 付费率、留存、多SQL拆表、影片类型多值、口语化长问法）若缺少 gold 可答用例，
 * 本测试失败，倒逼 eval 金样集保持生产级广度。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(__dir, "../config/analytics/eval/seed-v1.json");
const seed = JSON.parse(readFileSync(SEED_PATH, "utf8"));
const cases: any[] = Array.isArray(seed.cases) ? seed.cases : [];

const gold = cases.filter(
  (c) => c.should_refuse !== true && String(c.reviewStatus || "").toLowerCase() === "gold",
);

function goldText(c: any): string {
  return Array.isArray(c.goldSqls) ? c.goldSqls.join("\n") : "";
}

type Scene = { key: string; label: string; test: (c: any) => boolean };
const SCENES: Scene[] = [
  {
    key: "wide_avg_per_user",
    label: "多语言宽表·人均时长(sumIf/uniqIf 各列)",
    test: (c) =>
      /sumIf\(\s*watchSecond/i.test(goldText(c)) &&
      /uniqIf\(\s*guid,\s*contentLang\s*=\s*'te-IN'/i.test(goldText(c)),
  },
  {
    key: "wide_uniq",
    label: "多语言宽表·起播人数(uniqIf 各列)",
    test: (c) =>
      /uniqIf\(\s*guid,\s*contentLang\s*=\s*'te-IN'/i.test(goldText(c)) &&
      !/sumIf\(\s*watchSecond/i.test(goldText(c)),
  },
  {
    key: "wide_completion",
    label: "多语言宽表·完播率(maxWatchProgress)",
    test: (c) => /maxWatchProgress/i.test(goldText(c)) && /sumIf\(\s*a/i.test(goldText(c)),
  },
  {
    key: "pay_rate",
    label: "付费率·按语言(elt_film_order JOIN, orderStatus=6)",
    test: (c) => /elt_film_order/i.test(goldText(c)) && /orderStatus\s*=\s*6/i.test(goldText(c)),
  },
  {
    key: "retention_d1",
    label: "次日留存·按语言(elt_active_guid, addDays(targetDate,1))",
    test: (c) =>
      /elt_active_guid/i.test(goldText(c)) && /addDays\(targetDate,\s*1\)/i.test(goldText(c)),
  },
  {
    key: "multi_sql",
    label: "多SQL拆表(同比/环比/多渠道对照, goldSqls≥2)",
    test: (c) => Array.isArray(c.goldSqls) && c.goldSqls.length >= 2,
  },
  {
    key: "movie_multi",
    label: "影片类型多值过滤(movieType IN 多值)",
    test: (c) => /movieType\s+IN\s*\([^)]*,/i.test(goldText(c)),
  },
  {
    key: "colloquial",
    label: "口语化完整问法(长问法端到端)",
    test: (c) => String(c.nl || "").length > 24 && /统计|分组|在 .* 至/.test(c.nl || ""),
  },
];

console.log(`[sampling-matrix] seed=${seed.version} gold answerable=${gold.length}`);
const missing: string[] = [];
for (const s of SCENES) {
  const hits = gold.filter(s.test);
  const ok = hits.length > 0;
  if (!ok) missing.push(s.key);
  console.log(
    `  ${ok ? "OK  " : "MISS"} ${s.key.padEnd(16)} ${s.label}  (n=${hits.length})  ${hits[0]?.id ?? ""}`,
  );
}
assert.equal(missing.length, 0, `采样矩阵未覆盖场景: ${missing.join(", ")}`);
console.log("analytics-sampling-matrix.test.ts OK");
