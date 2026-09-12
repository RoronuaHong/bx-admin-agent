/**
 * Analytics Intent — schema-agent 结构化后的查询计划（语义层中间态）。
 * SQL 由 sql-compile 确定性编译；失败时由 pipeline 用 LLM 诊断原因，不写 SQL。
 */

import { extractNamedEntities } from "./named-entities.js";
import {
  extractAliasedEnumValues,
  isOverlayTable,
  packFieldsForTable,
  canApplyTextChannelFilter,
  pruneFiltersToTable,
  remapEnumTokens,
  tableHasField,
  type AnalyticsPack,
} from "./semantic-layer.js";
import { answerableTableNamedInNl } from "./catalog.js";
import type { ResultLayout } from "./types.js";

export type OutputDimId = "watch_date" | "channel" | string;

export type CompileMetricKind = "avg_of_max" | "uniq" | "sum" | "avg" | "avg_per_user" | "count";

const GENERIC_METRIC_RE = /^(uniq|sum|avg|count):([A-Za-z_][A-Za-z0-9_]*|\*)$/;

export function parseGenericMetricId(metricId: string): AnalyticsIntent["metric"] | null {
  const m = String(metricId || "").trim().match(GENERIC_METRIC_RE);
  if (!m) return null;
  const op = m[1] as "uniq" | "sum" | "avg" | "count";
  const field = m[2]!;
  if (op === "uniq") return { id: metricId, kind: "uniq", distinctField: field === "*" ? "guid" : field };
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

/** 从 NL 抽渠道码：pack.valueAliases + CamelCase/含数字实体（无产品白名单）。 */
export function extractChannelsFromNl(nl: string, pack?: AnalyticsPack): string[] {
  const found = new Set<string>(extractAliasedEnumValues(nl, pack, "channel"));
  for (const ent of extractNamedEntities(nl)) {
    if (looksLikeChannelCode(ent)) found.add(ent);
  }
  for (const m of nl.matchAll(/\b([A-Za-z][A-Za-z0-9]{1,31})\b/g)) {
    const t = m[1]!;
    if (looksLikeChannelCode(t)) found.add(t);
  }
  return remapEnumTokens([...found], pack, "channel");
}

function resolveMetricCompile(
  metricId: string,
  pack: AnalyticsPack,
): AnalyticsIntent["metric"] | null {
  for (const def of pack.metricDefs || []) {
    for (const opt of def.options || []) {
      if (opt.id !== metricId) continue;
      const c = opt.compile;
      if (!c?.kind) {
        if (metricId === "avg_max_progress") {
          return {
            id: metricId,
            kind: "avg_of_max",
            valueField: "maxWatchProgress",
            entityKeys: ["guid", "eid"],
          };
        }
        return null;
      }
      return {
        id: metricId,
        kind: c.kind,
        valueField: c.valueField,
        entityKeys: c.entityKeys,
        distinctField: c.distinctField,
      };
    }
  }
  if (metricId === "avg_max_progress") {
    return {
      id: metricId,
      kind: "avg_of_max",
      valueField: "maxWatchProgress",
      entityKeys: ["guid", "eid"],
    };
  }
  if (metricId === "uniq_users") {
    return { id: metricId, kind: "uniq", distinctField: "guid" };
  }
  if (metricId === "sum_watch_second") {
    return { id: metricId, kind: "sum", valueField: "watchSecond" };
  }
  if (metricId === "avg_watch_second_per_user") {
    return {
      id: metricId,
      kind: "avg_per_user",
      valueField: "watchSecond",
      distinctField: "guid",
    };
  }
  return parseGenericMetricId(metricId);
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
  if (metric.distinctField && knownFields.size && !knownFields.has(metric.distinctField)) {
    return { ok: false, reason: `metric_field_not_in_catalog:${metric.distinctField}` };
  }
  if (metric.valueField && knownFields.size && !knownFields.has(metric.valueField)) {
    return { ok: false, reason: `metric_field_not_in_catalog:${metric.valueField}` };
  }

  const filters: Record<string, string[]> = pruneFiltersToTable(pack, table, structure.filters);
  if (canApplyTextChannelFilter(pack, table)) {
    if (filters.channel?.length) {
      filters.channel = remapEnumTokens(filters.channel, pack, "channel");
    }
    if (!filters.channel?.length) {
      const channels = extractChannelsFromNl(fallbackNl, pack);
      if (channels.length) filters.channel = channels;
    }
  } else {
    delete filters.channel;
  }
  const overlayFields = pack.tables[0]?.fields || [];
  if (
    isOverlayTable(pack, table) &&
    !filters.movieType?.length &&
    pack.guards.defaultMovieTypes?.length &&
    (!overlayFields.length || overlayFields.includes("movieType"))
  ) {
    filters.movieType = pack.guards.defaultMovieTypes.map(String);
  }

  let outputDims = [...structure.outputDims];
  if (!outputDims.length) {
    if (/按天|按日|按.*日期|每天|观看日期/.test(fallbackNl)) outputDims.push("watch_date");
    if (
      tableHasField(pack, table, "channel") &&
      /按.*渠道|各渠道|观看日期.*渠道|渠道.*维度/.test(fallbackNl)
    ) {
      outputDims.push("channel");
    }
  }
  if (knownFields.size) {
    outputDims = outputDims.filter((d) => d === "watch_date" || knownFields.has(d));
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
