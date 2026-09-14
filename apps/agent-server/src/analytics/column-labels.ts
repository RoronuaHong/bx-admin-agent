/**
 * Display titles for analytics result columns: user NL phrases, 1:1 with SQL aliases.
 * Keys stay as SQL names (te_IN / watchDate); titles come from the ask text.
 */

export type NlFieldLabel = { code: string; label: string };

function normalizeCode(raw: string): string {
  const t = String(raw || "").trim();
  if (!t || t === "(empty)" || t === "''" || t === '""') return "";
  if (/^(en|a|aa)$/i.test(t)) return "";
  return t.replace(/_/g, "-").toLowerCase();
}

function localeFromInner(inner: string): string | undefined {
  const loc = inner.match(/\b([a-z]{2}-[A-Za-z]{2})\b/i);
  if (loc) return `${loc[1]!.slice(0, 2).toLowerCase()}-${loc[1]!.slice(3).toUpperCase()}`;
  if (/contentLang\s*=\s*(?:''|""|['\"]\s*['\"])/i.test(inner) || /为空|空串|空字符/.test(inner)) {
    return "";
  }
  return undefined;
}

/** `英语（contentLang=''）` / `泰卢固语（te-IN）` / `观看日期（由 lastWatchTime …）` */
export function extractNlFieldLabels(nl: string): NlFieldLabel[] {
  const text = String(nl || "");
  const out: NlFieldLabel[] = [];
  const seen = new Set<string>();
  const add = (code: string, label: string) => {
    const key = `${normalizeCode(code)}::${label}`;
    if (!label || seen.has(key)) return;
    seen.add(key);
    out.push({ code, label });
  };

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
    if (/lastWatchTime|watchDate|观看日期/i.test(inner)) {
      add("watchDate", label);
      continue;
    }
    if (/^channel$/i.test(inner) || /渠道/.test(inner)) {
      add("channel", label);
      continue;
    }
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(inner)) {
      add(inner, label);
    }
  }

  if (/观看日期|watchDate/i.test(text) && !out.some((h) => normalizeCode(h.code) === "watchdate")) {
    add("watchDate", "观看日期");
  }
  if (/(?:^|[^A-Za-z])channel(?:[^A-Za-z]|$)/i.test(text) || /渠道/.test(text)) {
    if (!out.some((h) => normalizeCode(h.code) === "channel")) add("channel", "渠道");
  }
  return out;
}

function colMatchKey(col: string): string {
  return normalizeCode(col);
}

/**
 * Map SQL aliases to user-mentioned labels. Unmentioned cols keep the alias.
 */
export function relabelAnalyticsCols(nl: string, cols: string[]): string[] {
  const hits = extractNlFieldLabels(nl);
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
): Array<T & { colTitles: string[] }> {
  return (tables || []).map((t) => ({
    ...t,
    colTitles: relabelAnalyticsCols(nl, t.cols || []),
  }));
}
