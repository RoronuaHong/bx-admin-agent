/**
 * Agent 调用栈追踪（traces）—— 给 Agent 装上「调用栈」。
 *
 * 设计原则（对齐项目零依赖 / 自托管基调）：
 * - 纯 Node 标准库，无新依赖；持久化到 .data/traces/<runId>.jsonl（.gitignore 已忽略 .data）。
 * - 显式 runId 贯穿（不依赖 AsyncLocalStorage：已验证 ALS 在 yield* 异步生成器中不会跨 await 传播）。
 * - 追踪失败绝不影响主流程（appendSpan 吞掉异常；span 创建/结束均为同步轻操作）。
 *
 * 覆盖维度：一次请求 = 1 个 run span + N 个 llm/tool/route span。
 * 每个 llm span 记录 model / 耗时 / token usage（成本维度）/ 重试；
 * 每个 tool span 记录 工具名 / Worker 上下文 / 越权拒绝状态。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

export type SpanKind = "run" | "llm" | "tool" | "route" | "render" | "guard" | "state";
export type SpanStatus = "ok" | "error" | "reject" | "skip";

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface TraceSpan {
  runId: string;
  spanId: string;
  parentSpanId?: string;
  kind: SpanKind;
  name: string;
  model?: string;
  worker?: string;
  attempt?: number;
  status: SpanStatus;
  startMs: number;
  endMs: number;
  durationMs: number;
  usage?: TokenUsage;
  error?: string;
  note?: string;
  meta?: Record<string, unknown>;
}

interface RunMeta {
  runId: string;
  sessionId?: string;
  userText?: string;
  model?: string;
  worker?: string;
  /** 操作者归属（countryId:loginName，P2 溯源；cost/audit 与 trace 关联靠它） */
  ownerKey?: string;
  /** 版本标识（P3：RELEASE env / git 短 sha），run 落盘时随 meta 持久化 */
  release?: string;
  startMs: number;
  endMs?: number;
}

const TRACE_DIR = join(process.cwd(), ".data", "traces");
const runMetas = new Map<string, RunMeta>();

/**
 * 版本标识（P3 版本化）：每次请求的 run 记录「跑在哪个版本上」，
 * 行为回归/成本波动可关联到具体提交，回滚有据可依。
 * 取值优先级：RELEASE 环境变量（部署注入）> git 短 sha > "unknown"。
 * 进程内缓存一次（sha 在进程生命周期内不变，避免每次请求 fork）。
 */
let releaseCache: string | null = null;
export function getRelease(): string {
  if (releaseCache) return releaseCache;
  const env = process.env.RELEASE?.trim();
  if (env) {
    releaseCache = env;
    return releaseCache;
  }
  try {
    releaseCache = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    releaseCache = "unknown";
  }
  return releaseCache;
}

/** trace 落盘目录（供成本聚合等只读消费者遍历，避免各自重复拼路径）。 */
export function getTraceDir(): string {
  return TRACE_DIR;
}

/**
 * 进程内「当前 runId」兜底（单并发调试用）。
 *
 * 主路径仍走显式透传（LangGraph LoopState.traceRunId / 子 Agent 入口参数），
 * 但独立子 Agent 函数或工具若拿不到显式 runId，可退而用 currentRunId()
 * 落到当前 run，避免子 Agent 内部 LLM 轮次脱离主 run 树。
 *
 * 注意：这是「单并发」兜底——多并发场景必须显式透传 runId（见 MULTI_AGENT 文档
 * 「trace 透传契约」）。多并发下 currentRunId 会串，不能作为生产路径。
 */
let currentRunId: string | null = null;
export function setCurrentRunId(runId: string | null): void {
  currentRunId = runId;
}
export function getCurrentRunId(): string | null {
  return currentRunId;
}

/** 开一次请求的根追踪上下文，返回 runId（后续所有 span 都带上它）。 */
export function beginRun(meta: {
  sessionId?: string;
  userText?: string;
  model?: string;
  worker?: string;
  ownerKey?: string;
}): string {
  const runId = randomUUID();
  runMetas.set(runId, {
    runId,
    sessionId: meta.sessionId,
    userText: meta.userText,
    model: meta.model,
    worker: meta.worker,
    ownerKey: meta.ownerKey,
    release: getRelease(),
    startMs: Date.now(),
  });
  // 进程内当前 run 兜底（单并发调试 / 独立子 Agent 函数退路）；多并发必须显式透传
  currentRunId = runId;
  return runId;
}

/** 补写已解析出的真实模型名（chatStream 解析完模型后调用，让 run span 的 model 不再是 ?）。 */
export function setRunModel(runId: string, modelId: string): void {
  const meta = runMetas.get(runId);
  if (meta) meta.model = modelId;
}

