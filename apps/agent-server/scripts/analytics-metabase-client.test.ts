/**
 * Metabase client / config 单元闸门（零网络）。
 * 运行：tsx scripts/analytics-metabase-client.test.ts
 */
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { maskMetabaseUser, normalizeMetabaseUrl } from "../src/analytics/metabase-client.ts";

const saved: Record<string, string | undefined> = {};

function stashEnv(keys: string[]) {
  for (const k of keys) saved[k] = process.env[k];
}

function restoreEnv() {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

stashEnv([
  "METABASE_URL",
  "METABASE_DATABASE_ID",
  "DISTINCT_COUNT_FN",
  "ANALYTICS_BUSINESS_TIMEZONE",
  "METABASE_USERNAME",
  "METABASE_USER_EMAIL",
]);

try {
  // ---- normalizeMetabaseUrl ----
  assert.equal(normalizeMetabaseUrl("https://bi.vmovs.com/"), "https://bi.vmovs.com");
  assert.equal(normalizeMetabaseUrl("https://bi.vmovs.com"), "https://bi.vmovs.com");
  assert.equal(
    `${normalizeMetabaseUrl("https://bi.vmovs.com/")}/api/session`,
    "https://bi.vmovs.com/api/session",
  );

  // ---- maskMetabaseUser ----
  assert.equal(maskMetabaseUser(""), "(empty)");
  assert.equal(maskMetabaseUser("ab@example.com"), "ab***@example.com");
  assert.equal(maskMetabaseUser("alice@example.com"), "al***@example.com");
  assert.equal(maskMetabaseUser("bob"), "bo***");

  // ---- config.metabase.url strips trailing slash ----
  process.env.METABASE_URL = "https://bi.example.com/";
  assert.equal(config.metabase.url, "https://bi.example.com");
  delete process.env.METABASE_URL;
  assert.equal(config.metabase.url, "https://bi.vmovs.com");

  // ---- distinctCountFn mapping ----
  delete process.env.DISTINCT_COUNT_FN;
  assert.equal(config.metabase.distinctCountFn, "uniq");
  process.env.DISTINCT_COUNT_FN = "uniqExact";
  assert.equal(config.metabase.distinctCountFn, "uniqExact");
  process.env.DISTINCT_COUNT_FN = "UNIQEXACT";
  assert.equal(config.metabase.distinctCountFn, "uniqExact");
  process.env.DISTINCT_COUNT_FN = "other";
  assert.equal(config.metabase.distinctCountFn, "uniq");

  // ---- databaseId fallback ----
  delete process.env.METABASE_DATABASE_ID;
  assert.equal(config.metabase.databaseId, 2);
  process.env.METABASE_DATABASE_ID = "5";
  assert.equal(config.metabase.databaseId, 5);
  process.env.METABASE_DATABASE_ID = "not-a-number";
  assert.equal(config.metabase.databaseId, 2);

  // ---- businessTimezone default ----
  delete process.env.ANALYTICS_BUSINESS_TIMEZONE;
  assert.equal(config.metabase.businessTimezone, "Asia/Shanghai");

  // ---- username prefers METABASE_USERNAME ----
  process.env.METABASE_USER_EMAIL = "fallback@example.com";
  process.env.METABASE_USERNAME = " primary@example.com ";
  assert.equal(config.metabase.username, "primary@example.com");
  delete process.env.METABASE_USERNAME;
  assert.equal(config.metabase.username, "fallback@example.com");

  console.log("analytics-metabase-client.test.ts OK");
} finally {
  restoreEnv();
}
