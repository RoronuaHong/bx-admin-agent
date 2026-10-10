// tools/dingtalk-doc.ts 的单元测试：覆盖 fail-soft 与检索解析两条主路径。
// 设计对齐最佳实践：凭证缺失/鉴权失败不得抛错中断对话；正常检索须正确解析列表。
// 通过 vi.resetModules + 动态 import 让每次测试在「设定好 env 后」重新求值模块级常量。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const clearEnv = () => {
  delete process.env.DINGTALK_CLIENT_ID;
  delete process.env.DINGTALK_CLIENT_SECRET;
  delete process.env.DINGTALK_DOC_BASE_URL;
  delete process.env.DINGTALK_DOC_SEARCH_URL;
};

beforeEach(() => {
  vi.resetModules();
  clearEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearEnv();
});

describe("tools/dingtalk-doc searchDingtalkDoc", () => {
  it("凭证未配置时返回配置指引（fail-soft，不抛错）", async () => {
    const { searchDingtalkDoc } = await import("../src/tools/dingtalk-doc.js");
    const r = await searchDingtalkDoc("季度规划");
    expect(r.ok).toBe(false);
    expect(r.text).toContain("未配置");
  });

  it("凭证齐全但未设置搜索地址时不发请求", async () => {
    process.env.DINGTALK_CLIENT_ID = "appkey";
    process.env.DINGTALK_CLIENT_SECRET = "appsecret";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { searchDingtalkDoc } = await import("../src/tools/dingtalk-doc.js");
    const r = await searchDingtalkDoc("季度规划");
    expect(r.ok).toBe(false);
    expect(r.text).toContain("未联调");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("凭证存在但获取 token 失败时返回鉴权失败提示（仍 ok:false，不抛错）", async () => {
    process.env.DINGTALK_CLIENT_ID = "appkey";
    process.env.DINGTALK_CLIENT_SECRET = "appsecret";
    process.env.DINGTALK_DOC_SEARCH_URL = "https://example.test/search";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ errcode: 1, errmsg: "invalid" }),
      })),
    );
    const { searchDingtalkDoc } = await import("../src/tools/dingtalk-doc.js");
    const r = await searchDingtalkDoc("季度规划");
    expect(r.ok).toBe(false);
    expect(r.text).toContain("鉴权失败");
  });

  it("token 正常且检索返回列表时解析为带标题/链接/摘要的文本", async () => {
    process.env.DINGTALK_CLIENT_ID = "appkey";
    process.env.DINGTALK_CLIENT_SECRET = "appsecret";
    process.env.DINGTALK_DOC_SEARCH_URL = "https://example.test/search";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("gettoken")) {
          return { ok: true, json: async () => ({ access_token: "tok" }) };
        }
        return {
          ok: true,
          json: async () => ({
            list: [{ title: "规划A", url: "https://doc/a", snippet: "摘要" }],
          }),
        };
      }),
    );
    const { searchDingtalkDoc } = await import("../src/tools/dingtalk-doc.js");
    const r = await searchDingtalkDoc("季度", 3);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("规划A");
    expect(r.text).toContain("https://doc/a");
    expect(r.text).toContain("摘要");
  });

  it("检索返回空列表时如实说明未找到（ok:true）", async () => {
    process.env.DINGTALK_CLIENT_ID = "appkey";
    process.env.DINGTALK_CLIENT_SECRET = "appsecret";
    process.env.DINGTALK_DOC_SEARCH_URL = "https://example.test/search";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("gettoken")) {
          return { ok: true, json: async () => ({ access_token: "tok" }) };
        }
        return { ok: true, json: async () => ({ list: [] }) };
      }),
    );
    const { searchDingtalkDoc } = await import("../src/tools/dingtalk-doc.js");
    const r = await searchDingtalkDoc("不存在的内容");
    expect(r.ok).toBe(true);
    expect(r.text).toContain("未找到");
  });
});
