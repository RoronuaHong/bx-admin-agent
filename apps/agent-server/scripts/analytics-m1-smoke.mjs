/**
 * Analytics M1 live smoke: NL → analyticsAsk pipeline → Metabase.
 *
 * Requires apps/agent-server/.env with METABASE_USERNAME / METABASE_PASSWORD
 * (and LLM model keys used by pipeline). Do not put secrets in this file.
 *
 * Run from apps/agent-server (prefer tsx; npx.ps1 may be broken on Windows):
 *   .\node_modules\.bin\tsx.cmd scripts\analytics-m1-smoke.mjs
 *   node --import tsx scripts/analytics-m1-smoke.mjs
 */
import "dotenv/config";
import { analyticsAsk } from "../src/analytics/pipeline.js";

const CLOCK = new Date("2026-09-09T12:00:00+08:00");

/**
 * pipeline.llmText picks the first MODEL_PROVIDERS id matching /flash|dsflash/i.
 * Prefer dsflash when present so EOL NVIDIA *flash* entries do not win by list order.
 */
function preferAnalyticsLlm() {
  const ids = (process.env.MODEL_PROVIDERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const preferred = ids.find((id) => id.toLowerCase() === "dsflash");
  if (!preferred) return;
  process.env.MODEL_PROVIDERS = [preferred, ...ids.filter((id) => id !== preferred)].join(",");
}
preferAnalyticsLlm();

function hasMetabaseCreds() {
  const user = (process.env.METABASE_USERNAME || process.env.METABASE_USER_EMAIL || "").trim();
  const pass = process.env.METABASE_PASSWORD || "";
  return Boolean(user && pass);
}

function totalRows(tables) {
  if (!Array.isArray(tables)) return 0;
  return tables.reduce((n, t) => n + (Array.isArray(t?.rows) ? t.rows.length : 0), 0);
}

function allSqlText(sqls) {
  return (sqls || []).join("\n");
}

const CASES = [
  {
    name: "vague-最近-clarify",
    nl: "最近人均多久",
    check(r) {
      if (r.status !== "clarify") {
        return `expected status=clarify, got ${r.status}: ${r.message || r.error || ""}`;
      }
      return null;
    },
  },
  {
    name: "single-IndiaA-day-users",
    nl: "八月二十到二十一印度A按天观看人数",
    check(r) {
      if (r.status !== "ok") {
        return `expected status=ok, got ${r.status}: ${r.message || r.error || ""}`;
      }
      const rows = totalRows(r.tables);
      if (rows < 1) return `expected ≥1 row in tables, got ${rows}`;
      const sql = allSqlText(r.sqls);
      if (!/todate/i.test(sql)) return `expected SQL to contain toDate, got: ${sql.slice(0, 200)}`;
      return null;
    },
  },
  {
    name: "parallel-IndiaA-day-and-FoxA-lang",
    nl: "八月二十到二十一印度A按天观看人数，同时FoxA按语言观看人数",
    check(r) {
      if (r.status !== "ok") {
        return `expected status=ok, got ${r.status}: ${r.message || r.error || ""}`;
      }
      const sqlCount = Array.isArray(r.sqls) ? r.sqls.length : 0;
      const tableCount = Array.isArray(r.tables) ? r.tables.length : 0;
      if (sqlCount < 2 && tableCount < 2) {
        return `expected ≥2 sqls or ≥2 tables, got sqls=${sqlCount} tables=${tableCount}`;
      }
      return null;
    },
  },
];

async function runCase(c) {
  const started = Date.now();
  let result;
  try {
    result = await analyticsAsk(c.nl, { clock: CLOCK });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: `threw: ${msg}`, ms: Date.now() - started };
  }
  const err = c.check(result);
  const brief = [
    `status=${result.status}`,
    result.sqls ? `sqls=${result.sqls.length}` : null,
    result.tables ? `tables=${result.tables.length}` : null,
    `rows=${totalRows(result.tables)}`,
  ]
    .filter(Boolean)
    .join(" ");
  if (err) {
    return { ok: false, detail: `${err} (${brief})`, ms: Date.now() - started, result };
  }
  return { ok: true, detail: brief, ms: Date.now() - started, result };
}

async function main() {
  console.log("[analytics-m1-smoke] clock =", CLOCK.toISOString());

  if (!hasMetabaseCreds()) {
    console.error(
      "[analytics-m1-smoke] FAIL: set METABASE_USERNAME and METABASE_PASSWORD in apps/agent-server/.env",
    );
    process.exit(2);
  }

  let failed = 0;
  for (const c of CASES) {
    process.stdout.write(`[analytics-m1-smoke] RUN ${c.name} … `);
    const out = await runCase(c);
    if (out.ok) {
      console.log(`PASS (${out.ms}ms) ${out.detail}`);
    } else {
      failed++;
      console.log(`FAIL (${out.ms}ms) ${out.detail}`);
      if (out.result?.sqls?.length) {
        for (let i = 0; i < out.result.sqls.length; i++) {
          console.log(`  sql[${i}]=${String(out.result.sqls[i]).slice(0, 180).replace(/\s+/g, " ")}`);
        }
      }
    }
  }

  const total = CASES.length;
  const passed = total - failed;
  console.log(`[analytics-m1-smoke] DONE ${passed}/${total}`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error("[analytics-m1-smoke] FAIL:", e);
  process.exit(1);
});
