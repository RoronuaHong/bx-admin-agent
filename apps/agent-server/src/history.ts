// 上下文装配（唯一实现，chat.ts 与测试共用）。
// 四层策略（对齐 Deep Agents 的 context management 与 Claude Code 的 compaction）：
//   1) 摘要水位线：`summary` + `summaryCovered` 之外的更早对话不重复压缩，增量扩展；
//   2) 窗口：只取最近 N 轮原文；
//   3) 无损裁剪：超长消息保头尾、长表格折叠（零模型调用）；
//   4) 压缩：仍超预算时，把更早的部分交给 LLM 生成/扩展摘要（产物持久化，跨轮复用）；
//      仍超则从最旧开始丢弃（硬保证）。
// 摘要进入 system 提示动态段，不占消息序列。
import { estimateTokens, estimateTokensOf, type Turn } from "./models.js";
import type { ToolHandle } from "./session.js";

const DEFAULT_MAX_TURNS = Number(process.env.HISTORY_MAX_TURNS || 8);
const KEEP_RECENT_TURNS = Number(process.env.HISTORY_KEEP_RECENT_TURNS || 3);
const AUTO_COMPACT = (process.env.HISTORY_AUTO_COMPACT || "on").toLowerCase() !== "off";
const LONG_MSG_CHARS = 3000;
const TABLE_MAX_LINES = 12;

/** 摘要生成的输入上限（字符）：更早的部分已被逐条裁剪，正常到不了这里。 */
const COMPACT_INPUT_CHARS = 24_000;

const SUMMARIZE_PROMPT =
  "把以下对话压缩成一份摘要，供后续对话作为背景使用。必须保留：\n" +
  "1) 用户的目标与约束；2) 已确认的结论与关键数字；3) 执行过的工具调用（工具名 + 关键参数）；4) 未完成事项。\n" +
  "不要评论、不要输出标题以外的客套话，直接输出摘要正文。\n\n对话内容：\n";

/** 把某轮的工具句柄渲染成可读行（只有「查过什么」，不含结果正文）。 */
export function renderHandles(handles: ToolHandle[] | undefined): string {
  if (!handles?.length) return "";
  const lines = handles.map(
    (handle) => `- ${handle.name}${handle.args ? ` ${handle.args}` : ""}${handle.summary ? ` → ${handle.summary}` : ""}`,
  );
  return `\n\n[本轮已执行的工具]\n${lines.join("\n")}`;
}

/** 单轮对话在上下文里的文本形态：正文 + 工具句柄。 */
function turnContent(turn: { text: string; handles?: ToolHandle[] }): string {
  return `${turn.text}${renderHandles(turn.handles)}`;
}

function prunedText(text: string): { text: string; changed: boolean } {
  let out = text;
  let changed = false;
  // 长 markdown 表格折叠：保留前 N 行表格（表头 + 首几行），避免整段表格占满预算。
  if (/\n\|.*\|/.test(out)) {
    const lines = out.split("\n");
    // 用行号集合判定，避免按内容判重时把内容相同的重复行整段保留下来。
    const tableRows = lines.reduce<number[]>((rows, line, index) => {
      if (line.trim().startsWith("|")) rows.push(index);
      return rows;
    }, []);
    if (tableRows.length > TABLE_MAX_LINES) {
      const all = new Set(tableRows);
      const keep = new Set(tableRows.slice(0, TABLE_MAX_LINES));
      out = `${lines.filter((_, index) => !all.has(index) || keep.has(index)).join("\n")}\n…（表格已折叠，共 ${tableRows.length} 行）`;
      changed = true;
    }
  }
  if (out.length > LONG_MSG_CHARS) {
    out = `${out.slice(0, 800)}\n…（中间省略 ${out.length - 1100} 字符）…\n${out.slice(-300)}`;
    changed = true;
  }
  return { text: out, changed };
}

interface AssembleUsage {
  /** 发给模型的历史条数（不含当前输入）。 */
  turns: number;
  /** 因预算被丢弃的较早消息条数（被摘要吸收的不计）。 */
  dropped: number;
  /** 是否触发了长内容裁剪。 */
  pruned: boolean;
  /** 发送时是否带历史摘要。 */
  summarized: boolean;
  /** 本轮是否新生成/扩展了摘要（发生 LLM 压缩调用）。 */
  compacted: boolean;
}