/** 结束一次请求：写一条 run 汇总 span（耗时由子 span 起止推导，此处用 run 起止时间）。 */
export function endRun(runId: string): void {
  const meta = runMetas.get(runId);
  if (!meta) return;
  runMetas.delete(runId);
  // 仅当当前 run 兜底仍指向本 run 时才清（多并发下不误清他人）
  if (currentRunId === runId) currentRunId = null;
  const endMs = Date.now();
  appendSpan({
    runId,
    spanId: `run-${runId}`,
    kind: "run",
    name: "chat.run",
    model: meta.model,
    worker: meta.worker,
    status: "ok",
    startMs: meta.startMs,
    endMs,
    durationMs: endMs - meta.startMs,
    meta: { sessionId: meta.sessionId, userText: meta.userText, ownerKey: meta.ownerKey, release: meta.release },
  });
}

export interface SpanHandle {
  id: string;
  end(opts?: {
    status?: SpanStatus;
    usage?: TokenUsage;
    error?: string;
    note?: string;
    meta?: Record<string, unknown>;
  }): TraceSpan;
}

/** 开一个 span（同步、轻量）。返回句柄，调用方在逻辑结束时调 .end()。 */
export function span(
  runId: string,
  kind: SpanKind,
  name: string,
  opts?: {
    parentSpanId?: string;
    model?: string;
    worker?: string;
    attempt?: number;
    note?: string;
    meta?: Record<string, unknown>;
  },
): SpanHandle {
  const startMs = Date.now();
  const spanId = `${kind}-${randomUUID()}`;
  const handle: SpanHandle = {
    id: spanId,
    end(endOpts) {
      const endMs = Date.now();
      const s: TraceSpan = {
        runId,
        spanId,
        parentSpanId: opts?.parentSpanId,
        kind,
        name,
        model: opts?.model,
        worker: opts?.worker,
        attempt: opts?.attempt,
        status: endOpts?.status ?? "ok",
        startMs,
        endMs,
        durationMs: endMs - startMs,
        usage: endOpts?.usage,
        error: endOpts?.error,
        note: endOpts?.note ?? opts?.note,
        meta: endOpts?.meta ?? opts?.meta,
      };
      appendSpan(s);
      return s;
    },
  };
  return handle;
}

function appendSpan(s: TraceSpan): void {
  try {
    if (!existsSync(TRACE_DIR)) mkdirSync(TRACE_DIR, { recursive: true });
    appendFileSync(join(TRACE_DIR, `${s.runId}.jsonl`), JSON.stringify(s) + "\n", "utf8");
  } catch {
    // 追踪失败绝不影响主流程
  }
}

