// 答案侧协议护栏（纯逻辑，不需要网络/真实模型）：
// 覆盖「把工具产出写成正文文本」的两种载体——工具调用语句（looksLikePseudoToolCall）
// 与图片占位符（unresolvableImageTargets）。设计口径见 src/chat.ts 对应函数注释。
//
// 真实用例来源：定时任务「每日渠道来源结构监测」某期模型没调 render_chart，
// 正文里直接写了 `![近 7 天 vs 前 7 天 各来源日均环比（%）](chart)` —— 浏览器按相对路径请求 → 破图。
import { test, expect } from "vitest";
import { looksLikePseudoToolCall, unresolvableImageTargets } from "../src/chat.js";

const TOOLS = new Set(["render_chart", "fs_read", "search_tools"]);

test("[A] 图片占位符：目标不是可解析地址 → 命中并回报目标", () => {
  // 实测形态（图标题带括号与百分号也要认得出来）
  expect(unresolvableImageTargets("![近 7 天 vs 前 7 天 各来源日均环比（%）](chart)")).toEqual(["chart"]);
  expect(unresolvableImageTargets("![](url)")).toEqual(["url"]);
  // 空目标 / 相对路径：浏览器一律按相对 URL 请求，同样是破图
  expect(unresolvableImageTargets("![]( )")).toEqual([""]);
  expect(unresolvableImageTargets("![图](notes/a.png)")).toEqual(["notes/a.png"]);
});

test("[B] 图片占位符：可解析的图片地址不误伤", () => {
  expect(unresolvableImageTargets("![图](https://example.com/a.png)")).toEqual([]);
  expect(unresolvableImageTargets("![图](http://example.com/a.png)")).toEqual([]);
  expect(unresolvableImageTargets("![图](data:image/png;base64,AAAA)")).toEqual([]);
  expect(unresolvableImageTargets("![图](//cdn.example.com/a.png)")).toEqual([]);
});

test("[C] 图片占位符：代码块/行内代码里的图片语法是示例，不算假装出图", () => {
  expect(unresolvableImageTargets("写法如下：\n```md\n![标题](chart)\n```\n")).toEqual([]);
  expect(unresolvableImageTargets("行内示例 `![标题](chart)` 只是语法说明")).toEqual([]);
  // 围栏外的同款语法仍要命中（不能因为剥代码块而整体放过）
  expect(unresolvableImageTargets("```md\n![a](x)\n```\n\n![标题](chart)")).toEqual(["chart"]);
});

test("[D] 图片占位符：多张去重 / 普通正文零命中", () => {
  expect(unresolvableImageTargets("![](chart)\n\n![另一个标题](chart)")).toEqual(["chart"]);
  expect(unresolvableImageTargets("![](a)\n![](b)")).toEqual(["a", "b"]);
  expect(unresolvableImageTargets("没有任何图片语法的普通结论文本。")).toEqual([]);
  expect(unresolvableImageTargets("")).toEqual([]);
  // 链接（非图片）不在口径内
  expect(unresolvableImageTargets("[文档](chart)")).toEqual([]);
});

test("[E] 伪工具调用基线：调用形态 + 真实工具名双重命中", () => {
  expect(looksLikePseudoToolCall('{"name":"render_chart","arguments":{}}', TOOLS)).toBe(true);
  expect(looksLikePseudoToolCall("<render_chart></render_chart>", TOOLS)).toBe(true);
  expect(looksLikePseudoToolCall("取数结果如下：\n[render_chart]", TOOLS)).toBe(true);
  // 未知工具名 / 无调用形态 / markdown 链接都不要误判
  expect(looksLikePseudoToolCall('{"name":"whatever","arguments":{}}', TOOLS)).toBe(false);
  expect(looksLikePseudoToolCall("这段只是普通结论文本。", TOOLS)).toBe(false);
  expect(looksLikePseudoToolCall("[render_chart](https://example.com)", TOOLS)).toBe(false);
});
