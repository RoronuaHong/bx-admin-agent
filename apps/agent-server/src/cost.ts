// 成本计量（agent-infrastructure §12 最小版）：消费 trace 落盘的 run 级记录做只读聚合。
// 计量口径：tokens 为运行时估算（prompt 侧累计，非精确计费数字）；
// 单价用 COST_RATE_<模型ID大写>_PER_1K（每 1k token 的价格）配置——未配置的模型只计 token 并计入
// unpricedTokens，如实显示"未定价"，绝不编造金额。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { TRACE_DIR, type RunTrace } from "./trace.js";

export interface CostBucket {
  runs: number;
  tokens: number;
  cost: number;
  unpricedTokens: number;
}

export interface CostSummary {
  days: number;
  totals: CostBucket;
  byDay: Array<{ date: string } & CostBucket>;
  byModel: Array<{ model: string } & CostBucket>;
  slowest: Array<{ runId: string; model?: string; durationMs: number; at: number }>;
  budgetAlerts?: string[];
}

function rateOf(model?: string): number | null {
  if (!model) return null;
  const raw = process.env[`COST_RATE_${model.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PER_1K`];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function addTo(bucket: CostBucket, run: RunTrace, tokens: number): void {
  bucket.runs += 1;
  bucket.tokens += tokens;
  const rate = rateOf(run.model);
  if (rate === null) bucket.unpricedTokens += tokens;
  else bucket.cost += (tokens / 1000) * rate;
}

function monthFilesInRange(from: number, to: number): string[] {
  if (!existsSync(TRACE_DIR)) return [];
  return readdirSync(TRACE_DIR)
    .filter((name) => /^runs-\d{6}\.jsonl$/.test(name))
    .sort()
    .reverse()
    .filter((name) => {
      const ym = name.slice(5, 11); // runs-YYYYMM.jsonl
      const start = new Date(Number(ym.slice(0, 4)), Number(ym.slice(4, 6)) - 1, 1).getTime();
      const end = new Date(Number(ym.slice(0, 4)), Number(ym.slice(4, 6)), 1).getTime() - 1;
      return end >= from && start <= to;
    });
}

/** 按时间窗聚合（from/to 为毫秒时间戳）；ownerKey 过滤在读取侧做（与审计/trace 同口径）。 */
export function summarizeCost(filter: { ownerKey?: string; days?: number } = {}): CostSummary {
  const days = Math.max(1, Math.min(90, Math.floor(Number(filter.days)) || 7));
  const now = Date.now();
  const from = new Date(now - (days - 1) * 86400_000);
  from.setHours(0, 0, 0, 0);
  const totals: CostBucket = { runs: 0, tokens: 0, cost: 0, unpricedTokens: 0 };
  const byDayMap = new Map<string, CostBucket>();
  const byModelMap = new Map<string, CostBucket>();
  const runs: RunTrace[] = [];

  for (const file of monthFilesInRange(from.getTime(), now)) {
    let lines: string[] = [];
    try {
      lines = readFileSync(resolve(TRACE_DIR, file), "utf-8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      let run: RunTrace;
      try {
        run = JSON.parse(line) as RunTrace;
      } catch {
        continue;
      }
      if (run.at < from.getTime() || run.at > now) continue;
      if (filter.ownerKey && run.ownerKey !== filter.ownerKey) continue;
      runs.push(run);
      const tokens = Math.max(0, Math.floor(Number(run.tokens)) || 0);
      const day = new Date(run.at).toISOString().slice(0, 10);
      addTo(totals, run, tokens);
      const dayBucket = byDayMap.get(day) || { runs: 0, tokens: 0, cost: 0, unpricedTokens: 0 };
      addTo(dayBucket, run, tokens);
      byDayMap.set(day, dayBucket);
      const model = run.model || "unknown";
      const modelBucket = byModelMap.get(model) || { runs: 0, tokens: 0, cost: 0, unpricedTokens: 0 };
      addTo(modelBucket, run, tokens);
      byModelMap.set(model, modelBucket);
    }
  }

  // 预算告警（§12）：日 token 预算 / 日成本预算（未配则不告警）。
  const budgetAlerts: string[] = [];
  const dailyTokenBudget = Number(process.env.DAILY_TOKEN_BUDGET) || 0;
  const dailyCostBudget = Number(process.env.DAILY_COST_BUDGET) || 0;
  for (const [date, bucket] of [...byDayMap.entries()].sort()) {
    if (dailyTokenBudget > 0 && bucket.tokens > dailyTokenBudget) {
      budgetAlerts.push(`${date}: token ${bucket.tokens} 超过日预算 ${dailyTokenBudget}`);
    }
    if (dailyCostBudget > 0 && bucket.cost > dailyCostBudget) {
      budgetAlerts.push(`${date}: 费用 ${bucket.cost.toFixed(4)} 超过日预算 ${dailyCostBudget}`);
    }
  }

  return {
    days,
    totals,
    byDay: [...byDayMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, bucket]) => ({ date, ...bucket })),
    byModel: [...byModelMap.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([model, bucket]) => ({ model, ...bucket })),
    slowest: runs
      .slice()
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 5)
      .map((run) => ({ runId: run.runId, model: run.model, durationMs: run.durationMs, at: run.at })),
    ...(budgetAlerts.length ? { budgetAlerts: [...budgetAlerts] } : {}),
  };
}
