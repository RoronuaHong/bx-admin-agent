import type { DistinctCountFn } from "./types.js";
import { analyzeSqlAst, assertSqlAstSafe } from "./sql-ast.js";

export { analyzeSqlAst, assertSqlAstSafe } from "./sql-ast.js";

/** Rewrite distinct-count calls to match the configured global default (§7.2). */
export function normalizeDistinctCount(sql: string, fn: DistinctCountFn): string {
  if (fn === "uniq") {
    return sql.replace(/\buniqExact\s*\(/gi, "uniq(");
  }
  return sql
    .replace(/\buniq\s*\(/gi, "uniqExact(")
    .replace(/\buniqExactExact\s*\(/gi, "uniqExact(");
}

/** Deterministic SQL lint checks aligned with spec §7.1（业务规则；结构项交给 AST）。 */
export function lintSql(sql: string, nl: string, opts?: { timeField?: string }): string[] {
  const issues: string[] = [];
  const ast = analyzeSqlAst(sql);
  issues.push(...ast.issues.filter((x) => x === "multi_statement" || x === "non_readonly" || x === "into_outfile" || x === "not_select"));

  const timeField = String(opts?.timeField || "lastWatchTime").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`${timeField}\\s*=\\s*'?\\d{4}-\\d{2}-\\d{2}'?`, "i").test(sql)) {
    issues.push("datetime_eq_date_string");
  }
  const allowDropEmpty = /不要没标|排除空|不要空语言/.test(nl);
  if (!allowDropEmpty && /contentLang\s*(!=|<>)\s*''/i.test(sql)) {
    issues.push("forbid_exclude_empty_lang");
  }
  if (/limit\s+1\b/i.test(sql) && !/只要第|第一名|top\s*1/i.test(nl)) {
    issues.push("avoid_limit_1_unless_asked");
  }
  return [...new Set(issues)];
}

/** Fail-closed guard: single read-only SELECT / WITH … SELECT；走 AST。 */
export function assertReadonlySingleSelect(sql: string): void {
  assertSqlAstSafe(sql);
}

/**
 * Extract bare table names from FROM / JOIN clauses (AST strip + scan).
 */
export function extractFromTables(sql: string): string[] {
  return analyzeSqlAst(sql).tables;
}

/** Ensure every extracted FROM table is in the allowed whitelist. */
export function assertTablesWhitelisted(sql: string, allowedTables: string[]): void {
  assertSqlAstSafe(sql, { allowedTables });
}

/** 问数编译结果：必须有 WHERE + 表白名单。 */
export function assertAnalyticsSqlSafe(sql: string, allowedTables: string[]): void {
  assertSqlAstSafe(sql, { requireWhere: true, allowedTables });
}
