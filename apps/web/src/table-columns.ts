import type { TableColumnView, TableView } from "./types";

const DATE_KEY_RE =
  /(?:^|_)(date|day|dt|ymd|time|at)(?:$|_)/i;
/** camelCase / PascalCase endings: lastWatchTime, createTime, createdAt, updateDate */
const DATE_KEY_CAMEL_RE = /(?:Time|Date|At|Day|Ymd)$/;
const DATE_VAL_RE =
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T].*)?$/;
const UNIX_TS_RE = /^\d{10,13}$/;
const ID_KEY_RE = /(?:^|_)(id|guid|uuid)(?:$|_)/i;
const MONEY_KEY_RE = /(?:money|amount|revenue|cost|price|fee|gmv|arpu)/i;
const NUMBER_KEY_RE =
  /^(?:n|cnt|count|users|uv|pv|sample|delta|ratio|rate|avg|sum|total|num|viewers|watch_sec|watchsecond|seconds)$|(?:_count|_num|_users|_uv|_pv|_sample|_sec)$/i;
/** Duration/metric fields that contain "time/second" but are not calendar timestamps */
const NOT_DATE_KEY_RE = /(?:second|seconds|duration|elapsed|latency|ttl|timeout|watchsec)/i;

const DEFAULT_TZ = "Asia/Shanghai";

function looksNumeric(v: string): boolean {
  const s = v.trim();
  if (!s) return true;
  return /^-?\d+(?:[.,]\d+)?%?$/.test(s);
}

function keyLooksLikeDate(key: string, title: string): boolean {
  const label = `${key} ${title}`.trim();
  if (NOT_DATE_KEY_RE.test(key) || NOT_DATE_KEY_RE.test(title)) return false;
  if (DATE_KEY_RE.test(key) || DATE_KEY_RE.test(title)) return true;
  if (DATE_KEY_CAMEL_RE.test(key) || DATE_KEY_CAMEL_RE.test(title)) return true;
  if (/^d$/i.test(key) || /^day$/i.test(title)) return true;
  return false;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format instant in business TZ → `YYYY-MM-DD` or `YYYY-MM-DD HH:mm` / `HH:mm:ss`. */
export function formatMsInTz(ms: number, timeZone = DEFAULT_TZ): string {
  if (!Number.isFinite(ms)) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value || "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");
  if ((hour === "00" || hour === "24") && minute === "00" && (second === "00" || !second)) {
    return date;
  }
  if (second && second !== "00") return `${date} ${hour}:${minute}:${second}`;
  return `${date} ${hour}:${minute}`;
}

/**
 * Convert raw table cell time values for display:
 * - unix s/ms → Asia/Shanghai
 * - ISO / `YYYY-MM-DDTHH:mm:ssZ` → Asia/Shanghai (midnight UTC calendar dates stay date-only)
 * - already `YYYY-MM-DD` / `YYYY-MM-DD HH:mm` → keep (normalize separators)
 */
export function formatDisplayDate(raw: string, timeZone = DEFAULT_TZ): string {
  const s = String(raw ?? "").trim();
  if (!s || s === "--") return s;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s)) {
    const [y, m, d] = s.split("/");
    return `${y}-${pad(Number(m))}-${pad(Number(d))}`;
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    return s.replace("T", " ").slice(0, 19);
  }

  if (UNIX_TS_RE.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return s;
    const ms = n < 1e12 ? n * 1000 : n;
    // Guard: small integers are not timestamps (e.g. movieType=10)
    if (ms < 1e11) return s;
    return formatMsInTz(ms, timeZone) || s;
  }

  // Calendar date at midnight (any offset) → keep the calendar day (ClickHouse/Metabase date)
  if (/^\d{4}-\d{2}-\d{2}T00:00:00(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) {
    return s.slice(0, 10);
  }

  const ms = Date.parse(s);
  if (Number.isFinite(ms)) {
    return formatMsInTz(ms, timeZone) || s;
  }
  return s;
}

export function looksLikeDateValue(v: string): boolean {
  const s = v.trim();
  if (!s) return false;
  if (DATE_VAL_RE.test(s)) return true;
  if (UNIX_TS_RE.test(s)) {
    const n = Number(s);
    const ms = n < 1e12 ? n * 1000 : n;
    return ms >= 1e12; // ms-scale timestamps only
  }
  return false;
}

export function inferTableColumnKind(
  key: string,
  title: string,
  samples: string[],
): NonNullable<TableColumnView["kind"]> {
  const label = `${key} ${title}`.trim();
  const nonEmpty = samples.map((s) => s.trim()).filter(Boolean).slice(0, 12);

  if (keyLooksLikeDate(key, title) || nonEmpty.some((s) => looksLikeDateValue(s))) {
    // Prefer number if key is clearly a duration metric despite "time" substring
    if (NOT_DATE_KEY_RE.test(key) || NOT_DATE_KEY_RE.test(title)) {
      /* fall through */
    } else {
      return "date";
    }
  }
  if (MONEY_KEY_RE.test(label)) return "money";
  if (NUMBER_KEY_RE.test(key) || NUMBER_KEY_RE.test(title)) return "number";
  if (ID_KEY_RE.test(key) && nonEmpty.every((s) => /^[\w.-]+$/.test(s))) return "id";
  if (nonEmpty.length >= 2 && nonEmpty.every(looksNumeric)) return "number";
  return "text";
}

/** Fill missing kind/align from key name + sample cells so analytics raw cols render typed. */
export function enrichTableColumns(
  columns: TableColumnView[],
  rows: Array<Record<string, string>>,
): TableColumnView[] {
  return columns.map((col) => {
    if (col.kind && col.align) return col;
    const samples = rows.slice(0, 16).map((r) => String(r[col.key] ?? ""));
    const kind = col.kind || inferTableColumnKind(col.key, col.title || col.key, samples);
    const align =
      col.align || (kind === "number" || kind === "money" ? "right" : kind === "id" ? "left" : undefined);
    return { ...col, kind, align };
  });
}

/** Display-format date cells in-place (kind=date, or date-like values). */
export function formatTableDateCells(table: TableView, timeZone = DEFAULT_TZ): TableView {
  const columns = enrichTableColumns(table.columns, table.rows);
  const dateKeys = new Set(
    columns.filter((c) => c.kind === "date").map((c) => c.key),
  );
  const mapRow = (row: Record<string, string>) => {
    const out: Record<string, string> = { ...row };
    for (const col of columns) {
      const raw = String(out[col.key] ?? "");
      if (!raw) continue;
      if (dateKeys.has(col.key) || looksLikeDateValue(raw)) {
        out[col.key] = formatDisplayDate(raw, timeZone);
      }
    }
    return out;
  };
  return {
    ...table,
    columns,
    rows: table.rows.map(mapRow),
    footer: table.footer ? mapRow(table.footer as Record<string, string>) : table.footer,
  };
}

export function enrichTableView(table: TableView): TableView {
  return formatTableDateCells({
    ...table,
    columns: enrichTableColumns(table.columns, table.rows),
  });
}
