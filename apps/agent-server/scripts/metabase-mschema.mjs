// M-Schema 紧凑渲染（text2sql 首选 schema 呈现）。
//
// 纯函数、零副作用、只依赖传入的 Metabase 元数据字段，输出 Markdown 字符串。
// 配套改动见 apps/agent-server/scripts/metabase-mcp.mjs 的 get_database_schema(mode:"mschema")。
// 设计依据：docs/bi-metabase-optimization-plan.md §4.3（M-Schema + 取值域内联 + 业务语义前置）。
//
// 关键取舍：
//  - 默认路径：取值域从 Metabase fingerprint.type.values 抽取（低基数字段才带），**零额外 API 调用**。
//    本仓库 ClickHouse 后端不填该指纹，故回落到描述内联；P1.1 提供可选的 with_values=true，
//    由 bi-mschema-values.mjs 只对枚举候选字段惰性补实测取值，覆盖描述里过期的手写枚举（doc §11.5 / T4 / S9）。
//  - 描述前置高亮（最长 300 字，比默认 JSON 的 200 更宽容），因为金额口径、时间字段用途等
//    业务规则藏在描述里，最易被模型忽略（doc T1 / S7）。
//  - FK 指向解析成 "表.字段" 人读引用；自引用显式标 (self)，直接喂多表 join（doc §1.1 两条自引用边）。

function clipText(value, max) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 取值域：从 Metabase 指纹抽取真实去重值（仅低基数字段才带 values）。上限 30，避免长枚举撑爆输出。 */
export function valueHints(field) {
  const t = field?.fingerprint?.type;
  const raw = Array.isArray(t?.values)
    ? t.values
    : Array.isArray(field?.fingerprint?.global?.values)
      ? field.fingerprint.global.values
      : null;
  if (!raw || raw.length === 0) return null;
  const seen = new Set();
  const uniq = [];
  for (const v of raw) {
    const k = JSON.stringify(v);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(v);
    if (uniq.length >= 30) break;
  }
  return uniq;
}

/**
 * P1.1 惰性取值充实的候选字段：只有「看起来像枚举」的字段才值得额外跑一次查询，
 * 避免对 781 个字段全量取值撑爆延迟。指纹里已有真实取值的不重复查。
 * 线索 = 语义类型（Category/Enum/State/Status/Boolean）或描述里的手写枚举映射
 * （如「映射关系：1:安卓，2:iOS」「结果来源：SUCCESS/FAILED」「0=否,1=是」）。
 */
