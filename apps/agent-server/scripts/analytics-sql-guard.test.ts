/**
 * SQL guard lint + distinctCountFn normalize unit tests (zero network).
 * Run: tsx scripts/analytics-sql-guard.test.ts
 */
import assert from "node:assert/strict";
import {
  assertAnalyticsSqlSafe,
  assertJoinsOnDeclaredRelationships,
  assertReadonlySingleSelect,
  assertTablesWhitelisted,
  extractFromTables,
  lintSql,
  normalizeDistinctCount,
  sqlRequiresWhere,
} from "../src/analytics/sql-guard.ts";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";

const okSelect =
  "SELECT uniq(guid) AS users FROM elt_watch_detail WHERE channel='IndiaA' LIMIT 100";

// ---- assertReadonlySingleSelect ----
assert.doesNotThrow(() => assertReadonlySingleSelect(okSelect));
assert.doesNotThrow(() =>
  assertReadonlySingleSelect("WITH cte AS (SELECT 1) SELECT * FROM cte"),
);

assert.throws(
  () => assertReadonlySingleSelect("INSERT INTO t SELECT 1"),
  /non_readonly/,
);
assert.throws(
  () => assertReadonlySingleSelect("SELECT 1; SELECT 2"),
  /multi_statement/,
);
assert.throws(() => assertReadonlySingleSelect("UPDATE t SET x=1"), /non_readonly/);

// ---- lintSql: multi-statement & non-readonly ----
assert.ok(lintSql("SELECT 1; SELECT 2", "").includes("multi_statement"));
assert.ok(lintSql("INSERT INTO t VALUES (1)", "").includes("non_readonly"));
assert.deepEqual(lintSql(okSelect, ""), []);

// ---- lintSql: datetime_eq_date_string ----
assert.ok(
  lintSql(
    "SELECT count(*) FROM elt_watch_detail WHERE lastWatchTime = '2026-08-20'",
    "8月20日人数",
  ).includes("datetime_eq_date_string"),
);
assert.ok(
  !lintSql(
    "SELECT count(*) FROM elt_watch_detail WHERE toDate(lastWatchTime) = '2026-08-20'",
    "8月20日人数",
  ).includes("datetime_eq_date_string"),
);
assert.ok(
  lintSql(
    "SELECT count(*) FROM ads_other WHERE eventAt = '2026-08-20'",
    "8月20日人数",
    { timeField: "eventAt" },
  ).includes("datetime_eq_date_string"),
);

// ---- lintSql: forbid_exclude_empty_lang ----
assert.ok(
  lintSql(
    "SELECT contentLang, uniq(guid) FROM elt_watch_detail GROUP BY contentLang",
    "按语言看人数",
  ).includes("forbid_exclude_empty_lang") === false,
);
assert.ok(
  lintSql(
    "SELECT contentLang, uniq(guid) FROM elt_watch_detail WHERE contentLang != '' GROUP BY contentLang",
    "按语言看人数",
  ).includes("forbid_exclude_empty_lang"),
);
assert.ok(
  !lintSql(
    "SELECT contentLang, uniq(guid) FROM elt_watch_detail WHERE contentLang != '' GROUP BY contentLang",
    "按语言看人数，排除空语言",
  ).includes("forbid_exclude_empty_lang"),
);

// ---- lintSql: avoid_limit_1_unless_asked ----
assert.ok(
  lintSql(
    "SELECT channel, uniq(guid) FROM elt_watch_detail GROUP BY channel ORDER BY 2 DESC LIMIT 1",
    "各渠道人数排行",
  ).includes("avoid_limit_1_unless_asked"),
);
assert.ok(
  !lintSql(
    "SELECT channel, uniq(guid) FROM elt_watch_detail GROUP BY channel ORDER BY 2 DESC LIMIT 1",
    "只要第一名 top 1",
  ).includes("avoid_limit_1_unless_asked"),
);

// ---- normalizeDistinctCount ----
assert.equal(
  normalizeDistinctCount("SELECT uniqExact(guid) FROM t", "uniq"),
  "SELECT uniq(guid) FROM t",
);
assert.equal(
  normalizeDistinctCount("SELECT uniqExact(a), uniqExact(b) FROM t", "uniq"),
  "SELECT uniq(a), uniq(b) FROM t",
);
assert.equal(
  normalizeDistinctCount("SELECT uniq(guid) FROM t", "uniq"),
  "SELECT uniq(guid) FROM t",
);
assert.equal(
  normalizeDistinctCount("SELECT uniq(guid) FROM t", "uniqExact"),
  "SELECT uniqExact(guid) FROM t",
);
assert.equal(
  normalizeDistinctCount("SELECT uniqExact(guid) FROM t", "uniqExact"),
  "SELECT uniqExact(guid) FROM t",
);

// ---- extractFromTables / assertTablesWhitelisted ----
assert.deepEqual(extractFromTables("SELECT * FROM elt_watch_detail"), ["elt_watch_detail"]);
assert.deepEqual(extractFromTables("SELECT * FROM elt_watch_detail JOIN other ON 1=1"), [
  "elt_watch_detail",
  "other",
]);
assert.deepEqual(
  extractFromTables(
    "SELECT * FROM elt_watch_detail LEFT JOIN secret_table ON 1=1 RIGHT JOIN other ON 1=1",
  ),
  ["elt_watch_detail", "secret_table", "other"],
);

assert.doesNotThrow(() =>
  assertTablesWhitelisted("SELECT * FROM elt_watch_detail", ["elt_watch_detail"]),
);
assert.throws(
  () => assertTablesWhitelisted("SELECT * FROM secret_table", ["elt_watch_detail"]),
  /whitelist/,
);
assert.throws(
  () =>
    assertTablesWhitelisted(
      "SELECT * FROM elt_watch_detail JOIN secret_table ON 1=1",
      ["elt_watch_detail"],
    ),
  /whitelist/,
);

assert.doesNotThrow(() =>
  assertAnalyticsSqlSafe("SELECT 1 FROM dim_x", ["dim_x"], { requireWhere: false }),
);
assert.throws(
  () => assertAnalyticsSqlSafe("SELECT 1 FROM dim_x", ["dim_x"], { requireWhere: true }),
  /missing_where/,
);

{
  const pack = loadAnalyticsPack("watch-detail");
  const live = {
    ...pack,
    warehouse: {
      tables: [
        { schema: "film_report", name: "dim_country", fields: ["id", "name"] },
        {
          schema: "film_report",
          name: "elt_film_order",
          fields: ["createdTime", "uid"],
          fieldTypes: { createdTime: "type/DateTime" },
        },
      ],
    },
  };
  assert.equal(sqlRequiresWhere("SELECT 1 FROM dim_country", live), false);
  assert.equal(sqlRequiresWhere("SELECT 1 FROM elt_watch_detail", live), true);
  assert.doesNotThrow(() =>
    assertJoinsOnDeclaredRelationships(
      "SELECT 1 FROM elt_film_user a INNER JOIN elt_film_order b ON a._id = b.uid",
      live,
    ),
  );
  assert.doesNotThrow(() =>
    assertJoinsOnDeclaredRelationships(
      "SELECT 1 FROM gather g INNER JOIN elt_new_guid n ON g.guid = n.guid INNER JOIN elt_active_guid a ON n.guid = a.guid",
      live,
    ),
  );
  assert.throws(
    () =>
      assertJoinsOnDeclaredRelationships(
        "SELECT 1 FROM elt_watch_detail w INNER JOIN elt_film_order o ON 1=1",
        live,
      ),
    /undeclared_join/,
  );
}

console.log("analytics-sql-guard.test.ts OK");
