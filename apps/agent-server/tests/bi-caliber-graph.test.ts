import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { buildCaliberGraph, buildCaliberContext, tokenize } from "../scripts/bi-caliber-graph.mjs";

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("../tests/bi-golden-set.json", import.meta.url)), "utf8"),
);
const knownRaw = JSON.parse(
  readFileSync(fileURLToPath(new URL("../tests/bi-known-tables.json", import.meta.url)), "utf8"),
);
const known = Array.isArray(knownRaw) ? knownRaw : knownRaw.tables;

describe("bi-caliber-graph (P3 口径语义图)", () => {
  test("用真实 97 卡片构建图，节点/边为正且表名全 canonical", () => {
    const g = buildCaliberGraph(golden.cases, { knownTables: known });
    expect(g.cardNodes.size).toBeGreaterThan(50);
    expect(g.tableNodes.size).toBeGreaterThan(5);
    expect(g.tableCo.size).toBeGreaterThan(3);
    // 所有表节点都是带 schema 的 canonical 形式（含 "."），无裸名分裂
    for (const t of g.tableNodes.keys()) expect(t).toMatch(/\./);
  });

  test("检索「观影过AK2」命中对应卡片并推荐观影核心表", () => {
    const g = buildCaliberGraph(golden.cases, { knownTables: known });
    const ctx = buildCaliberContext(g, "观影过AK2", { k: 3 });
    expect(ctx.matchedCards.some((c) => c.id === 100)).toBe(true);
    expect(ctx.tables.length).toBeGreaterThan(0);
    expect(ctx.tables.some((t) => t.table === "film_report.elt_watch_detail")).toBe(true);
    expect(ctx.joinHints.length).toBeGreaterThan(0);
  });

  test("表检索文本：卡片没覆盖的表也能凭字段描述里的业务词进候选，常见词权重低", () => {
    const cards = [{ id: 1, name: "订单数", expected_sql: "SELECT 1", tables: ["s.order"] }];
    const tableTexts = {
      "s.order": "订单的唯一标识 用户",
      "s.unsub": "退订原因 用户",
    };
    const g = buildCaliberGraph(cards, { knownTables: ["s.order", "s.unsub"], tableTexts });
    const hit = buildCaliberContext(g, "用户退订原因分布");
    expect(hit.tables[0]).toMatchObject({ table: "s.unsub", direct: 0, text: 1 });
    const off = buildCaliberContext(g, "用户退订原因分布", { textWeight: 0 });
    expect(off.tables.some((t) => t.table === "s.unsub")).toBe(false);
  });

  test("tables 只分层不截断：前 primaryTables 张为 primary，其余 candidate", () => {
    const g = buildCaliberGraph(golden.cases, { knownTables: known });
    const ctx = buildCaliberContext(g, "会员订单 地区 设备", { primaryTables: 3 });
    expect(ctx.tables.length).toBeGreaterThan(3);
    expect(ctx.tables.slice(0, 3).every((t) => t.tier === "primary")).toBe(true);
    expect(ctx.tables.slice(3).every((t) => t.tier === "candidate")).toBe(true);
  });

  test("裸名与全名归一为同一节点（不分裂图）", () => {
    const cards = [
      { id: 1, name: "A", expected_sql: "select 1", tables: ["film_report.elt_x"] },
      { id: 2, name: "B", expected_sql: "select 1", tables: ["elt_x"] },
    ];
    const g = buildCaliberGraph(cards, { knownTables: ["film_report.elt_x", "elt_x"] });
    expect(g.tableNodes.size).toBe(1);
    expect([...g.tableNodes.keys()]).toEqual(["film_report.elt_x"]);
  });

  test("无 SQL 的卡片不入图（白名单 fail-open）", () => {
    const cards = [
      { id: 1, name: "有SQL", expected_sql: "select 1", tables: ["film_report.elt_a"] },
      { id: 2, name: "无SQL", expected_sql: "", tables: [] },
      { id: 3, name: "噪声表", expected_sql: "select 1", tables: ["not_in_whitelist_xyz"] },
    ];
    const g = buildCaliberGraph(cards, { knownTables: ["film_report.elt_a"] });
    expect(g.cardNodes.has(1)).toBe(true);
    expect(g.cardNodes.has(2)).toBe(false); // 无 SQL 跳过
    expect(g.cardNodes.has(3)).toBe(false); // 表不在白名单，过滤后无表，跳过
  });

  test("tokenize 中英混合：英文整词 + 中文 bigram", () => {
    const t = tokenize("拉新用户 elt_film_order");
    expect(t.has("elt_film_order")).toBe(true);
    expect(t.has("拉新") || t.has("新用") || t.has("用户")).toBe(true);
    expect(t.size).toBeGreaterThan(2);
  });

  test("空查询返回空结果且不抛错", () => {
    const g = buildCaliberGraph(golden.cases, { knownTables: known });
    const ctx = buildCaliberContext(g, "   ", {});
    expect(ctx.matchedCards).toEqual([]);
    expect(ctx.note).toMatch(/无法检索/);
  });
});
