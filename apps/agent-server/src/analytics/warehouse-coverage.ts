/**
 * Warehouse coverage GATE — independent of EX.
 * Pack + expansion spec always; live 72/67/5 when a disk catalog exists.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalogCards } from "./catalog-card.js";
import {
  answerableCatalogTables,
  applyCatalogToPack,
  isHiddenCatalogTable,
  loadDiskCatalog,
  requiredCompileFields,
  type AnalyticsCatalog,
} from "./catalog.js";
import {
  allowedTableNames,
  loadAnalyticsPack,
  type AnalyticsPack,
} from "./semantic-layer.js";

export type WarehouseModelStatus = "overlay_compile" | "verified_query" | "catalog_only";

export type WarehouseExpansionRow = {
  batch: number;
  table: string;
  status: WarehouseModelStatus;
  why: string;
};

export type WarehouseCoverageSpec = {
  version: string;
  databaseId: number;
  catalog: {
    total: number;
    answerable: number;
    hidden: number;
    hiddenNames: string[];
  };
  overlay: {
    table: string;
    declaredFields: string[];
    liveActiveFields: number;
  };
  expansion: WarehouseExpansionRow[];
};

export type WarehouseCoverageReport = {
  pass: boolean;
  failures: string[];
  notes: string[];
  source: "pack_only" | "catalog";
  overlayDeclared: number;
  overlayLiveExpected: number;
  catalog?: { total: number; answerable: number; hidden: number };
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SPEC_PATH = resolve(ROOT, "config/analytics/warehouse-coverage.json");
const VQR_PATH = resolve(ROOT, "config/analytics/verified-queries.json");

export function loadWarehouseCoverageSpec(): WarehouseCoverageSpec {
  const raw = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as WarehouseCoverageSpec;
  return raw;
}

function sorted(xs: string[]): string[] {
  return [...xs].map((s) => String(s).trim()).filter(Boolean).sort();
}

function sameSet(a: string[], b: string[]): boolean {
  const aa = sorted(a);
  const bb = sorted(b);
  return aa.length === bb.length && aa.every((x, i) => x === bb[i]);
}

function verifiedQueryTables(): string[] {
  if (!existsSync(VQR_PATH)) return [];
  const raw = JSON.parse(readFileSync(VQR_PATH, "utf8")) as {
    queries?: Array<{ tables?: string[] }>;
  };
  const names = new Set<string>();
  for (const q of raw.queries || []) {
    for (const t of q.tables || []) names.add(String(t).trim());
  }
  return [...names];
}

export function evaluateWarehouseCoverage(input?: {
  pack?: AnalyticsPack;
  spec?: WarehouseCoverageSpec;
  catalog?: AnalyticsCatalog | null;
}): WarehouseCoverageReport {
  const spec = input?.spec || loadWarehouseCoverageSpec();
  const pack = input?.pack || loadAnalyticsPack("watch-detail");
  const catalog =
    input && "catalog" in (input || {})
      ? input.catalog ?? null
      : loadDiskCatalog(spec.databaseId);
  const failures: string[] = [];
  const notes: string[] = [];

  const overlayName = spec.overlay.table;
  const packTables = (pack.tables || []).map((t) => t.name).filter(Boolean);
  if (packTables.length !== 1 || packTables[0] !== overlayName) {
    failures.push(
      `pack.tables must be exactly [${overlayName}], got [${packTables.join(",")}]`,
    );
  }

  const declared = pack.tables[0]?.fields || [];
  if (!sameSet(declared, spec.overlay.declaredFields)) {
    failures.push(
      `overlay declared fields drifted: pack=[${sorted(declared).join(",")}] spec=[${sorted(spec.overlay.declaredFields).join(",")}]`,
    );
  }
  for (const field of requiredCompileFields(pack)) {
    if (!declared.includes(field)) {
      failures.push(`compile field ${field} is not in overlay declared fields`);
    }
  }
  notes.push(
    `overlay_field_gap: declared ${spec.overlay.declaredFields.length} / live expected ${spec.overlay.liveActiveFields} (compile uses declared; extra columns via catalog)`,
  );

  const hidden = spec.catalog.hiddenNames || [];
  if (hidden.length !== spec.catalog.hidden) {
    failures.push(
      `spec hiddenNames=${hidden.length} != catalog.hidden=${spec.catalog.hidden}`,
    );
  }
  for (const name of hidden) {
    if (isHiddenCatalogTable({ name })) continue;
    notes.push(
      `hiddenNames ${name} is not name-pattern hidden; live catalog must hide it by schema (e.g. metabase_upload)`,
    );
  }

  const cards = loadCatalogCards();
  const vqrTables = new Set(verifiedQueryTables());
  const seen = new Set<string>();
  for (const row of spec.expansion) {
    const name = String(row.table || "").trim();
    if (!name) {
      failures.push("expansion row missing table");
      continue;
    }
    if (seen.has(name)) failures.push(`expansion duplicate: ${name}`);
    seen.add(name);
    if (hidden.includes(name)) {
      failures.push(`expansion table ${name} is listed as hidden`);
    }
    if (!cards[name]) {
      failures.push(`expansion table ${name} missing catalog-cards.json entry`);
    }
    if (row.status === "overlay_compile" && name !== overlayName) {
      failures.push(`overlay_compile must be ${overlayName}, got ${name}`);
    }
    if (row.status === "verified_query" && !vqrTables.has(name)) {
      failures.push(`verified_query table ${name} not in verified-queries.json`);
    }
  }
  if (!seen.has(overlayName)) {
    failures.push(`expansion must include overlay ${overlayName}`);
  }

  const source: WarehouseCoverageReport["source"] = catalog?.tables?.length ? "catalog" : "pack_only";
  let catalogCounts: WarehouseCoverageReport["catalog"];

  if (catalog?.tables?.length) {
    const answerable = answerableCatalogTables(catalog);
    const hiddenLive = catalog.tables.filter((t) => isHiddenCatalogTable(t));
    catalogCounts = {
      total: catalog.tables.length,
      answerable: answerable.length,
      hidden: hiddenLive.length,
    };
    if (catalogCounts.total !== spec.catalog.total) {
      failures.push(
        `catalog total ${catalogCounts.total} != spec ${spec.catalog.total}`,
      );
    }
    if (catalogCounts.answerable !== spec.catalog.answerable) {
      failures.push(
        `catalog answerable ${catalogCounts.answerable} != spec ${spec.catalog.answerable}`,
      );
    }
    if (catalogCounts.hidden !== spec.catalog.hidden) {
      failures.push(
        `catalog hidden ${catalogCounts.hidden} != spec ${spec.catalog.hidden}`,
      );
    }
    const liveNames = new Set(catalog.tables.map((t) => t.name));
    for (const name of hidden) {
      if (!liveNames.has(name)) failures.push(`hidden ${name} missing from live catalog`);
      const liveHidden = catalog.tables.find((t) => t.name === name);
      if (liveHidden && !isHiddenCatalogTable(liveHidden)) {
        failures.push(`hidden ${name} is not classified hidden in live catalog`);
      }
    }
    const answerableNames = new Set(answerable.map((t) => t.name));
    for (const row of spec.expansion) {
      if (!liveNames.has(row.table)) {
        failures.push(`expansion ${row.table} missing from live catalog`);
        continue;
      }
      if (!answerableNames.has(row.table)) {
        failures.push(`expansion ${row.table} is not answerable in live catalog`);
      }
    }
    const overlayLive = catalog.tables.find((t) => t.name === overlayName);
    const liveFieldN = overlayLive?.fields.length || 0;
    if (liveFieldN && liveFieldN !== spec.overlay.liveActiveFields) {
      failures.push(
        `overlay live fields ${liveFieldN} != spec ${spec.overlay.liveActiveFields}`,
      );
    }
    const applied = applyCatalogToPack(pack, catalog);
    const allowed = allowedTableNames(applied.pack);
    if (allowed.length !== spec.catalog.answerable) {
      failures.push(
        `allowedTableNames ${allowed.length} != answerable ${spec.catalog.answerable}`,
      );
    }
  } else {
    notes.push("catalog_skipped: no disk snapshot; live 72/67/5 not asserted this run");
  }

  return {
    pass: failures.length === 0,
    failures,
    notes,
    source,
    overlayDeclared: spec.overlay.declaredFields.length,
    overlayLiveExpected: spec.overlay.liveActiveFields,
    catalog: catalogCounts,
  };
}

export function formatWarehouseCoverage(report: WarehouseCoverageReport): string {
  const cat = report.catalog
    ? `${report.catalog.total}/${report.catalog.answerable}/${report.catalog.hidden}`
    : "n/a";
  return `warehouse coverage ${report.source} tables=${cat} overlay_fields=${report.overlayDeclared}/${report.overlayLiveExpected} ${report.pass ? "PASS" : "FAIL"}`;
}
