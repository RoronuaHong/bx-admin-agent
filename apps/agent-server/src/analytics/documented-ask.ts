/**
 * Code-built structure for non-overlay warehouse tables.
 * Uses live Metabase descriptions + compile slots; does not write SQL.
 */

import { warehouseTableHasDocs } from "./catalog-digest.js";
import type { StructuredAskOk } from "./conversation-structure.js";
import { extractChannelsFromNl } from "./intent.js";
import { inferMetricIdFromNl, inferOutputDimsFromNl } from "./metric-infer.js";
import { extractAppVersionFromNl } from "./verified-query.js";
import {
  canApplyTextChannelFilter,
  isOverlayTable,
  packFieldsForTable,
  tableHasField,
  warehouseTable,
  type AnalyticsPack,
} from "./semantic-layer.js";

export function buildDocumentedTableStructure(input: {
  nl: string;
  pack: AnalyticsPack;
  table: string;
  time: { start: string; end: string };
  reason: string;
}): StructuredAskOk | null {
  const table = String(input.table || "").trim();
  if (!table || isOverlayTable(input.pack, table)) return null;
  const w = warehouseTable(input.pack, table);
  const documented = warehouseTableHasDocs(w);
  const reason = String(input.reason || "");
  if (
    !documented &&
    reason !== "named_in_nl" &&
    !reason.startsWith("unique_score") &&
    !reason.startsWith("metric_tables")
  ) {
    return null;
  }
  const nl = String(input.nl || "").trim();
  const metricId = inferMetricIdFromNl(nl, input.pack, table) || "count:*";
  const outputDims = inferOutputDimsFromNl(nl).filter(
    (d) => d === "watch_date" || tableHasField(input.pack, table, d),
  );
  if (metricId === "dau" && !outputDims.includes("watch_date")) {
    outputDims.unshift("watch_date");
  }
  const filters: Record<string, string[]> = {};
  const channels = extractChannelsFromNl(nl, input.pack);
  if (channels.length && (canApplyTextChannelFilter(input.pack, table) || reason.startsWith("metric_tables"))) {
    filters.channel = channels;
  }
  const ver = extractAppVersionFromNl(nl);
  if (ver) filters.appVersion = [ver];
  return {
    status: "ok",
    mergedNl: nl,
    time: { start: input.time.start, end: input.time.end },
    filters,
    outputDims,
    metricId,
    table,
    notes: [`code_structure:${reason}`],
  };
}

const OVERLAY_METRIC_IDS = new Set([
  "uniq_users",
  "sum_watch_second",
  "avg_watch_second_per_user",
  "avg_max_progress",
]);

export function coerceMetricForWarehouseTable(
  metricId: string | undefined,
  nl: string,
  pack: AnalyticsPack,
  table: string,
): string {
  if (!table || isOverlayTable(pack, table)) return String(metricId || "").trim();
  const id = String(metricId || "").trim();
  const live = new Set(packFieldsForTable(pack, table));
  if (OVERLAY_METRIC_IDS.has(id)) {
    return inferMetricIdFromNl(nl, pack, table) || "count:*";
  }
  const generic = id.match(/^(uniq|sum|avg|count):([A-Za-z_][A-Za-z0-9_]*|\*)$/);
  if (generic) {
    const field = generic[2]!;
    if (field !== "*" && live.size && !live.has(field)) {
      return inferMetricIdFromNl(nl, pack, table) || "count:*";
    }
    return id;
  }
  if (!id) return inferMetricIdFromNl(nl, pack, table) || "count:*";
  return inferMetricIdFromNl(nl, pack, table) || id;
}
