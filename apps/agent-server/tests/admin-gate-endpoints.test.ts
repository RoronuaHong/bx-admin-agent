// 配置令牌端点补测：全局管理中间件的无/错/正确令牌，以及 /health 探活豁免。
import { beforeAll, expect, test } from "vitest";

process.env.AGENT_ADMIN_TOKEN = "endpoint-admin-token";

let app: ReturnType<(typeof import("../src/app.js"))["createApp"]>;
beforeAll(async () => {
  app = (await import("../src/app.js")).createApp();
});

const headers = (token?: string) => ({
  "content-type": "application/json",
  ...(token ? { "x-admin-token": token } : {}),
});

test("/health 探活不需要令牌（原行为不变）", async () => {
  expect((await app.request("/health")).status).toBe(200);
});

test("/mcp/servers：缺失 / 错误 401，正确令牌 200", async () => {
  const missing = await app.request("/mcp/servers", { headers: headers() });
  expect(missing.status).toBe(401);
  expect(((await missing.json()) as { code?: string }).code).toBe("ADMIN_TOKEN_REQUIRED");

  const wrong = await app.request("/mcp/servers", { headers: headers("bad-token") });
  expect(wrong.status).toBe(401);
  expect(((await wrong.json()) as { code?: string }).code).toBe("ADMIN_TOKEN_INVALID");

  expect((await app.request("/mcp/servers", { headers: headers("endpoint-admin-token") })).status).toBe(200);
});

test("/notify/channels 写端点同样被全局令牌闸门覆盖", async () => {
  const body = JSON.stringify({ id: "gate_probe", kind: "webhook", url: "https://example.com/hook" });
  const missing = await app.request("/notify/channels", { method: "POST", headers: headers(), body });
  expect(missing.status).toBe(401);
  const wrong = await app.request("/notify/channels", { method: "POST", headers: headers("bad-token"), body });
  expect(wrong.status).toBe(401);
});
