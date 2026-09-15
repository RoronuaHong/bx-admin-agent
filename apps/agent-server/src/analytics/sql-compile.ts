/**
 * Intent → SQL 确定性编译（语义层引擎）。
 * 仅支持已建模 metric kind；不支持则返回 ok:false，由上层拒答/反问，不写 SQL。
 */

import type { AnalyticsIntent, OutputDimId } from "./intent.js";
import { sqlStringLiteral } from "./intent.js";
import { EMPTY_PROBE_TOKEN } from "./clarify-options.js";
import {
  compileTableRef,
  findMetricOption,
  isNumericWarehouseType,
  isOverlayTable,
  packDefaultEntityKey,
  packDefaultWideLangs,
  packFieldType,
  packFieldsForTable,
  packGrainAlias,
  packGrainId,
  packRelationships,
  packTimeField,
  type AnalyticsPack,
  type RatioCompileSpec,
  type RetentionCompileSpec,
} from "./semantic-layer.js";

/** Grain column alias comes from pack.time.grainColumnAlias — not from code. */
export function dayGrainSelect(
  pack: AnalyticsPack,
  timeField: string,
): { select: string; group: string; alias: string } {
  const alias = packGrainAlias(pack) || timeField;
  return {
    select: `toDate(${timeField}) AS ${alias}`,
    group: alias,
    alias,
  };
}

export type CompileOk = { ok: true; sql: string };
export type CompileFail = { ok: false; reason: string };
export type CompileResult = CompileOk | CompileFail;

function dimSelectExpr(
  dim: OutputDimId,
  timeField: string,
  pack: AnalyticsPack,
): { select: string; group: string; alias: string } {
  if (packGrainId(pack) && dim === packGrainId(pack)) {
    return dayGrainSelect(pack, timeField);
  }
  // 物理字段名（含已建模维）
  return { select: dim, group: dim, alias: dim };
}

/**
 * Empty-member surface forms come from the pack (emptyLabel prefix + emptyAliases).
 * "(empty)" / 空 are generic blank tokens; no dim-specific word lives in code.
 */
