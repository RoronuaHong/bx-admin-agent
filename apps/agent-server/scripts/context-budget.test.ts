// 上下文装配与工具结果治理的单元验证（纯逻辑，不需要网络；fs 卸载会写本地文件，结尾清理）。
// 跑法：cmd /c "cd /d <repo>\apps\agent-server && node --import tsx scripts/context-budget.test.ts"
// 先用环境变量固定阈值，再动态 import（模块级常量在 import 时读取 env）。
process.env.MCP_TOOL_RESULT_KEEP = "3";
process.env.MCP_TOOL_RESULT_BUDGET = "200";
process.env.MCP_TOOL_RESULT_PROTECT = "keepme";
process.env.FS_MAX_FILE_BYTES = String(1024 * 1024);

const { governToolResults } = await import("../src/chat.js");
const { assembleContext, renderHandles } = await import("../src/history.js");
const { estimateTokens } = await import("../src/models.js");
const { fsRead, fsRemoveConversation } = await import("../src/fs-store.js");

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

console.log("[2] assembleContext（窗口 + 预算 + 首条必须 user）");
{
  const messages = Array.from({ length: 10 }, (_, i) => pair(i)).flat();
  const r = await assembleContext({ history: messages as never, userText: "现在的问题", budgetTokens: 1_000_000 });
  check("窗口保留 16 条 + 当前输入 = 17", r.turns.length === 17, `len=${r.turns.length}`);
  check("首条是 user", r.turns[0].role === "user", r.turns[0].role);
  check("末条是当前输入", r.turns[r.turns.length - 1].content === "现在的问题");
  check("窗口外的消息不算 dropped（未触发压缩时只是不在窗口内）", r.usage.dropped === 0, `dropped=${r.usage.dropped}`);
  check("预算内不触发摘要", r.usage.summarized === false && r.summary === "", JSON.stringify(r.usage));
}
{
  // 奇数长度历史会让窗口切片以 assistant 开头，必须被修正
  const messages = [
    ...Array.from({ length: 9 }, (_, i) => pair(i)).flat(),
    { role: "user", text: "孤立的 user" },
  ];
  const r = await assembleContext({ history: messages as never, userText: "问", budgetTokens: 1_000_000 });
  check("奇数历史也被修正为首条 user", r.turns[0].role === "user", r.turns.map((t) => t.role).join(","));
}
{
  const messages = Array.from({ length: 5 }, (_, i) => pair(i)).flat();
  const r = await assembleContext({ history: messages as never, userText: "问", budgetTokens: 1 });
  check("预算不足且无摘要回调时只剩当前输入", r.turns.length === 1 && r.turns[0].content === "问", `len=${r.turns.length}`);
  check("不会把当前输入也丢掉", r.turns.length >= 1 && r.turns[r.turns.length - 1].content === "问");
}
{
  const messages = [
    { role: "user", text: "查数据" },
    { role: "assistant", text: "查完了", handles: [{ name: "mcp__bi__x", args: "{}", summary: "2 行 / 9 字符" }] },
  ];
  const r = await assembleContext({ history: messages as never, userText: "继续", budgetTokens: 1_000_000 });
  check(
    "工具句柄被注入该轮内容",
    r.turns[1].content.includes("[本轮已执行的工具]") && r.turns[1].content.includes("mcp__bi__x"),
    r.turns[1].content,
  );
}
{
  // 长表格折叠（无损裁剪）
  const table = Array.from({ length: 30 }, (_, i) => `| 行${i} | ${i} |`).join("\n");
  const messages = [
    { role: "user", text: "看表格" },
    { role: "assistant", text: `| 列 | 值 |\n|---|---|\n${table}` },
  ];
  const r = await assembleContext({ history: messages as never, userText: "问", budgetTokens: 1_000_000 });
  check("长表格被折叠", r.usage.pruned === true && r.turns[1].content.includes("表格已折叠"), JSON.stringify(r.usage));
}

