import { describe, expect, it } from "vitest";
import { autonomyFromSummary } from "../src/autonomy.js";
import type { EvalSummary } from "../src/eval-online.js";
import { checkProvenanceRecords, provenanceDigest, scriptFileDigests } from "../src/mcp/provenance.js";
import type { ProvenanceRecord } from "../src/mcp/provenance.js";

/** P2 补齐项：渐进式自主（ASI08）+ MCP 来源漂移检测（ASI06）。 */

function summary(over: Partial<EvalSummary>): EvalSummary {
  return {
    runs: 10,
    avgScore: 1,
    good: 10,
    degraded: 0,
    poor: 0,
    axisFailures: [],
    qualityDegraded: false,
    ...over,
  };
}

describe("渐进式自主分级（只向下收紧）", () => {
  it("样本不足 → 默认自主度（冷启动既不奖励也不惩罚）", () => {
    const s = autonomyFromSummary(summary({ runs: 3, good: 0, poor: 3 }), 14);
    expect(s.level).toBe(2);
    expect(s.maxRounds).toBe(14);
    expect(s.reason).toContain("样本不足");
  });

  it("劣质占比高 → 降为受限（轮次预算收到 4）", () => {
    const s = autonomyFromSummary(summary({ good: 3, degraded: 3, poor: 5 }), 14);
    expect(s.level).toBe(0);
    expect(s.maxRounds).toBe(4);
  });

  it("劣质占比中等 → 谨慎（收到 8）", () => {
    const s = autonomyFromSummary(summary({ good: 6, degraded: 3, poor: 1 }), 14);
    expect(s.level).toBe(1);
    expect(s.maxRounds).toBe(8);
  });

  it("质量正常 → 不收紧", () => {
    const s = autonomyFromSummary(summary({}), 14);
    expect(s.level).toBe(2);
    expect(s.maxRounds).toBe(14);
  });

  it("**永不**因为表现好而放大预算（不会超过 baseRounds）", () => {
    for (const good of [10, 100, 1000]) {
      const s = autonomyFromSummary(summary({ runs: 10, good }), 14);
      expect(s.maxRounds).toBeLessThanOrEqual(14);
      expect(s.level).toBe(2);
    }
  });
});

describe("MCP 来源漂移检测（纯函数）", () => {
  it("指纹稳定，且随 command / args / cwd 变化", () => {
    const base = provenanceDigest({ command: "npx", args: ["-y", "mcp"] });
    expect(base).toBe(provenanceDigest({ command: "npx", args: ["-y", "mcp"] }));
    expect(base).not.toBe(provenanceDigest({ command: "node", args: ["-y", "mcp"] }));
    expect(base).not.toBe(provenanceDigest({ command: "npx", args: ["-y", "other"] }));
  });

  it("首次出现记为 new（没有基线不算漂移）", () => {
    const checks = checkProvenanceRecords(
      [{ id: "a", label: "a", transport: "stdio", enabled: true, command: "npx" }],
      {},
    );
    expect(checks[0]!.status).toBe("new");
    expect(checks[0]!.previousDigest).toBeUndefined();
  });

  it("形态一致 → unchanged；被改 → changed（保留旧指纹供比对）", () => {
    const cfg = { id: "a", label: "a", transport: "stdio" as const, enabled: true, command: "npx", args: ["x"] };
    const rec: ProvenanceRecord = {
      id: "a",
      digest: provenanceDigest(cfg),
      command: "npx",
      args: ["x"],
      firstSeenAt: 1,
      lastSeenAt: 1,
    };
    expect(checkProvenanceRecords([cfg], { a: rec })[0]!.status).toBe("unchanged");
    const changed = checkProvenanceRecords([{ ...cfg, args: ["y"] }], { a: rec })[0]!;
    expect(changed.status).toBe("changed");
    expect(changed.previousDigest).toBe(rec.digest);
  });

  it("旧基线只有命令形态时，补记脚本哈希不算漂移", () => {
    const cfg = { id: "a", label: "a", transport: "stdio" as const, enabled: true, command: "node", args: ["scripts/x.mjs"] };
    const rec: ProvenanceRecord = {
      id: "a",
      digest: provenanceDigest(cfg),
      command: "node",
      args: ["scripts/x.mjs"],
      firstSeenAt: 1,
      lastSeenAt: 1,
    };
    const check = checkProvenanceRecords([cfg], { a: rec }, { a: { "scripts/x.mjs": "abc" } })[0]!;
    expect(check.status).toBe("unchanged");
    expect(check.scriptDrift).toBeUndefined();
  });

  it("命令没变、脚本内容变了 → scriptDrift", () => {
    const cfg = { id: "a", label: "a", transport: "stdio" as const, enabled: true, command: "node", args: ["scripts/x.mjs"] };
    const scripts = { "scripts/x.mjs": "abc" };
    const rec: ProvenanceRecord = {
      id: "a",
      digest: provenanceDigest(cfg, scripts),
      shape: provenanceDigest(cfg),
      scripts,
      command: "node",
      args: ["scripts/x.mjs"],
      firstSeenAt: 1,
      lastSeenAt: 1,
    };
    const check = checkProvenanceRecords([cfg], { a: rec }, { a: { "scripts/x.mjs": "def" } })[0]!;
    expect(check.status).toBe("changed");
    expect(check.scriptDrift).toBe(true);
  });

  it("HTTP 地址和请求头进指纹；旧基线补记地址不算漂移；换地址算漂移", () => {
    const cfg = {
      id: "movie",
      label: "movie",
      transport: "http" as const,
      enabled: true,
      url: "https://mcp.example/a",
      headers: { Authorization: "Bearer super-secret" },
    };
    const legacy = provenanceDigest(cfg, undefined, false);
    const current = provenanceDigest(cfg);
    expect(current).not.toBe(legacy);
    expect(current).not.toContain("super-secret");
    expect(provenanceDigest({ ...cfg, headers: { Authorization: "Bearer other" } })).not.toBe(current);
    const rec: ProvenanceRecord = {
      id: "movie",
      digest: legacy,
      command: "",
      args: [],
      firstSeenAt: 1,
      lastSeenAt: 1,
    };
    expect(checkProvenanceRecords([cfg], { movie: rec })[0]!.status).toBe("unchanged");
    const baselined: ProvenanceRecord = {
      ...rec,
      digest: provenanceDigest(cfg, {}),
      shape: current,
      scripts: {},
    };
    const swapped = checkProvenanceRecords([{ ...cfg, url: "https://evil.example/a" }], { movie: baselined })[0]!;
    expect(swapped.status).toBe("changed");
    expect(swapped.scriptDrift).toBeUndefined();
  });

  it("只哈希参数里的本地脚本，跳过开关和非脚本", () => {
    const files = scriptFileDigests(
      { args: ["-y", "not-a-file", "scripts/a.mjs"], cwd: "/app" },
      (abs) => (abs.endsWith("a.mjs") ? Buffer.from("body") : null),
    );
    expect(Object.keys(files)).toEqual(["scripts/a.mjs"]);
    expect(files["scripts/a.mjs"]).toHaveLength(64);
  });
});
