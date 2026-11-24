// AGENT_DATA_DIR 覆盖口径：所有落盘模块都从 store-util 的 DATA_DIR 解析路径。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function src(relative: string): string {
  return readFileSync(new URL(`../src/${relative}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

describe("数据目录归属清单", () => {
  const modules = [
    "trace.ts",
    "audit.ts",
    "fs-store.ts",
    "uploads.ts",
    "memory.ts",
    "mcp/config.ts",
    "mcp/tool-cache.ts",
    "mcp/provenance.ts",
    "rag/store.ts",
    "skills.ts",
    "eval-online.ts",
    "model-health.ts",
    "owner-alias.ts",
  ];

  it("单一真相：store-util 从 AGENT_DATA_DIR 解析 DATA_DIR", () => {
    expect(src("store-util.ts")).toContain("process.env.AGENT_DATA_DIR");
  });

  it.each(modules)("%s 引用 store-util 的 DATA_DIR", (relative) => {
    expect(src(relative)).toMatch(/import \{[^}]*\bDATA_DIR\b[^}]*\} from ".*store-util\.js";/);
  });
});
