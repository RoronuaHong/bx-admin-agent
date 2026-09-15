/**
 * Per-table retrieval card: identity + synonyms.
 * Cross-table “对照” prose is not indexed. Overrides live in catalog-cards.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadInferredTableDocs } from "./catalog-inferred.js";
import type { WarehouseTable } from "./semantic-layer.js";

export type CatalogCardOverride = {
  identity?: string;
  synonyms?: string[];
};

type CardsFile = {
  version?: string;
  tables?: Record<string, CatalogCardOverride>;
};

const FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../../config/analytics/catalog-cards.json");

const CARD_STOP = new Set([
  "本表",
  "记录",
  "存储",
  "信息",
  "数据",
  "每天",
  "明细",
  "汇总",
  "切片",
  "对照",
  "正式",
  "口径",
  "用户",
  "设备",
  "字段",
  "说明",
]);

let cache: Record<string, CatalogCardOverride> | null = null;

export function loadCatalogCards(): Record<string, CatalogCardOverride> {
  if (cache) return cache;
  if (!existsSync(FILE)) {
    cache = {};
    return cache;
  }
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as CardsFile;
    cache = raw.tables && typeof raw.tables === "object" ? raw.tables : {};
  } catch {
    cache = {};
  }
  return cache;
}

export function _resetCatalogCardsForTest(): void {
  cache = null;
}

/** Drop “对照 …” and parentheticals that name other physical tables. */
export function stripCrossRefs(text: string): string {
  return String(text || "")
    .replace(/对照[^\n。]*/g, " ")
    .replace(/（[^）]*(?:elt_|gather\.|mv_)[^）]*）/gi, " ")
    .replace(/\([^)]*(?:elt_|gather\.|mv_)[^)]*\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tableIdentity(
  t: Pick<WarehouseTable, "name" | "displayName" | "description" | "identity">,
): string {
  const override = t.name ? loadCatalogCards()[t.name]?.identity : undefined;
  const explicit = String(override || t.identity || "").trim();
  if (explicit) return stripCrossRefs(explicit);
  const desc = String(t.description || "");
  const first = desc.split(/\n/)[0] || "";
  return stripCrossRefs([t.displayName, first].filter(Boolean).join(" "));
}

function cleanPhrase(raw: string): string | undefined {
  const s = String(raw || "")
    .replace(/（[^）]*）|\([^)]*\)/g, "")
    .replace(/[表日志流水]$/u, "")
    .trim();
  if (s.length < 2 || s.length > 12) return undefined;
  if (CARD_STOP.has(s)) return undefined;
  return s;
}

function displayNameSynonyms(display?: string): string[] {
  const base = cleanPhrase(String(display || ""));
  if (!base) return [];
  const out = [base];
  if (base.length >= 4) out.push(base.slice(-2));
  return out.filter((s) => s.length >= 2 && !CARD_STOP.has(s));
}

function identityTails(identity: string): string[] {
  const out: string[] = [];
  const compact = stripCrossRefs(identity);
  for (const token of compact.split(/[\s,，、。；;：:的为是和及（）()【】/]+/)) {
    const p = cleanPhrase(token);
    if (!p) continue;
    out.push(p);
    if (p.length === 4) out.push(p.slice(-2));
  }
  return out;
}

/**
 * Declared (curated) synonyms: `catalog-cards.json` overrides + catalog-level synonyms.
 * These are operator/warehouse-authored, so short or shared surface forms stay trustworthy
 * — unlike derived phrases, which need the noise filters in scoreSynonymHits.
 */
export function tableDeclaredSynonyms(t: WarehouseTable): string[] {
  const out = new Set<string>();
  const card = t.name ? loadCatalogCards()[t.name] : undefined;
  for (const s of card?.synonyms || []) {
    const v = String(s || "").trim();
    if (v) out.add(v);
  }
  for (const s of t.synonyms || []) {
    const v = String(s || "").trim();
    if (v) out.add(v);
  }
  return [...out];
}

export function tableSynonyms(t: WarehouseTable): string[] {
  const out = new Set<string>();
  const add = (s?: string) => {
    const p = cleanPhrase(s || "");
    if (p) out.add(p);
  };
  for (const s of tableDeclaredSynonyms(t)) add(s);
  for (const s of displayNameSynonyms(t.displayName)) add(s);
  for (const s of identityTails(tableIdentity(t))) add(s);
  return [...out];
}

export function attachCatalogCard(t: WarehouseTable): WarehouseTable {
  const override = loadCatalogCards()[t.name];
  const inferred = loadInferredTableDocs()[t.name];
  const synonyms = [
    ...new Set(
      [...(override?.synonyms || []), ...(inferred?.synonyms || []), ...(t.synonyms || [])]
        .map((s) => String(s || "").trim())
        .filter(Boolean),
    ),
  ];
  const identity = stripCrossRefs(override?.identity || inferred?.identity || tableIdentity(t));
  return { ...t, identity, synonyms };
}
