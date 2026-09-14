/**
 * Table resolve: named / overlay / unique stem / retrieve (no lock-table clarify).
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
      {
        schema: "film_report",
        name: "elt_film_order",
        fields: ["payTime"],
        description: "本表为用户订单表，含明细信息",
      },
      {
        schema: "film_report",
        name: "elt_film_movie",
        fields: ["onlineTime"],
        description: "本表为影片资料表，一个影片可包含多个剧集",
      },
      {
        schema: "film_report",
        name: "elt_active_guid",
        fields: ["guid", "activeDate"],
        description: "记录最近1年每天的活跃用户，存储为每天一个分区",
      },
      {
        schema: "film_report",
        name: "elt_active_guid_2",
        fields: ["guid", "latestActiveDate"],
        description: "记录每个设备的活跃日期，此表是以设备维度记录活跃数据",
      },
      { schema: "film_report", name: "film_user_device_info_simple", fields: ["guid"] },
      { schema: "film_report", name: "elt_ul_activity_device", fields: ["guid"] },
      { schema: "film_report", name: "user_watch_movie_activity_device_log", fields: ["guid"] },
      {
        schema: "film_report",
        name: "watch_log",
        fields: ["watchTime", "guid"],
        description: "本表为观影日志事件流水。只有用户点名观影日志时才查本表。",
      },
    ],
  },
};

assert.equal(overlayAskFromNl("IndiaA 按天观看人数", pack), true);
assert.equal(overlayAskFromNl("查订单数", pack), false);
assert.equal(overlayAskFromNl("IndiaA 付费率", pack), false);
assert.equal(overlayAskFromNl("次日留存", pack), false);
assert.equal(overlayAskFromNl("查观影日志有多少条", pack), false);
assert.equal(overlayAskFromNl("观影日志的观看人数", pack), true);

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
  const r = resolveAskTable({ nl: "IndiaA 2.4.1 付费率", pack });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.table, "elt_film_user");
    assert.match(r.reason, /metric_tables/);
  }
}

{
  const r = resolveAskTable({ nl: "IndiaA 2.4.1 次日留存", pack });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.table, "elt_new_guid");
    assert.match(r.reason, /metric_tables/);
  }
}

{
  const r = resolveAskTable({ nl: "2026-08-19 到 2026-08-25 的订单数", pack });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.table, "elt_film_order");
    assert.equal(r.confidence, "unique");
    assert.match(r.reason, /unique_score/);
  }
}

{
  const r = resolveAskTable({ nl: "2026-08-19 到 2026-08-25 有多少台设备", pack });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.confidence, "retrieved");
    assert.ok(r.linked.includes("film_user_device_info_simple"));
    assert.ok(r.linked.includes("elt_ul_activity_device"));
  }
}

{
  const r = resolveAskTable({ nl: "2026-08-19 到 2026-08-25 成交了多少", pack });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.table, "elt_film_order");
    assert.ok(r.confidence === "unique" || r.confidence === "retrieved");
  }
}

{
  const leaked = {
    ...pack,
    warehouse: {
      tables: [
        ...(pack.warehouse?.tables || []),
        {
          schema: "film_report",
          name: "elt_invite_withdraw",
          fields: ["payTime", "amount"],
          description:
            "本表为邀请提现申请单，对照 elt_film_order（订单支付状态机）。核心信息：提现金额。",
        },
      ],
    },
  };
  const r = resolveAskTable({ nl: "2026-08-19 到 2026-08-25 的订单数", pack: leaked });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.table, "elt_film_order");
    assert.equal(r.confidence, "unique");
  }
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
  const wide = {
    ...pack,
    warehouse: {
      tables: [
        ...(pack.warehouse?.tables || []),
        {
          schema: "film_report",
          name: "elt_user_full",
          fields: ["recordDate"],
          description:
            "本表为用户画像数据的大宽表。\n核心信息：累计结算订单数量和金额、近N天创建的订单数量和金额。",
        },
      ],
    },
  };
  const r = resolveAskTable({ nl: "2026-08-19 到 2026-08-25 的订单数", pack: wide });
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.table, "elt_film_order");
}

{
  const r = resolveAskTable({ nl: "2026-08-19 到 2026-08-25 观影日志有多少条", pack });
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.table, "watch_log");
}

{
  const r = resolveAskTable({ nl: "2026-08-19 到 2026-08-25 影片资料有多少部", pack });
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.table, "elt_film_movie");
}

{
  const gpack = {
    ...pack,
    warehouse: {
      tables: [
        ...(pack.warehouse?.tables || []),
        {
          schema: "gather",
          name: "gather",
          fields: ["createTime", "eventName", "guid"],
          description: "本表为埋点明细。核心信息：事件名、设备。",
        },
        {
          schema: "gather",
          name: "gather_stat",
          fields: ["date", "eventName", "eventCount", "activeUsers"],
          fieldTypes: { date: "type/Date", createTime: "type/DateTime" },
          description:
            "本表为埋点的按日+事件汇总。核心信息：统计日、事件名、事件次数、活跃用户数。",
        },
      ],
    },
  };
  const r = resolveAskTable({ nl: "2026-08-19 到 2026-08-25 的埋点汇总", pack: gpack });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.table, "gather_stat");
    assert.ok(r.confidence === "unique" || r.confidence === "named");
  }
}

{
  const r = resolveAskTable({ nl: "2026-08-19 到 2026-08-25 活跃用户有多少", pack });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.match(r.table, /elt_active_guid/);
    assert.ok(r.linked.some((n) => n.startsWith("elt_active_guid")));
  }
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
