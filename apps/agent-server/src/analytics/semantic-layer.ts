import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 可枚举维：Ambiguity Gate 用（filter_set 未接地则反问）。 */
export interface EnumDimensionDef {
  id: string;
  field: string;
  aliases: string[];
  /** 集合未列成员时的信号（与别名共现才触发该维） */
  setSignals?: string[];
  domain?: "probe" | "pack";
  /**
   * How filter tokens are grounded:
   * - metabase_lexicon: code↔label from Metabase field values/description
   * - probe: live Top-N values (contentLang)
   * - literal: tokens used as stored values as-is
   */
  valueDomain?: "metabase_lexicon" | "probe" | "literal";
  allowedValues?: string[];
  /** Surface form → stored code (e.g. 印度A → IndiaA). Pack-owned, not code allow-lists. */
  valueAliases?: Record<string, string>;
  /** NL 未提及时用 defaultMovieTypes，不反问 */
  defaultWhenAbsent?: boolean;
}

export interface MetricDefOption {
  id: string;
  label: string;
  groundSignals?: string[];
  /** 语义层编译配方（Intent→SQL）；有则走确定性编译 */
  compile?: {
    kind: "avg_of_max" | "uniq" | "sum" | "avg_per_user";
    valueField?: string;
    entityKeys?: string[];
    distinctField?: string;
  };
}


/** 指标别名 → 多口径；未选中则 clarify。 */
export interface MetricDef {
  id: string;
  aliases: string[];
  options: MetricDefOption[];
}

export type PackCatalogMeta = {
  fetchedAt: number;
  stale: boolean;
  tableCount: number;
  schemas: string[];
  source: "metabase" | "cache" | "skipped";
  fieldDiff?: { table: string; added: string[]; removed: string[] };
  answerableCount?: number;
  hiddenCount?: number;
};

/** Runtime snapshot of one warehouse table (live catalog, not pack JSON). */
export type WarehouseTable = {
  schema: string;
  name: string;
  fields: string[];
  fieldTypes?: Record<string, string>;
};

export function inferTimeFieldFromTypes(
  fieldTypes?: Record<string, string>,
  fieldNames?: string[],
): string | undefined {
  const names = fieldNames?.length ? fieldNames : Object.keys(fieldTypes || {});
  if (!names.length) return undefined;
  const typeOf = (n: string) => String(fieldTypes?.[n] || "");
  const isTemporalType = (n: string) => /date|time/i.test(typeOf(n));
  const isTemporalName = (n: string) => /(?:^|_)(?:create|update|record|watch|event|pay|order)?(?:ed)?(?:time|date|at)$/i.test(n);
  const typed = names.filter(isTemporalType);
  return typed.find(isTemporalName) || typed[0] || names.find(isTemporalName);
}

export function warehouseTable(pack: AnalyticsPack | undefined, table?: string): WarehouseTable | undefined {
  if (!table) return undefined;
  return pack?.warehouse?.tables.find((t) => t.name === table);
}

export function overlayTableName(pack: AnalyticsPack | undefined): string {
  return String(pack?.tables?.[0]?.name || "").trim();
}

export function isOverlayTable(pack: AnalyticsPack | undefined, table?: string): boolean {
  const overlay = overlayTableName(pack);
  return !table || !overlay || table === overlay;
}

export function packFieldsForTable(pack: AnalyticsPack | undefined, table?: string): string[] {
  if (table && !isOverlayTable(pack, table)) {
    return warehouseTable(pack, table)?.fields || [];
  }
  const overlay = pack?.tables?.[0];
  if (overlay?.fields.length) return overlay.fields;
  if (table) return warehouseTable(pack, table)?.fields || [];
  return [];
}

export function tableHasField(pack: AnalyticsPack | undefined, table: string | undefined, field: string): boolean {
  const fields = packFieldsForTable(pack, table);
  return fields.includes(field);
}

/** Overlay `channel` is a text code (IndiaA). Other tables may store numeric channel ids. */
export function canApplyTextChannelFilter(pack: AnalyticsPack | undefined, table?: string): boolean {
  if (!tableHasField(pack, table, "channel")) return false;
  if (isOverlayTable(pack, table)) return true;
  return !isNumericWarehouseType(packFieldType(pack, "channel", table));
}

/** Drop overlay-only filters (channel / movieType / …) that the target table does not have. */
export function pruneFiltersToTable(
  pack: AnalyticsPack | undefined,
  table: string | undefined,
  filters: Record<string, string[]>,
): Record<string, string[]> {
  const known = new Set(packFieldsForTable(pack, table));
  if (!known.size) return { ...filters };
  const out: Record<string, string[]> = {};
  for (const [field, values] of Object.entries(filters || {})) {
    if (known.has(field) && values?.length) out[field] = values;
  }
  if (out.channel && !canApplyTextChannelFilter(pack, table)) {
    const ty = packFieldType(pack, "channel", table);
    if (isNumericWarehouseType(ty) && out.channel.some((v) => v !== "" && !/^-?\d+(\.\d+)?$/.test(v))) {
      delete out.channel;
    }
  }
  return out;
}

/** Non-overlay tables: schema.table when Metabase schema is set. Overlay stays unqualified. */
export function compileTableRef(pack: AnalyticsPack | undefined, table: string): string {
  const name = String(table || "").trim();
  if (!name) return name;
  if (isOverlayTable(pack, name)) return name;
  const schema = String(warehouseTable(pack, name)?.schema || "").trim();
  if (!schema || schema === "(default)") return name;
  return `${schema}.${name}`;
}