function packEmptyTokenMatcher(pack?: AnalyticsPack): (t: string) => boolean {
  const forms: Array<{ raw: string; lower: string }> = [];
  for (const d of pack?.enumDimensions || []) {
    const label = String(d.emptyLabel || "").trim();
    if (label) {
      const prefix = label.split(/（|\(/)[0]!.trim();
      if (prefix) forms.push({ raw: prefix, lower: prefix.toLowerCase() });
    }
    for (const a of d.emptyAliases || []) {
      const s = String(a || "").trim();
      if (s) forms.push({ raw: s, lower: s.toLowerCase() });
    }
  }
  return (t: string) => {
    const lower = t.toLowerCase();
    return forms.some(
      (f) => lower === f.lower || t.startsWith(`${f.raw}（`) || t.startsWith(`${f.raw}(`),
    );
  };
}

/** Probe/clarify may use the empty probe token for blank dimension values → SQL empty string. */
function normalizeFilterToken(v: string, pack?: AnalyticsPack): string {
  const t = String(v).trim();
  if (!t || t === EMPTY_PROBE_TOKEN || t === "\u7a7a" || t.startsWith("\u7a7a\uff08") || t.startsWith("\u7a7a(")) {
    return "";
  }
  if (packEmptyTokenMatcher(pack)(t)) return "";
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
  pack?: AnalyticsPack,
): { ok: true; where: string } | CompileFail {
  const timeField = packTimeField(pack, intent.table);
  const knownFields = new Set(packFieldsForTable(pack, intent.table));
  const parts: string[] = [];
  if (timeField) {
    parts.push(
      `toDate(${timeField}) BETWEEN ${sqlStringLiteral(intent.time.start)} AND ${sqlStringLiteral(intent.time.end)}`,
    );
  }
  const merged: Record<string, string[]> = { ...intent.filters };
  const forcedFilters = pack?.guards.forcedFilters;
  if (forcedFilters) {
    for (const [field, values] of Object.entries(forcedFilters)) {
      if (!values?.length) continue;
      const prev = merged[field] || [];
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
    if (knownFields.size && !knownFields.has(field)) {
      return { ok: false, reason: `filter_field_not_in_catalog:${field}` };
    }
    const normalized = values.map((v) => normalizeFilterToken(v, pack));
    const typedNumeric = isNumericWarehouseType(packFieldType(pack, field, intent.table));
    const dimDef = pack?.enumDimensions?.find((d) => d.field === field);
    const forceNumeric = typedNumeric || dimDef?.numericValues === true;
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
  return { ok: true, where: parts.join("\n  AND ") || "1" };
}

function safeAlias(code: string): string {
  return String(code).replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "v";
}

/** SQL alias for the pivot dim's empty member — pack-declared (emptyAlias), generic fallback. */
function emptyValueAlias(pack: AnalyticsPack | undefined, dimField: string | undefined): string {
  const d = pack?.enumDimensions?.find((x) => x.field && x.field === dimField);
  return String(d?.emptyAlias || "").trim() || "v";
}

/**
 * Canonicalize output dimensions for deterministic SQL grain.
 * - 用户/模型显式声明的 outputDims 全部保留（即使某维被单值 filter 固定，如 channel='X'）：
 *   用户点名「按 X 分组」即要求 X 出现在结果列中，服务端不得静默剔除（2026-09-14 修正）。
 * - Overlay table with no explicit breakout → daily grain (watch_date).
 * - Other warehouse tables with no breakout → grand total (no invented day grain).
 */
function canonicalDims(intent: AnalyticsIntent, pack?: AnalyticsPack): OutputDimId[] {
  const dims = [...(intent.outputDims || [])];
  if (dims.length) return dims;
  // Overlay with no explicit breakout → the pack's declared grain dim; degrade when undeclared.
  const grain = packGrainId(pack);
  return isOverlayTable(pack, intent.table) && grain ? [grain] : [];
}

function resolveWidePivotValues(intent: AnalyticsIntent, pack?: AnalyticsPack): string[] {
  const pivot = intent.pivotDim;
  if (intent.layout !== "wide" || !pivot) return [];
  const fromFilters = (intent.filters[pivot] || []).map((v) => normalizeFilterToken(v, pack));
  if (fromFilters.length >= 2) return fromFilters;
  return packDefaultWideLangs(pack);
}

function compileAvgOfMax(intent: AnalyticsIntent, pack?: AnalyticsPack): CompileResult {
  const valueField = intent.metric.valueField;
  if (!valueField) return { ok: false, reason: "metric_field_missing:valueField" };
  const entityKeys = intent.metric.entityKeys?.length
    ? intent.metric.entityKeys
    : [packDefaultEntityKey(pack)].filter(Boolean);
  const timeField = packTimeField(pack, intent.table);
  const dims = canonicalDims(intent, pack);
  const dimMeta = dims.map((d) => dimSelectExpr(d, timeField, pack));
  const whereBuilt = buildWhere(intent, pack);
  if (!whereBuilt.ok) return whereBuilt;
  const where = whereBuilt.where;

  const pivot = intent.pivotDim;
  const pivotValues = resolveWidePivotValues(intent, pack);
  const useWide = intent.layout === "wide" && pivot && pivotValues.length > 1;
  const emptyAlias = emptyValueAlias(pack, pivot);

  if (useWide) {
    // Pivot dim is expanded as columns — do not also select/group it as a row dim.
    // If all dims were pivot-only, keep empty outer grain (single row of pivot columns)
    const innerDimMeta = dims.filter((d) => d !== pivot).map((d) => dimSelectExpr(d, timeField, pack));
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
        const alias = safeAlias(v === "" ? emptyAlias : v);
        return `round(sumIf(a, ${pivot} = ${lit}) / nullIf(countIf(${pivot} = ${lit}), 0), 0) AS ${alias}`;
      })
      .join(",\n  ");
    const outerGroup = innerDimMeta.map((d) => d.group).join(", ");
    const outerSelect = [...innerDimMeta.map((d) => d.group), outerMetrics].filter(Boolean).join(",\n  ");
    const sql = [
      `SELECT`,
      `  ${outerSelect}`,
      `FROM (`,
      `  SELECT`,
      `    ${innerSelect}`,
      `  FROM ${compileTableRef(pack, intent.table)}`,
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
  const longMeta = longDims.map((d) => dimSelectExpr(d, timeField, pack));
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
    `  round(avg(a), 0) AS ${intent.metric.id}`,
    `FROM (`,
    `  SELECT`,
    `    ${innerSelect}`,
    `  FROM ${compileTableRef(pack, intent.table)}`,
    `  WHERE ${where}`,
    `  GROUP BY ${innerGroup}`,
    `)`,
    `GROUP BY ${outerGroup}`,
    `ORDER BY ${outerGroup}`,
  ].join("\n");
  return { ok: true, sql };
}

function compileWideAggregates(intent: AnalyticsIntent, pack?: AnalyticsPack): CompileResult | null {
  const pivot = intent.pivotDim;
  const pivotValues = resolveWidePivotValues(intent, pack);
  if (intent.layout !== "wide" || !pivot || pivotValues.length < 2) return null;
  if (intent.metric.kind === "avg_of_max") return null;

  const timeField = packTimeField(pack, intent.table);
  const dims = canonicalDims(intent, pack).filter((d) => d !== pivot);
  const dimMeta = dims.map((d) => dimSelectExpr(d, timeField, pack));
  const whereBuilt = buildWhere(intent, pack);
  if (!whereBuilt.ok) return whereBuilt;
  const where = whereBuilt.where;

  // Metric fields must be declared by the pack/intent — no schema defaults in code.
  const needsValue = intent.metric.kind === "avg_per_user" || intent.metric.kind === "sum" || intent.metric.kind === "avg";
  const needsDistinct = intent.metric.kind === "uniq" || intent.metric.kind === "avg_per_user";
  if (needsValue && !intent.metric.valueField) return { ok: false, reason: "metric_field_missing:valueField" };
  if (needsDistinct && !intent.metric.distinctField) return { ok: false, reason: "metric_field_missing:distinctField" };
  const valueField = intent.metric.valueField!;
  const distinctField = intent.metric.distinctField!;
  const emptyAlias = emptyValueAlias(pack, pivot);

  const cols = pivotValues.map((v) => {
    const lit = sqlStringLiteral(v);
    const alias = safeAlias(v === "" ? emptyAlias : v);
    const pred = `${pivot} = ${lit}`;
    if (intent.metric.kind === "uniq") {
      return `uniqIf(${distinctField}, ${pred}) AS ${alias}`;
    }
    if (intent.metric.kind === "avg_per_user") {
      return `round(sumIf(${valueField}, ${pred}) / nullIf(uniqIf(${distinctField}, ${pred}), 0), 0) AS ${alias}`;
    }
    if (intent.metric.kind === "sum") {
      return `sumIf(${valueField}, ${pred}) AS ${alias}`;
    }
    if (intent.metric.kind === "avg") {
      return `round(avgIf(${valueField}, ${pred}), 2) AS ${alias}`;
    }
    if (intent.metric.kind === "count") {
      return `countIf(${pred}) AS ${alias}`;
    }
    return "";
  });
  if (cols.some((c) => !c)) return null;

  const selectHead = dimMeta.map((d) => d.select);
  const group = dimMeta.map((d) => d.group).join(", ");
  const sql = [
    `SELECT`,
    `  ${[...selectHead, ...cols].filter(Boolean).join(",\n  ")}`,
    `FROM ${compileTableRef(pack, intent.table)}`,
    `WHERE ${where}`,
    ...(group ? [`GROUP BY ${group}`, `ORDER BY ${group}`] : []),
  ].join("\n");
  return { ok: true, sql };
}

function compileUniqOrSum(intent: AnalyticsIntent, pack?: AnalyticsPack): CompileResult {
  const wide = compileWideAggregates(intent, pack);
  if (wide) return wide;
  const timeField = packTimeField(pack, intent.table);
  const dims = canonicalDims(intent, pack);
  const dimMeta = dims.map((d) => dimSelectExpr(d, timeField, pack));
  const whereBuilt = buildWhere(intent, pack);
  if (!whereBuilt.ok) return whereBuilt;
  const where = whereBuilt.where;
  let metricExpr: string;
  if (intent.metric.kind === "uniq") {
    const f = intent.metric.distinctField;
    if (!f) return { ok: false, reason: "metric_field_missing:distinctField" };
    const out = findMetricOption(pack, intent.metric.id)?.opt.compile?.outputAlias;
    metricExpr = `uniq(${f}) AS ${out || safeAlias(intent.metric.id)}`;
  } else if (intent.metric.kind === "sum") {
    const f = intent.metric.valueField;
    if (!f) return { ok: false, reason: "metric_field_missing:valueField" };
    metricExpr = `sum(${f}) AS ${f}`;
  } else if (intent.metric.kind === "avg") {
    const f = intent.metric.valueField;
    if (!f) return { ok: false, reason: "metric_field_missing:valueField" };
    metricExpr = `round(avg(${f}), 2) AS ${f}`;
  } else if (intent.metric.kind === "avg_per_user") {
    const valueField = intent.metric.valueField;
    const distinctField = intent.metric.distinctField;
    if (!valueField || !distinctField) return { ok: false, reason: "metric_field_missing:avg_per_user_fields" };
    const out = findMetricOption(pack, intent.metric.id)?.opt.compile?.outputAlias;
    metricExpr = `round(sum(${valueField}) / nullIf(uniq(${distinctField}), 0), 2) AS ${out || safeAlias(intent.metric.id)}`;
  } else if (intent.metric.kind === "count") {
    const f = intent.metric.valueField;
    metricExpr = f ? `count(${f}) AS ${f}` : "count() AS rows";
  } else {
    return { ok: false, reason: `unsupported kind ${intent.metric.kind}` };
  }

  if (!dimMeta.length) {
    const sql = [`SELECT ${metricExpr}`, `FROM ${compileTableRef(pack, intent.table)}`, `WHERE ${where}`].join("\n");
    return { ok: true, sql };
  }

  const sql = [
    `SELECT`,
    `  ${dimMeta.map((d) => d.select).join(",\n  ")},`,
    `  ${metricExpr}`,
    `FROM ${compileTableRef(pack, intent.table)}`,
    `WHERE ${where}`,
    `GROUP BY ${dimMeta.map((d) => d.group).join(", ")}`,
    `ORDER BY ${dimMeta.map((d) => d.group).join(", ")}`,
  ].join("\n");
  return { ok: true, sql };
}

function defaultLangAliases(values: string[], pack?: AnalyticsPack): string[] | null {
  const defaults = packDefaultWideLangs(pack);
  if (defaults.length && values.length === defaults.length && values.every((v, i) => v === defaults[i])) {
    return defaults.map((_, i) => String.fromCharCode(97 + i));
  }
  return null;
}

function compileRatio(intent: AnalyticsIntent, pack?: AnalyticsPack): CompileResult {
  const spec = findMetricOption(pack, intent.metric.id)?.opt.compile?.ratio as RatioCompileSpec | undefined;
  if (!spec) return { ok: false, reason: "ratio_spec_missing" };
  const channel = (intent.filters.channel || [])[0];
  const appVersion = (intent.filters.appVersion || [])[0];
  if (!channel) return { ok: false, reason: "missing_filter:channel" };
  if (!appVersion) return { ok: false, reason: "missing_filter:appVersion" };
  const rel = packRelationships(pack).find((r) => r.id === spec.relationshipId);
  if (!rel) return { ok: false, reason: `relationship_missing:${spec.relationshipId}` };

  const langs = resolveWidePivotValues({ ...intent, layout: intent.layout || "wide", pivotDim: spec.pivotField }, pack);
  const pivotValues = langs.length >= 2 ? langs : packDefaultWideLangs(pack);
  if (pivotValues.length < 2) return { ok: false, reason: "ratio_need_wide_langs" };
  const aliases = defaultLangAliases(pivotValues, pack);

  const denTbl = compileTableRef(pack, spec.denominatorTable);
  const leftTbl = compileTableRef(pack, rel.left.table);
  const rightTbl = compileTableRef(pack, spec.numeratorTable);
  // Physical filter columns must be declared per table in the pack (filterFields) — no defaults.
  const denCh = spec.filterFields.channel?.[spec.denominatorTable];
  const denVer = spec.filterFields.appVersion?.[spec.denominatorTable];
  const numCh = spec.filterFields.channel?.[spec.numeratorTable];
  const numVerLeft = spec.filterFields.appVersion?.[spec.denominatorTable];
  const numVerRight = spec.filterFields.appVersion?.[spec.numeratorTable];
  if (!denCh || !denVer || !numCh || !numVerLeft || !numVerRight) {
    return { ok: false, reason: "ratio_filter_fields_missing" };
  }
  const extra = Object.entries(spec.numeratorFilters || {})
    .flatMap(([field, values]) => {
      if (!values?.length) return [];
      const numeric = values.every((v) => /^-?\d+(\.\d+)?$/.test(v));
      const lit = values.map((v) => (numeric ? v : sqlStringLiteral(v)));
      return values.length === 1
        ? [`bb.${field} = ${lit[0]}`]
        : [`bb.${field} IN (${lit.join(", ")})`];
    })
    .join("\n    AND ");

  const ratioEmptyAlias = emptyValueAlias(pack, spec.pivotField);
  const uniqCols = pivotValues.map((v, i) => {
    const alias = aliases?.[i] || safeAlias(v === "" ? ratioEmptyAlias : v);
    return `uniqIf(${spec.numeratorDistinctField}, ${spec.pivotField} = ${sqlStringLiteral(v)}) AS ${alias}`;
  });
  const rateCols = pivotValues.map((v, i) => {
    const src = aliases?.[i] || safeAlias(v === "" ? ratioEmptyAlias : v);
    const alias = aliases ? `${src}2` : `${src}_rate`;
    return `round(${src} / total, 6) AS ${alias}`;
  });

  const sql = [
    `SELECT`,
    `  ${rateCols.join(",\n  ")}`,
    `FROM (`,
    `  SELECT 1 AS i1, count() AS total`,
    `  FROM ${denTbl}`,
    `  WHERE ${denCh} = ${sqlStringLiteral(channel)} AND ${denVer} = ${sqlStringLiteral(appVersion)}`,
    `) t1`,
    `INNER JOIN (`,
    `  SELECT 1 AS i,`,
    `    ${uniqCols.join(",\n    ")}`,
    `  FROM ${leftTbl} AS aa`,
    `  INNER JOIN ${rightTbl} AS bb ON aa.${rel.left.key} = bb.${rel.right.key}`,
    `  WHERE toDate(bb.${spec.numeratorTimeField}) BETWEEN ${sqlStringLiteral(intent.time.start)} AND ${sqlStringLiteral(intent.time.end)}`,
    extra ? `    AND ${extra}` : "",
    `    AND bb.${numCh} = ${sqlStringLiteral(channel)}`,
    `    AND aa.${numVerLeft} = ${sqlStringLiteral(appVersion)}`,
    `    AND bb.${numVerRight} = ${sqlStringLiteral(appVersion)}`,
    `) t2 ON t1.i1 = t2.i`,
  ]
    .filter(Boolean)
    .join("\n");
  return { ok: true, sql };
}

function langTableRef(spec: RetentionCompileSpec["lang"], pack?: AnalyticsPack): string {
  if (spec.schema) return `${spec.schema}.${spec.table}`;
  return compileTableRef(pack, spec.table);
}

function compileRetention(intent: AnalyticsIntent, pack?: AnalyticsPack): CompileResult {
  const spec = findMetricOption(pack, intent.metric.id)?.opt.compile?.retention as RetentionCompileSpec | undefined;
  if (!spec) return { ok: false, reason: "retention_spec_missing" };
  const channel = (intent.filters.channel || [])[0];
  const appVersion = (intent.filters.appVersion || [])[0];
  if (!channel) return { ok: false, reason: "missing_filter:channel" };
  if (!appVersion) return { ok: false, reason: "missing_filter:appVersion" };
  const n = Number(spec.n || 1);
  const cohortRef = compileTableRef(pack, spec.cohortTable);
  const activeRef = compileTableRef(pack, spec.activeTable);
  const langRef = langTableRef(spec.lang, pack);
  const key = spec.keyField;
  if (!key) return { ok: false, reason: "retention_key_field_missing" };
  const header = [
    `WITH`,
    `${sqlStringLiteral(channel)} AS targetChannel,`,
    `toDate(${sqlStringLiteral(intent.time.start)}) AS targetDate,`,
    `todayGuid AS (`,
    `  SELECT ${key}, argMax(${spec.lang.langField}, ${spec.lang.timeField}) AS ${spec.lang.langField}`,
    `  FROM ${langRef}`,
    `  WHERE eventName = ${sqlStringLiteral(spec.lang.eventName)}`,
    `    AND toDate(${spec.lang.timeField}) = targetDate`,
    `    AND ${spec.lang.channelField} = targetChannel`,
    `    AND ${spec.lang.versionField} = ${sqlStringLiteral(appVersion)}`,
    `    AND ${key} IN (SELECT DISTINCT ${key} FROM ${cohortRef} WHERE ${spec.cohortDateField} = targetDate AND ${spec.cohortChannelField} = targetChannel)`,
    `  GROUP BY ${key}`,
    `),`,
    `retentionGuid AS (`,
    `  SELECT b.${key}, b.${spec.lang.langField}`,
    `  FROM ${activeRef} AS a`,
    `  INNER JOIN todayGuid AS b ON a.${key} = b.${key}`,
    `  WHERE a.${spec.activeDateField} = addDays(targetDate, ${n}) AND a.${spec.activeChannelField} = targetChannel`,
    `)`,
  ];

  if (spec.layout === "total") {
    const sql = [
      ...header,
      `,`,
      `todayCount AS (SELECT uniq(${key}) AS a FROM todayGuid),`,
      `retentionCount AS (SELECT uniq(${key}) AS b FROM retentionGuid)`,
      `SELECT t1.a, t2.b, round(t2.b / t1.a, 2)`,
      `FROM todayCount AS t1, retentionCount AS t2`,
    ].join("\n");
    return { ok: true, sql };
  }

  const langs = resolveWidePivotValues({ ...intent, layout: "wide", pivotDim: spec.lang.langField }, pack);
  const pivotValues = langs.length >= 2 ? langs : packDefaultWideLangs(pack);
  if (pivotValues.length < 2) return { ok: false, reason: "retention_need_wide_langs" };
  const aliases =
    defaultLangAliases(pivotValues, pack) ||
    pivotValues.map((v) => safeAlias(v === "" ? emptyValueAlias(pack, spec.lang.langField) : v));
  const todayCols = pivotValues.map((v, i) => `countIf(${spec.lang.langField} = ${sqlStringLiteral(v)}) AS ${aliases[i]}`);
  const retAliases = aliases.map((a) => (a.length === 1 ? `${a}${a}` : `${a}_r`));
  const retCols = pivotValues.map((v, i) => `countIf(${spec.lang.langField} = ${sqlStringLiteral(v)}) AS ${retAliases[i]}`);
  const rateCols = aliases.map((a, i) => `round(t2.${retAliases[i]} / t1.${a}, 2)`);
  const sql = [
    ...header,
    `,`,
    `todayCount AS (`,
    `  SELECT ${todayCols.join(", ")}`,
    `  FROM todayGuid`,
    `),`,
    `retentionCount AS (`,
    `  SELECT ${retCols.join(", ")}`,
    `  FROM retentionGuid`,
    `)`,
    `SELECT t1.${aliases.join(", t1.")}, t2.${retAliases.join(", t2.")},`,
    `  ${rateCols.join(", ")}`,
    `FROM todayCount AS t1, retentionCount AS t2`,
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
    case "avg":
    case "avg_per_user":
    case "count":
      return compileUniqOrSum(intent, pack);
    case "ratio":
      return compileRatio(intent, pack);
    case "retention_dn":
      return compileRetention(intent, pack);
    default:
      return { ok: false, reason: `unsupported_metric_kind:${String((intent.metric as { kind?: string }).kind || "")}` };
  }
}
