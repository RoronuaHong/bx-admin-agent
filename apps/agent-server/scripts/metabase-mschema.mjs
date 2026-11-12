// M-Schema 紧凑渲染（text2sql 首选 schema 呈现）。
//
// 纯函数、零副作用、只依赖传入的 Metabase 元数据字段，输出 Markdown 字符串。
// 配套改动见 apps/agent-server/scripts/metabase-mcp.mjs 的 get_database_schema(mode:"mschema")。
// 设计依据：docs/bi-metabase-optimization-plan.md §4.3（M-Schema + 取值域内联 + 业务语义前置）。
//
// 关键取舍：
//  - 取值域从 Metabase fingerprint.type.values 直接抽取（低基数字段才带），**不发起额外 API 调用**，
//    化解「描述里的枚举会过期 / 模型猜取值」两类错误（doc T4 / S9）。
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

function isPk(field) {
  return field?.semantic_type === "type/PK" || field?.pk === true;
}

function fkTarget(field, fieldIndex) {
  return field?.fk_target_field_id ? fieldIndex.get(field.fk_target_field_id) : null;
}

function renderMSchemaField(field, fieldIndex, currentTable) {
  const pk = isPk(field);
  const fk = fkTarget(field, fieldIndex);
  const selfRef = fk && currentTable && String(fk).startsWith(`${currentTable}.`);
  // Metabase 元数据里 base_type / semantic_type 都带 "type/" 前缀，M-Schema 里剥掉，保持紧凑（doc §4.3 样例即无前缀）。
  const base = String(field.base_type || "").replace(/^type\//, "");
  const parts = [`- ${field.name}`, base];
  if (pk) parts.push("PK");
  if (fk) parts.push(`FK → ${fk}${selfRef ? " (self)" : ""}`);
  if (field.semantic_type && field.semantic_type !== "type/PK")
    parts.push(field.semantic_type.replace(/^type\//, ""));
  let line = parts.join("  ").replace(/\s+/g, " ").trim();
  const values = valueHints(field);
  if (values) line += `  values: [${values.map((v) => JSON.stringify(v)).join(", ")}]`;
  if (field.description) line += `  desc: ${clipText(field.description, 300)}`;
  return line;
}

/** 单表 M-Schema（含所有字段）。 */
export function renderTableMSchema(databaseName, databaseId, engine, table, fieldIndex) {
  const fields = Array.isArray(table.fields) ? table.fields : [];
  const fkCount = fields.filter((f) => f.fk_target_field_id).length;
  const name = table.schema && table.schema !== "public" ? `${table.schema}.${table.name}` : table.name;
  const lines = [
    `# Database: ${databaseName} (${engine})  [DB_ID: ${databaseId}]`,
    `## Table: ${name}  [#Table]  (${fields.length} fields, ${fkCount} FK)`,
  ];
  if (table.description) lines.push(`> ${clipText(table.description, 200)}`);
  for (const f of fields) lines.push(renderMSchemaField(f, fieldIndex, table.name));
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
