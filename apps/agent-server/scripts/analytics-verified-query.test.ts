/**
 * Verified query match / bind / promote-to-A.
 * Run: tsx scripts/analytics-verified-query.test.ts
 */
import assert from "node:assert/strict";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";
import {
  bindVerifiedQuery,
  compileCanCoverVerified,
  extractAppVersionFromNl,
  loadVerifiedQueries,
  matchVerifiedQuery,
} from "../src/analytics/verified-query.js";

const pack = {
  ...loadAnalyticsPack("watch-detail"),
  warehouse: {
    tables: [
      { schema: "film_report", name: "elt_film_user", fields: ["_id"] },
      { schema: "film_report", name: "elt_film_order", fields: ["uid"] },
      { schema: "film_report", name: "elt_new_guid", fields: ["guid"] },
      { schema: "film_report", name: "elt_active_guid", fields: ["guid"] },
      { schema: "gather", name: "gather", fields: ["guid"] },
      {
        schema: "gather",
        name: "gather_stat",
        fields: ["date", "eventName", "eventCount", "activeUsers"],
      },
    ],
  },
};

const queries = loadVerifiedQueries();
assert.ok(queries.length >= 6);
const avgWide = queries.find((q) => q.id === "watch_avg_per_user_lang_wide");
const completion = queries.find((q) => q.id === "watch_completion_lang_wide");
const pay = queries.find((q) => q.id === "pay_rate_lang_wide");
assert.ok(avgWide && completion && pay);
assert.equal(compileCanCoverVerified(completion, "完播率宽表"), true);
assert.equal(compileCanCoverVerified(completion, "完播率宽表 te-IN ta-IN"), true);
assert.equal(compileCanCoverVerified(avgWide, "人均时长宽表"), true);
assert.equal(compileCanCoverVerified(pay, "付费率"), true);
const retentionTotal = queries.find((q) => q.id === "retention_d1_total");
assert.ok(retentionTotal);
assert.equal(compileCanCoverVerified(retentionTotal, "次日留存"), true);

{
  const hit = matchVerifiedQuery("人均时长宽表", pack);
  assert.equal(hit, null);
}

{
  const hit = matchVerifiedQuery("完播率宽表", pack);
  assert.equal(hit, null);
}
{
  const hit = matchVerifiedQuery("完播率宽表 te-IN ta-IN ml-IN", pack);
  assert.equal(hit, null);
}

{
  const hit = matchVerifiedQuery("付费率", pack);
  assert.equal(hit, null);
}

{
  const hit = matchVerifiedQuery("次日留存", pack);
  assert.equal(hit, null);
}

{
  const missing = bindVerifiedQuery(pay, { start: "2026-09-01", end: "2026-09-07" });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.ok(missing.missing.includes("channel"));
    assert.ok(missing.missing.includes("appVersion"));
  }
}

{
  const bound = bindVerifiedQuery(pay, {
    start: "2026-09-01",
    end: "2026-09-07",
    channel: "IndiaA",
    appVersion: "1.2.3",
  });
  assert.equal(bound.ok, true);
  if (bound.ok) {
    assert.ok(bound.sql.includes("2026-09-01"));
    assert.ok(bound.sql.includes("IndiaA"));
    assert.ok(bound.sql.includes("1.2.3"));
    assert.ok(!bound.sql.includes("{{"));
  }
}

assert.equal(extractAppVersionFromNl("版本 2.4.1 的付费率"), "2.4.1");
assert.equal(extractAppVersionFromNl("看看人数"), undefined);

{
  const hit = matchVerifiedQuery("埋点汇总", pack);
  assert.ok(hit && "query" in hit);
  if (hit && "query" in hit) assert.equal(hit.query.id, "gather_stat_daily");
}

{
  const hit = matchVerifiedQuery("埋点", pack);
  assert.equal(hit, null);
}

{
  const q = queries.find((row) => row.id === "gather_stat_daily");
  assert.ok(q);
  const bound = bindVerifiedQuery(q!, { start: "2026-08-19", end: "2026-08-25" });
  assert.equal(bound.ok, true);
  if (bound.ok) {
    assert.ok(bound.sql.includes("gather.gather_stat"));
    assert.ok(bound.sql.includes("toDate(date)"));
    assert.ok(!bound.sql.includes("createTime"));
    assert.ok(!bound.sql.includes("{{"));
  }
}

console.log("analytics-verified-query.test.ts OK");
