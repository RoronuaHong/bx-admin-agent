// 运行追踪（agent-infrastructure §10 最小版）：
// 一次对话任务收束后落一行 run 级 JSONL（runId / 会话归属 / 模型 / 轮次 / token / 耗时 / 状态 / 错误），
// 是「看得见每一次运行」的地基——排障、评测基线、成本聚合都从这里起步。
// 状态统计取自任务事件缓冲（usage / model / error 事件），零侵入模型循环。
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** trace 落盘目录（成本聚合消费同一份 JSONL）。 */
export const TRACE_DIR = resolve(__dirname, "..", ".data", "traces");

export type RunStatus = "success" | "failed" | "cancelled";

export interface RunTrace {
  runId: string;
  at: number;
  conversationId: string;
  sessionId?: string;
  ownerKey?: string;
  /** 用户输入（截断，便于回放对照；凭据类内容不应进输入框）。 */
  userText?: string;
  model?: string;
  status: RunStatus;
  durationMs: number;
  rounds?: number;
  toolCalls?: number;
  tokens?: number;
  costTokens?: number;
  modelRetries?: number;
  modelFallbacks?: number;
  /** 接地护栏纠正次数（零数据作答被拦截并回灌提示的次数）：评测 G7 与劣化排查的信号。 */
  groundingRetries?: number;
  /** 事后核验次数（收束前对「回答 vs 本轮证据」做断言级核对）。 */
  groundingVerifications?: number;
  /** 纠正用尽仍未取得工具数据、以确定性拒答收束（>0 说明本轮模型有编造倾向）。 */
  ungrounded?: boolean;
  error?: string;
  /** 代码版本（git sha / RELEASE env）：评测基线与排障按版本对比的必要条件。 */
  release?: string;
}

// ---- release 标记（§13 最小版）：RELEASE env 优先 > git sha（进程内缓存一次）> unknown ----
let releaseCache: string | undefined;
export function getRelease(): string {
  if (releaseCache) return releaseCache;
  const fromEnv = (process.env.RELEASE || "").trim();
  if (fromEnv) {
    releaseCache = fromEnv;
    return releaseCache;
  }
  try {
    releaseCache = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: resolve(__dirname, "..", "..", ".."),
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    releaseCache = "unknown";
  }
  return releaseCache;
}

export function newRunId(): string {
  return `run_${randomUUID()}`;
}

function monthFile(at: number): string {
  const d = new Date(at);
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
  return resolve(TRACE_DIR, `runs-${ym}.jsonl`);
}

/** 追加一条 run 级追踪；append-only，失败仅告警不抛错（best-effort，不阻断对话）。 */
export function appendRunTrace(trace: RunTrace): void {
  try {
    mkdirSync(TRACE_DIR, { recursive: true });
    appendFileSync(monthFile(trace.at), `${JSON.stringify(trace)}\n`, "utf-8");
  } catch (err) {
    console.warn(`[trace] 写入失败：${String((err as Error)?.message || err)}`);
  }
}

/** 逐轮运行快照：一次 run 内每个工具循环轮次的一行记录，按 runId 分文件 append-only（§12.6 疑问①：让重复探查 / 预算耗尽 / 熔断可被复盘）。 */
export interface RoundTrace {
  runId: string;
  round: number;
  at: number;
  /** 本轮模式：综合轮（模型直接收束答复）或工具轮。 */
  mode: "synthesis" | "tool";
  /** 本轮实际执行的工具调用数（同轮去重 / 未执行的请求不计）。 */
  toolCallsThisRound: number;
  /** 较上一轮的增量（避免逐轮重复写累计值）。 */
  clearedDelta: number;
  offloadedDelta: number;
  /** 截至本轮累计的「接地证据」工具成功次数。 */
  groundingEvidence: number;
  /** 截至本轮累计的 prompt token 估算（成本护栏累计）。 */
  spentTokens: number;
  /** 收束备注（如 failure / doom-loop 熔断 / 预算耗尽补位）。 */
  note?: string;
}

function roundFile(runId: string): string {
  return resolve(TRACE_DIR, `rounds-${runId}.jsonl`);
}

/** 追加一条逐轮快照；best-effort，失败仅告警不抛错（不阻断对话）。 */
export function appendRoundTrace(entry: RoundTrace): void {
  try {
    mkdirSync(TRACE_DIR, { recursive: true });
    appendFileSync(roundFile(entry.runId), `${JSON.stringify(entry)}\n`, "utf-8");
  } catch (err) {
    console.warn(`[trace] 逐轮写入失败：${String((err as Error)?.message || err)}`);
  }
}

