/**
 * Soft metric id inference from NL using pack metricDefs.
 * Multi-option metric families only resolve when an option is grounded.
 */

import {
  findMetricOption,
  isNumericWarehouseType,
  isOverlayTable,
  packFieldType,
  packFieldsForTable,
  packGrainId,
  warehouseTable,
  type AnalyticsPack,
  type MetricDef,
  type MetricDefOption,
} from "./semantic-layer.js";
import { extractAppVersionFromNl } from "./verified-query.js";
import { extractChannelsFromNl } from "./intent.js";
import { parseGenericMetricId } from "./intent.js";
import { packDefaultEntityKey } from "./semantic-layer.js";
import { nlWantsDim, nlWantsGrain, nlWantsWideShape } from "./nl-signals.js";

function optionGroundedInText(text: string, opt: MetricDefOption): boolean {
  const signals = [...(opt.groundSignals || []), opt.label].filter(Boolean);
  return signals.some((s) => s && text.includes(s));
}

function familyAliasHit(text: string, def: MetricDef): boolean {
  return (def.aliases || []).some((a) => a && text.includes(a));
}

/**
 * The wide shape of a family is its avg_of_max option (pack-owned id) — if the NL asks for
 * the wide shape, that family must not reopen into a clarify. No metric id in code.
 */
function wideShapeOptionId(def: MetricDef): string | undefined {
  return (def.options || []).find((o) => o.compile?.kind === "avg_of_max")?.id;
}

function wideShapeGroundedFromNl(text: string, def: MetricDef, pack: AnalyticsPack): boolean {
  if (!wideShapeOptionId(def)) return false;
  if (!familyAliasHit(text, def)) return false;
  return nlWantsWideShape(text, pack);
}

/** True when NL names a multi-option family but does not ground exactly one option. */
export function metricFamilyNeedsClarify(nl: string, pack: AnalyticsPack): boolean {
  return Boolean(ambiguousMetricFamilyClarify(nl, pack));
}

/**
 * NL for the metric-family gate. Always the latest user turn — never the full
 * transcript. History completion phrasing must not reopen on a dim/channel follow-up.
 */
export function nlForMetricFamilyGate(input: {
  lastUserText?: string;
  fallbackNl?: string;
}): string {
  return String(input.lastUserText || input.fallbackNl || "").trim();
}

export function ambiguousMetricFamilyClarify(
  nl: string,
  pack: AnalyticsPack,
): { familyId: string; message: string } | null {
  const text = String(nl || "");
  for (const def of pack.metricDefs || []) {
    const options = def.options || [];
    if (options.length < 2) continue;
    if (!familyAliasHit(text, def)) continue;
    if (wideShapeGroundedFromNl(text, def, pack)) continue;
    const grounded = options.filter((opt) => optionGroundedInText(text, opt));
    if (grounded.length === 1) continue;
    if (!grounded.length && options.some((opt) => opt.defaultWhenAbsent && opt.compile?.kind)) {
      continue;
    }
    const labels = options.map((o) => o.label || o.id).join("、");
    const alias = def.aliases?.[0] || def.id;
    return {
      familyId: def.id,
      message: `「${alias}」有多种口径，请确认要用哪一种（例如 ${labels}）。`,
    };
  }
  return null;
}

export function knownMetricIds(pack: AnalyticsPack): Set<string> {
  const ids = new Set<string>(pack.capabilities?.metrics || []);
  for (const def of pack.metricDefs || []) {
    for (const opt of def.options || []) {
      if (opt.id) ids.add(opt.id);
    }
  }
  return ids;
}

/** If model invented an unknown metric id, remap from this turn's NL only. */
export function coerceUnknownMetricId(metricId: string, nl: string, pack: AnalyticsPack): string {
  const id = String(metricId || "").trim();
  if (!id || knownMetricIds(pack).has(id) || parseGenericMetricId(id, packDefaultEntityKey(pack))) {
    return id;
  }
  return inferMetricIdFromNl(nl, pack) || id;
}

/**
 * If this turn's NL uniquely grounds a pack metric and the model filled a different
 * in-range id, prefer the NL-grounded id (CWR intercept; no new business wordlist).
 */
export function alignMetricIdToNl(metricId: string, nl: string, pack: AnalyticsPack): string {
  const id = String(metricId || "").trim();
  if (parseGenericMetricId(id, packDefaultEntityKey(pack))) return id;
  const inferred = inferMetricIdFromNl(nl, pack);
  if (!inferred || !id || inferred === id) return id;
  return inferred;
}

/**
 * CJK bigrams — a language-agnostic overlap measure between the user's wording and the
 * warehouse's own column documentation ("订单金额合计" ∩ "实付金额" = "金额").
 */
function cjkBigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const run of String(text || "").split(/[^\u4e00-\u9fff]+/)) {
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

function sharesCjk(grams: Set<string>, text: string): boolean {
  for (const g of cjkBigrams(text)) {
    if (grams.has(g)) return true;
  }
  return false;
}

/**
 * Generic aggregation cues — NLP function words ("合计/总和/平均/sum/total"), not business
 * terms. A `sum:<field>` is only inferred when the NL actually asks for an aggregate of a
 * value, so "人群包有多少个" stays a count instead of summing an id column.
 */
const AGG_CUES = /合计|总计|总和|总额|总数|一共|累计|平均|均值|求和|最大|最小|\bsum\b|\btotal\b|\bavg\b/i;

/**
 * Generic metric fallback for non-overlay tables: the measure is grounded on the table's own
 * Metabase docs (column identifier + displayName/description) and pack entities. No business
 * word lists, no warehouse-specific field names — adding a table needs zero code change.
 */
function inferGenericMetricForTable(nl: string, pack: AnalyticsPack, table: string): string | undefined {
  const text = String(nl || "");
  const fields = packFieldsForTable(pack, table);
  const w = warehouseTable(pack, table);
  const isNum = (f: string) => isNumericWarehouseType(packFieldType(pack, f, table));
  const docText = (f: string): string => {
    const meta = w?.fieldMeta?.[f];
    return `${meta?.displayName || ""} ${meta?.description || ""}`.trim();
  };

  // 1) A numeric column named in the NL — by identifier, else by overlapping its doc wording.
  //    Both need an explicit aggregation cue, else "有多少个" would sum an id column.
  if (AGG_CUES.test(text)) {
    const byName = fields.filter((f) => isNum(f) && f.length >= 3 && text.includes(f));
    if (byName.length === 1) return `sum:${byName[0]}`;
    const nlGrams = cjkBigrams(text);
    const byDoc = fields.filter((f) => isNum(f) && sharesCjk(nlGrams, docText(f)));
    if (byDoc.length === 1) return `sum:${byDoc[0]}`;
  }

  // 2) A pack-declared entity key named in the NL → distinct count of that entity.
  for (const ent of pack.entities || []) {
    for (const key of ent.keys || []) {
      if (key.length >= 3 && fields.includes(key) && text.includes(key)) return `uniq:${key}`;
    }
  }

  // 3) Documented table → plain row count is the only measure left that cannot be wrong.
  if (String(w?.description || "").trim()) return "count:*";
  return undefined;
}

function inferFromMetricDefs(text: string, pack: AnalyticsPack): string | undefined {
  const hits: string[] = [];
  const defaults: string[] = [];
  for (const def of pack.metricDefs || []) {
    const options = def.options || [];
    const grounded: string[] = [];
    for (const opt of options) {
      if (!opt.compile?.kind) continue;
      if (optionGroundedInText(text, opt)) grounded.push(opt.id);
    }
    if (options.length === 1 && options[0]?.compile?.kind && familyAliasHit(text, def)) {
      grounded.push(options[0].id);
    }
    const wideId = wideShapeOptionId(def);
    if (wideId && wideShapeGroundedFromNl(text, def, pack)) grounded.push(wideId);
    if (!grounded.length && familyAliasHit(text, def)) {
      const fallback = options.find((o) => o.defaultWhenAbsent && o.compile?.kind);
      if (fallback) defaults.push(fallback.id);
    }
    hits.push(...grounded);
  }
  const unique = [...new Set(hits)];
  // A grounded distinct-count option wins over a sum option whose value field the NL never
  // names (overlapping family aliases can ground both). Kinds are pack-owned.
  const uniqId = unique.find((id) => findMetricOption(pack, id)?.opt.compile?.kind === "uniq");
  if (uniqId) {
    const hijack = unique.some((id) => {
      const c = findMetricOption(pack, id)?.opt.compile;
      return c?.kind === "sum" && (!c.valueField || !text.includes(c.valueField));
    });
    if (hijack) return uniqId;
  }
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) {
    const specific = unique.filter((id) => !findMetricOption(pack, id)?.opt.defaultWhenAbsent);
    if (specific.length === 1) return specific[0];
    return undefined;
  }
  if (defaults.length === 1) return defaults[0];
  return undefined;
}

export function inferMetricIdFromNl(nl: string, pack: AnalyticsPack, table?: string): string | undefined {
  const fromDefs = inferFromMetricDefs(String(nl || ""), pack);
  if (fromDefs) return fromDefs;
  if (table && !isOverlayTable(pack, table)) {
    return inferGenericMetricForTable(nl, pack, table);
  }
  return undefined;
}

export function missingRequiredMetricSlots(
  metricId: string | undefined,
  nl: string,
  pack: AnalyticsPack,
  slotAnswers?: Record<string, string[]>,
): Array<"channel" | "appVersion"> {
  const found = metricId ? findMetricOption(pack, metricId) : undefined;
  const need = found?.def.requiredSlots || [];
  if (!need.length) return [];
  const missing: Array<"channel" | "appVersion"> = [];
  const channels = slotAnswers?.channel?.length
    ? slotAnswers.channel
    : extractChannelsFromNl(nl, pack);
  const ver = slotAnswers?.appVersion?.[0] || extractAppVersionFromNl(nl);
  if (need.includes("channel") && !channels.length) missing.push("channel");
  if (need.includes("appVersion") && !ver) missing.push("appVersion");
  return missing;
}

/** Output dims the NL asks for — grain + enum dims flagged `outputDim` in the pack. */
export function inferOutputDimsFromNl(nl: string, pack?: AnalyticsPack): string[] {
  if (!pack) return [];
  const dims: string[] = [];
  const grain = packGrainId(pack);
  if (grain && nlWantsGrain(nl, pack)) dims.push(grain);
  for (const d of pack.enumDimensions || []) {
    if (!d.outputDim) continue;
    const id = d.id || d.field;
    if (id && nlWantsDim(nl, pack, id)) dims.push(id);
  }
  return [...new Set(dims)];
}
