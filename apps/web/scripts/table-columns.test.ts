/**
 * table-columns date formatting unit tests.
 * Run: pnpm --filter @bx/web exec tsx scripts/table-columns.test.ts
 */
import assert from "node:assert/strict";
import {
  formatDisplayDate,
  formatMsInTz,
  inferTableColumnKind,
  enrichTableView,
} from "../src/table-columns.ts";

{
  assert.equal(formatDisplayDate("2026-08-20"), "2026-08-20");
  assert.equal(formatDisplayDate("2026-08-20T00:00:00.000Z"), "2026-08-20");
  assert.equal(formatDisplayDate("2026/8/20"), "2026-08-20");
}

{
  // 2026-08-20 12:00 UTC → 20:00 Asia/Shanghai
  const s = formatDisplayDate("2026-08-20T12:00:00.000Z");
  assert.equal(s, "2026-08-20 20:00");
}

{
  const ms = Date.parse("2026-09-10T02:30:00.000Z");
  assert.equal(formatMsInTz(ms), "2026-09-10 10:30");
  assert.equal(formatDisplayDate(String(Math.floor(ms / 1000))), "2026-09-10 10:30");
  assert.equal(formatDisplayDate(String(ms)), "2026-09-10 10:30");
}

{
  assert.equal(inferTableColumnKind("d", "d", ["2026-08-20"]), "date");
  assert.equal(inferTableColumnKind("lastWatchTime", "lastWatchTime", ["1690000000000"]), "date");
  assert.equal(inferTableColumnKind("watchSecond", "watchSecond", ["12345"]), "number");
  assert.equal(inferTableColumnKind("users", "users", ["10", "20"]), "number");
}

{
  const view = enrichTableView({
    title: "t",
    total: 1,
    columns: [{ key: "lastWatchTime", title: "lastWatchTime" }],
    rows: [{ lastWatchTime: "2026-08-20T12:00:00.000Z" }],
  });
  assert.equal(view.columns[0].kind, "date");
  assert.equal(view.rows[0].lastWatchTime, "2026-08-20 20:00");
}

console.log("table-columns.test.ts OK");
