export type ResolveOk = { ok: true; range: { start: string; end: string; echo: string } };
export type ResolveClarify = { ok: false; clarify: string };
export type ResolveResult = ResolveOk | ResolveClarify;

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function parseNumberToken(token: string): number | null {
  const s = token.trim();
  if (/^\d+$/.test(s)) return Number(s);

  if (s === "十") return 10;

  let result = 0;
  let current = 0;
  for (const ch of s) {
    if (ch === "十") {
      if (current === 0) current = 1;
      result += current * 10;
      current = 0;
    } else if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch];
    } else {
      return null;
    }
  }
  result += current;
  return result > 0 ? result : null;
}

function clockYear(clock: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric" }).formatToParts(clock);
  const year = parts.find((p) => p.type === "year")?.value;
  return Number(year ?? clock.getFullYear());
}

const NUM = "[\\d一二三四五六七八九十两〇零]+";

export function resolveTimeRange(nl: string, clock: Date, tz: string): ResolveResult {
  if (/最近/.test(nl) && !/\d{1,2}\s*月/.test(nl) && !/\d{4}-\d{2}-\d{2}/.test(nl)) {
    return { ok: false, clarify: "「最近」无法定界，请给出具体起止日期（例如 8月19日到25日）。" };
  }

  const year = clockYear(clock, tz);
  const iso = [...nl.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)].map((m) => m[0]);
  if (iso.length >= 2) {
    return { ok: true, range: { start: iso[0], end: iso[1], echo: `按 ${iso[0]}～${iso[1]}` } };
  }
  if (iso.length === 1) {
    return { ok: true, range: { start: iso[0], end: iso[0], echo: `按 ${iso[0]}` } };
  }

  const rangeMatch = nl.match(
    new RegExp(
      `(${NUM})\\s*月\\s*(${NUM})\\s*(?:日|号)?\\s*(?:到|至|-)\\s*(?:(${NUM})\\s*月\\s*)?(${NUM})\\s*(?:日|号)?`,
    ),
  );
  if (rangeMatch) {
    const m1 = parseNumberToken(rangeMatch[1]);
    const d1 = parseNumberToken(rangeMatch[2]);
    const m2 = rangeMatch[3] ? parseNumberToken(rangeMatch[3]) : m1;
    const d2 = parseNumberToken(rangeMatch[4]);
    if (m1 == null || d1 == null || m2 == null || d2 == null) {
      return { ok: false, clarify: "请提供分析的日期范围（例如 2026-08-19 到 2026-08-25）。" };
    }
    const start = `${year}-${pad(m1)}-${pad(d1)}`;
    const end = `${year}-${pad(m2)}-${pad(d2)}`;
    return { ok: true, range: { start, end, echo: `按 ${start}～${end}` } };
  }

  const singleMatch = nl.match(new RegExp(`(${NUM})\\s*月\\s*(${NUM})\\s*(?:日|号)?`));
  if (singleMatch) {
    const m1 = parseNumberToken(singleMatch[1]);
    const d1 = parseNumberToken(singleMatch[2]);
    if (m1 == null || d1 == null) {
      return { ok: false, clarify: "请提供分析的日期范围（例如 2026-08-19 到 2026-08-25）。" };
    }
    const start = `${year}-${pad(m1)}-${pad(d1)}`;
    return { ok: true, range: { start, end: start, echo: `按 ${start}` } };
  }

  return { ok: false, clarify: "请提供分析的日期范围（例如 2026-08-19 到 2026-08-25）。" };
}
