/**
 * Coverage Gate: NL-grounded dim values must appear in schema filters.
 * Symmetric to Capability Gate (declared ⊆ pack). Here: grounded ⊆ schema, else backfill.
 * Lexicon / locale / pack aliases — no product channel allow-list.
 */

import { extractLocalesFromText } from "./conversation-structure.js";
import { extractCodesFromText, type DimLexicon } from "./dim-lexicon.js";
import { extractChannelsFromNl } from "./intent.js";
import {
  canApplyTextChannelFilter,
  extractAliasedEnumValues,
  packFieldsForTable,
  type AnalyticsPack,
} from "./semantic-layer.js";

export type CoverageGateResult = {
  status: "ok";
  filters: Record<string, string[]>;
  notes: string[];
  backfilled: Record<string, string[]>;
};

function uniqCi(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = String(x).toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function missingFrom(have: string[], want: string[]): string[] {
  const haveSet = new Set(have.map((x) => x.toLowerCase()));
  return want.filter((w) => !haveSet.has(w.toLowerCase()));
}

export function coverageFields(pack: AnalyticsPack): string[] {
  return [
    ...new Set([
      ...(pack.probeDimensions || []),
      ...(pack.enumDimensions || []).map((d) => d.field),
    ]),
  ];
}

/** Ground filter values mentioned in NL via pack lexicons + locale pattern. */
export function groundFiltersFromNl(input: {
  nl: string;
  pack: AnalyticsPack;
  lexicons?: Record<string, DimLexicon>;
}): Record<string, string[]> {
  const text = String(input.nl || "");
  const out: Record<string, string[]> = {};
  const lexicons = input.lexicons || {};

  for (const field of coverageFields(input.pack)) {
    const lex = lexicons[field];
    const fromLex = lex ? extractCodesFromText(text, lex) : [];
    const fromLocale = field === "contentLang" ? extractLocalesFromText(text) : [];
    const fromAlias =
      field === "channel" ? extractChannelsFromNl(text, input.pack) : extractAliasedEnumValues(text, input.pack, field);
    const codes = uniqCi([...fromLex, ...fromLocale, ...fromAlias]);
    if (codes.length) out[field] = codes;
  }
  return out;
}

/**
 * Union NL-grounded codes into schema filters when the model omitted them.
 * Does not drop existing schema/prefs values.
 */
export function applyCoverageGate(input: {
  filters: Record<string, string[]>;
  nl: string;
  pack: AnalyticsPack;
  lexicons?: Record<string, DimLexicon>;
  table?: string;
}): CoverageGateResult {
  const filters = { ...input.filters };
  const notes: string[] = [];
  const backfilled: Record<string, string[]> = {};
  const grounded = groundFiltersFromNl({
    nl: input.nl,
    pack: input.pack,
    lexicons: input.lexicons,
  });
  const known = input.table ? new Set(packFieldsForTable(input.pack, input.table)) : null;

  for (const [field, want] of Object.entries(grounded)) {
    if (known && known.size && !known.has(field)) continue;
    if (field === "channel" && !canApplyTextChannelFilter(input.pack, input.table)) continue;
    const have = Array.isArray(filters[field]) ? filters[field]! : [];
    const miss = missingFrom(have, want);
    if (!miss.length) continue;
    filters[field] = uniqCi([...have, ...miss]);
    backfilled[field] = miss;
    notes.push(`coverage_backfill:${field}:${miss.join(",")}`);
  }

  return { status: "ok", filters, notes, backfilled };
}
