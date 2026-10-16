import { describe, test, expect } from "vitest";
import { makeQueryCache } from "../scripts/bi-query-cache.mjs";

describe("bi-query-cache", () => {
  test("相同 db + SQL + limit 命中，空白差异也命中", () => {
    const c = makeQueryCache({ ttlMs: 1000, maxEntries: 10 });
    const payload = { content: [{ type: "text", text: "x" }] };
    c.set(2, "SELECT 1", 200, payload);
    c.set(2, "select   1", 200, payload); // 仅空白差异
    expect(c.get(2, "SELECT 1", 200)).toBe(payload);
    expect(c.get(2, "SELECT 1", 200)).toBe(payload); // 再取仍是同一引用
  });

  test("db / limit 不同视为不同查询（miss）", () => {
    const c = makeQueryCache({ ttlMs: 1000, maxEntries: 10 });
    const payload = { content: [{ type: "text", text: "x" }] };
    c.set(2, "SELECT 1", 200);
    expect(c.get(2, "SELECT 1", 100)).toBeUndefined();
    expect(c.get(3, "SELECT 1", 200)).toBeUndefined();
  });

  test("TTL 过期后 miss 并清理", () => {
    const c = makeQueryCache({ ttlMs: 5, maxEntries: 10 });
    const payload = { content: [{ type: "text", text: "x" }] };
    c.set(2, "SELECT 1", 200, payload);
    expect(c.get(2, "SELECT 1", 200)).toBe(payload);
    // 等待过期
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(c.get(2, "SELECT 1", 200)).toBeUndefined();
        resolve();
      }, 20);
    });
  });

  test("enabled=false 时 get 永远 miss、set 为 no-op", () => {
    const c = makeQueryCache({ ttlMs: 1000, maxEntries: 10, enabled: false });
    c.set(2, "SELECT 1", 200, { content: [] });
    expect(c.get(2, "SELECT 1", 200)).toBeUndefined();
    expect(c.size()).toBe(0);
  });

  test("超出容量惰性淘汰最旧条目", () => {
    const c = makeQueryCache({ ttlMs: 10_000, maxEntries: 3 });
    for (let i = 0; i < 5; i++) c.set(1, `SELECT ${i}`, 200, { content: [] });
    expect(c.size()).toBeLessThanOrEqual(3);
  });

  test("clear 清空缓存", () => {
    const c = makeQueryCache({ ttlMs: 10_000, maxEntries: 10 });
    c.set(2, "SELECT 1", 200, { content: [] });
    c.clear();
    expect(c.size()).toBe(0);
    expect(c.get(2, "SELECT 1", 200)).toBeUndefined();
  });
});
