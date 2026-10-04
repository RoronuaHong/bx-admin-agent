import { describe, expect, it } from "vitest";
import { checkAdminToken } from "../src/admin-gate.js";

/**
 * 全局配置端点（MCP 服务器管理 / 通知通道）的准入。
 * 未配置令牌必须放行——否则每次部署到只听本机的单机环境都会先把自己的配置接口锁死。
 */
describe("管理端点令牌校验", () => {
  it("未配置令牌时一律放行（保持单机原行为）", () => {
    expect(checkAdminToken({ token: undefined, provided: undefined }).ok).toBe(true);
    expect(checkAdminToken({ token: "", provided: "anything" }).ok).toBe(true);
    expect(checkAdminToken({ token: "   ", provided: "anything" }).ok).toBe(true);
  });

  it("配置了令牌后：缺失拒绝、错误拒绝、正确放行", () => {
    expect(checkAdminToken({ token: "secret-token", provided: null })).toEqual({ ok: false, reason: "missing" });
    expect(checkAdminToken({ token: "secret-token", provided: "" })).toEqual({ ok: false, reason: "missing" });
    expect(checkAdminToken({ token: "secret-token", provided: "secret-toke" })).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(checkAdminToken({ token: "secret-token", provided: "Secret-token" })).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(checkAdminToken({ token: "secret-token", provided: "secret-token" }).ok).toBe(true);
    // 前后空白属于「手抄进来」的常见污染，容忍一次，别让用户以为令牌错了
    expect(checkAdminToken({ token: "secret-token", provided: "  secret-token  " }).ok).toBe(true);
  });

  it("拒绝时不因长度不同提前返回（定长比较）", () => {
    const long = "x".repeat(64);
    expect(checkAdminToken({ token: long, provided: long.slice(0, 63) })).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(checkAdminToken({ token: long, provided: long }).ok).toBe(true);
  });
});
