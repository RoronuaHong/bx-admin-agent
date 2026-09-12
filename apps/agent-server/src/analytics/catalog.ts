/**
 * Live warehouse catalog: Metabase metadata is the field/table truth.
 * Pack overlay (metrics / aliases / time.field) is not invented from column names.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchDatabaseMetadata, type MetabaseDatabaseMetadata } from "./metabase-client.js";
import {
  packTimeField,
  type AnalyticsPack,
  type PackCatalogMeta,
  type WarehouseTable,
} from "./semantic-layer.js";

export type CatalogField = {
  name: string;
  displayName?: string;
  description?: string | null;
  baseType?: string;
  semanticType?: string | null;
};

export type CatalogTable = {
  schema: string;
  name: string;
  fields: CatalogField[];
};

export type AnalyticsCatalog = {
  databaseId: number;
  fetchedAt: number;
  tables: CatalogTable[];
};

export type CatalogApplyResult = {
  pack: AnalyticsPack;
  notes: string[];
  unmodeledTablesInNl: string[];
};

const __dirname = dirname(fileURLToPath(import.meta.url));
let CATALOG_DIR = resolve(__dirname, "../../.data", "analytics-catalog");
const memoryCache = new Map<number, AnalyticsCatalog>();

export function _setCatalogDirForTest(dir: string): void {
  CATALOG_DIR = dir;
  memoryCache.clear();
}

export function catalogRefreshEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.ANALYTICS_CATALOG_REFRESH ?? "1").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

export function catalogTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ANALYTICS_CATALOG_TTL_MS || 10 * 60 * 1000);
  return Number.isFinite(n) && n >= 0 ? n : 10 * 60 * 1000;
}

function catalogPath(databaseId: number): string {
  return resolve(CATALOG_DIR, `db-${databaseId}.json`);
}

/** Tables the agent must not query even if they exist in Metabase. */
export function isHiddenCatalogTable(t: { schema?: string; name: string }): boolean {
  const name = String(t.name || "").toLowerCase();
  const schema = String(t.schema || "").toLowerCase();
  if (!name) return true;
  if (schema === "metabase_upload") return true;
  if (name.startsWith("upload_")) return true;
  return /_tmp$|_dict$/.test(name);
}

export function answerableCatalogTables(catalog: AnalyticsCatalog): CatalogTable[] {
  return catalog.tables.filter((t) => !isHiddenCatalogTable(t));
}

export function warehouseFromCatalog(catalog: AnalyticsCatalog): WarehouseTable[] {
  return answerableCatalogTables(catalog).map((t) => {
    const fieldTypes: Record<string, string> = {};
    for (const f of t.fields) {
      if (f.baseType) fieldTypes[f.name] = f.baseType;
    }
    return {
      schema: t.schema,
      name: t.name,
      fields: t.fields.map((f) => f.name),
      fieldTypes: Object.keys(fieldTypes).length ? fieldTypes : undefined,
    };
  });
}

function isActiveVisibleField(f: {
  name?: string;
  active?: boolean;
  visibility_type?: string;
}): boolean {
  if (!f.name?.trim()) return false;
  if (f.active === false) return false;
  const vis = String(f.visibility_type || "normal").toLowerCase();
  return vis !== "hidden" && vis !== "retired" && vis !== "sensitive";
}

