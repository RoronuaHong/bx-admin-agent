import assert from "node:assert/strict";
import { catalogPayload, listSqlStyleIds } from "../src/analytics/schema-agent.js";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";

const pack = loadAnalyticsPack("watch-detail");
{
  const cat = catalogPayload(pack);
  assert.equal(cat.table, "elt_watch_detail");
  assert.ok(Array.isArray(cat.probeDimensions));
  assert.ok((cat.probeDimensions as string[]).includes("movieType"));
  const dims = cat.enumDimensions as Array<{ field: string }>;
  assert.ok(dims.some((d) => d.field === "movieType"));
  assert.ok(dims.some((d) => d.field === "contentLang"));
  const styles = listSqlStyleIds();
  assert.ok(styles.includes("avg_per_user_by_day"));
  assert.ok(styles.includes("avg_of_max_wide"));
}

console.log("analytics-schema-agent-unit.test.ts OK");
