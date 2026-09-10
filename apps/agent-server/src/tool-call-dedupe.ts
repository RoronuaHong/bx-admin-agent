/**
 * 同轮并行工具调用去重 + tool_calls/result 配对护栏（纯协议，无业务语义）。
 *
 * 根因（通用）：
 * 1) 同轮：tool_choice=required / 弱模型忽略 parallel_tool_calls=false 时，会在一次
 *    assistant 消息里复制 N 份相同 (name, args) 的 tool_calls，烧 completion token。
 * 2) 跨轮：成功结果已在历史中，模型仍用相同入参再调（空 mock / 诱导性 prompt）。
 *
 * 正常契约：默认禁止并行 → 同轮至多 1 个 tool_call；完全重复本就不该出现。
 * 流式第 2 槽立刻掐断；响应侧只保留合法槽位。折叠仅作兜底，不是「允许多份再合并」。
 */
import type { AgentStep, ToolCall } from "./models.js";
import { SUBMIT_UNDERSTOOD_INTENT } from "./understood-intent.js";

const CALL_API = "call_api";

/** 稳定序列化：键排序，避免同参不同键序被当成两次调用。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** 任意工具的同轮去重签名。submit 只按工具名（整轮至多 1 次）。 */
export function toolCallSignature(c: ToolCall): string {
  if (c.name === SUBMIT_UNDERSTOOD_INTENT) return SUBMIT_UNDERSTOOD_INTENT;
  return `${c.name}|${stableStringify(c.input || {})}`;
}

/** call_api 跨轮签名：operation|path|params（与历史兼容） */
export function callApiKey(c: ToolCall): string | null {
  if (c.name !== CALL_API) return null;
  const op = c.input.operation ? String(c.input.operation) : "";
  const path = c.input.path ? String(c.input.path) : "";
  const params = c.input.params ? stableStringify(c.input.params) : "";
  return `${op}|${path}|${params}`;
}

export interface DedupeParallelToolCallsResult {
  kept: ToolCall[];
  /** 按签名折叠掉的重复次数（含 submit / call_api / 其它工具） */
  dropped: number;
  droppedSubmit: number;
  droppedCallApi: number;
}

/**
 * 同轮通用去重：相同 (工具名, 规范化入参) 只保留第一次出现。
 * submit_understood_intent 不论入参差异整轮只留 1 条（语义上「提交理解」不可并行多份）。
 */
export function dedupeParallelToolCalls(calls: ToolCall[]): DedupeParallelToolCallsResult {
  const seen = new Set<string>();
  const kept: ToolCall[] = [];
  let dropped = 0;
  let droppedSubmit = 0;
  let droppedCallApi = 0;
  for (const c of calls) {
    const sig = toolCallSignature(c);
    if (seen.has(sig)) {
      dropped += 1;
      if (c.name === SUBMIT_UNDERSTOOD_INTENT) droppedSubmit += 1;
      else if (c.name === CALL_API) droppedCallApi += 1;
      continue;
    }
    seen.add(sig);
    kept.push(c);
  }
  return { kept, dropped, droppedSubmit, droppedCallApi };
}

/** 是否允许同轮并行 tool_calls（默认否）。 */
export function parallelToolCallsAllowed(): boolean {
  const v = process.env.PARALLEL_TOOL_CALLS;
  return v === "1" || v === "true";
}

/**
 * 流式早停判定（纯协议）：
 * - 默认禁止并行：第 2 个槽位一出现即停（不等满槽、不等同名凑齐）
 * - 允许并行：仅超 maxSlots 才停
 * - 无论是否并行：submit_understood_intent ≥2 即停（该工具语义上不可并行）
 */
export function shouldAbortToolCallStream(opts: {
  slotCount: number;
  toolNames: Array<string | undefined>;
  parallelAllowed: boolean;
  maxSlots: number;
}): boolean {
  if (!opts.parallelAllowed && opts.slotCount >= 2) return true;
  if (opts.parallelAllowed && opts.slotCount >= opts.maxSlots) return true;
  let submitCount = 0;
  for (const n of opts.toolNames) {
    if (n === SUBMIT_UNDERSTOOD_INTENT) submitCount += 1;
  }
  return submitCount >= 2;
}

/**
 * 按契约裁剪同轮 tool_calls：禁止并行时只留第一条；允许并行时去重后截断到 maxSlots。
 * 完全重复在正常路径不应到达这里；此函数保证出口契约成立。
 */
export function enforceToolCallContract(
  calls: ToolCall[],
  opts: { parallelAllowed: boolean; maxSlots: number },
): ToolCall[] {
  if (!calls.length) return calls;
  if (!opts.parallelAllowed) return [calls[0]];
  const { kept } = dedupeParallelToolCalls(calls);
  return kept.slice(0, Math.max(1, opts.maxSlots));
}

