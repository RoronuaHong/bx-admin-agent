// 让 case fixture 真正"承重"，而不是变成没人引用的死文档。
//
// 为什么需要这一层：仓库里已有一个反面样本——`stall-incident-cases.json` 写了 10 个 case、
// 每条都有 assertions，但**全仓零代码引用**，只有文档提到它。这类 fixture 的断言不会随代码
// 退化而失败，等于没有回归价值。
//
// 本文件对 `text2sql-bi-cases.json` 补三道门禁：
//   ① schema 完整（字段缺失立刻红）；
//   ② **绑定真实存在**——每个 case 的 boundTests 里指的测试名必须在对应文件里真实存在；
//      有人删了/改名了那条测试，这里立刻红（这是 fixture 不腐化的关键）；
//   ③ **零业务词自检**——fixture 自己声明了脱敏 policy，就自己执行它。
import { test, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("./fixtures/text2sql-bi-cases.json", import.meta.url));

interface BoundTest {
  file: string;
  test: string;
}
interface Case {
  id: string;
  tier: string;
  title: string;
  shape: string;
  inject: string[];
  expectedBehavior: string[];
  assertions: string[];
  regression: string;
  boundTests: BoundTest[];
}
interface Fixture {
  version: number;
  meta: Record<string, string>;
  observedShape: Record<string, unknown>;
  cases: Case[];
}

const fixture = JSON.parse(readFileSync(FIXTURE, "utf-8")) as Fixture;
// fixture 里的 file 沿用仓库文档约定（`tests/…` = `apps/agent-server/tests/…`，见 docs/README 路径约定），
// 因此基准是本目录的上一级 = apps/agent-server/。
const repoFile = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

test("[A] fixture schema 完整、case 字段齐全", () => {
  expect(fixture.version).toBe(1);
  expect(fixture.meta.doc, "必须指向权威文档").toBeTruthy();
  expect(fixture.meta.redaction, "必须声明脱敏口径").toBeTruthy();
  expect(Array.isArray(fixture.cases)).toBe(true);
  expect(fixture.cases.length, "至少覆盖本轮实测发现的几类").toBeGreaterThanOrEqual(5);
  for (const c of fixture.cases) {
    expect(c.id, "缺 id").toBeTruthy();
    expect(["L0", "L1", "L2", "L3"]).toContain(c.tier);
    expect(c.title.length, `${c.id} 缺 title`).toBeGreaterThan(4);
    expect(c.shape.length, `${c.id} 缺 shape`).toBeGreaterThan(4);
    expect(c.inject.length, `${c.id} 缺 inject`).toBeGreaterThan(0);
    expect(c.expectedBehavior.length, `${c.id} 缺 expectedBehavior`).toBeGreaterThan(0);
    expect(c.assertions.length, `${c.id} 缺 assertions`).toBeGreaterThan(0);
    expect(c.regression.length, `${c.id} 缺 regression（必须说明它对应哪次实测）`).toBeGreaterThan(0);
  }
});

test("[B] 每个 case 都绑定了真实存在的测试（fixture 不腐化的关键）", () => {
  const missing: string[] = [];
  for (const c of fixture.cases) {
    // 没有任何 case 可以零绑定——零绑定就退化成死文档
    expect(c.boundTests.length, `${c.id} 没有绑定任何测试，会退化成死文档`).toBeGreaterThan(0);
    for (const b of c.boundTests) {
      const abs = repoFile(b.file);
      if (!existsSync(abs)) {
        missing.push(`${c.id} → 文件不存在：${b.file}`);
        continue;
      }
      const src = readFileSync(abs, "utf-8");
      // 测试名以 test("<name>" 形式出现；只比对名字主体，避免引号/转义差异误判
      const probe = b.test.replace(/^\[|\]$/g, "");
      if (!src.includes(probe)) missing.push(`${c.id} → 测试不存在：${b.file} :: ${b.test}`);
    }
  }
  expect(missing, `以下绑定指向的测试不存在（fixture 已腐化，必须同步修复）：\n${missing.join("\n")}`).toEqual([]);
});

test("[C] 零业务词自检：fixture 执行自己声明的脱敏口径", () => {
  const raw = readFileSync(FIXTURE, "utf-8");
  // 与 tests/bi-tool-ergonomics.test.ts [K] 同款清单：国家线 / 指标 / 维度 / 归因目标
  for (const term of ["印度", "巴西", "日活", "会员", "渠道", "退订", "获客"]) {
    expect(raw, `fixture 混入业务词「${term}」`).not.toContain(term);
  }
  // 也不能出现真实表名/列名片段（脱敏 policy 明确要求）
  for (const term of ["film_report", "elt_", "guid", "vip"]) {
    expect(raw, `fixture 混入真实对象名片段「${term}」`).not.toContain(term);
  }
});

test("[D] 结构化基线字段与实测一致（防止文档漂移）", () => {
  const s = fixture.observedShape;
  expect(s.runs, "实测轮次").toBe(9);
  // 审计结论：三类真问题 + 正确性类 0 命中
  expect(s.modelSqlSample).toBe(30);
  expect(s.modelSqlNoWhere).toBe(14);
  expect(s.modelSqlGroupByNoLimit).toBe(7);
  expect(s.modelSqlCorrectnessClassHits, "正确性类判据在实测样本上 0 命中，属预防项").toBe(0);
  // 最坏一轮的读回比例确实是"接近全捞"
  expect(String(s.readBackRatioWorst)).toContain("48");
});

test("[E] 每个 case 的 regression 都要指向可追溯的实测，而不是空话", () => {
  for (const c of fixture.cases) {
    // 回归说明应含日期或轮次/计数，便于日后核对
    expect(
      /\d{4}-\d{2}-\d{2}|\d+\s*(次|轮|条)/.test(c.regression),
      `${c.id} 的 regression 缺少可追溯的实测锚点：${c.regression}`,
    ).toBe(true);
  }
});