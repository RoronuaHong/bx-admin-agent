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

{
  const ast = analyzeSqlAst(
    "SELECT count() AS rows FROM gather.gather_stat WHERE toDate(createTime) BETWEEN '2026-08-19' AND '2026-08-25'",
  );
  assert.deepEqual(ast.tables, ["gather.gather_stat"]);
  assert.doesNotThrow(() =>
    assertSqlAstSafe(
      "SELECT count() AS rows FROM gather.gather_stat WHERE toDate(createTime) BETWEEN '2026-08-19' AND '2026-08-25'",
      { requireWhere: true, allowedTables: ["gather_stat"] },
    ),
  );
}

{
  const withCte =
    "WITH todayGuid AS (SELECT guid FROM elt_new_guid WHERE createDate = '2026-08-19') " +
    "SELECT uniq(guid) FROM todayGuid";
  const ast = analyzeSqlAst(withCte);
  assert.deepEqual(ast.tables, ["elt_new_guid"]);
  assert.doesNotThrow(() =>
    assertSqlAstSafe(withCte, { requireWhere: true, allowedTables: ["elt_new_guid"] }),
  );
}

{
  const retention = `WITH
'IndiaA' AS targetChannel,
toDate('2026-08-19') AS targetDate,
todayGuid AS (
  SELECT guid, argMax(contentLang, createTime) AS contentLang
  FROM gather.gather
  WHERE eventName = 'content_language_save_success'
    AND toDate(createTime) = targetDate
    AND channel = targetChannel
    AND guid IN (SELECT DISTINCT guid FROM elt_new_guid WHERE createDate = targetDate)
  GROUP BY guid
),
retentionGuid AS (
  SELECT b.guid
  FROM elt_active_guid AS a
  INNER JOIN todayGuid AS b ON a.guid = b.guid
  WHERE a.activeDate = addDays(targetDate, 1)
),
todayCount AS (SELECT uniq(guid) AS a FROM todayGuid),
retentionCount AS (SELECT uniq(guid) AS b FROM retentionGuid)
SELECT t1.a, t2.b
FROM todayCount AS t1, retentionCount AS t2`;
  const ast = analyzeSqlAst(retention);
  assert.equal(ast.kind, "with_select");
  assert.ok(!ast.tables.some((t) => /todayGuid|retentionGuid|todayCount|retentionCount/i.test(t)));
  assert.ok(ast.tables.includes("gather.gather") || ast.tables.includes("gather"));
  assert.ok(ast.tables.includes("elt_new_guid"));
  assert.ok(ast.tables.includes("elt_active_guid"));
  assert.doesNotThrow(() =>
    assertSqlAstSafe(retention, {
      requireWhere: true,
      allowedTables: ["gather", "gather.gather", "elt_new_guid", "elt_active_guid"],
    }),
  );
}

console.log("analytics-sql-ast.test.ts OK");
