/**
 * Analytics Intent — schema-agent 结构化后的查询计划（语义层中间态）。
 * SQL 由 sql-compile 确定性编译；失败时由 pipeline 用 LLM 诊断原因，不写 SQL。
 */

import { extractNamedEntities } from "./named-entities.js";
import type { AnalyticsPack } from "./semantic-layer.js";
import type { ResultLayout } from "./types.js";

export type OutputDimId = "watch_date" | "channel" | string;

export type CompileMetricKind = "avg_of_max" | "uniq" | "sum" | "avg_per_user";

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

/**
 * 渠道中文别名 → 库内码。
 * 暂时保留：schema-agent / Metabase probe 若未能稳定映射中文渠道名时作兜底。
 * 优先仍应靠对话原文里的拉丁渠道码，或 probe `channel` 维。
 */
const CHANNEL_ALIASES: Record<string, string> = {
  印度A: "IndiaA",
  印度B: "IndiaB",
  印度a: "IndiaA",
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 从 NL 抽渠道名（实体 + 中文别名兜底）。 */
export function extractChannelsFromNl(nl: string): string[] {
  const found = new Set<string>();
  for (const [alias, code] of Object.entries(CHANNEL_ALIASES)) {
    if (nl.includes(alias)) found.add(code);
  }
  for (const ent of extractNamedEntities(nl)) {
    const mapped = CHANNEL_ALIASES[ent];
    if (mapped) {
      found.add(mapped);
      continue;
    }
    // 仅接受拉丁渠道码（中文别名已在上表映射）
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(ent)) continue;
    if (
      /^(India|Fox|GoGo|Tiger|Pak|Peacock|MOBMAX|INGoogle)/i.test(ent) ||
      /^(IndiaA|IndiaB|FoxA|GoGo|Tiger2|PakA|Peacock|IndiaTV|India2)$/i.test(ent)
    ) {
      found.add(ent);
    }
  }
  for (const m of nl.matchAll(/\b([A-Za-z][A-Za-z0-9]{1,31})\b/g)) {
    const t = m[1]!;
    if (/^(IndiaA|IndiaB|FoxA|GoGo|Tiger2|PakA|Peacock|IndiaTV|India2)$/i.test(t)) {
      found.add(t);
    }
  }
  return [...found];
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
  return null;
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
  };
  pack: AnalyticsPack;
  fallbackNl?: string;
}): { ok: true; intent: AnalyticsIntent } | { ok: false; reason: string } {
  const { structure, pack, fallbackNl = "" } = input;
  const table = pack.tables[0]?.name;
  if (!table) return { ok: false, reason: "pack has no table" };
  const metric = resolveMetricCompile(structure.metricId, pack);
  if (!metric) return { ok: false, reason: `metric ${structure.metricId} not compilable` };

  const filters: Record<string, string[]> = { ...structure.filters };
  if (!filters.channel?.length) {
    const channels = extractChannelsFromNl(fallbackNl);
    if (channels.length) filters.channel = channels;
  }
  if (!filters.movieType?.length && pack.guards.defaultMovieTypes?.length) {
    filters.movieType = pack.guards.defaultMovieTypes.map(String);
  }

  let outputDims = [...structure.outputDims];
  if (!outputDims.length) {
    if (/按天|按日|按.*日期|每天|观看日期/.test(fallbackNl)) outputDims.push("watch_date");
    if (/按.*渠道|各渠道|观看日期.*渠道|渠道.*维度/.test(fallbackNl)) outputDims.push("channel");
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

export { escapeRegExp };