interface AssembleInput {
  /** 该对话的 `context`（thread 唯一真相）。 */
  history: Array<{ role: "user" | "assistant"; text: string; handles?: ToolHandle[] }>;
  userText: string;
  /** 历史 token 预算（窗口 − 输出预留 − 工具 schema − 本轮工具结果预算）× 安全系数。 */
  budgetTokens: number;
  maxTurns?: number;
  /** 已有摘要（跨轮复用）。 */
  summary?: string | null;
  /** 摘要水位线：已覆盖到 history 的第几条。 */
  summaryCovered?: number | null;
  /** LLM 压缩回调；不传则跳过摘要（只做窗口与裁剪）。 */
  compact?: (prompt: string) => Promise<string>;
}

interface AssembleResult {
  turns: Turn[];
  /** 最新摘要（可能沿用已有值；无摘要为空串）。 */
  summary: string;
  /** 最新水位线。 */
  summaryCovered: number;
  usage: AssembleUsage;
}

/** 组装一次模型请求的上下文（消息序列 + 摘要水位线）。 */
export async function assembleContext(input: AssembleInput): Promise<AssembleResult> {
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const history = Array.isArray(input.history) ? input.history : [];

  let summary = (input.summary || "").trim();
  let covered = Math.min(Math.max(0, input.summaryCovered || 0), history.length);
  let dropped = 0;
  let pruned = false;
  let compacted = false;

  const toTurn = (item: { role: "user" | "assistant"; text: string; handles?: ToolHandle[] }): Turn => {
    const result = prunedText(turnContent(item));
    pruned = pruned || result.changed;
    return { role: item.role, content: result.text };
  };

  // 未被摘要覆盖的部分里，取最近 N 轮原文；更早的先尝试吸收进摘要。
  let rest = history.slice(covered);
  let older = rest.slice(0, Math.max(0, rest.length - maxTurns * 2));
  let windowed = rest.slice(older.length);

  const buildTurns = (): Turn[] => {
    const turns = windowed.map(toTurn);
    turns.push({ role: "user", content: input.userText });
    // 部分 provider（如 anthropic）要求消息以 user 开头。
    while (turns.length > 1 && turns[0].role !== "user") {
      turns.shift();
      dropped += 1;
    }
    return turns;
  };
  const totalOf = (turns: Turn[]): number =>
    estimateTokensOf(turns.map((turn) => turn.content)) + estimateTokens(summary);

  let turns = buildTurns();
  let total = totalOf(turns);

  const absorbIntoSummary = async (absorb: Array<{ role: "user" | "assistant"; text: string; handles?: ToolHandle[] }>): Promise<boolean> => {
    if (!input.compact || !AUTO_COMPACT || !absorb.length) return false;
    const body = absorb
      .map((item) => `${item.role === "user" ? "用户" : "助手"}: ${turnContent(item)}`)
      .join("\n\n")
      .slice(0, COMPACT_INPUT_CHARS);
    const prompt = summary ? `已有摘要：\n${summary}\n\n新增对话：\n${body}` : body;
    const next = await input.compact(SUMMARIZE_PROMPT + prompt).catch(() => "");
    if (!next || !next.trim()) return false;
    summary = next.trim();
    covered += absorb.length;
    compacted = true;
    return true;
  };

  // 仍超预算：优先压缩（先吸收窗口外的更早部分，再牺牲窗口内较早的轮次），最后才硬丢弃。
  let guard = 0;
  while (total > input.budgetTokens && turns.length > 1 && guard < 32) {
    guard += 1;
    if (older.length && (await absorbIntoSummary(older))) {
      rest = history.slice(covered);
      windowed = rest.slice(-maxTurns * 2);
      older = rest.slice(0, Math.max(0, rest.length - windowed.length));
      turns = buildTurns();
      total = totalOf(turns);
      continue;
    }
    const keepCount = KEEP_RECENT_TURNS * 2;
    const sacrificable = Math.max(0, windowed.length - keepCount);
    if (sacrificable > 0 && (await absorbIntoSummary(windowed.slice(0, sacrificable)))) {
      rest = history.slice(covered);
      windowed = rest.slice(-Math.max(keepCount, maxTurns * 2));
      older = rest.slice(0, Math.max(0, rest.length - windowed.length));
      turns = buildTurns();
      total = totalOf(turns);
      continue;
    }
    const removed = turns.shift() as Turn;
    total -= estimateTokens(removed.content);
    dropped += 1;
  }

  return {
    turns,
    summary,
    summaryCovered: covered,
    usage: {
      turns: Math.max(0, turns.length - 1),
      dropped,
      pruned,
      summarized: Boolean(summary),
      compacted,
    },
  };
}
