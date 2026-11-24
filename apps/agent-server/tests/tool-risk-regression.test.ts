// T-7 / A-3 回归：MCP 工具原名含 __、非法字符折叠、_2 冲突后缀仍命中工具级风险声明。
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stub = vi.hoisted(() => ({ facts: {} as Record<string, unknown> }));
vi.mock("../src/mcp/hub.js", () => ({
  describeMcpTool: (name: string) => stub.facts[name] ?? null,
}));
import { resolveToolRisk } from "../src/risk.js";

beforeEach(() => {
  stub.facts = {};
});

describe("MCP 工具名解析回归", () => {
  it("原工具名含 __ 时按 serverId 精确切前缀，toolRisks 命中 destructive", () => {
    stub.facts["mcp__bi__run__query"] = { serverId: "bi", toolRisks: { "run__query": "destructive" } };
    const verdict = resolveToolRisk("mcp__bi__run__query");
    expect(verdict.level).toBe("destructive");
    expect(verdict.source).toBe("tool-config");
    expect(verdict.unknown).toBe(false);
    expect(verdict.serverId).toBe("bi");
  });

  it("非法字符折叠后的名字与 _2 冲突后缀都按裸名命中声明", () => {
    stub.facts["mcp__svc__drop_table"] = { serverId: "svc", toolRisks: { drop_table: "destructive" } };
    stub.facts["mcp__svc__tool_2"] = { serverId: "svc", toolRisks: { tool_2: "destructive" } };
    expect(resolveToolRisk("mcp__svc__drop_table").level).toBe("destructive");
    expect(resolveToolRisk("mcp__svc__tool_2").level).toBe("destructive");
  });

  it("编码函数保留折叠与序号后缀逻辑（不改实现，只锁现状）", () => {
    const hub = readFileSync(new URL("../src/mcp/hub.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(hub).toContain('tool.replace(/[^A-Za-z0-9_-]/g, "_")');
    expect(hub).toContain("let n = 2;");
    expect(hub).toContain("while (used.has(name)) name = `${base}_${n++}`.slice(0, 64);");
  });
});
