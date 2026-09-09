import type { ResolveScanWindowOpts, ScanWindow } from "./types.js";

/**
 * Format a Date as YYYY-MM-DD in the given IANA timezone via Intl.
 * V1 note: Asia/Shanghai is UTC+8 year-round (no DST); Intl still preferred
 * so other fixed-offset business zones work the same way.
 */
function formatYmdInTz(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Shift a calendar YYYY-MM-DD by `deltaDays` (UTC noon anchor avoids DST edge cases). */
function addCalendarDays(ymd: string, deltaDays: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) {
    throw new Error(`invalid calendar date: ${ymd}`);
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const utc = new Date(Date.UTC(y, mo - 1, d + deltaDays, 12, 0, 0));
  const yy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utc.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Resolve T-1 / T-2 (dod) / T-8 (wow) closed business days in `tz`.
 * Default `scanDate` is yesterday in `tz` (not server local timezone).
 */
export function resolveScanWindow(opts: ResolveScanWindowOpts): ScanWindow {
  const { clock, tz } = opts;
  const explicit = opts.scanDate?.trim();
  const scanDate = explicit || addCalendarDays(formatYmdInTz(clock, tz), -1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scanDate)) {
    throw new Error(`invalid scanDate: ${scanDate}`);
  }
  const dodDate = addCalendarDays(scanDate, -1);
  const wowDate = addCalendarDays(scanDate, -7);
  const echo = `巡检日 ${scanDate}（DoD ${dodDate} / WoW ${wowDate}，时区 ${tz}）`;
  return { scanDate, dodDate, wowDate, echo };
}
