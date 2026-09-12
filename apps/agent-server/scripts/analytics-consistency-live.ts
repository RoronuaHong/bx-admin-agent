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
  requireSlot?: string;
  minSqls?: number;
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
    expectStatus: ["ok"],
    whenOkSqlMust: [/movieType\s*=\s*1|movieType\s+IN\s*\([^)]*\b1\b/i],
    forbidOkSql: [/channel\s*=/i],
  },
  {
    id: "C2-wide",
    nl: "对比 te-IN 和 ta-IN 的平均最大观看进度，按内容语言分列，宽表展示；时间 2026-08-19 到 2026-08-25，渠道 IndiaA",
    expectStatus: ["ok"],
    whenOkSqlMust: [/sumIf|countIf|avgIf/i, /te-IN/, /ta-IN/, /IndiaA/],
  },
  {
    id: "S1-alias",
    nl: "印度A 在 2026-08-19 至 2026-08-25 按天观看人数",
    expectStatus: ["ok"],
    whenOkSqlMust: [/uniq\s*\(\s*guid\s*\)/i, /IndiaA/],
  },
  {
    id: "S6-mixed-grain",
    nl: "八月二十到二十一印度A按天观看人数，同时FoxA按语言观看人数",
    expectStatus: ["ok"],
    whenOkSqlMust: [/IndiaA/, /FoxA/],
    minSqls: 2,
  },
  {
    id: "S7-split",
    nl: "八月二十到二十一印度A和FoxA各自按天观看人数",
    expectStatus: ["ok"],
    whenOkSqlMust: [/IndiaA/, /FoxA/],
    minSqls: 2,
  },
  {
    id: "S8-yoy-channel",
    nl: "IndiaA 2026-08 同比观看人数",
    expectStatus: ["ok"],
    whenOkSqlMust: [/IndiaA/, /2025-08/, /2026-08/],
  },
  {
    id: "clarify-completion",
    nl: "2026-08-19到2026-08-25，IndiaA 完播率按天",
    expectStatus: ["clarify"],
    whenClarifyLabel: /指标口径|最大观看进度|完播|阈值/,
  },
  {
    id: "brazilA-clarify",
    nl: "巴西A 在 2026-08-19 至 2026-08-25 按天观看人数",
    expectStatus: ["clarify"],
    requireSlot: "channel",
    forbidClarifySlot: "contentLang",
    whenClarifyLabel: /渠道|channel|巴西/,
  },
  {
    id: "brazil-compare-no-silent",
    nl: "对比 IndiaA 和巴西A 在 2026-08-19 至 2026-08-25 的观看人数，按渠道",
    expectStatus: ["clarify"],
    requireSlot: "channel",
    forbidClarifySlot: "contentLang",
  },
  {
    id: "filme-tela-uv",
    nl: "FilmeTela 在 2026-08-19 至 2026-08-25 按天观看人数",
    expectStatus: ["ok"],
    whenOkSqlMust: [/uniq\s*\(\s*guid\s*\)/i, /FilmeTela/],
    forbidClarifySlot: "contentLang",
  },
];

const clock = new Date("2026-09-11T12:00:00+08:00");
const modelId = "glm5";
const ownerKey = `analytics:consistency-live:${Date.now()}`;
let failed = 0;

for (const c of cases) {
  const t0 = Date.now();
  let r;
  try {
    r = await analyticsAsk(c.nl, { clock, modelId, ownerKey: `${ownerKey}:${c.id}` });
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
  if (r.status === "ok" && c.minSqls && (r.sqls || []).length < c.minSqls) {
    issues.push(`sql_count=${(r.sqls || []).length}<${c.minSqls}`);
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
  if (c.requireSlot && r.clarifySlot !== c.requireSlot) {
    issues.push(`slot=${r.clarifySlot} want ${c.requireSlot}`);
  }
  if (/missing_where/i.test(r.error || "")) issues.push("missing_where_error");
  if (r.status === "ok" && /巴西/.test(c.nl)) {
    issues.push("brazil_silent_ok");
  }
  if ((r.sqls || []).some((s) => /巴西A|BrazilA/i.test(s))) {
    issues.push("ghost_brazil_sql");
  }
  if (c.id === "brazil-compare-no-silent" && r.status === "ok") {
    issues.push("compare_dropped_brazil_ran_india_only");
  }
  if (c.id === "C2-wide" && r.status === "ok" && r.askState?.metricId && r.askState.metricId !== "avg_max_progress") {
    issues.push(`metricId=${r.askState.metricId}`);
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
        modelId: r.modelId,
      },
      null,
      0,
    ),
  );
}

console.log(JSON.stringify({ failed, total: cases.length, ok: failed === 0 }));
process.exit(failed === 0 ? 0 : 1);
