// P3 口径层离线检索评测：留一法下本题卡片不进图；朴素基线不看问题；召回 / 全命中 / recall@k 口径。
import { test, expect } from "vitest";
import { evaluateCaliberRetrieval, scoreRetrieval } from "../scripts/bi-caliber-eval.mjs";

const known = ["film_report.elt_film_order", "film_report.elt_app_params", "film_report.elt_fo_ap_src", "film_report.elt_watch_detail"];
const cases = [
  { id: 1, question: "会员国籍分布", expected_sql: "SELECT 1", tables: ["film_report.elt_film_order", "film_report.elt_app_params"] },
  { id: 2, question: "会员国籍来源", expected_sql: "SELECT 2", tables: ["film_report.elt_film_order", "film_report.elt_app_params", "film_report.elt_fo_ap_src"] },
  { id: 3, question: "观影时长", expected_sql: "SELECT 3", tables: ["film_report.elt_watch_detail"] },
];

test("scoreRetrieval：召回、全命中、精确率、按排名截断的 recall@k", () => {
  const r = scoreRetrieval(["a.x", "a.y"], ["a.x", "a.z", "a.w", "y"]);
  expect(r.recall).toBe(1);
  expect(r.allHit).toBe(true);
  expect(r.precision).toBe(0.5);
  expect(r.recallAt[3]).toBe(0.5);
  expect(r.missing).toEqual([]);
});

test("留一法：评某题时它自己的卡片不在图里（唯一用到某表的题就检索不到那张表）", () => {
  const loo = evaluateCaliberRetrieval(cases, known, { leaveOneOut: true });
  const r3 = loo.rows.find((r) => r.id === 3)!;
  expect(r3.offered).not.toContain("film_report.elt_watch_detail");
  expect(r3.allHit).toBe(false);
  const leaky = evaluateCaliberRetrieval(cases, known, { leaveOneOut: false });
  expect(leaky.rows.find((r) => r.id === 3)!.allHit).toBe(true);
});

test("留一法：共享口径的相邻卡片仍能把表推荐出来", () => {
  const loo = evaluateCaliberRetrieval(cases, known, { leaveOneOut: true });
  const r1 = loo.rows.find((r) => r.id === 1)!;
  expect(r1.offered).toEqual(expect.arrayContaining(["film_report.elt_film_order", "film_report.elt_app_params"]));
  expect(loo.summary.n).toBe(3);
  expect(loo.summary.allHit.ci95).toHaveLength(2);
});

test("朴素基线：不看问题，按卡片引用次数推表", () => {
  const pop = evaluateCaliberRetrieval(cases, known, { leaveOneOut: true, retriever: "popularity", topTables: 1 });
  for (const r of pop.rows) expect(r.offered).toHaveLength(1);
  expect(pop.summary.retriever).toBe("popularity");
});
