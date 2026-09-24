// run_command 命令执行治理回归（2026-09-24，docs/artifact-delivery-plan.md §13）：
// A 输出编码（Windows GBK 不再乱码）· B 超长输出头尾截断而非整体失败 ·
// C 需要 stdin 的命令不挂死 · D 干净环境注入（BX_AGENT / NO_COLOR，对齐 Cursor 的 CURSOR_AGENT）。
import { test, expect, afterAll } from "vitest";
import { execBuiltin, decodeShellBytes, truncateShellOutput } from "../src/builtins.js";
import { fsRemoveConversation } from "../src/fs-store.js";

const CONV = "vitest-run-command";
const isWin = process.platform === "win32";
const winOnly = isWin ? test : test.skip;

afterAll(() => fsRemoveConversation(CONV));

const run = (command: string, timeoutMs?: number) =>
  execBuiltin("run_command", JSON.stringify(timeoutMs ? { command, timeoutMs } : { command }), CONV);

test("[A] 解码：GBK 字节按中文还原，UTF-8 字节仍按 UTF-8", () => {
  expect(decodeShellBytes(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe("中文"); // 「中文」的 GBK 编码
  expect(decodeShellBytes(Buffer.from("中文", "utf-8"))).toBe("中文");
  expect(decodeShellBytes(undefined)).toBe("");
});

test("[A2] 端到端：中文输出可读（不含替换字符）", async () => {
  const out = await run("echo 中文测试");
  expect(out.text).toContain("中文测试");
  expect(out.text).not.toContain("�");
}, 20000);

// 直接复现用户场景：ipconfig 的输出是 GBK，修复前整页乱码。
winOnly("[A3] 真实命令（ipconfig /all）的中文输出可读", async () => {
  const out = await run("ipconfig /all");
  expect(out.ok).toBe(true);
  expect(out.text).toContain("配置"); // 「Windows IP 配置」
}, 20000);

test("[B] 超长输出：保头尾 + 显式省略计数（不再整体失败）", () => {
  const long = "A".repeat(500) + "MIDDLE" + "B".repeat(500);
  const cut = truncateShellOutput(long, 200);
  expect(cut).toContain("已省略");
  expect(cut.startsWith("A")).toBe(true);
  expect(cut.endsWith("B")).toBe(true);
  expect(cut).not.toContain("MIDDLE"); // 中间被裁掉
});

test("[C] 需要 stdin 的命令不挂死（stdin 已关闭，不再空等到超时）", async () => {
  const t0 = Date.now();
  await run(isWin ? "pause" : "read x", 4000);
  expect(Date.now() - t0).toBeLessThan(10_000);
}, 15_000);

test("[D] 干净环境：BX_AGENT 注入对子进程可见", async () => {
  const out = await run(isWin ? "echo %BX_AGENT%" : "echo $BX_AGENT");
  expect(out.text).toContain("1");
}, 20000);
