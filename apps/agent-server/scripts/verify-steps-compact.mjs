/**
 * 验证 steps 只读投影压缩（Micro-compact 方案）：断言 5 类语义。
 * 运行：cd apps/agent-server && .\node_modules\.bin\tsx.cmd scripts/verify-steps-compact.mjs
 * ① 旧轮次 toolResult 替换占位符（保留最近 3 轮完整）
 * ② 数据类白名单（call_api/normalize_output/render_table）最近一次完整保留（即使在窗口外）
 * ③ toolCalls（assistant 推理轨迹）与 system 全保留不动
 * ④ 预算超限时保留窗口逐级回退（3→2→1），注入量硬上限
 * ⑤ 消息配对不破坏：不删任何消息（steps.length 不变，toolResult 仍对应 toolCallId）
 */
import { compactStepsForModel, estimateStepsChars } from "../src/chat.ts";

let pass = 0;
let fail = 0;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  ok ? pass++ : fail++;
};

// ---- 构造模拟 steps：4 轮工具循环 ----
// 轮1: search_api_module（探索）+ submit_understood_intent（理解）
// 轮2: read_api_module（探索，大输出）
// 轮3: grep_codebase（探索，大输出）
// 轮4: call_api（数据类，大输出，渲染用）
const mk = (kind, extra = {}) => ({ kind, ...extra });
const steps = [
  mk("system", { text: "[workflow/agent] 常驻规则与项目上下文…" }),
  // 轮 1
  mk("toolCalls", { calls: [
    { id: "c1", name: "search_api_module", arguments: { query: "账号合并" } },
    { id: "c2", name: "submit_understood_intent", arguments: { module: "user/account_merge" } },
  ] }),
  mk("toolResult", { toolCallId: "c1", content: "候选: user/account_merge（翻译表反查）".repeat(50) }),
  mk("toolResult", { toolCallId: "c2", content: "理解已提交 module=user/account_merge" }),
  // 轮 2
  mk("toolCalls", { calls: [
    { id: "c3", name: "read_api_module", arguments: { module: "user/account_merge" } },
  ] }),
  mk("toolResult", { toolCallId: "c3", content: "export async function getMergeLogs(params: {...}) {...}".repeat(80) }),
  // 轮 3
  mk("toolCalls", { calls: [
    { id: "c4", name: "grep_codebase", arguments: { pattern: "merge" } },
  ] }),
  mk("toolResult", { toolCallId: "c4", content: "src/views/account/merge/index.vue:10 ...".repeat(60) }),
  // 轮 4（数据类）
  mk("toolCalls", { calls: [
    { id: "c5", name: "call_api", arguments: { module: "user/account_merge", op: "getMergeLogs" } },
  ] }),
  mk("toolResult", { toolCallId: "c5", content: "UI_TABLE\naccountId|accountName|mergeTime\n...".repeat(120) }),
];

const compacted = compactStepsForModel(steps);

// ① 旧轮次（轮1/轮2）工具结果替换占位符；最近 3 轮（轮2/轮3/轮4）完整
// 轮次归属：轮1=c1/c2，轮2=c3，轮3=c4，轮4=c5。keep=3 → 保留 轮2(c3)/轮3(c4)/轮4(c5)
const byId = new Map(compacted.filter((s) => s.kind === "toolResult").map((s) => [s.toolCallId, s.content]));
check("① 轮1 search_api_module 旧结果被替换为占位符", /\[Previous: used search_api_module\]/.test(byId.get("c1") || ""), byId.get("c1")?.slice(0, 60));
check("① 轮1 submit_understood_intent 旧结果被替换为占位符", /\[Previous: used submit_understood_intent\]/.test(byId.get("c2") || ""), byId.get("c2")?.slice(0, 60));
check("① 轮2 read_api_module 在最近3轮内保留完整", (byId.get("c3") || "").startsWith("export async function"), (byId.get("c3") || "").length);
check("① 轮3 grep_codebase 在最近3轮内保留完整", (byId.get("c4") || "").startsWith("src/views/account"), (byId.get("c4") || "").length);

// ② 数据类白名单最近一次（轮4 call_api）完整保留
check("② 数据类 call_api 结果完整保留（不折叠）", (byId.get("c5") || "").startsWith("UI_TABLE"), (byId.get("c5") || "").length);

// ③ toolCalls / system 全保留不动
const keptToolCalls = compacted.filter((s) => s.kind === "toolCalls");
check("③ 4 组 toolCalls 推理轨迹全部保留", keptToolCalls.length === 4 && keptToolCalls.every((s, i) => s.calls[0].id === steps.filter((x) => x.kind === "toolCalls")[i].calls[0].id), `toolCalls=${keptToolCalls.length}`);
check("③ system 步骤保留", compacted.filter((s) => s.kind === "system").length === steps.filter((s) => s.kind === "system").length);

