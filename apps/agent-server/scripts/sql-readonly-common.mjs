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

// 表值函数（table-valued function）：能**越出数据库边界**的，一律拒。
//
// 为什么必须单列：这些函数的首词是 select、也不含任何写操作关键字，纯靠首词白名单 +
// 关键字黑名单**全部放行**——但它们的能力并不小：
//   · url() / urlCluster() / remote() / remoteSecure() —— 任意 HTTP/TCP 出网。
//     `SELECT * FROM url('http://169.254.169.254/…')` 就是经典 SSRF，可读云元数据凭据，
//     也可探测内网服务。对"把 SQL 暴露给模型"的通道这是最高危的一类漏洞。
//   · file() / hdfs() / s3() —— 读服务器本地文件或对象存储（.env、密钥、配置都在射程内）。
//   · mysql() / postgresql() / mongodb() / redis() / odbc() / jdbc() —— 可连任意其它数据源，
//     相当于绕过本库账号权限边界去读别处。
//   · executable() —— 旧版本可执行命令。
// 这些不是"写操作"，所以只读闸门原本完全看不见它们；但它们**同样突破只读边界的意图**
// （只允许读本库数据）。fail-closed 一律拒，不做"看起来像读就放行"的判断。
//
// 刻意**不**拒的：`values()` / `numbers()` / `input()` —— 它们只产生内联数据，不越界。
const DENY_TABLE_FUNCTIONS =
  "url|urlCluster|remote|remoteSecure|file|hdfs|s3|mysql|postgresql|mongodb|redis|odbc|jdbc|executable";
const DENY_TABLE_FN_RE = new RegExp(`\\b(${DENY_TABLE_FUNCTIONS})\\s*\\(`, "i");

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
  return LEADING_KEYWORDS.includes(first) && !DENY_RE.test(lower) && !DENY_PATTERNS.some((re) => re.test(lower)) && !DENY_TABLE_FN_RE.test(parts[0]);
}

/** 供测试与文档引用：当前被拒的表值函数清单。 */
export const READONLY_DENIED_TABLE_FUNCTIONS = DENY_TABLE_FUNCTIONS.split("|");