// ───────────────────────── span 级埋点（llm / tool 分层） ─────────────────────────
// run 级回答「这次运行怎么样」，轮级回答「每一轮做了什么」，但都回答不了
// 「时间到底花在哪一次模型调用 / 哪一个工具上」——这正是与 OTel 的主要差距（B 章「可观测」）。
// 这里补最小的一层：只记**耗时、成功与否、规模**，不记内容（内容属于上下文治理，不该再抄一份）。
// 落盘方式与轮级一致：按 runId 分文件 append-only，best-effort。

export type SpanKind = "llm" | "tool";

export interface SpanTrace {
  runId: string;
  /** span 起始时刻。 */
  at: number;
  kind: SpanKind;
  /** 工具名（tool）/ 模型标识（llm）。 */
  name?: string;
  durationMs: number;
  ok?: boolean;
  /** token（llm span 才有；含 prompt+completion 的估算或 usage 上报值）。 */
  tokens?: number;
  /** 失败原因（截断，不落原文）。 */
  error?: string;
  /**
   * 对齐 OpenTelemetry GenAI 语义约定的属性名（可观测互操作性）。
   * 自带 trace 结构之外再挂一份标准属性（`gen_ai.*`），日后导出到 OTel 后端或与其它
   * 可观测系统对齐时无需改数据结构——格式自有、语义标准。
   */
  attrs?: Record<string, string | number | boolean>;
}

function spanFile(runId: string): string {
  return resolve(TRACE_DIR, `spans-${runId}.jsonl`);
}

/** 追加一条 span；best-effort，失败仅告警不抛错（不阻断对话）。 */
export function appendSpanTrace(entry: SpanTrace): void {
  try {
    mkdirSync(TRACE_DIR, { recursive: true });
    appendFileSync(spanFile(entry.runId), `${JSON.stringify(entry)}\n`, "utf-8");
  } catch (err) {
    console.warn(`[trace] span 写入失败：${String((err as Error)?.message || err)}`);
  }
}

/** 只读：某次 run 的 span 列表（按时间正序，便于看调用链）。 */
export function listSpanTraces(runId: string, limit = 200): SpanTrace[] {
  const file = spanFile(runId);
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf-8").split("\n");
    const out: SpanTrace[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as SpanTrace);
      } catch {
        /* 单行损坏忽略 */
      }
      if (out.length >= Math.max(1, Math.min(2000, limit))) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 按 runId 回查 run 记录（span 端点做归属校验用）。
 * span 文件本身不带 owner —— 不回查就能拿别人的 runId 看整条调用链，所以这一步是必须的。
 */
export function findRunTrace(runId: string): RunTrace | undefined {
  const id = String(runId || "").trim();
  if (!id || !existsSync(TRACE_DIR)) return undefined;
  const files = readdirSync(TRACE_DIR)
    .filter((name) => /^runs-\d{6}\.jsonl$/.test(name))
    .sort()
    .reverse();
  for (const file of files) {
    let lines: string[] = [];
    try {
      lines = readFileSync(resolve(TRACE_DIR, file), "utf-8").split("\n").reverse();
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const run = JSON.parse(line) as RunTrace;
        if (run.runId === id) return run;
      } catch {
        /* 单行损坏忽略 */
      }
    }
  }
  return undefined;
}

export interface RunTraceFilter {
  ownerKey?: string;
  conversationId?: string;
  limit?: number;
}

/** 只读查询：按时间倒序返回最近 N 条（ownerKey 过滤在读取侧做，与审计同口径）。 */
export function listRunTraces(filter: RunTraceFilter = {}): RunTrace[] {
  const limit = Math.max(1, Math.min(200, Math.floor(Number(filter.limit)) || 50));
  if (!existsSync(TRACE_DIR)) return [];
  const out: RunTrace[] = [];
  const files = readdirSync(TRACE_DIR)
    .filter((name) => /^runs-\d{6}\.jsonl$/.test(name))
    .sort()
    .reverse();
  for (const file of files) {
    if (out.length >= limit) break;
    let lines: string[] = [];
    try {
      lines = readFileSync(resolve(TRACE_DIR, file), "utf-8").split("\n").reverse();
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const run = JSON.parse(line) as RunTrace;
        if (filter.ownerKey && run.ownerKey !== filter.ownerKey) continue;
        if (filter.conversationId && run.conversationId !== filter.conversationId) continue;
        out.push(run);
        if (out.length >= limit) return out;
      } catch {
        /* 单行损坏忽略 */
      }
    }
  }
  return out;
}
