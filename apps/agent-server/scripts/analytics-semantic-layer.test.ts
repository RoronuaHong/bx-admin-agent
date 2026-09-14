import assert from "node:assert/strict";
import {
  loadAnalyticsPack,
  assertTableAllowed,
  compileTableRef,
  expandLinkedTables,
  inferTimeFieldFromTypes,
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

{
  const userTypes = {
    birthday: "type/DateTime",
    createdTime: "type/DateTime",
    lastLoginTime: "type/DateTime",
  };
  assert.equal(inferTimeFieldFromTypes(userTypes, Object.keys(userTypes)), "createdTime");
  assert.equal(
    inferTimeFieldFromTypes(
      { endTime: "type/DateTime", createdTime: "type/DateTime" },
      ["endTime", "createdTime"],
    ),
    "createdTime",
  );
  assert.equal(
    inferTimeFieldFromTypes(
      { updateTime: "type/DateTime", onlineTime: "type/DateTime", publishTime: "type/DateTime" },
      ["updateTime", "onlineTime", "publishTime"],
    ),
    "onlineTime",
  );
  assert.equal(
    inferTimeFieldFromTypes(
      { createTime: "type/DateTime", day: "type/Date" },
      ["createTime", "day"],
    ),
    "day",
  );
  assert.equal(
    inferTimeFieldFromTypes(
      { createTime: "type/DateTime", date: "type/Date" },
      ["createTime", "date"],
    ),
    "date",
  );
  assert.equal(inferTimeFieldFromTypes({ birthday: "type/DateTime" }, ["birthday"]), undefined);
  assert.equal(inferTimeFieldFromTypes({ expireTime: "type/DateTime" }, ["expireTime"]), undefined);
  assert.equal(
    packTimeField(
      {
        ...pack,
        warehouse: {
          tables: [
            {
              schema: "film_report",
              name: "elt_film_order",
              fields: ["payTime", "createdTime"],
              fieldTypes: { payTime: "type/DateTime", createdTime: "type/DateTime" },
            },
          ],
        },
      },
      "elt_film_order",
    ),
    "payTime",
  );
}

{
  const linked = {
    ...pack,
    warehouse: {
      tables: [
        { schema: "film_report", name: "elt_film_user", fields: ["_id"] },
        { schema: "film_report", name: "elt_film_order", fields: ["uid"] },
        { schema: "film_report", name: "elt_new_guid", fields: ["guid"] },
        { schema: "film_report", name: "elt_active_guid", fields: ["guid"] },
        { schema: "gather", name: "gather", fields: ["guid"] },
      ],
    },
  };
  assert.deepEqual(expandLinkedTables(linked, ["elt_film_order"]).sort(), [
    "elt_film_order",
    "elt_film_user",
  ]);
  const ret = expandLinkedTables(linked, ["gather"]);
  assert.ok(ret.includes("gather"));
  assert.ok(ret.includes("elt_new_guid"));
  assert.ok(ret.includes("elt_active_guid"));
}

console.log("analytics-semantic-layer.test.ts OK");