/** 列出最近的 run（按文件修改时间倒序）。 */
export function listRuns(limit = 20): Array<{ runId: string; startMs: number; endMs?: number }> {
  try {
    if (!existsSync(TRACE_DIR)) return [];
    return readdirSync(TRACE_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const runId = f.replace(/\.jsonl$/, "");
        let startMs = 0;
        let endMs: number | undefined;
        try {
          const st = statSync(join(TRACE_DIR, f));
          startMs = st.mtimeMs;
          endMs = st.mtimeMs;
        } catch {
          /* ignore */
        }
        return { runId, startMs, endMs };
      })
      .sort((a, b) => b.startMs - a.startMs)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** 读取一次请求的全部 span（按时间正序）。 */
export function getRun(runId: string): TraceSpan[] {
  try {
    const file = join(TRACE_DIR, `${runId}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as TraceSpan)
      .sort((a, b) => a.startMs - b.startMs);
  } catch {
    return [];
  }
}

/** 返回最近一次请求的 runId（eval 脚本用于「刚跑完的请求」断言）。无数据返回 null。 */
export function latestRunId(): string | null {
  return listRuns(1)[0]?.runId ?? null;
}

export interface RunSummary {
  runId: string;
  startedAt: string;
  durationMs?: number;
  model?: string;
  userText?: string;
  ownerKey?: string;
  release?: string;
  llmRounds: number;
  /** tok=0 / 无 usage 的 llm span 数（未自愈的空响应轮） */
  emptyRounds: number;
  /** callAgentSafe 空响应瞬时重试次数合计（已自愈，仍计入劣化信号） */
  emptyRetries: number;
  toolCalls: number;
  totalTokens: number;
  error?: string;
}

/** 空响应轮签名：无 totalTokens（含 usage 缺失 / tok=0）。 */
export function isEmptyLlmSpan(s: Pick<TraceSpan, "kind" | "usage">): boolean {
  return s.kind === "llm" && !(s.usage?.totalTokens);
}

/** 从 llm spans 汇总空轮 / 瞬时重试（§5.3 劣化信号分子）。 */
export function countEmptySignals(llmSpans: Array<Pick<TraceSpan, "kind" | "usage" | "note" | "meta">>): {
  emptyRounds: number;
  emptyRetries: number;
} {
  let emptyRounds = 0;
  let emptyRetries = 0;
  for (const s of llmSpans) {
    if (s.kind !== "llm") continue;
    if (isEmptyLlmSpan(s)) emptyRounds += 1;
    const n = Number(s.meta?.emptyRetries);
    if (Number.isFinite(n) && n > 0) emptyRetries += n;
  }
  return { emptyRounds, emptyRetries };
}

export interface TraceRunsStats {
  runs: number;
  llmCalls: number;
  tokens: number;
  avgRounds: number;
  /** 未自愈空轮合计 */
  emptyRounds: number;
  /** 瞬时重试合计（已自愈空流） */
  emptyRetries: number;
  /** (emptyRounds+emptyRetries) / (llmCalls+emptyRetries)，保留 3 位小数 */
  emptyRoundRate: number;
  /** 短路收束：≤1 轮且 0 token（疑似未干活） */
  shortCircuitRuns: number;
  /** 超阈值时非空；提示切换模型 / 稍后重试（零业务词） */
  degradeHint: string | null;
}

/** 空轮率告警阈值（0–1）。可用 TRACE_EMPTY_ROUND_RATE_WARN 覆盖，默认 0.2。 */
export function emptyRoundRateWarnThreshold(): number {
  const n = Number(process.env.TRACE_EMPTY_ROUND_RATE_WARN);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.2;
}

/**
 * 最近 N 个 run 的摘要 + 统计（P3 可观测：HTTP 面只读视图的数据源）。
 * @param ownerKey 指定时只返回该操作者的 run（最小权限；旧数据无 ownerKey 被排除——不猜测归属）
 */
export function listRunSummaries(
  limit = 20,
  ownerKey?: string,
): { runs: RunSummary[]; stats: TraceRunsStats } {
  const cap = Math.max(limit, 1) + 30; // 多读一些文件以补偿 owner 过滤后的空缺
  const out: RunSummary[] = [];
  let llmCalls = 0;
  let tokens = 0;
  let emptyRounds = 0;
  let emptyRetries = 0;
  let shortCircuitRuns = 0;
  for (const { runId } of listRuns(cap)) {
    const spans = getRun(runId);
    const runSpan = spans.find((s) => s.kind === "run");
    if (!runSpan) continue;
    const runOwner = (runSpan.meta?.ownerKey as string) || "";
    if (ownerKey && runOwner !== ownerKey) continue;
    const llm = spans.filter((s) => s.kind === "llm");
    const roundTokens = llm.reduce((a, s) => a + (s.usage?.totalTokens || 0), 0);
    const empty = countEmptySignals(llm);
    llmCalls += llm.length;
    tokens += roundTokens;
    emptyRounds += empty.emptyRounds;
    emptyRetries += empty.emptyRetries;
    if (llm.length <= 1 && roundTokens === 0) shortCircuitRuns += 1;
    const errSpan = spans.find((s) => s.status === "error");
    out.push({
      runId,
      startedAt: new Date(runSpan.startMs).toISOString(),
      durationMs: runSpan.durationMs,
      model: runSpan.model,
      userText: (runSpan.meta?.userText as string) || undefined,
      ownerKey: runOwner || undefined,
      release: (runSpan.meta?.release as string) || undefined,
      llmRounds: llm.length,
      emptyRounds: empty.emptyRounds,
      emptyRetries: empty.emptyRetries,
      toolCalls: spans.filter((s) => s.kind === "tool").length,
      totalTokens: roundTokens,
      error: errSpan?.error,
    });
    if (out.length >= limit) break;
  }
  // 分母含瞬时重试次数：重试不另开 llm span，但占用上游调用；分子=未自愈空轮+重试。
  const attempts = llmCalls + emptyRetries;
  const emptyRoundRate = attempts ? Number(((emptyRounds + emptyRetries) / attempts).toFixed(3)) : 0;
  const warn = emptyRoundRateWarnThreshold();
  let degradeHint: string | null = null;
  if (emptyRoundRate >= warn || shortCircuitRuns > 0) {
    const alts = String(process.env.TRACE_DEGRADE_HINT_MODELS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const altPart = alts.length ? `；可切换 EVAL_MODEL 至 ${alts.join("/")}` : "；建议切换 EVAL_MODEL 或稍后重试";
    const parts: string[] = [];
    if (emptyRoundRate >= warn) parts.push(`emptyRoundRate=${emptyRoundRate}≥${warn}`);
    if (shortCircuitRuns > 0) parts.push(`shortCircuitRuns=${shortCircuitRuns}`);
    degradeHint = `上游疑似劣化（${parts.join(", ")}）${altPart}`;
  }
  return {
    runs: out,
    stats: {
      runs: out.length,
      llmCalls,
      tokens,
      avgRounds: out.length ? Number((llmCalls / out.length).toFixed(1)) : 0,
      emptyRounds,
      emptyRetries,
      emptyRoundRate,
      shortCircuitRuns,
      degradeHint,
    },
  };
}
