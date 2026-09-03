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
  startMs: number;
  endMs?: number;
}

const TRACE_DIR = join(process.cwd(), ".data", "traces");
const runMetas = new Map<string, RunMeta>();

/** 开一次请求的根追踪上下文，返回 runId（后续所有 span 都带上它）。 */
export function beginRun(meta: {
  sessionId?: string;
  userText?: string;
  model?: string;
  worker?: string;
}): string {
  const runId = randomUUID();
  runMetas.set(runId, {
    runId,
    sessionId: meta.sessionId,
    userText: meta.userText,
    model: meta.model,
    worker: meta.worker,
    startMs: Date.now(),
  });
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
    meta: { sessionId: meta.sessionId, userText: meta.userText },
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
