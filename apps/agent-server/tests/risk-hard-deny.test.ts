// 硬拒（deny）不受 fullAccess 影响（risk.ts isHardDenied，2026-10-06 修订）。
//
// 背景：`fullAccess`（完全访问）缺省为 true，于是旧写法 `verdict.deny && !ctx.fullAccess` 让硬拒
// 在**默认配置下从不生效**，造成两个真实后果：
//   1. 运维显式配置的 MCP_UNKNOWN_TOOLS=deny 被默认开关静默覆盖、形同失效；
//   2. source=sql-readonly 的原生 SQL 非只读查询硬拒同样被跳过 → 文档所称「适配器粗筛 + 服务端硬拒」
//      这道纵深防御在默认配置下只剩适配器一层。
//
// 本测试把「deny 不受 fullAccess 影响」钉成回归锚点，同时确认**确认卡口径未被改动**
//（完全访问的便利性必须原样保留，否则就成了另一种越权）。
import { test, expect, describe, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isHardDenied, resolveToolRisk, verdictNeedsConfirm } from "../src/risk.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHAT_SRC = resolve(__dirname, "..", "src", "chat.ts");

/**
 * 接线断言：真正的回归口在 chat.ts —— 「不受 fullAccess 影响」是**结构保证**
 * （isHardDenied 签名里没有 fullAccess 参数），单测证伪不了「有人把 && !ctx.fullAccess 加回调用处」。
 * 故这里直接读源码把那条调用行钉住。
 */
function hardDenyGateLine(): string {
  return readFileSync(CHAT_SRC, "utf-8")
    .split("\n")
    .find((line) => line.includes("isHardDenied(verdict)")) || "";
}

/** 构造一个最小 verdict，避免依赖 MCP 服务器配置。 */
function verdictOf(over: Partial<Parameters<typeof isHardDenied>[0]>): Parameters<typeof isHardDenied>[0] {
  return {
    level: "read",
    unknown: false,
    deny: false,
    reason: "test",
    source: "builtin",
    external: false,
    ...over,
  };
}

describe("硬拒不受 fullAccess 影响", () => {
  test("deny=true 恒为硬拒（fullAccess 不参与判定）", () => {
    // 本次修订的核心断言：以前 fullAccess=true 会让它变成「不拒」。
    expect(isHardDenied(verdictOf({ deny: true }))).toBe(true);
    // 反向锚点：deny 缺省 false 时不得误拒。
    expect(isHardDenied(verdictOf({ deny: false }))).toBe(false);
  });

  test("确认卡口径未被改动：destructive 仍需确认（收紧只动了 deny）", () => {
    const destructive = verdictOf({ level: "destructive", deny: false });
    expect(verdictNeedsConfirm(destructive)).toBe(true);
    // deny 与「需确认」是两个独立维度：destructive+deny 两者都为真。
    const denied = verdictOf({ level: "destructive", deny: true });
    expect(isHardDenied(denied)).toBe(true);
    expect(verdictNeedsConfirm(denied)).toBe(true);
  });

  test("接线：chat.ts 的硬拒调用不得带 fullAccess（防有人加回去）", () => {
    const line = hardDenyGateLine();
    expect(line, "应能找到 isHardDenied(verdict) 调用行").not.toBe("");
    // 关键断言：调用处不得再出现 fullAccess，否则「显式策略被默认开关覆盖」会原样复发。
    expect(line).not.toContain("fullAccess");
    expect(line).toContain("if (isHardDenied(verdict))");
  });
});

describe("MCP_UNKNOWN_TOOLS 显式策略真实生效", () => {
  const saved = process.env.MCP_UNKNOWN_TOOLS;
  afterEach(() => {
    if (saved === undefined) delete process.env.MCP_UNKNOWN_TOOLS;
    else process.env.MCP_UNKNOWN_TOOLS = saved;
  });

  test("deny：未声明工具被硬拒（不再被 fullAccess 静默覆盖）", () => {
    process.env.MCP_UNKNOWN_TOOLS = "deny";
    const v = resolveToolRisk("totally_undeclared_tool");
    expect(v.unknown).toBe(true);
    expect(v.deny).toBe(true);
    expect(isHardDenied(v)).toBe(true);
  });

  test("allow：不硬拒（按只读放行，口径仍可控）", () => {
    process.env.MCP_UNKNOWN_TOOLS = "allow";
    const v = resolveToolRisk("totally_undeclared_tool");
    expect(v.deny).toBe(false);
    expect(isHardDenied(v)).toBe(false);
  });

  test("confirm（默认）：不硬拒，仍走确认闸门（由 fullAccess 决定是否弹卡）", () => {
    process.env.MCP_UNKNOWN_TOOLS = "confirm";
    const v = resolveToolRisk("totally_undeclared_tool");
    expect(v.deny).toBe(false);
    // 未声明 → 保守按 destructive 处理 → 需要确认
    expect(verdictNeedsConfirm(v)).toBe(true);
  });

  test("内置工具永不被硬拒（登记表中有的走 builtin 分支）", () => {
    process.env.MCP_UNKNOWN_TOOLS = "deny";
    const v = resolveToolRisk("fs_read");
    expect(v.deny).toBe(false);
    expect(isHardDenied(v)).toBe(false);
  });
});
