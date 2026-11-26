import type { ArtifactSpec, ChartSpec, ChatEvent, LocalizedToken, SupportLabels, TodoItem } from "@bx/shared";
// 步骤类型以 chat-types.ts 为单一来源（与 ChatPage / ChatBubble 共用），不在此重复内联。
import type { ToolStep } from "./chat-types";

/** 流事件要改的气泡字段。页面上的 Bubble 多出来的展示字段不影响这里。 */
export interface StreamReply {
  id: number;
  text: string;
  streaming?: boolean;
  error?: string;
  thinking?: string;
  steps?: ToolStep[];
  pending?: {
    id: string;
    ticket: string;
    name: string;
    server?: string;
    args?: string;
    level?: "read" | "write" | "destructive";
    reason?: string;
    argSummary?: Array<{ key: string; value: string }>;
    canGrantRead?: boolean;
    expiresInMs?: number;
  } | null;
  clarification?: {
    id: string;
    ticket: string;
    question: string;
    options: Array<{ label: string; description?: string }>;
    missingField?: string;
    whyItMatters?: string;
    expiresInMs?: number;
  } | null;
  /** 客服助手封闭分类。只在这一路出现，不改回复正文。 */
  supportLabels?: SupportLabels;
  usage?: {
    tokens: number;
    budget: number;
    window: number;
    turns: number;
    dropped: number;
    summarized?: boolean;
    toolResultsCleared: number;
    toolResultsOffloaded?: number;
  };
  todos?: TodoItem[];
  charts?: ChartSpec[];
  artifacts?: ArtifactSpec[];
  subagents?: Array<{
    id: string;
    parentId: string;
    description: string;
    /** 子代理类型 id（task 的 subagent_type，缺省 general-purpose）；仅展示。 */
    subagentType?: string;
    /** UI 短标签（task 的 label）；仅展示，不影响执行。 */
    label?: string;
    status: "running" | "done" | "cancelled" | "error" | "interrupted";
    text: string;
  }>;
}

export interface StreamRun<T extends StreamReply = StreamReply> {
  convId: string;
  reply: T;
  state: { error: string };
  chosenModel: string;
  servedModel?: string;
  sawTerminal: boolean;
  /** 本轮收到过 cancelled（抢占 / 用户停止）：气泡末尾必须保留「已停止」标记，且不算成功轮次。 */
  cancelled?: boolean;
  lastSeq: number;
  serverErrorCode?: string;
}

/** 页面仍拥有滚动、计时和文案。这里只决定事件怎么落到气泡上。 */
export interface ChatStreamHost<T extends StreamReply> {
  thinkPhaseEnd(reply: T): void;
  thinkPhaseStart(id: number): void;
  queueScrollIfCurrent(convId: string): void;
  stickThinkingToBottom(): void;
  scheduleConfirmExpiry(reply: T, expiresInMs?: number): void;
  localizeError(token: LocalizedToken | undefined, fallback: string): string;
  /** 任务被抢占 / 中止时追加到气泡末尾的本地化标记（与主动 Stop 文案一致）。 */
  localizeStopMarker(): string;
  openReasoning(id: number): void;
  closeReasoning(id: number): void;
  rememberModel(id: string): void;
}

function interruptRunning(reply: StreamReply): void {
  for (const step of reply.steps || []) if (step.status === "running") step.status = "interrupted";
  for (const sa of reply.subagents || []) if (sa.status === "running") sa.status = "interrupted";
}

/**
 * 给被取消轮次的气泡末尾补「已停止生成」。服务端在 abort 后仍会 yield 一条 `text` 全文快照
 * （chat.ts 的 abortedRun / 正常收尾都会发），它是**替换**语义，会把 cancelled 时加的 marker 抹掉；
 * 故 text / done 分支都要重加。已存在则不重复（marker 可能夹在 wrapup 文本中间）。
 */
function appendStopMarker(reply: StreamReply, marker: string): void {
  if (!marker || reply.text.includes(marker)) return;
  reply.text = reply.text ? `${reply.text}\n\n${marker}` : marker;
}

/**
 * 把一条服务端事件应用到气泡上：首连与续传共用同一条路径。
 * `seq` 只用于记账（游标），渲染分支完全不关心它；`ping` 是保活事件，忽略即可。
 */
