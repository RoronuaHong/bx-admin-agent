/**
 * Live consistency checks against analyticsAsk (needs Metabase + LLM env).
 * Run: tsx scripts/analytics-consistency-live.ts
 */
import "dotenv/config";
import { analyticsAsk } from "../src/analytics/pipeline.js";

type Case = {
  id: string;
  nl: string;
  expectStatus: Array<"ok" | "clarify" | "refuse" | "error">;
  forbidOkUniqOnly?: boolean;
  whenOkSqlMust?: RegExp[];
  forbidOkSql?: RegExp[];
  whenClarifyLabel?: RegExp;
  forbidClarifySlot?: string;
};

const cases: Case[] = [
  {
    id: "C6-yoy",
    nl: "2026-08-19到2026-08-25，各渠道观看人数的同比增长率",
    expectStatus: ["ok"],
    whenOkSqlMust: [/uniq\s*\(\s*guid\s*\)/i, /2025-08-19/, /2026-08-19/],
    forbidOkSql: [/channel\s*=\s*'IndiaA'/i],
  },
  {
    id: "mom",
    nl: "2026-08-19到2026-08-25，各渠道观看人数的环比增长率",
    expectStatus: ["ok"],
    whenOkSqlMust: [/uniq\s*\(\s*guid\s*\)/i, /2026-08-12/, /2026-08-18/, /2026-08-19/],
    forbidOkSql: [/channel\s*=\s*'IndiaA'/i],
  },
  {
    id: "topn",
    nl: "2026-08-19到2026-08-25，观看时长合计 Top 10 渠道",
    expectStatus: ["refuse", "clarify"],
    forbidOkUniqOnly: true,
  },
  {
    id: "baseline-uniq",
    nl: "IndiaA 在 2026-08-19 至 2026-08-25 按天观看人数",
    expectStatus: ["ok"],
    whenOkSqlMust: [/uniq\s*\(\s*guid\s*\)/i, /IndiaA/],
    forbidClarifySlot: "contentLang",
  },
  {
    id: "C4-movie",
    nl: "2026-08-19到2026-08-25，电影的观看人数，按天",
    expectStatus: ["ok", "clarify"],
    whenOkSqlMust: [/movieType\s*=\s*1|movieType\s+IN\s*\([^)]*\b1\b/i],
    whenClarifyLabel: /电影/,
  },
  {
    id: "C2-wide",
    nl: "对比 te-IN 和 ta-IN 的平均最大观看进度，按内容语言分列，宽表展示；时间 2026-08-19 到 2026-08-25，渠道 IndiaA",
    expectStatus: ["ok", "clarify", "refuse"],
    whenOkSqlMust: [/sumIf|countIf/i, /te-IN/, /ta-IN/],
  },
];

const clock = new Date("2026-09-11T12:00:00+08:00");
let failed = 0;

for (const c of cases) {
  const t0 = Date.now();
  let r;
  try {
    r = await analyticsAsk(c.nl, { clock });
  } catch (e) {
    console.log(
      JSON.stringify({
        id: c.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        ms: Date.now() - t0,
      }),
    );
    failed++;
    continue;
  }
  const ms = Date.now() - t0;
  const issues: string[] = [];
  if (!c.expectStatus.includes(r.status)) {
    issues.push(`status=${r.status} not in ${c.expectStatus.join("|")}`);
  }
  if (c.forbidOkUniqOnly && r.status === "ok") {
    const sql = (r.sqls || []).join("\n");
    if (/uniq\s*\(\s*guid\s*\)/i.test(sql) && !/yoy|同比|growth|ratio/i.test(sql)) {
      issues.push("silent_downgrade_ok_uniq");
    }
  }
  if (r.status === "ok" && c.whenOkSqlMust) {
    const sql = (r.sqls || []).join("\n");
    for (const re of c.whenOkSqlMust) {
      if (!re.test(sql)) issues.push(`sql_missing:${re}`);
    }
    if (/missing_where/i.test(r.error || "")) issues.push("missing_where_error");
  }
  if (r.status === "ok" && c.forbidOkSql) {
    const sql = (r.sqls || []).join("\n");
    for (const re of c.forbidOkSql) {
      if (re.test(sql)) issues.push(`sql_forbidden:${re}`);
    }
  }
  if (r.status === "clarify" && c.whenClarifyLabel) {
    const blob = `${r.message || ""}\n${JSON.stringify(r.clarifyOptions || [])}`;
    if (!c.whenClarifyLabel.test(blob)) issues.push("clarify_missing_label");
  }
  if (r.status === "clarify" && c.forbidClarifySlot && r.clarifySlot === c.forbidClarifySlot) {
    issues.push(`spurious_clarify:${c.forbidClarifySlot}`);
  }
  if (r.status === "ok" && c.id === "C4-movie") {
    const sql = (r.sqls || []).join("\n");
    if (!/movieType/.test(sql) || !/\b1\b/.test(sql)) {
      // lexicon may put IN (1) — already checked by whenOkSqlMust
    }
  }

  const pass = issues.length === 0;
  if (!pass) failed++;
  console.log(
    JSON.stringify(
      {
        id: c.id,
        pass,
        status: r.status,
        ms,
        error: r.error?.slice(0, 120),
        message: (r.message || "").slice(0, 160),
        sqlPreview: (r.sqls?.[0] || "").slice(0, 280),
        clarifyOptions: (r.clarifyOptions || []).slice(0, 5),
        issues,
        packVersion: r.packVersion,
      },
      null,
      0,
    ),
  );
}

console.log(JSON.stringify({ failed, total: cases.length, ok: failed === 0 }));
process.exit(failed === 0 ? 0 : 1);
