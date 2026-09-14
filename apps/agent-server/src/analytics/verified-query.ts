/**
 * Path B: verified query repository — bind slots into gold SQL, never rewrite the formula.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allowedTableNames, type AnalyticsPack } from "./semantic-layer.js";

export type VerifiedQuerySlot = "start" | "end" | "channel" | "appVersion" | "langs";

export type VerifiedQuery = {
  id: string;
  title: string;
  aliases: string[];
  tables: string[];
  sql: string;
  slots: VerifiedQuerySlot[];
  /** When set and A can compile this shape, router stays on Path A. */
  promoteTo?: string;
  needsWide?: boolean;
};

type FileShape = { version?: string; queries?: VerifiedQuery[] };

const FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../../config/analytics/verified-queries.json");

let cache: VerifiedQuery[] | null = null;

export function loadVerifiedQueries(): VerifiedQuery[] {
  if (cache) return cache;
  if (!existsSync(FILE)) {
    cache = [];
    return cache;
  }
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as FileShape;
    cache = Array.isArray(raw.queries) ? raw.queries : [];
  } catch {
    cache = [];
  }
  return cache;
}

export function _resetVerifiedQueriesForTest(): void {
  cache = null;
}

const WIDE_SHAPE = /宽表|按语言拆列|小语种列|语言宽表|按语种拆/;

export function nlWantsWideShape(nl: string): boolean {
  return WIDE_SHAPE.test(String(nl || ""));
}

/** Metrics Path A can compile — skip Path B. */
const COMPILE_PROMOTE = new Set([
  "avg_max_progress",
  "avg_watch_second_per_user",
  "uniq_users",
  "pay_rate_lang_wide",
  "retention_d1_lang",
  "retention_d1_total",
]);

export function compileCanCoverVerified(q: VerifiedQuery, _nl: string): boolean {
  if (q.promoteTo && COMPILE_PROMOTE.has(q.promoteTo)) return true;
  return false;
}

function aliasHits(nl: string, aliases: string[]): { hit: boolean; maxLen: number } {
  const text = String(nl || "");
  let maxLen = 0;
  for (const a of aliases || []) {
    if (a && text.includes(a)) maxLen = Math.max(maxLen, a.length);
  }
  return { hit: maxLen > 0, maxLen };
}

export function tablesAnswerable(pack: AnalyticsPack, tables: string[]): boolean {
  const allowed = new Set(allowedTableNames(pack).map((t) => t.toLowerCase()));
  return tables.every((t) => {
    const bare = t.includes(".") ? t.slice(t.lastIndexOf(".") + 1) : t;
    return allowed.has(t.toLowerCase()) || allowed.has(bare.toLowerCase());
  });
}

export function matchVerifiedQuery(
  nl: string,
  pack: AnalyticsPack,
): { query: VerifiedQuery; score: number } | { clarify: Array<{ id: string; label: string }> } | null {
  const hits: Array<{ query: VerifiedQuery; score: number }> = [];
  for (const q of loadVerifiedQueries()) {
    const alias = aliasHits(nl, q.aliases);
    if (!alias.hit) continue;
    if (!tablesAnswerable(pack, q.tables)) continue;
    if (compileCanCoverVerified(q, nl)) continue;
    hits.push({ query: q, score: alias.maxLen });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.score - a.score || a.query.id.localeCompare(b.query.id));
  if (hits.length > 1 && hits[0]!.score === hits[1]!.score) {
    return {
      clarify: hits.slice(0, 6).map((h) => ({ id: h.query.id, label: h.query.title || h.query.id })),
    };
  }
  return { query: hits[0]!.query, score: hits[0]!.score };
}

export type BindSlots = {
  start: string;
  end: string;
  channel?: string;
  appVersion?: string;
  langs?: string[];
};

export function missingVerifiedSlots(q: VerifiedQuery, slots: BindSlots): VerifiedQuerySlot[] {
  const missing: VerifiedQuerySlot[] = [];
  const sql = q.sql || "";
  if (sql.includes("{{start}}") && !slots.start) missing.push("start");
  if (sql.includes("{{end}}") && !slots.end) missing.push("end");
  if (sql.includes("{{channel}}") && !String(slots.channel || "").trim()) missing.push("channel");
  if (sql.includes("{{appVersion}}") && !String(slots.appVersion || "").trim()) missing.push("appVersion");
  return missing;
}

export function bindVerifiedQuery(q: VerifiedQuery, slots: BindSlots): { ok: true; sql: string } | { ok: false; missing: VerifiedQuerySlot[] } {
  const missing = missingVerifiedSlots(q, slots);
  if (missing.length) return { ok: false, missing };
  let sql = q.sql;
  sql = sql.replaceAll("{{start}}", slots.start);
  sql = sql.replaceAll("{{end}}", slots.end);
  sql = sql.replaceAll("{{channel}}", String(slots.channel || "").replace(/'/g, "''"));
  sql = sql.replaceAll("{{appVersion}}", String(slots.appVersion || "").replace(/'/g, "''"));
  if (slots.langs?.length) {
    const lit = slots.langs.map((l) => `'${String(l).replace(/'/g, "''")}'`).join(", ");
    sql = sql.replaceAll("{{langs}}", lit);
  }
  return { ok: true, sql };
}

export function extractAppVersionFromNl(nl: string): string | undefined {
  const m = String(nl || "").match(
    /(?:appVersion|appVerName|版本号|版本)\s*[:=]?\s*([0-9]+(?:\.[0-9]+)+)/i,
  );
  if (m) return m[1];
  const bare = String(nl || "").match(/\b(\d+\.\d+\.\d+)\b/);
  return bare?.[1];
}
