/**
 * Hybrid ask router: verified_query → intent_compile → llm_sql.
 */
import { tableDeclaredSynonyms } from "./catalog-card.js";
import { parseGenericMetricId } from "./intent.js";
import { inferMetricIdFromNl } from "./metric-infer.js";
import { overlayAskFromNl, RICH_TABLE_CAP, type TableConfidence } from "./table-resolve.js";
import {
  findMetricOption,
  isOverlayTable,
  packFieldsForTable,
  type AnalyticsPack,
} from "./semantic-layer.js";
import { matchVerifiedQuery, type VerifiedQuery } from "./verified-query.js";

export type AskRoute =
  | { path: "verified_query"; query: VerifiedQuery }
  | { path: "intent_compile"; reason: string }
  | { path: "llm_sql"; tables: string[] }
  | {
      path: "clarify";
      slot: string;
      message: string;
      options?: Array<{ id: string; label: string }>;
    }
  | { path: "refuse"; reason: string; message: string };

/**
 * Did the user actually ask for a measure? Grounded on the pack's own metric vocabulary
 * (aliases / labels / groundSignals) or a column of the target table named in the NL.
 * No business word list in code — a new pack/warehouse needs zero changes here.
 */
function explicitMeasureInNl(nl: string, pack: AnalyticsPack, table?: string): boolean {
  const text = String(nl || "");
  if (!text) return false;
  for (const def of pack.metricDefs || []) {
    if ((def.aliases || []).some((a) => a && text.includes(a))) return true;
    for (const opt of def.options || []) {
      if (opt.label && text.includes(opt.label)) return true;
      if ((opt.groundSignals || []).some((s) => s && text.includes(s))) return true;
    }
  }
  if (packFieldsForTable(pack, table).some((f) => f.length >= 3 && text.includes(f))) return true;
  // Naming the table (or one of its declared synonyms) is itself an explicit ask.
  const t = (pack.warehouse?.tables || []).find((x) => x.name === table);
  return Boolean(t && tableDeclaredSynonyms(t).some((s) => s && text.includes(s)));
}

/** Documented-table default `count:*` is not a user-asked compile; leave those for Path C. */
function compilableByIntent(
  nl: string,
  generic: string,
  pack: AnalyticsPack,
  table?: string,
  confidence?: TableConfidence,
): boolean {
  const parsed = parseGenericMetricId(generic);
  if (!parsed && findMetricOption(pack, generic)?.opt.compile?.kind) return true;
  if (confidence === "retrieved" || confidence === "catalog") {
    return false;
  }
  if (!parsed && isOverlayTable(pack, table)) return true;
  if (!parsed) return false;
  if (
    parsed.kind === "count" &&
    table &&
    !isOverlayTable(pack, table) &&
    !explicitMeasureInNl(nl, pack, table)
  ) {
    return false;
  }
  return true;
}

export function llmSqlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.ANALYTICS_LLM_SQL ?? "on").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

export function routeAnalyticsAsk(input: {
  nl: string;
  pack: AnalyticsPack;
  lockedTable?: string;
  linkedTables?: string[];
  tableConfidence?: TableConfidence;
  llmSqlEnabled?: boolean;
}): AskRoute {
  const nl = String(input.nl || "").trim();
  const linked = [...new Set((input.linkedTables || []).filter(Boolean))].slice(0, RICH_TABLE_CAP);

  const vqr = matchVerifiedQuery(nl, input.pack);
  if (vqr && "clarify" in vqr) {
    return {
      path: "clarify",
      slot: "verified_query",
      message: "多条金样同时命中，请选择要查的口径。",
      options: vqr.clarify,
    };
  }
  if (vqr && "query" in vqr) {
    return { path: "verified_query", query: vqr.query };
  }

  const table = input.lockedTable;
  const generic = table ? inferMetricIdFromNl(nl, input.pack, table) : inferMetricIdFromNl(nl, input.pack);
  if (generic && compilableByIntent(nl, generic, input.pack, table, input.tableConfidence)) {
    return { path: "intent_compile", reason: `metric:${generic}` };
  }
  if (
    input.tableConfidence !== "retrieved" &&
    input.tableConfidence !== "catalog" &&
    overlayAskFromNl(nl, input.pack) &&
    (!table || isOverlayTable(input.pack, table))
  ) {
    return { path: "intent_compile", reason: "overlay_ask" };
  }

  const allowLlm = input.llmSqlEnabled ?? llmSqlEnabled();
  const llmTables = linked.length ? linked : table ? [table] : [];
  const warehouseCount = (input.pack.warehouse?.tables || []).length;
  if (allowLlm && (llmTables.length || warehouseCount)) {
    return { path: "llm_sql", tables: llmTables };
  }
  if (!allowLlm && (llmTables.length || warehouseCount)) {
    return {
      path: "refuse",
      reason: "llm_sql_disabled",
      message: "当前问数超出已建模/金样口径，且模型写 SQL 已关闭，已拒绝执行。",
    };
  }
  return {
    path: "refuse",
    reason: "no_route",
    message: "无法确定要查的表或口径，请点名一张可查询表，或改用已支持的指标。",
  };
}
