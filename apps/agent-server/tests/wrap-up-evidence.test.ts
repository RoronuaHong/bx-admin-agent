// 收尾必须看见工具结果，而不是只看见空的过程叙述。
// 思考类模型把发现写在 reasoning 里，工具轮正文经常为空；旧收尾会据此写成「没取到数据」。
import { test, expect } from "vitest";
import {
  buildSynthesisHint,
  buildWrapUpUserContent,
  clipHeadTail,
  clipWrapUpEvidence,
  collectWrapUpNarration,
  noteWrapUpEvidence,
  shouldForceSynthesisRound,
} from "../src/chat.js";

test("还没有证据时，交互式最后一轮仍保留工具", () => {
  expect(
    shouldForceSynthesisRound({ round: 2, maxRounds: 3, forceWrapUp: false, evidenceCalls: 0 }),
  ).toBe(false);
  expect(
    shouldForceSynthesisRound({ round: 1, maxRounds: 3, forceWrapUp: false, evidenceCalls: 4 }),
  ).toBe(false);
});

test("已经有证据时，最后一轮改为无工具综合；无人值守即使没证据也收尾", () => {
  expect(
    shouldForceSynthesisRound({ round: 7, maxRounds: 8, forceWrapUp: false, evidenceCalls: 13 }),
  ).toBe(true);
  expect(
    shouldForceSynthesisRound({ round: 2, maxRounds: 3, forceWrapUp: true, evidenceCalls: 0 }),
  ).toBe(true);
  expect(
    shouldForceSynthesisRound({ round: 0, maxRounds: 1, forceWrapUp: true, evidenceCalls: 3 }),
  ).toBe(false);
});

test("摘录从新到旧保留，超限丢掉更旧的结果", () => {
  const parts: string[] = [];
  noteWrapUpEvidence(parts, "web_search", "旧结果", 100, 2);
  noteWrapUpEvidence(parts, "fetch_url", "航班 CZ3505", 100, 2);
  noteWrapUpEvidence(parts, "fetch_url", "宠物进客舱仅限指定机场始发", 100, 2);
  expect(parts).toHaveLength(2);
  expect(parts[0]).toContain("航班 CZ3505");
  const clipped = clipWrapUpEvidence(["【a】\n" + "甲".repeat(30), "【b】\n乙"], 6);
  expect(clipped).toContain("乙");
  expect(clipped).not.toContain("甲");
});

test("超长工具结果保留头尾，后半段的事实不会被切掉", () => {
  const page = `${"前言".repeat(50)}航班 CZ3505 09:15`;
  const clipped = clipHeadTail(page, 40);
  expect(clipped.startsWith("前言")).toBe(true);
  expect(clipped).toContain("CZ3505");
  expect(clipped).toContain("中间已省略");
});

test("过程叙述带上思考流尾部；补位正文同时包含工具摘录和过程记录", () => {
  const narration = collectWrapUpNarration("", ["前面的计划", "我拿到了航班时刻表 CZ3505"], 20);
  expect(narration.endsWith("我拿到了航班时刻表 CZ3505") || narration.includes("CZ3505")).toBe(true);

  const hint = buildSynthesisHint("【fetch_url】\nCZ3505 09:15");
  expect(hint).toContain("工具不可再用");
  expect(hint).toContain("CZ3505 09:15");
  expect(buildSynthesisHint("")).toBe(hint.split("\n\n")[0]);

  const user = buildWrapUpUserContent("广州到福州的直飞航班？", narration, "【fetch_url】\nCZ3505");
  expect(user).toContain("过程记录");
  expect(user).toContain("CZ3505");
  expect(user.indexOf("CZ3505")).toBeLessThan(user.indexOf("过程记录"));
});
