// 按值搜索（§11.11 第 1 项③）：把"业务词 → 库内真实取值"映射成可检索资产，
// 对齐 Genie 值字典 / Cortex Analyst 字面值检索。模型写过滤/分组条件前先用本工具拿到真实字面值，
// 而不是凭业务词猜（valueMatch 失分的最大来源：IN8/FOXA 对应库内 INGoogle8/FoxA 等）。
//
// 纯函数 + 安全 SQL 拼装，测试可直接 import；执行经 metabase-mcp.mjs 的 mb 客户端（只读、带护栏）。

const IDENT = /^[A-Za-z0-9_$]+$/;
const MAX_PATTERN = 100;

// 维度列候选的字段名关键词（渠道/应用/事件/素材/归因等）。命中其一即视为可检索维度列；
// 同时包含语义类型为 Category 的列。最终数量由调用方用 max 截断（默认 20），避免一次扫太多表。
const SEED_KEYWORDS = [
  "channel", "eventname", "apkchannel", "source", "campaign", "material",
  "utm", "ref", "medium", "app", "package", "advertiser", "creative", "placement",
];

/**
 * 拼装按值检索 SQL：从单表某列取匹配 pattern 的去重值。
 * 标识符与字面量都做注入防护；只返一列 `v`。
 */
export function buildValueSearchSql(table, field, pattern, opts = {}) {
  const t = String(table || "").trim();
  const f = String(field || "").trim();
  // 与 get_field_values 同口径：表名可为 schema.table，逐段校验，避免把带 schema 的列整批判为非法。
  const parts = t.split(".");
  if (parts.length > 2 || !parts.every((p) => IDENT.test(p)) || !IDENT.test(f)) {
    return { ok: false, error: "table/field 不合法：只允许字母、数字、下划线、$（table 可为 schema.table）" };
  }
  const pat = String(pattern || "").trim().slice(0, MAX_PATTERN);
  if (!pat) return { ok: false, error: "pattern 必须是非空字符串（要找的字面值子串）" };
  const safe = pat.replace(/\\/g, "\\\\").replace(/'/g, "''");
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, 200) : 20;
  const [schema, name] = parts.length === 2 ? parts : [null, parts[0]];
  const tQual = schema ? `\`${schema}\`.\`${name}\`` : `\`${name}\``;
  const sql = `SELECT DISTINCT \`${f}\` AS v FROM ${tQual} WHERE \`${f}\` ILIKE '%${safe}%' AND \`${f}\` != '' LIMIT ${limit}`;
  return { ok: true, sql, table: t, field: f };
}

/**
 * 从 Metabase 元数据提取"维度列"候选（库内真实存在的列）。
 * 命中 SEED_KEYWORDS 或语义类型为 Category 的列入选；按 max 截断。
 * @param {object} meta getDatabaseMetadata 的返回（{ ok, data:{tables:[{schema,name,fields:[{name,semantic_type}]}]} }）
 */
export function dimensionColumnsFromMeta(meta, { max = 20 } = {}) {
  const out = [];
  const seen = new Set();
  if (!meta?.ok || !Array.isArray(meta.data?.tables)) return out;
  for (const t of meta.data.tables) {
    if (!t?.name) continue;
    const fq = t.schema && t.schema !== "public" ? `${t.schema}.${t.name}` : t.name;
    for (const f of t.fields || []) {
      if (typeof f?.name !== "string") continue;
      const name = f.name.toLowerCase();
      // Metabase 的 semantic_type 带 "type/" 前缀（见 metabase-mschema.mjs），裸值也兼容。
      const sem = String(f.semantic_type || "").replace(/^type\//, "").toLowerCase();
      const isDim = sem === "category" || SEED_KEYWORDS.some((k) => name.includes(k));
      if (isDim && IDENT.test(f.name)) {
        const key = `${fq}.${f.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ table: fq, field: f.name });
      }
    }
  }
  return out.slice(0, Math.max(1, max));
}
