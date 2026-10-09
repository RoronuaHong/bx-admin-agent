import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  catalogPlan,
  MCP_TOOL_CACHE_FRESH_MS,
  readMcpToolCache,
  usableCachedTools,
  writeMcpToolCache,
} from "../src/mcp/tool-cache.js";

test("白名单里的工具都在缓存中才能用；缺一个就不用", () => {
  const cached = [
    { name: "ZohoSalesIQ_getConversationsList", description: "list" },
    { name: "ZohoSalesIQ_getPortals" },
  ];
  expect(usableCachedTools(cached, ["ZohoSalesIQ_getConversationsList"])?.map((tool) => tool.name)).toEqual([
    "ZohoSalesIQ_getConversationsList",
  ]);
  expect(usableCachedTools(cached, ["ZohoSalesIQ_getConversationsList", "missing"])).toBeNull();
  expect(usableCachedTools(cached)?.map((tool) => tool.name)).toEqual([
    "ZohoSalesIQ_getConversationsList",
    "ZohoSalesIQ_getPortals",
  ]);
});

test("一天内的缓存直接用；过期或强制刷新才再列", () => {
  const now = 1_000_000;
  expect(catalogPlan({ now, savedAt: now - 1000, hasUsableCache: true })).toBe("use-cache");
  expect(catalogPlan({ now, savedAt: now - MCP_TOOL_CACHE_FRESH_MS, hasUsableCache: true })).toBe("list");
  expect(catalogPlan({ now, savedAt: now - 1000, hasUsableCache: true, forceList: true })).toBe("list");
  expect(catalogPlan({ now, hasUsableCache: false })).toBe("list");
});

test("工具清单按服务器写入后再读回", () => {
  const file = join(mkdtempSync(join(tmpdir(), "mcp-cache-")), "cache.json");
  writeMcpToolCache("zoho-salesiq", [{ name: "ZohoSalesIQ_getConversationsList", description: "会话" }], file, 50);
  writeMcpToolCache("other", [{ name: "ping" }], file, 60);
  expect(readMcpToolCache("zoho-salesiq", file)).toEqual({
    savedAt: 50,
    tools: [{ name: "ZohoSalesIQ_getConversationsList", description: "会话" }],
  });
  expect(readMcpToolCache("missing", file)).toBeNull();
});
