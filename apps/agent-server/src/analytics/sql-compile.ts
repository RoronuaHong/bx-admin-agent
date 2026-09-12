/**
 * Intent → SQL 确定性编译（语义层引擎）。
 * 仅支持已建模 metric kind；不支持则返回 ok:false，由上层 LLM 兜底或拒答。
 */

import type { AnalyticsIntent, OutputDimId } from "./intent.js";
import { sqlStringLiteral } from "./intent.js";
import type { AnalyticsPack } from "./semantic-layer.js";

export type CompileOk = { ok: true; sql: string };
export type CompileFail = { ok: false; reason: string };
export type CompileResult = CompileOk | CompileFail;

function dimSelectExpr(dim: OutputDimId): { select: string; group: string; alias: string } {
  if (dim === "watch_date") {
    return {
      select: "toDate(lastWatchTime) AS watchDate",
      group: "watchDate",
      alias: "watchDate",
    };
  }
  if (dim === "channel") {
    return { select: "channel", group: "channel", alias: "channel" };
  }
  // 物理字段名
  return { select: dim, group: dim, alias: dim };
}

/** Probe/clarify may use "(empty)" for blank dimension values → SQL empty string. */
function normalizeFilterToken(v: string): string {
  const t = String(v).trim();
  if (
    !t ||
    t === "(empty)" ||
    t === "\u7a7a" ||
    t.startsWith("\u7a7a\uff08") ||
    t === "\u82f1\u8bed" ||
    t.startsWith("\u82f1\u8bed\uff08") ||
    /^english$/i.test(t) ||
    /^en(-US)?$/i.test(t)
  ) {
    return "";
  }
  return t;
}

function assertNumericFilterValues(field: string, values: string[]): CompileFail | null {
  const bad = values.filter((v) => v !== "" && !/^-?\d+(\.\d+)?$/.test(v));
  if (!bad.length) return null;
  return {
    ok: false,
    reason: `filter_${field}_not_numeric:${bad.slice(0, 5).join(",")}`,
  };
}

function buildWhere(
  intent: AnalyticsIntent,
  forcedFilters?: Record<string, string[]>,
): { ok: true; where: string } | CompileFail {
  const parts: string[] = [
    `toDate(lastWatchTime) BETWEEN ${sqlStringLiteral(intent.time.start)} AND ${sqlStringLiteral(intent.time.end)}`,
  ];
  const merged: Record<string, string[]> = { ...intent.filters };
  if (forcedFilters) {
    for (const [field, values] of Object.entries(forcedFilters)) {
      if (!values?.length) continue;
      const prev = merged[field] || [];
      // 强制维：与用户过滤求交；用户未指定则全用强制集
      if (!prev.length) merged[field] = [...values];
      else {
        const allow = new Set(values.map(String));
        const kept = prev.filter((v) => allow.has(String(v)));
        merged[field] = kept.length ? kept : [...values];
      }
    }
  }
  for (const [field, values] of Object.entries(merged)) {
    if (!values?.length) continue;
    const normalized = values.map(normalizeFilterToken);
    const forceNumeric = field === "movieType";
    if (forceNumeric) {
      const bad = assertNumericFilterValues(field, normalized);
      if (bad) return bad;
    }
    const numeric =
      forceNumeric || normalized.every((v) => v !== "" && /^-?\d+(\.\d+)?$/.test(v));
    const lit = (v: string) => (numeric ? v : sqlStringLiteral(v));
    if (normalized.length === 1) {
      parts.push(`${field} = ${lit(normalized[0]!)}`);
    } else {
      parts.push(`${field} IN (${normalized.map(lit).join(", ")})`);
    }
  }
  return { ok: true, where: parts.join("\n  AND ") };
}

function safeAlias(code: string): string {
  return String(code).replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "v";
}

/**
 * Canonicalize output dimensions for deterministic SQL grain.
 * - Constant single-value filter fields (e.g. channel='IndiaA') are redundant in GROUP BY
 *   (already fixed by WHERE), so they are dropped from the breakout dims.
 * - No explicit breakout → default to daily grain (watch_date) so range aggregations always
 *   yield a consistent by-day series instead of a nondeterministic grand-total flip.
 */
function canonicalDims(intent: AnalyticsIntent): OutputDimId[] {
  const constantFilterFields = new Set(
    Object.entries(intent.filters || {})
      .filter(([, vs]) => Array.isArray(vs) && vs.length === 1)
      .map(([field]) => field),
  );
  const dims = (intent.outputDims || []).filter((d) => !constantFilterFields.has(d));
  if (!dims.length) return ["watch_date"];
  return dims;
}

