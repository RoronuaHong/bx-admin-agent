/**
 * Live AskState cases A / D / E (needs Metabase + LLM).
 * Run: tsx scripts/analytics-askstate-live.ts
 */
import "dotenv/config";
import { saveAnalyticsPrefs } from "../src/analytics/analytics-prefs.js";
import { analyticsAsk } from "../src/analytics/pipeline.js";

const clock = new Date("2026-09-11T12:00:00+08:00");
const ownerKey = "analytics:askstate-live";
let failed = 0;

function log(obj: Record<string, unknown>) {
  console.log(JSON.stringify(obj));
}

function channelCells(tables: Array<{ cols: string[]; rows: unknown[][] }> | undefined): string[] {
  const out = new Set<string>();
  for (const t of tables || []) {
    const idx = t.cols.findIndex((c) => c.toLowerCase() === "channel" || c.toLowerCase().includes("channel"));
    if (idx < 0) continue;
    for (const row of t.rows || []) {
      if (row[idx] != null && String(row[idx])) out.add(String(row[idx]));
    }
  }
  return [...out];
}

// --- A: revise 「IndiaB呢？」 after IndiaA ok ---
{
  const id = "A-revise-IndiaB";
  const t0 = Date.now();
  const first = await analyticsAsk("IndiaA 在 2026-08-19 至 2026-08-25 按渠道观看人数", {
    clock,
    ownerKey,
  });
  if (first.status !== "ok" || !first.askState) {
    log({
      id,
      ok: false,
      step: "first",
      status: first.status,
      clarifySlot: first.clarifySlot,
      message: first.message?.slice(0, 160),
      ms: Date.now() - t0,
    });
    failed++;
  } else {
    const second = await analyticsAsk("IndiaB呢？", {
      clock,
      ownerKey,
      prevAskState: first.askState,
      messages: [
        { role: "user", text: "IndiaA 在 2026-08-19 至 2026-08-25 按渠道观看人数" },
        { role: "assistant", text: first.message || "ok" },
        { role: "user", text: "IndiaB呢？" },
      ],
    });
    const forbidLang = second.clarifySlot === "contentLang";
    const requested = (second.askState as { requested?: { channels?: string[] } } | undefined)?.requested
      ?.channels;
    const hasB =
      (requested || []).some((c) => /indiab/i.test(c)) ||
      channelCells(second.tables).some((c) => /indiab/i.test(c)) ||
      (second.message || "").includes("IndiaB") ||
      (second.sqls || []).some((s) => /IndiaB/i.test(s));
    const ok =
      !forbidLang &&
      (second.status === "ok" || second.status === "clarify") &&
      (second.status !== "clarify" || second.clarifySlot === "channel") &&
      (second.status !== "ok" || hasB);
    log({
      id,
      ok,
      status: second.status,
      turnKind: second.turnKind,
      clarifySlot: second.clarifySlot,
      requested,
      channelsInTable: channelCells(second.tables),
      defaultsNote: second.defaultsNote,
      askSummary: second.askSummary,
      message: (second.message || "").slice(0, 180),
      ms: Date.now() - t0,
    });
    if (!ok) failed++;
  }
}

// --- D: two channels requested; missing row → zero_fill ---
{
  const id = "D-zero-fill";
  const t0 = Date.now();
  const r = await analyticsAsk(
    "对比 IndiaA 和 IndiaB 在 2026-08-19 至 2026-08-25 的观看人数，按渠道",
    { clock, ownerKey },
  );
  const cells = channelCells(r.tables);
  const hasA = cells.some((c) => /indiaa/i.test(c));
  const hasB = cells.some((c) => /indiab/i.test(c));
  const msgMentionsB = /IndiaB/i.test(r.message || "");
  const ok =
    r.status === "ok" &&
    hasA &&
    (hasB || msgMentionsB || /补 0|zero_fill/i.test(r.message || ""));
  log({
    id,
    ok,
    status: r.status,
    channelsInTable: cells,
    message: (r.message || "").slice(0, 200),
    sqlPreview: (r.sqls?.[0] || "").slice(0, 220),
    ms: Date.now() - t0,
  });
  if (!ok) failed++;
}

// --- E: defaults visible; disable_defaults_this_turn on re-ask ---
{
  const id = "E-prefs-toggle";
  const t0 = Date.now();
  saveAnalyticsPrefs(ownerKey, {
    version: 1,
    updatedAt: Date.now(),
    defaultChannels: ["IndiaA"],
  });
  const q = "2026-08-19到2026-08-25按天观看人数";
  const withDefault = await analyticsAsk(q, { clock, ownerKey });
  const noteVisible =
    Boolean(withDefault.defaultsNote) || Boolean(withDefault.askState?.defaultsApplied?.channels);
  const sqlHasDefault = (withDefault.sqls || []).some((s) => /IndiaA/i.test(s));

  const withoutDefault = await analyticsAsk(`本轮不用默认渠道。${q}`, {
    clock,
    ownerKey,
  });
  const stillForced =
    withoutDefault.status === "ok" &&
    (withoutDefault.sqls || []).some((s) => /channel\s*=\s*'IndiaA'/i.test(s)) &&
    Boolean(withoutDefault.defaultsNote);

  const ok =
    withDefault.status === "ok" &&
    noteVisible &&
    sqlHasDefault &&
    withoutDefault.status === "ok" &&
    !stillForced &&
    !withoutDefault.defaultsNote;

  log({
    id,
    ok,
    withDefault: {
      status: withDefault.status,
      defaultsNote: withDefault.defaultsNote,
      defaultsApplied: withDefault.askState?.defaultsApplied,
    },
    withoutDefault: {
      status: withoutDefault.status,
      turnKind: withoutDefault.turnKind,
      defaultsNote: withoutDefault.defaultsNote,
      sqlHasIndiaAEq: (withoutDefault.sqls || []).some((s) => /channel\s*=\s*'IndiaA'/i.test(s)),
      message: (withoutDefault.message || "").slice(0, 120),
    },
    ms: Date.now() - t0,
  });
  if (!ok) failed++;
}

// --- B smoke: ghost channel clarify ---
{
  const id = "B-ghost-channel";
  const t0 = Date.now();
  const r = await analyticsAsk("GhostChannelXYZ 在 2026-08-19 至 2026-08-25 观看人数", {
    clock,
    ownerKey,
  });
  const ok =
    r.status === "clarify" &&
    r.clarifySlot === "channel" &&
    !(r.sqls || []).some((s) => /GhostChannelXYZ/i.test(s));
  log({
    id,
    ok,
    status: r.status,
    clarifySlot: r.clarifySlot,
    message: (r.message || "").slice(0, 160),
    ms: Date.now() - t0,
  });
  if (!ok) failed++;
}

if (failed) {
  console.error(`askstate-live FAILED (${failed})`);
  process.exit(1);
}
console.log("analytics-askstate-live.ts OK");
