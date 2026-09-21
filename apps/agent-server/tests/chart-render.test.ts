// render_chart 内置工具的入参校验与图表 spec 产出（纯逻辑，不需要网络/真实模型）。
// 覆盖四类真实会踩到的边界：JSON 双重编码、纯数字数组、图形类结构、类型白名单。
// 设计口径见 src/builtins.ts 的 render_chart 分支与 web/src/components/ChartCard.vue。
import { test, expect } from "vitest";
import { execBuiltin, CHART_TYPES } from "../src/builtins.js";

const run = (args: unknown) => execBuiltin("render_chart", JSON.stringify(args), "conv_chart_test");

test("[A] 统计图：行对象数组 → 成功并原样透传 spec", async () => {
  const out = await run({
    chartType: "column",
    title: "T",
    data: [{ name: "A", value: 1 }],
    encode: { x: "name", y: "value" },
  });
  expect(out?.ok).toBe(true);
  expect(out?.chart?.chartType).toBe("column");
  expect(out?.chart?.title).toBe("T");
  expect(Array.isArray(out?.chart?.data)).toBe(true);
  expect(out?.chart?.encode).toEqual({ x: "name", y: "value" });
});

test("[B] 双重编码：data/encode 是 JSON 字符串时也要能解析", async () => {
  const out = await run({
    chartType: "pie",
    data: JSON.stringify([{ k: "a", v: 2 }]),
    encode: JSON.stringify({ color: "k", y: "v" }),
  });
  expect(out?.ok).toBe(true);
  expect((out?.chart?.data as unknown[]).length).toBe(1);
  expect(out?.chart?.encode).toEqual({ color: "k", y: "v" });
});

test("[C] 纯数字数组：明确回告，而不是静默出空白图", async () => {
  const out = await run({ chartType: "column", data: [1, 2, 3] });
  expect(out?.ok).toBe(false);
  expect(out?.text).toContain("行对象");
});

test("[D] 统计图 data 不是数组 → 拒绝", async () => {
  const out = await run({ chartType: "column", data: { a: 1 } });
  expect(out?.ok).toBe(false);
});

test("[E] 图形类：{nodes,edges} 与 {name,children} 都放行", async () => {
  const sankey = await run({ chartType: "sankey", data: { nodes: [{ id: "a" }], edges: [] } });
  expect(sankey?.ok).toBe(true);
  const mind = await run({ chartType: "mind_map", data: { name: "root", children: [{ name: "c" }] } });
  expect(mind?.ok).toBe(true);
});

test("[F] 图形类 data 是数组 → 拒绝（数组 typeof 也是 object，必须显式排除）", async () => {
  const out = await run({ chartType: "network", data: [1, 2] });
  expect(out?.ok).toBe(false);
});

test("[G] 图形类 data 缺 nodes/children → 拒绝（否则前端才抛错降级成表格）", async () => {
  const out = await run({ chartType: "org_chart", data: { foo: 1 } });
  expect(out?.ok).toBe(false);
  expect(out?.text).toContain("nodes");
});

test("[H] 未知图表类型 → 拒绝", async () => {
  const out = await run({ chartType: "rainbow", data: [{ a: 1 }] });
  expect(out?.ok).toBe(false);
  expect(out?.text).toContain("不支持");
});

test("[I] 类型别名与大小写：type 字段 / 大写值都要兼容", async () => {
  const out = await run({ type: "COLUMN", data: [{ a: 1, b: 2 }] });
  expect(out?.ok).toBe(true);
  expect(out?.chart?.chartType).toBe("column");
});

test("[J] 行数上限：超过 5000 行截断（不整包回吐给前端）", async () => {
  const big = Array.from({ length: 5001 }, (_, i) => ({ i, v: i }));
  const out = await run({ chartType: "line", data: big });
  expect(out?.ok).toBe(true);
  expect((out?.chart?.data as unknown[]).length).toBe(5000);
});

test("[K] 空数组：放行（前端画空图，不当成错误）", async () => {
  const out = await run({ chartType: "bar", data: [] });
  expect(out?.ok).toBe(true);
});

test("[L] 白名单自检：G2 统计图 + G6 图形类类型都在 CHART_TYPES 里", () => {
  for (const t of [
    "pie",
    "bar",
    "column",
    "line",
    "area",
    "scatter",
    "radar",
    "treemap",
    "funnel",
    "boxplot",
    "histogram",
    "waterfall",
    "dual_axes",
    "sankey",
    "mind_map",
    "org_chart",
    "network",
  ]) {
    expect(CHART_TYPES.has(t)).toBe(true);
  }
});
