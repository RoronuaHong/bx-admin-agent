/**
 * Lightweight AskState live smoke (ASKSTATE_CASE=A|B|C|D|E|all).
 * Run: ASKSTATE_CASE=B npm run test:analytics-askstate-smoke
 */
import "dotenv/config";
import { saveAnalyticsPrefs } from "../src/analytics/analytics-prefs.js";
import { analyticsAsk } from "../src/analytics/pipeline.js";

const clock = new Date("2026-09-11T12:00:00+08:00");
const ownerKey = "analytics:askstate-smoke";
const want = (process.env.ASKSTATE_CASE || "all").toUpperCase();

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

let failed = 0;

async function runB() {
  const id = "B-ghost";
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
    msg: (r.message || "").slice(0, 140),
    ms: Date.now() - t0,
  });
  if (!ok) failed++;
}

async function runA() {
  const id = "A-revise";
  const t0 = Date.now();
  const first = await analyticsAsk("IndiaA 在 2026-08-19 至 2026-08-25 按渠道观看人数", {
    clock,
    ownerKey,
  });
  if (first.status !== "ok" || !first.askState) {
    log({ id, ok: false, step: "first", status: first.status, msg: (first.message || "").slice(0, 120), ms: Date.now() - t0 });
    failed++;
    return;
  }
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
  const requested = second.askState?.requested?.channels || [];
  const hasB =
    requested.some((c) => /indiab/i.test(c)) ||
    channelCells(second.tables).some((c) => /indiab/i.test(c)) ||
    (second.message || "").includes("IndiaB") ||
    (second.sqls || []).some((s) => /IndiaB/i.test(s));
  // ok if revise path and not lang-clarify; IndiaB may clarify(channel) if not in DB
  const ok =
    !forbidLang &&
    second.turnKind === "revise" &&
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
    msg: (second.message || "").slice(0, 160),
    ms: Date.now() - t0,
  });
  if (!ok) failed++;
}

async function runD() {
  const id = "D-zero-fill";
  const t0 = Date.now();
  const r = await analyticsAsk("对比 IndiaA 和 IndiaB 在 2026-08-19 至 2026-08-25 的观看人数，按渠道", {
    clock,
    ownerKey,
  });
  const cells = channelCells(r.tables);
  const hasA = cells.some((c) => /indiaa/i.test(c));
  const hasB = cells.some((c) => /indiab/i.test(c));
  const msgMentionsB = /IndiaB|补 0/i.test(r.message || "");
  // If IndiaB not in domain → clarify channel is acceptable; else ok must cover both
  const ok =
    (r.status === "clarify" && r.clarifySlot === "channel") ||
    (r.status === "ok" && hasA && (hasB || msgMentionsB));
  log({
    id,
    ok,
    status: r.status,
    clarifySlot: r.clarifySlot,
    channelsInTable: cells,
    msg: (r.message || "").slice(0, 180),
    ms: Date.now() - t0,
  });
  if (!ok) failed++;
}

async function runC() {
  const id = "C-movie";
  const t0 = Date.now();
  const r = await analyticsAsk("2026-08-19到2026-08-25，电影的观看人数，按天，渠道 IndiaA", {
    clock,
    ownerKey,
  });
  const ok =
    (r.status === "ok" && (r.sqls || []).some((s) => /movieType\s*=\s*1|movieType\s+IN\s*\([^)]*\b1\b/i.test(s))) ||
    (r.status === "clarify" && /电影/.test(JSON.stringify(r.clarifyOptions || [])) );
  log({
    id,
    ok,
    status: r.status,
    clarifySlot: r.clarifySlot,
    options: (r.clarifyOptions || []).slice(0, 5).map((o) => o.label || o.id),
    sql: (r.sqls?.[0] || "").slice(0, 200),
    ms: Date.now() - t0,
  });
  if (!ok) failed++;
}

async function runE() {
  const id = "E-prefs";
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

  const withoutDefault = await analyticsAsk(`本轮不用默认渠道。${q}`, { clock, ownerKey });
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
    },
    ms: Date.now() - t0,
  });
  if (!ok) failed++;
}

if (want === "B" || want === "ALL") await runB();
if (want === "A" || want === "ALL") await runA();
if (want === "C" || want === "ALL") await runC();
if (want === "D" || want === "ALL") await runD();
if (want === "E" || want === "ALL") await runE();

if (failed) {
  console.error(`askstate-smoke FAILED (${failed})`);
  process.exit(1);
}
console.log("analytics-askstate-smoke.ts OK");
