/**
 * Compare agent SQL results vs the same SQL run directly on Metabase.
 * Run: node --import tsx ./scripts/analytics-metabase-compare.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyticsAsk } from "../src/analytics/pipeline.js";
import { runNativeDataset } from "../src/analytics/metabase-client.js";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";
import { softExMatchTables, type EvalTable } from "../src/analytics/eval-score.js";

const clock = new Date("2026-09-11T12:00:00+08:00");
const modelId = "glm5";
const pack = loadAnalyticsPack("watch-detail");
const dbId = pack.datasource.metabaseDatabaseId || 2;
const ownerKey = `analytics:mb-compare:${Date.now()}`;

const seed = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../config/analytics/eval/seed-v1.json"), "utf8"),
) as {
  cases: Array<{ id: string; nl: string; goldSqls?: string[]; should_refuse?: boolean; reviewStatus?: string }>;
};

const seedIds = [
  "ex-single-day-indiaA",
  "ex-indiaA-total-users",
  "ex-foxA-total-users",
  "ex-indiaA-watch-seconds",
  "ex-indiaA-day-users",
  "ex-iso-indiaA-day",
  "ex-multi-indiaA-day-foxA-lang",
  "ex-multi-indiaA-foxA-day",
];

const liveGold: Array<{ id: string; nl: string; goldSqls: string[] }> = [
  {
    id: "baseline-uniq",
    nl: "IndiaA 在 2026-08-19 至 2026-08-25 按天观看人数",
    goldSqls: [
      "SELECT toDate(lastWatchTime) AS watchDate, uniq(guid) AS users FROM elt_watch_detail WHERE toDate(lastWatchTime) BETWEEN '2026-08-19' AND '2026-08-25' AND channel = 'IndiaA' AND movieType IN (1, 2, 3, 4, 10, 11) GROUP BY watchDate ORDER BY watchDate",
    ],
  },
  {
    id: "S1-alias",
    nl: "印度A 在 2026-08-19 至 2026-08-25 按天观看人数",
    goldSqls: [
      "SELECT toDate(lastWatchTime) AS watchDate, uniq(guid) AS users FROM elt_watch_detail WHERE toDate(lastWatchTime) BETWEEN '2026-08-19' AND '2026-08-25' AND channel = 'IndiaA' AND movieType IN (1, 2, 3, 4, 10, 11) GROUP BY watchDate ORDER BY watchDate",
    ],
  },
  {
    id: "C4-movie",
    nl: "2026-08-19到2026-08-25，电影的观看人数，按天",
    goldSqls: [
      "SELECT toDate(lastWatchTime) AS watchDate, uniq(guid) AS users FROM elt_watch_detail WHERE toDate(lastWatchTime) BETWEEN '2026-08-19' AND '2026-08-25' AND movieType = 1 GROUP BY watchDate ORDER BY watchDate",
    ],
  },
  {
    id: "C2-wide",
    nl: "对比 te-IN 和 ta-IN 的平均最大观看进度，按内容语言分列，宽表展示；时间 2026-08-19 到 2026-08-25，渠道 IndiaA",
    goldSqls: [
      "SELECT round(sumIf(a, contentLang = 'te-IN') / nullIf(countIf(contentLang = 'te-IN'), 0), 0) AS te_IN, round(sumIf(a, contentLang = 'ta-IN') / nullIf(countIf(contentLang = 'ta-IN'), 0), 0) AS ta_IN FROM ( SELECT guid, eid, contentLang, max(maxWatchProgress) AS a FROM elt_watch_detail WHERE toDate(lastWatchTime) BETWEEN '2026-08-19' AND '2026-08-25' AND channel = 'IndiaA' AND contentLang IN ('te-IN', 'ta-IN') AND movieType IN (1, 2, 3, 4, 10, 11) GROUP BY guid, eid, contentLang )",
    ],
  },
  {
    id: "C6-yoy",
    nl: "2026-08-19到2026-08-25，各渠道观看人数的同比增长率",
    goldSqls: [
      "SELECT channel, uniq(guid) AS users FROM elt_watch_detail WHERE toDate(lastWatchTime) BETWEEN '2026-08-19' AND '2026-08-25' AND movieType IN (1, 2, 3, 4, 10, 11) GROUP BY channel ORDER BY channel",
      "SELECT channel, uniq(guid) AS users FROM elt_watch_detail WHERE toDate(lastWatchTime) BETWEEN '2025-08-19' AND '2025-08-25' AND movieType IN (1, 2, 3, 4, 10, 11) GROUP BY channel ORDER BY channel",
    ],
  },
  {
    id: "mom",
    nl: "2026-08-19到2026-08-25，各渠道观看人数的环比增长率",
    goldSqls: [
      "SELECT channel, uniq(guid) AS users FROM elt_watch_detail WHERE toDate(lastWatchTime) BETWEEN '2026-08-19' AND '2026-08-25' AND movieType IN (1, 2, 3, 4, 10, 11) GROUP BY channel ORDER BY channel",
      "SELECT channel, uniq(guid) AS users FROM elt_watch_detail WHERE toDate(lastWatchTime) BETWEEN '2026-08-12' AND '2026-08-18' AND movieType IN (1, 2, 3, 4, 10, 11) GROUP BY channel ORDER BY channel",
    ],
  },
  {
    id: "S8-yoy-channel",
    nl: "IndiaA 2026-08 同比观看人数",
    goldSqls: [
      "SELECT toDate(lastWatchTime) AS watchDate, uniq(guid) AS users FROM elt_watch_detail WHERE toDate(lastWatchTime) BETWEEN '2026-08-01' AND '2026-08-31' AND channel = 'IndiaA' AND movieType IN (1, 2, 3, 4, 10, 11) GROUP BY watchDate ORDER BY watchDate",
      "SELECT toDate(lastWatchTime) AS watchDate, uniq(guid) AS users FROM elt_watch_detail WHERE toDate(lastWatchTime) BETWEEN '2025-08-01' AND '2025-08-31' AND channel = 'IndiaA' AND movieType IN (1, 2, 3, 4, 10, 11) GROUP BY watchDate ORDER BY watchDate",
    ],
  },
];

type Case = { id: string; nl: string; goldSqls: string[]; reviewStatus?: string };

const cases: Case[] = [
  ...seedIds
    .map((id) => seed.cases.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c?.goldSqls?.length))
    .map((c) => ({ id: c.id, nl: c.nl, goldSqls: c.goldSqls!, reviewStatus: c.reviewStatus })),
  ...liveGold,
];

async function execSqls(sqls: string[]): Promise<{ ok: true; tables: EvalTable[] } | { ok: false; error: string }> {
  const tables: EvalTable[] = [];
  for (const sql of sqls) {
    const res = await runNativeDataset(sql, dbId);
    if (!res.ok) return { ok: false, error: res.error || "metabase exec failed" };
    tables.push({ cols: res.cols, rows: res.rows });
  }
  return { ok: true, tables };
}

function preview(t: EvalTable | undefined): string {
  if (!t) return "";
  const rows = t.rows.slice(0, 2).map((r) => r.join("|")).join(" ; ");
  return `cols=${t.cols.join(",")} n=${t.rows.length} sample=${rows}`;
}

let failed = 0;
for (const c of cases) {
  const t0 = Date.now();
  const gold = await execSqls(c.goldSqls);
  if (!gold.ok) {
    failed++;
    console.log(JSON.stringify({ id: c.id, pass: false, stage: "gold_exec", error: gold.error }));
    continue;
  }

  const agent = await analyticsAsk(c.nl, { clock, modelId, ownerKey: `${ownerKey}:${c.id}` });
  if (agent.status !== "ok") {
    failed++;
    console.log(
      JSON.stringify({
        id: c.id,
        pass: false,
        stage: "agent",
        status: agent.status,
        message: (agent.message || "").slice(0, 160),
        error: agent.error,
        ms: Date.now() - t0,
      }),
    );
    continue;
  }

  const agentSqls = agent.sqls || [];
  const sqlExec = agentSqls.length ? await execSqls(agentSqls) : { ok: false as const, error: "no agent sql" };
  const sqlMatch =
    sqlExec.ok && gold.tables.length <= sqlExec.tables.length
      ? softExMatchTables(gold.tables, sqlExec.tables)
      : { ok: false, mode: "fail" as const, detail: sqlExec.ok ? `sql tables ${sqlExec.tables.length} < gold ${gold.tables.length}` : sqlExec.error };

  const deliveryTables = (agent.tables || []).map((t) => ({ cols: t.cols || [], rows: t.rows || [] }));
  const deliveryMatch =
    deliveryTables.length >= gold.tables.length
      ? softExMatchTables(gold.tables, deliveryTables)
      : { ok: false, mode: "fail" as const, detail: `delivery tables ${deliveryTables.length} < gold ${gold.tables.length}` };

  const pass = sqlMatch.ok;
  if (!pass) failed++;
  console.log(
    JSON.stringify({
      id: c.id,
      reviewStatus: c.reviewStatus || "live-gold",
      pass,
      sqlEx: sqlMatch.ok ? sqlMatch.mode : `FAIL:${sqlMatch.detail}`,
      deliveryEx: deliveryMatch.ok ? deliveryMatch.mode : `FAIL:${deliveryMatch.detail}`,
      agentSqls: agentSqls.length,
      goldSqls: c.goldSqls.length,
      goldPreview: preview(gold.tables[0]),
      agentSqlPreview: sqlExec.ok ? preview(sqlExec.tables[0]) : "",
      ms: Date.now() - t0,
      modelId: agent.modelId,
    }),
  );
}

console.log(JSON.stringify({ failed, total: cases.length, ok: failed === 0, modelId }));
process.exit(failed === 0 ? 0 : 1);
