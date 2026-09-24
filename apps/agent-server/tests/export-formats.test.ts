// export_data 格式扩展回归（2026-09-23）：
// 钉住「8 种格式都能产出真实文件」+ 多表策略 + 扩展名别名 + 分格式行数上限，
// 避免将来改动把 pdf/docx 又退回「只能如实报错说做不到」。
// 依赖：docx / pdfmake 两个运行时依赖 + assets/fonts/NotoSansSC-Regular.otf 字体资产。
import { test, expect, afterAll } from "vitest";
import fs from "node:fs";
import { execBuiltin } from "../src/builtins.js";
import { fsRemoveConversation, fsResolve } from "../src/fs-store.js";

const CONV = "vitest-export-formats";
const rows = [
  { 名称: "甲", 数量: 1 },
  { 名称: "乙", 数量: 2 },
];
const run = (args: Record<string, unknown>) => execBuiltin("export_data", JSON.stringify(args), CONV);
const absOf = (p: string): string => {
  const abs = fsResolve(CONV, p);
  if (!abs) throw new Error(`无法解析产物路径：${p}`);
  return abs;
};

afterAll(() => fsRemoveConversation(CONV));

test("[A] 八种格式都生成真实文件（非空、可落盘）", async () => {
  for (const fmt of ["xlsx", "csv", "json", "md", "docx", "pdf", "html", "txt"]) {
    const out = await run({ filename: `回归.${fmt}`, title: "回归", rows });
    expect(out.ok, `${fmt}: ${out.text}`).toBe(true);
    expect(fs.statSync(absOf(out.artifact!.path)).size, fmt).toBeGreaterThan(0);
  }
});

test("[B] 二进制产物魔数正确：pdf=%PDF-、docx=PK", async () => {
  const pdf = await run({ filename: "魔数.pdf", title: "回归", rows });
  const docx = await run({ filename: "魔数.docx", title: "回归", rows });
  expect(fs.readFileSync(absOf(pdf.artifact!.path)).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(fs.readFileSync(absOf(docx.artifact!.path)).subarray(0, 2).toString("latin1")).toBe("PK");
});

test("[C] html 自带表格与标题，mime 为 text/html", async () => {
  const out = await run({ filename: "页面.html", title: "回归标题", rows });
  expect(out.ok).toBe(true);
  expect(out.artifact!.mime).toContain("text/html");
  const html = fs.readFileSync(absOf(out.artifact!.path), "utf-8");
  expect(html).toContain("<table>");
  expect(html).toContain("<h1>回归标题</h1>");
  expect(html).toContain("甲");
});

test("[D] 多表：xlsx/docx/pdf 放行；csv/json/md/html/txt 明确拒绝", async () => {
  const sheets = [
    { name: "表一", rows: [{ A: 1 }] },
    { name: "表二", rows: [{ A: 2 }] },
  ];
  for (const fmt of ["xlsx", "docx", "pdf"]) {
    const out = await run({ filename: `多表.${fmt}`, sheets });
    expect(out.ok, `${fmt}: ${out.text}`).toBe(true);
  }
  for (const fmt of ["csv", "json", "md", "html", "txt"]) {
    const out = await run({ filename: `多表.${fmt}`, sheets });
    expect(out.ok, fmt).toBe(false);
    expect(out.text, fmt).toContain("多张表只能用");
  }
});

test("[E] 扩展名别名归一：.xls → xlsx、.htm → html", async () => {
  const xls = await run({ filename: "别名.xls", rows });
  expect(xls.ok).toBe(true);
  expect(xls.artifact!.name.endsWith(".xlsx")).toBe(true);
  const htm = await run({ filename: "别名.htm", title: "别名", rows });
  expect(htm.ok).toBe(true);
  expect(htm.artifact!.mime).toContain("text/html");
});

test("[F] 不支持格式明确拒绝，且提示可用集合", async () => {
  const out = await run({ filename: "x.ppt", rows });
  expect(out.ok).toBe(false);
  expect(out.text).toContain("不支持的导出格式");
});

test("[G] pdf 行数上限收紧：超限报错并引导改用 xlsx", async () => {
  const big = Array.from({ length: 2001 }, (_, i) => ({ i }));
  const out = await run({ filename: "超大.pdf", rows: big });
  expect(out.ok).toBe(false);
  expect(out.text).toContain("pdf 上限");
  expect(out.text).toContain("xlsx");
});

// ---- v2.1（docs/artifact-delivery-plan.md §11）：报告式零表格 + fs_write 下载卡片 ----

test("[H] 报告式零表格：html 仅 sections+charts 可成文（内联 SVG、无外链脚本）", async () => {
  const out = await run({
    filename: "纯报告.html",
    title: "零表格报告",
    sections: ["## 结论", "- 第一条", "- 第二条"],
    charts: [{ chartType: "line", title: "趋势", data: [{ x: "周一", y: 1 }, { x: "周二", y: 3 }] }],
  });
  expect(out.ok, out.text).toBe(true);
  expect(out.artifact!.mime).toContain("text/html");
  const html = fs.readFileSync(absOf(out.artifact!.path), "utf-8");
  expect(html).toContain("<h1>零表格报告</h1>");
  expect(html).toContain("第一条");
  expect(html).toContain("<svg");
  // 自包含零外链：不接受 <script src=CDN>（对齐 report.ts 设计原则，§11.2 原则 1）
  expect(html).not.toContain("<script");
  expect(html).not.toContain("cdn.");
});

test("[I] 报告式零表格：pdf/docx 同样允许；数据格式无 rows 仍明确拒绝", async () => {
  for (const fmt of ["pdf", "docx"]) {
    const out = await run({ filename: `纯报告.${fmt}`, title: "零表格", sections: ["叙述"] });
    expect(out.ok, `${fmt}: ${out.text}`).toBe(true);
  }
  for (const fmt of ["xlsx", "csv", "json", "md", "txt"]) {
    const out = await run({ filename: `无行.${fmt}`, title: "无行" });
    expect(out.ok, fmt).toBe(false);
    expect(out.text, fmt).toContain("缺少数据行");
  }
});

test("[J] 三者全空（无 rows/sections/charts）明确拒绝，不产出空文件", async () => {
  for (const fmt of ["html", "pdf", "docx"]) {
    const out = await run({ filename: `空报告.${fmt}` });
    expect(out.ok, fmt).toBe(false);
    expect(out.text, fmt).toContain("缺少内容");
  }
});

test("[K] fs_write 写 .html 下发下载卡片；写 .md 维持草稿语义", async () => {
  const html = await execBuiltin(
    "fs_write",
    JSON.stringify({ path: "草稿页.html", content: "<h1>预览</h1>" }),
    CONV,
  );
  expect(html.ok, html.text).toBe(true);
  expect(html.artifact).toBeTruthy();
  expect(html.artifact!.mime).toContain("text/html");
  expect(html.artifact!.name).toBe("草稿页.html");
  const md = await execBuiltin("fs_write", JSON.stringify({ path: "草稿.md", content: "# 草稿" }), CONV);
  expect(md.ok, md.text).toBe(true);
  expect(md.artifact).toBeUndefined();
});
