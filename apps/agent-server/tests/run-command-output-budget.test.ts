// 命令输出治理：默认值不变，三条输出分支都必须给出可诊断文本。
import { afterAll, expect, test } from "vitest";
import { execBuiltin } from "../src/builtins.js";
import { fsRemoveConversation } from "../src/fs-store.js";

const CONV = "vitest-run-output-budget";
afterAll(() => fsRemoveConversation(CONV));

const run = (command: string) => execBuiltin("run_command", JSON.stringify({ command }), CONV);
const node = (script: string) => `node -e "${script}"`;

test("成功输出超过展示预算：保头尾截断并仍为 ok", async () => {
  const out = await run(node("process.stdout.write('S'.repeat(40000))"));
  expect(out.ok).toBe(true);
  expect(out.text).toContain("已省略");
  expect(out.text.startsWith("S")).toBe(true);
  expect(out.text.trimEnd().endsWith("S")).toBe(true);
}, 20_000);

test("失败分支的输出同样截断，且保留失败原因", async () => {
  const out = await run(node("process.stderr.write('E'.repeat(40000));process.exit(1)"));
  expect(out.ok).toBe(false);
  expect(out.text).toContain("命令执行失败");
  expect(out.text).toContain("已省略");
}, 20_000);

test("maxBuffer 超限：命令已跑过就按成功 + 截断返回，不谎报整体失败", async () => {
  // 测试环境 FS_MAX_FILE_BYTES=1MB → RUN_MAX_BUFFER=8MB，输出必须超过 8MB 才进超限分支。
  const out = await run(node("process.stdout.write('M'.repeat(9 * 1024 * 1024))"));
  expect(out.ok).toBe(true);
  expect(out.text).toContain("输出超过");
  expect(out.text).toContain("已省略");
}, 30_000);
