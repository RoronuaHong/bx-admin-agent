/**
 * D2: zero-fill with two grounded channels (IndiaA + FoxA).
 * Run: node --import tsx ./scripts/analytics-askstate-smoke-d2.ts
 */
import "dotenv/config";
import { analyticsAsk } from "../src/analytics/pipeline.js";

const clock = new Date("2026-09-11T12:00:00+08:00");
const t0 = Date.now();
const r = await analyticsAsk(
  "对比 IndiaA 和 FoxA 在 2026-08-19 至 2026-08-25 的观看人数，按渠道",
  { clock, ownerKey: "analytics:askstate-smoke-d2" },
);

function channelCells(tables: Array<{ cols: string[]; rows: unknown[][] }> | undefined): string[] {
  const out = new Set<string>();
  for (const t of tables || []) {
    const idx = t.cols.findIndex((c) => /channel/i.test(c));
    if (idx < 0) continue;
    for (const row of t.rows || []) {
      if (row[idx] != null && String(row[idx])) out.add(String(row[idx]));
    }
  }
  return [...out];
}

const cells = channelCells(r.tables);
const hasA = cells.some((c) => /indiaa/i.test(c));
const hasFox = cells.some((c) => /foxa/i.test(c));
const filled = /补 0|FoxA|IndiaA/i.test(r.message || "");
const ok = r.status === "ok" && hasA && hasFox;

console.log(
  JSON.stringify({
    id: "D2-zero-fill-grounded",
    ok,
    status: r.status,
    channelsInTable: cells,
    defaultsNote: r.defaultsNote,
    askSummary: r.askSummary,
    msg: (r.message || "").slice(0, 200),
    sql: (r.sqls?.[0] || "").slice(0, 260),
    filledHint: filled,
    ms: Date.now() - t0,
  }),
);
if (!ok) process.exit(1);
console.log("D2 OK");
