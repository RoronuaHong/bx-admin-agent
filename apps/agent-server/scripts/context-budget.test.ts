// 上下文预算与工具结果治理的单元验证（纯逻辑，不需要模型/网络）。
// 跑法：cmd /c "cd /d <repo>\apps\agent-server && node --import tsx scripts/context-budget.test.ts"
// 先用环境变量固定阈值，再动态 import（模块级常量在 import 时读取 env）。
process.env.HISTORY_MAX_TURNS = "8";
process.env.MCP_TOOL_RESULT_KEEP = "3";
process.env.MCP_TOOL_RESULT_BUDGET = "200";
process.env.MCP_TOOL_RESULT_PROTECT = "keepme";

const { buildTurns, governToolResults, renderHandles } = await import("../src/chat.js");
const { estimateTokens } = await import("../src/models.js");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

interface FakeTurn {
  role: string;
  name?: string;
  content: string;
  handles?: Array<{ name: string; args?: string; summary?: string }>;
}
const pair = (i: number) => [
  { role: "user", text: `q${i}` },
  { role: "assistant", text: `a${i}` },
];

console.log("[1] renderHandles");
{
  const text = renderHandles([{ name: "mcp__x__list", args: '{"a":1}', summary: "3 行 / 12 字符" }]);
  check(
    "输出含工具名/参数/规模",
    text.includes("mcp__x__list") && text.includes('{"a":1}') && text.includes("3 行 / 12 字符"),
    text,
  );
  check("空句柄返回空串", renderHandles([]) === "" && renderHandles(undefined) === "");
}

console.log("[2] buildTurns（跨轮窗口 + 预算 + 首条必须 user）");
{
  const messages = Array.from({ length: 10 }, (_, i) => pair(i)).flat();
  const r = buildTurns(messages as never, "现在的问题", 1_000_000);
  check("窗口保留 16 条 + 当前输入 = 17", r.turns.length === 17, `len=${r.turns.length}`);
  check("首条是 user", r.turns[0].role === "user", r.turns[0].role);
  check("末条是当前输入", r.turns[r.turns.length - 1].content === "现在的问题");
  check("dropped 计入窗口外的消息", r.dropped === 4, `dropped=${r.dropped}`);
}
{
  // 奇数长度历史会让窗口切片以 assistant 开头，必须被修正
  const messages = [
    ...Array.from({ length: 9 }, (_, i) => pair(i)).flat(),
    { role: "user", text: "孤立的 user" },
  ];
  const r = buildTurns(messages as never, "问", 1_000_000);
  check("奇数历史也被修正为首条 user", r.turns[0].role === "user", r.turns.map((t) => t.role).join(","));
}
{
  const messages = Array.from({ length: 5 }, (_, i) => pair(i)).flat();
  const r = buildTurns(messages as never, "问", 1);
  check("预算不足时只剩当前输入", r.turns.length === 1 && r.turns[0].content === "问", `len=${r.turns.length}`);
  check("不会把当前输入也丢掉", r.turns.length >= 1 && r.turns[r.turns.length - 1].content === "问");
}
{
  const messages = [
    { role: "user", text: "查数据" },
    { role: "assistant", text: "查完了", handles: [{ name: "mcp__bi__x", args: "{}", summary: "2 行 / 9 字符" }] },
  ];
  const r = buildTurns(messages as never, "继续", 1_000_000);
  check(
    "工具句柄被注入该轮内容",
    r.turns[1].content.includes("[本轮已执行的工具]") && r.turns[1].content.includes("mcp__bi__x"),
    r.turns[1].content,
  );
}

console.log("[3] governToolResults（本轮工具结果治理）");
{
  const big = "x".repeat(400); // ≈100 token/条
  check("估算：400 个 ASCII 字符 ≈ 100 token", estimateTokens(big) === 100, `got=${estimateTokens(big)}`);
  const conv = Array.from({ length: 5 }, (_, i) => ({ role: "tool", name: `t${i}`, content: big })) as FakeTurn[];
  const cleared = governToolResults(conv as never);
  check("超预算时从最旧开始清理", cleared === 2, `cleared=${cleared}`);
  check("最近 3 组不被清理", conv.slice(2).every((t) => t.content === big));
  check("被清理处替换为占位文本", cleared > 0 && conv[0].content !== big && conv[0].content.includes("已清理"));
}
{
  const small = "y".repeat(8);
  const conv = Array.from({ length: 5 }, () => ({ role: "tool", name: "t", content: small })) as FakeTurn[];
  check("预算内不做任何清理", governToolResults(conv as never) === 0);
}
{
  const big = "x".repeat(400);
  const conv = [
    { role: "tool", name: "keepme", content: big },
    ...Array.from({ length: 4 }, () => ({ role: "tool", name: "other", content: big })),
  ] as FakeTurn[];
  const cleared = governToolResults(conv as never);
  check("白名单工具不被清理", conv[0].content === big, `cleared=${cleared}`);
  check("白名单以外仍可清理", cleared >= 1, `cleared=${cleared}`);
}
{
  const big = "x".repeat(400);
  const conv = [{ role: "user", content: big }] as FakeTurn[];
  check("无工具结果时不清且不报错", governToolResults(conv as never) === 0);
}

console.log(`\n结果：PASS=${pass} FAIL=${fail}`);
if (fail) process.exit(1);
