import type { DistinctCountFn } from "./types.js";
import { analyzeSqlAst, assertSqlAstSafe } from "./sql-ast.js";
import {
  bareTableName,
  relationshipAllowsJoin,
  tableHasTimeField,
  type AnalyticsPack,
} from "./semantic-layer.js";
import { nlHasIntentSignal } from "./nl-signals.js";

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
export function lintSql(sql: string, nl: string, opts?: { pack?: AnalyticsPack; timeField?: string }): string[] {
  const issues: string[] = [];
  const ast = analyzeSqlAst(sql);
  issues.push(...ast.issues.filter((x) => x === "multi_statement" || x === "non_readonly" || x === "into_outfile" || x === "not_select"));

  // Time column comes from the caller (packTimeField) — no schema default in code.
  const timeField = String(opts?.timeField || "").trim();
  if (timeField) {
    const escaped = timeField.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`${escaped}\\s*=\\s*'?\\d{4}-\\d{2}-\\d{2}'?`, "i").test(sql)) {
      issues.push("datetime_eq_date_string");
    }
  }
  const allowDropEmpty = nlHasIntentSignal(nl, opts?.pack, "allowDropEmptyLang");
  if (!allowDropEmpty) {
    // Dims whose empty value is a real member (pack-owned flag) must not be excluded.
    for (const d of opts?.pack?.enumDimensions || []) {
      if (!d.denyEmptyExclusion || !d.field) continue;
      const f = d.field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`${f}\\s*(?:!=|<>)\\s*''`, "i").test(sql)) {
        issues.push("forbid_exclude_empty_lang");
        break;
      }
    }
  }
  if (/limit\s+1\b/i.test(sql) && !nlHasIntentSignal(nl, opts?.pack, "allowLimit1")) {
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

/** Require WHERE only when at least one table in the SQL has a time column. */
export function sqlRequiresWhere(sql: string, pack?: AnalyticsPack): boolean {
  if (!pack) return true;
  const tables = extractFromTables(sql);
  if (!tables.length) return true;
  return tables.some((t) => tableHasTimeField(pack, bareTableName(t)));
}

/** Fail unless every joined table is connected via declared relationships. */
export function assertJoinsOnDeclaredRelationships(sql: string, pack: AnalyticsPack): void {
  const tables = [...new Set(extractFromTables(sql).map((t) => bareTableName(t).toLowerCase()))].filter(
    Boolean,
  );
  if (tables.length <= 1) return;
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const a of tables) {
    for (const b of tables) {
      if (a !== b && relationshipAllowsJoin(pack, a, b)) {
        add(a, b);
        add(b, a);
      }
    }
  }
  const start = tables[0]!;
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const n of adj.get(cur) || []) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  const orphan = tables.filter((t) => !seen.has(t));
  if (orphan.length) {
    throw new Error(`undeclared_join:${orphan.join("+")}`);
  }
}

/** 问数编译结果：必须有 WHERE + 表白名单。 */
export function assertAnalyticsSqlSafe(
  sql: string,
  allowedTables: string[],
  opts?: { requireWhere?: boolean },
): void {
  assertSqlAstSafe(sql, {
    requireWhere: opts?.requireWhere !== false,
    allowedTables,
  });
}
