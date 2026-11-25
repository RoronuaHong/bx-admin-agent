// run_command 命令执行治理回归（2026-09-24，docs/artifact-delivery-plan.md §13）：
// A 输出编码（Windows GBK 不再乱码）· B 超长输出头尾截断而非整体失败 ·
// C 需要 stdin 的命令不挂死 · D 干净环境注入（BX_AGENT / NO_COLOR，对齐 Cursor 的 CURSOR_AGENT）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, afterAll } from "vitest";
import {
  execBuiltin,
  decodeShellBytes,
  truncateShellOutput,
  shellFailureHint,
  shellSyntaxPreflight,
  detectRunScriptLanguageMismatch,
  inferRunScriptLanguage,
  nodeScriptExtension,
} from "../src/builtins.js";
import { fsRead, fsWrite, fsEdit, fsRemoveConversation, conversationFsRoot } from "../src/fs-store.js";
import { SUBAGENT_PROMPT, buildSystemPrompt } from "../src/system-prompt.js";

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

test("runShell 在 SIGTERM 之后升级 SIGKILL", () => {
  const src = readFileSync(new URL("../src/builtins.ts", import.meta.url), "utf8");
  const start = src.indexOf("function runShell");
  const end = src.indexOf("function assertBuiltinRiskCoverage");
  const slice = src.slice(start, end);
  expect(slice).toContain('child.kill("SIGKILL")');
  expect(slice).toContain("stopEscalate");
});

test("[D] 干净环境：BX_AGENT 注入对子进程可见", async () => {
  const out = await run(isWin ? "echo %BX_AGENT%" : "echo $BX_AGENT");
  expect(out.text).toContain("1");
}, 20000);

// ---- 运行环境 / run_script 语言形态（2026-11-25 审计补充）----
test("[E] run_script 漏写 language 时按代码形态推断（字符串不干扰）", () => {
  expect(inferRunScriptLanguage("const a = 1; console.log(a);")).toBe("node");
  expect(inferRunScriptLanguage("print('hi')")).toBe("python");
  expect(inferRunScriptLanguage("echo hello && dir")).toBe("shell");
  expect(inferRunScriptLanguage("const s = 'print(1)'; console.log(s);")).toBe("node");
});

test("[F] Node 脚本扩展名按 require / import 选择（type=module 工作区）", () => {
  expect(nodeScriptExtension("const fs = require('node:fs'); console.log(fs);")).toBe(".cjs");
  expect(nodeScriptExtension("import fs from 'node:fs'; console.log(fs);")).toBe(".mjs");
  expect(nodeScriptExtension("console.log(1);")).toBe(".mjs");
});

test("[E2] 端到端：漏写 language 的 Node 代码按 node 执行", async () => {
  const out = await execBuiltin("run_script", JSON.stringify({ code: "console.log('OK_INFER')" }), CONV);
  expect(out.ok).toBe(true);
  expect(out.text).toContain("OK_INFER");
}, 20000);

test("[F2] 端到端：require 写法落到 .cjs，不再报 require is not defined", async () => {
  const out = await execBuiltin(
    "run_script",
    JSON.stringify({ language: "node", code: "const os = require('node:os'); console.log('CJS_OK', typeof os.platform);" }),
    CONV,
  );
  expect(out.ok).toBe(true);
  expect(out.text).toContain("CJS_OK");
  expect(out.text).not.toContain("require is not defined");
}, 20000);

winOnly("[G] Windows 下 language=bash 给出可操作提示，而不是丢给 cmd.exe", async () => {
  const out = await execBuiltin("run_script", JSON.stringify({ language: "bash", code: "echo hi" }), CONV);
  expect(out.ok).toBe(false);
  expect(out.text).toContain("没有 bash/sh");
});

test("[H] 主代理与子代理系统提示都带运行环境口径", () => {
  const src = readFileSync(new URL("../src/builtins.ts", import.meta.url), "utf8");
  expect(src).toContain("SHELL_SYNTAX_HINT");
  const main = buildSystemPrompt({
    tooling: { mcpToolCount: 0, builtinToolCount: 30, ready: [], unavailable: [], dropped: [], limit: 200 },
  });
  expect(main.stable).toContain("默认 shell");
  // 子代理同样拿到 run_command / run_script（subBuiltins 只排除了 save_memory 等），不能漏这份口径。
  expect(SUBAGENT_PROMPT).toContain("默认 shell");
});

