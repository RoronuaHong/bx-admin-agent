/**
 * Resolve which warehouse table an NL ask targets.
 * Named table / unique score → pick; overlay-grounded watch asks → overlay;
 * otherwise clarify (do not silently default a non-watch ask onto watch-detail).
 */

import { answerableTableNamedInNl } from "./catalog.js";
import { overlayTableName, type AnalyticsPack } from "./semantic-layer.js";

export type TableResolveOk = { status: "ok"; table: string; reason: string };
export type TableResolveClarify = {
  status: "clarify";
  message: string;
  options: Array<{ id: string; label: string }>;
  reason: string;
};
export type TableResolveResult = TableResolveOk | TableResolveClarify;

/** NL stems → table-name tokens. Used only to rank/clarify, never to invent metrics. */
const STEM_ALIASES: Array<{ re: RegExp; stems: string[] }> = [
  { re: /订单|下单|付款|支付|\bpay\b/i, stems: ["order", "pay"] },
  { re: /充值|recharge/i, stems: ["recharge"] },
  { re: /设备|device/i, stems: ["device"] },
  { re: /邀请|invite/i, stems: ["invite"] },
  { re: /安装|referrer/i, stems: ["referrer", "install"] },
  { re: /登录|login/i, stems: ["login"] },
  { re: /会员|vip/i, stems: ["vip"] },
];

export function overlayAskFromNl(nl: string, pack?: AnalyticsPack): boolean {
  const text = String(nl || "");
  if (!text.trim()) return false;
  if (/观看|观影|完播|人均观看|观看人数|watchSecond|maxWatchProgress|lastWatchTime/i.test(text)) {
    return true;
  }
  for (const def of pack?.metricDefs || []) {
    if ((def.aliases || []).some((a) => a && text.includes(a))) return true;
    for (const opt of def.options || []) {
      if ((opt.groundSignals || []).some((s) => s && text.includes(s))) return true;
      if (opt.label && text.includes(opt.label)) return true;
    }
  }
  return false;
}

function tableTokens(name: string): string[] {
  return String(name || "")
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3 && t !== "elt" && t !== "the");
}

function nlLatinTokens(nl: string): Set<string> {
  const out = new Set<string>();
  for (const m of String(nl || "").matchAll(/\b([A-Za-z][A-Za-z0-9_]{2,})\b/g)) {
    out.add(m[1]!.toLowerCase());
  }
  return out;
}

function stemHits(nl: string): string[] {
  const hits: string[] = [];
  for (const row of STEM_ALIASES) {
    if (row.re.test(nl)) hits.push(...row.stems);
  }
  return [...new Set(hits)];
}

export function scoreAnswerableTables(nl: string, pack: AnalyticsPack): Array<{ name: string; score: number }> {
  const text = String(nl || "");
  const latin = nlLatinTokens(text);
  const stems = stemHits(text);
  const ranked: Array<{ name: string; score: number }> = [];
  for (const t of pack.warehouse?.tables || []) {
    const name = t.name;
    if (!name) continue;
    let score = 0;
    const lower = name.toLowerCase();
    if (latin.has(lower)) score += 8;
    for (const tok of tableTokens(name)) {
      if (latin.has(tok)) score += 4;
      if (stems.includes(tok)) score += 3;
    }
    if (score > 0) ranked.push({ name, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return ranked;
}

function allowed(pack: AnalyticsPack, name: string): boolean {
  const want = String(name || "").trim();
  if (!want) return false;
  if ((pack.warehouse?.tables || []).some((t) => t.name === want)) return true;
  return pack.tables.some((t) => t.name === want);
}

export function resolveAskTable(input: {
  nl: string;
  pack: AnalyticsPack;
  hinted?: string;
  /** Previous Ask table; used when this turn does not name/score a different table. */
  fallback?: string;
}): TableResolveResult {
  const overlay = overlayTableName(input.pack) || "elt_watch_detail";
  const named = answerableTableNamedInNl(input.nl, input.pack);
  if (named) return { status: "ok", table: named, reason: "named_in_nl" };

  const hinted = String(input.hinted || "").trim();
  if (hinted && allowed(input.pack, hinted)) {
    return { status: "ok", table: hinted, reason: "slot_or_hint" };
  }

  if (overlayAskFromNl(input.nl, input.pack)) {
    return { status: "ok", table: overlay, reason: "overlay_grounded" };
  }

  const ranked = scoreAnswerableTables(input.nl, input.pack);
  const best = ranked[0];
  const second = ranked[1];
  if (best && best.score >= 3 && (!second || best.score >= second.score + 2)) {
    return { status: "ok", table: best.name, reason: `unique_score:${best.score}` };
  }

  if (ranked.length >= 2) {
    const options = ranked.slice(0, 8).map((r) => ({
      id: r.name,
      label: `${r.name}（${r.score}）`,
    }));
    if (!options.some((o) => o.id === overlay)) {
      options.unshift({ id: overlay, label: `${overlay}（观影明细，默认）` });
    }
    return {
      status: "clarify",
      reason: "ambiguous_table",
      message: "这句话没有点名表，且可能对应多张业务表。请选择一张，或直接写出 Metabase 表名。",
      options,
    };
  }

  if (best) {
    return { status: "ok", table: best.name, reason: `unique_score:${best.score}` };
  }

  const fallback = String(input.fallback || "").trim();
  if (fallback && allowed(input.pack, fallback)) {
    return { status: "ok", table: fallback, reason: "prev_ask_table" };
  }

  const hasWarehouse = (input.pack.warehouse?.tables || []).length > 0;
  if (!hasWarehouse) {
    return { status: "ok", table: overlay, reason: "catalog_unavailable_overlay" };
  }

  return {
    status: "clarify",
    reason: "table_unspecified",
    message:
      "这句话没有点名表，也无法唯一对应到一张业务表。默认是观影明细；若要查其它表，请选择或写出表名。",
    options: [
      { id: overlay, label: `${overlay}（观影明细，默认）` },
    ],
  };
}
