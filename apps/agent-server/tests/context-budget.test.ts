// 上下文装配与工具结果治理的单元验证（纯逻辑，不需要网络；fs 卸载会写本地文件，结尾清理）。
// 阈值在 vitest.config.ts 的 test.env 中固定。
import { test, expect } from "vitest";
import { governToolResults } from "../src/chat.js";
import { assembleContext, renderHandles } from "../src/history.js";
import { estimateTokens } from "../src/models.js";
import { fsRead, fsRemoveConversation } from "../src/fs-store.js";

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

test("[1] renderHandles", () => {
  const text = renderHandles([{ name: "mcp__x__list", args: '{"a":1}', summary: "3 行 / 12 字符" }]);
  expect(text.includes("mcp__x__list")).toBe(true);
  expect(text.includes('{"a":1}')).toBe(true);
  expect(text.includes("3 行 / 12 字符")).toBe(true);
  expect(renderHandles([])).toBe("");
  expect(renderHandles(undefined)).toBe("");
});

test("[2] assembleContext（窗口 + 预算 + 首条必须 user）", async () => {
  const messages = Array.from({ length: 10 }, (_, i) => pair(i)).flat();
  const r = await assembleContext({ history: messages as never, userText: "现在的问题", budgetTokens: 1_000_000 });
  expect(r.turns.length).toBe(17);
  expect(r.turns[0].role).toBe("user");
  expect(r.turns[r.turns.length - 1].content).toBe("现在的问题");
  expect(r.usage.dropped).toBe(0);
  expect(r.usage.summarized).toBe(false);
  expect(r.summary).toBe("");

  const odd = [
    ...Array.from({ length: 9 }, (_, i) => pair(i)).flat(),
    { role: "user", text: "孤立的 user" },
  ];
  const r2 = await assembleContext({ history: odd as never, userText: "问", budgetTokens: 1_000_000 });
  expect(r2.turns[0].role).toBe("user");

  const budget1 = Array.from({ length: 5 }, (_, i) => pair(i)).flat();
  const r3 = await assembleContext({ history: budget1 as never, userText: "问", budgetTokens: 1 });
  expect(r3.turns.length).toBe(1);
  expect(r3.turns[0].content).toBe("问");

  const withHandle = [
    { role: "user", text: "查数据" },
    { role: "assistant", text: "查完了", handles: [{ name: "mcp__bi__x", args: "{}", summary: "2 行 / 9 字符" }] },
  ];
  const r4 = await assembleContext({ history: withHandle as never, userText: "继续", budgetTokens: 1_000_000 });
  expect(r4.turns[1].content.includes("[本轮已执行的工具]")).toBe(true);
  expect(r4.turns[1].content.includes("mcp__bi__x")).toBe(true);

  const table = Array.from({ length: 30 }, (_, i) => `| 行${i} | ${i} |`).join("\n");
  const withTable = [
    { role: "user", text: "看表格" },
    { role: "assistant", text: `| 列 | 值 |\n|---|---|\n${table}` },
  ];
  const r5 = await assembleContext({ history: withTable as never, userText: "问", budgetTokens: 1_000_000 });
  expect(r5.usage.pruned).toBe(true);
  expect(r5.turns[1].content.includes("表格已折叠")).toBe(true);
});

test("[3] assembleContext（超预算 → LLM 摘要 + 水位线）", async () => {
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
  const budget = estimateTokens(big) * 8;
  const r1 = await assembleContext({ history: messages as never, userText: "现在的问题", budgetTokens: budget, compact });
  expect(r1.usage.compacted).toBe(true);
  expect(r1.usage.summarized).toBe(true);
  expect(r1.summaryCovered).toBeGreaterThan(0);
  expect(r1.usage.dropped).toBe(0);
  expect(r1.turns[0].role).toBe("user");

  const grown = [...messages, { role: "user", text: "追问" }, { role: "assistant", text: `回答:${big}` }];
  const r2 = await assembleContext({
    history: grown as never,
    userText: "最新问题",
    budgetTokens: budget,
    summary: r1.summary,
    summaryCovered: r1.summaryCovered,
    compact,
  });
  expect(r2.summaryCovered).toBeGreaterThanOrEqual(r1.summaryCovered);
  expect(r2.usage.summarized).toBe(true);

  const big2 = "x".repeat(600);
  const degraded = Array.from({ length: 12 }, (_, i) => pair(i)).flat().map((t) => ({ ...t, text: `${t.text}${big2}` }));
  const r3 = await assembleContext({
    history: degraded as never,
    userText: "问",
    budgetTokens: estimateTokens(big2) * 2,
    compact: async () => "",
  });
  expect(r3.usage.compacted).toBe(false);
  expect(r3.usage.dropped).toBeGreaterThan(0);
});

test("[4] governToolResults（本轮工具结果治理：卸载到工作区）", () => {
  const CONV = "ctx-budget-test";
  const big = "x".repeat(400); // ≈100 token/条
  expect(estimateTokens(big)).toBe(100);

  const conv = Array.from({ length: 5 }, (_, i) => ({ role: "tool", name: `t${i}`, content: big })) as FakeTurn[];
  const result = governToolResults(conv as never, CONV);
  expect(result.cleared + result.offloaded).toBe(2);
  expect(conv.slice(2).every((t) => t.content === big)).toBe(true);
  expect(result.offloaded).toBe(2);
  expect(conv[0].content.includes("已卸载到工作区文件")).toBe(true);
  const match = conv[0].content.match(/results\/[^\s]+\.txt/);
  expect(match).toBeTruthy();
  if (match) {
    const file = fsRead(CONV, match[0]);
    expect("content" in file && file.content === big).toBe(true);
  }

  const small = "y".repeat(8);
  const conv2 = Array.from({ length: 5 }, () => ({ role: "tool", name: "t", content: small })) as FakeTurn[];
  const result2 = governToolResults(conv2 as never, CONV);
  expect(result2.cleared).toBe(0);
  expect(result2.offloaded).toBe(0);

  const conv3 = [
    { role: "tool", name: "keepme", content: big },
    ...Array.from({ length: 4 }, () => ({ role: "tool", name: "other", content: big })),
  ] as FakeTurn[];
  const result3 = governToolResults(conv3 as never, CONV);
  expect(conv3[0].content).toBe(big);
  expect(result3.cleared + result3.offloaded).toBeGreaterThanOrEqual(1);

  const conv4 = [{ role: "user", content: big }] as FakeTurn[];
  const result4 = governToolResults(conv4 as never, CONV);
  expect(result4.cleared).toBe(0);
  expect(result4.offloaded).toBe(0);

  fsRemoveConversation(CONV); // 清理测试写入的工作区文件
});
