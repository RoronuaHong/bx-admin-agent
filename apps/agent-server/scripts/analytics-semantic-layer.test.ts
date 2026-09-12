import assert from "node:assert/strict";
import {
  loadAnalyticsPack,
  assertTableAllowed,
  compileTableRef,
  packFieldsForTable,
  packTimeField,
} from "../src/analytics/semantic-layer.js";

const pack = loadAnalyticsPack("watch-detail");
assert.equal(pack.datasource.engine, "clickhouse");
assert.ok(pack.tables.some((t) => t.name === "elt_watch_detail"));
assert.ok(pack.capabilities?.ops?.includes("base_aggregate"));
assert.ok(pack.capabilities?.unsupportedOpsHint?.yoy);
const channelDim = (pack.enumDimensions || []).find((d) => d.field === "channel");
assert.equal(channelDim?.valueAliases?.["印度A"], "IndiaA");
assert.equal(channelDim?.valueAliases?.["巴西A"], undefined);
assert.throws(() => assertTableAllowed(pack, "secret_table"), /whitelist/i);

{
  const live = {
    ...pack,
    warehouse: {
      tables: [
        {
          schema: "film_report",
          name: "elt_film_order",
          fields: ["createdTime", "amount"],
          fieldTypes: { createdTime: "type/DateTime", amount: "type/Float" },
        },
        {
          schema: "film_report",
          name: "dim_country",
          fields: ["id", "name"],
          fieldTypes: { id: "type/Integer", name: "type/Text" },
        },
      ],
    },
  };
  assert.equal(packTimeField(live, "elt_film_order"), "createdTime");
  assert.equal(packTimeField(live, "dim_country"), "");
  assert.deepEqual(packFieldsForTable(live, "elt_film_order"), ["createdTime", "amount"]);
  assert.ok(!packFieldsForTable(live, "elt_film_order").includes("lastWatchTime"));
}

{
  const live = {
    ...pack,
    warehouse: {
      tables: [
        { schema: "gather", name: "gather_stat", fields: ["createTime"] },
        { schema: "film_report", name: "elt_watch_detail", fields: ["guid"] },
      ],
    },
  };
  assert.equal(compileTableRef(live, "elt_watch_detail"), "elt_watch_detail");
  assert.equal(compileTableRef(live, "gather_stat"), "gather.gather_stat");
}

console.log("analytics-semantic-layer.test.ts OK");
