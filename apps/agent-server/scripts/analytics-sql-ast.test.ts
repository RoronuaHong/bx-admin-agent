/**
 * SQL AST guard unit tests (zero network).
 * Run: tsx scripts/analytics-sql-ast.test.ts
 */
import assert from "node:assert/strict";
import {
  analyzeSqlAst,
  assertSqlAstSafe,
  stripSqlLiteralsAndComments,
} from "../src/analytics/sql-ast.js";
import { assertAnalyticsSqlSafe, assertReadonlySingleSelect } from "../src/analytics/sql-guard.js";

{
  const cleaned = stripSqlLiteralsAndComments(
    "SELECT * FROM t WHERE x = 'a; DROP TABLE t; --' -- boom\nAND y=1",
  );
  assert.equal(cleaned.includes("DROP"), false);
  assert.match(cleaned, /WHERE x = ''/);
}

{
  const ast = analyzeSqlAst(
    "SELECT uniq(guid) FROM elt_watch_detail WHERE toDate(lastWatchTime) BETWEEN '2026-08-19' AND '2026-08-25'",
  );
  assert.equal(ast.kind, "select");
  assert.equal(ast.statementCount, 1);
  assert.equal(ast.hasWhere, true);
  assert.deepEqual(ast.tables, ["elt_watch_detail"]);
  assert.deepEqual(ast.issues, []);
}

{
  const ast = analyzeSqlAst("SELECT 1; DELETE FROM t");
  assert.ok(ast.issues.includes("multi_statement"));
}

{
  const ast = analyzeSqlAst("INSERT INTO t SELECT 1");
  assert.ok(ast.issues.includes("non_readonly") || ast.issues.includes("not_select"));
}

{
  // 字面量里的分号不应拆成多语句
  const ast = analyzeSqlAst("SELECT 'a;b' AS x FROM elt_watch_detail WHERE channel='IndiaA'");
  assert.equal(ast.statementCount, 1);
  assert.ok(!ast.issues.includes("multi_statement"));
}

assert.doesNotThrow(() =>
  assertSqlAstSafe(
    "SELECT 1 FROM elt_watch_detail WHERE channel='IndiaA'",
    { requireWhere: true, allowedTables: ["elt_watch_detail"] },
  ),
);

assert.throws(
  () => assertSqlAstSafe("SELECT 1 FROM elt_watch_detail", { requireWhere: true }),
  /missing_where/,
);

assert.throws(
  () =>
    assertAnalyticsSqlSafe("SELECT 1 FROM secret_table WHERE 1=1", ["elt_watch_detail"]),
  /whitelist/,
);

assert.doesNotThrow(() =>
  assertReadonlySingleSelect("WITH cte AS (SELECT 1 AS a) SELECT a FROM cte"),
);

assert.throws(() => assertReadonlySingleSelect("SELECT 1 INTO OUTFILE '/tmp/x'"), /into_outfile|SQL AST/);

{
  const nested = `
SELECT channel,
  round(sumIf(a, contentLang = 'te-IN') / nullIf(countIf(contentLang = 'te-IN'), 0), 0) AS te_IN
FROM (
  SELECT channel, guid, eid, contentLang, max(maxWatchProgress) AS a
  FROM elt_watch_detail
  WHERE toDate(lastWatchTime) BETWEEN '2026-08-19' AND '2026-08-25'
  GROUP BY channel, guid, eid, contentLang
)
GROUP BY channel`;
  assert.equal(analyzeSqlAst(nested).hasWhere, true);
  assert.doesNotThrow(() =>
    assertSqlAstSafe(nested, { requireWhere: true, allowedTables: ["elt_watch_detail"] }),
  );
}

console.log("analytics-sql-ast.test.ts OK");
