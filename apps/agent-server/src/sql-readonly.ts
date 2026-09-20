// 原生 SQL 只读判定（服务端单一真相，fail-closed）。
// 首词白名单。
const LEADING_KEYWORDS = ["select", "with", "show", "describe", "desc", "explain"];

// 命中任一即判否。
const DENY_KEYWORDS = [
  "insert", "update", "delete", "drop", "alter", "create", "truncate", "merge", "replace", "upsert",
  "grant", "revoke", "attach", "detach", "exec", "execute", "call", "copy", "load", "set", "reset",
];

// 危险构造：首词是 select 也要拒（写文件 / 读文件 / 改库配置）。
const DENY_PATTERNS = [/into\s+(out|dump)file/, /load_file\s*\(/, /pg_read_file\s*\(/, /writable_schema/];

const DENY_RE = new RegExp("\\b(" + DENY_KEYWORDS.join("|") + ")\\b");
/** 是否「可安全放行的单条只读查询」。fail-closed：不明朗一律 false。 */
export function isReadOnlySql(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  // 脱掉字符串/标识符引号（单/双/反引号）再判定：列名或字面量恰好是保留字/含分号时，
  // 不被误判为写操作或多语句（如 SELECT "update" FROM t）。仍 fail-closed，不明朗一律 false。
  const sql = stripComments(raw)
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, "``")
    .trim();
  if (!sql) return false;
  return check(sql);
}

/** 单条语句 + 首词白名单 + 全文黑名单。 */
function check(sql: string): boolean {
  const parts = sql.split(";").map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 1) return false;
  return wordsOk(parts[0]!);
}

/** 命中黑名单词或危险构造即判否。 */
function hasDeny(lower: string): boolean {
  return DENY_RE.test(lower) || DENY_PATTERNS.some((re) => re.test(lower));
}

/** 首词白名单 + 全文黑名单词 / 危险构造。 */
function wordsOk(sql: string): boolean {
  const lower = sql.toLowerCase();
  const first = lower.match(/^[a-z]+/)?.[0] || "";
  return LEADING_KEYWORDS.includes(first) && !hasDeny(lower);
}

/** 去注释：注释里的关键字不参与判定。 */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n\r]*/g, " ");
}
