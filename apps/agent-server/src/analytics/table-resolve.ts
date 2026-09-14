/**
 * Retrieve which warehouse tables an NL ask should write against.
 * Industry (Cortex / Cube / Metabot): schema-link from the catalog — do not
 * make the user lock a table. Unique / named / modeled → compile Path A;
 * close scores → Path C with top-k rich schemas + compact catalog.
 */

import { tableIdentity, tableSynonyms } from "./catalog-card.js";
import { answerableTableNamedInNl } from "./catalog.js";
import { inferMetricIdFromNl } from "./metric-infer.js";
import {
  expandLinkedTables,
  findMetricOption,
  overlayTableName,
  type AnalyticsPack,
  type WarehouseTable,
} from "./semantic-layer.js";

export const RICH_TABLE_CAP = 6;

export type TableConfidence =
  | "named"
  | "hint"
  | "metric"
  | "overlay"
  | "unique"
  | "retrieved"
  | "fallback"
  | "catalog";

export type TableResolveOk = {
  status: "ok";
  table: string;
  linked: string[];
  reason: string;
  confidence: TableConfidence;
};
export type TableResolveClarify = {
  status: "clarify";
  message: string;
  options: Array<{ id: string; label: string }>;
  reason: string;
};
export type TableResolveResult = TableResolveOk | TableResolveClarify;

