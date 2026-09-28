// §14.3 遗留一致项闭环：rag/store 的 loadIndex / loadVectors 从「只按 mtime 失效」
// 补齐为 §14.2 同口径的「mtime + size」。测试复刻 mcp-config-hotreload 的竞态法：
// 同一毫秒内改写文件（utimes 回拨旧 mtime）且长度变化 → 旧实现感知不到（命中旧缓存），新实现必须重载。
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSources, stats, setRagDirForTest, resetCache } from "../src/rag/store.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-store-"));
setRagDirForTest(dir);
resetCache();

const indexFile = path.join(dir, "index.json");
const vectorsFile = path.join(dir, "vectors.json");

/** 写入新内容后把 mtime 回拨到旧值：只留「size 变化」这一条失效线索。 */
function writeSameMtime(file: string, content: string): void {
  let old: Date | null = null;
  try {
    old = fs.statSync(file).mtime;
  } catch {
    /* 首次写入无旧 mtime */
  }
  fs.writeFileSync(file, content, "utf8");
  if (old) fs.utimesSync(file, old, old);
}

describe("rag store 缓存失效键（mtime + size，§14.2 同口径）", () => {
  it("[A] index.json 同 mtime 改写且变长 → listSources 必须看到新文档", () => {
    writeSameMtime(indexFile, '{"updatedAt":1,"docs":[]}');
    expect(listSources()).toEqual([]); // 填充缓存并记录失效键

    // 同 mtime、更长内容：旧实现 mtime 命中旧缓存 → 仍返回 []（复现「入库成功但检索不到」）
    writeSameMtime(
      indexFile,
      '{"updatedAt":2,"docs":[{"id":"a#0","title":"T","source":"s.md","text":"hello","updatedAt":2}]}',
    );
    expect(listSources()).toEqual([{ source: "s.md", title: "T", chunks: 1 }]);
  });

  it("[B] vectors.json 同 mtime 改写且变长 → stats 必须看到新向量", () => {
    writeSameMtime(vectorsFile, '{"model":"m","dim":2,"vectors":{}}');
    expect(stats().vectors).toBe(0); // 填充缓存并记录失效键

    writeSameMtime(vectorsFile, '{"model":"m","dim":2,"vectors":{"a#0":[1,2]}}');
    expect(stats().vectors).toBe(1);
  });

  it("[C] 文件消失 → 回落空索引（失效键含 size，不会误用旧缓存）", () => {
    fs.rmSync(indexFile, { force: true });
    expect(listSources()).toEqual([]);
  });
});

afterAll(() => {
  resetCache();
  fs.rmSync(dir, { recursive: true, force: true });
});
