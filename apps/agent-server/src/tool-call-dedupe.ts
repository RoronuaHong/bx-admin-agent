/**
 * 同轮并行工具调用去重 + tool_calls/result 配对护栏（纯协议，无业务语义）。
 *
 * 弱模型（如 dsflash）常在未见结果时并行吐出大量占位 submit_understood_intent /
 * 参数完全相同的 call_api。若只跳过执行仍向 UI/历史回喂 N 条 observe，会刷屏且污染上下文。
 *
 * 正确做法：在写入 steps / 执行 / 推 UI 之前折叠——只保留第一条，其余从本轮 toolCalls 列表移除。
 * 同轮 route 短路或中途 return 时，必须改写/补齐 toolResult，否则上游报 400001
 * insufficient tool messages following tool_calls。
 */
import type { AgentStep, ToolCall } from "./models.js";
import { SUBMIT_UNDERSTOOD_INTENT } from "./understood-intent.js";

const CALL_API = "call_api";

/** call_api 去重/跨轮跳过用的签名：operation|path|params */
export function callApiKey(c: ToolCall): string | null {
  if (c.name !== CALL_API) return null;
  const op = c.input.operation ? String(c.input.operation) : "";
  const path = c.input.path ? String(c.input.path) : "";
  const params = c.input.params ? JSON.stringify(c.input.params) : "";
  return `${op}|${path}|${params}`;
}

export interface DedupeParallelToolCallsResult {
  /** 折叠后保留的调用（顺序不变） */
  kept: ToolCall[];
  /** 丢弃的重复 submit_understood_intent 数量 */
  droppedSubmit: number;
  /** 丢弃的参数完全相同的 call_api 数量 */
  droppedCallApi: number;
}

export function dedupeParallelToolCalls(calls: ToolCall[]): DedupeParallelToolCallsResult {
  let seenSubmit = false;
  const seenCallKeys = new Set<string>();
  const kept: ToolCall[] = [];
  let droppedSubmit = 0;
  let droppedCallApi = 0;
  for (const c of calls) {
    if (c.name === SUBMIT_UNDERSTOOD_INTENT) {
      if (seenSubmit) {
        droppedSubmit += 1;
        continue;
      }
      seenSubmit = true;
      kept.push(c);
      continue;
    }
    const key = callApiKey(c);
    if (key) {
      if (seenCallKeys.has(key)) {
        droppedCallApi += 1;
        continue;
      }
      seenCallKeys.add(key);
    }
    kept.push(c);
  }
  return { kept, droppedSubmit, droppedCallApi };
}

/**
 * 收集本轮 steps 里已成功执行过的 call_api 签名（跨轮去重用）。
 * 失败 / MODULE_RETRY / 澄清 / 跳过说明不计入，允许模型换参或排错后重试。
 */
export function collectSuccessfulCallApiKeys(steps: AgentStep[]): Set<string> {
  const idToCall = new Map<string, ToolCall>();
  const ok = new Set<string>();
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
    if (
      /^(错误|ERROR|CLARIFICATION_REQUIRED|MODULE_RETRY)/i.test(body) ||
      /\[workflow\/observe\].*已跳过重复/.test(body) ||
      /\[workflow\/response-mode\]/.test(body) ||
      body.includes('"ok": false')
    ) {
      continue;
    }
    // 业务失败常见形态：code != 0；宽松：含 code 且非 0 则不当成功
    const codeM = body.match(/"code"\s*:\s*(-?\d+)/);
    if (codeM && Number(codeM[1]) !== 0) continue;
    ok.add(key);
  }
  return ok;
}

export function formatDuplicateCallApiSkip(operation: string): string {
  return (
    `[workflow/observe] 相同 call_api${operation ? `（${operation}）` : ""}与参数已成功执行过，已跳过重复调用。` +
    `请基于已有结果总结回复；若需更多数据请更换分页/筛选参数后再调。`
  );
}

/** 折叠说明（单条 system 回喂，避免 N 条 observe 刷屏）。 */
export function formatParallelDedupeObserve(droppedSubmit: number, droppedCallApi: number): string {
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
  return parts.length ? `[workflow/observe] ${parts.join(" ")}` : "";
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
 * 补齐缺失的 toolResult，保证 OpenAI 消息配对：每个 tool_call id 都有一条 tool 消息。
 * 用于同轮短路 / 中途 return 后仍把完整 rounds 写进历史的场景，避免上游 400001。
 *
 * 重要：补丁必须紧跟对应 toolCalls 之后的连续 tool 结果块插入，不能 append 到 steps 末尾——
 * 若末尾已有 role=user（system 步）再补 tool，上游会报 insufficient tool messages。
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
    // 插入点：本轮 toolCalls 后已有的连续 toolResult 之后（仍在任何 system/user 之前）
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

/**
 * 把夹在「assistant.tool_calls ↔ 其 tool 结果」之间的 system 步挪到该轮全部 tool 结果之后。
 * models.ts 会把 system 编成 role=user；夹在中间会破坏 OpenAI 配对（400001）。
 */
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
