/**
 * Instance check for analytics context budget + gates.
 * Deterministic first; then live analyticsAsk (needs LLM + Metabase).
 * Run: node --import tsx scripts/analytics-context-budget-verify.ts
 */
import "dotenv/config";
import assert from "node:assert/strict";
import {
  ANALYTICS_KEEP_RECENT_MESSAGES,
  packAnalyticsLlmContext,
  renderAnalyticsLlmUserTextWrapped,
} from "../src/analytics/context-pack.js";
import { wrapPackedAnalyticsUserText } from "../src/analytics/input-guard.js";
import {
  buildStructureSystemPrompt,
  neededProbeFields,
  parseStructureResponse,
  userDemandsLangFilter,
} from "../src/analytics/conversation-structure.js";
import { resolveAskTimeRange } from "../src/analytics/time-resolve.js";
import { evaluateCapabilityGate } from "../src/analytics/capability-gate.js";
import { nlForMetricFamilyGate, ambiguousMetricFamilyClarify } from "../src/analytics/metric-infer.js";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";
import { analyticsAsk } from "../src/analytics/pipeline.js";
import type { AskState } from "../src/analytics/ask-state.js";

const clock = new Date("2026-09-12T12:00:00+08:00");
const tz = "Asia/Shanghai";
const pack = loadAnalyticsPack("watch-detail");
const prev: AskState = {
  askId: "a1",
  packId: "watch-detail",
  packVersion: pack.version,
  metricId: "uniq_users",
  time: { start: "2026-08-19", end: "2026-08-25" },
  filters: { channel: ["IndiaA"], contentLang: ["te-IN"] },
  outputDims: ["watch_date"],
  ops: ["base_aggregate"],
  requested: { channels: ["IndiaA"], contentLangs: ["te-IN"] },
  summary: "IndiaA 三种小语种观看人数",
  updatedAt: 1,
};

type Row = { id: string; pass: boolean; detail: string };
const rows: Row[] = [];

