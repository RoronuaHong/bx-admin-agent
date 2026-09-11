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

/** 是否含可解析的显式日历/相对时间信号（不含裸「最近」） */
export function hasTimeSignal(nl: string): boolean {
  if (/\d{4}-\d{2}-\d{2}/.test(nl)) return true;
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
  if (/最近/.test(nl) && !new RegExp(`最近\\s*(${NUM})\\s*天`).test(nl) && !/\d{1,2}\s*月/.test(nl) && !/\d{4}-\d{2}-\d{2}/.test(nl)) {
    return { ok: false, clarify: "「最近」无法定界，请给出具体起止日期（例如 8月19日到25日）或「最近7天」。" };
  }

  const iso = [...nl.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)].map((m) => m[0]!);
  if (iso.length >= 2) return okRange(iso[0]!, iso[1]!);
  if (iso.length === 1) return okRange(iso[0]!, iso[0]!);

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
