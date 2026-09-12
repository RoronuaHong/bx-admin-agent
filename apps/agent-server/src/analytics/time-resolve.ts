/**
 * 确定性时间解析：模型只理解相对说法，代码用 clock+tz 算出 YYYY-MM-DD。
 */

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

const WEEKDAY_CN: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function ymd(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${day}`;
}

function clockYear(clock: Date, tz: string): number {
  return Number(ymd(clock, tz).slice(0, 4));
}

/** 业务日 00:00 对应的 UTC Date（用正午锚定避免 DST 边界） */
function dateFromYmd(iso: string, tz: string): Date {
  // 用 UTC 正午再按格式回读不可靠；改为构造「tz 日历日」的近似：ISO 本地解析
  const [ys, ms, ds] = iso.split("-").map(Number);
  // 迭代找 UTC 时刻使 tz 下日历日匹配
  let guess = Date.UTC(ys!, ms! - 1, ds!, 12, 0, 0);
  for (let i = 0; i < 3; i++) {
    const got = ymd(new Date(guess), tz);
    if (got === iso) return new Date(guess);
    const [gy, gm, gd] = got.split("-").map(Number);
    const want = Date.UTC(ys!, ms! - 1, ds!, 12);
    const have = Date.UTC(gy!, gm! - 1, gd!, 12);
    guess += want - have;
  }
  return new Date(guess);
}

function addDaysYmd(iso: string, tz: string, delta: number): string {
  const d = dateFromYmd(iso, tz);
  d.setUTCDate(d.getUTCDate() + delta);
  return ymd(d, tz);
}

function weekdayOfYmd(iso: string, tz: string): number {
  // 0=Sun..6=Sat via en-US short weekday in tz
  const d = dateFromYmd(iso, tz);
  const w = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[w] ?? 0;
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
      current = CN_DIGITS[ch]!;
    } else {
      return null;
    }
  }
  result += current;
  return result > 0 ? result : null;
}

const NUM = "[\\d一二三四五六七八九十两〇零]+";

function okRange(start: string, end: string): ResolveOk {
  return { ok: true, range: { start, end, echo: start === end ? `按 ${start}` : `按 ${start}～${end}` } };
}

function validMd(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function monthBounds(year: number, month: number, tz: string): ResolveOk | null {
  if (!validMd(month, 1)) return null;
  const start = `${year}-${pad(month)}-01`;
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
  return okRange(start, addDaysYmd(next, tz, -1));
}

function normalizeIsoSeps(nl: string): string {
  return nl.replace(/(\d{4})\/(\d{1,2})\/(\d{1,2})/g, (_, y, m, d) => `${y}-${pad(Number(m))}-${pad(Number(d))}`);
}

const REL_DAY: Record<string, number> = {
  今天: 0,
  今日: 0,
  昨天: -1,
  昨日: -1,
  前天: -2,
  明天: 1,
  明日: 1,
  后天: 2,
};

/** ISO 区间；支持「2026-08-19到25 / 到08-25 / 到8月25日」。单段 NL 内取最先两个完整 ISO。 */
function resolveIsoFamily(nl: string): ResolveOk | null {
  const all = [...normalizeIsoSeps(nl).matchAll(/(\d{4})-(\d{2})-(\d{2})/g)];
  if (all.length >= 2) return okRange(all[0]![0]!, all[1]![0]!);
  if (all.length !== 1) return null;
  const start = all[0]![0]!;
  const after = nl.slice((all[0]!.index || 0) + start.length);
  const md = after.match(/^\s*(?:到|至|-)\s*(\d{1,2})-(\d{1,2})(?:\s*(?:日|号))?/);
  if (md) {
    const m2 = Number(md[1]);
    const d2 = Number(md[2]);
    if (validMd(m2, d2)) return okRange(start, `${start.slice(0, 5)}${pad(m2)}-${pad(d2)}`);
  }
  const cn = after.match(new RegExp(`^\\s*(?:到|至|-)\\s*(${NUM})\\s*月\\s*(${NUM})\\s*(?:日|号)?`));
  if (cn) {
    const m2 = parseNumberToken(cn[1]!);
    const d2 = parseNumberToken(cn[2]!);
    if (m2 != null && d2 != null && validMd(m2, d2)) {
      return okRange(start, `${start.slice(0, 5)}${pad(m2)}-${pad(d2)}`);
    }
  }
  const dayOnly = after.match(/^\s*(?:到|至|-)\s*(\d{1,2})(?:\s*(?:日|号))?(?![\d-])/);
  if (dayOnly) {
    const d2 = Number(dayOnly[1]);
    const m1 = Number(start.slice(5, 7));
    if (validMd(m1, d2)) return okRange(start, `${start.slice(0, 8)}${pad(d2)}`);
  }
  return okRange(start, start);
}

/** 本轮是否在谈时间（不是词表穷举；有日历字就视为试图改时间）。 */
export function turnMentionsTime(nl: string): boolean {
  const t = String(nl || "");
  if (hasTimeSignal(t)) return true;
  return /[年月]|最近|旬|期间|区间/.test(t);
}

/**
 * Ask 时间：本轮解析出具体起止日才用。
 * 本轮在谈时间但解析失败 → 反问，不沿用上一问。
 * 本轮完全没谈时间（如「FoxA呢？」）→ 沿用 AskState。
 */
export function resolveAskTimeRange(input: {
  lastUserText: string;
  prevTime?: { start: string; end: string } | null;
  priorUserTexts?: string[];
  clock: Date;
  tz: string;
}): ResolveResult {
  const fromTurn = resolveTimeRange(input.lastUserText, input.clock, input.tz);
  if (fromTurn.ok) return fromTurn;
  if (turnMentionsTime(input.lastUserText)) return fromTurn;
  if (input.prevTime?.start && input.prevTime.end) {
    return okRange(input.prevTime.start, input.prevTime.end);
  }
  for (const prior of input.priorUserTexts || []) {
    const fromPrior = resolveTimeRange(prior, input.clock, input.tz);
    if (fromPrior.ok) return fromPrior;
  }
  return fromTurn;
}

/** 是否含可解析的显式日历/相对时间信号（不含裸「最近」） */
export function hasTimeSignal(nl: string): boolean {
  if (/\d{4}[/-]\d{1,2}[/-]\d{1,2}/.test(nl) || /\d{4}-\d{2}(?!-\d)/.test(nl)) return true;
  if (/\d{4}\s*年/.test(nl)) return true;
  if (/\d{1,2}\.\d{1,2}\s*(?:到|至|-)\s*\d{1,2}\.\d{1,2}/.test(nl)) return true;
  if (new RegExp(`${NUM}\\s*月\\s*${NUM}`).test(nl)) return true;
  if (/(今天|今日|昨天|昨日|前天|明天|明日|后天)/.test(nl)) return true;
  if (/(本周|这周|上周|下周|本月|上月|这个月|上个月)/.test(nl)) return true;
  if (/[上下本]?周[一二三四五六日天]/.test(nl)) return true;
  if (new RegExp(`(${NUM})\\s*天\\s*[前后内]`).test(nl)) return true;
  if (new RegExp(`最近\\s*(${NUM})\\s*天`).test(nl)) return true;
  if (/过去\s*\d+\s*天/.test(nl)) return true;
  return false;
}

export function resolveTimeRange(nl: string, clock: Date, tz: string): ResolveResult {
  const today = ymd(clock, tz);
  const year = clockYear(clock, tz);

  // 裸「最近」无法定界（有「最近N天」则走下面）
  if (
    /最近/.test(nl) &&
    !new RegExp(`最近\\s*(${NUM})\\s*天`).test(nl) &&
    !/\d{1,2}\s*月/.test(nl) &&
    !/\d{4}-\d{2}-\d{2}/.test(nl) &&
    !/\d{4}-\d{2}(?!-\d)/.test(nl)
  ) {
    return { ok: false, clarify: "「最近」无法定界，请给出具体起止日期（例如 8月19日到25日）或「最近7天」。" };
  }

  // 整周/整月后再接「初/中/底/旬」：不能取整段
  if (/(?:本月|这个月|上月|上个月|本周|这周|上周|下周)(?:初|中|底|旬)/.test(nl)) {
    return {
      ok: false,
      clarify: "这种时间无法定界，请给出具体起止日期（例如 8月19日到25日）。",
    };
  }

  // 两个整周/整月用「到/至」拼接：无法定界，禁止取其中一端
  if (/(上|本|这|下)[周月].{0,8}(?:到|至).{0,8}(上|本|这|下)[周月]/.test(nl)) {
    return {
      ok: false,
      clarify: "跨周/跨月的「到」无法定界，请给出具体起止日期（例如 8月19日到25日）。",
    };
  }

  const isoFamily = resolveIsoFamily(nl);
  if (isoFamily) return isoFamily;

  const monthOnly = nl.match(/(?:^|[^\d-])(\d{4})-(\d{2})(?!-\d)/);
  if (monthOnly) {
    const y = Number(monthOnly[1]);
    const m = Number(monthOnly[2]);
    const bounds = monthBounds(y, m, tz);
    if (bounds) return bounds;
  }

  // 最近N天 / 过去N天（含今天往前 N 天，共 N 天）
  const recent = nl.match(new RegExp(`(?:最近|过去)\\s*(${NUM})\\s*天`));
  if (recent) {
    const n = parseNumberToken(recent[1]!);
    if (n == null || n < 1 || n > 366) {
      return { ok: false, clarify: "请提供分析的日期范围（例如 最近7天）。" };
    }
    const start = addDaysYmd(today, tz, -(n - 1));
    return okRange(start, today);
  }

  // N天前 / N天后（单日）
  const ago = nl.match(new RegExp(`(${NUM})\\s*天\\s*前`));
  if (ago) {
    const n = parseNumberToken(ago[1]!);
    if (n != null) {
      const d = addDaysYmd(today, tz, -n);
      return okRange(d, d);
    }
  }
  const later = nl.match(new RegExp(`(${NUM})\\s*天\\s*后`));
  if (later) {
    const n = parseNumberToken(later[1]!);
    if (n != null) {
      const d = addDaysYmd(today, tz, n);
      return okRange(d, d);
    }
  }
  // N天内 → [today-(n-1), today]
  const within = nl.match(new RegExp(`(${NUM})\\s*天\\s*内`));
  if (within) {
    const n = parseNumberToken(within[1]!);
    if (n != null && n >= 1) {
      return okRange(addDaysYmd(today, tz, -(n - 1)), today);
    }
  }

  const relRange = nl.match(
    /(今天|今日|昨天|昨日|前天|明天|明日|后天)\s*(?:到|至|-)\s*(今天|今日|昨天|昨日|前天|明天|明日|后天)/,
  );
  if (relRange) {
    const a = REL_DAY[relRange[1]!]!;
    const b = REL_DAY[relRange[2]!]!;
    let start = addDaysYmd(today, tz, a);
    let end = addDaysYmd(today, tz, b);
    if (start > end) {
      const tmp = start;
      start = end;
      end = tmp;
    }
    return okRange(start, end);
  }

  const dotted = nl.match(/(\d{1,2})\.(\d{1,2})\s*(?:到|至|-)\s*(\d{1,2})\.(\d{1,2})/);
  if (dotted) {
    const m1 = Number(dotted[1]);
    const d1 = Number(dotted[2]);
    const m2 = Number(dotted[3]);
    const d2 = Number(dotted[4]);
    if (validMd(m1, d1) && validMd(m2, d2)) {
      return okRange(`${year}-${pad(m1)}-${pad(d1)}`, `${year}-${pad(m2)}-${pad(d2)}`);
    }
  }

  if (/(今天|今日)/.test(nl)) return okRange(today, today);
  if (/(昨天|昨日)/.test(nl)) {
    const d = addDaysYmd(today, tz, -1);
    return okRange(d, d);
  }
  if (/前天/.test(nl)) {
    const d = addDaysYmd(today, tz, -2);
    return okRange(d, d);
  }
  if (/(明天|明日)/.test(nl)) {
    const d = addDaysYmd(today, tz, 1);
    return okRange(d, d);
  }
  if (/后天/.test(nl)) {
    const d = addDaysYmd(today, tz, 2);
    return okRange(d, d);
  }

  // 上/本/下周X
  const wd = nl.match(/([上下本])周([一二三四五六日天])/);
  if (wd) {
    const which = wd[1]!;
    const target = WEEKDAY_CN[wd[2]!]!;
    const todayW = weekdayOfYmd(today, tz);
    // 本周：回到本周目标日；上周/下周：±7
    let delta = target - todayW;
    if (which === "上") delta -= 7;
    else if (which === "下") delta += 7;
    // 「本周」若目标日已过仍指向本周该日（可早于今天）
    const d = addDaysYmd(today, tz, delta);
    return okRange(d, d);
  }

  // 本周 / 上周 / 下周（整周 周一到周日）
  if (/本周|这周/.test(nl) && !/下周|上周/.test(nl)) {
    const todayW = weekdayOfYmd(today, tz);
    const mondayOffset = todayW === 0 ? -6 : 1 - todayW;
    const start = addDaysYmd(today, tz, mondayOffset);
    const end = addDaysYmd(start, tz, 6);
    return okRange(start, end);
  }
  if (/上周/.test(nl) && !/上周[一二三四五六日天]/.test(nl)) {
    const todayW = weekdayOfYmd(today, tz);
    const mondayOffset = todayW === 0 ? -6 : 1 - todayW;
    const thisMon = addDaysYmd(today, tz, mondayOffset);
    const start = addDaysYmd(thisMon, tz, -7);
    const end = addDaysYmd(start, tz, 6);
    return okRange(start, end);
  }
  if (/下周/.test(nl) && !/下周[一二三四五六日天]/.test(nl)) {
    const todayW = weekdayOfYmd(today, tz);
    const mondayOffset = todayW === 0 ? -6 : 1 - todayW;
    const thisMon = addDaysYmd(today, tz, mondayOffset);
    const start = addDaysYmd(thisMon, tz, 7);
    const end = addDaysYmd(start, tz, 6);
    return okRange(start, end);
  }

  // 本月 / 上月
  if (/本月|这个月/.test(nl)) {
    const [y, m] = today.split("-").map(Number);
    const start = `${y}-${pad(m!)}-01`;
    const nextMonth = m === 12 ? `${y! + 1}-01-01` : `${y}-${pad(m! + 1)}-01`;
    const end = addDaysYmd(nextMonth, tz, -1);
    return okRange(start, end);
  }
  if (/上月|上个月/.test(nl)) {
    const [y, m] = today.split("-").map(Number);
    const py = m === 1 ? y! - 1 : y!;
    const pm = m === 1 ? 12 : m! - 1;
    const start = `${py}-${pad(pm)}-01`;
    const thisMonthStart = `${y}-${pad(m!)}-01`;
    const end = addDaysYmd(thisMonthStart, tz, -1);
    return okRange(start, end);
  }

  const rangeMatch = nl.match(
    new RegExp(
      `(${NUM})\\s*月\\s*(${NUM})\\s*(?:日|号)?\\s*(?:到|至|-)\\s*(?:(${NUM})\\s*月\\s*)?(${NUM})\\s*(?:日|号)?`,
    ),
  );
  if (rangeMatch) {
    const m1 = parseNumberToken(rangeMatch[1]!);
    const d1 = parseNumberToken(rangeMatch[2]!);
    const m2 = rangeMatch[3] ? parseNumberToken(rangeMatch[3]!) : m1;
    const d2 = parseNumberToken(rangeMatch[4]!);
    if (m1 == null || d1 == null || m2 == null || d2 == null) {
      return { ok: false, clarify: "请提供分析的日期范围（例如 2026-08-19 到 2026-08-25）。" };
    }
    const start = `${year}-${pad(m1)}-${pad(d1)}`;
    const end = `${year}-${pad(m2)}-${pad(d2)}`;
    return okRange(start, end);
  }

  const singleMatch = nl.match(new RegExp(`(${NUM})\\s*月\\s*(${NUM})\\s*(?:日|号)?`));
  if (singleMatch) {
    const m1 = parseNumberToken(singleMatch[1]!);
    const d1 = parseNumberToken(singleMatch[2]!);
    if (m1 == null || d1 == null) {
      return { ok: false, clarify: "请提供分析的日期范围（例如 2026-08-19 到 2026-08-25）。" };
    }
    const start = `${year}-${pad(m1)}-${pad(d1)}`;
    return okRange(start, start);
  }

  const yearMonth = nl.match(
    new RegExp(`(\\d{4})\\s*年\\s*(${NUM})\\s*月(?!\\s*(?:${NUM}))`),
  );
  if (yearMonth) {
    const y = Number(yearMonth[1]);
    const m = parseNumberToken(yearMonth[2]!);
    if (m != null) {
      const bounds = monthBounds(y, m, tz);
      if (bounds) return bounds;
    }
  }

  return { ok: false, clarify: "请提供分析的日期范围（例如 2026-08-19 到 2026-08-25）。" };
}

/** 代码时间优先：有确定性解析时覆盖模型 time */
export function applyResolvedTime<T extends { time?: { start: string; end: string } }>(
  result: T,
  resolved: ResolveResult,
): T {
  if (!resolved.ok) return result;
  return {
    ...result,
    time: { start: resolved.range.start, end: resolved.range.end },
  };
}
