// P3 口径层离线检索评测：不调模型、不连 BI，只问「get_caliber_context 推荐的表里有没有期望表」。
// 确定性、秒级，可作为 P3 改动的回归基线，和端到端 JoinCorrect（混着模型噪声）分开看。
// 留一法：评第 i 题时，用「去掉本题卡片及其孪生卡片」的其余卡片建图——否则题目 = 卡片标题，
// 检索必然命中本题卡片、把它的表原样返回，测的是索引记忆而非检索能力。--leaky 给出不留一的对照值。
// 指标：表召回（期望表被推荐的比例，均值）、全命中率（期望表全部被推荐，附 Wilson 区间）、精确率、recall@k（按推荐排名截断）。
// 用法：node scripts/bi-caliber-eval.mjs [--k 5] [--top 12] [--out .data/bi-caliber-eval.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeKnownTables, filterKnownTables } from "./metabase-card-graph.mjs";
import { buildCaliberGraph, buildCaliberContext } from "./bi-caliber-graph.mjs";
import { sameTable, wilson } from "./bi-eval-score.mjs";
import { holdoutCardIds } from "./bi-eval-holdout.mjs";

const RANK_CUTS = [3, 5, 8, 12];
const round = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** 单题：推荐表（按排名）对期望表的覆盖。 */
export function scoreRetrieval(expected, offered) {
  const hitAt = (n) => expected.filter((t) => offered.slice(0, n).some((o) => sameTable(t, o))).length;
  const hit = hitAt(offered.length);
  const offeredHit = offered.filter((o) => expected.some((t) => sameTable(t, o))).length;
  return {
    recall: hit / expected.length,
    allHit: hit === expected.length,
    precision: offered.length ? offeredHit / offered.length : 0,
    recallAt: Object.fromEntries(RANK_CUTS.map((n) => [n, hitAt(n) / expected.length])),
    missing: expected.filter((t) => !offered.some((o) => sameTable(t, o))),
  };
}

/**
 * cases：黄金集条目 [{id, question, expected_sql, tables}]；knownList：白名单（数组或 {tables}）。
 * leaveOneOut=true 时每题用去掉本题及孪生卡片的图检索。
 */
export function evaluateCaliberRetrieval(
  cases,
  knownList,
  { leaveOneOut = true, k = 5, topTables = 12, retriever = "caliber", tableTexts = {}, textWeight } = {},
) {
  const known = normalizeKnownTables(knownList);
  const opts = { knownTables: [...known], tableTexts };
  const fullGraph = leaveOneOut ? null : buildCaliberGraph(cases, opts);
  const rows = [];
  for (const c of cases) {
    if (!c.expected_sql) continue;
    const expected = filterKnownTables(c.tables || [], known);
    if (!expected.length) continue;
    const hidden = leaveOneOut ? new Set(holdoutCardIds(cases, c.id)) : new Set();
    const graph = fullGraph || buildCaliberGraph(cases.filter((x) => !hidden.has(x.id)), opts);
    // popularity：不看问题，按「被多少张卡片引用」推前 N 张表。口径图必须明显胜过它才算真的在检索。
    const offered =
      retriever === "popularity"
        ? [...graph.tableNodes.values()].sort((a, b) => b.cardCount - a.cardCount).slice(0, topTables).map((t) => t.table)
        : buildCaliberContext(graph, c.question, { k, topTables, ...(textWeight != null ? { textWeight } : {}) }).tables.map((t) => t.table);
    rows.push({ id: c.id, question: c.question, expected, offered, hidden: [...hidden], ...scoreRetrieval(expected, offered) });
  }
  const allHit = rows.filter((r) => r.allHit).length;
  const ci = wilson(allHit, rows.length);
  return {
    summary: {
      retriever,
      leaveOneOut,
      k,
      topTables,
      n: rows.length,
      recallMean: round(mean(rows.map((r) => r.recall))),
      allHit: { rate: rows.length ? round(allHit / rows.length) : null, count: `${allHit}/${rows.length}`, ci95: ci ? ci.map(round) : null },
      precisionMean: round(mean(rows.map((r) => r.precision))),
      recallAt: Object.fromEntries(RANK_CUTS.map((n) => [n, round(mean(rows.map((r) => r.recallAt[n])))])),
      emptyRetrievals: rows.filter((r) => !r.offered.length).length,
    },
    rows,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const argv = process.argv.slice(2);
  const val = (flag, d) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : d);
  const k = Number(val("--k", 5));
  const topTables = Number(val("--top", 12));
  const out = val("--out", path.join(root, ".data", "bi-caliber-eval.json"));
  const golden = JSON.parse(fs.readFileSync(path.join(root, "tests", "bi-golden-set.json"), "utf8"));
  const known = JSON.parse(fs.readFileSync(path.join(root, "tests", "bi-known-tables.json"), "utf8"));
  // 与线上一致：表检索文本取自 bi-known-tables.json 的 tableTexts（bi-metadata-gaps.mjs 导出）。
  const tableTexts = known.tableTexts || {};
  const loo = evaluateCaliberRetrieval(golden.cases, known, { leaveOneOut: true, k, topTables, tableTexts });
  const leaky = evaluateCaliberRetrieval(golden.cases, known, { leaveOneOut: false, k, topTables, tableTexts });
  const popularity = evaluateCaliberRetrieval(golden.cases, known, { leaveOneOut: true, k, topTables, retriever: "popularity", tableTexts });
  console.log("留一法（真实能力）:", JSON.stringify(loo.summary, null, 2));
  console.log("朴素基线（按引用次数推前 N 张，留一法）:", JSON.stringify(popularity.summary, null, 2));
  console.log("不留一（含泄题，仅对照）:", JSON.stringify(leaky.summary, null, 2));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ leaveOneOut: loo, popularity: popularity.summary, leaky: leaky.summary }, null, 2));
  console.log("报告已写:", out);
}
