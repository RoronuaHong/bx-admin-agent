// 查询校验闭环（§4.3-5）：把 run_native_query / execute_sql / query / construct_query 共用的
// 「执行前硬校验」与「执行后结构化反馈信号」收敛为纯函数单一可信来源，可回归测试、杜绝漂移。
// MCP 侧只提供信号；执行反馈自校正循环由消费方编排，不越界到 Agent。
import { isReadOnlySql } from "./sql-readonly-common.mjs";

// ---- 执行前：口径护栏 ----
// 拦截已知会产出错误业务结论的取数方式。弱模型会无视 skill 里的软性提示，
// 故此处做硬拒绝（与只读校验同一失败通道，fail-closed），逼模型改用正确口径，
// 而不是替它改写 SQL（改写等于猜口径，且会掩盖模型的能力缺口）。
export function checkCaliber(sql) {
  // ① 国家维度：禁止用 IP/网络代理列，必须用 elt_user_full.countryCode
  if (/\bipcountrycode\b/i.test(sql) || /\bnetworkcountryiso\b/i.test(sql)) {
    return {
      ok: false,
      error:
        "口径错误：国家维度不能用 ipCountryCode / networkCountryIso 这类代理列（来自 elt_app_params 关联，匹配稀疏、语义是「登录 IP 所在国」而非「账号所属国」）。" +
        "请改用 elt_user_full.countryCode（数值口径：91=印度、55=巴西），无需 JOIN elt_app_params，直接按该列分组即可。",
    };
  }
  // ② 会员存量：禁止用 elt_user_full_history.vipExpireDay>0 的设备级快照替代会员表
  if (/\belt_user_full_history\b/i.test(sql) && /\bvipexpireday\b/i.test(sql)) {
    return {
      ok: false,
      error:
        "口径错误：会员存量不能用 elt_user_full_history.vipExpireDay>0 的设备级快照（会漏算/多算、且无去重账号语义，趋势必然失真）。" +
        "请改用 elt_user_vip_info 的「去重账号」口径：vipType=2 且 startDate<=统计日 且 endDate>=统计日，uniqExact(uid) 得当日有效会员数；按日存量需逐日扫描该表。",
    };
  }
  return { ok: true };
}

// 只读硬校验 + 多语句拦截 + 口径护栏，单一实现防漂移。fail-closed：不明朗一律拒绝。
export function assertSql(input) {
  const sql = String(input ?? "").trim().replace(/;+\s*$/, "");
  if (!sql) return { ok: false, error: "SQL 为空。" };
  // 多语句判定只看「引号外 / 注释外」的分号，与 src/sql-readonly.ts 口径对齐，避免误杀合法单条查询。
  const bare = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ")
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, "``");
  if (bare.includes(";")) return { ok: false, error: "不接受多语句：一次只能执行一条 SQL。" };
  if (!isReadOnlySql(sql)) {
    return { ok: false, error: "只接受只读查询（SELECT / WITH / SHOW / EXPLAIN 等），写操作（INSERT/UPDATE/DELETE/DROP/…）被拒绝。" };
  }
  const caliber = checkCaliber(sql);
  if (!caliber.ok) return { ok: false, error: caliber.error };
  return { ok: true, sql };
}

// ---- 执行后：结构化反馈信号（§3-E 执行反馈自校正的机读输入）----
// 错误类型分类：让消费方区分「改 SQL 可修」（未知列/歧义列/语法/类型）与「须缩小范围」/「不可重试」。
const ERROR_PATTERNS = [
  { kind: "UNKNOWN_IDENTIFIER", re: /unknown identifier|unknown column|missing columns|UNKNOWN_IDENTIFIER|Code:\s*47\b/i, retryable: true, hint: "对照报错字段/表名，用 get_database_schema 复核真实结构，别猜列名。" },
  { kind: "AMBIGUOUS_COLUMN", re: /ambiguous|AMBIGUOUS_COLUMN/i, retryable: true, hint: "同名列在多表中歧义：给列加表别名前缀，或只 JOIN 必要的表。" },
  { kind: "SYNTAX_ERROR", re: /syntax error|SYNTAX_ERROR|Cannot parse/i, retryable: true, hint: "SQL 语法错误：检查括号、逗号、函数调用拼写。" },
  { kind: "TYPE_MISMATCH", re: /type mismatch|cannot convert|ILLEGAL_TYPE|Code:\s*53\b/i, retryable: true, hint: "类型不匹配：显式 CAST，或统一比较两侧的类型。" },
  { kind: "MEMORY_LIMIT", re: /Code:\s*241\b|MEMORY_LIMIT_EXCEEDED/i, retryable: true, hint: "内存超限：缩小时间窗/去掉一个维度，或改近似聚合。" },
  { kind: "SCAN_LIMIT", re: /Code:\s*307\b|TOO_MANY_ROWS|scan.*limit/i, retryable: true, hint: "扫描量超限：加过滤条件或先做分组计数确认规模。" },
  { kind: "TIMEOUT", re: /Code:\s*394\b|Timeout exceeded|TIMEOUT_EXCEEDED|查询超时/i, retryable: true, hint: "超时：缩小范围再逐段放大，原样重试不会更快。" },
  { kind: "PERMISSION", re: /permission denied|access denied|Code:\s*497\b/i, retryable: false, hint: "权限不足：换可见的表，或请管理员授权；改 SQL 无法解决。" },
  { kind: "UNKNOWN_TABLE", re: /Code:\s*60\b|UNKNOWN_TABLE|table .* doesn't exist/i, retryable: true, hint: "表不存在：用 get_database_schema 复核表名与 schema 前缀。" },
];

/** 把上游错误文本归类成机读信号 `{ errorKind, retryable, hint }`；识别不了时给 UNKNOWN（仍可重试）。 */
export function classifyQueryError(upstream) {
  const text = String(upstream ?? "");
  for (const p of ERROR_PATTERNS) {
    if (p.re.test(text)) return { errorKind: p.kind, retryable: p.retryable, hint: p.hint };
  }
  return { errorKind: "UNKNOWN", retryable: true, hint: "本次没有拿到数据：缩小查询范围或复核字段后重试；同一句原样重试通常不会成功。" };
}

/**
 * 结构化执行反馈：错误类型 / 是否空结果 / 行数 / 列数 / 是否截断 / 是否可重试 / 可操作提示。
 * 供调用方做「首猜失败 → 按信号修 SQL → 重试」的闭环，并据此实现重试预算与「同错两次即降级」。
 * @param {{ ok: boolean, upstreamText?: string, cols?: unknown[], rows?: unknown[], truncated?: boolean, hint?: string|null }} input
 */
export function buildQueryFeedback({ ok, upstreamText = "", cols = [], rows = [], truncated = false, hint = null, errorKind = null } = {}) {
  const err = ok ? null : classifyQueryError(upstreamText);
  return {
    ok: Boolean(ok),
    errorKind: errorKind ?? err?.errorKind ?? null,
    empty: ok ? rows.length === 0 : null,
    rowCount: ok ? rows.length : 0,
    colCount: ok ? cols.length : 0,
    truncated: Boolean(truncated),
    retryable: ok ? false : Boolean(err?.retryable), // 成功结果无需重试
    hint: err ? (hint ?? err.hint) : null,
  };
}

/** 把反馈信号渲染成结果文本末尾的一行机读注释（不改 SQL 语义、不破坏既有文本消费方）。 */
export function renderFeedbackLine(feedback) {
  return `-- [feedback] ${JSON.stringify(feedback)}`;
}