test("[I] fs_* 越界报错给出替代方案（工作区外走 run_command）", () => {
  const out = fsRead(CONV, "../../../etc/passwd");
  expect("error" in out && out.error).toContain("run_command");
});

test("[M] 防错设计：Windows 下 Unix 命令在执行前被拦下（不烧一次调用）", async () => {
  const hint = shellSyntaxPreflight("pwd; ls -la");
  if (!isWin) {
    expect(hint).toBeNull();
    return;
  }
  expect(hint).toContain("[SHELL_SYNTAX]");
  expect(hint).toContain("dir");
  const out = await run("pwd; ls -la");
  expect(out.ok).toBe(false);
  expect(out.text).toContain("[SHELL_SYNTAX]");
  expect(out.text).not.toContain("不是内部或外部命令"); // 根本没起子进程
});

test("[M2] 预检不误伤字符串里的 Unix 词", () => {
  if (!isWin) return;
  expect(shellSyntaxPreflight('echo "cat this" && dir')).toBeNull();
});

test("[M3] 预检点名命令链后半段真正命中的命令（不误报合法命令）", () => {
  if (!isWin) return;
  const hint = shellSyntaxPreflight("dir && grep foo *.txt");
  expect(hint).toContain("「grep」");
  expect(hint).not.toContain("「dir」是 Unix");
});

test("[N] run_script 语言错配在写文件/起解释器前拦下", () => {
  expect(detectRunScriptLanguageMismatch("python", "const a = 1; console.log(a);")).toContain("改成 node");
  expect(detectRunScriptLanguageMismatch("node", "print('hi')")).toContain("改成 python");
  expect(detectRunScriptLanguageMismatch("shell", "const fs = require('node:fs');")).toContain("不要用 shell");
  expect(detectRunScriptLanguageMismatch("node", "console.log(1);")).toBeNull();
});

test("[N2] 端到端：显式 language 错配直接返回提示，不落脚本", async () => {
  const out = await execBuiltin("run_script", JSON.stringify({ language: "python", code: "console.log(1)" }), CONV);
  expect(out.ok).toBe(false);
  expect(out.text).toContain("[LANG_MISMATCH]");
});

test("[J] Windows 命中 Unix 命令的失败提示，非 Windows 不加", () => {
  const hint = shellFailureHint("pwd; ls -la");
  if (isWin) expect(hint).toContain("cmd.exe");
  else expect(hint).toBe("");
});

test("[L] fs_edit 拒绝编辑被截断的大文件（避免写回丢尾）", () => {
  const name = "too-big.txt";
  const root = conversationFsRoot(CONV);
  mkdirSync(root, { recursive: true });
  // vitest 可能把 FS_MAX_FILE_BYTES 调大，写到 4MB 保证任何配置下都触发读取截断。
  writeFileSync(join(root, name), "x".repeat(4 * 1024 * 1024), "utf8");
  const probe = fsRead(CONV, name);
  expect("content" in probe && probe.content.includes("…（文件过大，仅返回前 ")).toBe(true);
  const out = fsEdit(CONV, name, "x", "y");
  expect("error" in out && out.error).toContain("超过读取上限");
});

test("[K] fs_edit 换行符兜底：LF 输入替换 CRLF 源文件且保持 CRLF", () => {
  const name = "edit-crlf.txt";
  expect("error" in fsWrite(CONV, name, "first\r\nsecond\r\n")).toBe(false);
  const out = fsEdit(CONV, name, "first\nsecond", "FIRST\nSECOND");
  expect("error" in out).toBe(false);
  if ("error" in out) return;
  expect(out.note).toContain("换行符归一化");
  const read = fsRead(CONV, name);
  expect("content" in read && read.content).toBe("FIRST\r\nSECOND\r\n");
});
