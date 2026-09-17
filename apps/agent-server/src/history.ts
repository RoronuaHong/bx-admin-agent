// 上下文构建：把「某个对话框的完整历史」压缩成一次模型请求能吃的上下文。
// 三层策略（对齐主流 Agent：分层压缩 + LLM 摘要）：
//   1) 窗口：只取最近 N 轮；
//   2) 无损裁剪：超长消息保头尾、长表格折叠（零模型调用）；
//   3) 摘要：仍超预算时对更早的部分做摘要，摘要进系统提示，近期轮次原文保留。
import type { Turn } from "./models.js";

export interface ContextUsage {
  /** 参与本次请求的对话轮数（不含当前输入） */
  turns: number;
  /** 上下文总字符数 */
  chars: number;
  /** 因预算被丢弃的较早消息条数 */
  dropped: number;
  /** 是否使用了历史摘要 */
  summarized: boolean;
  /** 是否触发了长内容裁剪 */
  pruned: boolean;
}

export interface BuildResult {
  turns: Turn[];
  systemExtra: string;
  usage: ContextUsage;
}

export interface BuildInput {
  history: Array<{ role: "user" | "assistant"; text: string }>;
  userText: string;
  /** 该会话上次生成的摘要（可选） */
  summary?: string;
  maxTurns?: number;
  budget?: number;
  /** 摘要回调；不传则跳过 LLM 摘要（只做窗口与裁剪） */
  compact?: (olderTurns: Turn[]) => Promise<string>;
}

const DEFAULT_MAX_TURNS = Number(process.env.HISTORY_MAX_TURNS || 8);
const DEFAULT_BUDGET = Number(process.env.HISTORY_CHAR_BUDGET || 24_000);
const KEEP_RECENT_TURNS = Number(process.env.HISTORY_KEEP_RECENT_TURNS || 3);
const AUTO_COMPACT = (process.env.HISTORY_AUTO_COMPACT || "on").toLowerCase() !== "off";
const LONG_MSG_CHARS = 3000;
const TABLE_MAX_LINES = 12;

function prunedText(text: string): { text: string; changed: boolean } {
  let out = text;
  let changed = false;
  // 长 markdown 表格折叠：保留表头与首行，避免整段表格占满预算。
  if (/\n\|.*\|/.test(out)) {
    const lines = out.split("\n");
    const tableLines = lines.filter((line) => line.trim().startsWith("|"));
    if (tableLines.length > TABLE_MAX_LINES) {
      const head = tableLines.slice(0, TABLE_MAX_LINES);
      const tableWrapped = lines
        .map((line) => (!head.includes(line) && line.trim().startsWith("|") ? null : line))
        .filter((line): line is string => line !== null);
      out = `${tableWrapped.join("\n")}\n…（表格已折叠，共 ${tableLines.length} 行）`;
      changed = true;
    }
  }
  if (out.length > LONG_MSG_CHARS) {
    out = `${out.slice(0, 800)}\n…（中间省略 ${out.length - 1100} 字符）…\n${out.slice(-300)}`;
    changed = true;
  }
  return { text: out, changed };
}

function charsOf(turns: Turn[]): number {
  return turns.reduce((acc, turn) => acc + turn.content.length, 0);
}

function toTurns(history: BuildInput["history"]): { turns: Turn[]; pruned: boolean } {
  let pruned = false;
  const turns: Turn[] = [];
  for (const item of history) {
    if (!item.text) continue;
    const result = prunedText(item.text);
    pruned = pruned || result.changed;
    turns.push({ role: item.role, content: result.text });
  }
  return { turns, pruned };
}

export async function buildContext(input: BuildInput): Promise<BuildResult> {
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const budget = input.budget ?? DEFAULT_BUDGET;
  const windowed = input.history.slice(-maxTurns * 2);
  const { turns: prunedTurns, pruned } = toTurns(windowed);

  const usage: ContextUsage = {
    turns: prunedTurns.length,
    chars: 0,
    dropped: input.history.length - windowed.length,
    summarized: false,
    pruned,
  };

  const all: Turn[] = [...prunedTurns, { role: "user", content: input.userText }];
  const hasSummary = Boolean(input.summary);
  let systemExtra = input.summary ? `以下是该会话更早部分的摘要：\n${input.summary}` : "";

  // 预算内：直接用（超出则先摘要、仍超再逐条丢弃最早的）。
  let working = all;
  let total = charsOf(working) + systemExtra.length;
  if (hasSummary) usage.summarized = true;

  if (total > budget && input.compact && AUTO_COMPACT) {
    // 摘要：保留最近若干轮原文，更早的部分交给摘要模型。
    const keepCount = KEEP_RECENT_TURNS * 2;
    const older = working.slice(0, Math.max(0, working.length - keepCount));
    if (older.length) {
      const summaryText = await input.compact(older).catch(() => "");
      if (summaryText) {
        working = working.slice(older.length);
        systemExtra = systemExtra
          ? `${systemExtra}\n\n${summaryText}`
          : `以下是该会话更早部分的摘要：\n${summaryText}`;
        usage.summarized = true;
        total = charsOf(working) + systemExtra.length;
      }
    }
  }

  while (total > budget && working.length > 1) {
    const removed = working.shift() as Turn;
    total -= removed.content.length;
    usage.dropped += 1;
  }

  usage.turns = Math.max(0, working.length - 1);
  usage.chars = total;
  return { turns: working, systemExtra, usage };
}