export function formatParallelDedupeObserve(
  droppedSubmit: number,
  droppedCallApi: number,
  droppedOther = 0,
): string {
  const parts: string[] = [];
  if (droppedSubmit > 0) {
    parts.push(
      `同轮并行的 ${droppedSubmit} 个重复 submit_understood_intent 已合并，只保留第一条；请基于其结果继续，不要重复提交。`,
    );
  }
  if (droppedCallApi > 0) {
    parts.push(
      `同轮并行的 ${droppedCallApi} 个参数完全相同的 call_api 已合并，只保留第一条；` +
        `若需更多页，请基于返回分页信息递增参数后再调。`,
    );
  }
  if (droppedOther > 0) {
    parts.push(`同轮另有 ${droppedOther} 个完全相同的工具调用已合并。`);
  }
  return parts.length ? `[workflow/observe] ${parts.join(" ")}` : "";
}

/**
 * 收集本轮 steps 里已成功执行过的 call_api 签名，以及对应结果内容（供跨轮回放）。
 */
export function collectSuccessfulCallApiResults(steps: AgentStep[]): Map<string, string> {
  const idToCall = new Map<string, ToolCall>();
  const ok = new Map<string, string>();
  for (const s of steps) {
    if (s.kind === "toolCalls") {
      for (const c of s.calls) {
        if (c.name === CALL_API) idToCall.set(c.id, c);
      }
    }
  }
  for (const s of steps) {
    if (s.kind !== "toolResult") continue;
    const c = idToCall.get(s.toolCallId);
    if (!c) continue;
    const key = callApiKey(c);
    if (!key) continue;
    const body = s.content || "";
    if (!isSuccessfulToolBody(body)) continue;
    ok.set(key, body);
  }
  return ok;
}

export function collectSuccessfulCallApiKeys(steps: AgentStep[]): Set<string> {
  return new Set(collectSuccessfulCallApiResults(steps).keys());
}

function isSuccessfulToolBody(body: string): boolean {
  if (
    /^(错误|ERROR|CLARIFICATION_REQUIRED|MODULE_RETRY)/i.test(body) ||
    /\[workflow\/observe\].*已跳过重复/.test(body) ||
    /\[workflow\/response-mode\]/.test(body) ||
    body.includes('"ok": false')
  ) {
    return false;
  }
  const codeM = body.match(/"code"\s*:\s*(-?\d+)/);
  if (codeM && Number(codeM[1]) !== 0) return false;
  return true;
}

/** 跨轮跳过时回放上次成功结果，避免模型只看到 observe 空壳又去重试。 */
export function formatDuplicateCallApiReplay(operation: string, priorContent: string): string {
  const head =
    `[workflow/observe] 相同 call_api${operation ? `（${operation}）` : ""}与参数已成功执行过，已跳过重复调用。` +
    `以下回放上次结果；请直接总结，或更换分页/筛选参数后再调。\n\n`;
  return head + priorContent;
}

export function formatDuplicateCallApiSkip(operation: string): string {
  return (
    `[workflow/observe] 相同 call_api${operation ? `（${operation}）` : ""}与参数已成功执行过，已跳过重复调用。` +
    `请基于已有结果总结回复；若需更多数据请更换分页/筛选参数后再调。`
  );
}

/** 把 steps 里最近一条 toolCalls 的 calls 改写为指定列表（同轮短路时只保留实际执行的调用）。 */
export function rewriteLastToolCalls(steps: AgentStep[], calls: ToolCall[]): void {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.kind === "toolCalls") {
      steps[i] = { kind: "toolCalls", calls };
      return;
    }
  }
}

/**
 * 补齐缺失的 toolResult，保证 OpenAI 消息配对。
 * 补丁必须紧跟对应 toolCalls 之后的连续 tool 结果块插入。
 */
export function padMissingToolResults(
  steps: AgentStep[],
  note = "[workflow/observe] 同轮未执行的并行工具调用已跳过（保持消息配对）。",
): number {
  const have = new Set<string>();
  for (const s of steps) {
    if (s.kind === "toolResult") have.add(s.toolCallId);
  }
  let added = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind !== "toolCalls") continue;
    const missing = s.calls.filter((c) => !have.has(c.id));
    if (!missing.length) continue;
    let insertAt = i + 1;
    while (insertAt < steps.length && steps[insertAt].kind === "toolResult") insertAt += 1;
    const pads: AgentStep[] = missing.map((c) => {
      have.add(c.id);
      return { kind: "toolResult" as const, toolCallId: c.id, content: note };
    });
    steps.splice(insertAt, 0, ...pads);
    added += pads.length;
    i = insertAt + pads.length - 1;
  }
  return added;
}

/** 把夹在 tool_calls↔tool 结果之间的 system 步挪到该轮全部 tool 结果之后。 */
export function deferSystemStepsPastToolResults(steps: AgentStep[]): number {
  let moved = 0;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].kind !== "toolCalls") continue;
    let j = i + 1;
    const deferred: AgentStep[] = [];
    while (j < steps.length) {
      const cur = steps[j];
      if (cur.kind === "toolResult") {
        j += 1;
        continue;
      }
      if (cur.kind === "system") {
        deferred.push(cur);
        steps.splice(j, 1);
        moved += 1;
        continue;
      }
      break;
    }
    if (deferred.length) {
      steps.splice(j, 0, ...deferred);
      i = j + deferred.length - 1;
    }
  }
  return moved;
}
