import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { countSecretHits, redactSecrets } from "../src/redact.js";
import { isAllowedMcpCommand } from "../src/mcp/config.js";
import { mcpChildEnv } from "../src/mcp/hub.js";
import { resolveMetabaseKey } from "../scripts/metabase-key.mjs";

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

  it("生产环境未配白名单时拒绝 stdio（开发环境仍放行）", () => {
    const prev = process.env.NODE_ENV;
    delete process.env.MCP_ALLOWED_COMMANDS;
    process.env.NODE_ENV = "production";
    expect(isAllowedMcpCommand("node")).toBe(false);
    expect(isAllowedMcpCommand("npx")).toBe(false);
    process.env.MCP_ALLOWED_COMMANDS = "node";
    expect(isAllowedMcpCommand("node")).toBe(true);
    expect(isAllowedMcpCommand("cmd")).toBe(false);
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  });

  it("stdio 启动前会查白名单和来源基线，拒绝记在连接错误上", () => {
    const src = readFileSync(new URL("../src/mcp/hub.ts", import.meta.url), "utf8");
    const gate = src.slice(src.indexOf("function transportRefusal"), src.indexOf("function buildTransport"));
    expect(gate).toContain("isAllowedMcpCommand");
    expect(gate).toContain("provenanceBlocked");
    const open = src.slice(src.indexOf("async function openConnection"), src.indexOf("export async function connect"));
    const tryAt = open.indexOf("try {");
    expect(tryAt).toBeGreaterThan(open.indexOf("conns.set"));
    expect(open.indexOf("buildTransport")).toBeGreaterThan(tryAt);
    expect(open.slice(tryAt, open.indexOf("stderr"))).toContain("conn.error");
  });
});

describe("MCP 子进程环境（不继承整份服务端环境）", () => {
  const snapshot = {
    MODEL_KEY: process.env.MODEL_KEY,
    BI_API_KEY: process.env.BI_API_KEY,
    PATH: process.env.PATH,
    MCP_ENV_PASSTHROUGH: process.env.MCP_ENV_PASSTHROUGH,
    CUSTOM_MCP_TOKEN: process.env.CUSTOM_MCP_TOKEN,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("留下 PATH 和 BI_ 前缀，丢掉无关密钥；cfg.env 可覆盖", () => {
    process.env.MODEL_KEY = "secret-model";
    process.env.BI_API_KEY = "bi-secret";
    process.env.MCP_ENV_PASSTHROUGH = "CUSTOM_MCP_TOKEN";
    process.env.CUSTOM_MCP_TOKEN = "named";
    const env = mcpChildEnv({ BI_API_KEY: "from-cfg" });
    expect(env.PATH || env.Path).toBeTruthy();
    expect(env.BI_API_KEY).toBe("from-cfg");
    expect(env.CUSTOM_MCP_TOKEN).toBe("named");
    expect(env.MODEL_KEY).toBeUndefined();
  });
});

describe("Metabase Key 不在生产回落管理员 Key", () => {
  it("开发环境没有只读 Key 时用 BI_API_KEY", () => {
    expect(resolveMetabaseKey({ BI_API_KEY: "admin", NODE_ENV: "development" })).toEqual({
      key: "admin",
      blocked: false,
    });
  });

  it("生产环境没有只读 Key 时拒绝", () => {
    expect(resolveMetabaseKey({ BI_API_KEY: "admin", NODE_ENV: "production" })).toEqual({
      key: "",
      blocked: true,
    });
  });

  it("有只读 Key 时生产也用只读 Key", () => {
    expect(
      resolveMetabaseKey({ BI_READONLY_API_KEY: "ro", BI_API_KEY: "admin", NODE_ENV: "production" }),
    ).toEqual({ key: "ro", blocked: false });
  });
});
