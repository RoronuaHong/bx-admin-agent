/**
 * local-chart unit tests (no network).
 * Run: tsx scripts/analytics-local-chart.test.ts
 */
import assert from "node:assert/strict";
import {
  buildLocalChartFromTable,
  buildLocalChartsFromTables,
  pickCategoryColIndex,
  preferChartType,
} from "../src/analytics/local-chart.js";

{
  const cols = ["d", "users"];
  const rows = [
    ["2026-08-20", 10],
    ["2026-08-21", 12],
  ];
  assert.equal(pickCategoryColIndex(cols, rows), 0);
  assert.equal(preferChartType("day", "d", 2), "line");
  const chart = buildLocalChartFromTable({ title: "结果", cols, rows, grain: "day" });
  assert.ok(chart);
  assert.deepEqual(chart!.categories, ["2026-08-20", "2026-08-21"]);
  assert.equal(chart!.series[0].name, "users");
  assert.deepEqual(chart!.series[0].data, [10, 12]);
  assert.equal(chart!.series[0].type, "line");
}

{
  const chart = buildLocalChartFromTable({
    title: "排行",
    cols: ["channel", "users"],
    rows: [
      ["IndiaA", 100],
      ["FoxA", 80],
      ["GoGo", 50],
    ],
  });
  assert.ok(chart);
  assert.equal(chart!.series[0].type, "bar");
}

{
  assert.equal(
    buildLocalChartFromTable({ title: "x", cols: ["a"], rows: [[1]] }),
    null,
  );
  assert.equal(
    buildLocalChartFromTable({
      title: "x",
      cols: ["name", "label"],
      rows: [
        ["a", "b"],
        ["c", "d"],
      ],
    }),
    null,
  );
}

{
  const charts = buildLocalChartsFromTables([
    {
      title: "查询 1",
      cols: ["d", "users"],
      rows: [
        ["2026-08-20", 1],
        ["2026-08-21", 2],
      ],
      grain: "day",
    },
    {
      title: "查询 2",
      cols: ["contentLang", "users"],
      rows: [
        ["hi", 3],
        ["en", 4],
      ],
    },
  ]);
  assert.equal(charts.length, 2);
}

console.log("analytics-local-chart.test.ts OK");
