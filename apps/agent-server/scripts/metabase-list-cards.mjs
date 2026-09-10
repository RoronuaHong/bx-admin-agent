/**
 * List Metabase cards (read-only) to pick questionId for pack bindings.
 * Usage: node scripts/metabase-list-cards.mjs [substring]
 */
import "dotenv/config";

const url = (process.env.METABASE_URL || "https://bi.vmovs.com").replace(/\/$/, "");
const username = (process.env.METABASE_USERNAME || process.env.METABASE_USER_EMAIL || "").trim();
const password = process.env.METABASE_PASSWORD || "";
const needle = (process.argv[2] || "").trim().toLowerCase();

if (!username || !password) {
  console.error("Need METABASE_USERNAME + METABASE_PASSWORD");
  process.exit(2);
}

const login = await fetch(`${url}/api/session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password }),
});
if (!login.ok) {
  console.error("login failed", login.status);
  process.exit(1);
}
const { id: session } = await login.json();
const resp = await fetch(`${url}/api/card`, {
  headers: { "X-Metabase-Session": session, Accept: "application/json" },
});
const cards = await resp.json();
const arr = Array.isArray(cards) ? cards : [];
const filtered = needle
  ? arr.filter((c) => String(c.name || "").toLowerCase().includes(needle))
  : arr;
for (const c of filtered.slice(0, 80)) {
  console.log(`${c.id}\t${c.database_id ?? ""}\t${c.name}`);
}
console.log(`[metabase-list-cards] shown ${Math.min(80, filtered.length)} / ${filtered.length} (total ${arr.length})`);
console.log("Wire: ANALYTICS_BINDING_QID_indiaA_day_users=<id> or pack questionId");
