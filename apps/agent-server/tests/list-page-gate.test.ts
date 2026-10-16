import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "vitest";
import { admitDirectListCall, isSequentialStep, listPagingOffset, releaseDirectListCall, rememberDirectListPage } from "../src/list-page-gate.js";
import { execBuiltin } from "../src/builtins.js";
import { runToolCode } from "../src/tool-code.js";

const LIST = "mcp__zoho-salesiq__ZohoSalesIQ_getConversationsList";

test("分页参数决定闸门，不看工具名", () => {
  const seen = new Set<string>();
  expect(listPagingOffset(JSON.stringify({ query_params: { index: 99 } }))).toBe(99);
  expect(listPagingOffset(JSON.stringify({ page: 2 }))).toBe(2);
  expect(listPagingOffset(JSON.stringify({ cursor: "tok" }))).toBeGreaterThan(0);
  const first = JSON.stringify({ query_params: { index: 0, from_time: 1 } });
  expect(admitDirectListCall(LIST, first, seen)).toBeNull();
  expect(admitDirectListCall(LIST, JSON.stringify({ query_params: { index: 99, from_time: 1 } }), seen)).toContain("count_list_by_time");
  expect(admitDirectListCall(LIST, JSON.stringify({ query_params: { from_time: 1 } }), seen)).toContain("run_tool_code");
  expect(admitDirectListCall(LIST, JSON.stringify({ query_params: { index: 0, from_time: 2 } }), seen)).toContain("已拒绝继续直接翻页");
  expect(admitDirectListCall(LIST, JSON.stringify({ id: "conv-1" }), seen)).toBeNull();
  expect(admitDirectListCall("mcp__other__list", JSON.stringify({ index: 99 }), seen)).toContain("已拒绝继续直接翻页");
  expect(admitDirectListCall("mcp__other__get", JSON.stringify({ id: "a" }), seen)).toBeNull();
  expect(admitDirectListCall("mcp__other__get", JSON.stringify({ id: "b" }), seen)).toBeNull();
  expect(listPagingOffset(JSON.stringify({ after: "2026-09-01", limit: 10 }))).toBe(0);
  expect(listPagingOffset(JSON.stringify({ skip: true }))).toBe(0);
  expect(listPagingOffset(JSON.stringify({ page: "home" }))).toBe(0);
  const reordered = new Set<string>();
  expect(admitDirectListCall("mcp__crm__list", JSON.stringify({ query_params: { b: 1, limit: 10, a: 2 } }), reordered)).toBeNull();
  expect(admitDirectListCall("mcp__crm__list", JSON.stringify({ query_params: { a: 2, b: 1 } }), reordered)).toContain("已拒绝继续直接翻页");
  const bare = new Set<string>();
  const probe = JSON.stringify({ query_params: { from_time: 1 } });
  expect(admitDirectListCall(LIST, probe, bare)).toBeNull();
  rememberDirectListPage(LIST, probe, JSON.stringify({ data: [{ id: "1" }], more_data_available: true }), bare);
  expect(admitDirectListCall(LIST, probe, bare)).toContain("已拒绝继续直接翻页");

  const fresh = new Set<string>();
  const args = JSON.stringify({ query_params: { limit: 99, from_time: 1 } });
  expect(admitDirectListCall("mcp__crm__listDeals", args, fresh)).toBeNull();
  expect(admitDirectListCall("mcp__crm__listDeals", args, fresh)).toContain("已拒绝继续直接翻页");
  releaseDirectListCall("mcp__crm__listDeals", args, fresh);
  expect(admitDirectListCall("mcp__crm__listDeals", args, fresh)).toBeNull();
});

test("决策(c)（2026-10-15）：列表工具换【不同字符串筛选】再查一次放行（多角度探查），但同筛选重试仍拒", () => {
  // 旧版"工具槽"把换筛选也拒掉 → 模型放弃多来源核对、以「库里没有」收尾（与"答不全"相关）。
  // 现改为结构化判据：categorical 字符串换值属"不同筛选"放行；时间切片（单叶数值递增）仍拒。
  const seen = new Set<string>();
  expect(admitDirectListCall(LIST, JSON.stringify({ query_params: { search: "alpha", limit: 50 } }), seen)).toBeNull();
  expect(admitDirectListCall(LIST, JSON.stringify({ query_params: { search: "beta", limit: 50 } }), seen)).toBeNull();
  expect(admitDirectListCall(LIST, JSON.stringify({ query_params: { search: "alpha", limit: 50 } }), seen)).toContain(
    "已拒绝继续直接翻页",
  );
});

