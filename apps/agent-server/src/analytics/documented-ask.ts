/**
 * Metric id coercion for non-overlay warehouse tables:
 * overlay-only metrics / metrics whose field is absent fall back to NL inference.
 */

import { inferMetricIdFromNl } from "./metric-infer.js";
import {
  findMetricOption,
  isOverlayTable,
  overlayTableName,
  packFieldsForTable,
  type AnalyticsPack,
} from "./semantic-layer.js";

/**
 * Tables a metric id belongs to. `MetricDef.tables` wins; a def without `tables` is
 * overlay-scoped by definition (it describes the pack's modeled table). Config-driven —
 * no metric id list in code.
 */
function metricOwnerTables(pack: AnalyticsPack, id: string): string[] {
  const def = findMetricOption(pack, id)?.def;
  if (def?.tables?.length) return def.tables;
  const overlay = overlayTableName(pack) || pack.tables[0]?.name || "";
  return overlay ? [overlay] : [];
}

export function coerceMetricForWarehouseTable(
  metricId: string | undefined,
  nl: string,
  pack: AnalyticsPack,
  table: string,
): string {
  if (!table || isOverlayTable(pack, table)) return String(metricId || "").trim();
  const id = String(metricId || "").trim();
  const live = new Set(packFieldsForTable(pack, table));
  const owners = metricOwnerTables(pack, id);
  if (owners.length && !owners.includes(table)) {
    // The metric is modeled for another table → re-infer against this one.
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
