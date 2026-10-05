import { describe, expect, it } from "vitest";
import {
  OUTPUT_SCHEMAS,
  isChartSpecLike,
  validateChartArgs,
  validateClarification,
  validateTodos,
} from "../src/output-schema.js";

/** P2 补齐项：统一输出 schema 校验（LLM02 / ASI10）。 */

describe("request_clarification 输出 schema 校验", () => {
  it("合法：question + ≥2 个带 label 的 options", () => {
    const r = validateClarification({
      question: "用哪个数据源？",
      options: [{ label: "A" }, { label: "B" }, { label: "C" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.options).toHaveLength(3);
  });

  it("合法：可选澄清契约字段被保留", () => {
    const r = validateClarification({
      question: "q",
      options: [{ label: "A" }, { label: "B" }],
      missing_field: "data_source",
      why_it_matters: "决定了取数的接口",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.missingField).toBe("data_source");
      expect(r.value.whyItMatters).toBe("决定了取数的接口");
    }
  });

  it("非法：缺 question", () => {
    const r = validateClarification({ options: [{ label: "A" }, { label: "B" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("question");
  });

  it("非法：options 不足 2 个 → 拒绝（不让无指向提问漏出去）", () => {
    const r = validateClarification({ question: "q", options: [{ label: "A" }] });
    expect(r.ok).toBe(false);
  });

  it("非法：options 全是空 label → 有效项不足 2 个", () => {
    const r = validateClarification({ question: "q", options: [{ label: "" }, { label: "  " }] });
    expect(r.ok).toBe(false);
  });

  it("宽松：options 超过 6 个被截断到 6，不报错（弱模型多给不罚）", () => {
    const opts = Array.from({ length: 9 }, (_, i) => ({ label: `opt${i}` }));
    const r = validateClarification({ question: "q", options: opts });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.options).toHaveLength(6);
  });
});

describe("write_todos 输出 schema 校验", () => {
  it("合法：数组 + 每条约 content + 合法 status", () => {
    const r = validateTodos([
      { content: "取数", status: "in_progress" },
      { content: "出图", status: "pending" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(2);
  });

  it("合法：缺 status 补 pending", () => {
    const r = validateTodos([{ content: "x" }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[0].status).toBe("pending");
  });

  it("非法：非数组", () => {
    const r = validateTodos({ content: "x" });
    expect(r.ok).toBe(false);
  });

  it("非法：条数超过上限", () => {
    const r = validateTodos(Array.from({ length: 21 }, (_, i) => ({ content: `t${i}` })));
    expect(r.ok).toBe(false);
  });

  it("非法：空 content", () => {
    const r = validateTodos([{ content: "" }]);
    expect(r.ok).toBe(false);
  });

  it("非法：未知 status", () => {
    const r = validateTodos([{ content: "x", status: "maybe" }]);
    expect(r.ok).toBe(false);
  });
});

describe("render_chart 输出 schema 校验", () => {
  it("合法：统计图 data 为行对象数组", () => {
    const r = validateChartArgs({ chartType: "pie", data: [{ name: "A", value: 1 }] });
    expect(r.ok).toBe(true);
  });

  it("合法：图形类 data 为 {nodes,edges}", () => {
    const r = validateChartArgs({ chartType: "network", data: { nodes: [{}], edges: [{}] } });
    expect(r.ok).toBe(true);
  });

  it("非法：不支持的 chartType", () => {
    const r = validateChartArgs({ chartType: "banana", data: [] });
    expect(r.ok).toBe(false);
  });

  it("非法：统计图 data 为纯数字数组", () => {
    const r = validateChartArgs({ chartType: "line", data: [1, 2, 3] });
    expect(r.ok).toBe(false);
  });

  it("非法：图形类 data 为数组", () => {
    const r = validateChartArgs({ chartType: "graph", data: [1, 2] });
    expect(r.ok).toBe(false);
  });

  it("isChartSpecLike：与 validateChartArgs 同口径", () => {
    expect(isChartSpecLike({ chartType: "pie", data: [{ a: 1 }] })).toBe(true);
    expect(isChartSpecLike({ chartType: "pie", data: [1, 2] })).toBe(false);
    expect(isChartSpecLike({ chartType: "ghost", data: [] })).toBe(false);
    expect(isChartSpecLike(null)).toBe(false);
  });
});

describe("OUTPUT_SCHEMAS 登记清单（观测一致性）", () => {
  it("覆盖三个 fail-closed 工具输出 + 导出图表 artifact", () => {
    const names = OUTPUT_SCHEMAS.map((s) => s.name);
    expect(names).toContain("request_clarification");
    expect(names).toContain("write_todos");
    expect(names).toContain("render_chart");
    expect(names).toContain("export_data.charts");
  });

  it("工具输出类为 strict（fail-closed），artifact 为宽松过滤", () => {
    const by = Object.fromEntries(OUTPUT_SCHEMAS.map((s) => [s.name, s.strict]));
    expect(by["request_clarification"]).toBe(true);
    expect(by["write_todos"]).toBe(true);
    expect(by["render_chart"]).toBe(true);
    expect(by["export_data.charts"]).toBe(false);
  });

  it("每条都带可读的校验规则，便于 /chat/output-schema 暴露", () => {
    for (const s of OUTPUT_SCHEMAS) {
      expect(Array.isArray(s.rules) && s.rules.length > 0).toBe(true);
      expect(typeof s.description).toBe("string");
    }
  });
});
