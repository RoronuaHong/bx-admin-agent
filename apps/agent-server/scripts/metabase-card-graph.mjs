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
// ClickHouse 的 `[LEFT] ARRAY JOIN col` 展开的是数组列而不是表，排除。
const FROM_JOIN = /\b(?:FROM|(?<!\bARRAY\s{1,20})JOIN)\s+([`"]?[\w]+[`"]?)(?:\.([`"]?[\w]+[`"]?))?/gi;

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

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Metabase 外键显示映射（FK remapping，如 activityId 显示为活动名）编译出的
 * `LEFT JOIN (SELECT … FROM T) AS \`T__via__fk\``：只为取显示列。若映射出的列
 * （`T__via__fk__xxx`）在 SQL 里只出现在定义处、外层从没用过，T 对结果没有贡献。
 * 返回只以这种方式出现的表（规范化名）。
 */
export function unusedRemapTables(sql) {
  if (typeof sql !== "string" || !sql.includes("__via__")) return [];
  const aliases = new Set([...sql.matchAll(/`(\w+__via__\w+?)`\s+ON\b/g)].map((m) => m[1]));
  const unused = new Map();
  for (const alias of aliases) {
    const projected = [...sql.matchAll(new RegExp(`\`(${escapeRe(alias)}__\\w+)\``, "g"))].map((m) => m[1]);
    if (projected.some((p) => sql.split(`\`${p}\``).length - 1 >= 2)) continue;
    const src = sql.match(new RegExp(`FROM\\s+([\`"]?\\w+[\`"]?(?:\\.[\`"]?\\w+[\`"]?)?)\\s*\\)\\s*AS\\s+\`${escapeRe(alias)}\``));
    const t = src && normalizeTable(src[1]);
    if (t) unused.set(t, (unused.get(t) || 0) + 1);
  }
  const out = [];
  for (const [t, n] of unused) {
    let total = 0;
    for (const m of sql.matchAll(FROM_JOIN)) if (normalizeTable(m[2] ? `${m[1]}.${m[2]}` : m[1]) === t) total++;
    if (total === n) out.push(t);
  }
  return out;
}

/**
 * 黄金集期望表归一化：白名单里能唯一对应的裸表名补成 `schema.table`；SQL 里定义的 CTE 名剔除；
 * 剩下既不在白名单、又不是 CTE 的名字记进 unverifiedTables（多为 Metabase 隐藏表或已下线表），
 * 这些用例的期望表可能不全，评分时单列。只经未使用的外键显示映射引入的表剔除，记进 remapOnlyTables。
 * knownList：bi-known-tables.json 的 tables（带 schema 的全名）。
 */
export function normalizeGoldenCase(c, knownList) {
  const full = (Array.isArray(knownList) ? knownList : knownList?.tables || []).map(normalizeTable).filter(Boolean);
  const fullSet = new Set(full);
  const byBare = new Map();
  for (const t of full) {
    const bare = t.split(".").pop();
    byBare.set(bare, byBare.has(bare) ? null : t); // null = 多个 schema 同名，不敢补
  }
  const sql = typeof c.expected_sql === "string" ? c.expected_sql : "";
  const isCte = (name) => new RegExp(`(?:\\bwith\\s+|,\\s*)\`?${name}\`?\\s+as\\s*\\(`, "i").test(sql);
  const tables = [];
  const unverified = [];
  const remapOnly = new Set(unusedRemapTables(sql));
  // 有编译后 SQL 就按当前抽表规则重抽（抽表规则修正能回灌到黄金集），否则沿用落盘时的 tables。
  for (const raw of sql ? extractTables(sql) : c.tables || []) {
    const t = normalizeTable(raw);
    if (!t || remapOnly.has(t)) continue;
    if (fullSet.has(t)) tables.push(t);
    else if (!t.includes(".") && byBare.get(t)) tables.push(byBare.get(t));
    else if (!t.includes(".") && isCte(t)) continue;
    else {
      tables.push(t);
      unverified.push(t);
    }
  }
  const out = { ...c, tables: [...new Set(tables)] };
  if (unverified.length) {
    out.unverifiedTables = [...new Set(unverified)];
    // 白名单外表的查证结论（tests/bi-known-tables.json 的 tableAudit）：区分「库里存在但 Metabase 隐藏」与「库里已不存在」。
    const audit = Array.isArray(knownList) ? {} : knownList?.tableAudit || {};
    const inList = (list, t) => (list || []).some((x) => normalizeTable(x).split(".").pop() === t.split(".").pop());
    out.unverifiedTableStatus = Object.fromEntries(
      out.unverifiedTables.map((t) => [t, inList(audit.missing, t) ? "missing" : inList(audit.existHidden, t) ? "existHidden" : "unknown"]),
    );
  } else {
    delete out.unverifiedTables;
    delete out.unverifiedTableStatus;
  }
  if (remapOnly.size) out.remapOnlyTables = [...remapOnly];
  else delete out.remapOnlyTables;
  return out;
}

/**
 * 应用自然语言改写稿：question 换成改写后的提问，原卡片名保留在 cardTitle。
 * 留一法要靠卡片标题识别「同口径多份」的孪生卡片，题目改写后原名不能丢。
 * 幂等：重复执行不会把已改写的 question 再当原标题存一遍。
 */
export function applyGoldenQuestions(cases, questions) {
  const map = questions && typeof questions === "object" ? questions : {};
  return (cases || []).map((c) => {
    const out = { ...c, cardTitle: c.cardTitle ?? c.question };
    const q = map[String(c.id)];
    if (typeof q === "string" && q.trim()) out.question = q.trim();
    return out;
  });
}

/**
 * 卡片 SQL 的底表：剔除「只为 FK 显示映射、外层从未使用」的表（unusedRemapTables）。
 * 金样期望表归一化早已这么做（§11.7 的 9 例 elt_ul_activity），这里让线上「按表找卡片」索引
 * 与它一致，避免 9 张订单类卡片被错误挂到 elt_ul_activity 名下。纯函数，便于单测。
 */
export function cardTablesFromSql(sql) {
  const remapOnly = new Set(unusedRemapTables(sql || ""));
  return extractTables(sql || "").filter((t) => !remapOnly.has(t));
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
  return cardTablesFromSql(sql);
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
        // 与线上卡片→表索引、金样归一化同一口径：剔除未使用的 FK 显示映射表，
        // 否则线上 get_caliber_context / get_join_examples 会带着「订单表 ↔ elt_ul_activity」的假共现边，
        // 而离线评测用的是已剔除的 golden 文件，两边不一致。
        return { ...c, expected_sql: sql, tables: sql ? cardTablesFromSql(sql) : [] };
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
