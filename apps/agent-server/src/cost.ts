/**
 * 成本聚合（P1）—— 从 trace 落盘的 span 数据聚合 token / 计费。
 *
 * 定位：trace.ts 负责「采集」（每个 llm span 记 usage），本模块负责「聚合」
 * （按日 / 按模型 / 按会话汇总 + 预算告警）。两者分离，采集侧零感知。
 *
 * 设计原则：
 * - 纯只读：只遍历 trace 目录，不改任何 trace 数据。
 * - 零业务词：聚合维度只有「时间 / 模型 / 会话 / 工具」这些通用维度，
 *   不含任何业务模块名或业务术语（红线：服务端禁止写死业务词）。
 * - 零新依赖：仅 Node 标准库。
 * - 单价可配：模型单价从环境变量读取（COST_RATE_<MODEL>_PROMPT / _COMPLETION，
 *   单位「每百万 token」），未配置则只统计 token 不估算费用（诚实不编造单价）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getTraceDir } from "./trace.js";
import type { TraceSpan } from "./trace.js";

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 估算费用（仅当该模型配了单价才 >0；未配置单价计入 unpricedTokens） */
  cost: number;
  unpricedTokens: number;
  llmCalls: number;
  runs: number;
}

export interface CostReport {
  /** 统计窗口（ISO 日期，闭区间） */
  fromDay?: string;
  toDay?: string;
  totals: UsageTotals;
  byDay: Array<{ day: string } & UsageTotals>;
  byModel: Array<{ model: string } & UsageTotals>;
  bySession: Array<{ sessionId: string } & UsageTotals>;
  /** 按操作者（countryId:loginName）汇总；旧数据无 ownerKey 归入 "unknown" */
  byOwner: Array<{ ownerKey: string } & UsageTotals>;
  /** 慢调用 Top N（llm span 按耗时降序），用于定位性能与成本热点 */
  slowestCalls: Array<{ runId: string; model?: string; durationMs: number; totalTokens: number; at: string }>;
}

const empty = (): UsageTotals => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cost: 0,
  unpricedTokens: 0,
  llmCalls: 0,
  runs: 0,
});

/**
 * 读取模型单价（单位：每百万 token 的计价单位）。
 * 环境变量：COST_RATE_<MODEL_ID 大写化>_PROMPT / _COMPLETION
 * 未配置返回 undefined（此时不估算费用，token 计入 unpricedTokens）。
 */
function rateOf(modelId: string): { prompt?: number; completion?: number } {
  const key = modelId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const p = Number(process.env[`COST_RATE_${key}_PROMPT`]);
  const c = Number(process.env[`COST_RATE_${key}_COMPLETION`]);
  return {
    prompt: Number.isFinite(p) && p > 0 ? p : undefined,
    completion: Number.isFinite(c) && c > 0 ? c : undefined,
  };
}

function addUsage(t: UsageTotals, s: TraceSpan): void {
  const p = s.usage?.promptTokens || 0;
  const c = s.usage?.completionTokens || 0;
  const total = s.usage?.totalTokens || p + c;
  t.promptTokens += p;
  t.completionTokens += c;
  t.totalTokens += total;
  t.llmCalls += 1;
  const rate = rateOf(s.model || "");
  if (rate.prompt !== undefined && rate.completion !== undefined) {
    t.cost += (p / 1_000_000) * rate.prompt + (c / 1_000_000) * rate.completion;
  } else {
    t.unpricedTokens += total;
  }
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 列出 trace 目录下所有 run 的 span（按 run 分组）。 */
function readAllRuns(): Array<{ runId: string; spans: TraceSpan[] }> {
  const dir = getTraceDir();
  if (!existsSync(dir)) return [];
  const out: Array<{ runId: string; spans: TraceSpan[] }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const spans = readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as TraceSpan)
        .sort((a, b) => a.startMs - b.startMs);
      out.push({ runId: f.replace(/\.jsonl$/, ""), spans });
    } catch {
      // 单个损坏文件跳过，不中断整体聚合
    }
  }
  return out;
}

/**
 * 聚合成本。
 * @param opts.fromDay / toDay  ISO 日期过滤（含边界，如 "2026-09-04"）
 * @param opts.sessionId        只统计某个会话
 * @param opts.ownerKey         只统计某操作者（P2 溯源；run span meta.ownerKey，
 *                              旧数据无 ownerKey 会被过滤——诚实不猜测归属）
 * @param opts.slowestTopN      慢调用 Top N（默认 10）
 */