console.log("[3] assembleContext（超预算 → LLM 摘要 + 水位线）");
{
  const big = "x".repeat(600); // ≈150 token/条
  const messages = Array.from({ length: 12 }, (_, i) => [
    { role: "user", text: `问题${i}:${big}` },
    { role: "assistant", text: `回答${i}:${big}` },
  ]).flat();
  let compactCalls = 0;
  const compact = async (prompt: string) => {
    compactCalls += 1;
    return `摘要#${compactCalls}（含 ${prompt.includes("已有摘要") ? "旧摘要" : "首轮"}）`;
  };
  // 预算只够 ~8 条：必须吸收更早的轮次进摘要
  const budget = estimateTokens(big) * 8;
  const r1 = await assembleContext({
    history: messages as never,
    userText: "现在的问题",
    budgetTokens: budget,
    compact,
  });
  check("发生 LLM 压缩", r1.usage.compacted === true, JSON.stringify(r1.usage));
  check("发送时带摘要", r1.usage.summarized === true, JSON.stringify(r1.usage));
  check("水位线前移（吸收了窗口外的消息）", r1.summaryCovered > 0, `covered=${r1.summaryCovered}`);
  check("摘要不计入 dropped", r1.usage.dropped === 0, `dropped=${r1.usage.dropped}`);
  check("首条仍是 user", r1.turns[0].role === "user", r1.turns[0].role);

  // 第二轮：同一份（已增长的历史）+ 已有摘要 → 水位线之前的消息不重复压缩
  const grown = [...messages, { role: "user", text: "追问" }, { role: "assistant", text: `回答:${big}` }];
  const r2 = await assembleContext({
    history: grown as never,
    userText: "最新问题",
    budgetTokens: budget,
    summary: r1.summary,
    summaryCovered: r1.summaryCovered,
    compact,
  });
  check("水位线被沿用（covered 只增不减）", r2.summaryCovered >= r1.summaryCovered, `covered=${r2.summaryCovered}`);
  check("增量压缩后仍在预算内或仅少量丢弃", r2.usage.summarized === true, JSON.stringify(r2.usage));
}
{
  // 摘要回调失败 → 退化为硬丢弃，不报错
  const big = "x".repeat(600);
  const messages = Array.from({ length: 12 }, (_, i) => pair(i)).flat().map((t) => ({ ...t, text: `${t.text}${big}` }));
  const r = await assembleContext({
    history: messages as never,
    userText: "问",
    budgetTokens: estimateTokens(big) * 2,
    compact: async () => "",
  });
  check("压缩失败时退化为丢弃", r.turns.length >= 1 && r.usage.compacted === false, JSON.stringify(r.usage));
  check("退化为丢弃时 dropped > 0", r.usage.dropped > 0, `dropped=${r.usage.dropped}`);
}

console.log("[4] governToolResults（本轮工具结果治理：卸载到工作区）");
const CONV = "ctx-budget-test";
{
  const big = "x".repeat(400); // ≈100 token/条
  check("估算：400 个 ASCII 字符 ≈ 100 token", estimateTokens(big) === 100, `got=${estimateTokens(big)}`);
  const conv = Array.from({ length: 5 }, (_, i) => ({ role: "tool", name: `t${i}`, content: big })) as FakeTurn[];
  const result = governToolResults(conv as never, CONV);
  check("超预算时处理了 2 条", result.cleared + result.offloaded === 2, JSON.stringify(result));
  check("最近 3 组不被处理", conv.slice(2).every((t) => t.content === big));
  check("被处理处替换为卸载指针", result.offloaded === 2 && conv[0].content.includes("已卸载到工作区文件"), conv[0].content);
  const match = conv[0].content.match(/results\/[^\s]+\.txt/);
  check("指针路径可被 fs_read 读回原文", Boolean(match) && (() => {
    const file = fsRead(CONV, match![0]);
    return "content" in file && file.content === big;
  })(), conv[0].content);
}
{
  const small = "y".repeat(8);
  const conv = Array.from({ length: 5 }, () => ({ role: "tool", name: "t", content: small })) as FakeTurn[];
  const result = governToolResults(conv as never, CONV);
  check("预算内不做任何处理", result.cleared === 0 && result.offloaded === 0, JSON.stringify(result));
}
{
  const big = "x".repeat(400);
  const conv = [
    { role: "tool", name: "keepme", content: big },
    ...Array.from({ length: 4 }, () => ({ role: "tool", name: "other", content: big })),
  ] as FakeTurn[];
  const result = governToolResults(conv as never, CONV);
  check("白名单工具不被处理", conv[0].content === big, `cleared=${result.cleared}`);
  check("白名单以外仍会处理", result.cleared + result.offloaded >= 1, JSON.stringify(result));
}
{
  const big = "x".repeat(400);
  const conv = [{ role: "user", content: big }] as FakeTurn[];
  const result = governToolResults(conv as never, CONV);
  check("无工具结果时不清且不报错", result.cleared === 0 && result.offloaded === 0, JSON.stringify(result));
}
fsRemoveConversation(CONV); // 清理测试写入的工作区文件

console.log(`\n结果：PASS=${pass} FAIL=${fail}`);
if (fail) process.exit(1);
