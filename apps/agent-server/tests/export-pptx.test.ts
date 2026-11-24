// pptx 导出（additive）契约测试（2026-11-24）：
// A 纯计划（标题页 + 每表一页、title/name/matrix 原样透传）· B sections/charts 不产页 ·
// C 单表 rows 与多表 sheets 归一 · D fake builder 落盘通路（name/mime/bytes）·
// E builder 报错不落盘 · F 多表放行 · G 行数上限 · H/I 动态错误文案「仅尾部追加 pptx」。
// 全程用 setPptxBuilderForTest 注入假生成器，不真实生成二进制、不付 pptxgenjs 启动成本。
import { test, expect, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import { buildPptxPlan, execBuiltin, setPptxBuilderForTest, type PptxPlan } from "../src/builtins.js";
import { fsList, fsRead, fsRemoveConversation, fsResolve, fsStat } from "../src/fs-store.js";

const CONV = "vitest-export-pptx";
const run = (args: Record<string, unknown>) => execBuiltin("export_data", JSON.stringify(args), CONV);
const absOf = (p: string): string => {
  const abs = fsResolve(CONV, p);
  if (!abs) throw new Error(`无法解析产物路径：${p}`);
  return abs;
};

/** 每个用例后复位注入 seam，避免污染同文件后续用例与其它测试文件。 */
afterEach(() => setPptxBuilderForTest(null));
afterAll(() => fsRemoveConversation(CONV));

/** pptx 之前的 8 种导出格式（顺序与 EXPORT_FORMATS 字面量一致）。 */
const LEGACY_FORMATS = ["xlsx", "csv", "json", "md", "docx", "pdf", "html", "txt"];
/** pptx 之前的多表放行格式。 */
const LEGACY_MULTI_SHEET_FORMATS = ["xlsx", "docx", "pdf"];
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

test("[A] buildPptxPlan：标题页 + 每表一页，title/name/matrix 逐项原样透传（无标题不编造）", () => {
  const built = [
    { name: "表一", matrix: [["名称", "数量"], ["甲", 1]] },
    { name: "带/特殊:字符", matrix: [[true, { k: "v" }], [null, ""]] },
  ];
  const plan = buildPptxPlan({ title: "季度报告", built });
  expect(plan.slides).toHaveLength(3);
  expect(plan.slides[0]).toEqual({ kind: "title", title: "季度报告" });
  plan.slides.slice(1).forEach((slide, i) => {
    expect(slide.kind).toBe("table");
    if (slide.kind !== "table") return;
    expect(slide.name).toBe(built[i]!.name);
    // 同一矩阵引用直接进计划：既不复制也不改写单元格（长文本截断等交给下游生成器）。
    expect(slide.matrix).toBe(built[i]!.matrix);
    expect(slide.matrix).toEqual(built[i]!.matrix);
  });
  const noTitle = buildPptxPlan({ title: "", built: [] });
  expect(noTitle).toEqual({ slides: [{ kind: "title", title: "" }] });
});

test("[B] sections/charts 不额外产页：execBuiltin 捕获到的计划只有标题页 + 表格页", async () => {
  let captured: PptxPlan | null = null;
  setPptxBuilderForTest(async (plan) => {
    captured = plan;
    return new Uint8Array([0x50, 0x4b]);
  });
  const out = await run({
    filename: "报告.pptx",
    title: "标题",
    rows: [{ A: 1 }],
    sections: ["## 结论", "一段叙述"],
    charts: [{ chartType: "bar", data: [{ x: "甲", y: 1 }] }],
  });
  expect(out.ok, out.text).toBe(true);
  expect(captured).toBeTruthy();
  expect(captured!.slides).toEqual([
    { kind: "title", title: "标题" },
    { kind: "table", name: "标题", matrix: [["A"], [1]] },
  ]);
});

test("[C] 单表 rows 与多表 sheets（一张）归一成同一计划", async () => {
  const capture = async (args: Record<string, unknown>): Promise<PptxPlan> => {
    let plan: PptxPlan | null = null;
    setPptxBuilderForTest(async (p) => {
      plan = p;
      return new Uint8Array([1]);
    });
    const out = await run(args);
    expect(out.ok, out.text).toBe(true);
    if (!plan) throw new Error("builder 未被调用");
    return plan;
  };
  const rows = [{ A: 1, B: "甲" }];
  const byRows = await capture({ filename: "单表.pptx", title: "T", rows });
  const bySheets = await capture({ filename: "多表.pptx", title: "T", sheets: [{ name: "T", rows }] });
  expect(bySheets).toEqual(byRows);
  expect(byRows).toEqual({
    slides: [
      { kind: "title", title: "T" },
      { kind: "table", name: "T", matrix: [["A", "B"], [1, "甲"]] },
    ],
  });
});

test("[D] fake builder 落盘通路：artifact.name / mime / bytes 与磁盘字节一致", async () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef]);
  let seen: PptxPlan | null = null;
  setPptxBuilderForTest(async (plan) => {
    seen = plan;
    return bytes;
  });
  const out = await run({ filename: "产物.pptx", title: "T", rows: [{ A: 1 }] });
  expect(out.ok, out.text).toBe(true);
  expect(seen!.slides).toHaveLength(2);
  expect(out.artifact).toBeTruthy();
  expect(out.artifact!.name).toBe("产物.pptx");
  expect(out.artifact!.mime).toBe(PPTX_MIME);
  expect(out.artifact!.bytes).toBe(bytes.byteLength);
  expect(Buffer.from(fs.readFileSync(absOf(out.artifact!.path)))).toEqual(Buffer.from(bytes));
  // 二进制产物不能按文本读回（与 fs-store 的 BINARY_EXTS 白名单一致）。
  const read = fsRead(CONV, out.artifact!.path);
  expect(read).toHaveProperty("error");
  if ("error" in read) expect(read.error).toContain("二进制文件");
});

