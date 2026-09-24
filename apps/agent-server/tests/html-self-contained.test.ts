// 产物自包含护栏（2026-09-24，docs/artifact-delivery-plan.md §11.2 原则 1）：
// fs_write 手写 HTML 若引用外部 CDN，离线打开会只剩空壳 → 回灌软提示引导改用 export_data。
// 与「跨轮重复调用」同口径：**只提示不硬拦**（不硬编码 if-else，保留模型内嵌第三方库的合法场景）。
import { test, expect, afterAll } from "vitest";
import { execBuiltin, externalRefHint } from "../src/builtins.js";
import { fsRemoveConversation } from "../src/fs-store.js";

const CONV = "vitest-html-self-contained";

afterAll(() => fsRemoveConversation(CONV));

test("[A] 引用 CDN 的 HTML → 回灌外链提示（含引用处数与样例）", () => {
  const html =
    '<html><head><script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>' +
    '<link href="https://cdn.jsdelivr.net/npm/bootstrap/dist/css/bootstrap.min.css" rel="stylesheet">' +
    "</head><body><div id=\"main\"></div></body></html>";
  const hint = externalRefHint(html);
  expect(hint).toContain("外部资源");
  expect(hint).toContain("2 处");
  expect(hint).toContain("cdn.jsdelivr.net");
  expect(hint).toContain("export_data");
});

test("[B] 协议相对路径 //cdn 也算外链", () => {
  expect(externalRefHint('<script src="//cdn.example.com/a.js"></script>')).toContain("外部资源");
});

test("[C] 自包含 HTML（内联 style / 内联 SVG / 相对路径）不误报", () => {
  const html =
    "<html><head><style>body{font-family:sans-serif}</style></head>" +
    '<body><svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg><img src="assets/logo.png"></body></html>';
  expect(externalRefHint(html)).toBe("");
});

test("[D] fs_write 写 .html 仍下发下载卡片，且外链提示回灌到工具结果", async () => {
  const out = await execBuiltin(
    "fs_write",
    JSON.stringify({
      path: "reports/交付.html",
      content: '<script src="https://cdn.example.com/chart.js"></script><h1>报表</h1>',
    }),
    CONV,
  );
  expect(out.ok).toBe(true);
  expect(out.text).toContain("下载卡片");
  expect(out.text).toContain("外部资源");
  expect(out.artifact?.name).toBe("交付.html");
});
