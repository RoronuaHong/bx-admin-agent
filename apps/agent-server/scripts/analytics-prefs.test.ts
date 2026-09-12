import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _setAnalyticsPrefsDirForTest,
  applyAnalyticsPrefsDefaults,
  formatAnalyticsPrefsFacts,
  loadAnalyticsPrefs,
  rememberAnalyticsSuccess,
  saveAnalyticsPrefs,
} from "../src/analytics/analytics-prefs.js";

const dir = mkdtempSync(join(tmpdir(), "analytics-prefs-"));
_setAnalyticsPrefsDirForTest(dir);

try {
  const empty = loadAnalyticsPrefs("owner:a");
  assert.equal(empty.defaultChannels, undefined);
  assert.equal(formatAnalyticsPrefsFacts(empty), "");

  saveAnalyticsPrefs("owner:a", {
    version: 1,
    updatedAt: Date.now(),
    defaultChannels: ["IndiaA"],
    preferLayout: "wide",
    recentMetricIds: ["uniq_users"],
  });
  const loaded = loadAnalyticsPrefs("owner:a");
  assert.deepEqual(loaded.defaultChannels, ["IndiaA"]);
  assert.equal(loaded.preferLayout, "wide");
  const facts = formatAnalyticsPrefsFacts(loaded);
  assert.match(facts, /IndiaA/);
  assert.match(facts, /preferLayout|preferred result_layout/i);

  const applied = applyAnalyticsPrefsDefaults({
    filters: {},
    prefs: loaded,
  });
  assert.deepEqual(applied.filters.channel, ["IndiaA"]);
  assert.equal(applied.layout, "wide");
  assert.ok(applied.notes.some((n) => n.startsWith("prefs_default_channel")));

  // Prefer explicit channel over prefs
  const keep = applyAnalyticsPrefsDefaults({
    filters: { channel: ["IndiaB"] },
    prefs: loaded,
    nl: "IndiaB 按天观看人数",
  });
  assert.deepEqual(keep.filters.channel, ["IndiaB"]);
  assert.ok(!keep.notes.some((n) => n.startsWith("prefs_default_channel")));

  // Structure soft-mirrored prefs while NL omitted channel → still note for UI
  const soft = applyAnalyticsPrefsDefaults({
    filters: { channel: ["IndiaA"] },
    prefs: loaded,
    nl: "2026-08-19到2026-08-25按天观看人数",
  });
  assert.deepEqual(soft.filters.channel, ["IndiaA"]);
  assert.ok(soft.notes.some((n) => n.startsWith("prefs_default_channel")));

  // Never auto-fill contentLang
  const noLang = applyAnalyticsPrefsDefaults({
    filters: {},
    prefs: { ...loaded, defaultContentLangs: ["te-IN"] },
  });
  assert.equal(noLang.filters.contentLang, undefined);

  // Do not force default channel on 各渠道 asks
  const multi = applyAnalyticsPrefsDefaults({
    filters: {},
    prefs: loaded,
    nl: "各渠道观看人数的同比增长率",
  });
  assert.equal(multi.filters.channel, undefined);

  // NL already names a channel — do not inject prefs IndiaA
  const named = applyAnalyticsPrefsDefaults({
    filters: {},
    prefs: loaded,
    nl: "FoxA 按天观看人数",
  });
  assert.equal(named.filters.channel, undefined);

  rememberAnalyticsSuccess({
    ownerKey: "owner:b",
    metricId: "avg_watch_second_per_user",
    layout: "long",
  });
  const remembered = loadAnalyticsPrefs("owner:b");
  assert.equal(remembered.defaultChannels, undefined);
  assert.equal(remembered.preferLayout, "long");
  assert.equal(remembered.recentMetricIds?.[0], "avg_watch_second_per_user");

  console.log("analytics-prefs.test.ts OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
