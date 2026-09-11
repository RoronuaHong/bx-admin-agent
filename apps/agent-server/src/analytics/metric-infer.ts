/**
 * Soft metric id inference from NL using pack metricDefs aliases / known ids.
 * Used to promote clarify→ok when enum labels are NL-grounded.
 */

import type { AnalyticsPack } from "./semantic-layer.js";

const BUILTIN: Array<{ id: string; signals: RegExp }> = [
  { id: "avg_watch_second_per_user", signals: /人均|人均观看|人均时长/ },
  { id: "avg_max_progress", signals: /完播|最大进度|最大观看进度/ },
  { id: "sum_watch_second", signals: /时长合计|总时长|总观看|观看时长合计/ },
  { id: "uniq_users", signals: /观看人数|人数|UV|uv|用户数/ },
];

export function inferMetricIdFromNl(nl: string, pack: AnalyticsPack): string | undefined {
  const text = String(nl || "");
  for (const def of pack.metricDefs || []) {
    for (const opt of def.options || []) {
      if (!opt.compile?.kind) continue;
      const signals = [...(opt.groundSignals || []), ...(def.aliases || []), opt.label].filter(Boolean);
      for (const s of signals) {
        if (s && text.includes(s)) return opt.id;
      }
    }
  }
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
