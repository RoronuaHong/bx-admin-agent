// few-shot join 样例库（§4.3-4）：从已保存提问（卡片）的真实 SQL 抽 JOIN 路径，
// 按涉及表建索引，作为「自然语言 → 正确 join 写法」的样例，供模型写多表 SQL 时参考。
// 纯元数据、零 LLM、纯函数可测；不解析 SQL 语义，只抽结构片段（宁可少给也不编造）。
import { extractTables, filterKnownTables, normalizeKnownTables } from "./metabase-card-graph.mjs";

// 匹配 `[LEFT|INNER|...] JOIN <table>`。只取 JOIN 后首个标识符（可能是 CTE 名，交给白名单过滤）。
const JOIN_HEAD = /\b((?:LEFT|RIGHT|INNER|FULL|CROSS|ANY|ALL|ASOF)\s+)?JOIN\s+([`"]?[\w]+[`"]?(?:\.[`"]?[\w]+[`"]?)?)/gi;
// ON 片段的终止边界：下一个 JOIN / 主要子句 / 语句结尾。
const CLAUSE_END = /\b(?:(?:LEFT|RIGHT|INNER|FULL|CROSS|ANY|ALL|ASOF)\s+)?JOIN\b|\bWHERE\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|\bUNION\b|\bHAVING\b|\bQUALIFY\b/gi;

function cleanName(s) {
  return String(s || "").replace(/[`"]/g, "").trim().toLowerCase();
}

/** 从一条 SQL 抽 JOIN 子句：`[{ type, table, snippet }]`。snippet 为截断后的原文，供 few-shot 参考。 */
export function extractJoins(sql, { snippetLimit = 220 } = {}) {
  if (typeof sql !== "string" || !sql.trim()) return [];
  const out = [];
  let m;
  JOIN_HEAD.lastIndex = 0;
  while ((m = JOIN_HEAD.exec(sql))) {
    const type = (m[1] || "INNER").trim().toUpperCase() || "INNER";
    const table = cleanName(m[2]);
    if (!table) continue;
    // 从 JOIN 起取到下一个子句边界，作为可读的 ON 片段（不做语义解析）。
    const rest = sql.slice(m.index, m.index + snippetLimit + 400);
    CLAUSE_END.lastIndex = m[0].length;
    const end = CLAUSE_END.exec(rest);
    const snippet = rest.slice(0, end ? Math.min(end.index, snippetLimit) : snippetLimit).trim();
    // ON 条件单独抽出：既是 few-shot 最有价值的部分，也作为去重键（同一 join 在 UNION 多段里会重复出现）。
    const on = (snippet.match(/\bON\b([\s\S]*)/i)?.[1] || "").trim().slice(0, 200);
    out.push({ type, table, on, snippet });
  }
  return out;
}

/**
 * 用卡片 SQL 建 join 样例索引。
 * @param cards [{ id, name|question, sql|expected_sql }]
 * @param known 真实 schema 表名白名单（Set 或数组）；用于剔除 CTE 名/别名噪声
 */
export function buildJoinExamples(cards, known = new Set()) {
  const knownSet = known instanceof Set ? known : normalizeKnownTables(known);
  const byTable = new Map();
  const examples = [];
  for (const c of cards || []) {
    const sql = c.sql ?? c.expected_sql;
    if (typeof sql !== "string" || !sql.trim()) continue;
    const rawJoins = extractJoins(sql).filter((j) => knownSet.size === 0 || knownSet.has(j.table) || knownSet.has(j.table.split(".").pop()));
    // 去重：同一条 join 常在 UNION ALL 的多个分支里重复出现，few-shot 里留一条即可。
    const seen = new Set();
    const joins = [];
    for (const j of rawJoins) {
      const key = `${j.type}|${j.table}|${j.on}`;
      if (seen.has(key)) continue;
      seen.add(key);
      joins.push(j);
    }
    if (!joins.length) continue;
    const tables = filterKnownTables(extractTables(sql), knownSet);
    if (tables.length < 2) continue; // 单表自连接不成「join 路径」样例
    const ex = {
      cardId: c.id,
      question: c.name ?? c.question ?? `card ${c.id}`,
      tables,
      joins: joins.slice(0, 6),
      joinCount: joins.length,
    };
    examples.push(ex);
    for (const t of tables) {
      if (!byTable.has(t)) byTable.set(t, []);
      byTable.get(t).push(ex);
    }
  }
  return { examples, byTable, total: examples.length };
}

/** 按表名取 few-shot 样例：支持 qualified / bare 写法；同一卡片可能被多表命中，去重后返回。 */
export function joinExamplesForTable(index, table, limit = 3) {
  if (!index?.byTable || !table) return [];
  const needle = cleanName(table);
  const bare = needle.includes(".") ? needle.split(".").pop() : needle;
  const hits = new Map();
  for (const [key, list] of index.byTable) {
    if (key === needle || key === bare || key.split(".").pop() === bare) {
      for (const ex of list) hits.set(ex.cardId, ex);
    }
  }
  // 优先给 join 数更多的样例（对模型更有参考价值），同数按 cardId 稳定排序。
  return [...hits.values()].sort((a, b) => b.joinCount - a.joinCount || a.cardId - b.cardId).slice(0, limit);
}
