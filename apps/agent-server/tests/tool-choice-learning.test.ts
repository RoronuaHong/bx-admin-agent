// 强制工具通道的端点学习：被拒一次记住、自愈无效（降级 auto 仍失败）则回滚记忆（不固化推测）。
// 与 models.ts 三条端点自愈（回灌思考 / 关思考 / 温度）同一条纪律——学习信号来自报错措辞，
// 有误判空间，固化会永久关掉角色「首轮逼模型先调工具」的防编造增强，故自愈无效必须撤销。
import { test, expect } from "vitest";
import {
  markForcedToolChoiceUnsupported,
  unmarkForcedToolChoiceUnsupported,
  forcedToolChoiceSupported,
} from "../src/chat.js";
import type { ModelEntry } from "../src/config.js";

function makeModel(id: string, baseUrl = "https://api.openai.com"): ModelEntry {
  return {
    id,
    label: id,
    provider: "openai",
    name: id,
    baseUrl,
    apiKey: "k",
    apiKeys: ["k"],
    vision: "none",
    timeoutMs: 1000,
    contextWindow: 128000,
  };
}

test("被拒一次记住：forcedToolChoiceSupported 转 false；撤销后恢复 true（同一条纪律：自愈可回滚）", () => {
  const m = makeModel("probe-tc-rollback");
  expect(forcedToolChoiceSupported(m)).toBe(true);
  markForcedToolChoiceUnsupported(m);
  expect(forcedToolChoiceSupported(m)).toBe(false);
  // 自愈无效（降级 auto 仍失败）→ 撤销记忆：下次请求重新探测，而不是假装学会了永久禁用
  unmarkForcedToolChoiceUnsupported(m);
  expect(forcedToolChoiceSupported(m)).toBe(true);
});

test("记忆按端点地址隔离：换 baseUrl 的同名模型不受影响", () => {
  const a = makeModel("dup", "https://a.example");
  const b = makeModel("dup", "https://b.example");
  markForcedToolChoiceUnsupported(a);
  expect(forcedToolChoiceSupported(a)).toBe(false);
  expect(forcedToolChoiceSupported(b)).toBe(true); // 没被 A 的结论株连
  unmarkForcedToolChoiceUnsupported(a);
  expect(forcedToolChoiceSupported(a)).toBe(true);
});
