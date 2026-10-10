import type { ArtifactSpec, ChartSpec, ChatEvent, LocalizedToken, TodoItem } from "@bx/shared";

/** 流事件要改的气泡字段。页面上的 Bubble 多出来的展示字段不影响这里。 */
export interface StreamReply {
  id: number;
  text: string;
  streaming?: boolean;
  error?: string;
  thinking?: string;
  steps?: Array<{
    id: string;
    name: string;
    server?: string;
    args?: string;
    status: "running" | "ok" | "error" | "cancelled" | "interrupted";
    result?: string;
  }>;
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
  openReasoning(id: number): void;
  closeReasoning(id: number): void;
  rememberModel(id: string): void;
}

function interruptRunning(reply: StreamReply): void {
  for (const step of reply.steps || []) if (step.status === "running") step.status = "interrupted";
  for (const sa of reply.subagents || []) if (sa.status === "running") sa.status = "interrupted";
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
    reply.text = event.text;
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
      step.status = event.ok ? "ok" : "error";
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
  } else if (event.type === "done") {
    run.sawTerminal = true;
    reply.text = dedupeRepeats(reply.text);
    host.thinkPhaseEnd(reply);
    reply.streaming = false;
    host.closeReasoning(reply.id);
    if (!reply.error) host.rememberModel(run.servedModel || run.chosenModel);
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
    for (let L = Math.min(n >> 1, 600); L >= MIN && !replaced; L--) {
      let i = 0;
      while (i + 2 * L <= n) {
        const block = s.slice(i, i + L);
        if (s.slice(i + L, i + 2 * L) === block) {
          let count = 2;
          while (i + count * L <= n && s.slice(i + (count - 1) * L, i + count * L) === block) count++;
          if (count >= 2) {
            s = s.slice(0, i) + block + s.slice(i + count * L);
            replaced = true;
            break;
          }
        }
        i++;
      }
    }
    if (!replaced) break;
  }
  return s;
}
