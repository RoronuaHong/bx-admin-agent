/**
 * Focused retest D4/D5 after accuracy fixes.
 */
import "dotenv/config";
import { analyticsAsk } from "../src/analytics/pipeline.js";

const clock = new Date("2026-09-11T12:00:00+08:00");
const ownerKey = "analytics:accuracy-fix";
const modelId = "glm5";

function log(o: unknown) {
  console.log(JSON.stringify(o));
}

// D4
{
  const r1 = await analyticsAsk("GhostZZZ 在 2026-08-19 至 2026-08-25 观看人数", {
    clock,
    modelId,
    ownerKey: ownerKey + ":d4",
  });
  log({
    id: "D4-1",
    status: r1.status,
    slot: r1.clarifySlot,
    hasAskState: Boolean(r1.askState),
    askState: r1.askState
      ? {
          metricId: r1.askState.metricId,
          time: r1.askState.time,
          filters: r1.askState.filters,
          requested: r1.askState.requested,
        }
      : null,
    turnKind: r1.turnKind,
    turnIntentSource: r1.turnIntentSource,
  });
  const r2 = await analyticsAsk("那换成 IndiaA 吧", {
    clock,
    modelId,
    ownerKey: ownerKey + ":d4",
    prevAskState: r1.askState,
    lastClarifySlot: r1.clarifySlot,
    clarifyOptionIds: (r1.clarifyOptions || []).map((o) => o.id),
    messages: [
      { role: "user", text: "GhostZZZ 在 2026-08-19 至 2026-08-25 观看人数" },
      { role: "assistant", text: r1.message || "" },
      { role: "user", text: "那换成 IndiaA 吧" },
    ],
  });
  log({
    id: "D4-2",
    ok:
      r2.status === "ok" &&
      (r2.turnKind === "revise" || r2.turnKind === "clarify_answer") &&
      /IndiaA/i.test((r2.sqls || []).join("\n")) &&
      !/GhostZZZ/i.test((r2.sqls || []).join("\n")),
    status: r2.status,
    turnKind: r2.turnKind,
    turnIntentSource: r2.turnIntentSource,
    err: r2.error,
    msg: (r2.message || "").slice(0, 120),
    sql: (r2.sqls?.[0] || "").slice(0, 220),
  });
}

// D5
{
  const r1 = await analyticsAsk("IndiaA 在 2026-08-19 至 2026-08-25，te-IN 观看人数按天", {
    clock,
    modelId,
    ownerKey: ownerKey + ":d5",
  });
  log({
    id: "D5-1",
    status: r1.status,
    hasAskState: Boolean(r1.askState),
    dims: r1.askState?.outputDims,
    filters: r1.askState?.filters,
    turnKind: r1.turnKind,
    turnIntentSource: r1.turnIntentSource,
  });
  const r2 = await analyticsAsk("FoxA呢？", {
    clock,
    modelId,
    ownerKey: ownerKey + ":d5",
    prevAskState: r1.askState,
    messages: [
      { role: "user", text: "IndiaA 在 2026-08-19 至 2026-08-25，te-IN 观看人数按天" },
      { role: "assistant", text: r1.message || "" },
      { role: "user", text: "FoxA呢？" },
    ],
  });
  const sql = (r2.sqls || []).join("\n");
  log({
    id: "D5-2",
    ok:
      r2.status === "ok" &&
      r2.turnKind === "revise" &&
      r2.turnIntentSource === "llm" &&
      /FoxA/i.test(sql) &&
      /IndiaA/i.test(sql) &&
      /channel/i.test(sql) &&
      /GROUP BY[\s\S]*channel/i.test(sql),
    status: r2.status,
    turnKind: r2.turnKind,
    turnIntentSource: r2.turnIntentSource,
    sql: sql.slice(0, 280),
    requested: r2.askState?.requested,
    outputDims: r2.askState?.outputDims,
  });
}

process.exit(0);
