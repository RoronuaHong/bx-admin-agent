import { afterEach, expect, test, vi } from "vitest";
import { checkFetchTarget, fetchPage, isBlockedIp } from "../src/web-search.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("IP 字面量：私网 / 本机 / v4 映射 / NAT64 / 未指定地址都拦", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "[::ffff:a9fe:a9fe]",
    "64:ff9b::a9fe:a9fe",
    "fd00::1",
    "fe80::1%eth0",
  ]) {
    expect(isBlockedIp(ip), ip).toBe(true);
  }
  for (const ip of ["8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    expect(isBlockedIp(ip), ip).toBe(false);
  }
});

test("公网域名解析到内网地址 → 拒绝", async () => {
  const lookup = async () => ["127.0.0.1"];
  expect(await checkFetchTarget(new URL("http://127.0.0.1.nip.io/"), lookup)).toMatch(/私网/);
  expect(await checkFetchTarget(new URL("http://example.com/"), async () => ["93.184.216.34", "10.0.0.5"])).toMatch(/私网/);
  expect(await checkFetchTarget(new URL("http://example.com/"), async () => ["93.184.216.34"])).toBeNull();
});

test("302 跳到内网：逐跳复检，不跟随", async () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }));
  vi.stubGlobal("fetch", fetchMock);
  const out = await fetchPage("http://example.com/", { lookup: async () => ["93.184.216.34"] });
  expect(out.ok).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe("manual");
});

test("正常重定向到公网仍能抓到正文", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "/final" } }))
    .mockResolvedValueOnce(new Response("<title>T</title><p>hello</p>", { status: 200, headers: { "content-type": "text/html" } }));
  vi.stubGlobal("fetch", fetchMock);
  const out = await fetchPage("http://example.com/start", { lookup: async () => ["93.184.216.34"] });
  expect(out.ok).toBe(true);
  expect(fetchMock.mock.calls[1]![0]).toBe("http://example.com/final");
});
