/** 定时任务表单能精确表达的 cron。复杂表达式返回 null，由界面只读展示，保存时不覆盖。 */

export type RepeatFreq = "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";

export interface RepeatForm {
  freq: RepeatFreq;
  interval: number;
  byday: string[];
  time: string;
}

export type ScheduleTx = (zh: string, en: string, pt: string, hi: string) => string;

/** 预警分钟级间隔只开放整除 60 且 ≥5 的档位（单期 Agent 常要数十秒，不开放 1 分钟）。 */
export const MINUTELY_INTERVALS = [5, 10, 15, 30] as const;

export const REPEAT_FREQS: Array<{
  code: RepeatFreq;
  zh: string;
  en: string;
  pt: string;
  hi: string;
  unitZh: string;
  unitEn: string;
  unitPt: string;
  unitHi: string;
}> = [
  { code: "MINUTELY", zh: "每分钟", en: "Minutely", pt: "Por minuto", hi: "प्रति मिनट", unitZh: "分钟", unitEn: "minute(s)", unitPt: "minuto(s)", unitHi: "मिनट" },
  { code: "HOURLY", zh: "每小时", en: "Hourly", pt: "A cada hora", hi: "हर घंटे", unitZh: "小时", unitEn: "hour(s)", unitPt: "hora(s)", unitHi: "घंटे" },
  { code: "DAILY", zh: "每天", en: "Daily", pt: "Diariamente", hi: "हर दिन", unitZh: "天", unitEn: "day(s)", unitPt: "dia(s)", unitHi: "दिन" },
  { code: "WEEKLY", zh: "每周", en: "Weekly", pt: "Semanalmente", hi: "हर सप्ताह", unitZh: "周", unitEn: "week(s)", unitPt: "semana(s)", unitHi: "सप्ताह" },
  { code: "MONTHLY", zh: "每月", en: "Monthly", pt: "Mensalmente", hi: "हर महीने", unitZh: "个月", unitEn: "month(s)", unitPt: "mês(es)", unitHi: "महीने" },
];

export const WEEKDAYS: Array<{ code: string; zh: string; en: string; pt: string; hi: string }> = [
  { code: "MO", zh: "周一", en: "Mon", pt: "Seg", hi: "सोम" },
  { code: "TU", zh: "周二", en: "Tue", pt: "Ter", hi: "मंगल" },
  { code: "WE", zh: "周三", en: "Wed", pt: "Qua", hi: "बुध" },
  { code: "TH", zh: "周四", en: "Thu", pt: "Qui", hi: "गुरु" },
  { code: "FR", zh: "周五", en: "Fri", pt: "Sex", hi: "शुक्र" },
  { code: "SA", zh: "周六", en: "Sat", pt: "Sáb", hi: "शनि" },
  { code: "SU", zh: "周日", en: "Sun", pt: "Dom", hi: "रवि" },
];

/** cron 星期字段是数字（0 = 周日）。 */
const DOW: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 格式化成 datetime-local 需要的本地时间字符串（编辑一次性任务时回填）。 */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 卡片上的紧凑时间：侧栏宽度只够「9/21 16:00」这一档。
 * 非本年才带上年份。
 */
export function formatShortTime(ms: number): string {
  const d = new Date(ms);
  const date = `${d.getMonth() + 1}/${d.getDate()}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear() ? `${date} ${time}` : `${d.getFullYear()}/${date} ${time}`;
}

/**
 * 5 段 cron → 友好选项（buildCron 的逆运算，编辑时回填用）。
 * 只认本界面能产出的形态；其余返回 null，调用方只读展示原表达式。
 */
export function parseCron(expr?: string): RepeatForm | null {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  const isNum = (s: string) => /^\d{1,2}$/.test(s);
  const step = (s: string): number => (s === "*" ? 1 : /^\*\/(\d{1,2})$/.test(s) ? Number(s.slice(2)) : 0);
  const hhmm = (): string | null =>
    isNum(hour) && isNum(min) ? `${hour.padStart(2, "0")}:${min.padStart(2, "0")}` : null;
  const minutelyStep = step(min);
  if (minutelyStep >= 1 && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { freq: "MINUTELY", interval: minutelyStep, time: "09:00", byday: ["MO"] };
  }
  const hourlyStep = step(hour);
  if (min === "0" && hourlyStep >= 1 && dom === "*" && mon === "*" && dow === "*") {
    return { freq: "HOURLY", interval: hourlyStep, time: "09:00", byday: ["MO"] };
  }
  const time = hhmm();
  if (!time) return null;
  const dayStep = step(dom);
  if (dayStep >= 1 && mon === "*" && dow === "*") {
    return { freq: "DAILY", interval: dayStep, time, byday: ["MO"] };
  }
  if (dom === "*" && mon === "*" && dow !== "*") {
    const codes = dow.split(",");
    const names = codes.map((code) => Object.keys(DOW).find((k) => DOW[k] === Number(code)));
    if (codes.every(isNum) && names.every(Boolean) && names.length) {
      return { freq: "WEEKLY", interval: 1, time, byday: names as string[] };
    }
  }
  const monthStep = step(mon);
  if (dom === "1" && monthStep >= 1 && dow === "*") {
    return { freq: "MONTHLY", interval: monthStep, time, byday: ["MO"] };
  }
  return null;
}

/**
 * 友好选项 → 服务端 5 段 cron（分 时 日 月 周）。
 * 表达不了的情况返回 error 文案，不用近似值。
 */
export function buildCron(form: RepeatForm, tx: ScheduleTx): { cron?: string; error?: string } {
  const interval = Math.min(99, Math.max(1, Math.floor(form.interval || 1)));
  const [h, m] = form.time.split(":").map((x) => parseInt(x, 10));
  const hour = Number.isNaN(h) ? 9 : h;
  const minute = Number.isNaN(m) ? 0 : m;
  if (form.freq === "MINUTELY") {
    const allowed = MINUTELY_INTERVALS as readonly number[];
    const n = allowed.includes(interval) ? interval : 10;
    return { cron: `*/${n} * * * *` };
  }
  if (form.freq === "HOURLY") {
    return { cron: interval === 1 ? "0 * * * *" : `0 */${interval} * * *` };
  }
  if (form.freq === "DAILY") {
    return { cron: `${minute} ${hour} */${interval} * *` };
  }
  if (form.freq === "WEEKLY") {
    if (interval > 1) {
      return {
        error: tx(
          "每周重复暂只支持间隔 1 周（cron 无法精确表达「每 N 周」）",
          "Weekly repeats support interval 1 only (cron cannot express every N weeks)",
          "Repetição semanal aceita apenas intervalo 1",
          "साप्ताहिक दोहराव में अंतराल 1 ही समर्थित है",
        ),
      };
    }
    const days = WEEKDAYS.filter((w) => form.byday.includes(w.code))
      .map((w) => DOW[w.code])
      .join(",");
    if (!days) {
      return {
        error: tx(
          "每周重复请至少选择一天",
          "Pick at least one weekday",
          "Selecione ao menos um dia da semana",
          "कृपया सप्ताह का कम से कम एक दिन चुनें",
        ),
      };
    }
    return { cron: `${minute} ${hour} * * ${days}` };
  }
  return { cron: `${minute} ${hour} 1 */${interval} *` };
}
