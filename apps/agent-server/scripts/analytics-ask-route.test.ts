/**
 * Hybrid ask router (Path A / B / C).
 * Run: tsx scripts/analytics-ask-route.test.ts
 */
import assert from "node:assert/strict";
import { llmSqlEnabled, routeAnalyticsAsk } from "../src/analytics/ask-route.js";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";

const pack = loadAnalyticsPack("watch-detail");
const live = {
  ...pack,
  warehouse: {
    tables: [
      {
        schema: "film_report",
        name: "elt_film_user",
        fields: ["_id", "channel", "appVersion"],
        description: "用户",
      },
      {
        schema: "film_report",
        name: "elt_film_order",
        fields: ["uid", "createdTime", "amount"],
        fieldTypes: { createdTime: "type/DateTime", amount: "type/Float" },
        description: "订单表",
      },
      { schema: "film_report", name: "elt_new_guid", fields: ["guid"] },
      { schema: "film_report", name: "elt_active_guid", fields: ["guid"] },
      { schema: "gather", name: "gather", fields: ["guid"] },
    ],
  },
};

assert.equal(llmSqlEnabled({} as NodeJS.ProcessEnv), true);
assert.equal(llmSqlEnabled({ ANALYTICS_LLM_SQL: "off" } as NodeJS.ProcessEnv), false);

{
  const r = routeAnalyticsAsk({
    nl: "昨天观看人数",
    pack: live,
    lockedTable: "elt_watch_detail",
    linkedTables: ["elt_watch_detail"],
    llmSqlEnabled: true,
  });
  assert.equal(r.path, "intent_compile");
}

{
  const r = routeAnalyticsAsk({
    nl: "完播率宽表",
    pack: live,
    lockedTable: "elt_watch_detail",
    linkedTables: ["elt_watch_detail"],
    llmSqlEnabled: true,
  });
  assert.equal(r.path, "intent_compile");
}
{
  const r = routeAnalyticsAsk({
    nl: "完播率宽表 te-IN ta-IN",
    pack: live,
    lockedTable: "elt_watch_detail",
    linkedTables: ["elt_watch_detail"],
    llmSqlEnabled: true,
  });
  assert.equal(r.path, "intent_compile");
}

{
  const r = routeAnalyticsAsk({
    nl: "人均时长宽表",
    pack: live,
    lockedTable: "elt_watch_detail",
    linkedTables: ["elt_watch_detail"],
    llmSqlEnabled: true,
  });
  assert.equal(r.path, "intent_compile");
}

{
  const r = routeAnalyticsAsk({
    nl: "起播人数宽表",
    pack: live,
    lockedTable: "elt_watch_detail",
    linkedTables: ["elt_watch_detail"],
    llmSqlEnabled: true,
  });
  assert.equal(r.path, "intent_compile");
}

{
  const r = routeAnalyticsAsk({
    nl: "付费率",
    pack: live,
    lockedTable: "elt_film_order",
    linkedTables: ["elt_film_order", "elt_film_user"],
    llmSqlEnabled: true,
  });
  assert.equal(r.path, "intent_compile");
}

{
  const r = routeAnalyticsAsk({
    nl: "次日留存",
    pack: live,
    lockedTable: "elt_new_guid",
    linkedTables: ["elt_new_guid", "elt_active_guid", "gather"],
    llmSqlEnabled: true,
  });
  assert.equal(r.path, "intent_compile");
}

{
  const r = routeAnalyticsAsk({
    nl: "订单数",
    pack: live,
    lockedTable: "elt_film_order",
    linkedTables: ["elt_film_order"],
    llmSqlEnabled: true,
  });
  assert.equal(r.path, "intent_compile");
}

{
  const r = routeAnalyticsAsk({
    nl: "找下巴西环境的昨天到今天的日活",
    pack: live,
    lockedTable: "elt_active_guid",
    linkedTables: ["elt_active_guid"],
    llmSqlEnabled: true,
  });
  assert.equal(r.path, "intent_compile");
}

{
  const r = routeAnalyticsAsk({
    nl: "看看各渠道交叉怎么拆",
    pack: live,
    lockedTable: "elt_film_order",
    linkedTables: ["elt_film_order", "elt_film_user"],
    llmSqlEnabled: true,
  });
  assert.equal(r.path, "llm_sql");
  if (r.path === "llm_sql") {
    assert.ok(r.tables.includes("elt_film_order"));
  }
}

{
  const r = routeAnalyticsAsk({
    nl: "看看各渠道交叉怎么拆",
    pack: live,
    lockedTable: "elt_film_order",
    linkedTables: ["elt_film_order"],
    llmSqlEnabled: false,
  });
  assert.equal(r.path, "refuse");
  if (r.path === "refuse") assert.equal(r.reason, "llm_sql_disabled");
}

{
  const r = routeAnalyticsAsk({
    nl: "随便问问",
    pack: live,
    llmSqlEnabled: true,
  });
  assert.equal(r.path, "llm_sql");
}

{
  const r = routeAnalyticsAsk({
    nl: "有多少台设备",
    pack: live,
    lockedTable: "film_user_device_info_simple",
    linkedTables: ["film_user_device_info_simple", "elt_ul_activity_device"],
    tableConfidence: "retrieved",
    llmSqlEnabled: true,
  });
  assert.equal(r.path, "llm_sql");
  if (r.path === "llm_sql") {
    assert.ok(r.tables.includes("film_user_device_info_simple"));
    assert.ok(r.tables.includes("elt_ul_activity_device"));
  }
}

{
  const r = routeAnalyticsAsk({
    nl: "随便问问",
    pack,
    llmSqlEnabled: true,
  });
  assert.equal(r.path, "refuse");
  if (r.path === "refuse") assert.equal(r.reason, "no_route");
}

console.log("analytics-ask-route.test.ts OK");
