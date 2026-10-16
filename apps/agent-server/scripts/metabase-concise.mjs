// concise/detailed 双模式的投影逻辑（第 6 批，对标 Anthropic《Writing effective tools for agents》
// 「默认只回高信号字段；提供 concise/detailed 双模式；截断时给出 next_cursor + 如何继续」）。
//
// 事故形态（2026-10-14 复盘 §3 L3/L4）：单一元数据工具被调 24 次，每次全量回灌——
// 上下文被元数据撑爆，模型被迫把已取到的结果卸载成句柄后重新探查，27 轮预算大半耗在重复探查上。
// 元数据工具的用途是「认路」（有哪些表 / 字段 / 取值），不是「一次读完全部细节」：
// 默认给高信号投影 + 硬上限，要细节时显式要（detail="detailed"）。
//
// 抽成独立模块（与 sql-readonly-common.mjs 同模式）：metabase-mcp.mjs import 即连 stdio，
// 测试无法直接 import 它；纯函数放这里，两侧物理共用同一份实现。
//
// 零业务词：keys 由调用方（工具侧）传入，本模块只做「投影 + 截断 + 提示」，不认识任何字段名。

/**
 * 归一化 detail 入参：只有显式 "detailed" 给全量；
 * 缺省 / 任何其它值一律 concise（fail-closed 到省 token 侧：写错参数不该换来一份全量回灌）。
 */
export function detailMode(detail) {
  return String(detail ?? "").trim().toLowerCase() === "detailed" ? "detailed" : "concise";
}

/**
 * 按模式投影 + 截断：
 * - detailed：原样返回、不截断（调用方显式要全量时就给全量，含它自己的内部上限）；
 * - concise：只保留 keys 里的高信号字段（keys 缺省时保留原形状），按 cap 截断并给 note。
 *
 * 截断时必须给 note（含 hint）——这是 next_cursor 的语义：**不静默丢数据**，
 * 模型要能知道「只给了前 N 条」以及「怎么继续要剩下的」。
 */
export function projectRows(rows, opts) {
  const mode = detailMode(opts.detail);
  const list = [...(rows || [])];
  if (mode === "detailed") {
    return { rows: list, mode, truncated: false, total: list.length, note: "" };
  }
  const keys = opts.keys && opts.keys.length ? opts.keys : null;
  const projected = keys
    ? list.map((row) => {
        const out = {};
        for (const key of keys) if (row[key] !== undefined) out[key] = row[key];
        return out;
      })
    : list;
  const cap = Math.max(1, Math.floor(opts.cap));
  const limited = projected.slice(0, cap);
  const truncated = projected.length > cap;
  return {
    rows: limited,
    mode,
    truncated,
    total: projected.length,
    note: truncated ? `仅返回前 ${cap} 条（共 ${projected.length} 条）${opts.hint ? `；${opts.hint}` : ""}` : "",
  };
}

/** 工具描述里共用的双模式说明句（一处定义，各工具描述引用，避免措辞漂移）。 */
export const DETAIL_HINT = '默认 concise（只回高信号字段、按上限截断）；需要完整明细时传 detail="detailed"。';