// ④ 预算回退：逐级缩减窗口（3→2→1），注入量收敛；白名单（防伪 tool_call 的硬约束）优先于预算保留
// 中间预算 10000 → 应回退到 2 轮（保留轮3 grep + 轮4 call_api，折叠轮1/轮2）
const mid = compactStepsForModel(steps, { charBudget: 10000 });
const midById = new Map(mid.filter((s) => s.kind === "toolResult").map((s) => [s.toolCallId, s.content]));
check("④ 中间预算回退到 2 轮：c3 read_api_module 折叠", /\[Previous: used read_api_module\]/.test(midById.get("c3") || ""), midById.get("c3")?.slice(0, 50));
check("④ 中间预算回退到 2 轮：c4 grep 完整", (midById.get("c4") || "").startsWith("src/views/account"), (midById.get("c4") || "").length);
check("④ 中间预算回退后注入量 ≤ 预算", estimateStepsChars(mid) <= 10000, `chars=${estimateStepsChars(mid)}`);
// 超小预算 5000 → 回退到 1 轮（仅白名单 call_api 完整，其余全折叠；白名单 5280 本身超预算故无法更小）
const tiny = compactStepsForModel(steps, { charBudget: 5000 });
const tinyById = new Map(tiny.filter((s) => s.kind === "toolResult").map((s) => [s.toolCallId, s.content]));
check("④ 超小预算回退到 1 轮：c1/c2/c3/c4 全折叠", ["c1", "c2", "c3", "c4"].every((id) => /\[Previous: used/.test(tinyById.get(id) || "")), tinyById.get("c3")?.slice(0, 50));
check("④ 超小预算回退：白名单 call_api 仍完整", (tinyById.get("c5") || "").startsWith("UI_TABLE"), (tinyById.get("c5") || "").length);
check("④ 窗口逐级回退收敛（tiny < mid < 默认压缩）", estimateStepsChars(tiny) < estimateStepsChars(mid) && estimateStepsChars(mid) < estimateStepsChars(compacted), `tiny=${estimateStepsChars(tiny)} mid=${estimateStepsChars(mid)} default=${estimateStepsChars(compacted)}`);

// ⑤ 消息配对不破坏：不删任何消息，且 toolResult 的 toolCallId 全集不变
check("⑤ 消息数量不变（不删消息）", compacted.length === steps.length, `${steps.length} → ${compacted.length}`);
const origIds = new Set(steps.filter((s) => s.kind === "toolResult").map((s) => s.toolCallId));
const compIds = new Set(compacted.filter((s) => s.kind === "toolResult").map((s) => s.toolCallId));
check("⑤ toolResult 的 toolCallId 全集不变（配对保留）", origIds.size === compIds.size && [...origIds].every((id) => compIds.has(id)), `${[...origIds].join(",")}`);

// ---- 真实规模基准：模拟「账号合并」查询的多轮大 steps（read_api_module 接口源码 + call_api 大结果）----
const bigSteps = [];
const bigCalls = [
  { c: "s1", name: "submit_understood_intent", arg: { module: "user/account_merge" } },
  { c: "a1", name: "read_api_module", arg: { module: "user/account_merge" } },
  { c: "g1", name: "grep_codebase", arg: { pattern: "getMergeLogs" } },
  { c: "a2", name: "read_api_module", arg: { module: "user/account_merge" } },
  { c: "r1", name: "read_file", arg: { path: "configs.data.tsx" } },
  { c: "c1", name: "call_api", arg: { module: "user/account_merge", op: "getMergeLogs" } },
  { c: "n1", name: "normalize_output", arg: {} },
  { c: "c2", name: "call_api", arg: { module: "user/account_merge", op: "getMergeLogs", params: { userId: "5585230699772928" } } },
];
bigSteps.push(mk("system", { text: "[workflow/agent] 常驻规则与项目上下文…".repeat(20) }));
let bidx = 0;
for (const { c, name, arg } of bigCalls) {
  bigSteps.push(mk("toolCalls", { calls: [{ id: c, name, arguments: arg }] }));
  // 探索类工具大输出（5-15K），数据类白名单大输出（10-30K）
  const big = name === "call_api" ? `UI_TABLE\nuid|uname|utime\n` .repeat(400) : name === "read_api_module" ? `export async function ${arg.module.split("/").pop()}Detail(params) { return request(...) }`.repeat(200) : `src/views/${arg.module || "x"}/index.vue:123 ...`.repeat(120);
  bigSteps.push(mk("toolResult", { toolCallId: c, content: big }));
  bidx++;
}
const bigCompacted = compactStepsForModel(bigSteps);
const bigBefore = estimateStepsChars(bigSteps);
const bigAfter = estimateStepsChars(bigCompacted);
const bigRatio = Math.round((1 - bigAfter / bigBefore) * 100);
console.log(`\n真实规模基准（${bigSteps.length} 条消息 / ${bigBefore} chars ≈ ${Math.round(bigBefore / 4)} token）→ ${bigAfter} chars ≈ ${Math.round(bigAfter / 4)} token（降 ${bigRatio}%，保持 ${bigCompacted.length}/${bigSteps.length} 条消息）`);
check("真实规模：探索类旧结果折叠（s1/a1/g1/a2/r1）", ["s1", "a1", "g1", "a2", "r1"].every((id) => /\[Previous: used/.test(new Map(bigCompacted.filter((s) => s.kind === "toolResult").map((s) => [s.toolCallId, s.content])).get(id) || "")), "s1/a1/g1/a2/r1 → 占位符");
const bigById = new Map(bigCompacted.filter((s) => s.kind === "toolResult").map((s) => [s.toolCallId, s.content]));
check("真实规模：白名单最近一次完整（c2 call_api）", (bigById.get("c2") || "").startsWith("UI_TABLE"), `c2 len=${(bigById.get("c2") || "").length}`);
check("真实规模：窗口内最近3轮完整（n1/c2，非占位符）", (bigById.get("n1") || "").length > 100 && !/\[Previous: used/.test(bigById.get("n1") || ""), `n1 len=${(bigById.get("n1") || "").length}`);
check("真实规模：消息数量不变", bigCompacted.length === bigSteps.length, `${bigSteps.length} → ${bigCompacted.length}`);

// 汇总
console.log(`\n压缩效果：chars=${estimateStepsChars(steps)} → ${estimateStepsChars(compacted)} (${Math.round((1 - estimateStepsChars(compacted) / estimateStepsChars(steps)) * 100)}%)，保持 ${compacted.length}/${steps.length} 条消息`);
console.log("\n断言明细：");
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? ` | ${r.detail}` : ""}`);
}
console.log(`\n结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
