/**
 * Build catalog digest markdown + JSON from live or cached Metabase metadata.
 *   pnpm exec tsx scripts/analytics-catalog-digest.ts
 *   pnpm exec tsx scripts/analytics-catalog-digest.ts --force
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAnalyticsPack } from "../src/analytics/semantic-layer.js";
import { loadOrRefreshCatalog } from "../src/analytics/catalog.js";
import { buildCatalogDigest, formatCatalogDigestMarkdown } from "../src/analytics/catalog-digest.js";
import { formatInferredCatalogMarkdown } from "../src/analytics/catalog-inferred.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = resolve(root, "../../docs/agent");
const force = process.argv.includes("--force");
const pack = loadAnalyticsPack("watch-detail");
const databaseId = pack.datasource.metabaseDatabaseId;
const loaded = await loadOrRefreshCatalog({ databaseId, force });
if ("skipped" in loaded) {
  console.error(JSON.stringify({ ok: false, reason: loaded.reason }));
  process.exit(1);
}
const digest = buildCatalogDigest(loaded.catalog);
const md = formatCatalogDigestMarkdown(digest);
const jsonPath = resolve(root, ".data/analytics-catalog", `digest-${databaseId}.json`);
const mdPath = resolve(docsRoot, "ANALYTICS_CATALOG_DIGEST.md");
mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, JSON.stringify(digest, null, 2) + "\n");
writeFileSync(mdPath, md);
const inferredMdPath = resolve(docsRoot, "ANALYTICS_CATALOG_INFERRED.md");
writeFileSync(inferredMdPath, formatInferredCatalogMarkdown());
console.log(
  JSON.stringify(
    {
      ok: true,
      source: loaded.source,
      markdown: mdPath,
      inferred: inferredMdPath,
      json: jsonPath,
      tableCount: digest.tableCount,
      answerableCount: digest.answerableCount,
      hiddenCount: digest.hiddenCount,
      describedFieldCount: digest.describedFieldCount,
      fieldCount: digest.fieldCount,
    },
    null,
    2,
  ),
);
