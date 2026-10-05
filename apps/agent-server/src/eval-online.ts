/**
 * 在线评测闭环（P1）：把「遥测」变成「质量信号」，而不只是留档。
 *
 * 缺口：评测目前只有**测试闸门**（G1–G7，随 `pnpm test` 跑），回答不了
 * 「线上真实运行的质量是在变好还是变坏」。OTel 对 Agent 可观测的定位也正是
 * 「telemetry 作为 evaluation 的反馈回路」——trace 不应只用于排障，还应回流成质量分数。
 *
 * 设计取舍（重要）：
 * - **纯确定性打分，不调模型**：不引入 LLM-as-judge。在线评测要跑在每一次真实运行上，
 *   再叠一次模型调用等于把成本翻倍，还会引入「评委偏好」。这里只用 trace 已经如实记录的字段
 *   （是否收束 / 是否取证 / 轮数 / token / 耗时 / 模型切换 / 纠正次数）判——判不了的就不判，
 *   绝不用「看起来像」的启发式凑维度。
 * - **best-effort**：落盘失败只告警，绝不阻断对话。
 * - **零业务词**：维度是通用质量语义（收束 / 取证 / 效率 / 稳定性 / 纠正），
 *   不含任何业务词（符合「禁写死」红线）。
 * - 阈值全走环境变量，未配置用默认值。
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunTrace } from "./trace.js";
import { incCounter, observeSummary } from "./process-metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = resolve(__dirname, "..", ".data", "eval");

function threshold(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export interface RunEvalScore {
  runId: string;
  at: number;
  conversationId: string;
  ownerKey?: string;
  model?: string;
  release?: string;
  /** good = 全部达标；degraded = 1 项不达标；poor = ≥2 项不达标。 */
  verdict: "good" | "degraded" | "poor";
  /** 达标项占比（0–1）。 */
  score: number;
  /** 未达标的维度名（通用质量语义，非业务词）。 */
  failed: string[];
  status: RunTrace["status"];
}

/**
 * 纯函数：给一条 run 级 trace 打分。
 * 缺字段按「该维度不适用」处理（不计入分母），绝不因为没数据就判差——诚实优先。
 */
export function scoreRunTrace(rt: RunTrace): RunEvalScore {
  const failed: string[] = [];
  let total = 0;

  const check = (axis: string, ok: boolean) => {
    total += 1;
    if (!ok) failed.push(axis);
  };

  check("converged", rt.status === "success");
  check("grounded", rt.ungrounded !== true);

  const rounds = rt.rounds;
  if (typeof rounds === "number") {
    check("rounds", rounds <= threshold("EVAL_MAX_ROUNDS", 8));
  }
  const tokens = rt.tokens ?? rt.costTokens;
  if (typeof tokens === "number") {
    check("tokens", tokens <= threshold("EVAL_MAX_TOKENS", 60_000));
  }
  if (typeof rt.durationMs === "number") {
    check("latency", rt.durationMs <= threshold("EVAL_MAX_DURATION_MS", 180_000));
  }
  if (typeof rt.modelFallbacks === "number" || typeof rt.modelRetries === "number") {
    check(
      "stability",
      (rt.modelFallbacks ?? 0) <= threshold("EVAL_MAX_MODEL_FALLBACKS", 1) &&
        (rt.modelRetries ?? 0) <= threshold("EVAL_MAX_MODEL_RETRIES", 2),
    );
  }
  if (typeof rt.groundingRetries === "number") {
    check("correction", rt.groundingRetries <= threshold("EVAL_MAX_GROUNDING_RETRIES", 1));
  }

  const score = total ? (total - failed.length) / total : 0;
  const verdict: RunEvalScore["verdict"] =
    failed.length === 0 ? "good" : failed.length === 1 ? "degraded" : "poor";
  return {
    runId: rt.runId,
    at: rt.at,
    conversationId: rt.conversationId,
    ...(rt.ownerKey ? { ownerKey: rt.ownerKey } : {}),
    ...(rt.model ? { model: rt.model } : {}),
    ...(rt.release ? { release: rt.release } : {}),
    verdict,
    score,
    failed: [...failed],
    status: rt.status,
  };
}

