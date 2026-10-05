import { describe, expect, it } from "vitest";
import { isCatastrophicPattern } from "../src/fs-store.js";

/**
 * fsGrep 的 ReDoS 护栏：只拦「量词套量词」，不能误伤顺序量词。
 * 后者是日常检索的常用写法（a+b+、\d+\.\d+），误拒等于把工具废掉。
 */
describe("fsGrep 正则护栏", () => {
  it("拦住嵌套/指数回溯写法", () => {
    for (const pattern of [
      "(a+)+",
      "(.*)*",
      "(a*)*b",
      "(\\w+\\s?)+",
      "(a+b)+",
      "((a+)b)+",
      "(a+){2,}",
      // 交替重叠型：分支可重叠匹配 + 整体被量化 → 指数回溯（旧版漏判，只靠 2s 预算兜底）
      "(a|a)*",
      "(.*|a)*",
      "(a|ab)*",
      "(a?|b)*",
    ]) {
      expect(isCatastrophicPattern(pattern), pattern).toBe(true);
    }
  });

  it("放行同层顺序量词与有限量词（不误拒）", () => {
    for (const pattern of [
      "a+b+",
      "\\d+\\.\\d+",
      "\\w+@\\w+\\.com",
      "^\\s*#+\\s+(.*)$",
      "(foo|bar)+baz",
      "\\d{1,3}(\\.\\d{1,3}){3}",
      "a{2,}",
      "getTran\\('[^']*',\\s*'([^']*)'",
    ]) {
      expect(isCatastrophicPattern(pattern), pattern).toBe(false);
    }
  });
});
