// 问题-表窄图：从已保存提问（卡片）的 SQL 抽取底表，建立 card→table 边，供「先找现成提问/表」导航。
// 纯元数据、零 LLM。默认输出为卡片清单（认路够用）；detail=detailed 才带共享表细节。

// Metabase 列表接口有的返回裸数组、有的包成 { data: [...] }，统一取出数组（与 metabase-mcp.mjs 同源逻辑）。
function asList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}


// 模块级缓存：整库卡片→表索引按 database_id 缓存，TTL 内复用，避免每次重拉 97 张卡片 SQL。
let _indexCache = { ts: 0, databaseId: null, index: null };
const CARD_INDEX_TTL_MS = Number(process.env.BI_CARD_INDEX_TTL_MS || 300_000);

// 从 SQL 抽 FROM/JOIN 的表引用（含 schema.table）。跳过子查询（FROM 后紧跟 ( 不匹配），
// 因为要求 FROM\s+ 后必须是 \w 开头标识符。逗号连接只取首个，足够「发现」用途。
const FROM_JOIN = /\b(?:FROM|JOIN)\s+([`"]?[\w]+[`"]?)(?:\.([`"]?[\w]+[`"]?))?/gi;

function normalizeTable(s) {
  if (!s) return null;
  const t = String(s).replace(/[`"]/g, "").trim().toLowerCase();
  return t || null;
}

export function extractTables(sql) {
  const out = new Set(); // 规范化名（去反引号、转小写），便于与元数据表名对齐匹配
  if (typeof sql !== "string" || !sql.trim()) return [];
  let m;
  FROM_JOIN.lastIndex = 0;
  while ((m = FROM_JOIN.exec(sql))) {
    const schema = m[1];
    const tbl = m[2];
    const raw = tbl ? `${schema}.${tbl}` : schema;
    const norm = normalizeTable(raw);
    if (norm) out.add(norm);
  }
  return [...out];
}

// 把真实 schema 表名清单规整成匹配集合：同时收 qualified 名与 bare 名，
// 这样 SQL 里写 `film_report.elt_x` 或 `elt_x` 都能命中。
export function normalizeKnownTables(list) {
  const set = new Set();
  const arr = Array.isArray(list) ? list : Array.isArray(list?.tables) ? list.tables : [];
  for (const raw of arr) {
    const name = typeof raw === "string" ? raw : raw?.table ?? raw?.name;
    const norm = normalizeTable(name);
    if (!norm) continue;
    set.add(norm);
    if (norm.includes(".")) {
      const bare = norm.split(".").pop();
      if (bare) set.add(bare);
    }
  }
  return set;
}

// 用真实表名白名单过滤抽表结果，剔除 CTE 名 / 表别名 / 列名等噪声（如 `od` / `u` / `m5` / `new_dev`）。
// fail-open：白名单为空时不改动入参（避免在元数据缺失时把真实表全部误杀）。
export function filterKnownTables(tables, known) {
  const arr = [...new Set((tables || []).map(normalizeTable).filter(Boolean))];
  if (!known || known.size === 0) return arr;
  return arr.filter((t) => known.has(t) || known.has(t.split(".").pop()));
}

// 取单卡片的底表：原生卡片直接读 native.query；MBQL 卡片 POST /dataset/native 编译成 SQL 再抽。
export async function getCardTables(mb, cardId) {
  const r = await mb(`/card/${cardId}?legacy-mbql=true`);
  if (!r.ok || !r.data) return [];
  const dq = r.data.dataset_query || {};
  let sql = null;
  if (typeof dq.native?.query === "string") {
    sql = dq.native.query;
  } else if (dq.type === "query" && dq.query) {
    const compiled = await mb("/dataset/native", {
      method: "POST",
      body: { database: dq.database, type: "query", query: dq.query },
    });
    if (compiled.ok && typeof compiled.data?.query === "string") sql = compiled.data.query;
  }
  return extractTables(sql || "");
}

// 取单卡片的原生 SQL（用于黄金集的 expected_sql）：原生卡片直接读 native.query；MBQL 走 /dataset/native 编译。
export async function getCardSql(mb, cardId) {
  const r = await mb(`/card/${cardId}?legacy-mbql=true`);
  if (!r.ok || !r.data) return null;
  const dq = r.data.dataset_query || {};
  if (typeof dq.native?.query === "string") return dq.native.query;
  if (dq.type === "query" && dq.query) {
    const compiled = await mb("/dataset/native", {
      method: "POST",
      body: { database: dq.database, type: "query", query: dq.query },
    });
    if (compiled.ok && typeof compiled.data?.query === "string") return compiled.data.query;
  }
  return null;
}

// 黄金集：从已保存提问抽 {id, question=卡片名, expected_sql=编译后原生SQL, tables}。纯元数据、零 LLM。
// 模块级 TTL 缓存：get_golden_set / get_join_examples 共用，避免每次工具调用重拉 97 张卡片 SQL。
let _goldenCache = { ts: 0, databaseId: null, data: null };
export async function buildGoldenSet(mb, { databaseId = null, force = false } = {}) {
  const now = Date.now();
  if (!force && _goldenCache.data && _goldenCache.databaseId === databaseId && now - _goldenCache.ts < CARD_INDEX_TTL_MS) {
    return _goldenCache.data;
  }
  const r = await mb("/card");
  if (!r.ok) return { error: `[${r.status}] ${JSON.stringify(r.data)}` };
  let cards = asList(r.data).map((c) => ({
    id: c.id,
    name: c.name,
    database: c.database_id,
    collection: c.collection?.name ?? c.collection_id ?? null,
  }));
  if (databaseId != null) cards = cards.filter((c) => c.database === databaseId);
  const cases = [];
  const BATCH = 10;
  for (let i = 0; i < cards.length; i += BATCH) {
    const slice = cards.slice(i, i + BATCH);
    const enriched = await Promise.all(
      slice.map(async (c) => {
        const sql = await getCardSql(mb, c.id).catch(() => null);
        return { ...c, expected_sql: sql, tables: sql ? extractTables(sql) : [] };
      }),
    );
    cases.push(...enriched);
  }
  const out = { total: cases.length, cases };
  _goldenCache = { ts: now, databaseId, data: out };
  return out;
}

// 建整库卡片→表索引。databaseId 给定时只纳入该库卡片。并发批拉卡片以压低首调延迟。
export async function buildCardTableIndex(mb, { databaseId = null, force = false } = {}) {
  const now = Date.now();
  if (!force && _indexCache.index && _indexCache.databaseId === (databaseId ?? _indexCache.databaseId) && now - _indexCache.ts < CARD_INDEX_TTL_MS) {
    return _indexCache.index;
  }
  const r = await mb("/card");
  if (!r.ok) return { cards: [], tableToCards: new Map(), error: `[${r.status}] ${JSON.stringify(r.data)}` };
  let cards = asList(r.data).map((c) => ({
    id: c.id,
    name: c.name,
    database: c.database_id,
    collection: c.collection?.name ?? c.collection_id ?? null,
  }));
  if (databaseId != null) cards = cards.filter((c) => c.database === databaseId);

  // 并发批拉每张卡片的 SQL 并抽表（每批 10，避免瞬时打爆 Metabase）。
  const tableToCards = new Map();
  const enriched = [];
  const BATCH = 10;
  for (let i = 0; i < cards.length; i += BATCH) {
    const slice = cards.slice(i, i + BATCH);
    const tablesArr = await Promise.all(slice.map((c) => getCardTables(mb, c.id).catch(() => [])));
    slice.forEach((c, k) => {
      const tables = tablesArr[k];
      const normTables = [];
      for (const t of tables) {
        const norm = normalizeTable(t);
        if (!norm) continue;
        normTables.push(norm);
        if (!tableToCards.has(norm)) tableToCards.set(norm, []);
        const entry = tableToCards.get(norm);
        if (!entry.includes(c.id)) entry.push(c.id);
      }
      enriched.push({ ...c, tables: normTables });
    });
  }

  const index = { cards: enriched, tableToCards, builtAt: now };
  _indexCache = { ts: now, databaseId: databaseId ?? null, index };
  return index;
}

// 解析用户输入的表名：可能是 bare 或 schema.table；同时按 bare 名兜底匹配。
function matchKeys(query) {
  const norm = normalizeTable(query);
  if (!norm) return [];
  const keys = [norm];
  if (norm.includes(".")) {
    const bare = norm.split(".").pop();
    if (bare) keys.push(bare);
  }
  return keys;
}

export function cardsForTable(index, table) {
  const keys = matchKeys(table);
  const ids = new Set();
  for (const k of keys) for (const id of index.tableToCards.get(k) || []) ids.add(id);
  return index.cards.filter((c) => ids.has(c.id));
}

export function relatedCards(index, cardId) {
  const self = index.cards.find((c) => c.id === cardId);
  if (!self) return null;
  const selfTables = new Set(self.tables);
  const out = [];
  for (const c of index.cards) {
    if (c.id === cardId) continue;
    const shared = c.tables.filter((t) => selfTables.has(t));
    if (shared.length) out.push({ id: c.id, name: c.name, database: c.database, sharedTables: shared });
  }
  out.sort((a, b) => b.sharedTables.length - a.sharedTables.length);
  return { self, related: out };
}
