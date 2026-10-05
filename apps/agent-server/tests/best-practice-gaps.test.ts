import { afterEach, describe, expect, it } from "vitest";
import { countSecretHits, redactSecrets } from "../src/redact.js";
import { isAllowedMcpCommand } from "../src/mcp/config.js";

/**
 * 对齐最佳实践补齐项的回归：
 * - redactSecrets：OWASP ASI05 / LLM06（数据泄露 / 敏感信息暴露）的出站打码
 * - isAllowedMcpCommand：OWASP ASI06（供应链）的 stdio 命令白名单
 */
describe("出站密钥脱敏（ASI05 / LLM06）", () => {
  it("打码已知凭据形态", () => {
    expect(redactSecrets("key is sk-abcdefghijklmnopqrstuv")).toContain("[REDACTED:OPENAI_KEY]");
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toContain("[REDACTED:AWS_ACCESS_KEY]");
    expect(redactSecrets("token glpat-abcdefghijklmnop1234")).toContain("[REDACTED:GITLAB_TOKEN]");
    expect(redactSecrets("ghp_abcdefghijklmnop123456")).toContain("[REDACTED:GITHUB_TOKEN]");
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnop123456")).toContain("[REDACTED:BEARER]");
  });

  it("PEM 私钥整块替换，不残留密钥主体", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBALK\n-----END RSA PRIVATE KEY-----";
    const out = redactSecrets(pem);
    expect(out).toBe("[REDACTED:PRIVATE_KEY]");
  });

  it("不误伤正常业务文本", () => {
    for (const t of ["用户列表共 20 条", "订单号 A20261005001", "sk 不是密钥", "价格 12.50 元"]) {
      expect(redactSecrets(t), t).toBe(t);
      expect(countSecretHits(t), t).toBe(0);
    }
  });

  it("countSecretHits 与实际打码一致", () => {
    const text = "a=sk-abcdefghijklmnopqrstuv b=AKIAIOSFODNN7EXAMPLE";
    expect(countSecretHits(text)).toBe(2);
    expect(redactSecrets(text)).not.toContain("sk-abcdefghijklmnopqrstuv");
  });
});

describe("MCP stdio 命令白名单（ASI06 供应链）", () => {
  afterEach(() => {
    delete process.env.MCP_ALLOWED_COMMANDS;
  });

  it("未配白名单时恒等放行（向后兼容，不改变现状）", () => {
    delete process.env.MCP_ALLOWED_COMMANDS;
    expect(isAllowedMcpCommand("npx")).toBe(true);
    expect(isAllowedMcpCommand("anything-goes")).toBe(true);
    expect(isAllowedMcpCommand("")).toBe(true); // 未启用时不做空值拦截
  });

  it("配了白名单后只放行名单内命令（fail-closed）", () => {
    process.env.MCP_ALLOWED_COMMANDS = "npx, node";
    expect(isAllowedMcpCommand("npx")).toBe(true);
    expect(isAllowedMcpCommand("node")).toBe(true);
    expect(isAllowedMcpCommand("cmd")).toBe(false);
    expect(isAllowedMcpCommand("powershell")).toBe(false);
  });

  it("同时认完整路径与可执行名", () => {
    process.env.MCP_ALLOWED_COMMANDS = "npx";
    expect(isAllowedMcpCommand("/usr/bin/npx")).toBe(true);
    expect(isAllowedMcpCommand("C:\\Program Files\\nodejs\\npx.cmd")).toBe(false); // 反斜杠归一后 basename=npx.cmd ≠ npx
    expect(isAllowedMcpCommand("C:/Program Files/nodejs/npx.cmd")).toBe(false);
  });

  it("启用白名单后空命令被拒", () => {
    process.env.MCP_ALLOWED_COMMANDS = "npx";
    expect(isAllowedMcpCommand("")).toBe(false);
  });
});
