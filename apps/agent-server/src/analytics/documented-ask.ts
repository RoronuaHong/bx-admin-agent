/**
 * Metric id coercion for non-overlay warehouse tables:
 * overlay-only metrics / metrics whose field is absent fall back to NL inference.
 */

import { inferMetricIdFromNl } from "./metric-infer.js";
import {
  isOverlayTable,
  packFieldsForTable,
  type AnalyticsPack,
} from "./semantic-layer.js";

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
