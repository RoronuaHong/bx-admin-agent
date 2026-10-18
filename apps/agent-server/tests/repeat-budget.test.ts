// 同工具重复调用预算（第 2 批 P1-2）。
//
// 事故形态：模型对同一个元数据工具调了 24 次，每次换对象/换字段 —— 参数全不相同，
// 于是既有的「参数全等才算重复」提示一次没触发，27 轮预算大半耗在重复探查上。
//
// 判据借两处思想：AWS 的**重试预算**（用占比而非绝对次数，阈值才与任务复杂度无关）、
// Fowler 的**比率必须配最小样本数**。只提示不硬拦（重复有时是正当的）。
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  repeatBudgetNotice,
  repeatBudgetStop,
  repeatEscalation,
  repeatEscalationStep,
  repeatStopNotice,
  forceSynthesisByToolCallTotal,
} from "../src/repeat-budget.js";

const base = { toolName: "toolA", priorCount: 0, totalOther: 0 };

test("单轮同工具超限即提示，并给出两条可执行的下一步", () => {
  const notice = repeatBudgetNotice({ ...base, perRoundCount: 4 });
  expect(notice).toContain("toolA");
  expect(notice).toContain("同一轮");
  // 提示必须给动作，而不是只说「重复了」
  expect(notice).toContain("如实说明");
  expect(notice).toContain("换");
});

test("单轮未超限不提示", () => {
  expect(repeatBudgetNotice({ ...base, perRoundCount: 3 })).toBeNull();
  expect(repeatBudgetNotice({ ...base, perRoundCount: 1 })).toBeNull();
});

test("占比超限即提示（跨轮累计靠同一个工具硬撑）", () => {
  // 累计 7 次 toolA、另有 4 次别的工具 = 占比 64% > 40%
  const notice = repeatBudgetNotice({ toolName: "toolA", perRoundCount: 1, priorCount: 6, totalOther: 4 });
  expect(notice).toContain("toolA");
  expect(notice).toContain("%");
});

test("样本不足时不算占比（避免 1 次调用就 100%）", () => {
  // 累计 2 次、样本 2 < minSamples 6
  expect(repeatBudgetNotice({ toolName: "toolA", perRoundCount: 1, priorCount: 1, totalOther: 0 })).toBeNull();
});

test("占比未超限不提示（工具分布均匀属正常）", () => {
  // 累计 3 次 toolA、另有 9 次别的 = 25% < 40%
  expect(repeatBudgetNotice({ toolName: "toolA", perRoundCount: 1, priorCount: 2, totalOther: 9 })).toBeNull();
});

test("阈值可注入（按部署调整，且便于单测钉边界）", () => {
  expect(repeatBudgetNotice({ ...base, perRoundCount: 2 }, { perRoundLimit: 2 })).toContain("同一轮");
  expect(repeatBudgetNotice({ toolName: "t", perRoundCount: 1, priorCount: 6, totalOther: 4 }, { shareLimit: 0.9 })).toBeNull();
});

/* ── 第 10 批：跨轮阶梯提醒 + 可选运行级重复上限 ──────────────────────────
 * 真实复跑（2026-10-15）暴露的洞：上面的提示「同一工具只提示一次」，
 * 于是「第 8 次被提醒过一次，之后又调了 24 次」——单工具累计 32 次、28 轮 / 83 次调用。
 */

test("阶梯值翻倍：未达首阶为 0，跨阶只认已跨过的最高台阶", () => {
  const o = { firstStep: 8, factor: 2 };
  expect(repeatEscalationStep(7, o)).toBe(0);
  expect(repeatEscalationStep(8, o)).toBe(8);
  expect(repeatEscalationStep(15, o)).toBe(8);
  expect(repeatEscalationStep(16, o)).toBe(16);
  expect(repeatEscalationStep(31, o)).toBe(16);
  expect(repeatEscalationStep(32, o)).toBe(32);
  expect(repeatEscalationStep(100, o)).toBe(64);
});

test("阶梯可注入（firstStep/factor 都不是写死常量）", () => {
  expect(repeatEscalationStep(3, { firstStep: 3, factor: 3 })).toBe(3);
  expect(repeatEscalationStep(9, { firstStep: 3, factor: 3 })).toBe(9);
  expect(repeatEscalationStep(10, { firstStep: 3, factor: 3 })).toBe(9);
});

test("首次提醒给两条出路；同一台阶不重复提醒；上台阶后文案加重", () => {
  const first = repeatEscalation({ toolName: "toolA", total: 8, notifiedStep: 0 }, { firstStep: 8 });
  expect(first.notice).toContain("toolA");
  expect(first.notice).toContain("二选一");
  expect(first.step).toBe(8);

  // 已提示到第 8 阶、累计仍是 12 → 不再提示（防刷屏）
  expect(repeatEscalation({ toolName: "toolA", total: 12, notifiedStep: 8 }, { firstStep: 8 }).notice).toBeNull();

  // 跨到第 16 阶 → 再提示一次，且明确「再次提醒」
  const again = repeatEscalation({ toolName: "toolA", total: 16, notifiedStep: 8 }, { firstStep: 8 });
  expect(again.notice).toContain("再次提醒");
  expect(again.step).toBe(16);
});

test("运行级重复上限默认关（重复有时是正当的，不硬拦）", () => {
  expect(repeatBudgetStop(32)).toBe(false);
  expect(repeatBudgetStop(1000)).toBe(false);
  expect(repeatBudgetStop(8, { stopAfter: 8 })).toBe(true);
  expect(repeatBudgetStop(7, { stopAfter: 8 })).toBe(false);
});