export function applyStreamEvent<T extends StreamReply>(
  run: StreamRun<T>,
  event: ChatEvent,
  host: ChatStreamHost<T>,
): void {
  if (typeof event.seq === "number" && event.seq > run.lastSeq) run.lastSeq = event.seq;
  if (event.type === "model") run.servedModel = event.id;
  const { convId, reply, state } = run;
  if (event.type === "text_delta") {
    reply.text += event.text;
    host.thinkPhaseEnd(reply);
    host.queueScrollIfCurrent(convId);
  } else if (event.type === "text") {
    // 全文快照是替换语义：被取消的轮次要在末尾补回 marker，否则 wrapup 的 text 会把「已停止」抹掉（R33 与 R09 的交汇）。
    reply.text = event.text;
    if (run.cancelled) appendStopMarker(reply, host.localizeStopMarker());
    host.thinkPhaseEnd(reply);
  } else if (event.type === "thinking_delta") {
    reply.thinking = (reply.thinking || "") + event.text;
    host.thinkPhaseStart(reply.id);
    host.openReasoning(reply.id);
    host.queueScrollIfCurrent(convId);
    host.stickThinkingToBottom();
  } else if (event.type === "tool_call") {
    reply.steps = reply.steps || [];
    reply.steps.push({
      id: event.id,
      name: event.name,
      server: event.server,
      args: event.args,
      status: "running",
    });
    host.openReasoning(reply.id);
    host.queueScrollIfCurrent(convId);
  } else if (event.type === "tool_result") {
    const step = (reply.steps || []).find((item) => item.id === event.id);
    if (step) {
      // 未执行（闸门拒绝/跳过）≠ 真执行失败：前者黄色「未执行」+ 原因，后者才是红色「失败」。
      // executed 为 undefined（老版本未发该字段）时沿用红色，不改变既有行为。
      step.status = event.ok ? "ok" : event.executed === false ? "refused" : "error";
      step.result = event.text;
    }
    reply.pending = null;
    host.queueScrollIfCurrent(convId);
  } else if (event.type === "confirmation_required") {
    reply.pending = {
      id: event.id,
      ticket: event.ticket,
      name: event.name,
      server: event.server,
      args: event.args,
      level: event.level,
      reason: event.reason,
      argSummary: event.argSummary,
      canGrantRead: event.canGrantRead,
      expiresInMs: event.expiresInMs,
    };
    host.scheduleConfirmExpiry(reply, event.expiresInMs);
    host.queueScrollIfCurrent(convId);
  } else if (event.type === "confirmation_response") {
    reply.pending = null;
  } else if (event.type === "clarification_required") {
    reply.clarification = {
      id: event.id,
      ticket: event.ticket,
      question: event.question,
      options: event.options,
      ...(event.missingField ? { missingField: event.missingField } : {}),
      ...(event.whyItMatters ? { whyItMatters: event.whyItMatters } : {}),
      expiresInMs: event.expiresInMs,
    };
    host.queueScrollIfCurrent(convId);
  } else if (event.type === "clarification_response") {
    reply.clarification = null;
  } else if (event.type === "error") {
    run.sawTerminal = true;
    run.serverErrorCode = String(event.error?.code || event.code || "");
    const message = host.localizeError(event.error, event.message || "GENERIC_UNKNOWN_ERROR");
    reply.error = message;
    state.error = message;
    interruptRunning(reply);
    reply.pending = null;
    reply.clarification = null;
  } else if (event.type === "todos") {
    reply.todos = event.todos;
    host.openReasoning(reply.id);
    host.queueScrollIfCurrent(convId);
  } else if (event.type === "chart") {
    reply.charts = reply.charts || [];
    reply.charts.push({
      title: event.title,
      chartType: event.chartType,
      data: event.data,
      encode: event.encode,
      options: event.options,
    });
    host.queueScrollIfCurrent(convId);
  } else if (event.type === "artifact") {
    reply.artifacts = reply.artifacts || [];
    const existing = reply.artifacts.find((item) => item.path === event.path);
    if (existing) {
      existing.name = event.name;
      existing.bytes = event.bytes;
      existing.mime = event.mime;
    } else {
      reply.artifacts.push({ path: event.path, name: event.name, bytes: event.bytes, mime: event.mime });
    }
    host.queueScrollIfCurrent(convId);
  } else if (event.type === "subagent_start") {
    reply.subagents = reply.subagents || [];
    reply.subagents.push({
      id: event.id,
      parentId: event.parentId,
      description: event.description,
      ...(event.subagentType ? { subagentType: event.subagentType } : {}),
      ...(event.label ? { label: event.label } : {}),
      status: "running",
      text: "",
    });
    host.openReasoning(reply.id);
    host.queueScrollIfCurrent(convId);
  } else if (event.type === "subagent_delta") {
    const sa = (reply.subagents || []).find((item) => item.id === event.id);
    if (sa) sa.text += event.text;
    host.queueScrollIfCurrent(convId);
  } else if (event.type === "subagent_end") {
    const sa = (reply.subagents || []).find((item) => item.id === event.id);
    if (sa) {
      sa.status = event.status;
      sa.text = event.text;
    }
    host.queueScrollIfCurrent(convId);
  } else if (event.type === "support_labels") {
    reply.supportLabels = event.labels;
  } else if (event.type === "usage") {
    reply.usage = {
      tokens: event.tokens,
      budget: event.budget,
      window: event.window,
      turns: event.turns,
      dropped: event.dropped,
      summarized: event.summarized,
      toolResultsCleared: event.toolResultsCleared,
      toolResultsOffloaded: event.toolResultsOffloaded,
    };
  } else if (event.type === "cancelled") {
    // 任务被抢占 / 用户中止（服务端 cancelTask 发 cancelled 事件）：把对应气泡标记「已停止」。
    // 增量分支（text_delta / subagent_delta 等）不检查 sawTerminal，故旧 run 在 abort 后由模型生成的
    // wrapup 文本（abortedRun 说明「哪些没查完」）仍会正常渲染，不会被判终态而吞掉（§14.9 R33）。
    run.sawTerminal = true;
    run.cancelled = true;
    reply.streaming = false;
    interruptRunning(reply);
    // 清掉仍挂着的确认/澄清卡，否则会残留（§14.3 R35）。
    reply.pending = null;
    reply.clarification = null;
    appendStopMarker(reply, host.localizeStopMarker());
    host.thinkPhaseEnd(reply);
    host.closeReasoning(reply.id);
  } else if (event.type === "done") {
    run.sawTerminal = true;
    reply.text = dedupeRepeats(reply.text);
    // 被取消的轮次即使收到 done（wrapup 收尾），也要保住 marker 且不算成功模型。
    if (run.cancelled) appendStopMarker(reply, host.localizeStopMarker());
    host.thinkPhaseEnd(reply);
    reply.streaming = false;
    host.closeReasoning(reply.id);
    if (!reply.error && !run.cancelled) host.rememberModel(run.servedModel || run.chosenModel);
    interruptRunning(reply);
  }
}

