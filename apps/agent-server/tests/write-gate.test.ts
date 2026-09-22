// 工作区写闸门口径（2026-09-22 修订，纯逻辑，不依赖网络/真实模型）：
// 闸门只留给**不可逆 / 跨出信任边界**的动作；工作区写发生在对话沙箱内（路径越界即拒、体积有上限），
// 属可逆的本地动作 → 免确认（否则确认疲劳会让用户退化成橡皮图章）。
// 同时钉住「这次放宽没有波及外部写与未知工具」——那两类仍必须逐次确认（fail-closed）。
import { test, expect } from "vitest";
import { resolveToolRisk, subagentMayExecute, verdictNeedsConfirm, type RiskVerdict } from "../src/risk.js";
import { summarizeArgsForConfirm } from "../src/chat.js";
import { BUILTIN_RISK, WORKSPACE_FILE_WRITE_TOOLS } from "../src/builtins.js";

test("[A] 工作区写免确认：级别仍是 write（沙箱内、可回查），但不弹确认卡", () => {
  for (const name of ["fs_write", "fs_edit"]) {
    const v = resolveToolRisk(name);
    expect(v.source, name).toBe("builtin");
    expect(v.level, name).toBe("write");
    expect(v.external, name).toBe(false);
    expect(verdictNeedsConfirm(v), name).toBe(false);
  }
  // 其它无外部副作用的内置写/只读工具同样不弹卡
  for (const name of ["write_todos", "save_memory", "record_watched_movies", "fs_read", "fs_ls"]) {
    expect(verdictNeedsConfirm(resolveToolRisk(name)), name).toBe(false);
  }
});

test("[B] 放宽不外溢：外部写与未登记工具仍须确认（fail-closed）", () => {
  // 未连接 / 不在注册表快照里的 MCP 工具 → 未知兜底（默认 confirm）→ 仍需确认
  const unknownMcp = resolveToolRisk("mcp__not-connected__anything", undefined, {});
  expect(unknownMcp.unknown).toBe(true);
  expect(unknownMcp.external).toBe(true);
  expect(verdictNeedsConfirm(unknownMcp)).toBe(true);

  // 既不在内置登记表、也带不上 MCP 命名空间的名字 → 不得因本修订被静默放行
  const stray = resolveToolRisk("not_registered_tool");
  expect(stray.unknown).toBe(true);
  expect(verdictNeedsConfirm(stray)).toBe(true);
});

test("[C] 审计名单与风险登记表自洽（免确认后靠可回查兜底）", () => {
  // 会写工作区文件的工具必须在审计名单里，否则「免确认 + 无痕迹」会让覆盖写无法回溯。
  for (const name of WORKSPACE_FILE_WRITE_TOOLS) {
    const registered = BUILTIN_RISK[name];
    expect(registered, name).toBeTruthy();
    expect(registered.level, name).toBe("write");
    expect(registered.scope, name).toBe("workspace");
    expect(verdictNeedsConfirm(resolveToolRisk(name)), name).toBe(false);
  }
  expect(WORKSPACE_FILE_WRITE_TOOLS.has("fs_write")).toBe(true);
  expect(WORKSPACE_FILE_WRITE_TOOLS.has("fs_edit")).toBe(true);
});

test("[E] 子代理可执行范围按作用域判定：工作区写放行，需用户拍板的外部写拒绝", () => {
  // 免确认的工作区写（沙箱内、可回查）→ 子代理可执行；否则「子代理把中间结果落盘」这类安全委派被无谓挡住。
  for (const name of ["fs_write", "fs_edit"]) {
    expect(subagentMayExecute(resolveToolRisk(name), false), name).toBe(true);
  }
  // 只读照常放行。
  for (const name of ["fs_read", "fs_ls"]) {
    expect(subagentMayExecute(resolveToolRisk(name), false), name).toBe(true);
  }
  // 需要用户确认的外部写 / 破坏性：拒绝（子代理的确认事件送不倒用户面前，只能挂到超时）。
  const externalWrite: RiskVerdict = {
    level: "write",
    unknown: false,
    deny: false,
    reason: "外部写（测试夹具）",
    source: "annotation",
    external: true,
  };
  expect(subagentMayExecute(externalWrite, false)).toBe(false);
  expect(subagentMayExecute({ ...externalWrite, level: "destructive" }, false)).toBe(false);
  // 主代理（allowWrite=true，自己能弹确认卡）不受此闸门限制。
  expect(subagentMayExecute(externalWrite, true)).toBe(true);
});

test("[D] 确认卡参数展示：长值头尾保留 + 显式省略，敏感键脱敏", () => {
  const long = `${"A".repeat(2000)}TAIL`;
  const rows = summarizeArgsForConfirm(JSON.stringify({ content: long, path: "results/a.md", token: "s3cret" }));
  const shown = new Map(rows.map((row) => [row.key, row.value]));

  const content = shown.get("content") || "";
  expect(content.startsWith("A".repeat(100))).toBe(true);
  // 尾部内容不得被静默丢掉：显示摘要会把藏在尾部的内容藏起来（确认卡的全部价值是让用户看清要执行什么）
  expect(content.endsWith("TAIL")).toBe(true);
  expect(content).toContain("省略");
  expect(content.length).toBeLessThan(long.length);

  expect(shown.get("path")).toBe("results/a.md");
  expect(shown.get("token")).toBe("•••");

  // 条目数上限：多余键按上限截断（既有口径，不被本修订改变）
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i]));
  expect(summarizeArgsForConfirm(JSON.stringify(many)).length).toBe(8);
});
