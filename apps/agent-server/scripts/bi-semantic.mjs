// BI 语义资产：外键健康标注（来自 FK 核对清单）+ 口径词典（指标单一定义）。
// 数据放在 apps/agent-server/bi-semantic/，MCP 运行时读取；纯函数部分供审计脚本与评测共用。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SEMANTIC_DIR = path.join(here, "..", "bi-semantic");
export const FK_SIGNOFF_FILE = path.join(SEMANTIC_DIR, "fk-signoff.json");
export const GLOSSARY_FILE = path.join(SEMANTIC_DIR, "caliber-glossary.json");

const fileCache = new Map();
// 按 mtime+size 缓存；文件缺失或损坏时返回 null（fail-open：不标注、不提供词典，不影响原工具输出）。
function readJsonCached(file) {
  try {
    const st = fs.statSync(file);
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = fileCache.get(file);
    if (hit && hit.key === key) return hit.data;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    fileCache.set(file, { key, data });
    return data;
  } catch {
    return null;
  }
}

const bare = (s) => String(s || "").replace(/[`"]/g, "").trim().toLowerCase().split(".").pop();

// ---- 外键健康 ----

const FK_NOTES = {
  DEAD_FK_COLUMN: "子表这一列从未写入（全空），按此外键 JOIN 不会有匹配，不要用它关联",
  EMPTY_PARENT_TABLE: "被引用的父表当前为 0 行，按此外键 JOIN 取不到父表属性",
  DANGLING_SELF_REF: "引用的父记录在表里查不到，按此外键自连接得到 0 行",
  PERMISSION_OUT_OF_SCOPE: "当前权限下无法核对这条外键，结果需自行验证",
};

/** 解析「子表.列 → 父表.列（备注）」→ { child, column, parent }，表名统一成裸名小写。 */
export function parseFkEdge(edge) {
  const m = String(edge || "").match(/^\s*([\w.]+)\.(\w+)\s*→\s*([\w.]+)\.(\w+)/);
  if (!m) return null;
  return { child: bare(m[1]), column: m[2].toLowerCase(), parent: bare(m[3]) };
}

/** 从 FK 核对清单建索引：key = 子表裸名.列名（小写）→ { status, rootCause, note, signedOff }。只收非 VERIFIED 的边。 */
export function buildFkHealth(signoff) {
  const map = new Map();
  for (const e of signoff?.edges || []) {
    if (!e || e.status === "VERIFIED") continue;
    const p = parseFkEdge(e.edge);
    if (!p) continue;
    const decision = e.signoff?.decision || null;
    const base = FK_NOTES[e.rootCause] || "这条外键核对未通过，结果需自行验证";
    map.set(`${p.child}.${p.column}`, {
      status: e.status,
      rootCause: e.rootCause || null,
      note: decision ? `${base}（人工结论：${decision}）` : `${base}（技术核对结论，待人工签字）`,
      signedOff: Boolean(decision),
    });
  }
  return map;
}

export function loadFkHealth(file = FK_SIGNOFF_FILE) {
  const data = readJsonCached(file);
  return data ? buildFkHealth(data) : new Map();
}

export function fkHealthFor(health, table, column) {
  if (!(health instanceof Map) || !health.size) return null;
  return health.get(`${bare(table)}.${String(column || "").toLowerCase()}`) || null;
}

// ---- 口径词典 ----

export function loadGlossary(file = GLOSSARY_FILE) {
  const data = readJsonCached(file);
  return data && Array.isArray(data.entries) ? data : null;
}

/** 线上只提供业务方已拍板的条目；草稿只用于离线审计与评测。 */
export function approvedEntries(glossary) {
  return (glossary?.entries || []).filter((e) => e.status === "approved");
}

/** 口径名与别名 → 规则涉及的表，作为口径图的检索词：{ 裸表名: "已支付订单 付费 …" }。默认只取已批准条目。 */
export function glossaryTableTerms(glossary, { statuses = ["approved"] } = {}) {
  const out = {};
  for (const e of glossary?.entries || []) {
    if (!statuses.includes(e.status) || !e.check) continue;
    const tables = [e.check.table, ...(e.check.allowed || []).map((x) => String(x).split(".")[0])].filter(Boolean);
    const terms = [e.name, ...(e.aliases || [])].filter(Boolean).join(" ");
    for (const t of tables) out[bare(t)] = `${out[bare(t)] ? `${out[bare(t)]} ` : ""}${terms}`;
  }
  return out;
}

/** 歧义信号（第 8 项）：只给信号，不替调用方选口径。候选项 id 必须指向词典里存在的条目；
 *  approvedOnly 时还要已批准，避免把草稿口径泄漏到线上。少于 2 个候选项不构成歧义。 */
export function ambiguityFor(entry, glossary, { approvedOnly = false } = {}) {
  const raw = entry?.ambiguous;
  if (!raw || typeof raw.question !== "string" || !raw.question.trim() || !Array.isArray(raw.candidates)) return null;
  const byId = new Map((glossary?.entries || []).map((e) => [e.id, e]));
  const candidates = raw.candidates
    .filter((c) => c && typeof c.label === "string" && c.label.trim())
    .filter((c) => !c.id || (byId.has(c.id) && (!approvedOnly || byId.get(c.id).status === "approved")))
    .map((c) => ({
      ...(c.id ? { id: c.id } : {}),
      label: c.label,
      ...(c.hint ? { hint: String(c.hint) } : {}),
    }));
  return candidates.length >= 2 ? { question: raw.question, candidates } : null;
}

/** get_metric_definitions 的输出投影（纯函数，适配器只负责包装成 MCP 响应）。
 *  线上只给已批准口径；命中条目带歧义时，一并补齐候选项里已批准的口径定义，
 *  让调用方一次看到全部可选口径。是否向用户确认由调用方决定，这里不改任何判定。 */
export function metricDefinitions(glossary, query) {
  const entries = approvedEntries(glossary);
  if (!entries.length) return { value: "当前没有业务已确认的指标口径。", isError: true };
  const q = String(query || "").trim().toLowerCase();
  const hit = q
    ? entries.filter((e) => [e.name, e.id, ...(e.aliases || [])].some((s) => String(s).toLowerCase().includes(q)))
    : entries;
  if (!hit.length) return { value: `没有匹配「${query}」的已确认口径。已确认：${entries.map((e) => e.name).join("、")}`, isError: true };

  const byId = new Map(entries.map((e) => [e.id, e]));
  const defOf = (e) => {
    const { id, name, aliases, definition, sql, notes, owner, approvedAt, valueAliases } = e;
    const ambiguous = ambiguityFor(e, glossary, { approvedOnly: true });
    return {
      id, name, aliases, definition, sql, notes, owner, approvedAt,
      ...(valueAliases?.length ? { valueAliases } : {}),
      ...(ambiguous ? { ambiguous } : {}),
    };
  };
  const definitions = hit.map(defOf);
  const seen = new Set(hit.map((e) => e.id));
  const ambiguities = [];
  for (const e of hit) {
    const ambiguous = ambiguityFor(e, glossary, { approvedOnly: true });
    if (!ambiguous) continue;
    ambiguities.push({ id: e.id, name: e.name, ...ambiguous });
    for (const c of ambiguous.candidates) {
      const other = c.id && !seen.has(c.id) ? byId.get(c.id) : null;
      if (!other) continue;
      seen.add(c.id);
      definitions.push(defOf(other));
    }
  }
  return { value: { definitions, ...(ambiguities.length ? { ambiguities } : {}) }, isError: false };
}

const stripComments = (sql) => String(sql || "").replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const refsTable = (sql, table) => new RegExp(`\\b${bare(table)}\\b`, "i").test(sql);

/** SQL 里对某列的「过滤取值集合」：支持 = v / IN (..) / 多个 = v 用 OR 连接；没有过滤返回 null。 */
export function filterValues(sql, column) {
  const s = stripComments(sql);
  const col = `(?<![\\w])\`?${column}\`?`;
  const values = new Set();
  let found = false;
  for (const m of s.matchAll(new RegExp(`${col}\\s*=\\s*(\\d+)`, "gi"))) {
    found = true;
    values.add(Number(m[1]));
  }
  for (const m of s.matchAll(new RegExp(`${col}\\s+IN\\s*\\(([\\d,\\s]+)\\)`, "gi"))) {
    found = true;
    for (const v of m[1].split(",")) if (v.trim()) values.add(Number(v));
  }
  return found ? [...values].sort((a, b) => a - b) : null;
}

const sameSet = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// 每类规则返回 null（不适用）或 { ok, detail }。
const CHECKS = {
  // 某表某列做过滤时，取值集合必须等于约定集合；不过滤（如按状态分组算结算率）不适用。
  filter_set({ table, column, values }, sql) {
    if (!refsTable(sql, table)) return null;
    const got = filterValues(sql, column);
    if (!got) return null;
    const want = [...values].sort((a, b) => a - b);
    return sameSet(got, want) ? { ok: true } : { ok: false, detail: `${column} 过滤为 {${got.join(",")}}，约定为 {${want.join(",")}}` };
  },
  // 对某表汇总金额时必须用约定列（如 changeAmount），用了禁用列（如 amount）判冲突。
  sum_column({ table, column, forbidden = [] }, sql) {
    if (!refsTable(sql, table)) return null;
    const s = stripComments(sql);
    const sums = [...s.matchAll(/\b(?:sum|avg)(?:If)?\s*\(([^()]*)\)/gi)].map((m) => m[1]);
    const usesCol = (expr, c) => new RegExp(`(^|[^\\w])\`?${c}\`?($|[^\\w])`, "i").test(expr);
    const bad = forbidden.find((c) => sums.some((e) => usesCol(e, c)));
    if (bad) return { ok: false, detail: `汇总用了 ${bad}，约定为 ${column}` };
    return sums.some((e) => usesCol(e, column)) ? { ok: true } : null;
  },
  // 有时间过滤或按日分桶时，按约定时区解释。不写时区时按服务器默认时区解释：
  // serverTimezone 与约定一致则等价，不判冲突；未配置 serverTimezone 时要求显式写出。
  timezone({ timezone, others = [], serverTimezone = null }, sql) {
    const s = stripComments(sql);
    const timeish = /'\d{4}-\d{2}-\d{2}/.test(s) || /\b(toDate|toStartOf\w+|toYYYYMM\w*|formatDateTime)\s*\(/i.test(s);
    if (!timeish) return null;
    const other = others.find((tz) => s.includes(tz));
    if (other) return { ok: false, detail: `用了 ${other}，约定为 ${timezone}` };
    if (s.includes(timezone) || serverTimezone === timezone) return { ok: true };
    return { ok: false, detail: `未写时区（按服务器默认时区${serverTimezone ? ` ${serverTimezone}` : ""}解释），约定为 ${timezone}` };
  },
  // 几个标识符同时出现即判冲突（如「设备级快照表 + 会员到期天数列」拼出的会员存量）；不全出现不适用。
  forbidden_tokens({ all = [], message = null }, sql) {
    const s = stripComments(sql);
    if (!all.length || !all.every((tok) => new RegExp(`\\b${tok}\\b`, "i").test(s))) return null;
    return { ok: false, detail: message || `同时用了 ${all.join(" + ")}` };
  },
  // 某维度只能取自约定的表.列；用了禁用的表.列判冲突。
  dimension_source({ allowed = [], forbidden = [] }, sql) {
    // Metabase 关联表时会把整张表的列原样透传（`t`.`col` AS `col`），只透传不算用了该维度。
    const s = stripComments(sql).replace(/(?:`?\w+`?\.)*`(\w+)`\s+AS\s+`\1`/g, " ");
    const hit = (ref) => {
      const [t, c] = ref.split(".").slice(-2);
      return refsTable(s, t) && new RegExp(`\\b${c}\\b`).test(s);
    };
    const bad = forbidden.filter(hit);
    const good = allowed.filter(hit);
    if (bad.length && !good.length) return { ok: false, detail: `维度取自 ${bad.join(" / ")}，约定为 ${allowed.join(" / ")}` };
    return good.length ? { ok: true } : null;
  },
};

/** 按词典里可机检的规则检查一条 SQL。返回 { checked, violations: [{ id, detail }], passed: [id] }。 */
export function checkCaliber(sql, glossary, { statuses = ["approved", "draft"] } = {}) {
  const out = { checked: 0, violations: [], passed: [] };
  if (typeof sql !== "string" || !sql.trim()) return out;
  for (const e of glossary?.entries || []) {
    if (!statuses.includes(e.status) || !e.check || !CHECKS[e.check.type]) continue;
    const r = CHECKS[e.check.type](e.check, sql);
    if (!r) continue;
    out.checked++;
    if (r.ok) out.passed.push(e.id);
    else out.violations.push({ id: e.id, detail: r.detail });
  }
  return out;
}
