/**
 * Analytics / Metabase tool executors (M1).
 * Wired from tools.ts runAgentTool; MCP/HTTP facades reuse the same entry points.
 */
import { analyticsAsk } from "../analytics/pipeline.js";
import { runNativeDataset } from "../analytics/metabase-client.js";
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

/** Execute a single native SQL via Metabase `/api/dataset`. */
export async function execMetabaseRunDataset(input: Record<string, unknown>): Promise<string> {
  const sql = String(input.sql ?? input.query ?? "").trim();
  if (!sql) {
    return JSON.stringify({ ok: false, cols: [], rows: [], error: "missing sql" });
  }
  const rawDb = input.databaseId != null ? Number(input.databaseId) : config.metabase.databaseId;
  const databaseId = Number.isFinite(rawDb) ? rawDb : config.metabase.databaseId;
  const result = await runNativeDataset(sql, databaseId);
  return JSON.stringify(result);
}

/** Saved-question runner — stub in M1. */
export async function execMetabaseRunQuestion(_input: Record<string, unknown>): Promise<string> {
  return JSON.stringify({ ok: false, error: "not implemented in M1" });
}

/** EXPLAIN ESTIMATE — stub in M1. */
export async function execMetabaseExplainEstimate(_input: Record<string, unknown>): Promise<string> {
  return JSON.stringify({
    ok: false,
    error: "not implemented in M1",
    message: "metabase_explain_estimate is not implemented in M1",
  });
}
