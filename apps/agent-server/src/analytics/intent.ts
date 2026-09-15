/**
 * Analytics Intent — schema-agent 结构化后的查询计划（语义层中间态）。
 * SQL 由 sql-compile 确定性编译；失败时由 pipeline 用 LLM 诊断原因，不写 SQL。
 */

import { extractNamedEntities } from "./named-entities.js";
import { nlWantsDim, nlWantsGrain } from "./nl-signals.js";
import {
  extractAliasedEnumValues,
  isOverlayTable,
  packDefaultEntityKey,
  packFieldsForTable,
  packGrainId,
  canApplyTextChannelFilter,
  pruneFiltersToTable,
  remapEnumTokens,
  tableHasField,
  type AnalyticsPack,
} from "./semantic-layer.js";
import { answerableTableNamedInNl } from "./catalog.js";
import { extractAppVersionFromNl } from "./verified-query.js";
import type { ResultLayout } from "./types.js";

export type OutputDimId = "watch_date" | "channel" | string;

export type CompileMetricKind =
  | "avg_of_max"
  | "uniq"
  | "sum"
  | "avg"
  | "avg_per_user"
  | "count"
  | "ratio"
  | "retention_dn";

const GENERIC_METRIC_RE = /^(uniq|sum|avg|count):([A-Za-z_][A-Za-z0-9_]*|\*)$/;

/**
 * `uniq:field|*` / `sum:field` / `avg:field` / `count:field|*`.
 * `*` resolves to the pack's first declared entity key — never a hard-coded column.
 */
export function parseGenericMetricId(
  metricId: string,
  defaultEntityKey?: string,
): AnalyticsIntent["metric"] | null {
  const m = String(metricId || "").trim().match(GENERIC_METRIC_RE);
  if (!m) return null;
  const op = m[1] as "uniq" | "sum" | "avg" | "count";
  const field = m[2]!;
  if (op === "uniq") {
    const key = field === "*" ? String(defaultEntityKey || "").trim() : field;
    if (!key) return null;
    return { id: metricId, kind: "uniq", distinctField: key };
  }
  if (op === "sum") return { id: metricId, kind: "sum", valueField: field };
  if (op === "avg") return { id: metricId, kind: "avg", valueField: field };
  return { id: metricId, kind: "count", valueField: field === "*" ? undefined : field };
}

export type AnalyticsIntent = {
  table: string;
  time: { start: string; end: string };
  /** 字段 → 取值列表 */
  filters: Record<string, string[]>;
  outputDims: OutputDimId[];
  layout?: ResultLayout;
  pivotDim?: string;
  metric: {
    id: string;
    kind: CompileMetricKind;
    valueField?: string;
    entityKeys?: string[];
    distinctField?: string;
  };
};

/** Analytic/SQL tokens that look CamelCase but are not channel codes. */
const CHANNEL_SHAPE_STOP = new Set([
  "yoy",
  "mom",
  "sql",
  "topn",
  "avg",
  "sum",
  "uniq",
  "and",
  "the",
  "for",
  "from",
  "where",
  "group",
]);

function looksLikeChannelCode(t: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9]{1,31}$/.test(t)) return false;
  if (CHANNEL_SHAPE_STOP.has(t.toLowerCase())) return false;
  return (/[a-z][A-Z]/.test(t) && t.length >= 4) || /\d/.test(t);
}

/**
 * Lower-camelCase identifiers owned by the pack schema (fields / compile params like
 * "watchSecond"/"appVersion") — these are parameter names, never channel codes.
 * Collected from the pack object itself (zero hardcoded business words).
 */
function packLowerCamelTokens(pack?: AnalyticsPack): Set<string> {
  const out = new Set<string>();
  if (!pack) return out;
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (/^[a-z][a-zA-Z0-9]*$/.test(v) && /[A-Z]/.test(v)) out.add(v.toLowerCase());
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v as Record<string, unknown>).forEach(walk);
    }
  };
  walk(pack);
  return out;
}

/** 从 NL 抽渠道码：pack.valueAliases + CamelCase/含数字实体（无产品白名单）。 */
export function extractChannelsFromNl(nl: string, pack?: AnalyticsPack): string[] {
  const found = new Set<string>(extractAliasedEnumValues(nl, pack, "channel"));
  const schemaTokens = packLowerCamelTokens(pack);
  for (const ent of extractNamedEntities(nl)) {
    if (schemaTokens.has(ent.toLowerCase())) continue;
    if (looksLikeChannelCode(ent)) found.add(ent);
  }
  for (const m of nl.matchAll(/\b([A-Za-z][A-Za-z0-9]{1,31})\b/g)) {
    const t = m[1]!;
    if (schemaTokens.has(t.toLowerCase())) continue;
    if (looksLikeChannelCode(t)) found.add(t);
  }
  return remapEnumTokens([...found], pack, "channel");
}

/**
 * `metricDefs[].options[].compile` is the only source of a metric's SQL recipe.
 * No metric id / field name fallbacks in code — adding a pack needs zero code change.
 */
