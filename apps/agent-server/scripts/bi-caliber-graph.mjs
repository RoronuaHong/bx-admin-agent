// 口径语义图（P3，§4.2-2）：在口径层构建「表 / 卡片(指标)」小图，用共现边 + 图遍历做检索，
// 替代盲目上全量 GraphRAG。near-zero 成本：无 embedding 预计算，仅基于已抽取的卡片 SQL/tables 做共现图 + 关键词命中。
// 目标：直接改善被触发的 JoinCorrect（表选择正确率，全量 ~60%）——给定自然语言问题，返回
// 「该用的表 + 常一起 join 的表 + 可参考的现成卡片口径」，让模型写 SQL 前先拿到精准上下文。
//
// 节点：表（白名单 schema.table）、卡片（id/name/tables）。
// 边：card→table（用到的表）、table↔table（共现于同一卡片，权重=共现次数）、card↔card（共享表）。
import { normalizeKnownTables } from "./metabase-card-graph.mjs";

const CJK = /[一-龥]+/g;

// 中英混合分词：英文/数字按词，中文按 2-gram（中文无空格，bigram 足以做模糊匹配）。
export function tokenize(text) {
  const t = String(text ?? "").toLowerCase();
  const out = new Set();
  for (const m of t.match(/[a-z0-9_]+/g) || []) if (m.length >= 2) out.add(m);
  for (const seg of t.match(CJK) || []) {
    if (seg.length === 1) out.add(seg);
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
  }
  return out;
}

