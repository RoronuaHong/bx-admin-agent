/**
 * Analytics / Metabase tool executors (M1).
 * Wired from tools.ts runAgentTool; MCP/HTTP facades reuse the same entry points.
 */
import { analyticsAsk } from "../analytics/pipeline.js";
import { runMetabaseQuestion, runNativeDataset } from "../analytics/metabase-client.js";
import { loadAnalyticsPack } from "../analytics/semantic-layer.js";
import {
  assertReadonlySingleSelect,
  assertTablesWhitelisted,
  normalizeDistinctCount,
} from "../analytics/sql-guard.js";
import { config } from "../config.js";

/** NL → full analytics pipeline (time resolve → Probe → SQL → verify → exec). */
export async function execAnalyticsAsk(input: Record<string, unknown>): Promise<string> {
  const text = String(input.text ?? input.query ?? "").trim();
  if (!text) {
    return JSON.stringify({
      status: "error",
      message: "text is required",
      error: "missing text",
    });
  }
  const packId = input.packId != null ? String(input.packId).trim() : "";
  const result = await analyticsAsk(text, packId ? { packId } : undefined);
  return JSON.stringify(result);
}

/** Execute a single native SQL via Metabase `/api/dataset` (readonly + pack whitelist). */
export async function execMetabaseRunDataset(input: Record<string, unknown>): Promise<string> {
  const sqlRaw = String(input.sql ?? input.query ?? "").trim();
  if (!sqlRaw) {
    return JSON.stringify({ ok: false, cols: [], rows: [], error: "missing sql" });
  }
  const packId = String(input.packId ?? "watch-detail").trim() || "watch-detail";
  try {
    const pack = loadAnalyticsPack(packId);
    let sql = normalizeDistinctCount(sqlRaw, config.metabase.distinctCountFn);
    assertReadonlySingleSelect(sql);
    assertTablesWhitelisted(
      sql,
      pack.tables.map((t) => t.name),
    );
    const rawDb =
      input.databaseId != null ? Number(input.databaseId) : pack.datasource.metabaseDatabaseId;
    const databaseId = Number.isFinite(rawDb) ? rawDb : pack.datasource.metabaseDatabaseId;
    const result = await runNativeDataset(sql, databaseId);
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({
      ok: false,
      cols: [],
      rows: [],
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Saved Metabase question / card runner. */
export async function execMetabaseRunQuestion(input: Record<string, unknown>): Promise<string> {
  const rawId = input.questionId ?? input.cardId ?? input.id;
  const questionId = Number(rawId);
  if (!Number.isFinite(questionId) || questionId <= 0) {
    return JSON.stringify({ ok: false, cols: [], rows: [], error: "questionId is required" });
  }
  let parameters: Record<string, string> | undefined;
  if (input.parameters && typeof input.parameters === "object" && !Array.isArray(input.parameters)) {
    parameters = {};
    for (const [k, v] of Object.entries(input.parameters as Record<string, unknown>)) {
      parameters[k] = String(v ?? "");
    }
  } else if (input.start != null || input.end != null) {
    parameters = {
      start: String(input.start ?? ""),
      end: String(input.end ?? ""),
    };
  }
  try {
    const result = await runMetabaseQuestion(questionId, parameters);
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({
      ok: false,
      cols: [],
      rows: [],
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** EXPLAIN ESTIMATE — stub in M1. */
export async function execMetabaseExplainEstimate(_input: Record<string, unknown>): Promise<string> {
  return JSON.stringify({
    ok: false,
    error: "not implemented in M1",
    message: "metabase_explain_estimate is not implemented in M1",
  });
}
