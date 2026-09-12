/**
 * Soft metric id inference from NL using pack metricDefs.
 * Multi-option families (完播率 / 观看时长) only resolve when an option is grounded.
 */

import type { AnalyticsPack, MetricDef, MetricDefOption } from "./semantic-layer.js";
import { parseGenericMetricId } from "./intent.js";

const BUILTIN: Array<{ id: string; signals: RegExp }> = [
  { id: "avg_watch_second_per_user", signals: /人均|人均观看|人均时长/ },
  { id: "avg_max_progress", signals: /最大进度|最大观看进度/ },
  { id: "sum_watch_second", signals: /时长合计|总时长|总观看|观看时长合计/ },
  { id: "uniq_users", signals: /观看人数|人数|UV|uv|用户数/ },
];

function optionGroundedInText(text: string, opt: MetricDefOption): boolean {
  const signals = [...(opt.groundSignals || []), opt.label].filter(Boolean);
  return signals.some((s) => s && text.includes(s));
}

function familyAliasHit(text: string, def: MetricDef): boolean {
  return (def.aliases || []).some((a) => a && text.includes(a));
}

/** True when NL names a multi-option family but does not ground exactly one option. */
export function metricFamilyNeedsClarify(nl: string, pack: AnalyticsPack): boolean {
  return Boolean(ambiguousMetricFamilyClarify(nl, pack));
}

/**
 * NL for the metric-family gate. Always the latest user turn — never the full
 * transcript. History「完播率」must not reopen on a dim/channel follow-up.
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
    const grounded = options.filter((opt) => optionGroundedInText(text, opt));
    if (grounded.length === 1) continue;
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
  for (const b of BUILTIN) ids.add(b.id);
  return ids;
}

/** If model invented an unknown metric id, remap from this turn's NL only. */
export function coerceUnknownMetricId(metricId: string, nl: string, pack: AnalyticsPack): string {
  const id = String(metricId || "").trim();
  if (!id || knownMetricIds(pack).has(id) || parseGenericMetricId(id)) return id;
  return inferMetricIdFromNl(nl, pack) || id;
}

/**
 * If this turn's NL uniquely grounds a pack metric and the model filled a different
 * in-range id, prefer the NL-grounded id (CWR intercept; no new business wordlist).
 */
export function alignMetricIdToNl(metricId: string, nl: string, pack: AnalyticsPack): string {
  const id = String(metricId || "").trim();
  if (parseGenericMetricId(id)) return id;
  const inferred = inferMetricIdFromNl(nl, pack);
  if (!inferred || !id || inferred === id) return id;
  return inferred;
}

export function inferMetricIdFromNl(nl: string, pack: AnalyticsPack): string | undefined {
  const text = String(nl || "");
  const hits: string[] = [];

  for (const def of pack.metricDefs || []) {
    const options = def.options || [];
    for (const opt of options) {
      if (!opt.compile?.kind) continue;
      if (optionGroundedInText(text, opt)) hits.push(opt.id);
    }
    // Single-option family: parent aliases may select that option
    if (options.length === 1 && options[0]?.compile?.kind && familyAliasHit(text, def)) {
      hits.push(options[0].id);
    }
  }

  const unique = [...new Set(hits)];
  const userCountCue = /观看人数|用户数|\bUV\b|\buv\b/.test(text);
  const durationCue = /时长|watchSecond|总观看/.test(text);
  if (userCountCue && !durationCue && unique.includes("sum_watch_second")) {
    return "uniq_users";
  }
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) return undefined;

  for (const b of BUILTIN) {
    if (b.signals.test(text)) return b.id;
  }
  return undefined;
}

export function inferOutputDimsFromNl(nl: string): string[] {
  const dims: string[] = [];
  if (/按天|按日|按.*日期|每天|观看日期/.test(nl)) dims.push("watch_date");
  if (/按.*渠道|各渠道|渠道.*维度|分组.*渠道/.test(nl)) dims.push("channel");
  if (/按.*语言|各语言|contentLang/.test(nl)) dims.push("contentLang");
  return [...new Set(dims)];
}
