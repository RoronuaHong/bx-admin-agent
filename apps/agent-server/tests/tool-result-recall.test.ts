// 工具结果治理的「recall 优先」卸载（第 8 批，对标 Anthropic《Effective context engineering》
// 「Compaction 调优顺序：先最大化 recall，再提升 precision」）。
//
// 钉住三件事：
// 1. 卸载顺序按**重取代价**从低到高（可重放的先卸，不可重放的最后卸），不是按新旧一刀切；
// 2. 不可重放的结果**只卸载、绝不丢弃**（落盘失败时保留原文，不清成占位符）；
// 3. 判据与 `chat.ts` 共用同一份实现（纯函数模块），不是各写一遍。
//
// 阈值说明：vitest.config.ts 固定了 MCP_TOOL_RESULT_KEEP=3 / MCP_TOOL_RESULT_PROTECT=keepme，
// 本文件在导入 chat.js 之前把预算调成 450，好让「只需要卸一条」的场景可区分顺序。
import { test, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { classifyRecall, orderByRecallCost, recallRank, type RecallClass } from "../src/tool-result-governance.js";
import { fsRemoveConversation } from "../src/fs-store.js";

process.env.MCP_TOOL_RESULT_BUDGET = "450"; // 5×100=500，卸一条（100）即回落到 400 ≤ 450

let governToolResults: (typeof import("../src/chat.js"))["governToolResults"];

beforeAll(async () => {
  ({ governToolResults } = await import("../src/chat.js"));
});

const CONV = "tool-result-recall";
afterAll(() => {
  fsRemoveConversation(CONV);
});

/** ≈100 token/条（估算器：ASCII ≈ 4 字符/token）。 */
const BIG = "x".repeat(400);

/** 造一条 assistant 轮（携带工具调用参数）供「同输入是否已重放过」判定使用。 */
function assistantWith(calls: Array<{ id: string; name: string; argsJson: string }>) {
  return { role: "assistant", content: "", toolCalls: calls };
}

test("[A] classifyRecall：三类的判据（不可重放优先于其它判据）", () => {
  expect(classifyRecall({ duplicated: false, read: true, derived: false })).toBe("refetchable");
  expect(classifyRecall({ duplicated: true, read: true, derived: false })).toBe("replayed");
  // 非只读：重放会再产生一次副作用 → 不可重放（哪怕没重放过、也不是推导产物）
  expect(classifyRecall({ duplicated: false, read: false, derived: false })).toBe("irreplaceable");
  // 推导产物：再委派一次也未必复现 → 不可重放（哪怕调用本身只读）
  expect(classifyRecall({ duplicated: false, read: true, derived: true })).toBe("irreplaceable");
  expect(classifyRecall({ duplicated: true, read: false, derived: true })).toBe("irreplaceable");

  expect(recallRank("replayed")).toBeLessThan(recallRank("refetchable"));
  expect(recallRank("refetchable")).toBeLessThan(recallRank("irreplaceable"));
});

test("[B] orderByRecallCost：按代价升序，同级保持原顺序（稳定排序）", () => {
  const cls: RecallClass[] = ["irreplaceable", "refetchable", "replayed", "refetchable", "replayed"];
  const items = cls.map((c, i) => ({ i, c }));
  const ordered = orderByRecallCost(items, (item) => item.c);
  expect(ordered.map((item) => item.c)).toEqual([
    "replayed", // i=2
    "replayed", // i=4
    "refetchable", // i=1
    "refetchable", // i=3
    "irreplaceable", // i=0
  ]);
  // 同级内的相对顺序不变（旧结果在前）
  expect(ordered[0].i).toBe(2);
  expect(ordered[1].i).toBe(4);
  expect(ordered[2].i).toBe(1);
  expect(ordered[3].i).toBe(3);
  expect(orderByRecallCost([], () => "refetchable")).toEqual([]);
});

test("[C] 可重放的先卸：只差一条预算时，卸「只读可重放」而保住「重放有副作用」的", () => {
  // fs_write 登记为 write（重放会再写一次），fs_read 登记为 read（原样重放无副作用）。
  const conv = [
    { role: "tool", toolCallId: "w0", name: "fs_write", content: BIG },
    { role: "tool", toolCallId: "r0", name: "fs_read", content: BIG },
    { role: "tool", toolCallId: "r1", name: "fs_read", content: BIG },
    { role: "tool", toolCallId: "r2", name: "fs_read", content: BIG },
    { role: "tool", toolCallId: "r3", name: "fs_read", content: BIG },
  ];
  // keep=3 → 候选是前两条；总量 500 > 450 → 只需卸一条。
  const res = governToolResults(conv as never, CONV);
  expect(res.offloaded).toBe(1);
  expect(res.cleared).toBe(0);
  // 旧行为（按新旧一刀切）会先卸 w0；recall 优先后先卸 r0。
  expect(conv[0].content, "重放有副作用的结果被保住").toBe(BIG);
  expect(conv[1].content.includes("已卸载到工作区文件")).toBe(true);
});

test("[D] 不可重放的只卸不丢：落盘失败时保留原文（不清成占位符）", () => {
  // 内容超过单文件上限（FS_MAX_FILE_BYTES=1MB）→ offloadToolResult 必然失败，走「清成占位符」分支。
  const huge = "y".repeat(1_100_000);
  const conv = [
    { role: "tool", toolCallId: "w1", name: "fs_write", content: huge },
    { role: "tool", toolCallId: "r1", name: "fs_read", content: BIG },
    { role: "tool", toolCallId: "r2", name: "fs_read", content: BIG },
    { role: "tool", toolCallId: "r3", name: "fs_read", content: BIG },
    { role: "tool", toolCallId: "r4", name: "fs_read", content: BIG },
  ];
  const res = governToolResults(conv as never, CONV);
  // r1 可重放 → 正常卸载；w1 不可重放且落盘失败 → 保留原文，绝不清成占位符。
  // keep=3：候选只有 index0/1（w1、r1），w1 落盘失败被保住，故只卸掉 r1。
  expect(res.offloaded).toBe(1);
  expect(res.cleared, "不可重放的结果不会被丢弃").toBe(0);
  expect(conv[0].content, "落盘失败仍保留原文").toBe(huge);
  expect(conv[1].content.includes("已卸载到工作区文件")).toBe(true);
});

test("[E] 同输入已重放过的代价最低：先卸重复的、保住独一无二的", () => {
  // c0 参数独一无二（refetchable），c1/c2 参数相同（replayed）→ 顺序应为 c1、c2、c0。
  const conv = [
    assistantWith([
      { id: "c0", name: "fs_read", argsJson: '{"a":1}' },
      { id: "c1", name: "fs_read", argsJson: '{"b":2}' },
      { id: "c2", name: "fs_read", argsJson: '{"b":2}' },
    ]),
    // 6 条工具结果 + keep=3 → 候选是 c0/c1/c2 三条（重复判定只在候选范围内比）
    { role: "tool", toolCallId: "c0", name: "fs_read", content: BIG },
    { role: "tool", toolCallId: "c1", name: "fs_read", content: BIG },
    { role: "tool", toolCallId: "c2", name: "fs_read", content: BIG },
    { role: "tool", toolCallId: "c3", name: "fs_read", content: BIG },
    { role: "tool", toolCallId: "c4", name: "fs_read", content: BIG },
    { role: "tool", toolCallId: "c5", name: "fs_read", content: BIG },
  ];
  const res = governToolResults(conv as never, CONV);
  // 600 > 450 → 卸两条（600→500→400）。旧行为（按新旧一刀切）会卸 c0、c1。
  expect(res.offloaded).toBe(2);
  expect(res.cleared).toBe(0);
  expect(conv[1].content, "c0 参数独一无二，被保住").toBe(BIG);
  expect(conv[2].content.includes("已卸载到工作区文件"), "c1 与 c2 同参数，先卸").toBe(true);
  expect(conv[3].content.includes("已卸载到工作区文件")).toBe(true);
});

/* ── 第 11 批：对齐 CodeBuddy 的 Micro-compact 方案（安全子集） ──────────
 * 参考 `.codebuddy/plans/steps_上下文膨胀优化_Micro-compact___token_闸门___探索折叠__*.md`：
 * 保留最近 N 轮（keep 窗口）+ token 预算压老结果。该项目原方案还做了「保留窗口逐级收窄」的
 * token 闸门，但那会丢最近证据，与本项目的 keep 窗口硬保证冲突，故**不采用**——
 * 收口交给历史压缩。本批只落地：keep 硬下限（已存在，显式化）+ 压缩可观测日志。
 */

test("[G] token 预算只压「keep 之外的老结果」，压到预算内即停，绝不越界丢最近的", () => {
  // 5 条各 ≈250 tok（"x".repeat(1000)），keep=3，预算 450：老结果 index0/1 共 ≈500 > 450，
  // 卸掉这两条后 ≈750 仍 > 450，但已无「keep 之外」的候选，于是**停手**——index2..4（最近 3 条）整组保留，
  // 不为凑预算去动最近证据（收口交给历史压缩）。
  const fat = "x".repeat(1000);
  const conv = Array.from({ length: 5 }, (_, i) => ({
    role: "tool",
    toolCallId: `g${i}`,
    name: `mcp__s__t${i}`,
    content: fat,
  })) as never;
  const res = governToolResults(conv as never, CONV);
  expect(res.cleared).toBe(0);
  expect(res.offloaded).toBe(2);
  expect(conv.slice(2).every((t) => t.content === fat)).toBe(true);
});

test("[F] 静态接线：治理与 key 轮换都走共享实现，不是文档里写一遍、代码里另一遍", () => {
  const chatSrc = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf-8");
  // 排序与判据都来自共享纯函数模块（chat.ts 不得内联另一套顺序）
  expect(chatSrc).toContain('from "./tool-result-governance.js"');
  expect(chatSrc).toContain("orderByRecallCost(");
  expect(chatSrc).toContain("classifyRecall({");
  // 只读判定与执行闸门同一真源
  expect(chatSrc).toContain("resolveToolRisk(name).level === \"read\"");
  // 不可重放只卸不丢
  expect(chatSrc).toContain('if (cls === "irreplaceable") continue;');
  // 第 11 批（对齐 CodeBuddy Micro-compact 的安全子集）：keep 硬下限 + 压缩可观测日志
  expect(chatSrc).toContain("keep 窗口为硬下限");
  expect(chatSrc).toContain("[chat:compact]");
  // 子代理交接是推导产物（task 本身登记为 read，只有 derived 能表达「不可重放」）
  expect(chatSrc).toContain("derived: true");

  const modelSrc = readFileSync(new URL("../src/models.ts", import.meta.url), "utf-8");
  // 换 key 必须先过预算回调
  expect(modelSrc).toContain("spendRetry && !spendRetry()");
  expect(modelSrc).toContain("opts.spendRetry,");
  // 预算回调从 chat.ts 的 run 级预算透传下来（streamCall 参数 → callAgent opts）
  expect(chatSrc).toContain("spendRetry?: () => boolean");
  expect(chatSrc).toContain("canRetry,");
  expect(chatSrc).toContain("systemParts: system, spendRetry }");
});
