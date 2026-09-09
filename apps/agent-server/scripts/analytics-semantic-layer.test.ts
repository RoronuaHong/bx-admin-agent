import assert from "node:assert/strict";
import { loadAnalyticsPack, assertTableAllowed } from "../src/analytics/semantic-layer.js";

const pack = loadAnalyticsPack("watch-detail");
assert.equal(pack.datasource.engine, "clickhouse");
assert.ok(pack.tables.some((t) => t.name === "elt_watch_detail"));
assert.throws(() => assertTableAllowed(pack, "secret_table"), /whitelist/i);
console.log("analytics-semantic-layer.test.ts OK");
