// P0 FK 人工核查清单的结构回归：防止手工录入漏边、计数漂移、待决策项缺根因/缺决策提示。
// 这是数据夹具的一致性测试，不代表业务签字——签字仍需真人（见清单 signoffInstructions）。
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Signoff = { reviewer: string | null; decision: string | null; at: string | null };
type Edge = {
  id: number;
  edge: string;
  status: "VERIFIED" | "NEEDS_DECISION" | "OUT_OF_SCOPE";
  evidence: string;
  rootCause: string | null;
  decisionPrompt: string | null;
  signoff: Signoff;
};
type Checklist = {
  status: string;
  summary: { total: number; verified: number; needsDecision: number; outOfScope: number };
  rootCauseLegend: Record<string, string>;
  edges: Edge[];
  signoffInstructions: string;
};

const data: Checklist = JSON.parse(
  readFileSync(fileURLToPath(new URL("./bi-fk-signoff.json", import.meta.url)), "utf8"),
);

test("18 条边齐全、id 1..18 连续无重复、每条都有边定义与证据", () => {
  expect(data.edges).toHaveLength(18);
  expect(data.edges.map((e) => e.id)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
  for (const e of data.edges) {
    expect(e.edge, `edge #${e.id} 缺边定义`).toContain("→");
    expect(e.evidence.length, `edge #${e.id} 缺证据`).toBeGreaterThan(0);
  }
});

test("summary 计数与实际 status 统计一致（11 可信 / 6 待决策 / 1 越权）", () => {
  const count = (s: Edge["status"]) => data.edges.filter((e) => e.status === s).length;
  expect(data.summary).toEqual({
    total: 18,
    verified: count("VERIFIED"),
    needsDecision: count("NEEDS_DECISION"),
    outOfScope: count("OUT_OF_SCOPE"),
  });
  expect(count("VERIFIED")).toBe(11);
  expect(count("NEEDS_DECISION")).toBe(6);
  expect(count("OUT_OF_SCOPE")).toBe(1);
});

test("6 条待决策 + 1 条越权都有合法根因与具体决策提示", () => {
  const needs = data.edges.filter((e) => e.status !== "VERIFIED");
  expect(needs).toHaveLength(7);
  for (const e of needs) {
    expect(e.rootCause, `edge #${e.id} 缺根因`).toBeTruthy();
    expect(Object.keys(data.rootCauseLegend), `edge #${e.id} 根因未在 legend 登记`).toContain(e.rootCause);
    expect(e.decisionPrompt?.length, `edge #${e.id} 缺决策提示`).toBeGreaterThan(10);
  }
  // 根因分布：3 死字段 + 2 父表空 + 1 自引用悬空 + 1 越权
  const byCause = needs.reduce<Record<string, number>>((acc, e) => {
    acc[e.rootCause!] = (acc[e.rootCause!] || 0) + 1;
    return acc;
  }, {});
  expect(byCause).toEqual({
    DEAD_FK_COLUMN: 3,
    EMPTY_PARENT_TABLE: 2,
    DANGLING_SELF_REF: 1,
    PERMISSION_OUT_OF_SCOPE: 1,
  });
});

test("VERIFIED 边不带根因与决策提示，避免误导签字人", () => {
  for (const e of data.edges.filter((x) => x.status === "VERIFIED")) {
    expect(e.rootCause).toBeNull();
    expect(e.decisionPrompt).toBeNull();
  }
});

test("顶层状态为待人工签字，且每条边的签字栏均为空（尚未冒充签字）", () => {
  expect(data.status).toBe("PENDING_HUMAN_SIGNOFF");
  expect(data.signoffInstructions).toContain("业务正确性由签字人负责");
  for (const e of data.edges) {
    expect(e.signoff).toEqual({ reviewer: null, decision: null, at: null });
  }
});
