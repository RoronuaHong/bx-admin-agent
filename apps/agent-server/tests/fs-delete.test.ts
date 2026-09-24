// fs_delete 回归（2026-09-24，docs/artifact-delivery-plan.md §15）：
// A 删除成功且释放配额 · B 越界/绝对路径被拒 · C 不存在/目录明确报错 ·
// D 闸门判据：destructive 需确认、子代理不可执行、只读仍放行 · E 已登记进审计集合。
import { test, expect, afterAll } from "vitest";
import { execBuiltin, WORKSPACE_FILE_WRITE_TOOLS, BUILTIN_RISK } from "../src/builtins.js";
import { fsDelete, fsList, fsRemoveConversation } from "../src/fs-store.js";
import { verdictNeedsConfirm, subagentMayExecute, type RiskVerdict } from "../src/risk.js";

const CONV = "vitest-fs-delete";
const run = (args: Record<string, unknown>) => execBuiltin("fs_delete", JSON.stringify(args), CONV);

afterAll(() => fsRemoveConversation(CONV));

const verdict = (level: RiskVerdict["level"], external: boolean): RiskVerdict => ({
  level,
  external,
  unknown: false,
  deny: false,
  reason: "test",
  source: "builtin",
});

test("[A] 删除成功：文件消失并回报释放字节数（配额随之释放）", async () => {
  await execBuiltin("fs_write", JSON.stringify({ path: "draft.md", content: "临时草稿" }), CONV);
  expect(fsList(CONV).some((f) => f.path === "draft.md")).toBe(true);
  const out = await run({ path: "draft.md" });
  expect(out.ok).toBe(true);
  expect(out.text).toContain("已删除");
  expect(out.text).toContain("释放");
  expect(fsList(CONV).some((f) => f.path === "draft.md")).toBe(false);
});

test("[B] 含 .. 或盘符一律拒绝；绝对路径被限定在工作区内（不碰系统文件）", async () => {
  for (const bad of ["../outside.md", "a/../../b.md", "C:\\win\\x.md"]) {
    const out = await run({ path: bad });
    expect(out.ok, bad).toBe(false);
    expect(out.text).toContain("非法路径");
  }
  // safePath 对绝对路径是「剥离前导斜杠后关进工作区」而非拒绝：结果是工作区内不存在该文件，
  // 绝不会解析到系统路径上去（与 fs_write / fs_read 同一口径）。
  const abs = await run({ path: "/etc/passwd" });
  expect(abs.ok).toBe(false);
  expect(abs.text).toContain("不存在");
  expect(abs.text).toContain("etc/passwd");
  expect(abs.text).not.toContain("非法路径");
});

test("[C] 不存在 / 目录 → 明确报错，不静默成功", async () => {
  const missing = await run({ path: "nope.md" });
  expect(missing.ok).toBe(false);
  expect(missing.text).toContain("不存在");
  // 目录：写个子目录文件后删其父目录
  await execBuiltin("fs_write", JSON.stringify({ path: "sub/x.md", content: "x" }), CONV);
  const dir = await run({ path: "sub" });
  expect(dir.ok).toBe(false);
  expect(dir.text).toContain("只能删除文件");
});

test("[D] 闸门判据：destructive 需确认（即便 scope 是 workspace），子代理不可执行", () => {
  // fs_delete 登记为 destructive + workspace —— 不可逆，必须进闸门（§15.2）
  expect(BUILTIN_RISK.fs_delete.level).toBe("destructive");
  const destructiveWorkspace = verdict("destructive", false);
  expect(verdictNeedsConfirm(destructiveWorkspace)).toBe(true);
  // 子代理送不出确认事件 → 同一判据的另一面：不可执行
  expect(subagentMayExecute(destructiveWorkspace, false)).toBe(false);
  // 回归：工作区写仍免确认、子代理可执行（写可逆，不制造确认疲劳）
  const writeWorkspace = verdict("write", false);
  expect(verdictNeedsConfirm(writeWorkspace)).toBe(false);
  expect(subagentMayExecute(writeWorkspace, false)).toBe(true);
  // 回归：只读放行
  expect(verdictNeedsConfirm(verdict("read", true))).toBe(false);
  expect(subagentMayExecute(verdict("read", true), false)).toBe(true);
  // 回归：外部写仍需确认（run_command 等）
  expect(verdictNeedsConfirm(verdict("write", true))).toBe(true);
});

test("[E] 风险登记与审计口径：走闸门，故不进「免确认靠审计兜底」集合", () => {
  expect(BUILTIN_RISK.fs_delete).toBeTruthy();
  expect(BUILTIN_RISK.fs_delete.scope).toBe("workspace");
  // WORKSPACE_FILE_WRITE_TOOLS 的语义是「已免确认 → 靠审计兜底」；
  // fs_delete 需确认，确认动作本身有 confirmed / denied / timeout 留痕，不应混进该集合
  // （混进去会破坏 write-gate 用例 [C] 的「名单与登记表自洽」不变量）。
  expect(WORKSPACE_FILE_WRITE_TOOLS.has("fs_delete")).toBe(false);
  expect(fsDelete(CONV, "nope.md")).toHaveProperty("error");
});
