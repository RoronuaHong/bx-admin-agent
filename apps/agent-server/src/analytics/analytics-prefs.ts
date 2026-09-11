/**
 * Analytics user preferences (per ownerKey): default channel / layout / recent metrics.
 * Soft defaults only — never override explicit NL / 澄清选择.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
let PREFS_DIR = resolve(__dirname, "../../.data", "analytics-prefs");

export type AnalyticsUserPrefs = {
  version: 1;
  updatedAt: number;
  defaultChannels?: string[];
  defaultContentLangs?: string[];
  preferLayout?: "wide" | "long";
  recentMetricIds?: string[];
};

function safeFileName(ownerKey: string): string {
  const raw = String(ownerKey || "").trim() || "anonymous";
  return raw.replace(/[^a-zA-Z0-9._:@-]+/g, "_").replace(/:/g, "__") + ".json";
}

function prefsPath(ownerKey: string): string {
  return resolve(PREFS_DIR, safeFileName(ownerKey));
}

function emptyPrefs(): AnalyticsUserPrefs {
  return { version: 1, updatedAt: 0 };
}

export function loadAnalyticsPrefs(ownerKey: string): AnalyticsUserPrefs {
  if (!ownerKey?.trim()) return emptyPrefs();
  const path = prefsPath(ownerKey);
  if (!existsSync(path)) return emptyPrefs();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AnalyticsUserPrefs>;
    const out = emptyPrefs();
    if (Array.isArray(raw.defaultChannels)) {
      out.defaultChannels = [...new Set(raw.defaultChannels.map(String).filter(Boolean))].slice(0, 8);
    }
    if (Array.isArray(raw.defaultContentLangs)) {
      out.defaultContentLangs = [
        ...new Set(raw.defaultContentLangs.map(String).filter((x) => x !== undefined)),
      ].slice(0, 12);
    }
    if (raw.preferLayout === "wide" || raw.preferLayout === "long") {
      out.preferLayout = raw.preferLayout;
    }
    if (Array.isArray(raw.recentMetricIds)) {
      out.recentMetricIds = [...new Set(raw.recentMetricIds.map(String).filter(Boolean))].slice(0, 8);
    }
    out.updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : 0;
    return out;
  } catch {
    return emptyPrefs();
  }
}

export function saveAnalyticsPrefs(ownerKey: string, prefs: AnalyticsUserPrefs): void {
  if (!ownerKey?.trim()) return;
  if (!existsSync(PREFS_DIR)) mkdirSync(PREFS_DIR, { recursive: true });
  const path = prefsPath(ownerKey);
  const tmp = `${path}.${process.pid}.tmp`;
  const payload: AnalyticsUserPrefs = {
    version: 1,
    updatedAt: Date.now(),
    ...(prefs.defaultChannels?.length ? { defaultChannels: prefs.defaultChannels } : {}),
    ...(prefs.defaultContentLangs?.length ? { defaultContentLangs: prefs.defaultContentLangs } : {}),
    ...(prefs.preferLayout ? { preferLayout: prefs.preferLayout } : {}),
    ...(prefs.recentMetricIds?.length ? { recentMetricIds: prefs.recentMetricIds } : {}),
  };
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  renameSync(tmp, path);
}

/** Facts block for structure LLM — soft hints only. */
export function formatAnalyticsPrefsFacts(prefs: AnalyticsUserPrefs): string {
  const lines: string[] = [];
  if (prefs.defaultChannels?.length) {
    lines.push(`User default channels (use only if user omitted channel): ${prefs.defaultChannels.join(", ")}`);
  }
  if (prefs.preferLayout) {
    lines.push(`User preferred result_layout when ambiguous: ${prefs.preferLayout}`);
  }
  if (prefs.recentMetricIds?.length) {
    lines.push(`Recently used metrics: ${prefs.recentMetricIds.join(", ")}`);
  }
  if (!lines.length) return "";
  return ["[analytics-user-prefs]", ...lines, "Never override explicit user filters/locales this turn."].join(
    "\n",
  );
}

/**
 * Fill missing filter slots from prefs (channel / layout only).
 * Does NOT auto-fill contentLang — that caused false clarifications.
 * Does NOT force a default channel when the user asks for multi-channel breakdown.
 * If Structure already mirrored prefs defaults while NL omitted channel, still note it
 * so UI can show defaultsApplied / defaultsNote.
 */
export function applyAnalyticsPrefsDefaults(input: {
  filters: Record<string, string[]>;
  layout?: "wide" | "long";
  prefs: AnalyticsUserPrefs;
  nl?: string;
  outputDims?: string[];
}): { filters: Record<string, string[]>; layout?: "wide" | "long"; notes: string[] } {
  const filters = { ...input.filters };
  const notes: string[] = [];
  let layout = input.layout;
  const nl = String(input.nl || "");
  const multiChannelAsk = /各渠道|所有渠道|全部渠道|每个渠道|分渠道/.test(nl);
  const prefsChannels = input.prefs.defaultChannels || [];
  const nlMentionsAnyPreferred =
    prefsChannels.some((c) => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(nl)) ||
    /India[A-Za-z0-9]*|Fox[A-Za-z0-9]*|GoGo|Tiger|Pak[A-Za-z0-9]*/i.test(nl);

  if (prefsChannels.length && !multiChannelAsk) {
    if (!filters.channel?.length) {
      filters.channel = [...prefsChannels];
      notes.push(`prefs_default_channel:${filters.channel.join(",")}`);
    } else if (
      !nlMentionsAnyPreferred &&
      sameStringSet(filters.channel, prefsChannels)
    ) {
      // LLM soft-filled from prefs facts — still surface to user
      notes.push(`prefs_default_channel:${filters.channel.join(",")}:soft`);
    }
  }
  if (!layout && input.prefs.preferLayout) {
    layout = input.prefs.preferLayout;
    notes.push(`prefs_default_layout:${layout}`);
  }
  return { filters, layout, notes };
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a.map((x) => x.toLowerCase()));
  return b.every((x) => sa.has(x.toLowerCase()));
}

/** After successful ask: remember channel + metric (soft). */
export function rememberAnalyticsSuccess(input: {
  ownerKey: string;
  channels?: string[];
  metricId?: string;
  layout?: "wide" | "long";
}): void {
  if (!input.ownerKey?.trim()) return;
  const cur = loadAnalyticsPrefs(input.ownerKey);
  if (input.channels?.length) {
    cur.defaultChannels = [...new Set(input.channels.map(String).filter(Boolean))].slice(0, 8);
  }
  if (input.metricId) {
    const recent = [input.metricId, ...(cur.recentMetricIds || [])].filter(Boolean);
    cur.recentMetricIds = [...new Set(recent)].slice(0, 8);
  }
  if (input.layout) cur.preferLayout = input.layout;
  saveAnalyticsPrefs(input.ownerKey, cur);
}

/** Test helper */
export function _setAnalyticsPrefsDirForTest(dir: string): void {
  PREFS_DIR = dir;
}
