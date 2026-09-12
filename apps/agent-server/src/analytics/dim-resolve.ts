/**
 * Load Metabase field lexicons and resolve Intent/structure filter tokens
 * (Chinese labels → stored codes) before SQL compile.
 */

import {
  buildDimLexicon,
  extractLabelsFromText,
  lexiconClarifyOptions,
  resolveDimTokens,
  type DimLexicon,
} from "./dim-lexicon.js";
import {
  fetchMetabaseFieldValues,
  findMetabaseField,
  type MetabaseRunOpts,
} from "./metabase-client.js";
import { remapEnumTokens, type AnalyticsPack, type EnumDimensionDef } from "./semantic-layer.js";

const lexiconCache = new Map<string, { at: number; lexicon: DimLexicon }>();
const LEXICON_TTL_MS = 30 * 60 * 1000;

export function clearDimLexiconCache(): void {
  lexiconCache.clear();
}

export async function loadFieldLexicon(
  pack: AnalyticsPack,
  field: string,
  opts?: MetabaseRunOpts,
): Promise<{ ok: true; lexicon: DimLexicon } | { ok: false; error: string }> {
  const table = pack.tables[0]?.name;
  if (!table) return { ok: false, error: "pack has no table" };
  const dbId = pack.datasource.metabaseDatabaseId;
  const cacheKey = `${dbId}:${table}.${field}`;
  const cached = lexiconCache.get(cacheKey);
  if (cached && Date.now() - cached.at < LEXICON_TTL_MS) {
    return { ok: true, lexicon: cached.lexicon };
  }

  const found = await findMetabaseField(dbId, table, field, opts);
  if (!found.ok) return found;
  const valuesRes = await fetchMetabaseFieldValues(found.field.id, opts);
  const valuesRows = valuesRes.ok ? valuesRes.values : [];
  const lexicon = buildDimLexicon({
    field,
    valuesRows,
    description: found.field.description,
  });
  lexiconCache.set(cacheKey, { at: Date.now(), lexicon });
  return { ok: true, lexicon };
}

function wantsLexiconResolve(
  dim: EnumDimensionDef | undefined,
  field: string,
  tokens: string[],
  nl?: string,
): boolean {
  if (dim?.domain === "pack") return false;
  if (dim?.valueDomain === "literal") return false;
  if (dim?.valueDomain === "metabase_lexicon") return true;
  if (field === "movieType") return true;
  // Generic: CJK (or other non-code) tokens / NL hints need label→code mapping
  if (tokens.some((t) => /[\u4e00-\u9fff]/.test(t))) return true;
  if (nl && field === "movieType" && /[\u4e00-\u9fff]/.test(nl)) return true;
  return false;
}

export type FilterResolveOk = {
  status: "ok";
  filters: Record<string, string[]>;
  notes: string[];
};

export type FilterResolveClarify = {
  status: "clarify";
  clarifySlot: string;
  message: string;
  filters: Record<string, string[]>;
  options: Array<{ id: string; label: string }>;
  notes: string[];
};

export type FilterResolveResult = FilterResolveOk | FilterResolveClarify;

/**
 * Deterministically resolve remapped enum filters using Metabase field docs/values.
 * If labels cannot be mapped → clarify with lexicon options (not raw Top-N codes only).
 */
export async function resolvePackFilters(input: {
  pack: AnalyticsPack;
  filters: Record<string, string[]>;
  nl?: string;
  opts?: MetabaseRunOpts;
}): Promise<FilterResolveResult> {
  const filters: Record<string, string[]> = { ...input.filters };
  const notes: string[] = [];
  const enumByField = new Map((input.pack.enumDimensions || []).map((d) => [d.field, d]));

  const fields = new Set<string>([
    ...Object.keys(filters),
    ...(input.pack.enumDimensions || []).map((d) => d.field),
  ]);

  for (const field of fields) {
    const dim = enumByField.get(field);
    let tokens = remapEnumTokens([...(filters[field] || [])], input.pack, field);
    if (tokens.length && filters[field]?.some((t, i) => t !== tokens[i])) {
      filters[field] = tokens;
      notes.push(`pack_alias:${field}:${tokens.join(",")}`);
    }
    if (!wantsLexiconResolve(dim, field, tokens, input.nl)) continue;

    const loaded = await loadFieldLexicon(input.pack, field, input.opts);
    if (!loaded.ok) {
      notes.push(`lexicon_skip:${field}:${loaded.error}`);
      // Soft-fail: leave tokens; compile gate will refuse bare Chinese for numeric dims
      continue;
    }
    const { lexicon } = loaded;
    if (!lexicon.remapped) {
      notes.push(`lexicon_literal:${field}`);
      continue;
    }

    const fromNl = input.nl ? extractLabelsFromText(input.nl, lexicon) : [];
    // Prefer explicit NL labels when present (overrides invented leftovers)
    if (fromNl.length) {
      tokens = [...new Set([...fromNl, ...tokens])];
      notes.push(`lexicon_nl_ground:${field}:${fromNl.join(",")}`);
    }

    if (!tokens.length) continue;

    const resolved = resolveDimTokens(tokens, lexicon);
    if (resolved.unresolved.length) {
      return {
        status: "clarify",
        clarifySlot: field,
        message: `无法将「${resolved.unresolved.join("、")}」映射到 ${field} 编码，请从候选中选择。`,
        filters,
        options: lexiconClarifyOptions(lexicon),
        notes: [...notes, `lexicon_unresolved:${field}:${resolved.unresolved.join(",")}`],
      };
    }
    filters[field] = resolved.resolved;
    notes.push(`lexicon_resolved:${field}:${resolved.resolved.join(",")}`);
  }

  return { status: "ok", filters, notes };
}

/** Try to ground remapped enum values from NL via Metabase lexicon (e.g. 电影→1). */
export async function groundRemappedFieldFromNl(input: {
  pack: AnalyticsPack;
  field: string;
  nl: string;
  opts?: MetabaseRunOpts;
}): Promise<{ ok: true; codes: string[]; lexicon: DimLexicon } | { ok: false; error: string }> {
  const loaded = await loadFieldLexicon(input.pack, input.field, input.opts);
  if (!loaded.ok) return loaded;
  if (!loaded.lexicon.remapped) {
    return { ok: false, error: "not_remapped" };
  }
  const codes = extractLabelsFromText(input.nl, loaded.lexicon);
  return { ok: true, codes, lexicon: loaded.lexicon };
}

/** Tool / test helper: resolve a single field's tokens. */
export async function resolveDimensionValues(input: {
  pack: AnalyticsPack;
  field: string;
  tokens: string[];
  opts?: MetabaseRunOpts;
}): Promise<{
  ok: boolean;
  field: string;
  remapped?: boolean;
  resolved: string[];
  unresolved: string[];
  options?: Array<{ id: string; label: string }>;
  error?: string;
}> {
  const loaded = await loadFieldLexicon(input.pack, input.field, input.opts);
  if (!loaded.ok) {
    return {
      ok: false,
      field: input.field,
      resolved: [],
      unresolved: input.tokens,
      error: loaded.error,
    };
  }
  const r = resolveDimTokens(input.tokens, loaded.lexicon);
  return {
    ok: r.unresolved.length === 0,
    field: input.field,
    remapped: loaded.lexicon.remapped,
    resolved: r.resolved,
    unresolved: r.unresolved,
    options: lexiconClarifyOptions(loaded.lexicon),
  };
}
