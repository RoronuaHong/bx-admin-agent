/**
 * 语义层优化实例验证（零 LLM / 可选零 Metabase）：
 * Intent → compile → AST → forcedFilters(RLS) → 覆盖外 refuse。
 * Run: tsx scripts/analytics-semantic-hardening-verify.ts
 */
import assert from "node:assert/strict";
import { buildAnalyticsIntentFromStructure } from "../src/analytics/intent.js";
import { compileAnalyticsIntent } from "../src/analytics/sql-compile.js";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";
import { assertAnalyticsSqlSafe, analyzeSqlAst } from "../src/analytics/sql-guard.js";
import { resolveTimeRange } from "../src/analytics/time-resolve.js";
import { analyticsAsk } from "../src/analytics/pipeline.js";

const pack = loadAnalyticsPack("watch-detail");
const clock = new Date("2026-09-09T12:00:00+08:00");

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
}

// 1) 完整语义层路径：结构 → Intent → SQL → AST
{
  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"], contentLang: ["te-IN"] },
      outputDims: ["watch_date", "channel"],
      metricId: "avg_watch_second_per_user",
    },
    pack,
    fallbackNl: "IndiaA 2026-08-19到25 te-IN 人均观看时长 按天渠道",
  });
  check("intent_ok", built.ok, built.ok ? built.intent.metric.kind : (built as { reason: string }).reason);
  if (built.ok) {
    const compiled = compileAnalyticsIntent(built.intent, pack);
    check("compile_ok", compiled.ok, compiled.ok ? "sql" : compiled.reason);
    if (compiled.ok) {
      const ast = analyzeSqlAst(compiled.sql);
      check("ast_select", ast.kind === "select" || ast.kind === "with_select", ast.kind);
      check("ast_where", ast.hasWhere, `tables=${ast.tables.join(",")}`);
      check("ast_clean", ast.issues.length === 0, ast.issues.join(","));
      assert.doesNotThrow(() =>
        assertAnalyticsSqlSafe(compiled.sql, pack.tables.map((t) => t.name)),
      );
      check("ast_guard_pass", true);
      check("no_llm_sql", /SELECT/i.test(compiled.sql) && !/guess/i.test(compiled.sql));
    }
  }
}

// 2) RLS forcedFilters：编译强制带上渠道
{
  const packRls = {
    ...pack,
    guards: {
      ...pack.guards,
      forcedFilters: { channel: ["IndiaA", "IndiaB"] },
    },
  };
  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: {},
      outputDims: ["channel"],
      metricId: "uniq_users",
    },
    pack: packRls,
    fallbackNl: "观看人数按渠道",
  });
  assert.equal(built.ok, true);
  if (built.ok) {
    const compiled = compileAnalyticsIntent(built.intent, packRls);
    assert.equal(compiled.ok, true);
    if (compiled.ok) {
      check(
        "rls_forced_channel",
        /channel\s+IN\s*\(\s*'IndiaA'\s*,\s*'IndiaB'\s*\)/i.test(compiled.sql) ||
          (/channel\s*=\s*'IndiaA'/i.test(compiled.sql) && /IndiaB/i.test(compiled.sql)),
        compiled.sql.slice(0, 180).replace(/\s+/g, " "),
      );
    }
  }
}

// 3) 覆盖外 metric → Intent 失败（结构化拒答语义）
{
  const built = buildAnalyticsIntentFromStructure({
    structure: {
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: {},
      outputDims: [],
      metricId: "revenue_net_usd_v3",
    },
    pack,
    fallbackNl: "收入",
  });
  check("unsupported_metric_intent", !built.ok && /not compilable/i.test((built as { reason: string }).reason));
}

// 4) 时间代码解析（确定性）
{
  const r = resolveTimeRange("最近7天", clock, "Asia/Shanghai");
  check("time_recent_7d", r.ok && r.ok && r.range.start === "2026-09-03" && r.range.end === "2026-09-09");
}

// 5) 裸「最近」→ 代码澄清（不烧 LLM）
{
  const ask = await analyticsAsk("最近人均多久", { clock });
  check(
    "bare_recent_clarify",
    ask.status === "clarify" && ask.clarifySlot === "time_range",
    ask.message.slice(0, 80),
  );
}

// 6) queryTimeout 配置存在
{
  check("pack_query_timeout", Number(pack.guards.queryTimeoutMs) > 0, String(pack.guards.queryTimeoutMs));
  check("pack_forced_filters_hook", pack.guards.forcedFilters !== undefined);
}

const failed = results.filter((r) => !r.ok);
console.log(`\nsummary: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.error("FAILED:", failed.map((f) => f.name).join(", "));
  process.exit(1);
}
console.log("analytics-semantic-hardening-verify.ts OK");
