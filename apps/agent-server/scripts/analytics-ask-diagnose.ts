/**
 * 逐步诊断：把「一句话问数」在语义层被吃掉的每个决策阶段打印出来。
 * 用法：tsx scripts/analytics-ask-diagnose.ts "问句1" "问句2" ...
 * 只读：不做任何写库/写配置。LLM 段落用 ANALYTICS_DEFAULT_MODEL。
 */
import "dotenv/config";
import { analyticsAsk } from "../src/analytics/pipeline.js";
import { refreshPackFromCatalog, answerableTableNamedInNl } from "../src/analytics/catalog.js";
import {
  loadAnalyticsPack,
  overlayTableName,
  packFieldsForTable,
  findMetricOption,
  allowedTableNames,
  packTimeField,
  type AnalyticsPack,
} from "../src/analytics/semantic-layer.js";
import {
  resolveAskTable,
  scoreAnswerableTables,
  overlayAskFromNl,
} from "../src/analytics/table-resolve.js";
import {
  inferMetricIdFromNl,
  inferOutputDimsFromNl,
  ambiguousMetricFamilyClarify,
} from "../src/analytics/metric-infer.js";
import { routeAnalyticsAsk, llmSqlEnabled } from "../src/analytics/ask-route.js";
import {
  userDemandsLangFilter,
  impliesLangSetWithoutMembers,
  neededProbeFields,
} from "../src/analytics/conversation-structure.js";
import { guardAnalyticsInput } from "../src/analytics/input-guard.js";
import { resolveAskTimeRange } from "../src/analytics/time-resolve.js";
import { matchVerifiedQuery } from "../src/analytics/verified-query.js";

function head(title: string): void {
  console.log(`\n${"─".repeat(78)}\n${title}\n${"─".repeat(78)}`);
}