function resolveMetricCompile(
  metricId: string,
  pack: AnalyticsPack,
): AnalyticsIntent["metric"] | null {
  for (const def of pack.metricDefs || []) {
    for (const opt of def.options || []) {
      if (opt.id !== metricId) continue;
      const c = opt.compile;
      if (!c?.kind) return null;
      return {
        id: metricId,
        kind: c.kind as AnalyticsIntent["metric"]["kind"],
        valueField: c.valueField,
        entityKeys: c.entityKeys,
        distinctField: c.distinctField,
      };
    }
  }
  return parseGenericMetricId(metricId, packDefaultEntityKey(pack));
}

/** 由对话结构化结果组装 Intent。 */
export function buildAnalyticsIntentFromStructure(input: {
  structure: {
    time: { start: string; end: string };
    filters: Record<string, string[]>;
    outputDims: string[];
    layout?: ResultLayout;
    pivotDim?: string;
    metricId: string;
    table?: string;
  };
  pack: AnalyticsPack;
  fallbackNl?: string;
}): { ok: true; intent: AnalyticsIntent } | { ok: false; reason: string } {
  const { structure, pack, fallbackNl = "" } = input;
  const named = answerableTableNamedInNl(fallbackNl, pack);
  const table = String(structure.table || named || pack.tables[0]?.name || "").trim();
  if (!table) return { ok: false, reason: "pack has no table" };
  const knownFields = new Set(packFieldsForTable(pack, table));
  const metric = resolveMetricCompile(structure.metricId, pack);
  if (!metric) return { ok: false, reason: `metric ${structure.metricId} not compilable` };
  const joinKind = metric.kind === "ratio" || metric.kind === "retention_dn";
  if (!joinKind && metric.distinctField && knownFields.size && !knownFields.has(metric.distinctField)) {
    return { ok: false, reason: `metric_field_not_in_catalog:${metric.distinctField}` };
  }
  if (!joinKind && metric.valueField && knownFields.size && !knownFields.has(metric.valueField)) {
    return { ok: false, reason: `metric_field_not_in_catalog:${metric.valueField}` };
  }

  const filters: Record<string, string[]> = joinKind
    ? { ...structure.filters }
    : pruneFiltersToTable(pack, table, structure.filters);
  if (canApplyTextChannelFilter(pack, table)) {
    if (filters.channel?.length) {
      filters.channel = remapEnumTokens(filters.channel, pack, "channel");
    }
    if (!filters.channel?.length) {
      const channels = extractChannelsFromNl(fallbackNl, pack);
      if (channels.length) filters.channel = channels;
    }
  } else if (!joinKind) {
    delete filters.channel;
  }
  if (joinKind && !filters.appVersion?.length) {
    const ver = extractAppVersionFromNl(fallbackNl);
    if (ver) filters.appVersion = [ver];
  }
  const overlayFields = pack.tables[0]?.fields || [];
  // 默认类型过滤的落槽字段来自 pack 声明（guards.defaultMovieTypesField），不写死维字段名。
  const defaultTypesField = String(pack.guards.defaultMovieTypesField || "").trim();
  if (
    defaultTypesField &&
    isOverlayTable(pack, table) &&
    !filters[defaultTypesField]?.length &&
    pack.guards.defaultMovieTypes?.length &&
    (!overlayFields.length || overlayFields.includes(defaultTypesField))
  ) {
    filters[defaultTypesField] = pack.guards.defaultMovieTypes.map(String);
  }

  let outputDims = [...structure.outputDims];
  // 用户点名了分组维就必须出现在结果列中（2026-09-14 ground truth 对齐）。
  // 是否点名由 pack 维度/粒度同义词判定，不在代码里写死业务词。
  const grainId = packGrainId(pack);
  if (grainId && nlWantsGrain(fallbackNl, pack) && !outputDims.includes(grainId)) {
    outputDims.unshift(grainId);
  }
  // Pack-flagged output dims the NL names, limited to columns the target table really has.
  // The pivot dim is excluded on purpose: it becomes columns (layout), not a group-by key,
  // and auto-adding it would defeat the missing-layout gate below.
  for (const d of pack.enumDimensions || []) {
    if (!d.outputDim) continue;
    const col = d.field || d.id;
    if (!col || col === structure.pivotDim || outputDims.includes(col)) continue;
    if (d.field && !tableHasField(pack, table, d.field)) continue;
    if (nlWantsDim(fallbackNl, pack, d.id || col)) outputDims.push(col);
  }
  if (knownFields.size) {
    outputDims = outputDims.filter((d) => d === grainId || knownFields.has(d));
  }

  const pivotDim = structure.pivotDim;
  if (
    pivotDim &&
    (filters[pivotDim]?.length || 0) > 1 &&
    outputDims.length &&
    !outputDims.includes(pivotDim) &&
    !structure.layout
  ) {
    return { ok: false, reason: "result_layout missing" };
  }

  return {
    ok: true,
    intent: {
      table,
      time: { start: structure.time.start, end: structure.time.end },
      filters,
      outputDims,
      layout: structure.layout,
      pivotDim,
      metric,
    },
  };
}

export function intentToJson(intent: AnalyticsIntent): string {
  return JSON.stringify(intent, null, 2);
}

/** 供测试/调试：转义字面量 */
export function sqlStringLiteral(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function sqlInList(values: string[]): string {
  return values.map(sqlStringLiteral).join(", ");
}
