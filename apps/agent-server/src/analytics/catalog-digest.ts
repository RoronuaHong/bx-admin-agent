/**
 * Catalog digest: human + machine snapshot of live Metabase metadata.
 * Does not invent metrics. Overlay recipes stay in watch-detail.pack.json.
 */

import { tableIdentity, tableSynonyms } from "./catalog-card.js";
import {
  inferTimeFieldFromTypes,
  type AnalyticsPack,
  type WarehouseTable,
} from "./semantic-layer.js";
import { isHiddenCatalogTable, type AnalyticsCatalog, type CatalogTable } from "./catalog.js";

export type DigestField = {
  name: string;
  displayName?: string;
  description?: string | null;
  type?: string;
};

export type DigestTable = {
  schema: string;
  name: string;
  hidden: boolean;
  displayName?: string;
  description?: string | null;
  blurb: string;
  timeField: string | null;
  fieldCount: number;
  describedFieldCount: number;
  fields: DigestField[];
};

export type CatalogDigest = {
  databaseId: number;
  fetchedAt: number;
  generatedAt: number;
  tableCount: number;
  answerableCount: number;
  hiddenCount: number;
  fieldCount: number;
  describedFieldCount: number;
  notes: string[];
  tables: DigestTable[];
};

function shortType(baseType?: string): string {
  return String(baseType || "").replace(/^type\//, "") || "?";
}

function usefulDisplay(name: string, display?: string): string | undefined {
  const d = String(display || "").trim();
  if (!d || d === name) return undefined;
  const compact = name.replace(/[_-]/g, "");
  if (d.replace(/[\s_-]/g, "").toLowerCase() === compact.toLowerCase()) return undefined;
  return d;
}

export function oneLineDoc(text: string, max = 100): string {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;
}

export function warehouseTableHasDocs(t: { description?: string | null } | undefined): boolean {
  return Boolean(String(t?.description || "").trim());
}

function hintLine(t: WarehouseTable): string {
  const time = inferTimeFieldFromTypes(t.fieldTypes, t.fields) || "none";
  const syn = tableSynonyms(t).slice(0, 6).join("/");
  const id = tableIdentity(t) || t.description || t.displayName || "";
  return `- ${t.name} time=${time}${syn ? ` syn=${syn}` : ""}: ${oneLineDoc(id, 80)}`;
}

/** One-line index of every answerable warehouse table (Path C compact catalog). */
export function formatAnswerableCatalogHint(pack: AnalyticsPack): string {
  const tables = pack.warehouse?.tables || [];
  if (!tables.length) return "No answerable warehouse tables in this snapshot.";
  return [
    `Answerable tables (${tables.length}). Index only (name/syn/time). Full columns require get_table_schema.`,
    ...tables.map(hintLine),
  ].join("\n");
}

/** Compact documented-table list for structure / schema-agent (not the full markdown). */
export function formatDocumentedCatalogHint(pack: AnalyticsPack): string {
  const tables = pack.warehouse?.tables || [];
  const official = tables.filter((t) => t.docSource === "metabase" || (!t.docSource && warehouseTableHasDocs(t)));
  const inferred = tables.filter((t) => t.docSource === "inferred");
  if (!official.length && !inferred.length) {
    return "No table descriptions in this snapshot. Non-overlay tables require the exact physical name.";
  }
  const lines: string[] = [];
  if (official.length) {
    lines.push(`Metabase-documented tables (${official.length}/${tables.length}):`);
    lines.push(...official.map(hintLine));
  }
  if (inferred.length) {
    lines.push(`Inferred temporary docs (${inferred.length}; not official Metabase):`);
    lines.push(...inferred.map(hintLine));
  }
  return lines.join("\n");
}

export function tableBlurb(t: CatalogTable): string {
  const tableDesc = String(t.description || "").trim();
  if (tableDesc) return tableDesc;
  const bits: string[] = [];
  for (const f of t.fields) {
    const desc = String(f.description || "").trim();
    const label = usefulDisplay(f.name, f.displayName);
    if (desc) bits.push(`${f.name}: ${desc}`);
    else if (label) bits.push(`${f.name}: ${label}`);
    if (bits.length >= 4) break;
  }
  if (bits.length) return bits.join("；");
  return `无表级说明；${t.fields.length} 列`;
}

export function digestTable(t: CatalogTable): DigestTable {
  const fieldTypes: Record<string, string> = {};
  for (const f of t.fields) {
    if (f.baseType) fieldTypes[f.name] = f.baseType;
  }
  const timeField = inferTimeFieldFromTypes(fieldTypes, t.fields.map((f) => f.name)) || null;
  const fields: DigestField[] = t.fields.map((f) => ({
    name: f.name,
    displayName: usefulDisplay(f.name, f.displayName) || f.displayName,
    description: f.description ?? null,
    type: shortType(f.baseType),
  }));
  const describedFieldCount = fields.filter((f) => String(f.description || "").trim()).length;
  return {
    schema: t.schema,
    name: t.name,
    hidden: isHiddenCatalogTable(t),
    displayName: usefulDisplay(t.name, t.displayName) || t.displayName,
    description: t.description ?? null,
    blurb: tableBlurb(t),
    timeField,
    fieldCount: t.fields.length,
    describedFieldCount,
    fields,
  };
}

export function buildCatalogDigest(catalog: AnalyticsCatalog, generatedAt = Date.now()): CatalogDigest {
  const tables = catalog.tables.map(digestTable);
  const answerable = tables.filter((t) => !t.hidden);
  const hidden = tables.filter((t) => t.hidden);
  const fieldCount = tables.reduce((n, t) => n + t.fieldCount, 0);
  const describedFieldCount = tables.reduce((n, t) => n + t.describedFieldCount, 0);
  return {
    databaseId: catalog.databaseId,
    fetchedAt: catalog.fetchedAt,
    generatedAt,
    tableCount: tables.length,
    answerableCount: answerable.length,
    hiddenCount: hidden.length,
    fieldCount,
    describedFieldCount,
    notes: [
      "Source: Metabase GET /api/database/{id}/metadata (REST), not MCP.",
      "Hidden: _tmp / _dict / upload_* / schema metabase_upload — not queryable.",
      "Overlay metrics are only authored for the pack's overlay table.",
      "Other tables: compile uniq|sum|avg|count on live columns; do not invent metrics from names.",
    ],
    tables,
  };
}

export function formatCatalogDigestMarkdown(digest: CatalogDigest): string {
  const when = new Date(digest.generatedAt).toISOString();
  const fetched = digest.fetchedAt ? new Date(digest.fetchedAt).toISOString() : "?";
  const bySchema = new Map<string, DigestTable[]>();
  for (const t of digest.tables.filter((x) => !x.hidden)) {
    const list = bySchema.get(t.schema) || [];
    list.push(t);
    bySchema.set(t.schema, list);
  }
  const hidden = digest.tables.filter((t) => t.hidden);
  const lines: string[] = [
    "# Analytics Metabase 表结构说明（自动生成）",
    "",
    "> 由 live catalog 生成，**不要手改**。刷新：`pnpm --filter @bx/agent-server catalog-digest`",
    "",
    `- 生成时间：${when}`,
    `- metadata 拉取：${fetched}`,
    `- 数据库：Metabase db ${digest.databaseId}`,
    `- 表：${digest.tableCount}（可答 ${digest.answerableCount}，隐藏 ${digest.hiddenCount}）`,
    `- 字段：${digest.fieldCount}（其中 ${digest.describedFieldCount} 个有 Metabase description）`,
    "",
    "## 怎么用",
    "",
    "- 问数 agent 用这份说明对表/列；已建模 KPI 由 pack 编译（overlay 口径），其余由模型对着目录写 SQL。",
    "- 其它可答表：按文档/字段检索后写 SQL，不要求用户先点名表。",
    "- `_tmp` / `_dict` / `upload_*` 不可查。",
    "- 无表级 description 的表：暂存推断见 [ANALYTICS_CATALOG_INFERRED.md](./ANALYTICS_CATALOG_INFERRED.md)。",
    "",
    "## 隐藏表（不可查询）",
    "",
  ];
  if (!hidden.length) {
    lines.push("（无）", "");
  } else {
    for (const t of hidden) {
      lines.push(`- \`${t.schema}.${t.name}\``);
    }
    lines.push("");
  }
  for (const [schema, tables] of [...bySchema.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## Schema \`${schema}\``, "");
    for (const t of tables) {
      const title = t.displayName && t.displayName !== t.name ? `${t.name}（${t.displayName}）` : t.name;
      lines.push(`### \`${schema}.${t.name}\``, "");
      lines.push(`- ${title}`);
      lines.push(`- 时间列：${t.timeField ? `\`${t.timeField}\`` : "无（聚合不带日期谓词）"}`);
      lines.push(`- 说明：${t.blurb}`);
      lines.push(`- 字段 ${t.fieldCount}，其中 ${t.describedFieldCount} 个有 description`, "");
      lines.push("| 字段 | 显示名 | 类型 | 说明 |");
      lines.push("|---|---|---|---|");
      for (const f of t.fields) {
        const disp = f.displayName && f.displayName !== f.name ? f.displayName : "";
        const desc = String(f.description || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
        lines.push(`| \`${f.name}\` | ${disp} | ${f.type || "?"} | ${desc} |`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}