export function allowedTableNames(pack: AnalyticsPack | undefined): string[] {
  const names = new Set<string>();
  for (const t of pack?.tables || []) {
    if (t.name) names.add(t.name);
  }
  for (const t of pack?.warehouse?.tables || []) {
    if (t.name) names.add(t.name);
  }
  return [...names];
}

export function packTimeField(pack: AnalyticsPack | undefined, table?: string): string {
  if (isOverlayTable(pack, table)) {
    return String(pack?.time?.field || "lastWatchTime").trim() || "lastWatchTime";
  }
  const w = warehouseTable(pack, table);
  return inferTimeFieldFromTypes(w?.fieldTypes, w?.fields) || "";
}

export function packFieldType(
  pack: AnalyticsPack | undefined,
  field: string,
  table?: string,
): string | undefined {
  if (table && !isOverlayTable(pack, table)) {
    return warehouseTable(pack, table)?.fieldTypes?.[field];
  }
  return (
    pack?.tables?.[0]?.fieldTypes?.[field] || warehouseTable(pack, table || overlayTableName(pack))?.fieldTypes?.[field]
  );
}

export function isNumericWarehouseType(baseType?: string): boolean {
  if (!baseType) return false;
  return /int|float|decimal|double|number|long|uint/i.test(baseType);
}

export interface AnalyticsPack {
  version: string;
  id: string;
  datasource: { engine: string; metabaseDatabaseId: number };
  tables: Array<{
    name: string;
    fields: string[];
    /** Runtime: Metabase base_type per field (type/DateTime, type/Integer, …). */
    fieldTypes?: Record<string, string>;
  }>;
  /**
   * Runtime-only: answerable warehouse tables from the latest Metabase metadata.
   * Hidden tmp/dict/upload tables are excluded.
   */
  warehouse?: { tables: WarehouseTable[] };
  probeDimensions: string[];
  required_filters: string[];
  time: {
    businessTimezone: string;
    missingYearDefault: string;
    /** Physical time column; live catalog must still contain it. */
    field?: string;
  };
  /**
   * Runtime-only warehouse snapshot (not stored in pack JSON).
   * Filled by applyCatalogToPack after Metabase metadata refresh.
   */
  catalog?: PackCatalogMeta;
  guards: {
    distinctCountFn: "uniq" | "uniqExact";
    maxRows: number;
    maxProbeRounds: number;
    maxRewriteRounds: number;
    parallelism: number;
    defaultMovieTypes: number[];
    /** Metabase/CH 单次查询超时（毫秒）；缺省读 ANALYTICS_QUERY_TIMEOUT_MS 或 120000 */
    queryTimeoutMs?: number;
    /**
     * 行级强制过滤（RLS 钩子）：编译时 AND 进 WHERE，调用方/租户不可去掉。
     * 例：{ "channel": ["IndiaA"] }
     */
    forcedFilters?: Record<string, string[]>;
  };
  /** Ambiguity Gate / schema：可枚举维 */
  enumDimensions?: EnumDimensionDef[];
  /** 指标口径与 compile 配方 */
  metricDefs?: MetricDef[];
  /**
   * Demand–Capability：已支持能力白名单 + 已知但未建模的 op（供 LLM 声明、代码校验）。
   * 扩能力 = 实现 compile 后把 op/metric 移入白名单，不改闸门内核。
   */
  capabilities?: {
    ops: string[];
    metrics: string[];
    /**
     * opId → 用户可见说明；可选 groundSignals 供「模型漏填 ops」时从 NL 接地（配置在 pack，不在代码写死业务词）。
     */
    unsupportedOpsHint?: Record<
      string,
      string | { hint: string; groundSignals?: string[] }
    >;
    /** strict = 超纲 refuse；ask_downgrade = clarify 是否降级（默认 strict） */
    downgradePolicy?: "strict" | "ask_downgrade";
  };
  /** Post-exec delivery when requested members missing from result cells */
  delivery?: {
    missingChannel?: "zero_fill" | "explain";
  };
}

const root = join(dirname(fileURLToPath(import.meta.url)), "../../config/analytics");

export function enumDimForField(
  pack: AnalyticsPack | undefined,
  field: string,
): EnumDimensionDef | undefined {
  return (pack?.enumDimensions || []).find((d) => d.field === field);
}

/** Pack-owned surface→code map (印度A → IndiaA). Empty when pack/field has no aliases. */
export function extractAliasedEnumValues(
  nl: string,
  pack: AnalyticsPack | undefined,
  field: string,
): string[] {
  const aliases = enumDimForField(pack, field)?.valueAliases;
  if (!aliases) return [];
  const found = new Set<string>();
  for (const [alias, code] of Object.entries(aliases)) {
    if (alias && code && nl.includes(alias)) found.add(String(code));
  }
  return [...found];
}

export function remapEnumTokens(
  tokens: string[],
  pack: AnalyticsPack | undefined,
  field: string,
): string[] {
  const aliases = enumDimForField(pack, field)?.valueAliases;
  if (!aliases) return tokens;
  return tokens.map((t) => {
    const raw = String(t);
    if (aliases[raw]) return String(aliases[raw]);
    const hit = Object.entries(aliases).find(([k]) => k.toLowerCase() === raw.toLowerCase());
    return hit ? String(hit[1]) : raw;
  });
}

export function loadAnalyticsPack(id = "watch-detail"): AnalyticsPack {
  const raw = readFileSync(join(root, `${id}.pack.json`), "utf8");
  return JSON.parse(raw) as AnalyticsPack;
}

export function assertTableAllowed(pack: AnalyticsPack, table: string): void {
  if (!allowedTableNames(pack).includes(table)) {
    throw new Error(`table not in whitelist: ${table}`);
  }
}
