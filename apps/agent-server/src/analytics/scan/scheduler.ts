/**
 * In-process daily scan enqueue. Not a system cron.
 * Fire once per business calendar day after ANALYTICS_SCAN_CRON_HHMM.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";
import { enqueueScan } from "./runner.js";

const DEFAULT_HHMM = "10:00";
const STATE_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.data/analytics-scan/cron-fired.json",
);

export function parseScanCronHhmm(raw?: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || DEFAULT_HHMM).trim());
  const hour = m ? Number(m[1]) : 10;
  const minute = m ? Number(m[2]) : 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return { hour: 10, minute: 0 };
  }
  return { hour, minute };
}

export function clockPartsInTz(clock: Date, tz: string): { ymd: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(clock);
  const pick = (t: string) => parts.find((p) => p.type === t)?.value || "0";
  return {
    ymd: `${pick("year")}-${pick("month")}-${pick("day")}`,
    hour: Number(pick("hour")),
    minute: Number(pick("minute")),
  };
}

export function shouldFireDailyScan(input: {
  clock: Date;
  tz: string;
  hhmm?: string;
  lastFiredYmd?: string;
}): { fire: boolean; fireKey: string } {
  const { hour, minute } = parseScanCronHhmm(input.hhmm);
  const now = clockPartsInTz(input.clock, input.tz);
  const reached = now.hour > hour || (now.hour === hour && now.minute >= minute);
  const fire = reached && input.lastFiredYmd !== now.ymd;
  return { fire, fireKey: now.ymd };
}

function readLastFiredYmd(): string {
  try {
    if (!existsSync(STATE_FILE)) return "";
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { ymd?: string };
    return String(raw.ymd || "").trim();
  } catch {
    return "";
  }
}

function writeLastFiredYmd(ymd: string): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ ymd, at: Date.now() }), "utf8");
  } catch {
    /* best-effort */
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
let lastFiredYmd = "";

export function resetScanSchedulerForTests(): void {
  lastFiredYmd = "";
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

export async function tickScanCron(opts?: {
  clock?: Date;
  tz?: string;
  hhmm?: string;
  enqueue?: typeof enqueueScan;
  lastFiredYmd?: string;
  persist?: boolean;
}): Promise<{ fired: boolean; jobId?: string; fireKey?: string }> {
  const tz = opts?.tz || config.metabase.businessTimezone;
  const hhmm = opts?.hhmm || config.scan.cronHhmm;
  const clock = opts?.clock || new Date();
  const persist = opts?.persist !== false;
  if (opts?.lastFiredYmd !== undefined) {
    lastFiredYmd = opts.lastFiredYmd;
  } else if (!lastFiredYmd) {
    lastFiredYmd = readLastFiredYmd();
  }
  const gate = shouldFireDailyScan({ clock, tz, hhmm, lastFiredYmd });
  if (!gate.fire) return { fired: false, fireKey: gate.fireKey };
  lastFiredYmd = gate.fireKey;
  if (persist) writeLastFiredYmd(gate.fireKey);
  const enqueue = opts?.enqueue || enqueueScan;
  const result = await enqueue({
    ruleSetId: "watch-users",
    digest: true,
    clock,
  });
  if ("jobId" in result) return { fired: true, jobId: result.jobId, fireKey: gate.fireKey };
  return { fired: false, fireKey: gate.fireKey };
}

export function startScanScheduler(): () => void {
  if (!config.scan.workerEnabled || !config.scan.cronEnabled) {
    return () => {};
  }
  if (timer) return () => {};
  const tick = () => {
    void tickScanCron().catch((err) => {
      console.warn("[analytics-scan-cron]", err instanceof Error ? err.message : err);
    });
  };
  tick();
  timer = setInterval(tick, 60_000);
  timer.unref?.();
  console.log(`[analytics-scan-cron] daily ${config.scan.cronHhmm} ${config.metabase.businessTimezone}`);
  return () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
}
