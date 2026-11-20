import { afterEach, expect, test, vi } from "vitest";
import { execBuiltin } from "../src/builtins.js";
import { buildGroundedFallbackSystem, buildGroundingHint } from "../src/grounding.js";

const ENV_KEYS = ["WEB_SEARCH_PROVIDER", "WEB_SEARCH_BASE_URL", "WEB_SEARCH_API_KEY"];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) delete process.env[key];
});

function configure(): void {
  process.env.WEB_SEARCH_PROVIDER = "searxng";
  process.env.WEB_SEARCH_BASE_URL = "http://127.0.0.1:19999";
}

/** 零命中必须返回 ok:false，否则 chat.ts 会把它记成接地证据，护栏放行「网上没有该主体」。 */
test("公开检索零命中：无证据语义，文案不引导下「不存在」结论", async () => {
  configure();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })),
  );
  const out = await execBuiltin("web_search", JSON.stringify({ query: "一个绝对不存在的主体 xyzzy-404" }), "test-conv");
  expect(out?.ok).toBe(false);
  expect(out?.text).toMatch(/没有命中/);
  expect(out?.text).not.toMatch(/说明这个来源没有该结果/);
});

test("知识库零命中同样不算证据", async () => {
  configure();
  vi.stubGlobal("fetch", vi.fn()); // 不应走到联网；ragSearch 走本地 store
  const out = await execBuiltin("search_knowledge", JSON.stringify({ query: "绝对不存在的表 xyzzy-404" }), "test-conv");
  expect(out?.ok).toBe(false);
  expect(out?.text).toMatch(/没有命中/);
});

test("接地提示与兜底：有真实失败时允许如实说未查到，无失败时禁止谎称故障", () => {
  const withFailure = buildGroundingHint(true);
  expect(withFailure).toMatch(/取数确实失败过/);
  expect(withFailure).not.toMatch(/本轮并没有取数失败/);

  const noFailure = buildGroundingHint(false);
  expect(noFailure).toMatch(/本轮并没有取数失败/);

  const fallbackWith = buildGroundedFallbackSystem("助手", { hadFetchFailure: true });
  expect(fallbackWith).toMatch(/可以如实说明这次没有查到/);
  const fallbackWithout = buildGroundedFallbackSystem("助手", {});
  expect(fallbackWithout).toMatch(/不要提及工具、函数调用、数据源、连接状态/);
});
