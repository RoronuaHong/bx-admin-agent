import assert from "node:assert/strict";
import { loadAnalyticsPack, assertTableAllowed } from "../src/analytics/semantic-layer.js";

const pack = loadAnalyticsPack("watch-detail");
assert.equal(pack.datasource.engine, "clickhouse");
assert.ok(pack.tables.some((t) => t.name === "elt_watch_detail"));
assert.ok(pack.capabilities?.ops?.includes("base_aggregate"));
assert.ok(pack.capabilities?.unsupportedOpsHint?.yoy);
assert.throws(() => assertTableAllowed(pack, "secret_table"), /whitelist/i);
console.log("analytics-semantic-layer.test.ts OK");
