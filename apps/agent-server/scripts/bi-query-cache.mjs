// 轻量进程内查询缓存：对「相同 database_id + 规范化 SQL + limit」的重复取数做去重，
// 直接返回缓存结果，避免同一重查询在短时间窗口内被反复下发到 ClickHouse
// （对应文档 6.5.2，治 R4「同一会话连续 N 条 uniqExact 反复换口径 / 重试同一爆库查询」）。
//
// 设计取舍：
// - 非持久、非跨进程：MCP server 重启即清空，符合 ad-hoc 分析语义（数据以源为准，缓存仅省重跑）。
// - 默认开启，env BI_QUERY_CACHE_ENABLED=false 可关；TTL 默认 60s（BI_QUERY_CACHE_TTL_MS），
//   短 TTL 保证 ad-hoc 数据新鲜度，同时足够去重「瞬时重试 / 反复换同一口径」。
// - 仅缓存成功结果（ok 且无上游错误），失败不缓存避免缓存错误。
// - 容量上限（默认 200 条）惰性淘汰最旧条目，防止长会话内存膨胀。

/**
 * 构造一个进程内查询缓存。
 * @param {object} [opts]
 * @param {number} [opts.ttlMs=60000]   缓存条目存活时间（毫秒）
 * @param {number} [opts.maxEntries=200] 容量上限，超出惰性淘汰最旧条目
 * @param {boolean} [opts.enabled=true] 是否启用（关闭后 get 永远 miss、set 为 no-op）
 */
export function makeQueryCache({ ttlMs = 60_000, maxEntries = 200, enabled = true } = {}) {
  const store = new Map(); // key -> { expires, payload }

  function keyOf(database_id, sql, limit) {
    // 折叠空白并 trim，使「仅空白差异」的同一 SQL 也能命中；limit 不同视为不同查询。
    return `${database_id} ${Number(limit) || 0} ${String(sql ?? "").replace(/\s+/g, " ").trim()}`;
  }

  function get(database_id, sql, limit) {
    if (!enabled) return undefined;
    const k = keyOf(database_id, sql, limit);
    const hit = store.get(k);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) {
      store.delete(k);
      return undefined;
    }
    return hit.payload;
  }

  function set(database_id, sql, limit, payload) {
    if (!enabled) return;
    const k = keyOf(database_id, sql, limit);
    store.set(k, { expires: Date.now() + ttlMs, payload });
    if (store.size > maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
  }

  function clear() {
    store.clear();
  }

  return { get, set, clear, keyOf, size: () => store.size, isEnabled: () => enabled };
}

/** 从环境变量构造缓存（供 metabase-mcp.mjs 直接调用）。 */
export function createQueryCacheFromEnv(env = process.env) {
  const enabled = env["BI_QUERY_CACHE_ENABLED"] !== "false";
  const ttlMs = Number(env["BI_QUERY_CACHE_TTL_MS"] || 60_000);
  const maxEntries = Number(env["BI_QUERY_CACHE_MAX_ENTRIES"] || 200);
  return makeQueryCache({
    enabled,
    ttlMs: Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 60_000,
    maxEntries: Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : 200,
  });
}