export function parseMetabaseDatabaseMetadata(
  raw: MetabaseDatabaseMetadata,
  databaseId: number,
  fetchedAt = Date.now(),
): AnalyticsCatalog {
  const tables: CatalogTable[] = [];
  for (const t of raw.tables || []) {
    const name = String(t.name || "").trim();
    if (!name) continue;
    if (t.active === false) continue;
    const fields: CatalogField[] = [];
    for (const f of t.fields || []) {
      if (!isActiveVisibleField(f)) continue;
      fields.push({
        name: String(f.name).trim(),
        displayName: f.display_name || undefined,
        description: f.description ?? null,
        baseType: f.base_type || undefined,
        semanticType: f.semantic_type ?? null,
      });
    }
    tables.push({
      schema: String(t.schema || "").trim() || "(default)",
      name,
      fields,
    });
  }
  tables.sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`));
  return { databaseId, fetchedAt, tables };
}

export function diffTableFields(
  prev: string[] | undefined,
  next: string[],
): { added: string[]; removed: string[] } {
  const before = new Set((prev || []).map(String));
  const after = new Set(next.map(String));
  return {
    added: next.filter((f) => !before.has(f)),
    removed: [...before].filter((f) => !after.has(f)),
  };
}

export function findCatalogTable(
  catalog: AnalyticsCatalog,
  tableName: string,
): CatalogTable | undefined {
  const want = String(tableName || "").trim();
  return catalog.tables.find((t) => t.name === want);
}

function requiredCompileFields(pack: AnalyticsPack): string[] {
  const ids = new Set<string>([packTimeField(pack)]);
  for (const d of pack.enumDimensions || []) {
    if (d.field) ids.add(d.field);
  }
  for (const d of pack.probeDimensions || []) ids.add(d);
  for (const def of pack.metricDefs || []) {
    for (const opt of def.options || []) {
      const c = opt.compile;
      if (!c) continue;
      if (c.valueField) ids.add(c.valueField);
      if (c.distinctField) ids.add(c.distinctField);
      for (const k of c.entityKeys || []) ids.add(k);
    }
  }
  return [...ids];
}

export function applyCatalogToPack(
  pack: AnalyticsPack,
  catalog: AnalyticsCatalog,
  source: PackCatalogMeta["source"] = "metabase",
): CatalogApplyResult {
  const notes: string[] = [];
  const schemas = [...new Set(catalog.tables.map((t) => t.schema))].sort();
  const tables = pack.tables.map((slot) => {
    const live = findCatalogTable(catalog, slot.name);
    if (!live) {
      notes.push(`catalog_table_missing:${slot.name}`);
      return { ...slot };
    }
    const liveNames = live.fields.map((f) => f.name);
    const diff = diffTableFields(slot.fields, liveNames);
    if (diff.added.length || diff.removed.length) {
      notes.push(
        `catalog_field_diff:${slot.name}:+${diff.added.length}/-${diff.removed.length}`,
      );
    }
    const missing = requiredCompileFields(pack).filter((f) => !liveNames.includes(f));
    if (missing.length) {
      notes.push(`catalog_missing_compile_fields:${missing.join(",")}`);
    }
    const fieldTypes: Record<string, string> = {};
    for (const f of live.fields) {
      if (f.baseType) fieldTypes[f.name] = f.baseType;
    }
    return {
      ...slot,
      fields: liveNames,
      fieldTypes: Object.keys(fieldTypes).length ? fieldTypes : undefined,
    };
  });

  const first = tables[0];
  const liveFirst = first ? findCatalogTable(catalog, first.name) : undefined;
  const fieldDiff =
    first && liveFirst
      ? { table: first.name, ...diffTableFields(pack.tables[0]?.fields, first.fields) }
      : undefined;

  const warehouse = warehouseFromCatalog(catalog);
  const catalogMeta: PackCatalogMeta = {
    fetchedAt: catalog.fetchedAt,
    stale: source === "cache" || source === "skipped",
    tableCount: catalog.tables.length,
    schemas,
    source,
    fieldDiff,
    answerableCount: warehouse.length,
    hiddenCount: Math.max(0, catalog.tables.length - warehouse.length),
  };

  return {
    pack: { ...pack, tables, warehouse: { tables: warehouse }, catalog: catalogMeta },
    notes,
    unmodeledTablesInNl: [],
  };
}

function tableNameInNl(nl: string, tableName: string): boolean {
  if (tableName.length < 3) return false;
  const re = new RegExp(
    `(?:^|[^A-Za-z0-9_])${tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^A-Za-z0-9_])`,
  );
  return re.test(nl);
}

/** Hidden (tmp/dict/upload) tables named in NL — never answerable. */
export function blockedTablesNamedInNl(nl: string, catalog?: AnalyticsCatalog | null): string[] {
  const text = String(nl || "");
  if (!text) return [];
  const hits: string[] = [];
  if (catalog) {
    for (const t of catalog.tables) {
      if (!isHiddenCatalogTable(t)) continue;
      if (tableNameInNl(text, t.name)) hits.push(t.name);
    }
  }
  for (const m of text.matchAll(/\b([A-Za-z][A-Za-z0-9_]*(?:_tmp|_dict))\b/g)) {
    hits.push(m[1]!);
  }
  for (const m of text.matchAll(/\b(upload_[A-Za-z0-9_]+)\b/gi)) {
    hits.push(m[1]!);
  }
  return [...new Set(hits)];
}

/**
 * @deprecated Use blockedTablesNamedInNl. Kept so callers that still pass pack
 * only refuse hidden tables, not every non-overlay table.
 */
export function unmodeledTablesNamedInNl(
  nl: string,
  catalog: AnalyticsCatalog,
  _pack?: AnalyticsPack,
): string[] {
  return blockedTablesNamedInNl(nl, catalog);
}

export function answerableTableNamedInNl(nl: string, pack: AnalyticsPack): string | undefined {
  const text = String(nl || "");
  if (!text) return undefined;
  const names = [...(pack.warehouse?.tables || []).map((t) => t.name), ...pack.tables.map((t) => t.name)];
  const uniq = [...new Set(names)].sort((a, b) => b.length - a.length);
  for (const name of uniq) {
    if (tableNameInNl(text, name)) return name;
  }
  return undefined;
}

function readDiskCatalog(databaseId: number): AnalyticsCatalog | null {
  const path = catalogPath(databaseId);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as AnalyticsCatalog;
    if (!raw || raw.databaseId !== databaseId || !Array.isArray(raw.tables)) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeDiskCatalog(catalog: AnalyticsCatalog): void {
  mkdirSync(CATALOG_DIR, { recursive: true });
  writeFileSync(catalogPath(catalog.databaseId), JSON.stringify(catalog, null, 2) + "\n");
}

function cacheFresh(catalog: AnalyticsCatalog, now: number, ttl: number): boolean {
  return now - catalog.fetchedAt <= ttl;
}

export async function loadOrRefreshCatalog(input: {
  databaseId: number;
  signal?: AbortSignal;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{ catalog: AnalyticsCatalog; source: PackCatalogMeta["source"] } | { skipped: true; reason: string }> {
  const env = input.env || process.env;
  if (!catalogRefreshEnabled(env)) {
    return { skipped: true, reason: "catalog_refresh_disabled" };
  }
  const ttl = catalogTtlMs(env);
  const now = Date.now();
  const mem = memoryCache.get(input.databaseId);
  if (!input.force && mem && cacheFresh(mem, now, ttl)) {
    return { catalog: mem, source: "cache" };
  }
  const disk = readDiskCatalog(input.databaseId);
  if (!input.force && disk && cacheFresh(disk, now, ttl)) {
    memoryCache.set(input.databaseId, disk);
    return { catalog: disk, source: "cache" };
  }

  const fetched = await fetchDatabaseMetadata(input.databaseId, { signal: input.signal });
  if (!fetched.ok) {
    if (disk) {
      memoryCache.set(input.databaseId, disk);
      return { catalog: disk, source: "cache" };
    }
    return { skipped: true, reason: fetched.error || "catalog_fetch_failed" };
  }
  const catalog = parseMetabaseDatabaseMetadata(fetched.data, input.databaseId, now);
  memoryCache.set(input.databaseId, catalog);
  try {
    writeDiskCatalog(catalog);
  } catch {
    /* disk cache best-effort */
  }
  return { catalog, source: "metabase" };
}

export async function refreshPackFromCatalog(
  pack: AnalyticsPack,
  opts?: { signal?: AbortSignal; force?: boolean; nl?: string; env?: NodeJS.ProcessEnv },
): Promise<CatalogApplyResult> {
  const databaseId = pack.datasource.metabaseDatabaseId;
  const loaded = await loadOrRefreshCatalog({
    databaseId,
    signal: opts?.signal,
    force: opts?.force,
    env: opts?.env,
  });
  if ("skipped" in loaded) {
    return {
      pack: {
        ...pack,
        catalog: {
          fetchedAt: 0,
          stale: true,
          tableCount: 0,
          schemas: [],
          source: "skipped",
        },
      },
      notes: [`catalog_skipped:${loaded.reason}`],
      unmodeledTablesInNl: blockedTablesNamedInNl(opts?.nl || "", null),
    };
  }
  const applied = applyCatalogToPack(pack, loaded.catalog, loaded.source);
  applied.unmodeledTablesInNl = blockedTablesNamedInNl(opts?.nl || "", loaded.catalog);
  return applied;
}

export function formatCatalogFacts(pack: AnalyticsPack, notes: string[]): string | undefined {
  const c = pack.catalog;
  if (!c) return undefined;
  if (c.source === "skipped") {
    return `- warehouse_catalog: skipped (${notes.filter((n) => n.startsWith("catalog_skipped")).join("; ") || "unavailable"})`;
  }
  const table = pack.tables[0];
  const diff = c.fieldDiff;
  const diffBit =
    diff && (diff.added.length || diff.removed.length)
      ? `; overlay ${diff.table} live ${table?.fields.length || 0} fields (+${diff.added.length}/-${diff.removed.length} vs pack file)`
      : table
        ? `; overlay ${table.name} fields=${table.fields.length}`
        : "";
  const answerable = c.answerableCount ?? pack.warehouse?.tables.length ?? 0;
  const hidden = c.hiddenCount ?? Math.max(0, c.tableCount - answerable);
  return `- warehouse_catalog: db ${c.tableCount} tables (${answerable} answerable, ${hidden} hidden tmp/dict/upload) in ${c.schemas.join("/") || "?"} (${c.source})${diffBit}; new/updated tables come from live metadata`;
}
