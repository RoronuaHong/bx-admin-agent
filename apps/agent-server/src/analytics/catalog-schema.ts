/**
 * Path C get_table_schema: on-demand columns for answerable tables only.
 */
import { tableIdentity, tableSynonyms } from "./catalog-card.js";
import { isHiddenCatalogTable } from "./catalog.js";
import { RICH_TABLE_CAP } from "./table-resolve.js";
import {
  bareTableName,
  packTimeField,
  warehouseTable,
  type AnalyticsPack,
} from "./semantic-layer.js";

export type TableSchemaOk = { status: "ok"; name: string; text: string };
export type TableSchemaRefuse = { status: "refused"; name: string; reason: string };
export type TableSchemaResult = TableSchemaOk | TableSchemaRefuse;

export type GetTableSchemasResult = {
  ok: string[];
  refused: TableSchemaRefuse[];
  text: string;
};

function shortType(baseType?: string): string {
  return String(baseType || "").replace(/^type\//, "") || "";
}

export function getTableSchema(pack: AnalyticsPack, rawName: string): TableSchemaResult {
  const name = bareTableName(rawName);
  if (!name) return { status: "refused", name: rawName, reason: "empty" };
  if (isHiddenCatalogTable({ name })) {
    return { status: "refused", name, reason: "hidden" };
  }
  const w =
    warehouseTable(pack, name) ||
    pack.warehouse?.tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (!w) return { status: "refused", name, reason: "not_answerable" };
  const time = packTimeField(pack, name) || "none";
  const syn = tableSynonyms(w).slice(0, 8).join(", ");
  const lines = [
    `### ${w.schema}.${w.name}`,
    `identity: ${tableIdentity(w) || w.displayName || w.name}`,
    syn ? `synonyms: ${syn}` : "",
    `time: ${time}`,
    "columns:",
  ].filter(Boolean);
  const fields = w.fields.slice(0, 60);
  for (const f of fields) {
    const meta = w.fieldMeta?.[f];
    const typ = shortType(w.fieldTypes?.[f]);
    const label = meta?.displayName && meta.displayName !== f ? meta.displayName : "";
    const desc = String(meta?.description || "").replace(/\s+/g, " ").trim();
    lines.push(`- ${f}${typ ? ` ${typ}` : ""}${label ? ` ${label}` : ""}${desc ? ` — ${desc.slice(0, 80)}` : ""}`);
  }
  if (w.fields.length > 60) lines.push(`- … +${w.fields.length - 60} more`);
  return { status: "ok", name: w.name, text: lines.join("\n") };
}

export function getTableSchemas(pack: AnalyticsPack, names: string[], cap = RICH_TABLE_CAP): GetTableSchemasResult {
  const seen = new Set<string>();
  const ok: string[] = [];
  const refused: TableSchemaRefuse[] = [];
  const blocks: string[] = [];
  for (const raw of names) {
    const key = bareTableName(raw).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (ok.length >= cap) {
      refused.push({ status: "refused", name: raw, reason: "cap" });
      continue;
    }
    const got = getTableSchema(pack, raw);
    if (got.status === "ok") {
      ok.push(got.name);
      blocks.push(got.text);
    } else {
      refused.push(got);
    }
  }
  return {
    ok,
    refused,
    text: blocks.length ? ["get_table_schema result:", ...blocks].join("\n\n") : "",
  };
}
