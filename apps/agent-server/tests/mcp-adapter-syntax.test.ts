// stdio MCP 适配器脚本的**解析门禁**。
//
// 为什么需要这一层（2026-10-14 真实端到端复跑才发现）：`scripts/metabase-mcp.mjs` 里残留了一处
// TS 返回类型标注（`function currentTimeoutMs(): number`），`.mjs` 被 Node 当纯 JS 解析 →
// 启动即 `SyntaxError` → MCP 握手前进程就退出 → 服务端只看到「Connection closed」，
// 模型一个数据都取不到、只能如实说「未取到」。而**全量单测当时是全绿的**：既有断言全部是
// 「读源码做静态断言 / import 共享纯函数」，从来没有真正解析或启动过适配器本身。
//
// 这类缺陷的特征是「代码看起来对、测试也全过、只有真跑才炸」，所以必须有一层**执行侧**的门禁：
// 这里用 `node --check` 逐个解析（只解析不执行，不会真的连上游），并对合成的反例自检门禁有效。
import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = fileURLToPath(new URL("../scripts/", import.meta.url));

function parseOk(file: string): boolean {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

test("[A] 门禁本身有效：合成一处 TS 标注必须被判为不可解析", () => {
  const dir = mkdtempSync(join(os.tmpdir(), "adapter-syntax-"));
  const bad = join(dir, "bad.mjs");
  writeFileSync(bad, "export function f(): number {\n  return 1;\n}\n", "utf-8");
  try {
    expect(parseOk(bad), "带类型标注的 .mjs 必须解析失败（否则本门禁是摆设）").toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[B] scripts/*.mjs 全部可被 Node 解析（stdio MCP 适配器不会启动即崩）", () => {
  const files = readdirSync(SCRIPTS_DIR).filter((name) => name.endsWith(".mjs"));
  expect(files.length, "至少要有适配器脚本，空目录说明路径变了").toBeGreaterThan(0);
  const broken = files.filter((name) => !parseOk(join(SCRIPTS_DIR, name)));
  expect(broken, `以下脚本无法被 Node 解析（MCP 会启动即崩）：${broken.join("、")}`).toEqual([]);
}, 60000);
