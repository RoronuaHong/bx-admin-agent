import { expect, test } from "vitest";
import { mcpConnectionPlan, transientMcpListError } from "../src/mcp/hub.js";

test("工具清单超时要换连接；其它清单错误冷却过后才在原连接上重列", () => {
  const now = 1_000_000;
  expect(mcpConnectionPlan({ attemptedAt: now }, now)).toBe("ready");
  expect(mcpConnectionPlan({ attemptedAt: now, toolsError: "MCP error -32001: Request timed out" }, now)).toBe("cooldown");
  expect(
    mcpConnectionPlan({ attemptedAt: now - 31_000, toolsError: "MCP error -32001: Request timed out" }, now),
  ).toBe("reconnect");
  expect(
    mcpConnectionPlan({ attemptedAt: now - 31_000, toolsError: "MCP error -32000: bad request" }, now),
  ).toBe("retry-tools");
  expect(mcpConnectionPlan({ attemptedAt: now - 31_000, error: "connect failed" }, now)).toBe("reconnect");
  expect(
    mcpConnectionPlan({ attemptedAt: now - 31_000, toolsError: "Connection closed" }, now),
  ).toBe("reconnect");
  expect(transientMcpListError("MCP error -32001: Request timed out")).toBe(true);
  expect(transientMcpListError("unknown tool")).toBe(false);
});