function dump(label: string, v: unknown): void {
  console.log(`  ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
}

/** 打印上屏表格（列名 + 行数 + 前若干行）。 */
function dumpTables(tables?: Array<{ title?: string; cols: string[]; rows: unknown[][] }>): void {
  if (!tables?.length) {
    console.log("  tables: (无)");
    return;
  }
  tables.forEach((t, i) => {
    console.log(`  table[${i}] title=${t.title || ""} rows=${t.rows.length}`);
    console.log(`    cols: ${t.cols.join(" | ")}`);
    for (const row of t.rows.slice(0, 5)) {
      console.log(`    ${row.map((c) => (c == null ? "" : String(c))).join(" | ")}`);
    }
    if (t.rows.length > 5) console.log(`    … 还有 ${t.rows.length - 5} 行`);
  });
}

async function deterministicStages(nl: string, pack: AnalyticsPack, clock: Date, tz: string) {
  head(`【A】确定性阶段（无语义模型） NL = ${JSON.stringify(nl)}`);

  const guarded = guardAnalyticsInput(nl);
  dump("A0 guard.input", guarded.text);
  dump("A0 guard.refused", guarded.refused || "(none)");

  const t = resolveAskTimeRange({ lastUserText: nl, clock, tz });
  dump("A1 time", t.ok ? `${t.range.start}..${t.range.end}` : `UNRESOLVED:${t.clarify}`);

  const vqr = matchVerifiedQuery(nl, pack);
  dump("A2 verified_query", vqr ? ("query" in vqr ? vqr.query.id : "clarify") : "(no hit)");

  // ---- 指标识别 ----
  const metricId = inferMetricIdFromNl(nl, pack);
  dump("A3 metric-infer (no table)", metricId || "(undefined)");
  const metricOwner = metricId ? findMetricOption(pack, metricId) : undefined;
  dump(
    "A3 metric.def.tables",
    metricOwner ? metricOwner.def.tables || "(undeclared → 不属于任何具体表)" : "(n/a)",
  );
  dump(
    "A3 metric.requiredSlots",
    metricOwner ? metricOwner.def.requiredSlots || "(none)" : "(n/a)",
  );
  dump("A3 metric.compile.kind", metricOwner?.opt.compile?.kind || "(none)");

  const fam = ambiguousMetricFamilyClarify(nl, pack);
  dump("A4 metric-family ambiguous", fam ? `${fam.familyId} → ${fam.message}` : "(not ambiguous)");

  dump("A5 lang signals", {
    userDemandsLangFilter: userDemandsLangFilter(nl),
    impliesLangSetWithoutMembers: impliesLangSetWithoutMembers(nl),
    neededProbeFields: neededProbeFields(nl),
  });
  dump("A6 inferOutputDimsFromNl", inferOutputDimsFromNl(nl, pack));

  // ---- 表选择 ----
  const overlay = overlayTableName(pack);
  dump("A7 overlay table", overlay);
  const named = answerableTableNamedInNl(nl, pack);
  dump("A7 answerableTableNamedInNl", named || "(none)");
  dump("A7 overlayAskFromNl", overlayAskFromNl(nl, pack));
  const ranking = scoreAnswerableTables(nl, pack).slice(0, 8);
  dump("A7 scoreAnswerableTables top8", ranking);

  const resolved = resolveAskTable({ nl, pack });
  dump("A8 resolveAskTable", resolved);

  const lockedTable = resolved.status === "ok" ? resolved.table : undefined;
  const route = routeAnalyticsAsk({
    nl,
    pack,
    lockedTable,
    linkedTables: resolved.status === "ok" ? resolved.linked : [],
    tableConfidence: resolved.status === "ok" ? resolved.confidence : undefined,
    llmSqlEnabled: llmSqlEnabled(),
  });
  dump("A9 routeAnalyticsAsk", route);

  // ---- 表 × 指标 是否可满足 ----
  if (lockedTable) {
    const cols = packFieldsForTable(pack, lockedTable);
    dump(`A10 ${lockedTable}.fields`, cols);
    const dims = inferOutputDimsFromNl(nl, pack);
    const missing = dims.filter((d) => d !== packGrain(pack) && !cols.includes(d));
    dump("A10 requested outputDims NOT on that table (会被静默丢弃)", missing);
    dump("A10 compileTableRef/timeField", {
      ref: lockedTable === overlay ? `${overlay} (overlay, 不写 schema)` : `film_report.${lockedTable}`,
      timeField: packTimeField(pack, lockedTable),
    });
  }
  return { metricId, lockedTable, route, ranking };
}

function packGrain(pack: AnalyticsPack): string {
  return String(pack.time?.grainId || "");
}

/** 打印一轮 ask 的关键落点。 */
function dumpAsk(label: string, r: Awaited<ReturnType<typeof analyticsAsk>>): void {
  console.log(`\n  ▸ ${label}`);
  dump("status", r.status);
  dump("message", (r.message || "").slice(0, 220));
  dump("error", r.error || "(none)");
  dump("clarifySlot", r.clarifySlot || "(none)");
  dump("timeEcho", r.timeEcho || "(none)");
  dump("askState", r.askState
    ? {
        metricId: r.askState.metricId,
        table: r.askState.table || "(undefined → overlay)",
        time: r.askState.time,
        filters: r.askState.filters,
        outputDims: r.askState.outputDims,
        layout: r.askState.layout,
      }
    : "(none)");
  dump("sqls", r.sqls);
}

/**
 * 多轮续答对照：同一个「补槽」句，喂不同的 prevAskState，结论是否天差地别。
 * 复现线上「问日活+留存，却按观影明细表取数」的链路。
 */
async function replayConversation(clock: Date): Promise<void> {
  const askNL = "2026-09-09各语言用户的活跃度 次日留存";
  const slotNL = "channel是 IndiaA FoxA";

  head("【C-1】先造两个候选 prevAskState");
  const priorOk = await analyticsAsk("2026-09-14 按渠道观看人数", { clock });
  dumpAsk('上一轮「成功」问句 → askState（前端在 refuse 后仍会复用它）', priorOk);
  const askTurn = await analyticsAsk(askNL, { clock });
  dumpAsk(`本轮问句 ${JSON.stringify(askNL)}`, askTurn);

  const history = [
    { role: "user" as const, text: askNL },
    { role: "assistant" as const, text: askTurn.message || "" },
    { role: "user" as const, text: slotNL },
  ];

  head("【C-2】对照 A：prevAskState = 本轮问句的 AskState（正确续答）");
  dumpAsk(
    "续答结果",
    await analyticsAsk(slotNL, {
      clock,
      messages: history,
      prevAskState: askTurn.askState,
      lastClarifySlot: askTurn.clarifySlot,
    }),
  );

  head("【C-3】对照 B：prevAskState = 上一轮成功问句的陈旧 AskState（线上真实链路）");
  dumpAsk(
    "续答结果",
    await analyticsAsk(slotNL, {
      clock,
      messages: history,
      prevAskState: priorOk.askState,
      lastClarifySlot: undefined,
    }),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(Boolean);
  /** 默认用例：1) 线上 ledger 实际记录的问句；2) 用户口述问句。 */
  const defaults = [
    "2026-09-01到2026-09-12 INGoogle8,INGoogle10两个渠道、不同新增用户来源的新增用户数，监测每天这两个渠道的不同新增用户来源的结构变化与各来源的同比变化",
  ];
  const positional = args.filter((a) => !a.startsWith("--"));
  const nls = positional.length ? positional : defaults;
  const clock = new Date();
  const base = loadAnalyticsPack("watch-detail");
  const applied = await refreshPackFromCatalog(base, { nl: nls.join("\n") });
  const pack = applied.pack;
  const tz = pack.time.businessTimezone;
  dump("pack.version", pack.version);
  dump("pack.catalog.source", pack.catalog?.source);
  dump("pack.catalog.tableCount/answerable", [
    pack.catalog?.tableCount,
    pack.catalog?.answerableCount,
  ]);
  dump("allowedTableNames count", allowedTableNames(pack).length);

  for (const nl of nls) {
    await deterministicStages(nl, pack, clock, tz);
  }

  head("【B】跑完整 pipeline（含语义模型），看最终落到哪张表");
  for (const nl of nls) {
    const r = await analyticsAsk(nl, { clock });
    console.log(`\n  NL: ${nl}`);
    dump("status", r.status);
    dump("message", (r.message || "").slice(0, 300));
    dump("error", r.error || "(none)");
    dump("clarifySlot", r.clarifySlot || "(none)");
    dump("timeEcho", r.timeEcho || "(none)");
    dump("askState", r.askState
      ? {
          metricId: r.askState.metricId,
          table: r.askState.table || `(undefined → 默认 ${overlayTableName(pack)})`,
          time: r.askState.time,
          filters: r.askState.filters,
          outputDims: r.askState.outputDims,
          layout: r.askState.layout,
          pivotDim: r.askState.pivotDim,
        }
      : "(none)");
    dump("sqls", r.sqls);
    dumpTables(r.tables);
    dump("insight", r.insight || "(none)");
  }

  if (process.argv.includes("--replay")) {
    await replayConversation(clock);
  }

  const repeatArg = process.argv.find((a) => a.startsWith("--repeat"));
  if (repeatArg && nls[0]) {
    const n = Math.max(2, Number(repeatArg.split("=")[1] || 3));
    head(`【D】同一条问句重复 ${n} 次：看落表是否稳定`);
    for (let i = 0; i < n; i++) {
      const r = await analyticsAsk(nls[0]!, { clock });
      const summary = {
        run: i + 1,
        status: r.status,
        table: r.askState?.table || "(undefined→overlay)",
        metricId: r.askState?.metricId || "(none)",
        outputDims: r.askState?.outputDims,
        clarifySlot: r.clarifySlot || "-",
        rows: r.tables?.[0]?.rows?.length ?? 0,
        cols: r.tables?.[0]?.cols,
      };
      console.log(`  ${JSON.stringify(summary)}`);
      if (r.status === "ok" && i === 0) {
        dump("message", r.message);
        dump("sqls", r.sqls);
        dumpTables(r.tables);
        dump("insight", r.insight || "(none)");
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
