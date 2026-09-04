/**
 * 成本聚合查看（P1）：从 trace 落盘数据聚合 token / 费用。
 *
 * 用法（需 tsx 解析 .ts 模块：.\\node_modules\\.bin\\tsx.cmd）：
 *   tsx scripts/inspect-cost.mjs                      全部汇总
 *   tsx scripts/inspect-cost.mjs --from 2026-09-01    按起始日过滤
 *   tsx scripts/inspect-cost.mjs --from X --to Y      日期区间
 *   tsx scripts/inspect-cost.mjs --session <sid>      仅某会话
 *   tsx scripts/inspect-cost.mjs --top 20             慢调用 Top N
 *
 * 环境变量（可选）：
 *   COST_RATE_<MODEL>_PROMPT / _COMPLETION   模型单价（每百万 token），未配只统计 token
 *   DAILY_TOKEN_BUDGET / RUN_TOKEN_BUDGET    预算阈值，超出时输出告警
 *
 * 红线：本脚本不含任何业务词，聚合维度仅为时间/模型/会话/耗时（通用维度）。
 */
import { aggregateCost, budgetAlerts } from "../src/cost.ts";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const report = aggregateCost({
  fromDay: flag("from"),
  toDay: flag("to"),
  sessionId: flag("session"),
  slowestTopN: Number(flag("top")) || 10,
});

const t = report.totals;
const win = report.fromDay || report.toDay ? ` [${report.fromDay || "…"} ~ ${report.toDay || "…"}]` : "";
console.log(`\n===== 成本聚合${win} =====`);
console.log(
  `总计: runs=${t.runs} llmCalls=${t.llmCalls} tokens=${t.totalTokens} (prompt=${t.promptTokens} completion=${t.completionTokens})`,
);
console.log(
  t.unpricedTokens > 0
    ? `费用: ${t.cost.toFixed(4)}（注意：${t.unpricedTokens} tokens 因模型未配单价未计入，配 COST_RATE_* 可估算）`
    : `费用: ${t.cost.toFixed(4)}`,
);

if (report.byDay.length) {
  console.log(`\n-- 按日 --`);
  for (const d of report.byDay) {
    console.log(`  ${d.day}  runs=${d.runs} calls=${d.llmCalls} tokens=${d.totalTokens} cost=${d.cost.toFixed(4)}`);
  }
}

if (report.byModel.length) {
  console.log(`\n-- 按模型 --`);
  for (const m of report.byModel) {
    console.log(`  ${m.model}  calls=${m.llmCalls} tokens=${m.totalTokens} cost=${m.cost.toFixed(4)}`);
  }
}

if (report.bySession.length) {
  console.log(`\n-- 按会话（Top ${Math.min(report.bySession.length, 10)}）--`);
  for (const s of report.bySession.slice(0, 10)) {
    console.log(`  ${s.sessionId}  calls=${s.llmCalls} tokens=${s.totalTokens} cost=${s.cost.toFixed(4)}`);
  }
}

if (report.slowestCalls.length) {
  console.log(`\n-- 慢调用 Top ${report.slowestCalls.length} --`);
  for (const c of report.slowestCalls) {
    console.log(`  ${c.durationMs}ms tokens=${c.totalTokens} model=${c.model || "?"} at=${c.at} run=${c.runId.slice(0, 8)}`);
  }
}

const alerts = budgetAlerts(report);
if (alerts.length) {
  console.log(`\n!! 预算告警 !!`);
  for (const a of alerts) console.log(`  - ${a}`);
  process.exitCode = 1;
}
