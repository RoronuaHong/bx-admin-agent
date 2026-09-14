/**
 * Path C date overlay / inclusive end.
 * Run: tsx scripts/analytics-sql-agent.test.ts
 */
import assert from "node:assert/strict";
import {
  buildSqlAgentCatalogHint,
  includeResolvedEndDay,
  missingNlAnchorsInSql,
  overlayResolvedDates,
  parseSqlAgentTurn,
} from "../src/analytics/sql-agent.js";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";
import { sanitizeAnalyticsLlmError } from "../src/analytics/llm-error.js";

assert.equal(
  includeResolvedEndDay(
    "SELECT 1 FROM t WHERE createdTime >= '2026-08-19 00:00:00' AND createdTime < '2026-08-25 00:00:00'",
    "2026-08-25",
  ),
  "SELECT 1 FROM t WHERE createdTime >= '2026-08-19 00:00:00' AND createdTime < addDays(toDate('2026-08-25'), 1)",
);

assert.equal(
  includeResolvedEndDay(
    "SELECT 1 FROM t WHERE toDate(createdTime) < toDate('2026-08-25')",
    "2026-08-25",
  ),
  "SELECT 1 FROM t WHERE toDate(createdTime) < addDays(toDate('2026-08-25'), 1)",
);

assert.match(
  overlayResolvedDates(
    "SELECT 1 FROM t WHERE createdTime >= '2020-01-01 00:00:00' AND createdTime < '2020-01-07 00:00:00'",
    "2026-08-19",
    "2026-08-25",
  ),
  /createdTime >= '2026-08-19 00:00:00' AND createdTime < addDays\(toDate\('2026-08-25'\), 1\)/,
);

assert.match(
  overlayResolvedDates(
    "SELECT 1 FROM t WHERE toDate(createdTime) BETWEEN '2020-01-01' AND '2020-01-07'",
    "2026-08-19",
    "2026-08-25",
  ),
  /BETWEEN '2026-08-19' AND '2026-08-25'/,
);

{
  const pack = loadAnalyticsPack("watch-detail");
  assert.deepEqual(
    missingNlAnchorsInSql(
      "IndiaA 1.2.3 elt_film_user 渠道交叉",
      "SELECT channel FROM elt_film_user WHERE toDate(createdTime) BETWEEN '2026-09-01' AND '2026-09-07'",
      pack,
    ),
    ["missing_channel:IndiaA", "missing_appVersion:1.2.3"],
  );
  assert.deepEqual(
    missingNlAnchorsInSql(
      "IndiaA 1.2.3 交叉",
      "SELECT 1 FROM elt_film_user WHERE channel = 'IndiaA' AND appVersion = '1.2.3'",
      pack,
    ),
    [],
  );
  assert.deepEqual(
    missingNlAnchorsInSql(
      "te-IN ta-IN elt_film_user 交叉",
      "SELECT channel FROM elt_film_user WHERE channel = 'IndiaA'",
      pack,
    ),
    ["missing_locale:te-IN", "missing_locale:ta-IN"],
  );
  assert.deepEqual(
    missingNlAnchorsInSql(
      "te-IN 交叉",
      "SELECT 1 FROM elt_film_user WHERE contentLang = 'te-IN'",
      pack,
    ),
    [],
  );
}

{
  const live = {
    ...loadAnalyticsPack("watch-detail"),
    warehouse: {
      tables: [
        {
          schema: "film_report",
          name: "elt_film_order",
          fields: ["payTime", "amount"],
          description: "用户订单表",
        },
        {
          schema: "film_report",
          name: "elt_film_user",
          fields: ["_id", "channel"],
          description: "账号资料",
        },
      ],
    },
  };
  const hint = buildSqlAgentCatalogHint(live, ["elt_film_order"]);
  assert.match(hint, /Answerable tables \(2\)/);
  assert.match(hint, /Index only/);
  assert.match(hint, /elt_film_user/);
  assert.match(hint, /Already schemed/);
  assert.match(hint, /payTime/);
}

{
  const schema = parseSqlAgentTurn('{"action":"get_table_schema","tables":["elt_film_user"]}');
  assert.equal(schema.status, "get_schema");
  if (schema.status === "get_schema") assert.deepEqual(schema.tables, ["elt_film_user"]);
  const sql = parseSqlAgentTurn('{"sql":"SELECT 1","tables":["elt_film_order"]}');
  assert.equal(sql.status, "ok");
}

{
  assert.match(
    sanitizeAnalyticsLlmError(
      '{"error":{"type":"gateway_error","code":"401008","message":"The free trial quota"}}',
    ),
    /额度已耗尽/,
  );
  assert.match(sanitizeAnalyticsLlmError(new Error("llm_timeout")), /超时/);
  assert.doesNotMatch(
    sanitizeAnalyticsLlmError('{"error":{"type":"gateway_error","code":"401008"}}'),
    /gateway_error/,
  );
}

console.log("analytics-sql-agent.test.ts OK");
