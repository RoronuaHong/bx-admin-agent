/**
 * Table resolve: named / overlay / unique stem / clarify.
 * Run: tsx scripts/analytics-table-resolve.test.ts
 */
import assert from "node:assert/strict";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";
import { overlayAskFromNl, resolveAskTable, scoreAnswerableTables } from "../src/analytics/table-resolve.js";

const pack = {
  ...loadAnalyticsPack("watch-detail"),
  warehouse: {
    tables: [
      { schema: "film_report", name: "elt_watch_detail", fields: ["guid"] },
      { schema: "film_report", name: "elt_film_order", fields: ["payTime"] },
      { schema: "film_report", name: "elt_film_movie", fields: ["onlineTime"] },
      { schema: "film_report", name: "film_user_device_info_simple", fields: ["guid"] },
      { schema: "film_report", name: "elt_ul_activity_device", fields: ["guid"] },
      { schema: "film_report", name: "user_watch_movie_activity_device_log", fields: ["guid"] },
    ],
  },
};

assert.equal(overlayAskFromNl("IndiaA 按天观看人数", pack), true);
assert.equal(overlayAskFromNl("查订单数", pack), false);

{
  const r = resolveAskTable({ nl: "IndiaA 在 2026-08-19 至 2026-08-25 按天观看人数", pack });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.table, "elt_watch_detail");
    assert.equal(r.reason, "overlay_grounded");
  }
}

{
  const r = resolveAskTable({
    nl: "查 elt_film_order 在 2026-08-19 到 2026-08-25 的订单数",
    pack,
  });
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.table, "elt_film_order");
}

{
  const r = resolveAskTable({ nl: "2026-08-19 到 2026-08-25 的订单数", pack });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.table, "elt_film_order");
    assert.match(r.reason, /unique_score/);
  }
}

{
  const r = resolveAskTable({ nl: "2026-08-19 到 2026-08-25 有多少台设备", pack });
  assert.equal(r.status, "clarify");
  if (r.status === "clarify") {
    assert.equal(r.reason, "ambiguous_table");
    assert.ok(r.options.some((o) => o.id === "film_user_device_info_simple"));
    assert.ok(r.options.some((o) => o.id === "elt_ul_activity_device"));
  }
}

{
  const r = resolveAskTable({ nl: "2026-08-19 到 2026-08-25 成交了多少", pack });
  assert.equal(r.status, "clarify");
  if (r.status === "clarify") assert.equal(r.reason, "table_unspecified");
}

{
  const r = resolveAskTable({
    nl: "IndiaB呢",
    pack,
    fallback: "elt_watch_detail",
  });
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.table, "elt_watch_detail");
}

{
  const scored = scoreAnswerableTables("订单", pack);
  assert.equal(scored[0]?.name, "elt_film_order");
}

{
  const r = resolveAskTable({
    nl: "查 elt_film_movie 在 2026-08-19 到 2026-08-25 有多少部",
    pack,
    hinted: "elt_film_order",
  });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.table, "elt_film_movie");
    assert.equal(r.reason, "named_in_nl");
  }
}

console.log("analytics-table-resolve.test.ts OK");