function compileAvgOfMax(intent: AnalyticsIntent, pack?: AnalyticsPack): CompileResult {
  const valueField = intent.metric.valueField || "maxWatchProgress";
  const entityKeys = intent.metric.entityKeys?.length ? intent.metric.entityKeys : ["guid", "eid"];
  const dims = canonicalDims(intent);
  const dimMeta = dims.map(dimSelectExpr);
  const whereBuilt = buildWhere(intent, pack?.guards.forcedFilters);
  if (!whereBuilt.ok) return whereBuilt;
  const where = whereBuilt.where;

  const pivot = intent.pivotDim;
  const pivotValues = pivot ? (intent.filters[pivot] || []).map(normalizeFilterToken) : [];
  const useWide = intent.layout === "wide" && pivot && pivotValues.length > 1;

  if (useWide) {
    // Pivot dim is expanded as columns — do not also select/group it as a row dim.
    const wideDims = dims.filter((d) => d !== pivot);
    const wideMeta = (wideDims.length ? wideDims : dims.filter((d) => d !== pivot)).map(dimSelectExpr);
    // If all dims were pivot-only, keep empty outer grain (single row of pivot columns)
    const innerDimMeta = wideMeta.length ? wideMeta : [];
    const innerSelectParts = [
      ...innerDimMeta.map((d) => d.select),
      ...entityKeys,
      pivot!,
      `max(${valueField}) AS a`,
    ];
    // De-dupe identical select expressions (e.g. contentLang listed twice)
    const seenSel = new Set<string>();
    const innerSelect = innerSelectParts
      .filter((s) => {
        const key = s.replace(/\s+/g, " ").trim().toLowerCase();
        if (seenSel.has(key)) return false;
        seenSel.add(key);
        return true;
      })
      .join(",\n    ");
    const innerGroupParts = [...innerDimMeta.map((d) => d.group), ...entityKeys, pivot!];
    const seenGrp = new Set<string>();
    const innerGroup = innerGroupParts
      .filter((g) => {
        const key = g.toLowerCase();
        if (seenGrp.has(key)) return false;
        seenGrp.add(key);
        return true;
      })
      .join(", ");
    const outerMetrics = pivotValues
      .map((v) => {
        const lit = sqlStringLiteral(v);
        const alias = safeAlias(v === "" ? "en" : v);
        return `round(sumIf(a, ${pivot} = ${lit}) / nullIf(countIf(${pivot} = ${lit}), 0), 0) AS ${alias}`;
      })
      .join(",\n  ");
    const outerGroup = innerDimMeta.map((d) => d.group).join(", ");
    const outerSelect = [...innerDimMeta.map((d) => d.group), outerMetrics].filter(Boolean).join(",\n  ");
    const order = outerGroup || outerMetrics.split(" AS ").pop()?.trim() || "1";
    const sql = [
      `SELECT`,
      `  ${outerSelect}`,
      `FROM (`,
      `  SELECT`,
      `    ${innerSelect}`,
      `  FROM ${intent.table}`,
      `  WHERE ${where}`,
      `  GROUP BY ${innerGroup}`,
      `)`,
      ...(outerGroup ? [`GROUP BY ${outerGroup}`, `ORDER BY ${outerGroup}`] : []),
    ].join("\n");
    return { ok: true, sql };
  }

  // LONG / 单值：输出维（+ 可选 pivot）上对 max 再 avg
  const longDims = [...dims];
  if (intent.layout === "long" && pivot && !longDims.includes(pivot)) longDims.push(pivot);
  const longMeta = longDims.map(dimSelectExpr);
  const innerSelect = [
    ...longMeta.map((d) => d.select),
    ...entityKeys,
    `max(${valueField}) AS a`,
  ].join(",\n    ");
  const innerGroup = [...longMeta.map((d) => d.group), ...entityKeys].join(", ");
  const outerGroup = longMeta.map((d) => d.group).join(", ");
  const sql = [
    `SELECT`,
    `  ${longMeta.map((d) => d.group).join(",\n  ")},`,
    `  round(avg(a), 0) AS avg_max_progress`,
    `FROM (`,
    `  SELECT`,
    `    ${innerSelect}`,
    `  FROM ${intent.table}`,
    `  WHERE ${where}`,
    `  GROUP BY ${innerGroup}`,
    `)`,
    `GROUP BY ${outerGroup}`,
    `ORDER BY ${outerGroup}`,
  ].join("\n");
  return { ok: true, sql };
}

function compileUniqOrSum(intent: AnalyticsIntent, pack?: AnalyticsPack): CompileResult {
  const dims = canonicalDims(intent);
  const dimMeta = dims.map(dimSelectExpr);
  const whereBuilt = buildWhere(intent, pack?.guards.forcedFilters);
  if (!whereBuilt.ok) return whereBuilt;
  const where = whereBuilt.where;
  let metricExpr: string;
  if (intent.metric.kind === "uniq") {
    const f = intent.metric.distinctField || "guid";
    metricExpr = `uniq(${f}) AS users`;
  } else if (intent.metric.kind === "sum") {
    const f = intent.metric.valueField || "watchSecond";
    metricExpr = `sum(${f}) AS ${f}`;
  } else if (intent.metric.kind === "avg_per_user") {
    const valueField = intent.metric.valueField || "watchSecond";
    const distinctField = intent.metric.distinctField || "guid";
    metricExpr = `round(sum(${valueField}) / nullIf(uniq(${distinctField}), 0), 2) AS avg_watch_second`;
  } else {
    return { ok: false, reason: `unsupported kind ${intent.metric.kind}` };
  }

  if (!dimMeta.length) {
    const sql = [`SELECT ${metricExpr}`, `FROM ${intent.table}`, `WHERE ${where}`].join("\n");
    return { ok: true, sql };
  }

  const sql = [
    `SELECT`,
    `  ${dimMeta.map((d) => d.select).join(",\n  ")},`,
    `  ${metricExpr}`,
    `FROM ${intent.table}`,
    `WHERE ${where}`,
    `GROUP BY ${dimMeta.map((d) => d.group).join(", ")}`,
    `ORDER BY ${dimMeta.map((d) => d.group).join(", ")}`,
  ].join("\n");
  return { ok: true, sql };
}

export function compileAnalyticsIntent(
  intent: AnalyticsIntent,
  pack?: AnalyticsPack,
): CompileResult {
  switch (intent.metric.kind) {
    case "avg_of_max":
      return compileAvgOfMax(intent, pack);
    case "uniq":
    case "sum":
    case "avg_per_user":
      return compileUniqOrSum(intent, pack);
    default:
      return { ok: false, reason: `unsupported_metric_kind:${String((intent.metric as { kind?: string }).kind || "")}` };
  }
}