/** NL stems → table-name tokens. Used only to rank, never to invent metrics. */
const STEM_ALIASES: Array<{ re: RegExp; stems: string[] }> = [
  { re: /订单|下单|付款|支付|成交|营收|\bpay\b|\bgmv\b/i, stems: ["order", "pay"] },
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
  if (pack) {
    const named = answerableTableNamedInNl(text, pack);
    if (named && named !== overlayTableName(pack)) return false;
  }
  if (
    /观影日志|观影行为|偏好行为|播放错误|播放缓冲/i.test(text) &&
    !/观看人数|完播率|人均观看|人均时长/i.test(text)
  ) {
    return false;
  }
  if (/观看|观影|完播|人均观看|观看人数|watchSecond|maxWatchProgress|lastWatchTime/i.test(text)) {
    return true;
  }
  const overlay = overlayTableName(pack);
  for (const def of pack?.metricDefs || []) {
    if (def.tables?.length && overlay && !def.tables.includes(overlay)) continue;
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

const DOC_STOP = new Set([
  "本表",
  "记录",
  "存储",
  "每天",
  "分区",
  "排序",
  "去重",
  "核心",
  "信息",
  "注意",
  "事项",
  "查询",
  "必须",
  "时间",
  "条件",
  "数据",
  "巨大",
  "连表",
  "需要",
  "谨慎",
  "最近",
  "一年",
  "通过",
  "确认",
  "一个",
  "是否",
  "包含",
  "以及",
  "进行",
  "使用",
  "相关",
  "可以",
  "如果",
  "只有",
  "每个",
  "没有",
  "其他",
  "或者",
  "此表",
  "用来",
  "作为",
  "标识",
  "维度",
  "限定",
  "超过",
  "范围",
  "不能",
  "最多",
  "不要",
  "关键",
  "依赖",
  "选择",
  "用户",
  "设备",
  "字段",
  "说明",
]);

function tableTitleText(t: WarehouseTable): string {
  return tableIdentity(t);
}

function tableCoreItems(t: WarehouseTable): string[] {
  const desc = String(t.description || "");
  const m = desc.match(/核心信息[：:]([\s\S]*?)(?:注意事项|$)/);
  if (!m?.[1]) return [];
  return m[1]
    .split(/[、，,;；。\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 16);
}

function extractDocPhrases(text: string, allowPrefix = false): string[] {
  const out = new Set<string>();
  for (const token of String(text || "").split(/[\s,，、。；;：:的为是和及\n（）()【】/]+/)) {
    const t = token.trim();
    if (!/[\u4e00-\u9fff]/.test(t)) continue;
    if (t.length < 2 || t.length > 12 || DOC_STOP.has(t)) continue;
    out.add(t);
    if (allowPrefix && t.length >= 4 && t.length <= 8) {
      for (const len of [2, 3, 4]) {
        if (len >= t.length) continue;
        const p = t.slice(0, len);
        if (!DOC_STOP.has(p)) out.add(p);
      }
    }
  }
  return [...out];
}

type PhraseHit = { tables: Set<string>; weight: number };

function scoreDocOverlap(nl: string, pack: AnalyticsPack): Map<string, number> {
  const text = String(nl || "");
  const index = new Map<string, PhraseHit>();
  const add = (phrase: string, table: string, weight: number) => {
    const cur = index.get(phrase) || { tables: new Set<string>(), weight: 0 };
    cur.tables.add(table);
    cur.weight = Math.max(cur.weight, weight);
    index.set(phrase, cur);
  };
  for (const t of pack.warehouse?.tables || []) {
    for (const phrase of extractDocPhrases(tableTitleText(t), true)) {
      add(phrase, t.name, 3);
    }
    for (const item of tableCoreItems(t)) {
      for (const phrase of extractDocPhrases(item, false)) {
        add(phrase, t.name, 1);
      }
    }
  }
  const hits = new Map<string, number>();
  const phrases = [...index.keys()].sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    if (!text.includes(phrase)) continue;
    const hit = index.get(phrase);
    if (!hit) continue;
    if (hit.tables.size >= 4) continue;
    if (phrase.length === 2 && hit.tables.size > 1) continue;
    const idf = hit.tables.size === 1 ? 6 : hit.tables.size === 2 ? 2 : 1;
    const lenBonus = phrase.length >= 4 ? 3 : phrase.length >= 3 ? 1 : 0;
    const points = (idf + lenBonus) * hit.weight;
    for (const name of hit.tables) {
      hits.set(name, (hits.get(name) || 0) + points);
    }
  }
  return hits;
}

function scoreSynonymHits(nl: string, pack: AnalyticsPack): Map<string, number> {
  const text = String(nl || "");
  const owners = new Map<string, string[]>();
  for (const t of pack.warehouse?.tables || []) {
    for (const syn of tableSynonyms(t)) {
      const list = owners.get(syn) || [];
      list.push(t.name);
      owners.set(syn, list);
    }
  }
  const hits = new Map<string, number>();
  const syns = [...owners.keys()].sort((a, b) => b.length - a.length);
  for (const syn of syns) {
    if (!text.includes(syn)) continue;
    const tables = [...new Set(owners.get(syn) || [])];
    if (tables.length >= 4) continue;
    if (syn.length === 2 && tables.length > 1) continue;
    const idf = tables.length === 1 ? 8 : tables.length === 2 ? 3 : 1;
    const lenBonus = syn.length >= 4 ? 4 : syn.length >= 3 ? 2 : 0;
    const points = idf + lenBonus;
    for (const name of tables) {
      hits.set(name, (hits.get(name) || 0) + points);
    }
  }
  return hits;
}

function fieldPhraseText(t: WarehouseTable): string {
  const bits: string[] = [];
  for (const meta of Object.values(t.fieldMeta || {})) {
    if (meta.displayName) bits.push(meta.displayName);
    if (meta.description) bits.push(String(meta.description));
  }
  return bits.join(" ");
}

function scoreFieldOverlap(nl: string, pack: AnalyticsPack): Map<string, number> {
  const text = String(nl || "");
  const index = new Map<string, PhraseHit>();
  const add = (phrase: string, table: string, weight: number) => {
    const cur = index.get(phrase) || { tables: new Set<string>(), weight: 0 };
    cur.tables.add(table);
    cur.weight = Math.max(cur.weight, weight);
    index.set(phrase, cur);
  };
  for (const t of pack.warehouse?.tables || []) {
    for (const phrase of extractDocPhrases(fieldPhraseText(t), false)) {
      add(phrase, t.name, 2);
    }
  }
  const hits = new Map<string, number>();
  const phrases = [...index.keys()].sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    if (!text.includes(phrase)) continue;
    const hit = index.get(phrase);
    if (!hit) continue;
    if (hit.tables.size >= 6) continue;
    if (phrase.length === 2 && hit.tables.size > 1) continue;
    const idf = hit.tables.size === 1 ? 4 : hit.tables.size === 2 ? 2 : 1;
    const points = idf * hit.weight;
    for (const name of hit.tables) {
      hits.set(name, (hits.get(name) || 0) + points);
    }
  }
  return hits;
}

export function scoreAnswerableTables(nl: string, pack: AnalyticsPack): Array<{ name: string; score: number }> {
  const text = String(nl || "");
  const latin = nlLatinTokens(text);
  const stems = stemHits(text);
  const docHits = scoreDocOverlap(text, pack);
  const fieldHits = scoreFieldOverlap(text, pack);
  const synHits = scoreSynonymHits(text, pack);
  const ranked: Array<{ name: string; score: number }> = [];
  for (const t of pack.warehouse?.tables || []) {
    const name = t.name;
    if (!name) continue;
    let score = (docHits.get(name) || 0) + (fieldHits.get(name) || 0) + (synHits.get(name) || 0);
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

function pickRetrievedNames(ranked: Array<{ name: string; score: number }>, cap = RICH_TABLE_CAP): string[] {
  if (!ranked.length) return [];
  const top = ranked[0]!.score;
  return ranked
    .filter((r) => r.score >= top - 2 || r.score >= top * 0.55)
    .slice(0, cap)
    .map((r) => r.name);
}

function okResult(
  pack: AnalyticsPack,
  table: string,
  reason: string,
  confidence: TableConfidence,
  seeds?: string[],
): TableResolveOk {
  const linked = expandLinkedTables(pack, seeds?.length ? seeds : table ? [table] : [], RICH_TABLE_CAP);
  return { status: "ok", table, linked, reason, confidence };
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
  if (named) return okResult(input.pack, named, "named_in_nl", "named");

  const hinted = String(input.hinted || "").trim();
  if (hinted && allowed(input.pack, hinted)) {
    return okResult(input.pack, hinted, "slot_or_hint", "hint");
  }

  const metricId = inferMetricIdFromNl(input.nl, input.pack);
  const metricLock = metricId ? findMetricOption(input.pack, metricId)?.def.tables?.[0] : undefined;
  if (metricLock) {
    return okResult(input.pack, metricLock, `metric_tables:${metricId}`, "metric");
  }

  if (overlayAskFromNl(input.nl, input.pack)) {
    return okResult(input.pack, overlay, "overlay_grounded", "overlay");
  }

  const ranked = scoreAnswerableTables(input.nl, input.pack);
  const best = ranked[0];
  const second = ranked[1];
  if (best && best.score >= 3 && (!second || best.score >= second.score + 2)) {
    return okResult(input.pack, best.name, `unique_score:${best.score}`, "unique");
  }

  if (ranked.length) {
    const seeds = pickRetrievedNames(ranked);
    return okResult(input.pack, best?.name || seeds[0] || "", `retrieved:${seeds.length}`, "retrieved", seeds);
  }

  const fallback = String(input.fallback || "").trim();
  if (fallback && allowed(input.pack, fallback)) {
    return okResult(input.pack, fallback, "prev_ask_table", "fallback");
  }

  const hasWarehouse = (input.pack.warehouse?.tables || []).length > 0;
  if (!hasWarehouse) {
    return okResult(input.pack, overlay, "catalog_unavailable_overlay", "overlay");
  }

  return okResult(input.pack, "", "catalog_retrieve", "catalog");
}
