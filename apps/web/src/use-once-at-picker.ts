import { computed, nextTick, reactive, ref } from "vue";
import { pad2, type ScheduleTx } from "./schedule-cron";

/**
 * 一次性任务的日期时间面板。
 * 值仍是 "YYYY-MM-DDTHH:mm"。页面只提供读写，面板自己管开关和定位。
 */
export function useOnceAtPicker(opts: {
  scheduledAt: () => string;
  setScheduledAt: (value: string) => void;
  tx: ScheduleTx;
}) {
  const dtOpen = ref(false);
  const dtRoot = ref<HTMLElement | null>(null);
  const dtPanel = ref<HTMLElement | null>(null);
  const dtPos = reactive({ top: 0, left: 0 });
  const dtView = reactive({ y: new Date().getFullYear(), m: new Date().getMonth() });
  const dtTemp = reactive({ date: "", time: "09:00" });

  const dtDisplay = computed(() => (opts.scheduledAt() ? opts.scheduledAt().replace("T", " ") : ""));

  function updateDtPos() {
    const el = dtRoot.value;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const panelH = dtPanel.value?.offsetHeight ?? 340;
    const below = window.innerHeight - r.bottom;
    const top = below >= panelH + 8 || below >= r.top ? r.bottom + 6 : Math.max(8, r.top - panelH - 6);
    dtPos.top = Math.round(top);
    dtPos.left = Math.round(Math.min(Math.max(8, r.left), window.innerWidth - 272));
  }

  function openDtPicker() {
    const current = opts.scheduledAt();
    if (current) {
      const [d, t] = current.split("T");
      dtTemp.date = d;
      dtTemp.time = t || "09:00";
      dtView.y = +d.slice(0, 4);
      dtView.m = +d.slice(5, 7) - 1;
    } else {
      const n = new Date();
      dtView.y = n.getFullYear();
      dtView.m = n.getMonth();
      dtTemp.date = "";
      dtTemp.time = "09:00";
    }
    dtOpen.value = true;
    void nextTick(updateDtPos);
  }

  function syncDtPos() {
    if (dtOpen.value) updateDtPos();
  }

  function commitDt() {
    opts.setScheduledAt(dtTemp.date ? `${dtTemp.date}T${dtTemp.time}` : "");
  }

  function pickDay(day: number) {
    dtTemp.date = `${dtView.y}-${pad2(dtView.m + 1)}-${pad2(day)}`;
    commitDt();
  }

  function shiftMonth(delta: number) {
    const t = new Date(dtView.y, dtView.m + delta, 1);
    dtView.y = t.getFullYear();
    dtView.m = t.getMonth();
  }

  function setDtTo(base: Date, time?: string) {
    dtView.y = base.getFullYear();
    dtView.m = base.getMonth();
    dtTemp.date = `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(base.getDate())}`;
    dtTemp.time = time ?? `${pad2(base.getHours())}:${pad2(base.getMinutes())}`;
    commitDt();
  }

  const DT_SHORTCUTS: Array<{ zh: string; en: string; pt: string; hi: string; fn: () => void }> = [
    { zh: "此刻", en: "Now", pt: "Agora", hi: "अभी", fn: () => setDtTo(new Date()) },
    { zh: "1 小时后", en: "In 1 hour", pt: "Em 1 hora", hi: "1 घंटे बाद", fn: () => setDtTo(new Date(Date.now() + 3600e3)) },
    {
      zh: "明天 09:00",
      en: "Tomorrow 9:00",
      pt: "Amanhã 9:00",
      hi: "कल सुबह 9:00",
      fn: () => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0);
        setDtTo(d);
      },
    },
  ];

  const DT_WEEKDAYS: Array<{ zh: string; en: string; pt: string; hi: string }> = [
    { zh: "一", en: "Mo", pt: "Seg", hi: "सोम" },
    { zh: "二", en: "Tu", pt: "Ter", hi: "मंगल" },
    { zh: "三", en: "We", pt: "Qua", hi: "बुध" },
    { zh: "四", en: "Th", pt: "Qui", hi: "गुरु" },
    { zh: "五", en: "Fr", pt: "Sex", hi: "शुक्र" },
    { zh: "六", en: "Sa", pt: "Sáb", hi: "शनि" },
    { zh: "日", en: "Su", pt: "Dom", hi: "रवि" },
  ];

  const dtMonthLabel = computed(() => {
    const enNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const ptNames = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
    const hiNames = ["जनवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्तूबर", "नवंबर", "दिसंबर"];
    return opts.tx(
      `${dtView.y}年${dtView.m + 1}月`,
      `${enNames[dtView.m]} ${dtView.y}`,
      `${ptNames[dtView.m]} de ${dtView.y}`,
      `${hiNames[dtView.m]} ${dtView.y}`,
    );
  });

  const dtCells = computed<(number | null)[]>(() => {
    const first = new Date(dtView.y, dtView.m, 1);
    const offset = (first.getDay() + 6) % 7;
    const days = new Date(dtView.y, dtView.m + 1, 0).getDate();
    const cells: (number | null)[] = [];
    for (let i = 0; i < offset; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(d);
    return cells;
  });

  function dtDateStr(day: number): string {
    return `${dtView.y}-${pad2(dtView.m + 1)}-${pad2(day)}`;
  }

  function isDtToday(day: number): boolean {
    const n = new Date();
    return dtDateStr(day) === `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`;
  }

  function isDtPicked(day: number): boolean {
    return dtTemp.date === dtDateStr(day);
  }

  const DT_HOURS = Array.from({ length: 24 }, (_, i) => pad2(i));
  const DT_MINUTES = Array.from({ length: 60 }, (_, i) => pad2(i));

  const dtHour = computed({
    get: () => dtTemp.time.slice(0, 2),
    set: (v: string) => {
      dtTemp.time = `${v}:${dtTemp.time.slice(3)}`;
      commitDt();
    },
  });
  const dtMinute = computed({
    get: () => dtTemp.time.slice(3),
    set: (v: string) => {
      dtTemp.time = `${dtTemp.time.slice(0, 3)}${v}`;
      commitDt();
    },
  });

  function makeDtTimePart(max: number, get: () => string, set: (v: string) => void) {
    let editing: string | null = null;
    return {
      onInput(e: Event) {
        const el = e.target as HTMLInputElement;
        editing = el.value;
        const n = parseInt(el.value, 10);
        if (/^\d{2}$/.test(el.value) && n >= 0 && n <= max) {
          set(pad2(n));
          editing = null;
        }
      },
      onChange(e: Event) {
        const el = e.target as HTMLInputElement;
        const n = parseInt(editing ?? el.value, 10);
        editing = null;
        const v = Number.isFinite(n) ? pad2(Math.min(max, Math.max(0, n))) : get();
        if (el.value !== v) el.value = v;
        set(v);
      },
    };
  }

  const dtHourPart = makeDtTimePart(23, () => dtHour.value, (v) => (dtHour.value = v));
  const dtMinutePart = makeDtTimePart(59, () => dtMinute.value, (v) => (dtMinute.value = v));

  function onOutsideDt(e: MouseEvent) {
    if (!dtOpen.value) return;
    const t = e.target;
    if (!(t instanceof Node)) return;
    const inTrigger = dtRoot.value?.contains(t) ?? false;
    const inPanel = dtPanel.value?.contains(t) ?? false;
    if (!inTrigger && !inPanel) dtOpen.value = false;
  }

  return {
    dtOpen,
    dtRoot,
    dtPanel,
    dtPos,
    dtDisplay,
    openDtPicker,
    syncDtPos,
    pickDay,
    shiftMonth,
    DT_SHORTCUTS,
    DT_WEEKDAYS,
    dtMonthLabel,
    dtCells,
    isDtToday,
    isDtPicked,
    DT_HOURS,
    DT_MINUTES,
    dtHour,
    dtMinute,
    dtHourPart,
    dtMinutePart,
    onOutsideDt,
  };
}
