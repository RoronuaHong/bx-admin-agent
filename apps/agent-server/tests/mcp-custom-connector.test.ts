import { expect, test } from "vitest";

test("对话里添加的连接器只接受远程 http(s)，不能盖过系统自带", async () => {
  const prev = process.env.MCP_BUILTIN_SERVERS;
  process.env.MCP_BUILTIN_SERVERS = JSON.stringify([
    { id: "bi", label: "BI", transport: "http", url: "http://127.0.0.1/mcp", enabled: true },
  ]);
  try {
  const { buildCustomHttpConnector } = await import("../src/mcp/config.js");
  const ok = buildCustomHttpConnector({ id: "zz-flyout-docs", label: "文档", url: "https://example.com/mcp" });
  expect(ok.ok).toBe(true);
  if (ok.ok) {
    expect(ok.server.transport).toBe("http");
    expect(ok.server.headers).toBeUndefined();
  }
  expect(buildCustomHttpConnector({ id: "zz-flyout-file", label: "x", url: "file:///tmp/x" }).ok).toBe(false);
  expect(buildCustomHttpConnector({ id: "zz-flyout-auth", label: "x", url: "https://user:pass@example.com/mcp" }).ok).toBe(false);
  expect(buildCustomHttpConnector({ id: "bi", label: "x", url: "https://example.com/mcp" }).ok).toBe(false);
  const header = buildCustomHttpConnector({
    id: "zz-flyout-hdr",
    label: "带令牌",
    url: "https://example.com/mcp",
    headerName: "Authorization",
    headerValue: "Bearer secret",
  });
  expect(header.ok).toBe(true);
  if (header.ok) expect(header.server.headers?.Authorization).toBe("Bearer secret");
  } finally {
    if (prev === undefined) delete process.env.MCP_BUILTIN_SERVERS;
    else process.env.MCP_BUILTIN_SERVERS = prev;
  }
});