function check(id: string, fn: () => void) {
  try {
    fn();
    rows.push({ id, pass: true, detail: "ok" });
  } catch (e) {
    rows.push({ id, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

// --- pack instances ---
check("pack/long-session-FoxA-omits-turn0", () => {
  const long = Array.from({ length: 12 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    text: i % 2 === 0 ? `问${i} 三种小语种观看人数` : `请确认语言 ${i}`,
  }));
  long.push({ role: "user", text: "FoxA呢？" });
  const packed = packAnalyticsLlmContext({
    messages: long,
    prevAskState: prev,
    facts: "today_date: 2026-09-12",
    phase: "structure",
  });
  assert.ok(packed.omittedMessages >= 12 - ANALYTICS_KEEP_RECENT_MESSAGES);
  assert.match(packed.transcript, /FoxA呢/);
  assert.match(packed.transcript, /AskState/);
  assert.doesNotMatch(packed.transcript, /问0 三种小语种/);
  assert.ok(packed.transcript.indexOf("AskState") < packed.transcript.indexOf("Current user turn"));
});

check("pack/first-short-ask-keeps-current", () => {
  const packed = packAnalyticsLlmContext({
    messages: [{ role: "user", text: "IndiaA 在 2026-08-19 至 2026-08-25 观看人数" }],
  });
  assert.equal(packed.omittedMessages, 0);
  assert.match(packed.currentTurn, /IndiaA 在 2026-08-19/);
});

check("pack/turn_intent-drops-history", () => {
  const packed = packAnalyticsLlmContext({
    messages: [
      { role: "user", text: "旧问 三种小语种" },
      { role: "assistant", text: "请确认" },
      { role: "user", text: "FoxA呢？" },
    ],
    prevAskState: prev,
    phase: "turn_intent",
  });
  assert.equal(packed.history, "");
  assert.match(packed.currentTurn, /FoxA呢/);
});

check("pack/wrap-only-untrusted", () => {
  const packed = packAnalyticsLlmContext({
    messages: [{ role: "user", text: "FoxA呢？" }],
    prevAskState: prev,
    facts: "today_date: 2026-09-12",
  });
  const wrapped = renderAnalyticsLlmUserTextWrapped(packed, (t) => `⟦U⟧${t}⟦/U⟧`);
  assert.match(wrapped, /Deterministic facts/);
  assert.match(wrapped, /AskState/);
  assert.doesNotMatch(wrapped, /⟦U⟧AskState/);
  assert.match(wrapPackedAnalyticsUserText(packed), /user_message nonce=/);
});

check("pack/system-has-no-clock", () => {
  const sys = buildStructureSystemPrompt(pack);
  assert.doesNotMatch(sys, /today_date|resolved_time_range|2026-09-12/);
});

// --- time instances ---
check("time/八月初-clarify", () => {
  const t = resolveAskTimeRange({ lastUserText: "八月初观看人数", clock, tz });
  assert.equal(t.ok, false);
});
check("time/上周到本周-clarify", () => {
  const t = resolveAskTimeRange({ lastUserText: "上周到本周观看人数", clock, tz });
  assert.equal(t.ok, false);
});
check("time/改成最近-no-inherit", () => {
  const t = resolveAskTimeRange({
    lastUserText: "改成最近",
    prevTime: prev.time,
    clock,
    tz,
  });
  assert.equal(t.ok, false);
});
check("time/改成八月初-no-inherit", () => {
  const t = resolveAskTimeRange({
    lastUserText: "改成八月初",
    prevTime: prev.time,
    clock,
    tz,
  });
  assert.equal(t.ok, false);
});
check("time/FoxA-inherit", () => {
  const t = resolveAskTimeRange({ lastUserText: "FoxA呢？", prevTime: prev.time, clock, tz });
  assert.equal(t.ok, true);
  if (t.ok) {
    assert.equal(t.range.start, "2026-08-19");
    assert.equal(t.range.end, "2026-08-25");
  }
});
check("time/按天-inherit", () => {
  const t = resolveAskTimeRange({ lastUserText: "按天呢？", prevTime: prev.time, clock, tz });
  assert.equal(t.ok, true);
});

// --- JIT / gate / policy instances ---
check("jit/plain-uv-no-probe", () => {
  assert.deepEqual(neededProbeFields("IndiaA 上周观看人数"), []);
  assert.deepEqual(neededProbeFields("FoxA呢？"), []);
  assert.deepEqual(neededProbeFields("按天呢？"), []);
});
check("jit/lang-set-and-movie", () => {
  assert.deepEqual(neededProbeFields("三种小语种观看人数"), ["contentLang"]);
  assert.deepEqual(neededProbeFields("电影观看人数"), ["movieType"]);
});
check("gate/FoxA-does-not-reopen-topn", () => {
  const uv = {
    status: "ok" as const,
    mergedNl: "IndiaA 按天观看人数",
    time: { start: "2026-08-19", end: "2026-08-25" },
    filters: { channel: ["IndiaA"] },
    outputDims: ["watch_date"],
    metricId: "uniq_users",
    ops: ["base_aggregate"],
  };
  assert.equal(evaluateCapabilityGate({ structure: uv, pack, nl: "FoxA呢？" }).status, "ok");
});
check("gate/FoxA-does-not-reopen-completion", () => {
  const history = "2026-08-19到25 IndiaA 完播率按天\n请确认口径\nFoxA呢？";
  assert.equal(
    ambiguousMetricFamilyClarify(nlForMetricFamilyGate({ lastUserText: "FoxA呢？", fallbackNl: history }), pack),
    null,
  );
});
check("policy/movie-after-小语种-no-lang", () => {
  assert.equal(userDemandsLangFilter("电影的观看人数按天"), false);
  const packed = packAnalyticsLlmContext({
    messages: [
      { role: "user", text: "IndiaA 2026-08-19到25 三种小语种完播率按天" },
      { role: "assistant", text: "请确认指标口径" },
      { role: "user", text: "电影的观看人数按天" },
    ],
    prevAskState: prev,
  });
  const r = parseStructureResponse(
    JSON.stringify({
      status: "ok",
      mergedNl: "三种小语种完播率 电影的观看人数按天",
      time: { start: "2026-08-19", end: "2026-08-25" },
      filters: { channel: ["IndiaA"], contentLang: ["te-IN"] },
      outputDims: ["watch_date"],
      metricId: "uniq_users",
    }),
    packed.transcript,
  );
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.filters.contentLang, undefined);
});
check("policy/mergedNl-not-askstate", () => {
  const packed = packAnalyticsLlmContext({
    messages: [{ role: "user", text: "FoxA呢？" }],
    prevAskState: prev,
    facts: "today_date: 2026-09-12",
  });
  const r = parseStructureResponse(
    JSON.stringify({
      status: "clarify",
      clarify: "请确认指标口径",
      clarifySlot: "metric",
      time: { start: "2026-08-19", end: "2026-08-25" },
    }),
    packed.transcript,
  );
  assert.equal(r.status, "clarify");
  if (r.status === "clarify") {
    assert.equal(r.mergedNl, "FoxA呢？");
    assert.doesNotMatch(String(r.mergedNl), /AskState|三种小语种/);
  }
});

// --- pipeline early-exit instances (no LLM) ---
for (const [id, nl] of [
  ["pipe/最近", "最近人均多久"],
  ["pipe/八月初", "八月初观看人数"],
  ["pipe/上周到本周", "上周到本周观看人数"],
] as const) {
  const r = await analyticsAsk(nl, { clock });
  const pass = r.status === "clarify" && r.clarifySlot === "time_range";
  rows.push({
    id,
    pass,
    detail: pass ? `clarify time_range` : `status=${r.status} slot=${r.clarifySlot} msg=${(r.message || "").slice(0, 80)}`,
  });
}

{
  const first = await analyticsAsk("IndiaA 在 2026-08-19 至 2026-08-25 按天观看人数", { clock });
  const r = await analyticsAsk("改成八月初", {
    clock,
    prevAskState: first.askState,
    messages: [
      { role: "user", text: "IndiaA 在 2026-08-19 至 2026-08-25 按天观看人数" },
      { role: "assistant", text: first.message || "ok" },
      { role: "user", text: "改成八月初" },
    ],
  });
  const pass = r.status === "clarify" && r.clarifySlot === "time_range";
  rows.push({
    id: "pipe/改成八月初-no-inherit",
    pass,
    detail: pass
      ? "clarify time_range (did not keep 08-19..25)"
      : `status=${r.status} slot=${r.clarifySlot} echo=${r.timeEcho || ""}`,
  });
}

{
  const first = await analyticsAsk("IndiaA 在 2026-08-19 至 2026-08-25 按天观看人数", { clock });
  const r = await analyticsAsk("改成最近", {
    clock,
    prevAskState: first.askState,
    messages: [
      { role: "user", text: "IndiaA 在 2026-08-19 至 2026-08-25 按天观看人数" },
      { role: "assistant", text: first.message || "ok" },
      { role: "user", text: "改成最近" },
    ],
  });
  const pass = r.status === "clarify" && r.clarifySlot === "time_range";
  rows.push({
    id: "pipe/改成最近-no-inherit",
    pass,
    detail: pass
      ? "clarify time_range (did not keep 08-19..25)"
      : `status=${r.status} slot=${r.clarifySlot} echo=${r.timeEcho || ""}`,
  });
}

// --- live follow-ups ---
const ownerKey = `analytics:ctx-budget-verify:${Date.now()}`;
const modelId = process.env.ANALYTICS_VERIFY_MODEL || "glm5";

async function live(id: string, fn: () => Promise<string>) {
  try {
    const detail = await fn();
    rows.push({ id, pass: !detail.startsWith("FAIL"), detail });
  } catch (e) {
    rows.push({ id, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

await live("live/UV-then-FoxA", async () => {
  const t1 = await analyticsAsk("IndiaA 在 2026-08-19 至 2026-08-25 按天观看人数", {
    clock,
    modelId,
    ownerKey: `${ownerKey}:foxa`,
  });
  if (t1.status !== "ok" || !t1.askState) {
    return `FAIL t1 status=${t1.status} slot=${t1.clarifySlot} ${t1.message || t1.error || ""}`.slice(0, 180);
  }
  const t2 = await analyticsAsk("FoxA呢？", {
    clock,
    modelId,
    ownerKey: `${ownerKey}:foxa`,
    prevAskState: t1.askState,
    messages: [
      { role: "user", text: "IndiaA 在 2026-08-19 至 2026-08-25 按天观看人数" },
      { role: "assistant", text: t1.message || "ok" },
      { role: "user", text: "FoxA呢？" },
    ],
  });
  const sql = (t2.sqls || []).join("\n");
  if (t2.clarifySlot === "contentLang") return "FAIL spurious contentLang";
  if (t2.clarifySlot === "time_range") return "FAIL did not inherit time";
  if (t2.status !== "ok") return `FAIL t2 status=${t2.status} slot=${t2.clarifySlot} ${(t2.message || "").slice(0, 100)}`;
  if (!/FoxA/i.test(sql)) return `FAIL FoxA missing in sql ${sql.slice(0, 160)}`;
  if (!/2026-08-19/.test(sql)) return "FAIL time not inherited";
  return `ok turn=${t2.turnKind} sqls=${(t2.sqls || []).length}`;
});

await live("live/completion-then-FoxA-no-metric-reopen", async () => {
  const t1nl = "IndiaA 在 2026-08-19 至 2026-08-25 最大观看进度平均值按天";
  const t1 = await analyticsAsk(t1nl, {
    clock,
    modelId,
    ownerKey: `${ownerKey}:comp`,
  });
  if (t1.status === "clarify" && t1.clarifySlot === "metric") {
    return `FAIL t1 reopened bare completion family: ${t1.message || ""}`.slice(0, 160);
  }
  const t2 = await analyticsAsk("FoxA呢？", {
    clock,
    modelId,
    ownerKey: `${ownerKey}:comp`,
    prevAskState: t1.askState,
    messages: [
      { role: "user", text: t1nl },
      { role: "assistant", text: t1.message || "ok" },
      { role: "user", text: "FoxA呢？" },
    ],
  });
  if (t2.clarifySlot === "metric") return "FAIL FoxA reopened metric family";
  return `ok t1=${t1.status}/${t1.clarifySlot || "-"} t2=${t2.status}/${t2.clarifySlot || "-"} turn=${t2.turnKind || "-"}`;
});

await live("live/小语种-then-电影-no-lang", async () => {
  const t1 = await analyticsAsk("IndiaA 在 2026-08-19 至 2026-08-25 三种小语种观看人数", {
    clock,
    modelId,
    ownerKey: `${ownerKey}:movie`,
  });
  if (t1.status !== "clarify" || t1.clarifySlot !== "contentLang") {
    return `FAIL t1 expected contentLang, got ${t1.status}/${t1.clarifySlot}`;
  }
  const t2 = await analyticsAsk("2026-08-19到2026-08-25，电影的观看人数，按天", {
    clock,
    modelId,
    ownerKey: `${ownerKey}:movie`,
    prevAskState: t1.askState,
    messages: [
      { role: "user", text: "IndiaA 在 2026-08-19 至 2026-08-25 三种小语种观看人数" },
      { role: "assistant", text: t1.message || "请确认语言" },
      { role: "user", text: "2026-08-19到2026-08-25，电影的观看人数，按天" },
    ],
  });
  if (t2.clarifySlot === "contentLang") return "FAIL history 小语种 forced lang on 电影问";
  if (t2.status === "ok") {
    const sql = (t2.sqls || []).join("\n");
    if (!/movieType/.test(sql)) return `FAIL ok but no movieType ${sql.slice(0, 160)}`;
  }
  return `ok status=${t2.status} slot=${t2.clarifySlot || "-"}`;
});

await live("live/plain-dated-uv-no-lang", async () => {
  const r = await analyticsAsk("IndiaA 在 2026-08-19 至 2026-08-25 按天观看人数", {
    clock,
    modelId,
    ownerKey: `${ownerKey}:plain`,
  });
  if (r.clarifySlot === "contentLang") return "FAIL spurious contentLang on plain UV";
  if (r.status !== "ok") return `FAIL status=${r.status} slot=${r.clarifySlot} ${(r.message || "").slice(0, 100)}`;
  if (!/IndiaA/.test((r.sqls || []).join("\n"))) return "FAIL IndiaA missing";
  return `ok sqls=${(r.sqls || []).length}`;
});

const failed = rows.filter((r) => !r.pass);
for (const r of rows) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}  ${r.detail}`);
}
console.log(JSON.stringify({ failed: failed.length, total: rows.length, ok: failed.length === 0 }));
process.exit(failed.length === 0 ? 0 : 1);