/**
 * 收束或载入时折叠模型回声：整段被原样重复，或段中某句连续重复。
 * 只折叠连续、原样、完全一致的块（最短 12 字）。不在流式进行中反复跑。
 */
export function dedupeRepeats(text: string): string {
  const MIN = 12;
  let s = text;
  for (let guard = 0; guard < 6; guard++) {
    const n = s.length;
    let replaced = false;
    // 前缀滚动哈希：把旧版每次 `slice` 比较（每次都分配两个新字符串）换成 O(1) 的哈希比较。
    // 循环顺序与语义完全不变（L 从大到小、i 从小到大），哈希相等时再逐字校验，杜绝碰撞误判。
    const BASE = 911382323;
    const hash = new Uint32Array(n + 1);
    const pow = new Uint32Array(n + 1);
    pow[0] = 1;
    for (let k = 0; k < n; k++) {
      hash[k + 1] = (Math.imul(hash[k], BASE) + s.charCodeAt(k)) >>> 0;
      pow[k + 1] = Math.imul(pow[k], BASE) >>> 0;
    }
    const eq = (a: number, b: number, len: number): boolean => {
      if (a + len > n || b + len > n) return false;
      if ((hash[a + len] - Math.imul(hash[a], pow[len])) >>> 0 !== (hash[b + len] - Math.imul(hash[b], pow[len])) >>> 0) return false;
      // 哈希相等才做的兜底校验。用原生 slice 比较（V8 走 memcmp），比逐字 charCodeAt 循环快一个量级。
      return s.slice(a, a + len) === s.slice(b, b + len);
    };
    for (let L = Math.min(n >> 1, 600); L >= MIN && !replaced; L--) {
      let i = 0;
      while (i + 2 * L <= n) {
        if (eq(i + L, i, L)) {
          let count = 2;
          while (i + count * L <= n && eq(i + (count - 1) * L, i, L)) count++;
          s = s.slice(0, i) + s.slice(i, i + L) + s.slice(i + count * L);
          replaced = true;
          break;
        }
        i++;
      }
    }
    if (!replaced) break;
  }
  return s;
}
