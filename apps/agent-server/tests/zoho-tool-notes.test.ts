import { test, expect } from "vitest";
import { withToolNote } from "../src/mcp/hub.js";

test("withToolNote：有注记时追加中文用途，检索索引与工具 schema 都能被中文关键词命中", () => {
  expect(withToolNote("Retrieves notes.", "列出某会话的坐席内部备注")).toBe(
    "Retrieves notes.\n（用途：列出某会话的坐席内部备注）",
  );
});

test("withToolNote：无注记或空白注记时原样返回", () => {
  expect(withToolNote("desc", undefined)).toBe("desc");
  expect(withToolNote("desc", "   ")).toBe("desc");
});