function overlap(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

// 从黄金集卡片构建口径图。cards: [{id, name/question, expected_sql, tables}]。
// knownTables: 真实 schema 白名单（schema.table 或裸表名），用于剔除抽取噪声；空则 fail-open。
export function buildCaliberGraph(cards, { knownTables = [] } = {}) {
  const known = new Set(normalizeKnownTables(knownTables));
  const useKnown = known.size > 0;
  // canonical 映射：优先用 golden 自身出现的「带 schema 形式」（最可信），其次白名单里的带 schema 条目。
  // 这能统一「白名单裸名 + golden 带 schema 名」导致的节点分裂（如 elt_x 与 film_report.elt_x）。
  const bareToFull = new Map();
  for (const k of known) {
    const parts = k.split(".");
    if (parts.length >= 2) bareToFull.set(parts[parts.length - 1], k);
  }
  const goldenBareToFull = new Map();
  for (const c of cards) {
    for (const t of c.tables || []) {
      const parts = t.split(".");
      if (parts.length >= 2) goldenBareToFull.set(parts[parts.length - 1], t);
    }
  }
  const canon = (t) => {
    const bare = t.split(".").pop();
    if (goldenBareToFull.has(bare)) return goldenBareToFull.get(bare);
    if (bareToFull.has(bare)) return bareToFull.get(bare);
    return t;
  };

  const cardNodes = new Map(); // id -> {id, name, tables}
  const tableNodes = new Map(); // table -> {table, cardCount}
  const tableToCards = new Map(); // table -> Set<cardId>

  for (const c of cards) {
    if (!c.expected_sql) continue; // 只有编译出原生 SQL 的卡片才能抽表
    const tbls = (c.tables || [])
      .filter((t) => !useKnown || known.has(t) || known.has(t.split(".").pop()))
      .map(canon); // 统一为 canonical 表名
    if (!tbls.length) continue;
    const name = c.name || c.question || `card ${c.id}`;
    cardNodes.set(c.id, { id: c.id, name, tables: tbls });
    for (const t of tbls) {
      if (!tableNodes.has(t)) tableNodes.set(t, { table: t, cardCount: 0 });
      tableNodes.get(t).cardCount++;
      if (!tableToCards.has(t)) tableToCards.set(t, new Set());
      tableToCards.get(t).add(c.id);
    }
  }

  // 表共现边（同一卡片内两表共现）
  const tableCo = new Map(); // table -> Map(table2 -> weight)
  for (const c of cardNodes.values()) {
    const ts = c.tables;
    for (let i = 0; i < ts.length; i++) {
      for (let j = i + 1; j < ts.length; j++) {
        const a = ts[i];
        const b = ts[j];
        if (!tableCo.has(a)) tableCo.set(a, new Map());
        if (!tableCo.has(b)) tableCo.set(b, new Map());
        tableCo.get(a).set(b, (tableCo.get(a).get(b) || 0) + 1);
        tableCo.get(b).set(a, (tableCo.get(b).get(a) || 0) + 1);
      }
    }
  }

  // 卡片共现边（共享表）
  const cardCo = new Map(); // id -> Map(id2 -> sharedTableCount)
  for (const c of cardNodes.values()) {
    const co = new Map();
    for (const t of c.tables) {
      for (const otherId of tableToCards.get(t) || []) {
        if (otherId === c.id) continue;
        co.set(otherId, (co.get(otherId) || 0) + 1);
      }
    }
    cardCo.set(c.id, co);
  }

  return { cardNodes, tableNodes, tableCo, cardCo };
}

// 检索：给定自然语言 query，返回相关卡片 / 表（直接 + 共现 join 候选）/ join 建议 / 相关卡片。
export function buildCaliberContext(graph, query, { k = 5, topTables = 12 } = {}) {
  const qt = tokenize(query);
  if (qt.size === 0) {
    return { query, matchedCards: [], tables: [], joinHints: [], relatedCards: [], note: "查询无可分词，无法检索口径图。" };
  }

  // 1. 卡片打分：名称/表名命中
  const scored = [];
  for (const c of graph.cardNodes.values()) {
    let s = overlap(qt, tokenize(c.name)); // 名称命中
    for (const tbl of c.tables) {
      const bt = tokenize(tbl);
      for (const tok of qt) {
        if (bt.has(tok)) s += 2; // 表名 token 命中权重高
        if (tbl.toLowerCase().includes(tok)) s += 1;
      }
    }
    if (s > 0) scored.push({ card: c, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  const topCards = scored.slice(0, k);

  // 2. 相关表：命中卡片直接用的表（direct）+ 共现表（co，join 候选）
  const tableScore = new Map();
  const bump = (t, key) => {
    if (!tableScore.has(t)) tableScore.set(t, { direct: 0, co: 0 });
    tableScore.get(t)[key]++;
  };
  for (const { card } of topCards) for (const t of card.tables) bump(t, "direct");
  for (const { card } of topCards) {
    for (const t of card.tables) {
      const co = graph.tableCo.get(t);
      if (!co) continue;
      for (const [t2, w] of co) bump(t2, "co");
    }
  }
  const tables = [...tableScore.entries()]
    .map(([table, s]) => ({ table, direct: s.direct, co: s.co, score: s.direct * 2 + s.co }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topTables);

  // 3. join 建议：相关表之间权重最高的共现对
  const relSet = new Set(tables.map((t) => t.table));
  const joinHints = [];
  for (const t of relSet) {
    const co = graph.tableCo.get(t);
    if (!co) continue;
    for (const [t2, w] of co) {
      if (relSet.has(t2) && t < t2) joinHints.push({ tableA: t, tableB: t2, weight: w });
    }
  }
  joinHints.sort((a, b) => b.weight - a.weight).slice(0, 8);

  // 4. 相关卡片（共享表的其它卡片，作为口径参考）
  const seen = new Set(topCards.map((c) => c.card.id));
  const relatedCards = [];
  for (const { card } of topCards) {
    const co = graph.cardCo.get(card.id);
    if (!co) continue;
    for (const [id, w] of co) {
      if (seen.has(id)) continue;
      seen.add(id);
      const node = graph.cardNodes.get(id);
      relatedCards.push({ id, name: node?.name, sharedTables: w });
      if (relatedCards.length >= 5) break;
    }
  }

  return {
    query,
    matchedCards: topCards.map((c) => ({ id: c.card.id, name: c.card.name, tables: c.card.tables, score: c.score })),
    tables,
    joinHints,
    relatedCards,
    note: "以上为口径语义图检索结果（共现图 + 关键词命中）。优先参考 matchedCards 的真实口径与 tables 里的表来写 SQL；join 建议仅作启发，仍需核实外键。",
  };
}
