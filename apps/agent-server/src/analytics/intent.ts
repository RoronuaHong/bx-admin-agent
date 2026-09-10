/**
 * Analytics Intent — Gate/NL 接地后的结构化查询计划（语义层中间态）。
 * SQL 由 sql-compile 确定性编译，禁止把金句塞进 LLM。
 */

import { extractNamedEntities } from "./named-entities.js";
import type { AmbiguityGateOk, ResultLayout } from "./ambiguity-gate.js";
import type { AnalyticsPack } from "./semantic-layer.js";

export type OutputDimId = "watch_date" | "channel" | string;

export type CompileMetricKind = "avg_of_max" | "uniq" | "sum";

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

const CHANNEL_ALIASES: Record<string, string> = {
  印度A: "IndiaA",
  印度B: "IndiaB",
  印度a: "IndiaA",
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 从 NL 抽渠道名（实体 + 中文别名）。 */
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
        // 语义层未声明 compile 时，avg_max_progress 用默认配方（语义定义，非 LLM 金句）
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
  return null;
}

function inferMetricId(nl: string, gate: AmbiguityGateOk): string | null {
  if (gate.groundedMetrics.length) return gate.groundedMetrics[0]!;
  if (/完播|最大进度/.test(nl)) return null;
  if (/人数|UV|用户数|观看人数/.test(nl)) return "uniq_users";
  if (/时长|观看秒|watchSecond|watch_second/.test(nl)) return "sum_watch_second";
  return null;
}

/**
 * Gate 通过后组装 Intent；缺渠道等关键过滤时返回 null（交 LLM 或上层 clarify）。
 */
export function buildAnalyticsIntent(input: {
  nl: string;
  range: { start: string; end: string };
  gate: AmbiguityGateOk;
  pack: AnalyticsPack;
}): { ok: true; intent: AnalyticsIntent } | { ok: false; reason: string } {
  const { nl, range, gate, pack } = input;
  const table = pack.tables[0]?.name;
  if (!table) return { ok: false, reason: "pack has no table" };

  const metricId = inferMetricId(nl, gate);
  if (!metricId) return { ok: false, reason: "metric not inferred" };
  const metric = resolveMetricCompile(metricId, pack);
  if (!metric) return { ok: false, reason: `metric ${metricId} not compilable` };

  const filters: Record<string, string[]> = { ...gate.groundedFilters };
  const channels = extractChannelsFromNl(nl);
  if (channels.length && !filters.channel?.length) {
    filters.channel = channels;
  }
  // 语义层默认 movieType（用户未显式覆盖时）
  if (!filters.movieType?.length && pack.guards.defaultMovieTypes?.length) {
    filters.movieType = pack.guards.defaultMovieTypes.map(String);
  }

  // 单渠道题未抽出渠道 → 无法安全编译（避免全渠道扫）
  const needsChannel =
    /渠道|India|Fox|GoGo|Tiger|Pak|Peacock|印度/.test(nl) || Boolean(filters.channel?.length);
  if (needsChannel && !filters.channel?.length) {
    return { ok: false, reason: "channel filter missing" };
  }

  let outputDims = [...gate.outputDims];
  if (!outputDims.length) {
    // 默认：有「按天/日期」用 watch_date；否则仅聚合
    if (/按天|按日|按.*日期|每天/.test(nl)) outputDims.push("watch_date");
    if (/按.*渠道|各渠道/.test(nl)) outputDims.push("channel");
  }

  // 宽表需要 pivot + layout
  if (
    gate.pivotDim &&
    (filters[gate.pivotDim]?.length || 0) > 1 &&
    outputDims.length &&
    !outputDims.includes(gate.pivotDim)
  ) {
    if (!gate.layout) return { ok: false, reason: "result_layout missing" };
  }

  return {
    ok: true,
    intent: {
      table,
      time: { start: range.start, end: range.end },
      filters,
      outputDims,
      layout: gate.layout,
      pivotDim: gate.pivotDim,
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