export function aggregateCost(opts?: {
  fromDay?: string;
  toDay?: string;
  sessionId?: string;
  ownerKey?: string;
  slowestTopN?: number;
}): CostReport {
  const { fromDay, toDay, sessionId, ownerKey, slowestTopN = 10 } = opts || {};
  const totals = empty();
  const dayMap = new Map<string, UsageTotals>();
  const modelMap = new Map<string, UsageTotals>();
  const sessionMap = new Map<string, UsageTotals>();
  const ownerMap = new Map<string, UsageTotals>();
  const slowest: CostReport["slowestCalls"] = [];

  for (const { runId, spans } of readAllRuns()) {
    const runSpan = spans.find((s) => s.kind === "run");
    if (!runSpan) continue;
    const day = dayOf(runSpan.startMs);
    if (fromDay && day < fromDay) continue;
    if (toDay && day > toDay) continue;
    const sid = (runSpan.meta?.sessionId as string) || "";
    if (sessionId && sid !== sessionId) continue;
    const runOwner = (runSpan.meta?.ownerKey as string) || "";
    if (ownerKey && runOwner !== ownerKey) continue;

    totals.runs += 1;
    const d = dayMap.get(day) || empty();
    d.runs += 1;
    // run 级维度（会话/操作者）的 runs 计数与 totals 同步（bucket 在 llm 循环内懒创建，
    // 这里先确保存在并 +1，避免 bySession/byOwner 的 runs 恒为 0）
    const st0 = sessionMap.get(sid || "unknown") || empty();
    st0.runs += 1;
    sessionMap.set(sid || "unknown", st0);
    const ot0 = ownerMap.get(runOwner || "unknown") || empty();
    ot0.runs += 1;
    ownerMap.set(runOwner || "unknown", ot0);

    for (const s of spans) {
      if (s.kind !== "llm") continue;
      addUsage(totals, s);
      addUsage(d, s);

      const m = s.model || "unknown";
      const mt = modelMap.get(m) || empty();
      addUsage(mt, s);
      modelMap.set(m, mt);

      const st = sessionMap.get(sid || "unknown") || empty();
      addUsage(st, s);
      sessionMap.set(sid || "unknown", st);

      const ot = ownerMap.get(runOwner || "unknown") || empty();
      addUsage(ot, s);
      ownerMap.set(runOwner || "unknown", ot);

      slowest.push({
        runId,
        model: s.model,
        durationMs: s.durationMs,
        totalTokens: s.usage?.totalTokens || 0,
        at: new Date(s.startMs).toISOString(),
      });
    }
    dayMap.set(day, d);
  }

  slowest.sort((a, b) => b.durationMs - a.durationMs);
  const sortByTokens = (a: UsageTotals, b: UsageTotals) => b.totalTokens - a.totalTokens;

  return {
    fromDay,
    toDay,
    totals,
    byDay: [...dayMap.entries()]
      .map(([day, v]) => ({ day, ...v }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    byModel: [...modelMap.entries()].map(([model, v]) => ({ model, ...v })).sort(sortByTokens),
    bySession: [...sessionMap.entries()]
      .map(([sid, v]) => ({ sessionId: sid, ...v }))
      .sort(sortByTokens),
    byOwner: [...ownerMap.entries()]
      .map(([ok, v]) => ({ ownerKey: ok, ...v }))
      .sort(sortByTokens),
    slowestCalls: slowest.slice(0, slowestTopN),
  };
}

/**
 * 预算告警：判断聚合结果是否超阈值。
 * 阈值走环境变量（DAILY_TOKEN_BUDGET / RUN_TOKEN_BUDGET），未配置则不告警（返回空）。
 */
export function budgetAlerts(report: CostReport): string[] {
  const alerts: string[] = [];
  const daily = Number(process.env.DAILY_TOKEN_BUDGET);
  const perRun = Number(process.env.RUN_TOKEN_BUDGET);
  if (Number.isFinite(daily) && daily > 0) {
    for (const d of report.byDay) {
      if (d.totalTokens > daily) {
        alerts.push(`日预算超限：${d.day} tokens=${d.totalTokens} > ${daily}`);
      }
    }
  }
  if (Number.isFinite(perRun) && perRun > 0 && report.totals.runs > 0) {
    const avg = Math.round(report.totals.totalTokens / report.totals.runs);
    if (avg > perRun) alerts.push(`单次请求均值超限：avg tokens=${avg} > ${perRun}`);
  }
  return alerts;
}
