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
  /**
   * SQL lint: the empty value is a real member of this dimension, so `field != ''`
   * must not silently drop it. Config, not code — the field name lives in the pack.
   */
  denyEmptyExclusion?: boolean;
  /** NL naming this dim implies it is an output dim (group-by column). Config, not code. */
  outputDim?: boolean;
  /**
   * Human label for the empty value of this dim in clarify options
   * (e.g. blank locale means English). Config, not code.
   */
  emptyLabel?: string;
  /**
   * Surface forms that mean the empty member of this dim (label prefix from
   * emptyLabel + these aliases). Config, not code — no built-in token lists.
   */
  emptyAliases?: string[];
  /** SQL column alias for the empty member in wide/pivot shapes. Config, not code. */
  emptyAlias?: string;
  /**
   * Stored values of this dim are numeric codes; non-numeric filter tokens must be
   * refused instead of string-compared. Config, not code.
   */
  numericValues?: boolean;
  /**
   * Member-value pattern: how stored values / user tokens map to members.
   * - locale: members are locale codes (xx-YY) plus an empty member (英语/empty); the
   *   pack-declared "language dimension" carries this. Extracted from free text via the
   *   locale regex + emptyAliases; NOT a code↔label lexicon.
   * - lexicon: members are code↔label pairs resolved through Metabase field values; user
   *   names (电影/电视剧…) are memberCues that must be probed/resolved, never guessed.
   * - literal: tokens are stored values as-is (channel codes, named values).
   * Declaring this per dim removes every hard-coded contentLang/movieType reference from
   * the clarify slot cluster — the code reads memberKind instead of naming a dimension.
   */
  memberKind?: "locale" | "lexicon" | "literal";
  /**
   * Surface forms of *members* of this dim (e.g. 电影/电视剧/短剧…) used to tell
   * 「N 种 <dim>」集合问法 from「已点名成员」。Aligned with the warehouse lexicon.
   */
  memberCues?: string[];
}

export type RatioCompileSpec = {
  relationshipId: string;
  denominatorTable: string;
  numeratorTable: string;
  numeratorDistinctField: string;
  numeratorTimeField: string;
  numeratorFilters?: Record<string, string[]>;
  pivotField: string;
  filterFields: Record<string, Record<string, string>>;
};

export type RetentionLangSpec = {
  table: string;
  schema?: string;
  eventName: string;
  timeField: string;
  langField: string;
  versionField: string;
  channelField: string;
};

export type RetentionCompileSpec = {
  n: number;
  layout: "wide" | "total";
  cohortTable: string;
  cohortDateField: string;
  cohortChannelField: string;
  activeTable: string;
  activeDateField: string;
  activeChannelField: string;
  keyField: string;
  lang: RetentionLangSpec;
};

export interface MetricDefOption {
  id: string;
  label: string;
  groundSignals?: string[];
  /** Family alias with no option grounded → pick this option. */
  defaultWhenAbsent?: boolean;
  /** 语义层编译配方（Intent→SQL）；有则走确定性编译 */
  compile?: {
    kind: "avg_of_max" | "uniq" | "sum" | "avg_per_user" | "ratio" | "retention_dn";
    valueField?: string;
    entityKeys?: string[];
    distinctField?: string;
    /** SQL output column alias for single-value results; defaults to safeAlias(option id). */
    outputAlias?: string;
    ratio?: RatioCompileSpec;
    retention?: RetentionCompileSpec;
  };
}


