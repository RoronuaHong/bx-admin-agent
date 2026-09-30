// 审计告警节流（dedup + throttle，src/audit.ts）：
// 「拒绝一次就推一条」会把用户正常点不同意变成刷屏；真正值得告警的是同一来源短时间反复被拒。
// 口径与定时任务告警一致：窗口内累计到阈值才推 → 推完进冷静期 → 冷静期内只累计 → 期后有新增再推汇总。
import { test, expect } from "vitest";
import { decideAuditAlert } from "../src/audit.js";

const W = 10 * 60_000; // 窗口 10 分钟
const C = 30 * 60_000; // 冷静期 30 分钟
const BURST = 3;
const t0 = 1_700_000_000_000;
const base = { windowMs: W, cooldownMs: C, burst: BURST };

/** 连投 n 条（间隔 stepMs），返回每次的判定与最终一条被推时的累计条数。 */
function feed(n: number, stepMs = 60_000, start = t0) {
  const out: Array<{ deliver: boolean; count: number }> = [];
  let state = undefined as Parameters<typeof decideAuditAlert>[0]["state"];
  for (let i = 0; i < n; i++) {
    const r = decideAuditAlert({ ...base, now: start + i * stepMs, state });
    state = r.next;
    out.push({ deliver: r.deliver, count: r.count });
  }
  return out;
}

test("累计未到阈值不推；到阈值推一条并带累计条数", () => {
  const r = feed(BURST);
  expect(r.map((x) => x.deliver)).toEqual([false, false, true]);
  expect(r[2]!.count).toBe(BURST);
});

test("冷静期内只累计不推；冷静期结束有新增再推一条（不刷屏也不丢信息）", () => {
  // 第 3 条触发推送 → 冷静期 30 分钟内继续被拒都不推。
  const during = feed(6, 60_000);
  expect(during.filter((x) => x.deliver).length).toBe(1);
  // 冷静期结束后（第 40 分钟起）再来 3 条 → 再推一条。
  const later = feed(3, 60_000, t0 + 40 * 60_000);
  expect(later.map((x) => x.deliver)).toEqual([false, false, true]);
});

test("跨累计窗口重新计数：稀疏的偶发拒绝不该被累计成告警", () => {
  // 每 11 分钟一次（> 窗口 10 分钟）→ 每次都是新窗口的第 1 条，永远推不出去。
  const sparse = feed(5, 11 * 60_000);
  expect(sparse.some((x) => x.deliver)).toBe(false);
});

test("不同来源互不压制（按 key 分别计状态，状态由调用方持有）", () => {
  // 纯函数本身无 key 概念：状态按调用方传入的 state 演进，
  // 两个来源各喂一串，互不影响 —— 这里用两条独立状态链验证。
  const a = feed(3);
  const b = feed(3);
  expect(a[2]!.deliver).toBe(true);
  expect(b[2]!.deliver).toBe(true);
  // 只喂 2 条的来源不推。
  expect(feed(2).every((x) => !x.deliver)).toBe(true);
});

test("burst=1 退化为「每次都推」（旧行为），仍受冷静期约束", () => {
  const once = decideAuditAlert({ ...base, burst: 1, now: t0 });
  expect(once.deliver).toBe(true);
  // 紧接着的第二条落在冷静期内 → 不推。
  const second = decideAuditAlert({ ...base, burst: 1, now: t0 + 1000, state: once.next });
  expect(second.deliver).toBe(false);
});
