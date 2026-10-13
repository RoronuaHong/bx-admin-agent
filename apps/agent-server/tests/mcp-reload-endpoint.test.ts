import { afterEach, beforeEach, expect, test, vi } from "vitest";

// 只替换 reload：其余 hub 能力保持真实实现，listStatuses 等照常工作。
vi.mock("../src/mcp/hub.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mcp/hub.js")>();
  return { ...actual, reload: vi.fn() };
});

const { reload } = await import("../src/mcp/hub.js");
const { createApp } = await import("../src/app.js");

const reloadMock = vi.mocked(reload);

beforeEach(() => {
  reloadMock.mockReset();
});

afterEach(() => {
  reloadMock.mockReset();
});

test("重连处理器：未知 id → 404；reload 抛异常 → 502 明确错误码（不是裸 500）", async () => {
  const app = createApp();

  reloadMock.mockResolvedValueOnce(null);
  const notFound = await app.request("/chat/mcp/servers/zz-no-such-server/reload", { method: "POST" });
  expect(notFound.status).toBe(404);

  reloadMock.mockRejectedValueOnce(new Error("config read race"));
  const failed = await app.request("/chat/mcp/servers/zz-broken/reload", { method: "POST" });
  expect(failed.status).toBe(502);
  const body = (await failed.json()) as { error?: { code?: string } };
  expect(body.error?.code).toBe("MCP_RELOAD_FAILED");

  // 连接失败但 reload 正常返回（带 error 的状态）→ 200，由前端按状态展示。
  reloadMock.mockResolvedValueOnce({
    id: "zz-broken",
    label: "zz",
    transport: "stdio",
    enabled: true,
    connected: false,
    error: "MCP error -32000: Connection closed",
    tools: 0,
    toolNames: [],
  });
  const soft = await app.request("/chat/mcp/servers/zz-broken/reload", { method: "POST" });
  expect(soft.status).toBe(200);
  const softBody = (await soft.json()) as { status?: { connected?: boolean; error?: string } };
  expect(softBody.status?.connected).toBe(false);
  expect(softBody.status?.error).toContain("Connection closed");
});
