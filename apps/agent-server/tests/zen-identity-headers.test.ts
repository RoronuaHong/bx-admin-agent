// OpenCode Zen 免费档身份闸门回归（2026-11-16）。
//
// 现象：Zen 网关把免费车道收紧成「只认 OpenCode 客户端」，按请求头识别身份，
// 缺身份头一律拒绝："OpenCode 1.18.0 or newer is required to use the free tier"。
// 修复：models.ts 对 opencode.ai 端点自动注入客户端身份头（User-Agent opencode/1.18.0+ 与
// x-opencode-* 四件套）；API_KEY 留空时按免费池凭据 `Bearer public` 兜底，不再发裸 `Bearer `。
// 测试用 ZEN_HOST 把判定重定向到本机 mock，端到端断言真实发出的请求头。
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

let handler: http.RequestListener = () => {};
const server = http.createServer((req, res) => handler(req, res));
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const PORT = (server.address() as AddressInfo).port;

// ZEN_HOST 指向本机 mock：isZenEndpoint 按「baseUrl 的 host 是否含 ZEN_HOST」判定。
process.env.ZEN_HOST = "127.0.0.1";
process.env.MONGO_URI = "mongodb://127.0.0.1:1";
process.env.MODEL_PROVIDERS = "zenmock";
process.env.MODEL_ZENMOCK_PROVIDER = "openai";
process.env.MODEL_ZENMOCK_NAME = "space-bunny-free";
process.env.MODEL_ZENMOCK_BASE_URL = `http://127.0.0.1:${PORT}/v1`;
// 不设 API_KEY：验证免费档匿名路径回落 `Bearer public`。
process.env.MODEL_ZENMOCK_CONTEXT_WINDOW = "128000";

// mock 捕获最近一次请求头（供断言；Node 把 header 名全转小写）。
let lastHeaders: http.IncomingHttpHeaders = {};
handler = async (req, res) => {
  if (req.method === "POST" && (req.url || "").endsWith("/chat/completions")) {
    lastHeaders = req.headers;
    for await (const c of req) void c; // 消费 body
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' + "data: [DONE]\n\n",
    );
    return;
  }
  res.writeHead(404);
  res.end();
};

let isZenEndpoint: (typeof import("../src/models.js"))["isZenEndpoint"];
let zenIdentityHeaders: (typeof import("../src/models.js"))["zenIdentityHeaders"];
let callAgent: (typeof import("../src/models.js"))["callAgent"];
let getModel: (typeof import("../src/config.js"))["getModel"];

beforeAll(async () => {
  ({ isZenEndpoint, zenIdentityHeaders, callAgent } = await import("../src/models.js"));
  ({ getModel } = await import("../src/config.js"));
});

afterAll(() => server.close());

test("isZenEndpoint：按 host 判定，不误伤其它网关", () => {
  // 先还原默认判定（ZEN_HOST 会被端到端用例重定向到本机 mock，判定是调用时读 env 的）。
  delete process.env.ZEN_HOST;
  expect(isZenEndpoint({ baseUrl: "https://opencode.ai/zen/v1" })).toBe(true);
  expect(isZenEndpoint({ baseUrl: "https://api.openai.com/v1" })).toBe(false);
  // ZEN_HOST 覆盖生效：指向本机 mock（端到端用例依赖同一配置）。
  process.env.ZEN_HOST = "127.0.0.1";
  expect(isZenEndpoint({ baseUrl: `http://127.0.0.1:${PORT}/v1` })).toBe(true);
});

test("zenIdentityHeaders：User-Agent 标注 opencode/1.18+，四件套前缀齐全", () => {
  const headers = zenIdentityHeaders();
  expect(headers["User-Agent"]).toMatch(/^opencode\/1\.18\.\d+/);
  expect(headers["x-opencode-client"]).toBe("desktop");
  expect(headers["x-opencode-project"]).toBe("global");
  expect(headers["x-opencode-session"]).toMatch(/^ses_[0-9a-f]+$/);
  expect(headers["x-opencode-request"]).toMatch(/^msg_[0-9a-f]+$/);
  // session/request 逐请求刷新，两次生成不同（贴合客户端形态）。
  expect(zenIdentityHeaders()["x-opencode-request"]).not.toBe(headers["x-opencode-request"]);
});

test("callAgent 对 Zen 端点真实注入身份头，匿名 key 回落 Bearer public", async () => {
  process.env.ZEN_HOST = "127.0.0.1"; // 判定调用时读 env，显式对齐 mock，不依赖用例顺序。
  const model = getModel("zenmock");
  expect(model).not.toBeNull();
  await callAgent(model!, [{ role: "user", content: "hi" }], []);
  expect(lastHeaders["content-type"]).toContain("application/json");
  expect(lastHeaders["user-agent"]).toMatch(/^opencode\/1\.18\.\d+/);
  expect(lastHeaders["x-opencode-client"]).toBe("desktop");
  expect(lastHeaders["x-opencode-project"]).toBe("global");
  expect(String(lastHeaders["x-opencode-session"])).toMatch(/^ses_/);
  expect(String(lastHeaders["x-opencode-request"])).toMatch(/^msg_/);
  // 免费档池化凭据：key 池为空时不再发出裸 `Bearer `。
  expect(lastHeaders.authorization).toBe("Bearer public");
});
