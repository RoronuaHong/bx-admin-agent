/**
 * NL → pack-driven signal detection.
 *
 * Every CJK surface form (grain / dimension / intent-signal) lives in the pack
 * (time.grainAliases, enumDimensions[].aliases, intentSignals, wideShapeCues) — never
 * hard-coded in code. This module is the single read path so the analytics red line
 * (no hard-coded business words) holds.
 */
import { packGrainId, type AnalyticsPack } from "./semantic-layer.js";

function anyAliasHit(nl: string, aliases?: string[]): boolean {
  const text = String(nl || "");
  return (aliases || []).some((a) => a && text.includes(a));
}

/**
 * NL asks for the pack's time grain (time.grainAliases). Grain-agnostic: the id
 * comes from the pack (packGrainId), never from a hard-coded dim name.
 */
export function nlWantsGrain(nl: string, pack: AnalyticsPack | undefined): boolean {
  return anyAliasHit(nl, pack?.time?.grainAliases);
}

/** NL asks for a probe/output dimension declared in the pack (enumDimensions). */
export function nlWantsDim(nl: string, pack: AnalyticsPack | undefined, dim: string): boolean {
  if (!dim) return false;
  if (packGrainId(pack) && dim === packGrainId(pack)) return nlWantsGrain(nl, pack);
  const ed = (pack?.enumDimensions || []).find((d) => d.id === dim || d.field === dim);
  return ed ? anyAliasHit(nl, ed.aliases) : false;
}

/** Intent signal that relaxes a lint rule — sourced from pack.intentSignals, not code. */
export function nlHasIntentSignal(
  nl: string,
  pack: AnalyticsPack | undefined,
  signal: "allowDropEmptyLang" | "allowLimit1",
): boolean {
  return anyAliasHit(nl, pack?.intentSignals?.[signal]);
}

/** NL names a metric/metric-family or probe dimension → treat as a metric question. */
export function isMetricQueryNl(nl: string, pack: AnalyticsPack | undefined): boolean {
  const text = String(nl || "");
  if (anyAliasHit(text, pack?.time?.grainAliases)) return true;
  for (const d of pack?.enumDimensions || []) {
    if (anyAliasHit(text, d.aliases)) return true;
  }
  for (const def of pack?.metricDefs || []) {
    if (anyAliasHit(text, def.aliases)) return true;
    for (const o of def.options || []) {
      if (anyAliasHit(text, [o.label, ...(o.groundSignals || [])])) return true;
    }
  }
  return false;
}

/** NL asks for a wide (language-split) shape. */
export function nlWantsWideShape(nl: string, pack: AnalyticsPack | undefined): boolean {
  return anyAliasHit(nl, pack?.wideShapeCues);
}

/** NL asks for a long (row-per-member) shape. */
export function nlWantsLongShape(nl: string, pack: AnalyticsPack | undefined): boolean {
  return anyAliasHit(nl, pack?.longShapeCues);
}
