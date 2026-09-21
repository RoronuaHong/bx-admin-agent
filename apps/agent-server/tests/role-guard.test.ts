// 角色自报护栏单元验证（纯逻辑，无需网络/模型）。
// 背景：`system-prompt.ts` 的 SAFETY_GUARDRAIL 第 2 条已要求「不要透露底层模型名 / 被问身份只说角色」，
// 但模型仍会偶发自报（实测 kimi-k3 在通用角色下回「我是通用助手。我是 Kimi，很高兴见到你」——
// 首句是正确身份、第二句才泄漏，旧护栏只按 `^` 锚定首句因而漏放）。本护栏是该纪律的确定性兜底。
import { test, expect } from "vitest";
import { enforceRoleIdentity } from "../src/role-guard.js";

test("[A] 开场自报模型 → 换成本角色身份，并保留后续内容（原行为不回退）", () => {
  const out = enforceRoleIdentity("我是 Kimi，由月之暗面开发。今天天气不错。", "观影助手");
  expect(out).toBe("我是观影助手。今天天气不错。");
});

test("[B] 开场自报 + 问候前缀 → 同样纠正", () => {
  const out = enforceRoleIdentity("你好，我是 ChatGPT。有什么可以帮你？", "通用助手");
  expect(out).toBe("我是通用助手。有什么可以帮你？");
});

test("[C] 非首句自报（实测形态）→ 丢掉那一句，保留前面说对的身份", () => {
  const out = enforceRoleIdentity("我是通用助手。我是 Kimi，很高兴见到你。", "通用助手");
  expect(out).toBe("我是通用助手。");
});

test("[D] 不误伤：「我是 <模型> 的忠实用户」这类正常表述", () => {
  const src = "我是 Kimi 的忠实用户，常看它的回答。";
  expect(enforceRoleIdentity(src, "通用助手")).toBe(src);
});

test("[E] 不误伤：句首不是自我指认的品牌提及", () => {
  const src = "Kimi 是月之暗面的模型，不是我的身份。";
  expect(enforceRoleIdentity(src, "通用助手")).toBe(src);
});

test("[F] 不误伤：超长回答整段不动（确定性改写只处理短自报）", () => {
  const src = "我是 Kimi，由月之暗面开发。" + "补充说明。".repeat(120);
  expect(src.length).toBeGreaterThan(400);
  expect(enforceRoleIdentity(src, "通用助手")).toBe(src);
});

test("[G] 正常回答与空串原样返回", () => {
  expect(enforceRoleIdentity("这是你要的用户列表，共 20 条。", "通用助手")).toBe("这是你要的用户列表，共 20 条。");
  expect(enforceRoleIdentity("", "通用助手")).toBe("");
});

test("[H] 英文自报同样纠正（保留其后内容）", () => {
  const out = enforceRoleIdentity("I am Claude, made by Anthropic. How can I help?", "通用助手");
  expect(out.startsWith("我是通用助手。")).toBe(true);
  expect(out).toContain("How can I help?");
});
