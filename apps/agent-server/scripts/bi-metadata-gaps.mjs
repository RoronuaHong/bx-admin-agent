// 元数据缺口清单：卡片 SQL 里常用、但在 Metabase 里没有字段描述的列，按被多少张卡片用到排序。
// 给业务方在 Admin → Table Metadata 补描述用；描述会被 get_database_schema / M-Schema 前置给模型，补一处、每次查询都受益。
// 用法：node scripts/bi-metadata-gaps.mjs [database_id]   只读 GET /api/database/{id}/metadata，结果写 .data/bi-metadata-gaps.json；
// 同时把各表检索文本（tableSearchText）写进 tests/bi-known-tables.json 的 tableTexts，供 bi-caliber-eval.mjs 离线评测口径图用。
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMetabaseKey } from "./metabase-key.mjs";
import { tableSearchText } from "./bi-caliber-graph.mjs";

const ENUM_NAME = /(status|type|state|level|flag|source|channel|kind|mode)$/i;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @param metaTables Metabase /metadata 的 tables（含 fields）
 * @param cases 黄金集用例 [{ id, expected_sql, tables }]
 * @returns 按卡片数降序的 [{ table, column, cards, cardIds, semantic, likelyEnum }]，只含无描述的列
 */
export function metadataGaps(metaTables, cases) {
  const byBare = new Map();
  for (const t of metaTables || []) byBare.set(String(t.name).toLowerCase(), t);
  const usage = new Map();
  for (const c of cases || []) {
    if (!c.expected_sql) continue;
    for (const ref of c.tables || []) {
      const t = byBare.get(String(ref).split(".").pop().toLowerCase());
      if (!t) continue;
      const qualified = t.schema && t.schema !== "public" ? `${t.schema}.${t.name}` : t.name;
      for (const f of t.fields || []) {
        if (String(f.description || "").trim()) continue;
        if (!new RegExp(`(?<![\\w])${escapeRe(f.name)}(?![\\w])`).test(c.expected_sql)) continue;
        const key = `${qualified}.${f.name}`;
        if (!usage.has(key)) {
          usage.set(key, {
            table: qualified,
            column: f.name,
            cardIds: new Set(),
            semantic: f.semantic_type || null,
            likelyEnum: f.semantic_type === "type/Category" || ENUM_NAME.test(f.name),
          });
        }
        usage.get(key).cardIds.add(c.id);
      }
    }
  }
  return [...usage.values()]
    .map((u) => ({ ...u, cards: u.cardIds.size, cardIds: [...u.cardIds].sort((a, b) => a - b) }))
    .sort((a, b) => b.cards - a.cards || Number(b.likelyEnum) - Number(a.likelyEnum) || a.table.localeCompare(b.table));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dbId = Number(process.argv[2] || process.env.METABASE_DATABASE_ID || 2);
  const base = (process.env.BI_BASE_URL || "").replace(/\/+$/, "");
  const { key } = resolveMetabaseKey(process.env);
  if (!base || !key) {
    console.error("未配置 BI_BASE_URL 或 BI_API_KEY（apps/agent-server/.env）。");
    process.exit(1);
  }
  const res = await fetch(`${base}/api/database/${dbId}/metadata`, { headers: { "X-API-Key": key } });
  if (!res.ok) {
    console.error(`读取元数据失败：HTTP ${res.status}`);
    process.exit(1);
  }
  const meta = await res.json();
  const golden = JSON.parse(fs.readFileSync(path.join(root, "tests", "bi-golden-set.json"), "utf8"));
  const gaps = metadataGaps(meta.tables, golden.cases);
  const fields = (meta.tables || []).flatMap((t) => t.fields || []);
  const described = fields.filter((f) => String(f.description || "").trim()).length;
  const out = path.join(root, ".data", "bi-metadata-gaps.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify({ generatedAt: new Date().toISOString(), databaseId: dbId, fields: fields.length, described, gaps }, null, 2),
  );
  console.log(`字段 ${fields.length}，有描述 ${described}；卡片用到但无描述的列 ${gaps.length} 个（前 30）：`);
  for (const g of gaps.slice(0, 30)) {
    console.log(`  ${String(g.cards).padStart(3)} 张卡片  ${g.table}.${g.column}${g.likelyEnum ? "  [疑似枚举]" : ""}`);
  }
  console.log(`报告已写: ${out}`);

  const knownPath = path.join(root, "tests", "bi-known-tables.json");
  const knownDoc = JSON.parse(fs.readFileSync(knownPath, "utf8"));
  const tableTexts = {};
  for (const t of meta.tables || []) {
    const text = tableSearchText(t);
    if (text) tableTexts[(t.schema && t.schema !== "public" ? `${t.schema}.${t.name}` : t.name).toLowerCase()] = text;
  }
  fs.writeFileSync(knownPath, JSON.stringify({ ...knownDoc, tableTexts }, null, 2));
  console.log(`表检索文本已写入 ${knownPath}（${Object.keys(tableTexts).length} 张表有描述文本）`);
}
