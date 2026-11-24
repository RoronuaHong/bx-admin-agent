// RAG 分块默认值与离线行为固化：不改分块策略，只锁住现有口径。
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { chunkText } from "../src/rag/store.js";

test("分块默认值仍为 900 / 120", () => {
  const source = readFileSync(new URL("../src/rag/store.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  expect(source).toContain("const CHUNK_CHARS = 900;");
  expect(source).toContain("const CHUNK_OVERLAP = 120;");
});

test("空文档与短文档不切片", () => {
  expect(chunkText("   \n  ")).toEqual([]);
  expect(chunkText("  短文档  ")).toEqual(["短文档"]);
});

test("长文档按段落切片并保留 120 字符重叠，不丢尾段", () => {
  const para = "内容".repeat(150); // 300 字符一段，5 段超过默认 900
  const text = Array.from({ length: 5 }, (_, i) => `${i} ${para}`).join("\n\n");
  const chunks = chunkText(text);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[0]!.length).toBeLessThan(900 + 300);
  expect(chunks[1]).toContain(chunks[0]!.slice(-100)); // 重叠来自上一段尾部
  expect(chunks.at(-1)).toContain("4 "); // 最后一段仍在
});