/** 指标别名 → 多口径；未选中则 clarify。 */
export interface MetricDef {
  id: string;
  aliases: string[];
  /** Non-overlay metrics: lock tables[0]; overlayAsk must ignore these. */
  tables?: string[];
  requiredSlots?: Array<"channel" | "appVersion">;
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

export type WarehouseFieldMeta = {
  displayName?: string;
  description?: string | null;
};

/** Runtime snapshot of one warehouse table (live catalog, not pack JSON). */
export type WarehouseTable = {
  schema: string;
  name: string;
  fields: string[];
  fieldTypes?: Record<string, string>;
  displayName?: string;
  description?: string | null;
  /** Retrieval identity (对照/他表提及已剥掉). */
  identity?: string;
  /** NL synonyms for schema linking; not compile recipes. */
  synonyms?: string[];
  /** metabase = official description; inferred = catalog-inferred.json fallback. */
  docSource?: "metabase" | "inferred";
  fieldMeta?: Record<string, WarehouseFieldMeta>;
};

/**
 * Fallback heuristic for tables NOT declared in pack time.tableFields — generic English
 * warehouse naming conventions only (no business-system column names in code).
 * Higher = better default query window. ≤0 means do not use as the ask time column.
 */
export function timeFieldRank(name: string): number {
  const n = String(name || "");
  if (!n) return -100;
  if (/birthday/i.test(n)) return -100;
  if (/expire/i.test(n)) return -80;
  if (/^(endTime|endDate)$/i.test(n)) return -70;
  if (/^(reportDate|recordDate|activeDate|onlineTime|publishTime|day)$/i.test(n)) return 90;
  if (/^(date)$/i.test(n)) return 88;
  if (/^(createdTime|createTime|createDate|createdDate)$/i.test(n)) return 80;
  if (/^(serverTime|eventTime|eventDate)$/i.test(n)) return 70;
  if (/^(lastLoginTime)$/i.test(n)) return 60;
  if (/^(date|time|ct)$/i.test(n)) return 50;
  if (/updateTime|updateDate/i.test(n)) return 15;
  if (/(?:time|date|at)$/i.test(n)) return 10;
  return 0;
}

export function inferTimeFieldFromTypes(
  fieldTypes?: Record<string, string>,
  fieldNames?: string[],
): string | undefined {
  const names = fieldNames?.length ? fieldNames : Object.keys(fieldTypes || {});
  if (!names.length) return undefined;
  const typeOf = (n: string) => String(fieldTypes?.[n] || "");
  const isTemporalType = (n: string) => /date|time/i.test(typeOf(n));
  const typed = names.filter(isTemporalType);
  const candidates = typed.length ? typed : names.filter((n) => timeFieldRank(n) > 0);
  let best: string | undefined;
  let bestRank = 0;
  for (const n of candidates) {
    const rank = timeFieldRank(n);
    if (rank > bestRank) {
      bestRank = rank;
      best = n;
    }
  }
  return best;
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
    return String(pack?.time?.field || "").trim();
  }
  const w = warehouseTable(pack, table);
  // Pack-declared per-table ask window wins — validated against the live field list
  // (a stale declaration for a column the table no longer has must degrade, not guess).
  const declared = String(pack?.time?.tableFields?.[bareTableName(table || "")] || "").trim();
  if (declared && (!w?.fields?.length || w.fields.includes(declared))) {
    return declared;
  }
  // Fallback: generic naming heuristic; pack-excluded columns never qualify.
  const excluded = new Set((pack?.time?.excludeFields || []).map((f) => String(f).toLowerCase()));
  const candidates = (w?.fields || []).filter((f) => !excluded.has(String(f).toLowerCase()));
  return inferTimeFieldFromTypes(w?.fieldTypes, candidates) || "";
}

/**
 * Logical id of the pack's time grain dim (used in outputDims / grain verify).
 * Empty when the pack does not model a grain — callers must degrade, not guess.
 */
export function packGrainId(pack: AnalyticsPack | undefined): string {
  return String(pack?.time?.grainId || "").trim();
}

/** SQL/result alias for the grain column (e.g. the day column). Empty when undeclared. */
export function packGrainAlias(pack: AnalyticsPack | undefined): string {
  return String(pack?.time?.grainColumnAlias || "").trim();
}

/** First declared entity key — default column for a bare `uniq:*`. Empty when undeclared. */
export function packDefaultEntityKey(pack: AnalyticsPack | undefined): string {
  for (const e of pack?.entities || []) {
    for (const k of e.keys || []) {
      const key = String(k || "").trim();
      if (key) return key;
    }
  }
  return "";
}

/** True when this table has a usable analytics time column. */
export function tableHasTimeField(pack: AnalyticsPack | undefined, table?: string): boolean {
  return Boolean(packTimeField(pack, table));
}

export type PackRelationship = {
  id: string;
  left: { table: string; key: string; schema?: string };
  right: { table: string; key: string; schema?: string };
  join?: "inner" | "left";
};

export type PackEntity = {
  id: string;
  keys: string[];
};

/** Bare table name from schema.table or table. */
export function bareTableName(name: string): string {
  const t = String(name || "").trim();
  const dot = t.lastIndexOf(".");
  return dot >= 0 ? t.slice(dot + 1) : t;
}

export function packRelationships(pack: AnalyticsPack | undefined): PackRelationship[] {
  return pack?.relationships || [];
}

/** Seed tables plus neighbors declared in pack relationships (max two hops, cap 6). */
export function expandLinkedTables(
  pack: AnalyticsPack | undefined,
  seeds: string[],
  cap = 6,
): string[] {
  const allowed = allowedTableNames(pack);
  const nameByLower = new Map(allowed.map((t) => [t.toLowerCase(), t]));
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const b = bareTableName(raw).toLowerCase();
    if (!b || seen.has(b) || !nameByLower.has(b)) return;
    seen.add(b);
    out.push(nameByLower.get(b)!);
  };
  for (const s of seeds) add(s);
  for (let hop = 0; hop < 2; hop++) {
    const cur = [...out];
    for (const name of cur) {
      const b = bareTableName(name).toLowerCase();
      for (const r of packRelationships(pack)) {
        const l = bareTableName(r.left.table).toLowerCase();
        const rr = bareTableName(r.right.table).toLowerCase();
        if (l === b) add(r.right.table);
        if (rr === b) add(r.left.table);
      }
    }
  }
  return out.slice(0, cap);
}