test("决策(c) 预算封顶：超过 LIST_PROBE_BUDGET 组不同筛选后拒绝并导向聚合工具", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 4; i++) {
    expect(
      admitDirectListCall(LIST, JSON.stringify({ query_params: { channel: `c${i}`, limit: 50 } }), seen),
    ).toBeNull();
  }
  expect(
    admitDirectListCall(LIST, JSON.stringify({ query_params: { channel: "c9", limit: 50 } }), seen),
  ).toContain("已拒绝继续直接探查");
});

test("决策(c) 回归锚点：时间切片 from_time:1→2 仍拒绝，但不靠参数名（单叶数值递增判据）", () => {
  const seen = new Set<string>();
  expect(admitDirectListCall(LIST, JSON.stringify({ query_params: { index: 0, from_time: 1 } }), seen)).toBeNull();
  expect(admitDirectListCall(LIST, JSON.stringify({ query_params: { index: 0, from_time: 2 } }), seen)).toContain(
    "已拒绝继续直接翻页",
  );
});

test("[2d] 单叶数值步进检测：不碰参数名，任意数值叶递增都判为步进；字符串换值/多叶/相同都不算", () => {
  expect(isSequentialStep(JSON.stringify({ a: 1 }), JSON.stringify({ a: 2 }))).toBe(true);
  expect(isSequentialStep(JSON.stringify({ q: { t: 10 } }), JSON.stringify({ q: { t: 11 } }))).toBe(true);
  expect(isSequentialStep(JSON.stringify({ country: "IN" }), JSON.stringify({ country: "US" }))).toBe(false);
  // 单叶数值递增（即使还有另一个未变的叶）仍判为步进。
  expect(isSequentialStep(JSON.stringify({ a: 1, b: 2 }), JSON.stringify({ a: 1, b: 3 }))).toBe(true);
  // 多叶同时变化才算"不同筛选"，放行交由预算处理。
  expect(isSequentialStep(JSON.stringify({ a: 1, b: 2 }), JSON.stringify({ a: 5, b: 3 }))).toBe(false);
  expect(isSequentialStep(JSON.stringify({ a: 1 }), JSON.stringify({ a: 1 }))).toBe(false);
  // 递减不算步进（不会无限向前拉）。
  expect(isSequentialStep(JSON.stringify({ a: 3 }), JSON.stringify({ a: 2 }))).toBe(false);
});

test("代码里调只读工具时，明细留在进程里，模型只看到聚合输出", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bx-tool-code-"));
  try {
    const out = await runToolCode({
      language: "node",
      cwd: dir,
      timeoutMs: 20_000,
      code: `
        const page = await callTool("mcp__demo__list", { index: 0 });
        const rows = JSON.parse(page).data;
        console.log("unique:" + rows.length);
        console.log("secret-row-should-not-matter");
      `,
      callTool: async (name, args) => {
        expect(name).toBe("mcp__demo__list");
        expect(args.index).toBe(0);
        return {
          ok: true,
          text: JSON.stringify({ data: [{ id: "a", blob: "X".repeat(5000) }, { id: "b" }] }),
        };
      },
    });
    expect(out.ok).toBe(true);
    expect(out.text).toContain("unique:2");
    expect(out.text).not.toContain("X".repeat(200));
    expect(readdirSync(dir).some((name) => name.startsWith("_bx_tool") || name.startsWith("tool_code"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("没调用工具的代码不能当成事实，写工具从代码里会被拒绝", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bx-tool-code-"));
  try {
    const bare = await runToolCode({
      language: "node",
      cwd: dir,
      timeoutMs: 20_000,
      code: `console.log("hours over 300: 0");`,
      callTool: async () => ({ ok: true, text: "unused" }),
    });
    expect(bare.ok).toBe(false);
    expect(bare.text).toContain("不能当作事实");

    const denied = await execBuiltin(
      "run_tool_code",
      JSON.stringify({
        language: "node",
        code: `await callTool("run_script", { code: "echo hi" });`,
      }),
      "conv_tool_code",
      "generic",
      undefined,
      undefined,
      {
        callTool: async (name) => ({ ok: false, text: `host saw ${name}` }),
      },
    );
    expect(denied?.ok).toBe(false);
    expect(denied?.text).toContain("不能从代码里调用 run_script");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