export function isEnumCandidate(field) {
  const sem = String(field?.semantic_type || "").replace(/^type\//, "");
  if (/^(category|enum|state|status|boolean)$/i.test(sem)) return true;
  const desc = String(field?.description || "");
  if (!desc) return false;
  return /\d\s*[:：=]\s*\S|映射关系|枚举|取值[:：]|状态[:：]|[a-z0-9_]+\/[a-z0-9_]+/i.test(desc);
}

function enumScore(field) {
  const sem = String(field?.semantic_type || "").replace(/^type\//, "");
  return /^(category|enum|state|status|boolean)$/i.test(sem) ? 2 : 1;
}

/** 按「语义类型明确 > 仅描述线索」排序，最多取 max 个（上限 20），由调用方控制延迟预算。 */
export function pickEnumFields(fields, max = 8) {
  const cap = Math.min(Math.max(Number(max) || 0, 0), 20);
  if (!cap) return [];
  return (Array.isArray(fields) ? fields : [])
    .filter((f) => !valueHints(f) && isEnumCandidate(f))
    .slice()
    .sort((a, b) => enumScore(b) - enumScore(a))
    .slice(0, cap);
}

function isPk(field) {
  return field?.semantic_type === "type/PK" || field?.pk === true;
}

function fkTarget(field, fieldIndex) {
  return field?.fk_target_field_id ? fieldIndex.get(field.fk_target_field_id) : null;
}

function renderMSchemaField(field, fieldIndex, currentTable, valueOverrides, fkNotes) {
  const pk = isPk(field);
  const fk = fkTarget(field, fieldIndex);
  const selfRef = fk && currentTable && String(fk).startsWith(`${currentTable}.`);
  // Metabase 元数据里 base_type / semantic_type 都带 "type/" 前缀，M-Schema 里剥掉，保持紧凑（doc §4.3 样例即无前缀）。
  const base = String(field.base_type || "").replace(/^type\//, "");
  const parts = [`- ${field.name}`, base];
  if (pk) parts.push("PK");
  if (fk) parts.push(`FK → ${fk}${selfRef ? " (self)" : ""}`);
  if (fk && fkNotes instanceof Map && fkNotes.has(field.name)) parts.push(`[FK 核对未通过：${fkNotes.get(field.name)}]`);
  if (field.semantic_type && field.semantic_type !== "type/PK")
    parts.push(field.semantic_type.replace(/^type\//, ""));
  let line = parts.join("  ").replace(/\s+/g, " ").trim();
  // 实测取值优先于 fingerprint，也优先于 description 里可能过期的手写枚举（doc §11.5 / T4）。
  const live = valueOverrides instanceof Map && valueOverrides.has(field.name);
  const values = live ? valueOverrides.get(field.name) : valueHints(field);
  if (Array.isArray(values) && values.length) line += `  values: [${values.map((v) => JSON.stringify(v)).join(", ")}]${live ? " (live)" : ""}`;
  if (field.description) line += `  desc: ${clipText(field.description, 300)}`;
  return line;
}

/**
 * 单表 M-Schema（含所有字段）。valueOverrides: Map<字段名, 实测去重值[]>，P1.1 可选传入；
 * fkNotes: Map<字段名, 说明>，技术核对未通过的外键在 FK 后标注。
 */
export function renderTableMSchema(databaseName, databaseId, engine, table, fieldIndex, valueOverrides = null, fkNotes = null) {
  const fields = Array.isArray(table.fields) ? table.fields : [];
  const fkCount = fields.filter((f) => f.fk_target_field_id).length;
  const name = table.schema && table.schema !== "public" ? `${table.schema}.${table.name}` : table.name;
  const lines = [
    `# Database: ${databaseName} (${engine})  [DB_ID: ${databaseId}]`,
    `## Table: ${name}  [#Table]  (${fields.length} fields, ${fkCount} FK)`,
  ];
  if (table.description) lines.push(`> ${clipText(table.description, 200)}`);
  const liveCount = valueOverrides instanceof Map ? [...valueOverrides.values()].filter((v) => Array.isArray(v) && v.length).length : 0;
  if (liveCount) lines.push(`> 取值域标 (live) 的 ${liveCount} 个字段来自实测去重值（取样最多 20 万行），优先级高于 description 里的手写枚举（可能过期）。`);
  for (const f of fields) lines.push(renderMSchemaField(f, fieldIndex, table.name, valueOverrides, fkNotes));
  return lines.join("\n");
}

/** 库级 M-Schema（仅表清单 + FK 数，引导调用方再传 table 取字段级定义）。 */
export function renderDatabaseMSchema(databaseName, databaseId, engine, tables, matched, search) {
  const lines = [
    `# Database: ${databaseName} (${engine})  [DB_ID: ${databaseId}]`,
    `## Tables (${matched.length}${search ? `, 过滤 "${search}"` : ""}) — 传 table=<名> 取 M-Schema 字段级定义`,
    "",
  ];
  for (const t of matched) {
    const fkCount = (t.fields || []).filter((f) => f.fk_target_field_id).length;
    const name = t.schema && t.schema !== "public" ? `${t.schema}.${t.name}` : t.name;
    lines.push(
      `#Table ${name}  (${ (t.fields || []).length } fields, ${fkCount} FK)${
        t.description ? ` — ${clipText(t.description, 120)}` : ""
      }`,
    );
  }
  return lines.join("\n");
}
