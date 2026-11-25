import { afterEach, expect, test, vi } from "vitest";
import { builtinToolSpecs } from "../src/builtins.js";
import { describeNetworkError, webSearch, webSearchStatus } from "../src/web-search.js";

const ENV_KEYS = ["WEB_SEARCH_PROVIDER", "WEB_SEARCH_BASE_URL", "WEB_SEARCH_API_KEY"];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) delete process.env[key];
});

function configure(): void {
  process.env.WEB_SEARCH_PROVIDER = "searxng";
  process.env.WEB_SEARCH_BASE_URL = "http://127.0.0.1:19999";
}

test("可用性只由配置决定：配置齐备即可用，与检索服务是否可达无关", () => {
  configure();
  expect(webSearchStatus().available).toBe(true);
  expect(builtinToolSpecs().some((spec) => spec.name === "web_search")).toBe(true);
  expect(builtinToolSpecs().some((spec) => spec.name === "fetch_url")).toBe(true);

  delete process.env.WEB_SEARCH_PROVIDER;
  expect(webSearchStatus().available).toBe(false);
  expect(builtinToolSpecs().some((spec) => spec.name === "web_search")).toBe(false);
});

test("服务连不上：工具仍在，失败由调用期如实上报（带真实网络原因）", async () => {
  configure();
  const fetchMock = vi.fn(async () => {
    throw Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error(""), { code: "ECONNREFUSED" }) });
  });
  vi.stubGlobal("fetch", fetchMock);

  const before = webSearchStatus();
  const out = await webSearch("人没有下车属于临时停放吗");
  const after = webSearchStatus();

  expect(out.ok).toBe(false);
  if (!out.ok) {
    expect(out.error).toMatch(/ECONNREFUSED/);
    expect(out.error).not.toBe("fetch failed");
  }
  // 调用失败不改变能力声明：下一轮对话里工具照样可用，模型不会误以为自己没有联网能力。
  expect(before.available).toBe(true);
  expect(after.available).toBe(true);
  expect(builtinToolSpecs().some((spec) => spec.name === "web_search")).toBe(true);
});

test("describeNetworkError 展开 cause，不把网络故障压成 fetch failed", () => {
  const refused = Object.assign(new Error("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8888"), { code: "ECONNREFUSED" }),
  });
  expect(describeNetworkError(refused)).toMatch(/ECONNREFUSED.*检索服务未启动/);
  // 服务没起是确定性故障：明确告诉模型别换关键词重试（系统提示的「换说法再试」只适用于零命中/超时）。
  expect(describeNetworkError(refused)).toMatch(/重试不会成功/);

  const dns = Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error(""), { code: "ENOTFOUND" }) });
  expect(describeNetworkError(dns)).toMatch(/ENOTFOUND.*域名解析失败/);

  // undici 的实际超时文案是 "The operation timed out."，不是 timeout
  const undiciTimeout = Object.assign(new Error("fetch failed"), {
    cause: new Error("The operation timed out."),
  });
  expect(describeNetworkError(undiciTimeout)).toMatch(/timed out.*检索服务无响应/);

  expect(describeNetworkError(new Error("普通错误"))).toBe("普通错误");
});