test("停止执行的回灌文案必须给替代动作（否则模型会当工具坏了反复重试）", () => {
  const text = repeatStopNotice("toolA", 24, 24);
  expect(text).toContain("toolA");
  expect(text).toContain("已停止执行");
  expect(text).toContain("换一条取证路径");
});

test("复跑形态回放：累计 32 次至少被提醒 3 次（改动前全程只有 1 次）", () => {
  let notified = 0;
  let step = 0;
  for (let total = 1; total <= 32; total += 1) {
    const esc = repeatEscalation({ toolName: "toolA", total, notifiedStep: step }, { firstStep: 8 });
    if (esc.notice) notified += 1;
    step = esc.step;
  }
  expect(notified, "8 / 16 / 32 三个台阶各提醒一次").toBe(3);
});

test("事故形态回放：多轮多条「不同」查询绕过单工具护栏，总量上限必须拦住", () => {
  // 2026-10-16 /chat 实跑形态：每轮跑 1~2 条不同查询，单工具各只调 1 次 → perRoundLimit、
  // shareLimit、跨轮阶梯全部不触发；只有总调用预算能拦住。evidence=3（早就取到数了）。
  const cap = 30;
  let total = 0;
  let forcedAt = -1;
  for (let round = 1; round <= 27 && forcedAt < 0; round += 1) {
    for (const tag of ["a", "b"]) {
      total += 1;
      const toolName = `query_${round}${tag}`; // 每条查询都是一个"新工具"
      // 单工具护栏：这种形态一次都不该触发（这正是它收不住总量的证据）
      expect(repeatBudgetNotice({ toolName, perRoundCount: 1, priorCount: 0, totalOther: total - 1 })).toBeNull();
      expect(repeatEscalation({ toolName, total: 1, notifiedStep: 0 }).notice).toBeNull();
      if (forceSynthesisByToolCallTotal(total, cap, 3, total)) forcedAt = total; // 事故形态每条都是取数查询，dataCalls 与 total 同步
    }
  }
  expect(forcedAt, "不同查询绕过单工具护栏，但总量上限必须在 cap 处强制收尾").toBe(cap);
});

test("静态接线：阶梯提醒与停止上限都真的挂在主循环上", () => {
  const src = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf-8");
  expect(src).toContain("repeatEscalation({");
  expect(src).toContain("repeatEscalatedStep.set(");
  expect(src).toContain("repeatBudgetStop(repeatTotal)");
  expect(src).toContain("repeatStopNotice(");
  // 总调用预算必须真的接进「是否强制收尾」的判据（否则只是加了个没人调用的函数）
  expect(src).toContain("forceSynthesisByToolCallTotal(");
  expect(src).toContain("MCP_MAX_TOTAL_TOOL_CALLS");
  expect(src).toContain("toolCallTotal,");
  // Fix 2 提前收敛提示：预算用到约 2/3 且已有证据时一次性要求收敛（治低效探索）
  expect(src).toContain("convergeNudged");
  expect(src).toContain("CONVERGE_HINT");
  expect(src).toContain("round >= Math.ceil(ctx.maxRounds * (2 / 3))");
});

/* ── 总调用预算（2026-10-16 /chat 多子问题取数事故：25 条不同 SQL 跑满轮次） ── */

test("总量预算（取数预算）：达到上限且已有证据 → 强制收尾（不论第几轮）", () => {
  // 现在预算基于「取数类调用」(dataCalls) 而非总调用；事故形态 41 次调用都是取数 → dataCalls=41
  expect(forceSynthesisByToolCallTotal(30, 30, 3, 30)).toBe(true);
  expect(forceSynthesisByToolCallTotal(41, 30, 12, 41)).toBe(true); // 事故形态：41 次取数调用
  // 取数预算未达上限不强制
  expect(forceSynthesisByToolCallTotal(29, 30, 12, 29)).toBe(false);
  // 还没有任何证据 → 不强制（否则把探索掐死成「没数据」），交给轮次预算兜底
  expect(forceSynthesisByToolCallTotal(41, 30, 0, 41)).toBe(false);
  // 预算关闭（0）→ 行为完全不变
  expect(forceSynthesisByToolCallTotal(1000, 0, 5, 1000)).toBe(false);
});

test("P0-B·4 预算分离：探索不挤占取数预算，探索耗尽但 0 取数不白收尾", () => {
  // 取数预算与探索预算都未耗尽（dataCalls 小、exploreCalls 小）→ 不收尾
  expect(forceSynthesisByToolCallTotal(2, 30, 5, 2, 5, 16)).toBe(false);
  // 探索预算耗尽且已取过数（dataCalls>0）→ 收尾
  expect(forceSynthesisByToolCallTotal(30, 30, 5, 3, 30, 16)).toBe(true);
  // 探索预算耗尽但还没取过数（dataCalls=0）→ 不收尾，给最后一次取数机会
  expect(forceSynthesisByToolCallTotal(30, 30, 5, 0, 30, 16)).toBe(false);
  // 取数预算耗尽且有证据 → 收尾
  expect(forceSynthesisByToolCallTotal(30, 30, 5, 30, 0, 16)).toBe(true);
});

test("事故形态回放：24 次换参数的元数据探查必须被提示（改动前完全逃过）", () => {
  // 逐轮各调一次 toolA，累计到第 4 轮时占比已超阈值
  let prior = 0;
  let noticed: string | null = null;
  for (let round = 1; round <= 24 && !noticed; round += 1) {
    const other = round <= 8 ? round - 1 : 8; // 前 8 轮有别的工具，之后全靠 toolA
    noticed = repeatBudgetNotice({ toolName: "toolA", perRoundCount: 1, priorCount: prior, totalOther: other });
    prior += 1;
  }
  expect(noticed, "24 次换参数探查必须在某一轮触发提示").not.toBeNull();
});

