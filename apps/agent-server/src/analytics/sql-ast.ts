/**
 * SELECT-only SQL 结构分析（轻量 AST）：先剥离字面量/注释，再按括号深度切分顶层子句。
 * 不做完整方言解析；目标是挡住正则漏掉的多语句、写入、INTO OUTFILE、子查询外泄表等。
 */

export type SqlAstSummary = {
  kind: "select" | "with_select" | "invalid";
  statementCount: number;
  tables: string[];
  hasWhere: boolean;
  hasLimit: boolean;
  hasUnion: boolean;
  issues: string[];
};

const WRITE_KW =
  /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|attach|detach|rename|optimize|system|kill)\b/i;
const INTO_OUT = /\binto\s+(outfile|dumpfile|table)\b/i;

/** 去掉字符串字面量与注释，保留结构位置（用空格占位）。 */
export function stripSqlLiteralsAndComments(sql: string): string {
  let out = "";
  let i = 0;
  const s = sql || "";
  while (i < s.length) {
    const ch = s[i]!;
    const next = s[i + 1];
    // line comment
    if (ch === "-" && next === "-") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (ch === "#") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    // block comment
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < s.length - 1 && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    // single-quoted string ('' escape)
    if (ch === "'") {
      i++;
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (s[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      out += "''";
      continue;
    }
    // double-quoted ident/string
    if (ch === '"') {
      i++;
      while (i < s.length) {
        if (s[i] === '"' && s[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (s[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      out += '""';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function splitTopLevelStatements(cleaned: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      const chunk = cleaned.slice(start, i).trim();
      if (chunk) parts.push(chunk);
      start = i + 1;
    }
  }
  const last = cleaned.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function extractTablesFromClause(cleaned: string): string[] {
  const tables: string[] = [];
  const seen = new Set<string>();
  const re = /\b(?:from|join)\s+([a-zA-Z_][\w]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const name = m[1]!;
    // skip subquery alias after ) AS x — FROM (select...) t already skipped by pattern needing ident after FROM
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    tables.push(name);
  }
  return tables;
}

function topLevelHasKeyword(cleaned: string, kw: RegExp): boolean {
  let depth = 0;
  const tokens: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) tokens.push(buf.trim());
    buf = "";
  };
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i]!;
    if (c === "(") {
      flush();
      depth++;
      continue;
    }
    if (c === ")") {
      flush();
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;
    if (/\s/.test(c)) {
      flush();
      continue;
    }
    buf += c;
  }
  flush();
  const flat = tokens.join(" ");
  return kw.test(flat);
}

/**
 * 分析单条（或误带多语句的）SQL，返回结构摘要 + issues。
 */
export function analyzeSqlAst(sql: string): SqlAstSummary {
  const issues: string[] = [];
  const cleaned = stripSqlLiteralsAndComments(sql).replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return {
      kind: "invalid",
      statementCount: 0,
      tables: [],
      hasWhere: false,
      hasLimit: false,
      hasUnion: false,
      issues: ["empty_sql"],
    };
  }

  const stmts = splitTopLevelStatements(cleaned);
  if (stmts.length > 1) issues.push("multi_statement");

  const primary = stmts[0] || cleaned;
  if (WRITE_KW.test(primary)) issues.push("non_readonly");
  if (INTO_OUT.test(primary)) issues.push("into_outfile");

  const startsWithSelect = /^\s*select\b/i.test(primary);
  const startsWithWith = /^\s*with\b/i.test(primary);
  let kind: SqlAstSummary["kind"] = "invalid";
  if (startsWithWith) kind = "with_select";
  else if (startsWithSelect) kind = "select";
  else {
    issues.push("not_select");
  }

  // WITH 后最终必须落到 SELECT
  if (startsWithWith && !/\bselect\b/i.test(primary)) {
    issues.push("with_without_select");
    kind = "invalid";
  }

  const tables = extractTablesFromClause(primary);
  // WHERE may live only in a subquery (wide/pivot compile); accept nested WHERE.
  const hasWhere =
    topLevelHasKeyword(primary, /\bwhere\b/i) || /\bwhere\b/i.test(primary);
  const hasLimit = topLevelHasKeyword(primary, /\blimit\b/i);
  const hasUnion = topLevelHasKeyword(primary, /\bunion\b/i);

  if (kind === "invalid" && !issues.length) issues.push("invalid_ast");

  return {
    kind,
    statementCount: stmts.length,
    tables,
    hasWhere,
    hasLimit,
    hasUnion,
    issues: [...new Set(issues)],
  };
}

export type AstGuardOpts = {
  /** 分析问数 SQL 必须带 WHERE（时间/过滤） */
  requireWhere?: boolean;
  allowedTables?: string[];
};

/** Fail-closed：AST 结构不合法则抛错。 */
export function assertSqlAstSafe(sql: string, opts?: AstGuardOpts): void {
  const ast = analyzeSqlAst(sql);
  const issues = [...ast.issues];
  if (opts?.requireWhere && !ast.hasWhere) issues.push("missing_where");
  if (opts?.allowedTables?.length) {
    const allowed = new Set(opts.allowedTables.map((t) => t.toLowerCase()));
    for (const t of ast.tables) {
      if (!allowed.has(t.toLowerCase())) issues.push(`table not in whitelist: ${t}`);
    }
  }
  if (ast.kind === "invalid" || issues.length) {
    throw new Error(`SQL AST guard: ${[...new Set(issues)].join(", ")}`);
  }
}