test("[E] builder 返回 {error}：ok:false、无 artifact、不落盘", async () => {
  setPptxBuilderForTest(async () => ({ error: "生成 pptx 失败：模拟生成器故障" }));
  const before = fsList(CONV).map((f) => f.path).sort();
  const out = await run({ filename: "失败.pptx", title: "T", rows: [{ A: 1 }] });
  expect(out.ok).toBe(false);
  expect(out.text).toContain("生成 pptx 失败：模拟生成器故障");
  expect(out.artifact).toBeUndefined();
  expect(fsList(CONV).map((f) => f.path).sort()).toEqual(before);
  expect(fsStat(CONV, "失败.pptx")).toBeNull();
});

test("[F] 多表 pptx 放行（与 xlsx/docx/pdf 同列）：每表一页、无拒绝文案", async () => {
  const sheets = [
    { name: "表一", rows: [{ A: 1 }] },
    { name: "表二", rows: [{ B: 2 }] },
  ];
  let captured: PptxPlan | null = null;
  setPptxBuilderForTest(async (plan) => {
    captured = plan;
    return new Uint8Array([1]);
  });
  const out = await run({ filename: "多表.pptx", sheets });
  expect(out.ok, out.text).toBe(true);
  expect(out.text).not.toContain("多张表只能用");
  expect(captured!.slides.map((s) => s.kind)).toEqual(["title", "table", "table"]);
  expect(captured!.slides.slice(1)).toEqual([
    { kind: "table", name: "表一", matrix: [["A"], [1]] },
    { kind: "table", name: "表二", matrix: [["B"], [2]] },
  ]);
});

test("[G] pptx 仍受全局行数上限：超限如实报错，builder 不被调用", async () => {
  let calls = 0;
  setPptxBuilderForTest(async () => {
    calls += 1;
    return new Uint8Array([1]);
  });
  const limit = Number(process.env.FS_MAX_EXPORT_ROWS || 50_000) || 50_000;
  const big = Array.from({ length: limit + 2 }, () => [1]); // 首行是表头 → 数据行 = limit + 1
  const out = await run({ filename: "超大.pptx", rows: big });
  expect(out.ok).toBe(false);
  expect(out.text).toContain("数据行过多");
  expect(out.text).toContain(`pptx 上限 ${limit}`);
  expect(calls).toBe(0);
});

test("[H] 不支持格式文案：原 8 项逐字不变，pptx 只追加在尾部", async () => {
  const out = await run({ filename: "x.ppt", rows: [{ A: 1 }] });
  expect(out.ok).toBe(false);
  expect(out.text).toContain("导出失败：不支持的导出格式：ppt（支持 ");
  const listed = out.text.match(/（支持 (.+)）$/)?.[1];
  expect(listed).toBeTruthy();
  const parts = listed!.split(" / ");
  expect(parts.slice(0, LEGACY_FORMATS.length)).toEqual(LEGACY_FORMATS);
  expect(parts.slice(LEGACY_FORMATS.length)).toEqual(["pptx"]); // 仅尾部追加，无其它改动
});

test("[I] 多表拒绝文案：原 3 项逐字不变，pptx 只追加在格式列表尾部", async () => {
  const sheets = [
    { name: "一", rows: [{ A: 1 }] },
    { name: "二", rows: [{ A: 2 }] },
  ];
  const out = await run({ filename: "多表.csv", sheets });
  expect(out.ok).toBe(false);
  expect(out.text).toContain("导出失败：多张表只能用");
  const listed = out.text.match(/多张表只能用 (.+)（当前 format=csv）/)?.[1];
  expect(listed).toBeTruthy();
  const parts = listed!.split(" / ");
  expect(parts.slice(0, LEGACY_MULTI_SHEET_FORMATS.length)).toEqual(LEGACY_MULTI_SHEET_FORMATS);
  expect(parts.slice(LEGACY_MULTI_SHEET_FORMATS.length)).toEqual(["pptx"]);
  expect(out.text).toContain("请改用 .xlsx，或把多张表合并成一张。");
});
