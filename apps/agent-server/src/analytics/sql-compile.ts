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

function buildWhere(intent: AnalyticsIntent): string {
  const parts: string[] = [
    `toDate(lastWatchTime) BETWEEN ${sqlStringLiteral(intent.time.start)} AND ${sqlStringLiteral(intent.time.end)}`,
  ];
  for (const [field, values] of Object.entries(intent.filters)) {
    if (!values?.length) continue;
    const numeric = field === "movieType" || values.every((v) => /^-?\d+(\.\d+)?$/.test(v));
    const lit = (v: string) => (numeric ? v : sqlStringLiteral(v));
    if (values.length === 1) {
      parts.push(`${field} = ${lit(values[0]!)}`);
    } else {
      parts.push(`${field} IN (${values.map(lit).join(", ")})`);
    }
  }
  return parts.join("\n  AND ");
}

function safeAlias(code: string): string {
  return String(code).replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "v";
}

function compileAvgOfMax(intent: AnalyticsIntent): CompileResult {
  const valueField = intent.metric.valueField || "maxWatchProgress";
  const entityKeys = intent.metric.entityKeys?.length ? intent.metric.entityKeys : ["guid", "eid"];
  const dims = intent.outputDims.length ? intent.outputDims : ["watch_date"];
  const dimMeta = dims.map(dimSelectExpr);
  const where = buildWhere(intent);

  const pivot = intent.pivotDim;
  const pivotValues = pivot ? intent.filters[pivot] || [] : [];
  const useWide = intent.layout === "wide" && pivot && pivotValues.length > 1;

  if (useWide) {
    const innerSelect = [
      ...dimMeta.map((d) => d.select),
      ...entityKeys,
      pivot,
      `max(${valueField}) AS a`,
    ].join(",\n    ");
    const innerGroup = [...dimMeta.map((d) => d.group), ...entityKeys, pivot!].join(", ");
    const outerMetrics = pivotValues
      .map((v) => {
        const lit = sqlStringLiteral(v);
        const alias = safeAlias(v);
        return `round(sumIf(a, ${pivot} = ${lit}) / nullIf(countIf(${pivot} = ${lit}), 0), 0) AS ${alias}`;
      })
      .join(",\n  ");
    const outerGroup = dimMeta.map((d) => d.group).join(", ");
    const outerSelect = [...dimMeta.map((d) => d.group), outerMetrics].join(",\n  ");
    const order = dimMeta.map((d) => d.group).join(", ");
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
      `GROUP BY ${outerGroup}`,
      `ORDER BY ${order}`,
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

function compileUniqOrSum(intent: AnalyticsIntent): CompileResult {
  const dims = intent.outputDims.length ? intent.outputDims : [];
  const dimMeta = dims.map(dimSelectExpr);
  const where = buildWhere(intent);
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
  _pack?: AnalyticsPack,
): CompileResult {
  switch (intent.metric.kind) {
    case "avg_of_max":
      return compileAvgOfMax(intent);
    case "uniq":
    case "sum":
    case "avg_per_user":
      return compileUniqOrSum(intent);
    default:
      return { ok: false, reason: `unknown metric kind` };
  }
}
