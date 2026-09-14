/**
 * Soft metric id inference from NL using pack metricDefs.
 * Multi-option families (完播率 / 观看时长) only resolve when an option is grounded.
 */

import {
  findMetricOption,
  isNumericWarehouseType,
  isOverlayTable,
  packFieldType,
  packFieldsForTable,
  warehouseTable,
  type AnalyticsPack,
  type MetricDef,
  type MetricDefOption,
} from "./semantic-layer.js";
import { extractAppVersionFromNl } from "./verified-query.js";
import { extractChannelsFromNl } from "./intent.js";
import { parseGenericMetricId } from "./intent.js";
import { nlWantsWideShape } from "./verified-query.js";

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

/** Wide 完播 is the Path A avg_of_max shape — do not reopen the 完播率 family. */
function completionWideFromNl(text: string, def: MetricDef): boolean {
  return def.id === "completion_rate" && familyAliasHit(text, def) && nlWantsWideShape(text);
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
    if (completionWideFromNl(text, def)) continue;
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

function inferGenericMetricForTable(nl: string, pack: AnalyticsPack, table: string): string | undefined {
  const fields = packFieldsForTable(pack, table);
  const has = (n: string) => fields.includes(n);
  const numeric = (n: string) => isNumericWarehouseType(packFieldType(pack, n, table));
  const w = warehouseTable(pack, table);

  if (/金额|实付|收入|\bGMV\b|\bgmv\b/.test(nl)) {
    const named = fields.find(
      (f) => numeric(f) && /^(amount|payAmount|realAmount|price|income)$/i.test(f),
    );
    if (named) return `sum:${named}`;
    const fromDoc = fields.find((f) => {
      if (!numeric(f)) return false;
      const meta = w?.fieldMeta?.[f];
      const hay = `${meta?.displayName || ""} ${meta?.description || ""}`;
      return /金额|实付|收入/.test(hay);
    });
    if (fromDoc) return `sum:${fromDoc}`;
  }

  if (/时长合计|总时长|总观看/.test(nl)) {
    const f = fields.find((x) => /watchSecond|duration|activeSecond|seconds/i.test(x));
    if (f) return `sum:${f}`;
  }

  if (/人数|UV|uv|用户数|用户有多少|有多少.*用户/.test(nl)) {
    if (has("guid")) return "uniq:guid";
    if (has("uid")) return "uniq:uid";
  }

  if (/多少|数量|条数|笔数|次数|订单数|有多少|统计|一共/.test(nl)) {
    return "count:*";
  }

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
    if (completionWideFromNl(text, def)) grounded.push("avg_max_progress");
    if (!grounded.length && familyAliasHit(text, def)) {
      const fallback = options.find((o) => o.defaultWhenAbsent && o.compile?.kind);
      if (fallback) defaults.push(fallback.id);
    }
    hits.push(...grounded);
  }
  const unique = [...new Set(hits)];
  const userCountCue = /观看人数|用户数|\bUV\b|\buv\b/.test(text);
  const durationCue = /时长|watchSecond|总观看/.test(text);
  if (userCountCue && !durationCue && unique.includes("sum_watch_second")) {
    return "uniq_users";
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
  for (const b of BUILTIN) {
    if (b.signals.test(nl)) return b.id;
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

export function inferOutputDimsFromNl(nl: string): string[] {
  const dims: string[] = [];
  if (/按天|按日|按.*日期|每天|观看日期/.test(nl)) dims.push("watch_date");
  if (/按.*渠道|各渠道|渠道.*维度|分组.*渠道/.test(nl)) dims.push("channel");
  if (/按.*语言|各语言|contentLang/.test(nl)) dims.push("contentLang");
  return [...new Set(dims)];
}