/** True when this pair of tables is an allowed join (order-insensitive). */
export function relationshipAllowsJoin(
  pack: AnalyticsPack | undefined,
  leftTable: string,
  rightTable: string,
): boolean {
  const a = bareTableName(leftTable).toLowerCase();
  const b = bareTableName(rightTable).toLowerCase();
  if (!a || !b || a === b) return true;
  return packRelationships(pack).some((r) => {
    const l = bareTableName(r.left.table).toLowerCase();
    const rr = bareTableName(r.right.table).toLowerCase();
    return (l === a && rr === b) || (l === b && rr === a);
  });
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
  entities?: PackEntity[];
  relationships?: PackRelationship[];
  probeDimensions: string[];
  required_filters: string[];
  time: {
    businessTimezone: string;
    missingYearDefault: string;
    /** Physical time column; live catalog must still contain it. */
    field?: string;
    /**
     * Per-table ask-time column overrides (bare table name → physical column).
     * Config, not code; validated against the live field list before use — a stale
     * declaration degrades to the naming heuristic instead of being trusted blindly.
     */
    tableFields?: Record<string, string>;
    /** Columns that must never be picked as the ask time window. Config, not code. */
    excludeFields?: string[];
    /**
     * Logical id of the time grain dimension (e.g. day grain) used in outputDims.
     * Config, not code — callers read packGrainId(pack) instead of naming a grain.
     */
    grainId?: string;
    /** Result/SQL column alias for the grain column. Config, not code. */
    grainColumnAlias?: string;
    /** Human title for the grain column when the NL names it. Config, not code. */
    grainColumnLabel?: string;
    /**
     * CJK surface forms that request day-grain (by-day). Config, not code — keep all
     * business wording here so the analytics red line (no hard-coded business words) holds.
     */
    grainAliases?: string[];
  };
  /**
   * NL intent signals that relax a lint rule. CJK surface forms live here, never in code.
   * allowDropEmptyLang: user explicitly permits dropping empty-language rows.
   * allowLimit1: user explicitly asks for a single top row.
   */
  intentSignals?: {
    allowDropEmptyLang?: string[];
    allowLimit1?: string[];
  };
  /** CJK surface forms that request a wide (language-split) result shape. Config, not code. */
  wideShapeCues?: string[];
  /** CJK surface forms that request a long (row-per-member) result shape. Config, not code. */
  longShapeCues?: string[];
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
    /** Column that `defaultMovieTypes` filters on. Config, not code. */
    defaultMovieTypesField?: string;
    /** Language-wide columns when NL says 宽表 but does not name ≥2 locales. */
    defaultWideLangs?: string[];
    /**
     * Dimension id the wide (per-value conditional-aggregation) shape pivots on
     * (e.g. the language column). Config, not code — empty means no wide pivot,
     * callers must degrade instead of guessing.
     */
    widePivotDim?: string;
    /**
     * Dimension id that multi-intent plan tuples split on (one step per member,
     * e.g. channel compare). Config, not code — empty means no entity-split planning.
     */
    entityCompareDim?: string;
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

/** The pack-declared "language" dimension — members are locale codes with a special empty member. */
export function languageDimension(pack: AnalyticsPack | undefined): EnumDimensionDef | undefined {
  return (pack?.enumDimensions || []).find((d) => d.memberKind === "locale");
}

/** Enum dims by member-kind (locale = language codes, lexicon = metabase code↔label, literal = as-is). */
export function enumDimsByMemberKind(
  pack: AnalyticsPack | undefined,
  kind: "locale" | "lexicon" | "literal",
): EnumDimensionDef[] {
  return (pack?.enumDimensions || []).filter((d) => d.memberKind === kind);
}

/**
 * Resolve a user/assistant slot name to a canonical enum-dim id. Matches dim.id, dim.field,
 * or any alias — so a pack can name its language dimension anything and the model's
 * clarifySlot still routes. Unknown slot → returned unchanged (callers fall through).
 */
export function canonicalDimSlot(slot: string, pack: AnalyticsPack | undefined): string {
  const s = String(slot || "").trim().toLowerCase();
  if (!s || !pack?.enumDimensions?.length) return slot;
  for (const d of pack.enumDimensions) {
    const ids = [d.id, d.field, ...(d.aliases || [])].map((x) => String(x || "").toLowerCase());
    if (ids.includes(s)) return d.id || d.field || slot;
  }
  return slot;
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

/** Locale codes for language-wide columns when the user did not name ≥2 langs. */
export function findMetricOption(
  pack: AnalyticsPack | undefined,
  metricId: string,
): { def: MetricDef; opt: MetricDefOption } | undefined {
  const id = String(metricId || "").trim();
  if (!id || !pack) return undefined;
  for (const def of pack.metricDefs || []) {
    const opt = (def.options || []).find((o) => o.id === id);
    if (opt) return { def, opt };
  }
  return undefined;
}

export function packDefaultWideLangs(pack?: AnalyticsPack): string[] {
  const raw = pack?.guards?.defaultWideLangs;
  if (!Array.isArray(raw) || raw.length < 2) return [];
  return raw.map((v) => (v == null ? "" : String(v)));
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
