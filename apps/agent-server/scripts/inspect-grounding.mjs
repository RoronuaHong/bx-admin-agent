// 接地护栏观测 CLI（只读）：把 .data/traces/runs-*.jsonl 里的护栏信号聚成「这张表能不能看出防线在退化」。
//
// 为什么要它：护栏埋点（groundingRetries / groundingVerifications / ungrounded）已经写进 run 级 trace，
// 但没有聚合与告警，护栏好坏只能靠翻日志。这里给出最小可用口径：
//   - ungroundedRate：纠正用尽仍未取得任何工具数据、以诚实兜底收束的比例（模型编造倾向的硬信号）；
//   - retryRate：本轮出现过「零工具数据就直接给结论」被拦下的比例（弱模型/提示词退化的早期信号）；
//   - verifyRate：走完事后核验的比例（太低说明核验被跳过，防线少了一层）。
//
// 用法（PowerShell 下不要传中文参数）：
//   node scripts/inspect-grounding.mjs [--days 7] [--model <id>] [--limit 20] [--json]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TRACE_DIR = resolve(here, "..", ".data", "traces");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const days = Math.max(1, Number(arg("days", 7)) || 7);
const modelFilter = arg("model", "");
const limit = Math.max(1, Number(arg("limit", 20)) || 20);
const asJson = flag("json");

function readRuns() {
  if (!existsSync(TRACE_DIR)) return [];
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const out = [];
  for (const file of readdirSync(TRACE_DIR).filter((n) => /^runs-\d{6}\.jsonl$/.test(n)).sort().reverse()) {
    for (const line of readFileSync(resolve(TRACE_DIR, file), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const run = JSON.parse(line);
        if (typeof run.at !== "number" || run.at < since) continue;
        if (modelFilter && run.model !== modelFilter) continue;
        out.push(run);
      } catch {
        /* 单行损坏忽略 */
      }
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

const runs = readRuns();
const total = runs.length;
const count = (fn) => runs.filter(fn).length;
const pct = (n) => (total ? `${((n / total) * 100).toFixed(1)}%` : "-");

const ungrounded = count((r) => r.ungrounded === true);
const retried = count((r) => (r.groundingRetries || 0) > 0);
const verified = count((r) => (r.groundingVerifications || 0) > 0);
const retries = runs.reduce((sum, r) => sum + (r.groundingRetries || 0), 0);
const verifications = runs.reduce((sum, r) => sum + (r.groundingVerifications || 0), 0);
const avgRounds = total ? (runs.reduce((s, r) => s + (r.rounds || 0), 0) / total).toFixed(2) : "-";

// 按模型分组：护栏命中率按模型差异很大（弱模型显著更高），这是切换模型的依据。
const byModel = new Map();
for (const run of runs) {
  const key = run.model || "unknown";
  const bucket = byModel.get(key) || { runs: 0, ungrounded: 0, retried: 0 };
  bucket.runs += 1;
  if (run.ungrounded) bucket.ungrounded += 1;
  if ((run.groundingRetries || 0) > 0) bucket.retried += 1;
  byModel.set(key, bucket);
}

const summary = {
  windowDays: days,
  model: modelFilter || "(all)",
  runs: total,
  avgRounds,
  ungrounded,
  ungroundedRate: pct(ungrounded),
  groundingRetries: retries,
  retryRate: pct(retried),
  groundingVerifications: verifications,
  verifyRate: pct(verified),
  byModel: [...byModel.entries()]
    .map(([model, b]) => ({ model, runs: b.runs, ungrounded: b.ungrounded, retried: b.retried }))
    .sort((a, b) => b.runs - a.runs),
  worst: runs
    .filter((r) => r.ungrounded || (r.groundingRetries || 0) > 0)
    .slice(0, limit)
    .map((r) => ({
      runId: r.runId,
      at: new Date(r.at).toISOString(),
      model: r.model,
      rounds: r.rounds,
      groundingRetries: r.groundingRetries || 0,
      ungrounded: Boolean(r.ungrounded),
      userText: String(r.userText || "").slice(0, 60),
    })),
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`grounding metrics (last ${days}d, model=${modelFilter || "all"})`);
  console.log(`  runs                    : ${total} (avg rounds ${avgRounds})`);
  console.log(`  ungrounded (blocked)    : ${ungrounded} (${summary.ungroundedRate})`);
  console.log(`  zero-evidence retries   : ${retries} across ${retried} runs (${summary.retryRate})`);
  console.log(`  post-hoc verifications  : ${verifications} across ${verified} runs (${summary.verifyRate})`);
  console.log("  by model:");
  for (const row of summary.byModel) {
    console.log(
      `    ${row.model.padEnd(28)} runs=${String(row.runs).padStart(4)}  ungrounded=${row.ungrounded}  retried=${row.retried}`,
    );
  }
  if (summary.worst.length) {
    console.log(`  recent guarded runs (top ${summary.worst.length}):`);
    for (const row of summary.worst) {
      console.log(
        `    ${row.at}  ${row.model || "-"}  retries=${row.groundingRetries}${row.ungrounded ? "  UNGROUNDED" : ""}  ${row.userText}`,
      );
    }
  }
}

// 告警口径：ungrounded 率超过阈值就是「模型在编造」的可观测信号，CI/定时任务可直接看退出码。
const ALERT_UNGROUNDED_RATE = Number(process.env.ALERT_UNGROUNDED_RATE || 0);
if (ALERT_UNGROUNDED_RATE > 0 && total > 0 && ungrounded / total > ALERT_UNGROUNDED_RATE) {
  console.error(
    `ALERT: ungrounded rate ${summary.ungroundedRate} > ${(ALERT_UNGROUNDED_RATE * 100).toFixed(1)}%`,
  );
  process.exitCode = 1;
}
