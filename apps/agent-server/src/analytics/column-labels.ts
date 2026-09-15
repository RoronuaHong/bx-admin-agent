/**
 * Display titles for analytics result columns: user NL phrases, 1:1 with SQL aliases.
 * Keys stay as SQL names (te_IN / watchDate); titles come from the ask text.
 * Which aliases exist (grain column / dim columns) comes from the pack.
 */

import { packGrainAlias, packTimeField, type AnalyticsPack } from "./semantic-layer.js";

export type NlFieldLabel = { code: string; label: string };

function normalizeCode(raw: string): string {
  const t = String(raw || "").trim();
  if (!t || t === "(empty)" || t === "''" || t === '""') return "";
  if (/^(en|a|aa)$/i.test(t)) return "";
  return t.replace(/_/g, "-").toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function localeFromInner(inner: string): string | undefined {
  const loc = inner.match(/\b([a-z]{2}-[A-Za-z]{2})\b/i);
  if (loc) return `${loc[1]!.slice(0, 2).toLowerCase()}-${loc[1]!.slice(3).toUpperCase()}`;
  // 任意列被赋空串 = 空值成员（`x=''` / 「为空」）
  if (/[A-Za-z_][\w.]*\s*=\s*(?:''|""|['"]\s*['"])/.test(inner) || /为空|空串|空字符/.test(inner)) {
    return "";
  }
  return undefined;
}

/** `英语（contentLang=''）` / `泰卢固语（te-IN）` / `观看日期（由 <time column> …）` */
export function extractNlFieldLabels(nl: string, pack?: AnalyticsPack): NlFieldLabel[] {
  const text = String(nl || "");
  const out: NlFieldLabel[] = [];
  const seen = new Set<string>();
  const add = (code: string, label: string) => {
    const key = `${normalizeCode(code)}::${label}`;
    if (!label || seen.has(key)) return;
    seen.add(key);
    out.push({ code, label });
  };

  const timeField = packTimeField(pack);
  const grainAlias = packGrainAlias(pack);
  const grainCode = grainAlias || timeField;
  const grainLabel = String(pack?.time?.grainColumnLabel || "").trim();
  const timeCue = [timeField, grainAlias].filter(Boolean).map(escapeRe).join("|");
  const dateish = (s: string) =>
    (Boolean(timeCue) && new RegExp(timeCue, "i").test(s)) ||
    /date|time/i.test(s) ||
    /日期|时间/.test(s);
  const dimFor = (inner: string) =>
    (pack?.enumDimensions || []).find(
      (d) =>
        (d.field && new RegExp(`^${escapeRe(d.field)}$`, "i").test(inner)) ||
        (d.aliases || []).some((a) => a && inner.includes(a)),
    );

  for (const m of text.matchAll(/([^\s，,；;。:\n（(]{1,32})[（(]([^）)]*)[）)]/g)) {
    const label = m[1]!
      .replace(/^[的对和与及]/, "")
      .replace(/^(?:分别按|按|统计|计算)/, "")
      .trim();
    const inner = m[2]!.trim();
    const loc = localeFromInner(inner);
    if (loc !== undefined) {
      add(loc, label);
      continue;
    }
    if (grainCode && dateish(inner)) {
      add(grainCode, label);
      continue;
    }
    const dim = dimFor(inner);
    if (dim?.field) {
      add(dim.field, label);
      continue;
    }
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(inner)) {
      add(inner, label);
    }
  }

  // 无括号的裸提：按 pack 的粒度别名/标签补一列标题
  if (grainCode && grainLabel && dateish(text) && !out.some((h) => normalizeCode(h.code) === normalizeCode(grainCode))) {
    add(grainCode, grainLabel);
  }
  for (const d of pack?.enumDimensions || []) {
    const code = d.field || d.id;
    const label = String(d.aliases?.[0] || d.id || "").trim();
    if (!code || !label || out.some((h) => normalizeCode(h.code) === normalizeCode(code))) continue;
    if ((d.aliases || []).some((a) => a && text.includes(a))) add(code, label);
  }
  return out;
}

function colMatchKey(col: string): string {
  return normalizeCode(col);
}

/**
 * Map SQL aliases to user-mentioned labels. Unmentioned cols keep the alias.
 */
export function relabelAnalyticsCols(nl: string, cols: string[], pack?: AnalyticsPack): string[] {
  const hits = extractNlFieldLabels(nl, pack);
  if (!hits.length) return [...cols];
  const byCode = new Map<string, string>();
  for (const h of hits) byCode.set(normalizeCode(h.code), h.label);
  return cols.map((col) => {
    const key = colMatchKey(col);
    const label = byCode.get(key);
    return label || col;
  });
}

export function withNlColumnTitles<T extends { cols: string[] }>(
  tables: T[],
  nl: string,
  pack?: AnalyticsPack,
): Array<T & { colTitles: string[] }> {
  return (tables || []).map((t) => ({
    ...t,
    colTitles: relabelAnalyticsCols(nl, t.cols || [], pack),
  }));
}
