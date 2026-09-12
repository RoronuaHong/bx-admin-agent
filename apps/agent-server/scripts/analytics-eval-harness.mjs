/**
 * Analytics M2 eval harness: seed → analyticsAsk → soft-EX / refuse metrics → GATE_*.
 *
 * reviewStatus:
 *   gold        — human-confirmed; counted in GATE_*
 *   provisional — scaffold/smoke only; run & print, not in GATE EX
 *
 * Modes:
 *   ANALYTICS_EVAL_MODE=refuse  (default when no Metabase) — only should_refuse cases
 *   ANALYTICS_EVAL_MODE=full    — refuse + live answerable (needs Metabase + LLM)
 *
 * Run from apps/agent-server:
 *   .\node_modules\.bin\tsx.cmd scripts\analytics-eval-harness.mjs
 *   ANALYTICS_EVAL_MODE=full .\node_modules\.bin\tsx.cmd scripts\analytics-eval-harness.mjs
 *
 * Exit: 0 = gates pass; 1 = gate fail; 2 = config / seed error
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyticsAsk } from "../src/analytics/pipeline.js";
import { runNativeDataset } from "../src/analytics/metabase-client.js";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";
import {
  accumulateOutcome,
  emptyMetrics,
  evaluateGates,
  isGateCase,
  loadGateThresholds,
  softExMatchTables,
} from "../src/analytics/eval-score.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const SEED_PATH = join(ROOT, "config/analytics/eval/seed-v1.json");
const BASELINE_PATH = join(ROOT, "config/analytics/eval/baseline.json");

function preferAnalyticsLlm() {
  const forced = (process.env.ANALYTICS_EVAL_MODEL || "").trim();
  if (forced) {
    const ids = (process.env.MODEL_PROVIDERS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    process.env.MODEL_PROVIDERS = [forced, ...ids.filter((id) => id !== forced)].join(",");
    return;
  }
  const ids = (process.env.MODEL_PROVIDERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const preferred = ids.find((id) => id.toLowerCase() === "dsflash");
  if (!preferred) return;
  process.env.MODEL_PROVIDERS = [preferred, ...ids.filter((id) => id !== preferred)].join(",");
}

function resolveModelId() {
  const fromArg = process.argv.find((a) => a.startsWith("--model="));
  if (fromArg) return fromArg.slice("--model=".length).trim();
  const idx = process.argv.indexOf("--model");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1].trim();
  return (process.env.ANALYTICS_EVAL_MODEL || "").trim() || undefined;
}

preferAnalyticsLlm();
const EVAL_MODEL_ID = resolveModelId();

function hasMetabaseCreds() {
  const user = (process.env.METABASE_USERNAME || process.env.METABASE_USER_EMAIL || "").trim();
  const pass = process.env.METABASE_PASSWORD || "";
  return Boolean(user && pass);
}

function resolveMode() {
  if (process.argv.includes("--refuse-only") || process.argv.includes("--refuse")) {
    return "refuse";
  }
  if (process.argv.includes("--full")) return "full";
  const raw = (process.env.ANALYTICS_EVAL_MODE || "").trim().toLowerCase();
  if (raw === "full" || raw === "refuse") return raw;
  return hasMetabaseCreds() ? "full" : "refuse";
}

function isRefuseStatus(status) {
  return status === "clarify" || status === "refuse";
}

async function runGoldTables(goldSqls, databaseId) {
  const tables = [];
  for (const sql of goldSqls) {
    const res = await runNativeDataset(sql, databaseId);
    if (!res.ok) {
      return { ok: false, error: res.error || "gold sql failed", tables };
    }
    tables.push({ cols: res.cols, rows: res.rows });
  }
  return { ok: true, tables };
}

async function runCase(c, ctx) {
  const started = Date.now();
  const shouldRefuse = c.should_refuse === true;
  const requireLive = c.requireLive === true || (!shouldRefuse && Array.isArray(c.goldSqls));

  if (requireLive && ctx.mode === "refuse") {
    return { outcome: "skipped", detail: "skipped (refuse-only mode)", ms: 0 };
  }

  let result;
  try {
    result = await analyticsAsk(c.nl, {
      clock: ctx.clock,
      packId: ctx.packId,
      modelId: ctx.modelId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { outcome: "error", detail: `threw: ${msg}`, ms: Date.now() - started };
  }

  if (shouldRefuse) {
    if (isRefuseStatus(result.status) && !(result.tables?.some((t) => t.rows?.length))) {
      return {
        outcome: "refuse_ok",
        detail: `status=${result.status}`,
        ms: Date.now() - started,
        result,
      };
    }
    return {
      outcome: "refuse_miss",
      detail: `expected clarify/refuse, got status=${result.status} tables=${result.tables?.length || 0}`,
      ms: Date.now() - started,
      result,
    };
  }

  if (isRefuseStatus(result.status)) {
    return {
      outcome: "over_refuse",
      detail: `over-refuse status=${result.status}`,
      ms: Date.now() - started,
      result,
    };
  }

  if (result.status !== "ok") {
    return {
      outcome: "error",
      detail: `status=${result.status} ${result.error || result.message || ""}`,
      ms: Date.now() - started,
      result,
    };
  }

  const goldSqls = Array.isArray(c.goldSqls) ? c.goldSqls : [];
  if (!goldSqls.length) {
    return {
      outcome: "error",
      detail: "answerable case missing goldSqls",
      ms: Date.now() - started,
      result,
    };
  }

  if (c.tags?.includes("multi_query")) {
    const nSql = result.sqls?.length || 0;
    const nTab = result.tables?.length || 0;
    if (nSql < goldSqls.length && nTab < goldSqls.length) {
      return {
        outcome: "ex_fail",
        detail: `multi_query collapsed sqls=${nSql} tables=${nTab} gold=${goldSqls.length}`,
        ms: Date.now() - started,
        result,
      };
    }
  }

  const gold = await runGoldTables(goldSqls, ctx.databaseId);
  if (!gold.ok) {
    return {
      outcome: "error",
      detail: `gold exec failed: ${gold.error}`,
      ms: Date.now() - started,
      result,
    };
  }

  const predTables = (result.tables || []).map((t) => ({
    cols: t.cols || [],
    rows: t.rows || [],
  }));
  const match = softExMatchTables(gold.tables, predTables);
  if (!match.ok) {
    return {
      outcome: "ex_fail",
      detail: `soft-EX fail: ${match.detail}`,
      ms: Date.now() - started,
      result,
    };
  }
  return {
    outcome: match.mode === "soft" ? "ex_soft" : "ex_pass",
    detail: `soft-EX ${match.mode}: ${match.detail}`,
    ms: Date.now() - started,
    result,
  };
}

function pct(n) {
  if (n == null || Number.isNaN(n)) return "n/a";
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  const mode = resolveMode();
  console.log(`[analytics-eval] mode=${mode} model=${EVAL_MODEL_ID || "(auto)"}`);

  let seed;
  try {
    seed = JSON.parse(readFileSync(SEED_PATH, "utf8"));
  } catch (e) {
    console.error("[analytics-eval] FAIL: cannot read seed", e);
    process.exit(2);
  }

  const clock = new Date(seed.clock || "2026-09-09T12:00:00+08:00");
  const packId = seed.packId || "watch-detail";
  let databaseId = 2;
  try {
    databaseId = loadAnalyticsPack(packId).datasource.metabaseDatabaseId || 2;
  } catch {
    /* pack load optional for refuse-only */
  }

  if (mode === "full" && !hasMetabaseCreds()) {
    console.error("[analytics-eval] FAIL: full mode needs METABASE_USERNAME/PASSWORD");
    process.exit(2);
  }

  const casesAll = Array.isArray(seed.cases) ? seed.cases : [];
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const onlyIdx = process.argv.indexOf("--only");
  const onlyRaw =
    onlyArg?.slice("--only=".length) ||
    (onlyIdx >= 0 ? process.argv[onlyIdx + 1] : "") ||
    "";
  const onlyIds = new Set(
    onlyRaw
      .split(/[,|\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const cases = onlyIds.size
    ? casesAll.filter((c) => onlyIds.has(c.id))
    : casesAll;
  if (onlyIds.size && !cases.length) {
    console.error(`[analytics-eval] FAIL: --only matched 0 cases (${[...onlyIds].join(",")})`);
    process.exit(2);
  }
  const refuseGoldN = casesAll.filter((c) => c.should_refuse && isGateCase(c)).length;
  const answerGoldN = casesAll.filter((c) => !c.should_refuse && isGateCase(c)).length;
  const answerProvN = casesAll.filter((c) => !c.should_refuse && !isGateCase(c)).length;
  const answerN = casesAll.filter((c) => !c.should_refuse).length;
  if (refuseGoldN < 8) {
    console.error(`[analytics-eval] FAIL: gold refuse cases ${refuseGoldN} < 8`);
    process.exit(2);
  }
  console.log(
    `[analytics-eval] seed=${seed.version} gate: refuseGold=${refuseGoldN} answerableGold=${answerGoldN}; smoke answerableProvisional=${answerProvN}`,
  );
  if (answerGoldN === 0) {
    console.log(
      "[analytics-eval] NOTE: no gold answerable cases — GATE_EX is n/a until humans promote provisional → gold",
    );
  }

  const ctx = { mode, clock, packId, databaseId, modelId: EVAL_MODEL_ID };
  const gateMetrics = emptyMetrics();
  const smokeMetrics = emptyMetrics();
  const lines = [];

  for (const c of cases) {
    const gate = isGateCase(c);
    process.stdout.write(`[analytics-eval] RUN ${c.id}${gate ? "" : " [smoke]"} … `);
    const out = await runCase(c, ctx);
    accumulateOutcome(gate ? gateMetrics : smokeMetrics, out.outcome, c.should_refuse === true);
    const mark = ["ex_pass", "ex_soft", "refuse_ok", "skipped"].includes(out.outcome) ? "PASS" : "FAIL";
    console.log(`${mark} (${out.ms}ms) ${out.outcome} ${out.detail}`);
    lines.push({
      id: c.id,
      reviewStatus: c.reviewStatus || "provisional",
      outcome: out.outcome,
      detail: out.detail,
      ms: out.ms,
    });
  }

  let baselineEx = null;
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    // 种子集版本变化时不做回归对比（扩题会导致 EX 分母变化）
    if (typeof baseline.ex === "number" && baseline.seedVersion === seed.version) {
      baselineEx = baseline.ex;
    } else if (baseline.seedVersion && baseline.seedVersion !== seed.version) {
      console.log(
        `[analytics-eval] baseline seedVersion=${baseline.seedVersion} ≠ seed ${seed.version}，跳过 EX 回归门禁`,
      );
    }
  } catch {
    /* optional */
  }

  const thresholds = loadGateThresholds(process.env);
  const gate = evaluateGates(gateMetrics, thresholds, baselineEx);

  console.log("\n[analytics-eval] gate metrics (reviewStatus=gold only)");
  console.log(
    `  answerable=${gateMetrics.answerable} exPass=${gateMetrics.exPass} exSoft=${gateMetrics.exSoft} cwr=${gateMetrics.cwr}`,
  );
  console.log(
    `  refuse=${gateMetrics.refuseTotal} hit=${gateMetrics.refuseHit} systemRefuse=${gateMetrics.systemRefuse} overRefuse=${gateMetrics.overRefuse}`,
  );
  console.log(
    `  errors=${gateMetrics.errors} skipped=${gateMetrics.skipped} (seed answerableGold=${answerGoldN} provisional=${answerProvN})`,
  );
  if (smokeMetrics.answerable || smokeMetrics.errors || smokeMetrics.overRefuse) {
    console.log("\n[analytics-eval] smoke metrics (provisional; not gated)");
    console.log(
      `  answerable=${smokeMetrics.answerable} exPass=${smokeMetrics.exPass} cwr=${smokeMetrics.cwr} overRefuse=${smokeMetrics.overRefuse} errors=${smokeMetrics.errors}`,
    );
  }
  console.log("\n[analytics-eval] gates");
  console.log(`  EX=${pct(gate.ex)} (min ${pct(thresholds.exMin)})`);
  console.log(`  RefuseRecall=${pct(gate.refuseRecall)} (min ${pct(thresholds.refuseRecallMin)})`);
  console.log(`  RefusePrecision=${pct(gate.refusePrecision)} (min ${pct(thresholds.refusePrecisionMin)})`);
  console.log(`  CWR=${pct(gate.cwr)} (max ${pct(thresholds.cwrMax)})`);
  if (baselineEx != null) {
    console.log(`  baseline EX=${pct(baselineEx)} regressionMaxPp=${thresholds.exRegressionMaxPp}`);
  }

  // Write baseline whenever EX is computable (not gated on full gate.pass): the baseline
  // captures the CURRENT measured state so future runs can detect EX regressions, even when
  // other gates (refuse recall / cwr) still have known agent gaps.
  if (process.env.ANALYTICS_EVAL_WRITE_BASELINE === "1" && gate.ex != null) {
    writeFileSync(
      BASELINE_PATH,
      JSON.stringify(
        {
          seedVersion: seed.version,
          ex: gate.ex,
          refuseRecall: gate.refuseRecall,
          recordedAt: new Date().toISOString(),
          notes:
            "Gold-only EX baseline (reviewStatus=gold). Written by analytics-eval-harness with ANALYTICS_EVAL_WRITE_BASELINE=1",
        },
        null,
        2,
      ) + "\n",
    );
    console.log("[analytics-eval] wrote baseline.json");
  }

  if (!gate.pass) {
    console.error("\n[analytics-eval] GATE FAIL");
    for (const f of gate.failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  // refuse-only must still exercise refuse denominator
  if (mode === "refuse" && gateMetrics.refuseTotal < 8) {
    console.error("[analytics-eval] GATE FAIL: refuse-only ran fewer than 8 gold refuse cases");
    process.exit(1);
  }

  // full mode with gold answerable expected but only infra errors — not a silent EX pass
  if (mode === "full" && answerGoldN > 0 && gateMetrics.answerable === 0 && gateMetrics.errors > 0) {
    console.error(
      `[analytics-eval] FAIL: full mode produced 0 gold EX samples (${gateMetrics.errors} infra errors)`,
    );
    process.exit(2);
  }

  console.log("\n[analytics-eval] GATE PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error("[analytics-eval] FAIL:", e);
  process.exit(1);
});