function monthFile(at: number): string {
  const d = new Date(at);
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
  return resolve(EVAL_DIR, `eval-${ym}.jsonl`);
}

/** 打分 + 落盘 + 打点；best-effort，失败只告警（绝不阻断对话）。 */
export function recordRunEval(rt: RunTrace): RunEvalScore | null {
  let scored: RunEvalScore;
  try {
    scored = scoreRunTrace(rt);
  } catch (err) {
    console.warn(`[eval] 打分失败：${String((err as Error)?.message || err)}`);
    return null;
  }
  try {
    mkdirSync(EVAL_DIR, { recursive: true });
    appendFileSync(monthFile(scored.at), `${JSON.stringify(scored)}\n`, "utf-8");
  } catch (err) {
    console.warn(`[eval] 写入失败：${String((err as Error)?.message || err)}`);
  }
  try {
    incCounter("bx_agent_eval_runs_total", "在线评测运行数（按结论）", { verdict: scored.verdict });
    observeSummary("bx_agent_eval_score", "在线评测达标项占比", {}, scored.score);
    if (scored.verdict !== "good") {
      console.warn(`[eval] run ${scored.runId} ${scored.verdict}：未达标维度 ${scored.failed.join("、")}`);
    }
  } catch {
    /* 指标打点不能影响主流程 */
  }
  return scored;
}

export interface EvalFilter {
  ownerKey?: string;
  limit?: number;
  from?: number;
}

/** 只读：最近的评测记录（倒序）。ownerKey 隔离：只看自己的 + 无主遗留。 */
export function listRunEvals(filter: EvalFilter = {}): RunEvalScore[] {
  if (!existsSync(EVAL_DIR)) return [];
  const limit = Math.max(1, Math.min(1000, Math.floor(filter.limit || 100)));
  const files = readdirSync(EVAL_DIR)
    .filter((f) => f.startsWith("eval-") && f.endsWith(".jsonl"))
    .sort()
    .reverse();
  const out: RunEvalScore[] = [];
  for (const file of files) {
    let lines: string[];
    try {
      lines = readFileSync(resolve(EVAL_DIR, file), "utf-8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line) as RunEvalScore;
        if (filter.ownerKey && item.ownerKey && item.ownerKey !== filter.ownerKey) continue;
        if (filter.from && item.at < filter.from) continue;
        out.push(item);
      } catch {
        /* 单行损坏忽略 */
      }
    }
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

export interface EvalSummary {
  runs: number;
  avgScore: number;
  good: number;
  degraded: number;
  poor: number;
  /** 未达标维度计数：定位「到底是哪个维度在劣化」。 */
  axisFailures: Array<{ axis: string; count: number }>;
  /** 劣质占比超阈值 → true（供告警/看板判断）。 */
  qualityDegraded: boolean;
}

/** 只读聚合：一段时间内的质量概览。 */
export function summarizeEval(filter: EvalFilter & { days?: number } = {}): EvalSummary {
  const days = Math.max(1, Math.min(90, Number(filter.days) || 7));
  const from = Date.now() - days * 86_400_000;
  const items = listRunEvals({ ownerKey: filter.ownerKey, from, limit: 1000 });
  const axisMap = new Map<string, number>();
  let sum = 0;
  let good = 0;
  let degraded = 0;
  let poor = 0;
  for (const item of items) {
    sum += item.score;
    if (item.verdict === "good") good += 1;
    else if (item.verdict === "degraded") degraded += 1;
    else poor += 1;
    for (const axis of item.failed) axisMap.set(axis, (axisMap.get(axis) || 0) + 1);
  }
  const badRatio = items.length ? (degraded + poor) / items.length : 0;
  const limit = Number(process.env.EVAL_DEGRADE_RATIO) || 0.3;
  return {
    runs: items.length,
    avgScore: items.length ? Number((sum / items.length).toFixed(3)) : 0,
    good,
    degraded,
    poor,
    axisFailures: [...axisMap.entries()]
      .map(([axis, count]) => ({ axis, count }))
      .sort((a, b) => b.count - a.count),
    qualityDegraded: items.length >= 5 && badRatio > limit,
  };
}
