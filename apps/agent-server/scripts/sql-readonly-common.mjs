// 原生 SQL 只读判定的**单一可信来源**（纯函数、无副作用，可被服务端 TS 与 MCP 适配器 mjs 两侧 import）。
//
// 为什么是单一文件、两侧都 import 它（而非各写一份）：
//   - 服务端 src/sql-readonly.ts（再导出本模块）在工具抵达 MCP 之前按 source=sql-readonly 硬拒非只读 SQL；
//   - scripts/metabase-mcp.mjs 在适配器侧做同口径粗筛（哪怕拿到管理员 Key 也只转发只读查询）。
// 两道是刻意的纵深防御，但**判定口径必须唯一**，否则改了一处忘了另一处就会出现「适配器放行、服务端拒绝」
// 或反之的静默漂移。把逻辑收口到本文件、两侧都 import，物理上消灭第二份副本（比靠注释提醒「记得同步」可靠）。
//
// fail-closed：任何不明朗的输入一律判为「不可放行」。
//
// ⚠️ 改白名单 / 黑名单 / 危险构造 / 多语句规则时，**只改这里**；不要到两侧再各写一份。
//    行为回归由 tests/sql-readonly-consistency.test.ts 兜住。

// 首词白名单：SQL 以这些词开头才可能是只读查询。
const LEADING_KEYWORDS = ["select", "with", "show", "describe", "desc", "explain"];

// 命中任一即判否（全文匹配，含字面量/注释脱去后的内容）。
const DENY_KEYWORDS = [
  "insert", "update", "delete", "drop", "alter", "create", "truncate", "merge", "replace", "upsert",
  "grant", "revoke", "attach", "detach", "exec", "execute", "call", "copy", "load", "set", "reset",
];

// 危险构造：首词是 select 也要拒（写文件 / 读文件 / 改库配置）。
const DENY_PATTERNS = [/into\s+(out|dump)file/, /load_file\s*\(/, /pg_read_file\s*\(/, /writable_schema/];

const DENY_RE = new RegExp("\\b(" + DENY_KEYWORDS.join("|") + ")\\b");

/** 去注释：注释里的关键字不参与判定（避免 `-- drop table` 之类被误杀）。 */
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n\r]*/g, " ");
}

/** 是否「可安全放行的单条只读查询」。fail-closed：不明朗一律 false。 */
export function isReadOnlySql(raw) {
  if (typeof raw !== "string") return false;
  // 脱掉字符串/标识符引号（单/双/反引号）再判定：列名或字面量恰好是保留字/含分号时，
  // 不被误判为写操作或多语句（如 SELECT "update" FROM t）。仍 fail-closed，不明朗一律 false。
  const sql = stripComments(raw)
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, "``")
    .trim();
  if (!sql) return false;
  const parts = sql.split(";").map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 1) return false; // 多语句一律拒绝（无正当用途）
  const lower = parts[0].toLowerCase();
  const first = lower.match(/^[a-z]+/)?.[0] || "";
  return LEADING_KEYWORDS.includes(first) && !DENY_RE.test(lower) && !DENY_PATTERNS.some((re) => re.test(lower));
}
